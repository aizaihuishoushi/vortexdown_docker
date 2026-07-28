/**
 * queue.js - Task queue with concurrency control and state machine for VortexDown
 * States: pending -> downloading -> completed | failed | stopped
 * Pure ESM, zero dependencies
 */

import { loadTasks, saveTasks, updateTask, getTask, loadSettings } from './db.js';
import { generateSavePath } from './naming.js';
import { downloadHTTP, formatBytes } from './engines/http-downloader.js';
import { downloadM3U8 } from './engines/m3u8-downloader.js';
import { downloadStream } from './engines/nm3u8dl-re-engine.js';

// ---- Event Emitter (simple implementation, zero deps) ----

class Emitter {
  constructor() {
    this._listeners = new Map();
  }

  on(event, fn) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(fn);
    return this;
  }

  off(event, fn) {
    const set = this._listeners.get(event);
    if (set) {
      set.delete(fn);
    }
    return this;
  }

  emit(event, ...args) {
    const set = this._listeners.get(event);
    if (set) {
      for (const fn of set) {
        try {
          fn(...args);
        } catch (err) {
          console.error(`[queue] Event handler error for "${event}":`, err.message);
        }
      }
    }
  }
}

// ---- Valid state transitions ----

const VALID_TRANSITIONS = {
  pending: ['downloading', 'stopped'],
  downloading: ['completed', 'failed', 'stopped'],
  completed: [],
  failed: ['pending', 'stopped'],
  stopped: ['pending', 'stopped'],
};

/**
 * Check if a state transition is valid
 */
function canTransition(from, to) {
  return VALID_TRANSITIONS[from]?.includes(to) || false;
}

// ---- Task Queue ----

class TaskQueue extends Emitter {
  constructor() {
    super();
    this._runningCount = 0;
    this._abortControllers = new Map(); // taskId -> AbortController
    this._maxConcurrent = 3;
    this._m3u8Concurrency = 8;
    this._processing = false;
  }

  /**
   * Load settings and update concurrency limits
   */
  _syncSettings() {
    try {
      const settings = loadSettings();
      this._maxConcurrent = settings.maxConcurrent || 3;
      this._m3u8Concurrency = settings.m3u8Concurrency || 8;
    } catch {
      // Use defaults
    }
  }

  /**
   * Start the queue processing loop
   */
  start() {
    if (this._processing) return;
    this._processing = true;
    this._processQueue();
  }

  /**
   * Stop the queue processing (does not stop running tasks)
   */
  stop() {
    this._processing = false;
  }

  /**
   * Process the queue - start pending tasks up to concurrency limit
   */
  _processQueue() {
    if (!this._processing) return;

    this._syncSettings();

    // Check if we can start more tasks
    const tasks = loadTasks();
    const downloading = tasks.filter(t => t.status === 'downloading');
    this._runningCount = downloading.length;

    if (this._runningCount >= this._maxConcurrent) {
      // Max concurrency reached, check again in 1 second
      setTimeout(() => this._processQueue(), 1000);
      return;
    }

    // Find next pending task
    const pending = tasks.filter(t => t.status === 'pending');
    if (pending.length === 0 && downloading.length === 0) {
      // No work to do
      return;
    }

    // Start pending tasks up to concurrency limit
    const slotsAvailable = this._maxConcurrent - this._runningCount;
    const toStart = pending.slice(0, slotsAvailable);

    for (const task of toStart) {
      this._startTask(task);
    }

    // Check again in a second
    setTimeout(() => this._processQueue(), 1000);
  }

  /**
   * Start downloading a single task
   */
  async _startTask(task) {
    const settings = loadSettings();
    const template = settings.namingTemplate || '{name} S{season}E{episode}.{ext}';

    // Generate save path: 优先使用任务指定的 saveDir，其次全局设置
    const baseDir = task.saveDir || settings.saveDir || '/tmp/vortexdown_downloads';
    const savePath = generateSavePath(task, baseDir, template);
    task.savePath = savePath;

    // Transition to downloading
    this._transitionTask(task.id, 'downloading', {
      savePath,
      downloaded: 0,
      total: 0,
      speed: 0,
    });

    // Create abort controller
    const controller = new AbortController();
    this._abortControllers.set(task.id, controller);

    try {
      const onProgress = (downloaded, total, speed) => {
        updateTask(task.id, {
          downloaded,
          total,
          speed,
        });
        this.emit('progress', task.id, { downloaded, total, speed });
      };

      let result;

      if (task.engine === 'm3u8' || task.engine === 'mpd' || task.engine === 'ism') {
        // N_m3u8DL-RE 支持 M3U8/MPD/ISM 三种格式
        result = await downloadStream(task, onProgress, controller.signal);
      } else if (task.engine === 'http') {
        result = await downloadHTTP(
          task,
          onProgress,
          controller.signal,
        );
      } else {
        throw new Error(`不支持的下载类型: ${task.engine}`);
      }

      // Success
      this._transitionTask(task.id, 'completed', {
        downloaded: result.totalSize,
        total: result.totalSize,
        speed: 0,
        filePath: result.filePath,
      });

      this.emit('completed', task.id, result);
    } catch (err) {
      // 重新读取最新状态，防止重复转换（stopTask可能已强制更新为stopped）
      const currentTask = getTask(task.id);
      if (currentTask && currentTask.status === 'downloading') {
        if (controller.signal.aborted) {
          this._transitionTask(task.id, 'stopped', { error: null });
          this.emit('stopped', task.id);
        } else {
          // 检测是否为地域限制导致的 404
          let errorMsg = err.message;
          if (errorMsg.includes('HTTP 404') || errorMsg.includes('404')) {
            try {
              const urlObj = new URL(task.url);
              const cdnDomain = urlObj.hostname;
              errorMsg += ` [提示: 请将 ${cdnDomain} 加入路由器 PassWall 直连列表]`;
            } catch { /* ignore */ }
          }
          this._transitionTask(task.id, 'failed', { error: errorMsg });
          this.emit('failed', task.id, errorMsg);
        }
      }
    } finally {
      this._abortControllers.delete(task.id);
      this._processQueue();
    }
  }

  /**
   * Transition a task to a new state
   */
  _transitionTask(taskId, newState, updates = {}) {
    const task = getTask(taskId);
    if (!task) return;

    const oldState = task.status;

    if (!canTransition(oldState, newState)) {
      console.error(`[queue] Invalid transition: ${taskId} ${oldState} -> ${newState}`);
      return;
    }

    const finalUpdates = {
      status: newState,
      ...updates,
    };

    // Set timestamps
    const now = new Date().toISOString();
    if (newState === 'downloading') {
      finalUpdates.startedAt = now;
    } else if (newState === 'completed') {
      finalUpdates.completedAt = now;
    } else if (newState === 'failed') {
      finalUpdates.failedAt = now;
    } else if (newState === 'stopped') {
      finalUpdates.stoppedAt = now;
    }

    updateTask(taskId, finalUpdates);
    this.emit('stateChange', taskId, oldState, newState, finalUpdates);
  }

  /**
   * Stop a running task
   * 修复：abort后立即强制更新数据库状态，不依赖异步catch块
   */
  stopTask(taskId) {
    const controller = this._abortControllers.get(taskId);
    if (controller) {
      controller.abort();
    }
    // 立即更新数据库状态，不依赖异步的catch块
    const task = getTask(taskId);
    if (task) {
      if (task.status === 'downloading') {
        // 强制更新为 stopped，避免网络请求卡住导致状态不转换
        updateTask(taskId, {
          status: 'stopped',
          speed: 0,
          stoppedAt: new Date().toISOString(),
        });
        this.emit('stateChange', taskId, 'downloading', 'stopped');
      } else if (task.status === 'pending') {
        this._transitionTask(taskId, 'stopped');
      }
    }
  }

  /**
   * Retry a failed task
   */
  retryTask(taskId) {
    const task = getTask(taskId);
    if (task && (task.status === 'failed' || task.status === 'stopped')) {
      this._transitionTask(taskId, 'pending', {
        error: null,
        downloaded: 0,
        speed: 0,
      });
      this._processQueue();
    }
  }

  /**
   * Get KPI stats
   */
  getStats() {
    const tasks = loadTasks();
    const downloading = tasks.filter(t => t.status === 'downloading');
    const completed = tasks.filter(t => t.status === 'completed');
    const failed = tasks.filter(t => t.status === 'failed');
    const pending = tasks.filter(t => t.status === 'pending');

    let totalSpeed = 0;
    for (const t of downloading) {
      totalSpeed += t.speed || 0;
    }

    return {
      total: tasks.length,
      downloading: downloading.length,
      completed: completed.length,
      failed: failed.length,
      pending: pending.length,
      totalSpeed,
    };
  }
}

// Singleton instance
let queueInstance = null;

/**
 * Get or create the task queue singleton
 */
export function getQueue() {
  if (!queueInstance) {
    queueInstance = new TaskQueue();
  }
  return queueInstance;
}

export { TaskQueue, formatBytes };

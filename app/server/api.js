/**
 * api.js - REST API endpoints for VortexDown (Docker Edition)
 * Task CRUD, batch add, status query, settings management
 * Pure ESM, zero dependencies
 */

import { loadTasks, addTask, addTasks, deleteTask, getTask, updateTask, saveTasks, loadSettings, updateSettings } from './db.js';
import { parseMultilineLinks } from './router.js';
import { generateFilename } from './naming.js';
import { getQueue } from './queue.js';
import { readdirSync, existsSync as fsExistsSync } from 'node:fs';
import { join as pathJoin } from 'node:path';

/**
 * 从配对格式的行内名称中提取剧名（去掉集数标记）
 */
function extractShowName(text) {
  if (!text) return '';
  const cleaned = text.replace(/第\s*\d+\s*集?$/i, '').replace(/EP\s*\d+$/i, '').trim();
  return cleaned || text;
}

/**
 * Parse JSON body from request
 */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Send JSON response
 */
function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

/**
 * Handle OPTIONS preflight
 */
function handleOptions(res) {
  res.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end();
}

/**
 * Parse URL pathname without query string
 */
function getPathname(reqUrl) {
  try {
    const parsedUrl = new URL(reqUrl, 'http://localhost');
    return parsedUrl.pathname;
  } catch {
    return reqUrl.split('?')[0];
  }
}

/**
 * Extract route parameters (e.g., /api/tasks/:id -> id)
 */
function matchRoute(pathname, pattern) {
  const pathParts = pathname.split('/').filter(Boolean);
  const patternParts = pattern.split('/').filter(Boolean);

  if (pathParts.length !== patternParts.length) return null;

  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = pathParts[i];
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

/**
 * 获取浏览根路径列表
 * Docker 环境下从 BROWSE_ROOTS 环境变量读取
 */
function getBrowseRoots() {
  const envRoots = process.env.BROWSE_ROOTS;
  if (envRoots) {
    return envRoots.split(',').map(r => r.trim()).filter(Boolean);
  }
  // 默认浏览路径
  return ['/downloads', '/host'];
}

/**
 * Create API request handler
 */
export function createAPIHandler() {
  const queue = getQueue();
  queue.start();

  return async function handleAPI(req, res) {
    const method = req.method;
    const pathname = getPathname(req.url);

    // CORS preflight
    if (method === 'OPTIONS') {
      handleOptions(res);
      return;
    }

    try {
      // ---- GET /api/tasks ----
      if (method === 'GET' && pathname === '/api/tasks') {
        const tasks = loadTasks();
        json(res, { code: 0, data: tasks });
        return;
      }

      // ---- POST /api/tasks/batch ----
      if (method === 'POST' && pathname === '/api/tasks/batch') {
        const body = await parseBody(req);
        const { name, season = 1, template, links, saveDir, referer } = body;

        if (!links) {
          json(res, { code: 1, error: '缺少链接参数' }, 400);
          return;
        }

        const settings = loadSettings();
        const namingTemplate = template || settings.namingTemplate || '{name} S{season}E{episode}.{ext}';
        const effectiveSaveDir = saveDir || settings.saveDir || '/downloads';

        const parsed = parseMultilineLinks(links);

        if (parsed.length === 0) {
          json(res, { code: 1, error: '未检测到有效链接' }, 400);
          return;
        }

        const now = new Date().toISOString();
        const tasks = parsed.map((p, idx) => {
          const taskName = name || (p.isPaired ? extractShowName(p.name) : '未命名');
          const epTitle = p.isPaired ? p.name : '';

          const task = {
            id: `task_${Date.now()}_${idx}`,
            name: taskName,
            season: parseInt(season, 10) || 1,
            episode: p.episode || (idx + 1),
            epTitle,
            url: p.url,
            engine: p.engine,
            referer: referer || '',
            saveDir: saveDir || '',
            filename: '',
            savePath: '',
            status: 'pending',
            downloaded: 0,
            total: 0,
            speed: 0,
            error: null,
            createdAt: now,
            startedAt: null,
            completedAt: null,
            failedAt: null,
            stoppedAt: null,
          };

          task.filename = generateFilename(task, namingTemplate);
          return task;
        });

        addTasks(tasks);
        queue._processQueue();

        json(res, { code: 0, data: tasks });
        return;
      }

      // ---- POST /api/tasks/:id/start ----
      const startMatch = matchRoute(pathname, '/api/tasks/:id/start');
      if (method === 'POST' && startMatch) {
        const { id } = startMatch;
        const task = getTask(id);
        if (!task) {
          json(res, { code: 1, error: '任务不存在' }, 404);
          return;
        }

        if (task.status === 'completed') {
          json(res, { code: 1, error: '任务已完成，无法重新开始' }, 400);
          return;
        }

        if (task.status === 'failed' || task.status === 'stopped') {
          updateTask(id, {
            status: 'pending',
            downloaded: 0,
            speed: 0,
            error: null,
          });
        }

        queue._processQueue();
        json(res, { code: 0, message: '任务已加入队列' });
        return;
      }

      // ---- POST /api/tasks/:id/stop ----
      const stopMatch = matchRoute(pathname, '/api/tasks/:id/stop');
      if (method === 'POST' && stopMatch) {
        const { id } = stopMatch;
        queue.stopTask(id);
        json(res, { code: 0, message: '已发送停止信号' });
        return;
      }

      // ---- DELETE /api/tasks/:id ----
      const deleteMatch = matchRoute(pathname, '/api/tasks/:id');
      if (method === 'DELETE' && deleteMatch) {
        const { id } = deleteMatch;
        queue.stopTask(id);
        setTimeout(() => {
          deleteTask(id);
        }, 100);
        json(res, { code: 0, message: '任务已删除' });
        return;
      }

      // ---- POST /api/tasks/batch-stop ----
      if (method === 'POST' && pathname === '/api/tasks/batch-stop') {
        const body = await parseBody(req);
        const { ids } = body;
        if (!ids || !Array.isArray(ids)) {
          json(res, { code: 1, error: '缺少ids参数' }, 400);
          return;
        }
        let count = 0;
        for (const id of ids) {
          queue.stopTask(id);
          count++;
        }
        json(res, { code: 0, message: `已停止 ${count} 个任务` });
        return;
      }

      // ---- POST /api/tasks/batch-delete ----
      if (method === 'POST' && pathname === '/api/tasks/batch-delete') {
        const body = await parseBody(req);
        const { ids } = body;
        if (!ids || !Array.isArray(ids)) {
          json(res, { code: 1, error: '缺少ids参数' }, 400);
          return;
        }
        for (const id of ids) {
          queue.stopTask(id);
        }
        setTimeout(() => {
          const tasks = loadTasks();
          const remaining = tasks.filter(t => !ids.includes(t.id));
          saveTasks(remaining);
        }, 200);
        json(res, { code: 0, message: `已删除 ${ids.length} 个任务` });
        return;
      }

      // ---- POST /api/tasks/batch-retry ----
      if (method === 'POST' && pathname === '/api/tasks/batch-retry') {
        const body = await parseBody(req);
        const { ids } = body;
        if (!ids || !Array.isArray(ids)) {
          json(res, { code: 1, error: '缺少ids参数' }, 400);
          return;
        }
        let count = 0;
        for (const id of ids) {
          queue.retryTask(id);
          count++;
        }
        json(res, { code: 0, message: `已重试 ${count} 个任务` });
        return;
      }

      // ---- POST /api/tasks/clear-completed ----
      if (method === 'POST' && pathname === '/api/tasks/clear-completed') {
        const tasks = loadTasks();
        const remaining = tasks.filter(t => t.status !== 'completed');
        saveTasks(remaining);
        const removed = tasks.length - remaining.length;
        json(res, { code: 0, message: `已清除 ${removed} 个已完成任务` });
        return;
      }

      // ---- GET /api/browse?path=xxx ----
      // Docker 环境下浏览挂载的目录
      if (method === 'GET' && pathname === '/api/browse') {
        const parsedUrl = new URL(req.url, 'http://localhost');
        let queryPath = parsedUrl.searchParams.get('path') || '';

        const browseRoots = getBrowseRoots();

        // 无路径时返回浏览根列表
        if (!queryPath) {
          const roots = browseRoots.filter(r => fsExistsSync(r));
          if (roots.length === 1) {
            queryPath = roots[0];
          } else if (roots.length > 0) {
            // 返回多个根供前端选择
            const items = roots.map(r => ({
              name: r,
              path: r,
              isDir: true,
            }));
            json(res, { code: 0, data: items, currentPath: '', isRoots: true });
            return;
          } else {
            queryPath = '/';
          }
        }

        // 安全检查：确保路径在允许的根路径下
        const isAllowed = browseRoots.some(root =>
          queryPath === root || queryPath.startsWith(root + '/') || queryPath === '/'
        );

        if (!isAllowed && browseRoots.length > 0) {
          json(res, { code: 1, error: '路径不在允许的浏览范围内' }, 403);
          return;
        }

        if (!fsExistsSync(queryPath)) {
          json(res, { code: 1, error: '路径不存在: ' + queryPath }, 404);
          return;
        }

        try {
          const entries = readdirSync(queryPath, { withFileTypes: true });
          const items = entries
            .filter(e => !e.name.startsWith('.'))
            .map(e => ({
              name: e.name,
              path: pathJoin(queryPath, e.name),
              isDir: e.isDirectory(),
            }))
            .sort((a, b) => {
              if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
              return a.name.localeCompare(b.name, 'zh-CN');
            });
          json(res, { code: 0, data: items, currentPath: queryPath });
        } catch (err) {
          json(res, { code: 1, error: '无法读取目录: ' + err.message }, 500);
        }
        return;
      }

      // ---- GET /api/settings ----
      if (method === 'GET' && pathname === '/api/settings') {
        const settings = loadSettings();
        json(res, { code: 0, data: settings });
        return;
      }

      // ---- POST /api/settings ----
      if (method === 'POST' && pathname === '/api/settings') {
        const body = await parseBody(req);
        const updated = updateSettings(body);
        json(res, { code: 0, data: updated });
        return;
      }

      // ---- GET /api/status ----
      if (method === 'GET' && pathname === '/api/status') {
        const stats = queue.getStats();
        json(res, { code: 0, data: stats });
        return;
      }

      // ---- POST /api/preview ----
      if (method === 'POST' && pathname === '/api/preview') {
        const body = await parseBody(req);
        const { links, name, season = 1, template } = body;
        const settings = loadSettings();
        const namingTemplate = template || settings.namingTemplate || '{name} S{season}E{episode}.{ext}';

        const parsed = parseMultilineLinks(links);
        const preview = parsed.map((p, idx) => {
          const taskName = name || (p.isPaired ? extractShowName(p.name) : '未命名');
          const task = {
            name: taskName,
            season: parseInt(season, 10) || 1,
            episode: p.episode || (idx + 1),
            epTitle: p.isPaired ? p.name : '',
            url: p.url,
            engine: p.engine,
          };
          const filename = generateFilename(task, namingTemplate);
          return {
            url: p.url,
            name: p.isPaired ? p.name : '',
            engine: p.engine,
            episode: p.episode,
            filename,
          };
        });

        json(res, { code: 0, data: preview });
        return;
      }

      // 404
      json(res, { code: 404, error: 'Not Found' }, 404);
    } catch (err) {
      console.error('[api] Error:', err.message);
      json(res, { code: 500, error: err.message }, 500);
    }
  };
}

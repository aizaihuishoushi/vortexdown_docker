/**
 * nm3u8dl-re-engine.js - N_m3u8DL-RE CLI 包装引擎
 *
 * 进度追踪策略：直接解析 N_m3u8DL-RE 的 stdout 进度输出
 *   1. 加 --force-ansi-console 强制输出进度（即使 stdout 是 pipe）
 *   2. 收集 stdout → rolling buffer → 提取最新百分比
 *   3. 用 N_m3u8DL-RE 自己算的 (已下载/总大小) → 精确百分比
 *   4. fallback：文件大小轮询
 *
 * 纯 ESM，零外部依赖
 */

import { spawn, execSync } from 'node:child_process';
import { dirname, basename, extname, join } from 'node:path';
import { existsSync, statSync, readdirSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 动态查找 N_m3u8DL-RE 二进制文件
 * 查找优先级：
 *   1. 环境变量 VORTEXDOWN_ROOT/bin/N_m3u8DL-RE（cmd/main 传入，fnOS 安装路径）
 *   2. 相对引擎文件的 ../../bin/N_m3u8DL-RE（app/server/engines/ -> app/bin/）
 *   3. 系统 PATH 中的 N_m3u8DL-RE（which 查找）
 *   4. 常见安装路径
 */
function findBinary() {
  const candidates = [
    // 1. Environment variable (most reliable)
    process.env.VORTEXDOWN_ROOT ? join(process.env.VORTEXDOWN_ROOT, 'bin', 'N_m3u8DL-RE') : null,
    // 2. Relative to engine file: app/server/engines/ -> app/bin/
    join(__dirname, '..', '..', 'bin', 'N_m3u8DL-RE'),
    // 4. Common install paths
    '/usr/local/bin/N_m3u8DL-RE',
    '/usr/bin/N_m3u8DL-RE',
    '/opt/N_m3u8DL-RE/N_m3u8DL-RE',
  ].filter(Boolean);

  for (const p of candidates) {
    if (p === 'N_m3u8DL-RE') {
      // Check via which/command
      try {
        const resolved = execSync('which N_m3u8DL-RE 2>/dev/null').toString().trim();
        if (resolved) return resolved;
      } catch { continue; }
    } else if (existsSync(p)) {
      return p;
    }
  }

  // 3. Fallback to PATH search
  return 'N_m3u8DL-RE';
}

const BINARY_PATH = findBinary();

function safeName(str) {
  return str.replace(/[<>:"/\\|?*$&!;(){}[\]\x00-\x1f]/g, '').trim();
}

function getDirSize(dirPath) {
  let total = 0;
  try {
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      const p = join(dirPath, entry.name);
      total += entry.isDirectory() ? getDirSize(p) : (statSync(p).size || 0);
    }
  } catch {}
  return total;
}

// ==============================================================
// 从 N_m3u8DL-RE stdout 解析进度
// ==============================================================

/**
 * 解析一行输出，提取进度信息
 * N_m3u8DL-RE 的进度格式（ANSI 控制序列已 strip 后）：
 *   "Downloading... 45.2% (500MB/1.1GB) @ 5.2MB/s"
 *   "45.2% (500MB/1.1GB) @ 5.2MB/s"
 *   "Downloading 45.2%"
 *   "[45.2%]"
 */
function parseProgressLine(line) {
  if (!line) return null;
  const text = line;

  // 格式1: "Downloading... 45.2% (500MB/1.1GB) @ 5.2MB/s"
  let m = text.match(/(\d+\.?\d*)%\s*\(([\d.]+)\s*([KMGT]?B)\/([\d.]+)\s*([KMGT]?B)\)\s*@\s*([\d.]+)\s*([KMGT]?B\/s)/i);
  if (m) {
    return {
      pct: parseFloat(m[1]),
      downloaded: parseSize(m[2], m[3]),
      total: parseSize(m[4], m[5]),
      speed: parseSize(m[6], m[7]),
    };
  }

  // 格式2: "45.2% (500MB/1.1GB)" 或 "Downloading... 45.2% (500MB/1.1GB)"
  m = text.match(/(\d+\.?\d*)%\s*\(([\d.]+)\s*([KMGT]?B)\/([\d.]+)\s*([KMGT]?B)\)/i);
  if (m) {
    return {
      pct: parseFloat(m[1]),
      downloaded: parseSize(m[2], m[3]),
      total: parseSize(m[4], m[5]),
      speed: 0,
    };
  }

  // 格式3: 纯百分比 "45.2%"
  m = text.match(/(\d+\.?\d*)%/);
  if (m) {
    return {
      pct: parseFloat(m[1]),
      downloaded: 0,
      total: 0,
      speed: 0,
    };
  }

  return null;
}

function parseSize(value, unit) {
  const n = parseFloat(value);
  if (isNaN(n)) return 0;
  const u = (unit || '').toUpperCase();
  if (u.startsWith('TB')) return n * 1024 ** 4;
  if (u.startsWith('GB')) return n * 1024 ** 3;
  if (u.startsWith('MB')) return n * 1024 ** 2;
  if (u.startsWith('KB')) return n * 1024;
  return n;
}

/**
 * 处理 stdout chunk：按 \r 或 \n 拆行，提取进度
 * N_m3u8DL-RE 用 \r 回覆同一行更新进度
 */
function makeStdoutHandler(onProgress) {
  let buf = '';
  let lastPct = 0;
  let lastTotal = 0;
  let lastDownloaded = 0;
  let lastSpeed = 0;

  return function(chunk) {
    buf += chunk;
    // 按 \r 或 \n 拆行，保留可能不完整的末尾
    const lines = buf.split(/\r|\n/);
    buf = lines.pop() || '';

    for (const raw of lines) {
      // Strip ANSI escape sequences
      const clean = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
      if (!clean) continue;

      const p = parseProgressLine(clean);
      if (p) {
        if (p.pct > 0) lastPct = p.pct;
        if (p.total > 0) lastTotal = p.total;
        if (p.downloaded > 0) lastDownloaded = p.downloaded;
        if (p.speed > 0) lastSpeed = p.speed;
      }
    }

    // 实时上报最新进度
    if (lastTotal > 0) {
      onProgress(lastDownloaded || 0, lastTotal, lastSpeed || 0);
    } else if (lastPct > 0) {
      // 只有百分比没有大小 → 虚拟值
      const virtualTotal = 1000000;
      onProgress(Math.floor(lastPct / 100 * virtualTotal), virtualTotal, lastSpeed || 0);
    }
  };
}

// ==============================================================

function buildArgs(task) {
  const args = [];
  args.push(task.url);
  args.push('--save-dir', dirname(task.savePath));
  const saveName = safeName(basename(task.savePath, extname(task.savePath)));
  args.push('--save-name', saveName);
  if (task.referer) args.push('-H', `Referer: ${task.referer}`);
  args.push('-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  args.push('--thread-count', '16');
  args.push('-M', 'format=mp4');

  // Docker 环境下使用下载目录下的 .tmp 子目录，避免 /tmp 权限问题
  const saveBaseDir = dirname(task.savePath);
  const taskTmpDir = join(saveBaseDir, '.tmp', task.id);
  try { mkdirSync(taskTmpDir, { recursive: true }); } catch {}
  args.push('--tmp-dir', taskTmpDir);

  // 关键：强制 ANSI 控制台输出，即使 stdout 是 pipe
  args.push('--force-ansi-console');

  return args;
}

/**
 * 下载 M3U8/MPD/ISM 流媒体
 * 进度：优先 stdout 实时解析 → fallback 文件大小轮询
 */
export function downloadStream(task, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const args = buildArgs(task);
    const saveBaseDir = dirname(task.savePath);
    const taskTmpDir = join(saveBaseDir, '.tmp', task.id);
    const outputDir = dirname(task.savePath);
    let resolved = false;
    let lastBytes = 0;
    let lastTime = Date.now();

    // stdout 进度处理器
    const stdoutHandler = makeStdoutHandler((dl, total, spd) => {
      // 只有当解析到有效进度时才直接上报
      if (total > 0) {
        onProgress(dl, total, spd);
      }
    });

    console.log(`[nm3u8dl-re] CLI: ${BINARY_PATH} ${args.join(' ')}`);

    const child = spawn(BINARY_PATH, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let killTimer = null;

    if (signal) {
      const onAbort = () => {
        if (child.killed) return;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 3000);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    // stdout：实时解析进度
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', stdoutHandler);

    // stderr：收集错误信息
    const stderrChunks = [];
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderrChunks.push(chunk); });

    // 文件大小轮询 fallback：每 2 秒补充一次
    const pollInterval = setInterval(() => {
      if (resolved) return;

      let downloaded = 0;
      let totalSize = 0;

      if (existsSync(task.savePath)) {
        try { downloaded = statSync(task.savePath).size; } catch {}
        totalSize = downloaded;
      } else {
        if (existsSync(taskTmpDir)) downloaded = getDirSize(taskTmpDir);
        if (downloaded === 0 && existsSync(outputDir)) downloaded = getDirSize(outputDir);
      }

      const now = Date.now();
      const elapsed = (now - lastTime) / 1000;
      const speed = elapsed > 0 ? Math.round((downloaded - lastBytes) / elapsed) : 0;
      lastBytes = downloaded;
      lastTime = now;

      // fallback：只有文件大小 > 0 时才上报（不覆盖 stdout 的精确进度）
      if (totalSize > 0) {
        onProgress(downloaded, totalSize, speed);
      } else if (downloaded > 0) {
        onProgress(downloaded, 0, speed);
      }
    }, 2000);

    child.on('close', (code, exitSignal) => {
      clearInterval(pollInterval);
      if (killTimer) { clearTimeout(killTimer); killTimer = null; }

      if (signal?.aborted) { reject(new Error('下载已取消')); return; }
      if (exitSignal) {
        reject(new Error(stderrChunks.join('').trim() || `进程被 ${exitSignal} 终止`));
        return;
      }
      if (code !== 0) {
        reject(new Error(stderrChunks.join('').trim() || `N_m3u8DL-RE 退出码: ${code}`));
        return;
      }

      let totalSize = 0;
      if (existsSync(task.savePath)) {
        try { totalSize = statSync(task.savePath).size; } catch {}
      }
      onProgress(totalSize, totalSize > 0 ? totalSize : 1, 0);
      resolved = true;
      resolve({ filePath: task.savePath, totalSize });
    });

    child.on('error', (err) => {
      clearInterval(pollInterval);
      if (killTimer) { clearTimeout(killTimer); killTimer = null; }
      reject(err);
    });
  });
}

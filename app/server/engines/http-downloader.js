/**
 * http-downloader.js - Multi-thread HTTP download engine for VortexDown
 * Uses Node.js native https/http module with redirect following
 * Streams directly to file, supports Range header for resume
 * Pure ESM, zero dependencies
 */

import http from 'node:http';
import https from 'node:https';
import { createWriteStream, existsSync, statSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_REDIRECTS = 10;
const RETRY_COUNT = 3;
const RETRY_DELAY = 2000;

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * Make an HTTP/HTTPS request with redirect following
 * @param {string} url - URL to request
 * @param {object} options - request options (headers, method)
 * @returns {Promise<{response: http.IncomingMessage, url: string}>}
 */
function requestWithRedirect(url, options = {}) {
  return new Promise((resolve, reject) => {
    let redirectCount = 0;
    let currentUrl = url;

    function doRequest(targetUrl) {
      redirectCount++;
      if (redirectCount > MAX_REDIRECTS) {
        reject(new Error(`Too many redirects (>${MAX_REDIRECTS}) for ${url}`));
        return;
      }

      // 将 URL 中的空格编码为 %20，避免 new URL() 抛出异常
      const safeUrl = targetUrl.replace(/ /g, '%20');
      const parsedUrl = new URL(safeUrl);
      const client = parsedUrl.protocol === 'https:' ? https : http;

      const reqOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: 30000,
      };

      const req = client.request(reqOptions, (res) => {
        // Handle redirects
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          let location = res.headers.location;
          // Handle relative redirects
          if (location.startsWith('/')) {
            location = `${parsedUrl.protocol}//${parsedUrl.hostname}${location}`;
          }
          // Consume response body to free memory
          res.resume();
          doRequest(location);
          return;
        }

        if (res.statusCode >= 400) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${targetUrl}`));
          return;
        }

        resolve({ response: res, url: targetUrl });
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.on('timeout', () => {
        req.destroy(new Error('Request timeout'));
      });

      if (options.body) {
        req.write(options.body);
      }
      req.end();
    }

    doRequest(currentUrl);
  });
}

/**
 * Extract filename from Content-Disposition header
 * @param {string} header - Content-Disposition header value
 * @returns {string|null} extracted filename or null
 */
function extractFilenameFromCD(header) {
  if (!header) return null;
  // filename*=UTF-8''encoded_name
  const utf8Match = header.match(/filename\*=(?:UTF-8''|utf-8'')(.+)/i);
  if (utf8Match) {
    try {
      return decodeURIComponent(utf8Match[1].replace(/"/g, '').trim());
    } catch {
      // fall through
    }
  }
  // filename="name"
  const quotedMatch = header.match(/filename="?([^;"]+)"?/i);
  if (quotedMatch) {
    try {
      return decodeURIComponent(quotedMatch[1].trim());
    } catch {
      return quotedMatch[1].trim();
    }
  }
  return null;
}

/**
 * Download a file via HTTP with progress reporting
 * @param {object} task - task object
 * @param {function} onProgress - callback(downloaded, total, speed)
 * @param {AbortSignal} signal - abort signal for cancellation
 * @returns {Promise<{filePath: string, totalSize: number}>}
 */
export async function downloadHTTP(task, onProgress, signal) {
  const url = task.url;
  const savePath = task.savePath;

  // Ensure output directory exists
  const dir = dirname(savePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Check for existing partial download
  let startByte = 0;
  let existingSize = 0;
  if (existsSync(savePath)) {
    const stat = statSync(savePath);
    existingSize = stat.size;
    startByte = stat.size;
  }

  let lastBytes = startByte;
  let speedSamples = [];
  let totalSize = 0;
  let attempt = 0;
  let finalUrl = url;

  while (attempt <= RETRY_COUNT) {
    try {
      const headers = {};

      if (startByte > 0) {
        headers.Range = `bytes=${startByte}-`;
      }

      // Anti-hotlink: set Referer and User-Agent to mimic browser
      const origin = new URL(finalUrl.replace(/ /g, '%20')).origin;
      headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
      headers['Referer'] = task.referer || origin + '/';
      headers['Accept'] = '*/*';
      headers['Accept-Language'] = 'zh-CN,zh;q=0.9,en;q=0.8';
      headers['Accept-Encoding'] = 'identity';

      const { response } = await requestWithRedirect(finalUrl, { headers });
      finalUrl = response.url || finalUrl;

      // Get total size
      if (response.statusCode === 206) {
        // Partial content - server supports resume
        const contentRange = response.headers['content-range'];
        if (contentRange) {
          const match = contentRange.match(/\/(\d+)/);
          if (match) {
            totalSize = parseInt(match[1], 10);
          }
        }
      } else {
        // Full content - server doesn't support resume, start from scratch
        totalSize = parseInt(response.headers['content-length'], 10) || 0;
        startByte = 0;
        existingSize = 0;
      }

      // Extract filename from Content-Disposition if needed
      if (!task.originalFilename) {
        const cd = response.headers['content-disposition'];
        if (cd) {
          task.originalFilename = extractFilenameFromCD(cd);
        }
      }

      // Stream to file
      const fileFlags = startByte > 0 ? 'a' : 'w';
      const writeStream = createWriteStream(savePath, { flags: fileFlags });
      let downloaded = startByte;

      // Speed calculation interval
      const speedInterval = setInterval(() => {
        const now = Date.now();
        const sample = { time: now, bytes: downloaded };
        speedSamples.push(sample);
        // Keep only last 5 seconds of samples
        speedSamples = speedSamples.filter(s => now - s.time < 5000);
        const speed = calculateSpeed(speedSamples);
        onProgress(downloaded, totalSize, speed);
      }, 1000);

      // Handle abort signal
      const abortHandler = () => {
        clearInterval(speedInterval);
        response.destroy();
        writeStream.close();
      };
      signal?.addEventListener('abort', abortHandler, { once: true });

      try {
        await new Promise((resolve, reject) => {
          response.on('data', (chunk) => {
            downloaded += chunk.length;
            writeStream.write(chunk);

            if (signal?.aborted) {
              reject(new Error('Download aborted'));
            }
          });

          response.on('end', () => {
            writeStream.end();
            resolve();
          });

          response.on('error', (err) => {
            writeStream.close();
            reject(err);
          });

          writeStream.on('error', (err) => {
            reject(err);
          });
        });
      } finally {
        clearInterval(speedInterval);
        signal?.removeEventListener('abort', abortHandler);
      }

      // Final progress update
      const finalSpeed = calculateSpeed(speedSamples);
      onProgress(downloaded, totalSize, finalSpeed);

      return {
        filePath: savePath,
        totalSize: downloaded,
        filename: task.originalFilename || savePath.split('/').pop(),
      };
    } catch (err) {
      attempt++;
      if (err.message === 'Download aborted') {
        throw err;
      }
      if (attempt > RETRY_COUNT) {
        throw new Error(`HTTP download failed after ${RETRY_COUNT} retries: ${err.message}`);
      }
      console.error(`[http-downloader] Attempt ${attempt}/${RETRY_COUNT} failed: ${err.message}`);
      await new Promise(r => setTimeout(r, RETRY_DELAY * attempt));
    }
  }

  throw new Error('HTTP download failed');
}

/**
 * Calculate speed from speed samples
 */
function calculateSpeed(samples) {
  if (samples.length < 2) return 0;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const timeDiff = (last.time - first.time) / 1000; // seconds
  if (timeDiff <= 0) return 0;
  const bytesDiff = last.bytes - first.bytes;
  return bytesDiff / timeDiff; // bytes per second
}

/**
 * Quick HEAD request to get file size without downloading
 */
export async function getHTTPInfo(url) {
  try {
    const { response } = await requestWithRedirect(url, {
      method: 'HEAD',
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const size = parseInt(response.headers['content-length'], 10) || 0;
    const acceptsRange = response.headers['accept-ranges'] === 'bytes';
    const cd = response.headers['content-disposition'];
    const filename = cd ? extractFilenameFromCD(cd) : null;
    return { size, acceptsRange, filename };
  } catch {
    return { size: 0, acceptsRange: false, filename: null };
  }
}

export { formatBytes };

/**
 * m3u8-downloader.js - M3U8 stream downloader engine for VortexDown
 * Parses m3u8 playlists, downloads segments, handles AES-128 decryption
 * Merges segments using ffmpeg concat demuxer
 * Pure ESM, zero dependencies (requires ffmpeg on system)
 */

import http from 'node:http';
import https from 'node:https';
import { createWriteStream, existsSync, mkdirSync, unlinkSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';

const MAX_REDIRECTS = 5;

/**
 * Make HTTP/HTTPS GET request with redirect following
 * @param {string} url - URL to fetch
 * @returns {Promise<{data: string, headers: object}>}
 */
async function fetchText(url, referer) {
  let redirectCount = 0;
  let currentUrl = url;

  async function doFetch(targetUrl) {
    redirectCount++;
    if (redirectCount > MAX_REDIRECTS) {
      throw new Error(`Too many redirects fetching ${url}`);
    }

    const origin = new URL(targetUrl).origin;
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(targetUrl);
      const client = parsedUrl.protocol === 'https:' ? https : http;

      const req = client.get({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Referer': referer || origin + '/',
          'Accept': '*/*',
        },
        timeout: 15000,
      }, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          let location = res.headers.location;
          if (location.startsWith('/')) {
            location = `${parsedUrl.protocol}//${parsedUrl.hostname}${location}`;
          }
          res.resume();
          doFetch(location);
          return;
        }

        if (res.statusCode >= 400) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} fetching ${targetUrl}`));
          return;
        }

        let data = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ data, headers: res.headers }));
        res.on('error', reject);
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('Timeout')); });
    });
  }

  return doFetch(currentUrl);
}

/**
 * Fetch a binary segment and save to file
 * @param {string} url - segment URL
 * @param {string} filePath - save path
 * @returns {Promise<number>} bytes written
 */
async function fetchSegment(url, filePath, referer) {
  let redirectCount = 0;
  let currentUrl = url;

  async function doFetch(targetUrl) {
    redirectCount++;
    if (redirectCount > MAX_REDIRECTS) {
      throw new Error(`Too many redirects fetching segment`);
    }

    const origin = new URL(targetUrl).origin;
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(targetUrl);
      const client = parsedUrl.protocol === 'https:' ? https : http;

      const req = client.get({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Referer': referer || origin + '/',
          'Accept': '*/*',
        },
        timeout: 30000,
      }, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          let location = res.headers.location;
          if (location.startsWith('/')) {
            location = `${parsedUrl.protocol}//${parsedUrl.hostname}${location}`;
          }
          res.resume();
          doFetch(location);
          return;
        }

        if (res.statusCode >= 400) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} fetching segment`));
          return;
        }

        const ws = createWriteStream(filePath);
        let bytes = 0;
        res.on('data', (chunk) => {
          bytes += chunk.length;
          ws.write(chunk);
        });
        res.on('end', () => {
          ws.end();
          resolve(bytes);
        });
        res.on('error', (err) => {
          ws.close();
          reject(err);
        });
        ws.on('error', reject);
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('Timeout')); });
    });
  }

  return doFetch(currentUrl);
}

/**
 * Resolve a relative URL against a base URL
 */
function resolveUrl(base, relative) {
  if (relative.startsWith('http://') || relative.startsWith('https://')) {
    return relative;
  }
  try {
    return new URL(relative, base).href;
  } catch {
    return `${base.replace(/\/[^/]*$/, '/')}${relative}`;
  }
}

/**
 * Parse a master playlist to find the best media playlist
 * @param {string} content - m3u8 content
 * @param {string} baseUrl - base URL for resolution
 * @returns {string} URL of the selected media playlist
 */
function parseMasterPlaylist(content, baseUrl) {
  const lines = content.split('\n');
  let bestBandwidth = 0;
  let bestUrl = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const bwMatch = line.match(/BANDWIDTH=(\d+)/);
      const bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;

      // Next non-comment, non-empty line is the URL
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j].trim();
        if (nextLine && !nextLine.startsWith('#')) {
          if (bandwidth > bestBandwidth) {
            bestBandwidth = bandwidth;
            bestUrl = resolveUrl(baseUrl, nextLine);
          }
          break;
        }
      }
    }
  }

  return bestUrl;
}

/**
 * Parse a media playlist to extract segments and key info
 * @param {string} content - m3u8 content
 * @param {string} baseUrl - base URL
 * @returns {Array<{url: string, duration: number, keyInfo: object|null}>}
 */
function parseMediaPlaylist(content, baseUrl) {
  const lines = content.split('\n');
  const segments = [];
  let currentKey = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Parse encryption key
    if (line.startsWith('#EXT-X-KEY')) {
      const methodMatch = line.match(/METHOD=([^,\s]+)/);
      if (methodMatch && methodMatch[1] === 'AES-128') {
        const uriMatch = line.match(/URI="([^"]+)"/);
        const ivMatch = line.match(/IV=0x([0-9a-fA-F]+)/);
        currentKey = {
          method: 'AES-128',
          uri: uriMatch ? resolveUrl(baseUrl, uriMatch[1]) : null,
          iv: ivMatch ? Buffer.from(ivMatch[1], 'hex') : null,
        };
      } else {
        currentKey = null; // no encryption or unsupported
      }
      continue;
    }

    // Parse segment
    if (line.startsWith('#EXTINF')) {
      const durationMatch = line.match(/#EXTINF:([\d.]+)/);
      const duration = durationMatch ? parseFloat(durationMatch[1]) : 0;

      // Next non-empty, non-comment line is the segment URL
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j].trim();
        if (nextLine && !nextLine.startsWith('#')) {
          segments.push({
            url: resolveUrl(baseUrl, nextLine),
            duration,
            keyInfo: currentKey ? { ...currentKey } : null,
          });
          break;
        }
      }
      continue;
    }
  }

  return segments;
}

/**
 * Decrypt an AES-128 encrypted segment
 * @param {string} segmentPath - encrypted segment file path
 * @param {object} keyInfo - key info {uri, iv}
 * @param {string} outputPath - decrypted output path
 * @param {string} baseUrl - base URL for key fetch
 */
async function decryptSegment(segmentPath, keyInfo, outputPath, baseUrl, referer) {
  // Fetch the key
  let keyData;
  try {
    const { data } = await fetchText(keyInfo.uri, referer);
    // The key might be base64 encoded
    const b64Match = data.trim().match(/^[A-Za-z0-9+/]+=*$/);
    if (b64Match) {
      keyData = Buffer.from(data.trim(), 'base64');
    } else {
      keyData = Buffer.from(data.trim(), 'utf-8');
    }
  } catch (err) {
    throw new Error(`Failed to fetch decryption key: ${err.message}`);
  }

  // Read encrypted data
  const encryptedData = readFileSync(segmentPath);

  // Determine IV
  let iv = keyInfo.iv;
  if (!iv) {
    // Default IV is the segment sequence number, but we use zero IV
    iv = Buffer.alloc(16, 0);
  }

  // Decrypt
  const decipher = createDecipheriv('aes-128-cbc', keyData, iv);
  const decrypted = Buffer.concat([
    decipher.update(encryptedData),
    decipher.final(),
  ]);

  writeFileSync(outputPath, decrypted);
}

/**
 * Download M3U8 with progress reporting
 * @param {object} task - task object
 * @param {function} onProgress - callback(downloaded, total, speed)
 * @param {AbortSignal} signal - abort signal
 * @param {number} concurrency - max concurrent segment downloads
 * @returns {Promise<{filePath: string, totalSize: number}>}
 */
export async function downloadM3U8(task, onProgress, signal, concurrency = 8) {
  const url = task.url;
  const savePath = task.savePath;
  const workDir = `${savePath}.vortexdown_tmp`;
  const referer = task.referer || new URL(url).origin + '/';

  // Ensure directories exist
  if (!existsSync(workDir)) {
    mkdirSync(workDir, { recursive: true });
  }
  const parentDir = dirname(savePath);
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  try {
    // Step 1: Fetch playlist
    if (signal?.aborted) throw new Error('Download aborted');
    const { data: playlistContent } = await fetchText(url, referer);

    // Step 2: Determine if master or media playlist
    const isMaster = playlistContent.includes('#EXT-X-STREAM-INF');
    let mediaPlaylistUrl = url;

    if (isMaster) {
      mediaPlaylistUrl = parseMasterPlaylist(playlistContent, url);
      if (!mediaPlaylistUrl) {
        throw new Error('Could not find a suitable media playlist in master playlist');
      }
      // Fetch the media playlist
      const { data: mediaContent } = await fetchText(mediaPlaylistUrl, referer);
      var segments = parseMediaPlaylist(mediaContent, mediaPlaylistUrl);
    } else {
      var segments = parseMediaPlaylist(playlistContent, url);
    }

    if (segments.length === 0) {
      throw new Error('No segments found in m3u8 playlist');
    }

    console.log(`[m3u8-downloader] Found ${segments.length} segments`);

    // Step 3: Download segments with concurrency control
    let completedSegments = 0;
    let totalDownloaded = 0;
    let speedSamples = [];
    const segmentFiles = [];
    let activeCount = 0;
    let segmentIndex = 0;

    const downloadSegmentWrapper = async (idx) => {
      if (signal?.aborted) throw new Error('Download aborted');

      const seg = segments[idx];
      const encPath = join(workDir, `seg_${String(idx).padStart(5, '0')}.enc`);
      const decPath = join(workDir, `seg_${String(idx).padStart(5, '0')}.ts`);

      try {
        // Download encrypted/raw segment
        await fetchSegment(seg.url, encPath, referer);
        let finalPath = encPath;

        // Decrypt if needed
        if (seg.keyInfo && seg.keyInfo.method === 'AES-128' && seg.keyInfo.uri) {
          await decryptSegment(encPath, seg.keyInfo, decPath, url, referer);
          finalPath = decPath;
          // Remove encrypted file to save space
          try { unlinkSync(encPath); } catch { /* ignore */ }
        }

        segmentFiles[idx] = finalPath;

        // Update progress
        completedSegments++;
        try {
          const fileSize = statSync(finalPath).size;
          totalDownloaded += fileSize;
        } catch { /* ignore */ }

        const now = Date.now();
        speedSamples.push({ time: now, bytes: totalDownloaded });
        speedSamples = speedSamples.filter(s => now - s.time < 5000);

        const speed = calculateSpeed(speedSamples);
        onProgress(completedSegments, segments.length, speed);
      } catch (err) {
        console.error(`[m3u8-downloader] Segment ${idx} failed: ${err.message}`);
        segmentFiles[idx] = null;
        throw err;
      }
    };

    // Concurrent download with semaphore-like pattern
    const downloadPromises = [];
    const results = new Array(segments.length).fill(null);
    let nextIdx = 0;

    async function worker() {
      while (nextIdx < segments.length) {
        if (signal?.aborted) throw new Error('Download aborted');
        const idx = nextIdx++;
        try {
          await downloadSegmentWrapper(idx);
          results[idx] = true;
        } catch (err) {
          results[idx] = false;
          throw err;
        }
      }
    }

    // Start workers
    const workers = [];
    const actualConcurrency = Math.min(concurrency, segments.length);
    for (let i = 0; i < actualConcurrency; i++) {
      workers.push(worker());
    }

    await Promise.all(workers);

    if (signal?.aborted) throw new Error('Download aborted');

    // Verify all segments downloaded
    const failedCount = results.filter(r => r === false).length;
    if (failedCount > 0) {
      throw new Error(`${failedCount} segments failed to download`);
    }

    // Step 4: Merge segments using ffmpeg
    console.log(`[m3u8-downloader] Merging ${segmentFiles.length} segments...`);

    // Write concat file for ffmpeg
    const concatFilePath = join(workDir, 'concat.txt');
    let concatContent = '';
    for (let i = 0; i < segmentFiles.length; i++) {
      if (segmentFiles[i]) {
        concatContent += `file '${segmentFiles[i]}'\n`;
      }
    }
    writeFileSync(concatFilePath, concatContent);

    // Merge with ffmpeg using concat demuxer
    await new Promise((resolve, reject) => {
      const ffmpegArgs = [
        '-f', 'concat',
        '-safe', '0',
        '-i', concatFilePath,
        '-c', 'copy',
        '-y',
        savePath,
      ];

      const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      ffmpeg.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
        }
      });

      ffmpeg.on('error', (err) => {
        reject(new Error(`Failed to start ffmpeg: ${err.message}. Please ensure ffmpeg is installed on the system.`));
      });
    });

    // Step 5: Cleanup temp files
    try {
      for (let i = 0; i < segmentFiles.length; i++) {
        if (segmentFiles[i]) {
          try { unlinkSync(segmentFiles[i]); } catch { /* ignore */ }
        }
      }
      try { unlinkSync(concatFilePath); } catch { /* ignore */ }
      try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    } catch { /* ignore cleanup errors */ }

    // Final progress
    let totalSize = 0;
    try { totalSize = statSync(savePath).size; } catch { /* ignore */ }

    onProgress(segments.length, segments.length, 0);

    return {
      filePath: savePath,
      totalSize,
      filename: savePath.split('/').pop(),
    };
  } catch (err) {
    // Cleanup on error
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Calculate speed from samples
 */
function calculateSpeed(samples) {
  if (samples.length < 2) return 0;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const timeDiff = (last.time - first.time) / 1000;
  if (timeDiff <= 0) return 0;
  return (last.bytes - first.bytes) / timeDiff;
}

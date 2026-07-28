/**
 * index.js - HTTP server entry point for VortexDown (Docker Edition)
 * Serves static files and API routes
 * Pure ESM, zero dependencies
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAPIHandler } from './api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, '..', 'ui');

const PORT = parseInt(process.env.PORT) || 19634;
const HOST = '0.0.0.0';

// Log startup info
console.log(`[server] VortexDown Docker starting...`);
console.log(`[server] PORT: ${PORT}`);
console.log(`[server] DATA_DIR: ${process.env.DATA_DIR || '(not set)'}`);
console.log(`[server] DOWNLOAD_DIR: ${process.env.DOWNLOAD_DIR || '(not set)'}`);

// MIME types
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Get MIME type from file extension
 */
function getMimeType(filepath) {
  const ext = filepath.split('.').pop().toLowerCase();
  return MIME_TYPES[`.${ext}`] || 'application/octet-stream';
}

/**
 * Serve static files
 */
function serveStatic(res, pathname) {
  let filePath;

  if (pathname === '/' || pathname === '/index.html') {
    filePath = join(UI_DIR, 'index.html');
    if (!existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    try {
      const content = readFileSync(filePath, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(content);
    } catch (err) {
      console.error(`[server] Error serving index.html:`, err.message);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
    return;
  }

  // Sanitize path to prevent directory traversal
  const safePath = pathname.replace(/\.\./g, '').replace(/\\/g, '');
  filePath = join(UI_DIR, safePath);

  if (!existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  try {
    const content = readFileSync(filePath);
    const mime = getMimeType(filePath);
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(content);
  } catch (err) {
    console.error(`[server] Error serving static file ${filePath}:`, err.message);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  }
}

/**
 * Get pathname from request URL
 */
function getPathname(reqUrl) {
  try {
    const parsedUrl = new URL(reqUrl, `http://${'localhost'}`);
    return parsedUrl.pathname;
  } catch {
    return reqUrl.split('?')[0];
  }
}

/**
 * Create and start the HTTP server
 */
async function main() {
  const apiHandler = createAPIHandler();

  const server = createServer((req, res) => {
    const pathname = getPathname(req.url);

    // Health check endpoint
    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', pid: process.pid }));
      return;
    }

    // API routes
    if (pathname.startsWith('/api/')) {
      apiHandler(req, res);
      return;
    }

    // Static files
    serveStatic(res, pathname);
  });

  server.on('error', (err) => {
    console.error(`[server] Error:`, err.message);
    if (err.code === 'EADDRINUSE') {
      console.error(`[server] Port ${PORT} is already in use.`);
      process.exit(1);
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`[server] VortexDown running at http://${HOST}:${PORT}`);
    console.log(`[server] Press Ctrl+C to stop`);
  });

  // Graceful shutdown
  const shutdown = (signal) => {
    console.log(`\n[server] Received ${signal}, shutting down...`);
    server.close(() => {
      console.log('[server] HTTP server closed');
      process.exit(0);
    });
    // Force exit after 5 seconds
    setTimeout(() => process.exit(1), 5000);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[server] Fatal error:', err);
  process.exit(1);
});

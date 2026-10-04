#!/usr/bin/env node
/**
 * serve.mjs — tiny static server for the dashboard's demo mode (no dependencies).
 *   npm run preview  →  http://localhost:4173/extension/dashboard/dashboard.html
 * Serves the repository root read-only, on 127.0.0.1 only, and refuses paths that
 * escape the root.
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 4173;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml',
};

export function createServer(root = ROOT) {
  return http.createServer(async (req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(root, `.${urlPath.endsWith('/') ? `${urlPath}index.html` : urlPath}`);
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500).end(err.code === 'ENOENT' ? 'not found' : 'error');
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer().listen(PORT, '127.0.0.1', () => {
    process.stdout.write(`Demo dashboard: http://localhost:${PORT}/extension/dashboard/dashboard.html\n`);
  });
}

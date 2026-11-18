// Zero-dependency static server for the sample site.
// Set SAMPLE_PREVIEW_TOKEN to simulate an auth-protected preview deployment: requests then need an
// `x-preview-token` header or a `preview_token` cookie with that value.
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const portFlag = process.argv.indexOf('--port');
const port = Number(portFlag > -1 ? process.argv[portFlag + 1] : process.env.PORT || 4173);
const token = process.env.SAMPLE_PREVIEW_TOKEN;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (token) {
      const cookie = /(?:^|;\s*)preview_token=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
      if (req.headers['x-preview-token'] !== token && cookie !== token) {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<h1>401 · This preview is protected</h1>');
        return;
      }
    }
    let file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (url.pathname.endsWith('/')) file = path.join(file, 'index.html');
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h1>404 · Not found</h1>');
    }
  })
  .listen(port, '127.0.0.1', () => console.log(`sample site on http://127.0.0.1:${port}`));

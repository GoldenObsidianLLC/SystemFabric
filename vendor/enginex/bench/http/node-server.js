'use strict';
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const engine = require('../../index');

const PORT = Number(process.env.PORT || 43181);
const views = path.join(__dirname, '..', 'views');
const locals = {
  user: { name: 'Ada & Lee' },
  products: [
    { name: 'Notebook', price: 8.5 },
    { name: 'Pen & pencil', price: 2.25 },
    { name: 'Monitor', price: 1234.5 }
  ]
};

async function main() {
  const template = await engine.load('sample.html', { views, cache: true });
  const prepared = template.prepareData(locals);
  const responseCache = engine.createResponseCache({ maxEntries: 8, maxBytes: 1024 * 1024, ttlMs: 30_000 });
  const pageKey = 'public:sample-v1';
  const initialHtml = template.renderPrepared(prepared);
  responseCache.set(pageKey, initialHtml);
  const etag = `"${crypto.createHash('sha256').update(initialHtml).digest('hex')}"`;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.end('ok');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' });
      res.end('Method Not Allowed');
      return;
    }
    let html;
    let mode;
    try {
      if (url.pathname === '/dynamic') {
        mode = 'compiled-render';
        html = template.render(locals);
      } else if (url.pathname === '/prepared') {
        mode = 'prepared-data';
        html = template.renderPrepared(prepared);
      } else if (url.pathname === '/page-cache') {
        mode = 'memory-page-cache';
        html = responseCache.get(pageKey);
        if (html === undefined) {
          html = template.renderPrepared(prepared);
          responseCache.set(pageKey, html);
        }
      } else if (url.pathname === '/stats') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ cache: responseCache.stats(), engine: engine.cacheStats() }));
        return;
      } else {
        res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
        res.end('Not Found');
        return;
      }
      const headers = {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(Buffer.byteLength(html)),
        'x-enginex-mode': mode,
        'cache-control': mode === 'memory-page-cache' ? 'public, max-age=0, s-maxage=30' : 'no-store',
        etag
      };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : html);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('Render failed');
      process.stderr.write(`${error.stack || error}\n`);
    }
  });
  server.listen(PORT, '127.0.0.1', () => process.stdout.write(`READY ${PORT}\n`));
}
main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });

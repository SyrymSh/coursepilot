import http from 'node:http';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const files = {
    '/content.js': ['extension/content.js', 'text/javascript'],
    '/core/ai.js': ['extension/core/ai.js', 'text/javascript'],
    '/harness.js': ['scripts/fixtures/browser-debug.js', 'text/javascript'],
    '/video-harness.js': ['scripts/fixtures/video-debug.js', 'text/javascript'],
    '/dashboard.html': ['extension/dashboard.html', 'text/html'],
    '/dashboard.js': ['extension/dashboard.js', 'text/javascript'],
    '/dashboard.css': ['extension/dashboard.css', 'text/css'],
  };
  const selected = files[pathname] || (pathname.startsWith('/learn/fixture/') ? ['scripts/fixtures/browser-debug.html', 'text/html']
    : pathname.startsWith('/learn/video-fixture/') ? ['scripts/fixtures/video-debug.html', 'text/html'] : null);
  if (!selected) { response.writeHead(404); response.end(); return; }
  try {
    response.writeHead(200, { 'Content-Type': `${selected[1]}; charset=utf-8`, 'Cache-Control': 'no-store' });
    response.end(await readFile(new URL(selected[0], root)));
  } catch { response.writeHead(500); response.end('Fixture unavailable'); }
});
server.listen(0, '127.0.0.1', () => console.log(`Local isolated fixture: http://127.0.0.1:${server.address().port}/learn/fixture/assignment-submission/check/debug`));

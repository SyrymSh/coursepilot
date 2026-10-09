import http from 'node:http';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const files = {
    '/content.js': ['extension/content.js', 'text/javascript'],
    '/core/ai.js': ['extension/core/ai.js', 'text/javascript'],
    '/harness.js': ['scripts/fixtures/browser-debug.js', 'text/javascript'],
    '/navigation-harness.js': ['scripts/fixtures/navigation-debug.js', 'text/javascript'],
    '/video-harness.js': ['scripts/fixtures/video-debug.js', 'text/javascript'],
    '/widget-harness.js': ['scripts/fixtures/widget-debug.js', 'text/javascript'],
    '/widget-frame.html': ['scripts/fixtures/widget-frame.html', 'text/html'],
    '/widget-frame-harness.js': ['scripts/fixtures/widget-frame.js', 'text/javascript'],
    '/widget-script.js': ['extension/widget.js', 'text/javascript'],
    '/widget-content.js': ['extension/content.js', 'text/javascript'],
    '/dashboard.html': ['extension/dashboard.html', 'text/html'],
    '/dashboard.js': ['extension/dashboard.js', 'text/javascript'],
    '/dashboard.css': ['extension/dashboard.css', 'text/css'],
  };
  const selected = files[pathname] || (pathname.startsWith('/learn/navigation-fixture/') ? ['scripts/fixtures/navigation-debug.html', 'text/html']
    : pathname.startsWith('/learn/fixture/') ? ['scripts/fixtures/browser-debug.html', 'text/html']
    : pathname.startsWith('/learn/video-fixture/') ? ['scripts/fixtures/video-debug.html', 'text/html']
    : pathname === '/learn/foundations-of-cybersecurity/ungradedWidget/l9B7s/explore-keep-organizations-secure' ? ['scripts/fixtures/widget-debug.html', 'text/html'] : null);
  if (!selected) { response.writeHead(404); response.end(); return; }
  try {
    response.writeHead(200, { 'Content-Type': `${selected[1]}; charset=utf-8`, 'Cache-Control': 'no-store' });
    let body = await readFile(new URL(selected[0], root), 'utf8');
    if (pathname === '/widget-script.js' || pathname === '/widget-content.js') {
      body = body.replace('https://d10o6em2qtnr4q.cloudfront.net/assets/d96617fd0cc347daaf2a8420f66905f1/tmp/S30P001-security-analysts-en/index.html', `http://127.0.0.1:${server.address().port}/widget-frame.html`);
    }
    response.end(body);
  } catch { response.writeHead(500); response.end('Fixture unavailable'); }
});
server.listen(0, '127.0.0.1', () => console.log(`Local isolated fixture: http://127.0.0.1:${server.address().port}/learn/fixture/assignment-submission/check/debug`));

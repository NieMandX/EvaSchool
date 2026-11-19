import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const html = new URL('../dist/index.html', import.meta.url);
const port = Number(process.env.KONTUR_PORT ?? 4387);
createServer(async (request, response) => {
  if (!['/', '/index.html'].includes(new URL(request.url, 'http://localhost').pathname)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const contents = await readFile(html);
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(contents);
  } catch {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Run npm run build first.');
  }
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}`));

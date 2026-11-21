import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRankingApi } from '../server/rankings.mjs';

const service = process.argv.includes('--service');
const html = new URL(service ? '../dist-service/index.html' : '../dist/index.html', import.meta.url);
const port = Number(process.env.KONTUR_PORT ?? (service ? 4388 : 4387));
const rankings = createRankingApi();
const server = createServer(async (request, response) => {
  if (await rankings.handle(request, response)) return;
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
    response.end(`Run npm run ${service ? 'build:service' : 'build'} first.`);
  }
});
server.once('close', rankings.close);
server.listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}`));

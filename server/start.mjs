import { createServer } from 'node:http';
import { createRankingApi } from './rankings.mjs';

const port = Number(process.env.KONTUR_RANKINGS_PORT ?? 4389);
const host = process.env.KONTUR_RANKINGS_HOST || '127.0.0.1';
const rankings = createRankingApi();
const server = createServer(async (request, response) => {
  if (!await rankings.handle(request, response)) response.writeHead(404).end();
});
server.once('close', rankings.close);
server.listen(port, host, () => console.log(`Ranking API listening on ${host}:${server.address().port}`));

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { LEADERBOARD, LEADERBOARD_PATH, MAX_BODY_BYTES, PLAYER_PATH, PUT_PLAYER, parsePlayer, playerToken } from './ranking-sql.mjs';

const DEFAULT_DATABASE = fileURLToPath(new URL('../.kontur-ranking.sqlite', import.meta.url));
const SCHEMA = readFileSync(new URL('./migrations/0001_rankings.sql', import.meta.url), 'utf8');

function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
  return true;
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  if (Number(request.headers['content-length']) > MAX_BODY_BYTES) return undefined;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch {
    return null;
  }
}

export function createRankingApi({
  databasePath = process.env.KONTUR_RANKINGS_DB || DEFAULT_DATABASE,
  origin = process.env.KONTUR_RANKINGS_ORIGIN,
} = {}) {
  const originURL = origin ? new URL(origin) : null;
  if (originURL && !['http:', 'https:'].includes(originURL.protocol)) {
    throw new Error('KONTUR_RANKINGS_ORIGIN must be an HTTP(S) origin');
  }
  const allowedOrigin = originURL?.origin;

  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA busy_timeout = 2500');
  database.exec(SCHEMA);
  const putPlayer = database.prepare(PUT_PLAYER);
  const leaderboard = database.prepare(LEADERBOARD);

  return {
    async handle(request, response) {
      let path;
      try {
        path = new URL(request.url, 'http://localhost').pathname;
      } catch {
        return send(response, 400, { error: 'Invalid request URL' });
      }
      if (path !== PLAYER_PATH && path !== LEADERBOARD_PATH) return false;
      const method = path === PLAYER_PATH ? 'PUT' : 'GET';
      const cors = Boolean(allowedOrigin && request.headers.origin === allowedOrigin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Cache-Control', 'no-store');
      if (cors) response.setHeader('Access-Control-Allow-Origin', allowedOrigin);

      if (request.method === 'OPTIONS') {
        if (request.headers.origin && !cors) return send(response, 403, { error: 'Origin is not allowed' });
        response.setHeader('Allow', `${method}, OPTIONS`);
        if (cors) {
          response.setHeader('Access-Control-Allow-Methods', method);
          response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        }
        response.writeHead(204).end();
        return true;
      }
      if (request.method !== method) {
        response.setHeader('Allow', `${method}, OPTIONS`);
        return send(response, 405, { error: 'Method is not allowed' });
      }

      try {
        if (path === LEADERBOARD_PATH) return send(response, 200, { entries: leaderboard.all() });

        const token = playerToken(request.headers.authorization);
        if (!token) {
          request.resume();
          response.setHeader('WWW-Authenticate', 'Bearer');
          return send(response, 401, { error: 'Player token is required' });
        }
        const body = await readBody(request);
        if (body === undefined) {
          request.resume();
          response.setHeader('Connection', 'close');
          return send(response, 413, { error: 'Request body is too large' });
        }
        const player = parsePlayer(body);
        if (!player) return send(response, 400, { error: 'Invalid player name or score' });
        const { name, best } = player;
        const key = createHash('sha256').update(Buffer.from(token, 'hex')).digest('hex');
        return send(response, 200, putPlayer.get(key, name, best));
      } catch {
        return send(response, 500, { error: 'Ranking is unavailable' });
      }
    },
    close: () => database.close(),
  };
}

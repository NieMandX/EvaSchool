import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { ROUND_LENGTH } from '../src/questions.js';

const PLAYER = '/api/ranking/player';
const LEADERBOARD = '/api/ranking/leaderboard';
const MAX_BODY_BYTES = 1024;
const DEFAULT_DATABASE = fileURLToPath(new URL('../.kontur-ranking.sqlite', import.meta.url));

function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
  return true;
}

function playerName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/gu, ' ').normalize('NFC');
  const length = [...name].length;
  return length >= 2 && length <= 24 && !/[\p{Cc}\p{Cf}]/u.test(name) ? name : null;
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
  database.exec(`
    PRAGMA busy_timeout = 2500;
    CREATE TABLE IF NOT EXISTS ranking_players (
      player_key TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      best INTEGER CHECK (best BETWEEN 0 AND ${ROUND_LENGTH})
    ) STRICT;
    CREATE INDEX IF NOT EXISTS ranking_by_best ON ranking_players (best DESC, name, player_key)
      WHERE best IS NOT NULL;
  `);
  const putPlayer = database.prepare(`
    INSERT INTO ranking_players (player_key, name, best) VALUES (?, ?, ?)
    ON CONFLICT (player_key) DO UPDATE SET
      name = excluded.name,
      best = CASE
        WHEN ranking_players.best IS NULL OR excluded.best > ranking_players.best THEN excluded.best
        ELSE ranking_players.best
      END
    RETURNING best
  `);
  const leaderboard = database.prepare(`
    SELECT RANK() OVER (ORDER BY best DESC) AS rank, name, best
    FROM (
      SELECT player_key, name, best FROM ranking_players
      WHERE best IS NOT NULL ORDER BY best DESC, name, player_key LIMIT 10
    )
    ORDER BY best DESC, name, player_key
  `);

  return {
    async handle(request, response) {
      let path;
      try {
        path = new URL(request.url, 'http://localhost').pathname;
      } catch {
        return send(response, 400, { error: 'Invalid request URL' });
      }
      if (path !== PLAYER && path !== LEADERBOARD) return false;
      const method = path === PLAYER ? 'PUT' : 'GET';
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
        if (path === LEADERBOARD) return send(response, 200, { entries: leaderboard.all() });

        const token = /^Bearer ([\da-f]{64})$/i.exec(request.headers.authorization ?? '')?.[1];
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
        const name = playerName(body?.name);
        const best = body?.best;
        if (!name || (best !== null && (!Number.isInteger(best) || best < 0 || best > ROUND_LENGTH))) {
          return send(response, 400, { error: 'Invalid player name or score' });
        }
        const key = createHash('sha256').update(Buffer.from(token, 'hex')).digest('hex');
        return send(response, 200, putPlayer.get(key, name, best));
      } catch {
        return send(response, 500, { error: 'Ranking is unavailable' });
      }
    },
    close: () => database.close(),
  };
}

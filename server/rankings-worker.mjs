import {
  DELETE_PLAYER, LEADERBOARD, LEADERBOARD_PATH, MAX_BODY_BYTES, PLAYER_PATH, PUT_PLAYER, parsePlayer, playerToken,
} from './ranking-sql.mjs';

const DEFAULT_ORIGIN = 'https://niemandx.github.io';

async function readBody(request) {
  if (Number(request.headers.get('Content-Length')) > MAX_BODY_BYTES) return undefined;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const bytes = new Uint8Array(MAX_BODY_BYTES);
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (size + value.byteLength > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        return undefined;
      }
      bytes.set(value, size);
      size += value.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
    } catch {
      return null;
    }
  } finally {
    reader.releaseLock();
  }
}

async function playerKey(token) {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(token.slice(2 * i, 2 * i + 2), 16);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request, env) {
    const headers = new Headers({ 'Cache-Control': 'no-store', Vary: 'Origin' });
    const json = (status, body) => Response.json(body, { status, headers });
    const noContent = () => new Response(null, { status: 204, headers });
    const path = new URL(request.url).pathname;
    if (path !== PLAYER_PATH && path !== LEADERBOARD_PATH) return json(404, { error: 'Not found' });

    try {
      const configured = new URL(env.KONTUR_RANKINGS_ORIGIN || DEFAULT_ORIGIN);
      if (!['http:', 'https:'].includes(configured.protocol)) throw new Error('Invalid origin configuration');
      const origin = request.headers.get('Origin');
      if (origin !== null && origin !== configured.origin) return json(403, { error: 'Origin is not allowed' });
      if (origin !== null) headers.set('Access-Control-Allow-Origin', configured.origin);

      const methods = path === PLAYER_PATH ? ['PUT', 'DELETE'] : ['GET'];
      if (request.method === 'OPTIONS' || !methods.includes(request.method)) {
        headers.set('Allow', [...methods, 'OPTIONS'].join(', '));
        if (request.method !== 'OPTIONS') return json(405, { error: 'Method is not allowed' });
        if (origin !== null) {
          headers.set('Access-Control-Allow-Methods', methods.join(', '));
          headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
          headers.set('Access-Control-Max-Age', '600');
        }
        return noContent();
      }

      if (path === LEADERBOARD_PATH) {
        const { results } = await env.DB.prepare(LEADERBOARD).all();
        return json(200, { entries: results });
      }

      const token = playerToken(request.headers.get('Authorization'));
      if (!token) {
        headers.set('WWW-Authenticate', 'Bearer');
        return json(401, { error: 'Player token is required' });
      }
      if (request.method === 'DELETE') {
        await env.DB.prepare(DELETE_PLAYER).bind(await playerKey(token)).run();
        return noContent();
      }

      const body = await readBody(request);
      if (body === undefined) return json(413, { error: 'Request body is too large' });
      const player = parsePlayer(body);
      if (!player) return json(400, { error: 'Invalid player name or score' });
      const { name, best } = player;
      const saved = await env.DB.prepare(PUT_PLAYER).bind(await playerKey(token), name, best).first();
      if (!saved) throw new Error('Ranking write did not return a score');
      return json(200, { best: saved.best });
    } catch {
      return json(500, { error: 'Ranking is unavailable' });
    }
  },
};

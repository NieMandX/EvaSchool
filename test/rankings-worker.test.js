import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import worker from '../server/rankings-worker.mjs';
import { ROUND_LENGTH } from '../src/questions.js';

const APP = 'https://niemandx.github.io';
const API = 'https://api.example';
const PLAYER = '/api/ranking/player';
const LEADERBOARD = '/api/ranking/leaderboard';
const SCHEMA = readFileSync(new URL('../server/migrations/0001_rankings.sql', import.meta.url), 'utf8');
const token = number => number.toString(16).padStart(64, 'a');

function fixture(t, settings = {}) {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  database.exec(SCHEMA);
  const DB = {
    prepare(sql) {
      const query = database.prepare(sql);
      function statement(args) {
        return {
          bind: (...values) => statement(values),
          first: async () => query.get(...args) ?? null,
          all: async () => ({ results: query.all(...args) }),
          run: async () => ({ meta: query.run(...args) }),
        };
      }
      return statement([]);
    },
  };
  const call = (path, options) => worker.fetch(new Request(API + path, options), { DB, ...settings });
  const put = (playerToken, name, best) => call(PLAYER, {
    method: 'PUT', headers: { Origin: APP, Authorization: `Bearer ${playerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, best }),
  });
  return { call, put, database };
}

test('Worker uses migration schema and stores max scores keyed by the same token digest as Node', async t => {
  const { call, put, database } = fixture(t);
  const key = token(1);
  assert.deepEqual(await (await put(key, 'Без игры', null)).json(), { best: null });
  assert.deepEqual(await (await call(LEADERBOARD)).json(), { entries: [] });
  assert.deepEqual(await (await put(key, 'Игрок', 0)).json(), { best: 0 });
  assert.deepEqual(await (await call(LEADERBOARD)).json(), { entries: [{ rank: 1, name: 'Игрок', best: 0 }] });
  assert.equal((await put(key, 'Игрок', ROUND_LENGTH + 1)).status, 400);
  assert.deepEqual(await (await put(key, 'Игрок', ROUND_LENGTH)).json(), { best: ROUND_LENGTH });
  assert.deepEqual(await (await put(key.toUpperCase(), '  Игрок   Е\u0308  ', 3)).json(), { best: ROUND_LENGTH });
  assert.equal((await put(key, 'Иг\u202eрок', 3)).status, 400);
  assert.equal(database.prepare('SELECT player_key FROM ranking_players').get().player_key,
    createHash('sha256').update(Buffer.from(key, 'hex')).digest('hex'));

  assert.equal((await put(token(2), 'Боря', ROUND_LENGTH)).status, 200);
  assert.equal((await put(token(3), 'Аня', 4)).status, 200);
  const response = await call(LEADERBOARD, { headers: { Origin: APP } });
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), APP);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), { entries: [
    { rank: 1, name: 'Боря', best: ROUND_LENGTH },
    { rank: 1, name: 'Игрок Ё', best: ROUND_LENGTH },
    { rank: 3, name: 'Аня', best: 4 },
  ] });
});

test('Worker rejects foreign origin requests and allows configured origin to delete only its own record', async t => {
  const origin = 'https://quiz.example';
  const { call, database } = fixture(t, { KONTUR_RANKINGS_ORIGIN: origin });
  const key = token(3);
  const headers = { Origin: origin, Authorization: `Bearer ${key}` };
  const preflight = await call(PLAYER, { method: 'OPTIONS', headers: {
    Origin: origin, 'Access-Control-Request-Method': 'DELETE', 'Access-Control-Request-Headers': 'Authorization',
  } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Vary'), 'Origin');
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'PUT, DELETE');
  assert.equal(preflight.headers.get('Access-Control-Allow-Headers'), 'Authorization, Content-Type');

  for (const method of ['OPTIONS', 'DELETE']) {
    const foreign = await call(PLAYER, { method, headers: { ...headers, Origin: APP } });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.headers.get('Access-Control-Allow-Origin'), null);
  }
  const noToken = await call(PLAYER, { method: 'DELETE', headers: { Origin: origin } });
  assert.equal(noToken.status, 401);
  assert.equal(noToken.headers.get('WWW-Authenticate'), 'Bearer');
  for (const auth of [headers.Authorization, `Bearer ${token(4)}`]) {
    assert.equal((await call(PLAYER, {
      method: 'PUT', headers: { ...headers, Authorization: auth }, body: JSON.stringify({ name: 'Игрок', best: 0 }),
    })).status, 200);
  }
  for (let n = 0; n < 2; n++) {
    const deletion = await call(PLAYER, { method: 'DELETE', headers });
    assert.equal(deletion.status, 204);
    assert.equal(deletion.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(await deletion.text(), '');
  }
  const rows = database.prepare('SELECT player_key FROM ranking_players').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].player_key, createHash('sha256').update(Buffer.from(token(4), 'hex')).digest('hex'));
});

test('Worker bounds a streamed upload without trusting Content-Length and reports unavailable storage', async t => {
  const { call } = fixture(t);
  const headers = { Origin: APP, Authorization: `Bearer ${token(3)}` };
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(600));
      controller.enqueue(new Uint8Array(600));
    },
    cancel() { cancelled = true; },
  });
  const oversize = await call(PLAYER, { method: 'PUT', headers, body, duplex: 'half' });
  assert.equal(oversize.status, 413);
  assert.equal(cancelled, true);
  assert.equal((await call(PLAYER, { method: 'PUT', headers, body: new Uint8Array([255]) })).status, 400);
  const unavailable = await worker.fetch(new Request(API + LEADERBOARD, { headers: { Origin: APP } }), {});
  assert.equal(unavailable.status, 500);
  assert.deepEqual(await unavailable.json(), { error: 'Ranking is unavailable' });
  assert.equal(unavailable.headers.get('Cache-Control'), 'no-store');
});

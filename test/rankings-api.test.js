import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createRankingApi } from '../server/rankings.mjs';
import { ROUND_LENGTH } from '../src/questions.js';

const PLAYER = '/api/ranking/player';
const LEADERBOARD = '/api/ranking/leaderboard';
const key = player => player.toString(16).padStart(64, 'a');

async function call(api, url, { method = 'GET', headers = {}, chunks = [] } = {}) {
  const request = Object.assign(Readable.from(chunks), { url, method, headers });
  const responseHeaders = {};
  let status, body;
  const response = {
    setHeader(name, value) { responseHeaders[name.toLowerCase()] = value; },
    writeHead(code, fields = {}) {
      status = code;
      for (const [name, value] of Object.entries(fields)) this.setHeader(name, value);
      return this;
    },
    end(content) { body = content ? JSON.parse(content) : undefined; },
  };
  const handled = await api.handle(request, response);
  return { handled, status, headers: responseHeaders, body };
}

const put = (api, token, body) => call(api, PLAYER, {
  method: 'PUT', headers: { authorization: `Bearer ${token}` }, chunks: [Buffer.from(JSON.stringify(body))],
});

test('a profile stores its max played score across connections and survives a restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kontur-rankings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'ranking.sqlite');
  const first = createRankingApi({ databasePath });
  const second = createRankingApi({ databasePath });
  const token = key(1);
  try {
    assert.deepEqual((await put(first, token, { name: 'Аня', best: null })).body, { best: null });
    assert.deepEqual((await call(second, LEADERBOARD)).body, { entries: [] });
    assert.deepEqual((await put(first, token, { name: 'Аня', best: 0 })).body, { best: 0 });
    assert.deepEqual((await call(second, LEADERBOARD)).body.entries, [{ rank: 1, name: 'Аня', best: 0 }]);
    await Promise.all([8, ROUND_LENGTH, 3].map((best, index) => put(index ? second : first, token, { name: 'Аня', best })));
    const best = { best: ROUND_LENGTH };
    assert.deepEqual((await put(first, token, { name: 'Аня', best: null })).body, best);
    assert.deepEqual((await put(second, token.toUpperCase(), { name: '  Аня \t  Е\u0308  ', best: 7 })).body, best);
    await put(first, key(4), { name: 'Ещё без игры', best: null });
  } finally {
    first.close();
    second.close();
  }

  const reopened = createRankingApi({ databasePath });
  try {
    assert.deepEqual((await call(reopened, LEADERBOARD)).body, {
      entries: [{ rank: 1, name: 'Аня Ё', best: ROUND_LENGTH }],
    });
    const database = new DatabaseSync(databasePath);
    try {
      const stored = database.prepare('SELECT player_key FROM ranking_players WHERE best = ?').get(ROUND_LENGTH);
      assert.equal(stored.player_key, createHash('sha256').update(Buffer.from(token, 'hex')).digest('hex'));
      assert.notEqual(stored.player_key, token);
    } finally {
      database.close();
    }
  } finally {
    reopened.close();
  }
});

test('leaderboard has ten entries with deterministic ties and shared rank', async t => {
  const api = createRankingApi({ databasePath: ':memory:' });
  t.after(api.close);
  await put(api, key(1), { name: 'Боря', best: ROUND_LENGTH });
  await put(api, key(2), { name: 'Аня', best: ROUND_LENGTH });
  for (let score = 0; score < ROUND_LENGTH; score++) {
    await put(api, key(10 + score), { name: `Игрок ${score}`, best: score });
  }
  const { body, headers } = await call(api, LEADERBOARD);
  assert.equal(headers['cache-control'], 'no-store');
  assert.equal(body.entries.length, 10);
  assert.deepEqual(body.entries.slice(0, 3), [
    { rank: 1, name: 'Аня', best: ROUND_LENGTH },
    { rank: 1, name: 'Боря', best: ROUND_LENGTH },
    { rank: 3, name: 'Игрок 9', best: 9 },
  ]);
  assert.deepEqual(body.entries.at(-1), { rank: 10, name: 'Игрок 2', best: 2 });
  assert.deepEqual((await call(api, LEADERBOARD)).body, body);
});

test('validates registration, bounds payloads, and permits only the configured cross-origin browser', async t => {
  const origin = 'https://quiz.example';
  const api = createRankingApi({ databasePath: ':memory:', origin });
  t.after(api.close);
  assert.equal((await call(api, '/')).handled, false);
  assert.equal((await call(api, PLAYER)).status, 405);
  assert.equal((await put(api, 'bad-token', { name: 'Аня', best: 0 })).status, 401);
  for (const body of [
    { name: 'А', best: 0 }, { name: 'А'.repeat(25), best: 0 }, { name: 'А\0ня', best: 0 },
    { name: 'А\u202eня', best: 0 }, { name: 'Аня', best: -1 }, { name: 'Аня', best: .5 }, { name: 'Аня' },
    { name: 'Аня', best: ROUND_LENGTH + 1 },
  ]) assert.equal((await put(api, key(1), body)).status, 400);

  const oversized = await call(api, PLAYER, {
    method: 'PUT', headers: { authorization: `Bearer ${key(1)}` }, chunks: [Buffer.alloc(600), Buffer.alloc(600)],
  });
  assert.equal(oversized.status, 413);
  const preflight = await call(api, PLAYER, { method: 'OPTIONS', headers: {
    origin, 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization,content-type',
  } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], origin);
  assert.equal(preflight.headers['access-control-allow-methods'], 'PUT');
  assert.equal(preflight.headers['access-control-allow-headers'], 'Authorization, Content-Type');
  assert.equal(preflight.headers.vary, 'Origin');
  const external = await call(api, PLAYER, { method: 'OPTIONS', headers: { origin: 'https://elsewhere.example' } });
  assert.equal(external.status, 403);
  assert.equal(external.headers['access-control-allow-origin'], undefined);
  assert.equal((await call(api, LEADERBOARD, { headers: { origin } })).headers['access-control-allow-origin'], origin);
  assert.equal((await call(api, LEADERBOARD)).headers['access-control-allow-origin'], undefined);
});

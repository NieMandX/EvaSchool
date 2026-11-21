import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlayerStore, localLeaderboard } from '../src/players.js';

function testStorage() {
  let saved = null;
  return { getItem: () => saved, setItem: (_, value) => { saved = value; } };
}

test('names select separate profiles and lower scores leave each personal best intact', () => {
  const storage = testStorage();
  let id = 0;
  const players = createPlayerStore({ storage, createToken: () => String(++id).repeat(64) });
  const alice = players.select('  Алиса  ', false);
  assert.equal(alice.name, 'Алиса');
  assert.equal(alice.best, null);
  assert.equal(players.record(alice.token, 8).improved, true);
  const max = players.select('Макс', false);
  assert.notEqual(max.token, alice.token);
  assert.equal(players.record(max.token, 4).player.best, 4);
  assert.equal(players.record(alice.token, 3).player.best, 8);
  assert.equal(players.select('АЛИСА', false).token, alice.token);
  assert.equal(createPlayerStore({ storage }).snapshot().active, alice.token);
  assert.deepEqual(createPlayerStore({ storage }).snapshot().profiles.map(profile => profile.best), [8, 4]);
});

test('played zeroes qualify for ranking and ties share a place', () => {
  const profiles = [
    { token: 'a', name: 'Борис', best: 5 },
    { token: 'b', name: 'Анна', best: 5 },
    { token: 'c', name: 'Вера', best: 0 },
    { token: 'd', name: 'Саша', best: null },
  ];
  const entries = localLeaderboard(profiles, 'a');
  assert.deepEqual(entries.map(({ rank, name, active }) => [rank, name, active]), [
    [1, 'Анна', false], [1, 'Борис', true], [3, 'Вера', false],
  ]);
});

test('a local nickname only joins the shared ranking when explicitly reselected', () => {
  const players = createPlayerStore({ storage: null, createToken: () => 'a'.repeat(64) });
  assert.throws(() => players.select(' ', true), /2 до 24/);
  assert.equal(players.select('Игрок', false).shared, false);
  assert.equal(players.select('Игрок', true).shared, true);
  assert.equal(players.select('Игрок', false).shared, true);
  assert.equal(players.record('a'.repeat(64), 11), null);
});

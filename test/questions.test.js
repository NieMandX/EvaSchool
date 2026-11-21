import assert from 'node:assert/strict';
import test from 'node:test';
import { nextDeck, ROUND_LENGTH } from '../src/questions.js';

const ids = deck => deck.map(question => question.id);
const early = () => 0;
const late = () => .999999;

test('the first round samples different countries from the whole pool', () => {
  const first = ids(nextDeck(undefined, early));
  const second = ids(nextDeck(undefined, late));
  assert.equal(first.length, ROUND_LENGTH);
  assert.equal(new Set(first).size, ROUND_LENGTH);
  assert(!first.every(id => second.includes(id)));
});

test('new rounds use unseen countries until there are too few to fill a round', () => {
  const played = new Set();
  for (let round = 0; round < 3; round++) {
    const deck = ids(nextDeck(played, early));
    assert.equal(new Set(deck).size, ROUND_LENGTH);
    assert(deck.every(id => !played.has(id)));
    for (const id of deck) played.add(id);
  }
  assert.deepEqual(ids(nextDeck(played, late)), ids(nextDeck(undefined, late)));
  assert.equal(played.size, 0);
});

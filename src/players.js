import { ROUND_LENGTH } from './questions.js';

const STORAGE_KEY = 'kontur.players.v1';
const nameKey = name => name.toLocaleLowerCase('ru');
const isScore = value => Number.isInteger(value) && value >= 0 && value <= ROUND_LENGTH;
const isToken = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function playerName(value) {
  const name = value.trim().replace(/\s+/gu, ' ').normalize('NFC');
  const length = [...name].length;
  if (length < 2 || length > 24 || /[\p{Cc}\p{Cf}]/u.test(name)) {
    throw new Error('Введи имя от 2 до 24 символов.');
  }
  return name;
}

function browserStorage() {
  try { return globalThis.localStorage; } catch { return null; }
}

function playerToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function localLeaderboard(profiles, active) {
  const ranked = profiles.filter(profile => isScore(profile.best)).sort((a, b) =>
    b.best - a.best || a.name.localeCompare(b.name, 'ru'));
  let rank = 0;
  return ranked.slice(0, 10).map(({ name, best, token }, i) => {
    if (best !== ranked[i - 1]?.best) rank = i + 1;
    return { rank, name, best, active: token === active };
  });
}

export function createPlayerStore({ storage = browserStorage(), createToken = playerToken } = {}) {
  let state = { seen: false, active: null, profiles: [] };
  let persistent = Boolean(storage);

  function read() {
    if (!persistent) return state;
    try {
      const saved = JSON.parse(storage.getItem(STORAGE_KEY));
      if (saved && Array.isArray(saved.profiles)) {
        saved.profiles = saved.profiles.filter(profile => profile && isToken(profile.token) &&
          typeof profile.name === 'string' && (profile.best === null || isScore(profile.best)));
        if (!saved.profiles.some(profile => profile.token === saved.active)) saved.active = null;
        state = saved;
      }
    } catch {
      persistent = false;
    }
    return state;
  }

  function update(mutate) {
    const data = read();
    const result = mutate(data);
    if (persistent) {
      try { storage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch { persistent = false; }
    }
    return result;
  }

  return {
    snapshot: read,
    dismiss() { update(data => { data.seen = true; }); },
    select(value, shared) {
      const name = playerName(value);
      return update(data => {
        let player = data.profiles.find(profile => nameKey(profile.name) === nameKey(name));
        if (!player) {
          player = { name, token: createToken(), best: null, shared: false };
          data.profiles.push(player);
        }
        if (shared) player.shared = true;
        data.seen = true;
        data.active = player.token;
        return player;
      });
    },
    record(token, score) {
      if (!isScore(score)) return null;
      return update(data => {
        const player = data.profiles.find(profile => profile.token === token);
        if (!player) return null;
        const previous = player.best;
        player.best = Math.max(previous ?? 0, score);
        return { player, improved: score > (previous ?? 0) };
      });
    },
  };
}

export function createRankingClient(configured, location) {
  if (location.protocol === 'file:') return null;
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
  const base = configured || (local ? location.origin + '/api/ranking' : '');
  if (!base) return null;
  const endpoint = base.replace(/\/+$/, '');

  async function request(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch(endpoint + path, {
        credentials: 'omit', cache: 'no-store', signal: controller.signal, ...options,
      });
      if (!response.ok) throw new Error('Ranking unavailable');
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async record({ name, best, token }) {
      const result = await request('/player', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, best }),
      });
      return result.best;
    },
    async leaderboard() {
      const { entries } = await request('/leaderboard');
      return entries;
    },
  };
}

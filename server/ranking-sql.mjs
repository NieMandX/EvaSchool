import { ROUND_LENGTH } from '../src/questions.js';

export const PLAYER_PATH = '/api/ranking/player';
export const LEADERBOARD_PATH = '/api/ranking/leaderboard';
export const MAX_BODY_BYTES = 1024;

export function parsePlayer(body) {
  const { name: rawName, best } = body ?? {};
  if (typeof rawName !== 'string' || (best !== null && (!Number.isInteger(best) || best < 0 || best > ROUND_LENGTH))) {
    return null;
  }
  const name = rawName.trim().replace(/\s+/gu, ' ').normalize('NFC');
  const length = [...name].length;
  return length >= 2 && length <= 24 && !/[\p{Cc}\p{Cf}]/u.test(name) ? { name, best } : null;
}

export function playerToken(authorization) {
  return /^Bearer ([\da-f]{64})$/i.exec(authorization ?? '')?.[1];
}

export const PUT_PLAYER = `
  INSERT INTO ranking_players (player_key, name, best) VALUES (?, ?, ?)
  ON CONFLICT (player_key) DO UPDATE SET
    name = excluded.name,
    best = CASE
      WHEN ranking_players.best IS NULL OR excluded.best > ranking_players.best THEN excluded.best
      ELSE ranking_players.best
    END
  RETURNING best
`;

export const LEADERBOARD = `
  SELECT RANK() OVER (ORDER BY best DESC) AS rank, name, best
  FROM (
    SELECT player_key, name, best FROM ranking_players
    WHERE best IS NOT NULL ORDER BY best DESC, name, player_key LIMIT 10
  )
  ORDER BY best DESC, name, player_key
`;

export const DELETE_PLAYER = 'DELETE FROM ranking_players WHERE player_key = ?';

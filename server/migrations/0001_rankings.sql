CREATE TABLE IF NOT EXISTS ranking_players (
  player_key TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  best INTEGER CHECK (best BETWEEN 0 AND 10)
) STRICT;
CREATE INDEX IF NOT EXISTS ranking_by_best ON ranking_players (best DESC, name, player_key)
  WHERE best IS NOT NULL;

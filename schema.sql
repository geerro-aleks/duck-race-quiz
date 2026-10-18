CREATE TABLE IF NOT EXISTS quiz_games (
  id TEXT PRIMARY KEY CHECK (id = 'main'),
  pin TEXT NOT NULL UNIQUE CHECK (pin ~ '^[0-9]{6}$'),
  phase TEXT NOT NULL CHECK (phase IN ('lobby', 'question', 'race', 'reveal', 'finished')),
  question_index INTEGER NOT NULL DEFAULT -1,
  deadline BIGINT,
  race_started_at BIGINT,
  race_ends_at BIGINT,
  correct_index INTEGER
);

CREATE TABLE IF NOT EXISTS quiz_players (
  id UUID PRIMARY KEY,
  game_pin TEXT NOT NULL REFERENCES quiz_games(pin) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 20),
  score INTEGER NOT NULL DEFAULT 0 CHECK (score >= 0),
  answer_index SMALLINT CHECK (answer_index BETWEEN 0 AND 3)
);

CREATE UNIQUE INDEX IF NOT EXISTS quiz_players_unique_name
  ON quiz_players (game_pin, lower(name));

CREATE INDEX IF NOT EXISTS quiz_players_game_score
  ON quiz_players (game_pin, score DESC, name);

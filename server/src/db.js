import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { DATA_DIR } from './config.js';

fs.mkdirSync(path.join(DATA_DIR, 'audio'), { recursive: true });

export const AUDIO_DIR = path.join(DATA_DIR, 'audio');
export const db = new Database(path.join(DATA_DIR, 'verdict.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  nickname      TEXT NOT NULL,
  emoji         TEXT NOT NULL,
  device_hash   TEXT,
  created_at    INTEGER NOT NULL,
  sub_until     INTEGER,
  jury_score    INTEGER NOT NULL DEFAULT 0,
  wins          INTEGER NOT NULL DEFAULT 0,
  losses        INTEGER NOT NULL DEFAULT 0,
  cases_judged  INTEGER NOT NULL DEFAULT 0,
  banned_until  INTEGER,
  ban_reason    TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_device ON users(device_hash);

CREATE TABLE IF NOT EXISTS disputes (
  id                TEXT PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE,
  topic             TEXT NOT NULL,
  creator_id        TEXT NOT NULL REFERENCES users(id),
  status            TEXT NOT NULL,
  tier              TEXT NOT NULL DEFAULT 'free',
  jury_size         INTEGER NOT NULL,
  consent_content   INTEGER NOT NULL DEFAULT 0,
  one_sided         INTEGER NOT NULL DEFAULT 0,
  moderation_state  TEXT NOT NULL DEFAULT 'clean',
  moderation_reason TEXT,
  created_at        INTEGER NOT NULL,
  published_at      INTEGER,
  deadline_at       INTEGER,
  verdict_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status);
CREATE INDEX IF NOT EXISTS idx_disputes_creator ON disputes(creator_id);

CREATE TABLE IF NOT EXISTS sides (
  id           TEXT PRIMARY KEY,
  dispute_id   TEXT NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  user_id      TEXT REFERENCES users(id),
  audio_file   TEXT,
  mime         TEXT,
  duration_ms  INTEGER,
  transcript   TEXT,
  created_at   INTEGER NOT NULL,
  UNIQUE(dispute_id, label)
);

CREATE TABLE IF NOT EXISTS assignments (
  id          TEXT PRIMARY KEY,
  dispute_id  TEXT NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  juror_id    TEXT NOT NULL REFERENCES users(id),
  order_flip  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  voted       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_assign_juror ON assignments(juror_id, voted, expires_at);
CREATE INDEX IF NOT EXISTS idx_assign_dispute ON assignments(dispute_id);

CREATE TABLE IF NOT EXISTS votes (
  id          TEXT PRIMARY KEY,
  dispute_id  TEXT NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  juror_id    TEXT NOT NULL REFERENCES users(id),
  side_label  TEXT NOT NULL,
  device_hash TEXT,
  listened_a  REAL NOT NULL,
  listened_b  REAL NOT NULL,
  elapsed_ms  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE(dispute_id, juror_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_votes_device ON votes(dispute_id, device_hash);
CREATE INDEX IF NOT EXISTS idx_votes_dispute ON votes(dispute_id);

CREATE TABLE IF NOT EXISTS comments (
  id          TEXT PRIMARY KEY,
  dispute_id  TEXT NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  author_id   TEXT NOT NULL REFERENCES users(id),
  body        TEXT NOT NULL,
  upvotes     INTEGER NOT NULL DEFAULT 0,
  hidden      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_dispute ON comments(dispute_id, hidden, upvotes DESC);

CREATE TABLE IF NOT EXISTS comment_votes (
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (comment_id, user_id)
);

CREATE TABLE IF NOT EXISTS verdicts (
  dispute_id  TEXT PRIMARY KEY REFERENCES disputes(id) ON DELETE CASCADE,
  pct_a       INTEGER NOT NULL,
  pct_b       INTEGER NOT NULL,
  winner      TEXT NOT NULL,
  total_votes INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS badges (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  dispute_id TEXT REFERENCES disputes(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL,
  label      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_badges_user ON badges(user_id);

CREATE TABLE IF NOT EXISTS reports (
  id          TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  reporter_id TEXT NOT NULL REFERENCES users(id),
  reason      TEXT NOT NULL,
  note        TEXT,
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at);

CREATE TABLE IF NOT EXISTS payments (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  dispute_id   TEXT REFERENCES disputes(id) ON DELETE SET NULL,
  tier         TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status       TEXT NOT NULL,
  provider     TEXT NOT NULL DEFAULT 'mock',
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS waitlist (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  role       TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  name       TEXT NOT NULL,
  props      TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_name ON events(name, created_at);
`);

export function track(userId, name, props) {
  db.prepare('INSERT INTO events (id, user_id, name, props, created_at) VALUES (?,?,?,?,?)')
    .run(randomUUID(), userId || null, name, props ? JSON.stringify(props) : null, Date.now());
}

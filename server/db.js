'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
fs.mkdirSync(config.uploadDir, { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  handle        TEXT NOT NULL,
  emoji         TEXT NOT NULL DEFAULT '⚖️',
  role          TEXT NOT NULL DEFAULT 'user',
  age_confirmed INTEGER NOT NULL DEFAULT 0,
  jury_score    INTEGER NOT NULL DEFAULT 0,
  sub_until     INTEGER,
  credit_cents  INTEGER NOT NULL DEFAULT 0,
  banned_until  INTEGER,
  created_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);

CREATE TABLE IF NOT EXISTS disputes (
  id                TEXT PRIMARY KEY,
  public_no         INTEGER,
  topic             TEXT NOT NULL,
  creator_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opponent_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  invite_token      TEXT UNIQUE NOT NULL,
  tier              TEXT NOT NULL DEFAULT 'free',
  consent_content   INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'awaiting_opponent',
  one_sided         INTEGER NOT NULL DEFAULT 0,
  target_jury       INTEGER NOT NULL,
  min_quorum        INTEGER NOT NULL,
  priority          INTEGER NOT NULL DEFAULT 0,
  opponent_deadline INTEGER,
  jury_opened_at    INTEGER,
  deadline_at       INTEGER,
  reminders_sent    INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sides (
  id               TEXT PRIMARY KEY,
  dispute_id       TEXT NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label            TEXT NOT NULL,
  audio_file       TEXT NOT NULL,
  audio_mime       TEXT NOT NULL,
  audio_bytes      INTEGER NOT NULL,
  duration_ms      INTEGER NOT NULL,
  transcript       TEXT,
  transcript_state TEXT NOT NULL DEFAULT 'pending',
  moderation_state TEXT NOT NULL DEFAULT 'pending',
  moderation_note  TEXT,
  created_at       INTEGER NOT NULL,
  UNIQUE (dispute_id, label)
);

CREATE TABLE IF NOT EXISTS jury_assignments (
  id         TEXT PRIMARY KEY,
  dispute_id TEXT NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  juror_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_flip INTEGER NOT NULL DEFAULT 0,
  served_at  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE (dispute_id, juror_id)
);

CREATE TABLE IF NOT EXISTS votes (
  id          TEXT PRIMARY KEY,
  dispute_id  TEXT NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  juror_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  side_label  TEXT NOT NULL,
  listened_a  REAL NOT NULL,
  listened_b  REAL NOT NULL,
  device_hash TEXT,
  ip_hash     TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE (dispute_id, juror_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id         TEXT PRIMARY KEY,
  dispute_id TEXT NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  juror_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  score      INTEGER NOT NULL DEFAULT 0,
  hidden     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS comment_votes (
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (comment_id, user_id)
);

CREATE TABLE IF NOT EXISTS verdicts (
  id          TEXT PRIMARY KEY,
  dispute_id  TEXT NOT NULL UNIQUE REFERENCES disputes(id) ON DELETE CASCADE,
  pct_a       INTEGER NOT NULL,
  pct_b       INTEGER NOT NULL,
  winner      TEXT NOT NULL,
  total_votes INTEGER NOT NULL,
  issued_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS badges (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dispute_id TEXT REFERENCES disputes(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL,
  label      TEXT NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dispute_id   TEXT REFERENCES disputes(id) ON DELETE SET NULL,
  product      TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  provider     TEXT NOT NULL,
  provider_ref TEXT,
  status       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id          TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  reporter_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason      TEXT NOT NULL,
  detail      TEXT,
  state       TEXT NOT NULL DEFAULT 'open',
  resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         TEXT PRIMARY KEY,
  actor_id   TEXT,
  action     TEXT NOT NULL,
  subject    TEXT,
  meta       TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_disputes_status   ON disputes(status);
CREATE INDEX IF NOT EXISTS idx_disputes_creator  ON disputes(creator_id);
CREATE INDEX IF NOT EXISTS idx_disputes_deadline ON disputes(deadline_at);
CREATE INDEX IF NOT EXISTS idx_sides_dispute     ON sides(dispute_id);
CREATE INDEX IF NOT EXISTS idx_votes_dispute     ON votes(dispute_id);
CREATE INDEX IF NOT EXISTS idx_assign_juror      ON jury_assignments(juror_id);
CREATE INDEX IF NOT EXISTS idx_comments_dispute  ON comments(dispute_id);
CREATE INDEX IF NOT EXISTS idx_reports_state     ON reports(state);
`);

db.prepare(`INSERT OR IGNORE INTO counters (name, value) VALUES ('dispute_no', 4400)`).run();

/* Человекочитаемый номер дела вместо UUID в интерфейсе */
const nextDisputeNo = db.transaction(() => {
  db.prepare(`UPDATE counters SET value = value + 1 WHERE name = 'dispute_no'`).run();
  return db.prepare(`SELECT value FROM counters WHERE name = 'dispute_no'`).get().value;
});

module.exports = { db, nextDisputeNo };

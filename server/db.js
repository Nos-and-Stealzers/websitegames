/* SQLite schema + connection. Migrations are idempotent: the file is created
   and brought up to date on first require. */
"use strict";

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const FILE = process.env.ARCADE_DB || path.join(__dirname, "arcade.db");

if (FILE !== ":memory:") fs.mkdirSync(path.dirname(FILE), { recursive: true });

const db = new Database(FILE);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT    NOT NULL,
  username_lower TEXT    NOT NULL UNIQUE,
  display_name   TEXT    NOT NULL DEFAULT '',
  bio            TEXT    NOT NULL DEFAULT '',
  pass_hash      TEXT    NOT NULL,
  pass_salt      TEXT    NOT NULL,
  role           TEXT    NOT NULL DEFAULT 'user',      -- user | mod | admin
  state          TEXT    NOT NULL DEFAULT 'active',    -- active | suspended
  accepts_dms    INTEGER NOT NULL DEFAULT 1,           -- 0 = friends only
  show_activity  INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  last_seen      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  agent      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- One row per pair. requester_id is whoever sent the request.
CREATE TABLE IF NOT EXISTS friendships (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state        TEXT    NOT NULL,        -- pending | accepted | blocked
  blocked_by   INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (requester_id, addressee_id)
);
CREATE INDEX IF NOT EXISTS idx_fr_req ON friendships(requester_id);
CREATE INDEX IF NOT EXISTS idx_fr_add ON friendships(addressee_id);

-- Direct threads only; a_id is always the lower user id.
CREATE TABLE IF NOT EXISTS threads (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  a_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  b_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_at    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (a_id, b_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  sender_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  read_at    INTEGER NOT NULL DEFAULT 0,
  deleted    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_msg_thread ON messages(thread_id, id);

-- Mirror of the browser's local save, so it follows the account.
CREATE TABLE IF NOT EXISTS saves (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  payload    TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Aggregate play counts across all accounts, for "popular" ordering.
CREATE TABLE IF NOT EXISTS game_stats (
  game_id TEXT PRIMARY KEY,
  plays   INTEGER NOT NULL DEFAULT 0,
  seconds INTEGER NOT NULL DEFAULT 0
);

-- One row per thing that happened to a user; actor_id is who caused it.
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL,   -- friend-request | friend-accept | message | role | state | report
  actor_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body       TEXT    NOT NULL DEFAULT '',
  link       TEXT    NOT NULL DEFAULT '',
  read_at    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_notif_unread ON notifications(user_id, read_at);

CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind        TEXT    NOT NULL,        -- user | message | game
  target      TEXT    NOT NULL,
  reason      TEXT    NOT NULL,
  state       TEXT    NOT NULL DEFAULT 'open',   -- open | closed
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT    NOT NULL,
  detail     TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
`);

function audit(actorId, action, detail) {
  db.prepare("INSERT INTO audit (actor_id, action, detail, created_at) VALUES (?,?,?,?)")
    .run(actorId || null, action, detail || "", Date.now());
}

module.exports = { db, audit, FILE };

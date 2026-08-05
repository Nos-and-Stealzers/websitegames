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

-- Conversations. For a DM, a_id/b_id hold the ordered user pair and a partial
-- unique index keeps it to one thread per pair. Groups leave them null and rely
-- entirely on thread_members. Membership is always read from thread_members.
CREATE TABLE IF NOT EXISTS threads (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  a_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  b_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  is_group   INTEGER NOT NULL DEFAULT 0,
  title      TEXT    NOT NULL DEFAULT '',
  owner_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  last_at    INTEGER NOT NULL DEFAULT 0
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

/* ---------------------------------------------------------------------
   Migrations for tables that already exist in the wild. CREATE TABLE IF
   NOT EXISTS won't add columns, so anything introduced after v2 is added
   here, guarded, and back-filled.
   --------------------------------------------------------------------- */

function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

function addColumn(table, column, decl) {
  if (!hasColumn(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

/* Shareable friend code. Ambiguous glyphs (0/O, 1/I/L) are left out so it
   survives being read aloud or copied off a screen. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function makeFriendCode() {
  const bytes = require("crypto").randomBytes(8);
  let out = "";
  for (let i = 0; i < 6; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out.slice(0, 3) + "-" + out.slice(3);
}

function freshFriendCode() {
  for (let i = 0; i < 40; i++) {
    const code = makeFriendCode();
    if (!db.prepare("SELECT 1 FROM users WHERE friend_code = ?").get(code)) return code;
  }
  throw new Error("Could not allocate a friend code.");
}

addColumn("users", "friend_code", "TEXT");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_code ON users(friend_code)");

/* Groups. Membership lives in thread_members for every thread, group or
   not, so there is exactly one membership check in the codebase. a_id/b_id
   stay on threads purely to keep the one-DM-per-pair unique index working. */
addColumn("threads", "is_group", "INTEGER NOT NULL DEFAULT 0");
addColumn("threads", "title", "TEXT NOT NULL DEFAULT ''");
addColumn("threads", "owner_id", "INTEGER");

/* v2 declared a_id/b_id NOT NULL, which a group thread cannot satisfy — it
   has no pair, only members. SQLite has no "ALTER COLUMN DROP NOT NULL", so
   the table is rebuilt. Pair uniqueness moves to a partial index that only
   covers DMs, otherwise a second group by the same owner would collide. */
function threadsNeedRebuild() {
  const cols = db.prepare("PRAGMA table_info(threads)").all();
  const a = cols.find((c) => c.name === "a_id");
  return !!a && a.notnull === 1;
}

if (threadsNeedRebuild()) {
  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  db.transaction(() => {
    db.exec(`
      CREATE TABLE threads_rebuilt (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        a_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
        b_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
        is_group   INTEGER NOT NULL DEFAULT 0,
        title      TEXT    NOT NULL DEFAULT '',
        owner_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL,
        last_at    INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO threads_rebuilt (id, a_id, b_id, is_group, title, owner_id, created_at, last_at)
        SELECT id, a_id, b_id, is_group, title, owner_id, created_at, last_at FROM threads;
      DROP TABLE threads;
      ALTER TABLE threads_rebuilt RENAME TO threads;
    `);
  })();
  db.pragma("legacy_alter_table = OFF");
  db.pragma("foreign_keys = ON");

  const broken = db.pragma("foreign_key_check");
  if (broken.length) {
    throw new Error("threads rebuild left dangling references: " + JSON.stringify(broken));
  }
}

db.exec(
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_dm ON threads(a_id, b_id) WHERE is_group = 0"
);
addColumn("messages", "attachment_id", "INTEGER");
addColumn("messages", "kind", "TEXT NOT NULL DEFAULT 'text'");

db.exec(`
CREATE TABLE IF NOT EXISTS thread_members (
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  role      TEXT    NOT NULL DEFAULT 'member',   -- owner | member
  joined_at INTEGER NOT NULL,
  last_read INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (thread_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_tm_user ON thread_members(user_id);

CREATE TABLE IF NOT EXISTS attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  uploader_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id   INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL,          -- screenshot | camera | upload
  mime        TEXT    NOT NULL,
  width       INTEGER NOT NULL DEFAULT 0,
  height      INTEGER NOT NULL DEFAULT 0,
  bytes       INTEGER NOT NULL,
  data        BLOB    NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_att_thread ON attachments(thread_id);
`);

/* Back-fill: give existing accounts a code, and existing DM threads their
   membership rows. Both are no-ops on a fresh database. */
(function backfill() {
  const needCode = db.prepare("SELECT id FROM users WHERE friend_code IS NULL").all();
  if (needCode.length) {
    const set = db.prepare("UPDATE users SET friend_code = ? WHERE id = ?");
    db.transaction(() => needCode.forEach((u) => set.run(freshFriendCode(), u.id)))();
  }

  const orphans = db.prepare(
    `SELECT t.id, t.a_id, t.b_id, t.created_at FROM threads t
      WHERE NOT EXISTS (SELECT 1 FROM thread_members m WHERE m.thread_id = t.id)`
  ).all();
  if (orphans.length) {
    const add = db.prepare(
      "INSERT OR IGNORE INTO thread_members (thread_id, user_id, joined_at) VALUES (?,?,?)"
    );
    db.transaction(() => orphans.forEach((t) => {
      if (t.a_id) add.run(t.id, t.a_id, t.created_at);
      if (t.b_id) add.run(t.id, t.b_id, t.created_at);
    }))();
  }
})();

function audit(actorId, action, detail) {
  db.prepare("INSERT INTO audit (actor_id, action, detail, created_at) VALUES (?,?,?,?)")
    .run(actorId || null, action, detail || "", Date.now());
}

module.exports = { db, audit, FILE, freshFriendCode };

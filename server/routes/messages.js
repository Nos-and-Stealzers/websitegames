/* Direct messages. Threads are strictly one-to-one and keyed on the ordered
   user pair, so the same two people can never end up with two threads. */
"use strict";

const express = require("express");
const { db } = require("../db");
const A = require("../auth");
const S = require("../shape");
const social = require("./social");
const notify = require("../notify");

const router = express.Router();

const sendLimit = A.rateLimit({ name: "send", windowMs: 60000, max: 30 });

function pair(a, b) {
  return a < b ? [a, b] : [b, a];
}

function findThread(a, b) {
  const [lo, hi] = pair(a, b);
  return db.prepare("SELECT * FROM threads WHERE a_id = ? AND b_id = ?").get(lo, hi);
}

function openThread(a, b) {
  const found = findThread(a, b);
  if (found) return found;
  const [lo, hi] = pair(a, b);
  const now = Date.now();
  const info = db.prepare("INSERT INTO threads (a_id, b_id, created_at, last_at) VALUES (?,?,?,?)")
    .run(lo, hi, now, now);
  return db.prepare("SELECT * FROM threads WHERE id = ?").get(info.lastInsertRowid);
}

function otherId(thread, me) {
  return thread.a_id === me ? thread.b_id : thread.a_id;
}

function memberOf(thread, me) {
  return thread && (thread.a_id === me || thread.b_id === me);
}

/* May `me` start or continue a conversation with `them`? */
function canMessage(me, them) {
  if (social.isBlocked(me, them)) return "You can't message this person.";
  const target = db.prepare("SELECT accepts_dms, state FROM users WHERE id = ?").get(them);
  if (!target) return "No such user.";
  if (target.state === "suspended") return "That account is suspended.";
  if (!target.accepts_dms && !social.areFriends(me, them)) {
    return "This person only accepts messages from friends.";
  }
  return null;
}

/* ------------------------------------------------------------- listings */

router.get("/messages/threads", A.requireUser, (req, res) => {
  const me = req.user.id;
  /* t.id must be aliased: `u.*` also carries an `id`, and the later column wins,
     so an unaliased t.* would hand back the other user's id as the thread id. */
  const rows = db.prepare(
    `SELECT t.id AS thread_id, t.last_at AS thread_last_at, u.*
       FROM threads t
       JOIN users u ON u.id = CASE WHEN t.a_id = ? THEN t.b_id ELSE t.a_id END
      WHERE (t.a_id = ? OR t.b_id = ?) AND t.last_at > 0
      ORDER BY t.last_at DESC`
  ).all(me, me, me);

  const lastOf = db.prepare(
    "SELECT body, sender_id, created_at FROM messages WHERE thread_id = ? AND deleted = 0 ORDER BY id DESC LIMIT 1"
  );
  const unreadOf = db.prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND sender_id != ? AND read_at = 0 AND deleted = 0"
  );

  res.json({
    threads: rows.map((row) => {
      const last = lastOf.get(row.thread_id);
      return {
        id: row.thread_id,
        with: S.publicUser(row),
        lastAt: row.thread_last_at,
        unread: unreadOf.get(row.thread_id, me).n,
        preview: last ? { body: last.body.slice(0, 140), mine: last.sender_id === me, at: last.created_at } : null
      };
    })
  });
});

/* Everything the rail needs to paint its badges, in one round trip. */
router.get("/messages/unread", A.requireUser, (req, res) => {
  const me = req.user.id;
  const { n } = db.prepare(
    `SELECT COUNT(*) AS n
       FROM messages m JOIN threads t ON t.id = m.thread_id
      WHERE (t.a_id = ? OR t.b_id = ?) AND m.sender_id != ? AND m.read_at = 0 AND m.deleted = 0`
  ).get(me, me, me);

  const { r } = db.prepare(
    "SELECT COUNT(*) AS r FROM friendships WHERE addressee_id = ? AND state = 'pending'"
  ).get(me);

  res.json({ messages: n, requests: r, notifications: notify.unreadCount(me) });
});

/* Open (or create) the thread with a given username. */
router.post("/messages/with/:username", A.requireUser, (req, res) => {
  const target = db.prepare("SELECT * FROM users WHERE username_lower = ?")
    .get(String(req.params.username).toLowerCase());
  if (!target) return res.status(404).json({ error: "No such user." });
  if (target.id === req.user.id) return res.status(400).json({ error: "You can't message yourself." });

  const denied = canMessage(req.user.id, target.id);
  if (denied) return res.status(403).json({ error: denied });

  const thread = openThread(req.user.id, target.id);
  res.json({ threadId: thread.id, with: S.publicUser(target) });
});

/* ------------------------------------------------------------- messages */

router.get("/messages/threads/:id", A.requireUser, (req, res) => {
  const thread = db.prepare("SELECT * FROM threads WHERE id = ?").get(Number(req.params.id));
  if (!memberOf(thread, req.user.id)) return res.status(404).json({ error: "No such thread." });

  const after = Number(req.query.after || 0) || 0;
  const rows = db.prepare(
    `SELECT id, sender_id, body, created_at, deleted FROM messages
      WHERE thread_id = ? AND id > ? ORDER BY id ASC LIMIT 200`
  ).all(thread.id, after);

  /* Anything they sent that we're now looking at counts as read. */
  db.prepare(
    "UPDATE messages SET read_at = ? WHERE thread_id = ? AND sender_id != ? AND read_at = 0"
  ).run(Date.now(), thread.id, req.user.id);

  const other = db.prepare("SELECT * FROM users WHERE id = ?").get(otherId(thread, req.user.id));

  res.json({
    threadId: thread.id,
    with: S.publicUser(other),
    canSend: !canMessage(req.user.id, other.id),
    messages: rows.map((m) => ({
      id: m.id,
      mine: m.sender_id === req.user.id,
      body: m.deleted ? "" : m.body,
      deleted: !!m.deleted,
      at: m.created_at
    }))
  });
});

router.post("/messages/threads/:id", A.requireUser, sendLimit, (req, res, next) => {
  try {
    const thread = db.prepare("SELECT * FROM threads WHERE id = ?").get(Number(req.params.id));
    if (!memberOf(thread, req.user.id)) return res.status(404).json({ error: "No such thread." });

    const them = otherId(thread, req.user.id);
    const denied = canMessage(req.user.id, them);
    if (denied) return res.status(403).json({ error: denied });

    const body = S.str(req.body.body, { field: "Message", min: 1, max: 2000 });
    const now = Date.now();

    const info = db.prepare(
      "INSERT INTO messages (thread_id, sender_id, body, created_at) VALUES (?,?,?,?)"
    ).run(thread.id, req.user.id, body, now);
    db.prepare("UPDATE threads SET last_at = ? WHERE id = ?").run(now, thread.id);
    notify.on.message(them, req.user, thread.id);

    res.status(201).json({
      message: { id: info.lastInsertRowid, mine: true, body, deleted: false, at: now }
    });
  } catch (err) { next(err); }
});

/* Senders can retract their own; moderators can remove anything. */
router.delete("/messages/:id", A.requireUser, (req, res) => {
  const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: "Not found." });

  const staff = req.user.role === "admin" || req.user.role === "mod";
  if (row.sender_id !== req.user.id && !staff) {
    return res.status(403).json({ error: "That isn't yours." });
  }
  db.prepare("UPDATE messages SET deleted = 1, body = '' WHERE id = ?").run(row.id);
  res.json({ ok: true });
});

module.exports = router;

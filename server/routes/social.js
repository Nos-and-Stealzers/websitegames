/* Profiles, user search and the friend graph. */
"use strict";

const express = require("express");
const { db } = require("../db");
const A = require("../auth");
const S = require("../shape");
const notify = require("../notify");

const router = express.Router();

/* ------------------------------------------------------------- relations */

/* The single row describing how two users relate, in either direction. */
function edge(a, b) {
  return db.prepare(
    `SELECT * FROM friendships
      WHERE (requester_id = ? AND addressee_id = ?)
         OR (requester_id = ? AND addressee_id = ?)`
  ).get(a, b, b, a);
}

/* How `viewer` should see `other`: none | pending-out | pending-in | friends | blocked */
function relation(viewerId, otherId) {
  if (viewerId === otherId) return "self";
  const row = edge(viewerId, otherId);
  if (!row) return "none";
  if (row.state === "accepted") return "friends";
  if (row.state === "blocked") return row.blocked_by === viewerId ? "blocked" : "blocked-by";
  return row.requester_id === viewerId ? "pending-out" : "pending-in";
}

function areFriends(a, b) {
  const row = edge(a, b);
  return !!row && row.state === "accepted";
}

function isBlocked(a, b) {
  const row = edge(a, b);
  return !!row && row.state === "blocked";
}

router.relation = relation;
router.areFriends = areFriends;
router.isBlocked = isBlocked;

/* --------------------------------------------------------------- profile */

router.patch("/users/me", A.requireUser, (req, res, next) => {
  try {
    const patch = {};
    if (req.body.displayName !== undefined) {
      patch.display_name = S.str(req.body.displayName, { field: "Display name", max: 32 }) ||
        req.user.username;
    }
    if (req.body.bio !== undefined) {
      patch.bio = S.str(req.body.bio, { field: "Bio", max: 300 });
    }
    if (req.body.acceptsDms !== undefined) patch.accepts_dms = req.body.acceptsDms ? 1 : 0;
    if (req.body.showActivity !== undefined) patch.show_activity = req.body.showActivity ? 1 : 0;

    const keys = Object.keys(patch);
    if (keys.length) {
      db.prepare(`UPDATE users SET ${keys.map((k) => k + " = ?").join(", ")} WHERE id = ?`)
        .run(...keys.map((k) => patch[k]), req.user.id);
    }
    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
    res.json({ user: S.privateUser(row) });
  } catch (err) { next(err); }
});

router.delete("/users/me", A.requireUser, (req, res, next) => {
  try {
    S.str(req.body.confirm, { field: "Confirmation" });
    if (req.body.confirm !== req.user.username) {
      return res.status(400).json({ error: "Type your username exactly to confirm." });
    }
    /* Cascades clear sessions, friendships, threads, messages and the save. */
    db.prepare("DELETE FROM users WHERE id = ?").run(req.user.id);
    A.clearCookie(res);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get("/users/search", A.requireUser, (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  if (q.length < 2) return res.json({ users: [] });

  const rows = db.prepare(
    `SELECT * FROM users
      WHERE username_lower LIKE ? AND id != ? AND state = 'active'
      ORDER BY LENGTH(username), username_lower LIMIT 20`
  ).all(q.replace(/[%_]/g, "") + "%", req.user.id);

  res.json({
    users: rows
      .filter((r) => relation(req.user.id, r.id) !== "blocked-by")
      .map((r) => Object.assign(S.publicUser(r), { relation: relation(req.user.id, r.id) }))
  });
});

router.get("/users/:username", A.requireUser, (req, res) => {
  const row = db.prepare("SELECT * FROM users WHERE username_lower = ?")
    .get(String(req.params.username).toLowerCase());
  if (!row) return res.status(404).json({ error: "No such user." });

  const rel = relation(req.user.id, row.id);
  if (rel === "blocked-by") return res.status(404).json({ error: "No such user." });

  const out = Object.assign(S.publicUser(row), { relation: rel });

  /* Activity is opt-out, and only ever shared with friends. */
  if (row.show_activity && (rel === "friends" || rel === "self")) {
    const save = db.prepare("SELECT payload FROM saves WHERE user_id = ?").get(row.id);
    if (save) {
      try {
        const data = JSON.parse(save.payload);
        const stats = data.stats || {};
        out.activity = {
          totalSeconds: Object.values(stats).reduce((n, s) => n + (s.seconds || 0), 0),
          gamesPlayed: Object.keys(stats).length,
          recent: (data.recents || []).slice(0, 5).map((r) => r.id)
        };
      } catch { /* a malformed save just means no activity block */ }
    }
  }
  res.json({ user: out });
});

/* --------------------------------------------------------------- friends */

router.get("/friends", A.requireUser, (req, res) => {
  const me = req.user.id;
  const rows = db.prepare(
    `SELECT f.*, u.* , f.id AS edge_id, f.state AS edge_state
       FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
      WHERE (f.requester_id = ? OR f.addressee_id = ?)`
  ).all(me, me, me);

  const friends = [], incoming = [], outgoing = [], blocked = [];

  for (const row of rows) {
    const person = Object.assign(S.publicUser(row), { edgeId: row.edge_id });
    if (row.edge_state === "accepted") friends.push(person);
    else if (row.edge_state === "blocked") {
      if (row.blocked_by === me) blocked.push(person);
    } else if (row.requester_id === me) outgoing.push(person);
    else incoming.push(person);
  }

  const byName = (a, b) => a.username.localeCompare(b.username);
  friends.sort((a, b) => Number(b.online) - Number(a.online) || byName(a, b));
  res.json({ friends, incoming, outgoing, blocked });
});

router.post("/friends/request", A.requireUser, (req, res, next) => {
  try {
    const name = S.str(req.body.username, { field: "Username", max: 20 });
    const target = db.prepare("SELECT * FROM users WHERE username_lower = ?")
      .get(name.toLowerCase());

    if (!target) return res.status(404).json({ error: "No such user." });
    if (target.id === req.user.id) return res.status(400).json({ error: "That's you." });
    if (target.state === "suspended") return res.status(403).json({ error: "That account is suspended." });

    const existing = edge(req.user.id, target.id);
    if (existing) {
      if (existing.state === "accepted") return res.status(409).json({ error: "Already friends." });
      if (existing.state === "blocked") return res.status(403).json({ error: "That isn't possible." });
      if (existing.requester_id === req.user.id) {
        return res.status(409).json({ error: "Request already sent." });
      }
      /* They asked first — treat this as accepting. */
      db.prepare("UPDATE friendships SET state = 'accepted', updated_at = ? WHERE id = ?")
        .run(Date.now(), existing.id);
      notify.on.friendAccepted(target.id, req.user);
      return res.json({ state: "friends" });
    }

    const now = Date.now();
    db.prepare(
      `INSERT INTO friendships (requester_id, addressee_id, state, created_at, updated_at)
       VALUES (?,?,'pending',?,?)`
    ).run(req.user.id, target.id, now, now);
    notify.on.friendRequest(target.id, req.user);

    res.status(201).json({ state: "pending-out" });
  } catch (err) { next(err); }
});

router.post("/friends/:id/accept", A.requireUser, (req, res) => {
  const row = db.prepare("SELECT * FROM friendships WHERE id = ?").get(Number(req.params.id));
  if (!row || row.addressee_id !== req.user.id || row.state !== "pending") {
    return res.status(404).json({ error: "No such request." });
  }
  db.prepare("UPDATE friendships SET state = 'accepted', updated_at = ? WHERE id = ?")
    .run(Date.now(), row.id);
  notify.on.friendAccepted(row.requester_id, req.user);
  res.json({ state: "friends" });
});

/* Decline an incoming request, cancel an outgoing one, or unfriend. */
router.delete("/friends/:id", A.requireUser, (req, res) => {
  const row = db.prepare("SELECT * FROM friendships WHERE id = ?").get(Number(req.params.id));
  if (!row || (row.requester_id !== req.user.id && row.addressee_id !== req.user.id)) {
    return res.status(404).json({ error: "Not found." });
  }
  if (row.state === "blocked" && row.blocked_by !== req.user.id) {
    return res.status(403).json({ error: "That isn't possible." });
  }
  db.prepare("DELETE FROM friendships WHERE id = ?").run(row.id);
  res.json({ ok: true });
});

router.post("/friends/block", A.requireUser, (req, res, next) => {
  try {
    const name = S.str(req.body.username, { field: "Username", max: 20 });
    const target = db.prepare("SELECT * FROM users WHERE username_lower = ?")
      .get(name.toLowerCase());
    if (!target) return res.status(404).json({ error: "No such user." });
    if (target.id === req.user.id) return res.status(400).json({ error: "That's you." });

    const now = Date.now();
    const existing = edge(req.user.id, target.id);
    if (existing) {
      db.prepare("UPDATE friendships SET state='blocked', blocked_by=?, updated_at=? WHERE id=?")
        .run(req.user.id, now, existing.id);
    } else {
      db.prepare(
        `INSERT INTO friendships (requester_id, addressee_id, state, blocked_by, created_at, updated_at)
         VALUES (?,?,'blocked',?,?,?)`
      ).run(req.user.id, target.id, req.user.id, now, now);
    }
    res.json({ state: "blocked" });
  } catch (err) { next(err); }
});

module.exports = router;

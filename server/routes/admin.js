/* Admin surface: overview, user moderation, reports, audit trail.
   Every route is role-gated on the server — hiding the tab in the UI is not
   the control, this is. */
"use strict";

const express = require("express");
const { db, audit, rankOf, outranks } = require("../db");
const A = require("../auth");
const S = require("../shape");
const notify = require("../notify");

const router = express.Router();

const staff = A.requireRole("owner", "admin", "mod");
const adminOnly = A.requireRole("owner", "admin");

router.get("/overview", staff, (req, res) => {
  const one = (sql, ...args) => Object.values(db.prepare(sql).get(...args))[0];
  const dayAgo = Date.now() - 864e5;
  const weekAgo = Date.now() - 7 * 864e5;

  res.json({
    users: {
      total: one("SELECT COUNT(*) FROM users"),
      active: one("SELECT COUNT(*) FROM users WHERE state = 'active'"),
      suspended: one("SELECT COUNT(*) FROM users WHERE state = 'suspended'"),
      online: one("SELECT COUNT(*) FROM users WHERE last_seen > ?", Date.now() - S.ONLINE_WINDOW),
      newToday: one("SELECT COUNT(*) FROM users WHERE created_at > ?", dayAgo),
      newThisWeek: one("SELECT COUNT(*) FROM users WHERE created_at > ?", weekAgo)
    },
    social: {
      friendships: one("SELECT COUNT(*) FROM friendships WHERE state = 'accepted'"),
      pending: one("SELECT COUNT(*) FROM friendships WHERE state = 'pending'"),
      blocks: one("SELECT COUNT(*) FROM friendships WHERE state = 'blocked'"),
      threads: one("SELECT COUNT(*) FROM threads"),
      messages: one("SELECT COUNT(*) FROM messages WHERE deleted = 0"),
      messagesToday: one("SELECT COUNT(*) FROM messages WHERE created_at > ?", dayAgo)
    },
    reports: {
      open: one("SELECT COUNT(*) FROM reports WHERE state = 'open'"),
      total: one("SELECT COUNT(*) FROM reports")
    },
    sessions: one("SELECT COUNT(*) FROM sessions WHERE expires_at > ?", Date.now()),
    topGames: db.prepare(
      "SELECT game_id AS id, plays, seconds FROM game_stats ORDER BY seconds DESC LIMIT 10"
    ).all()
  });
});

router.get("/users", staff, (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase().replace(/[%_]/g, "");
  const where = q ? "WHERE u.username_lower LIKE ?" : "";
  const args = q ? [q + "%"] : [];

  const rows = db.prepare(
    `SELECT u.*,
            (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ${Date.now()}) AS sessions,
            (SELECT COUNT(*) FROM friendships f WHERE f.state='accepted'
               AND (f.requester_id = u.id OR f.addressee_id = u.id)) AS friends,
            (SELECT COUNT(*) FROM messages m WHERE m.sender_id = u.id AND m.deleted = 0) AS messages
       FROM users u ${where}
      ORDER BY u.created_at DESC LIMIT 200`
  ).all(...args);

  res.json({ users: rows.map(S.adminUser) });
});

/* Role and suspension changes. Guard rails so an install can't lock itself out. */
router.patch("/users/:id", adminOnly, (req, res, next) => {
  try {
    const target = db.prepare("SELECT * FROM users WHERE id = ?").get(Number(req.params.id));
    if (!target) return res.status(404).json({ error: "No such user." });

    /* The rule that makes ranks mean anything: you can only act on someone
       you outrank. Without it an admin could demote another admin, or a
       compromised admin account could lock the owner out. */
    if (target.id !== req.user.id && !outranks(req.user.role, target.role)) {
      return res.status(403).json({
        error: target.role === "owner"
          ? "The owner can't be changed by anyone."
          : "You can only manage accounts below your own rank."
      });
    }

    const changes = [];

    if (req.body.role !== undefined) {
      const role = String(req.body.role);
      if (!["user", "mod", "admin", "owner"].includes(role)) throw S.fail("Unknown role.");

      /* Owner is claimed by configuration, not handed out — otherwise the
         one untouchable account becomes something an admin can mint. */
      if (role === "owner") {
        return res.status(403).json({ error: "Owner is set by the server, not granted here." });
      }
      if (target.role === "owner") {
        return res.status(403).json({ error: "The owner's rank can't be changed." });
      }
      /* Nobody may promote someone to their own rank or above. */
      if (rankOf(role) >= rankOf(req.user.role)) {
        return res.status(403).json({ error: "You can't promote anyone to your own rank." });
      }
      if (target.id === req.user.id) {
        return res.status(400).json({ error: "You can't change your own rank." });
      }

      db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, target.id);
      if (role !== target.role) notify.on.roleChanged(target.id, role, req.user.id);
      changes.push("role=" + role);
    }

    if (req.body.state !== undefined) {
      const state = String(req.body.state);
      if (!["active", "suspended"].includes(state)) throw S.fail("Unknown state.");
      if (target.id === req.user.id) {
        return res.status(400).json({ error: "You can't suspend yourself." });
      }
      if (target.role === "owner") {
        return res.status(403).json({ error: "The owner can't be suspended." });
      }
      db.prepare("UPDATE users SET state = ? WHERE id = ?").run(state, target.id);
      if (state !== target.state) notify.on.stateChanged(target.id, state, req.user.id);
      /* A suspension has to end the sessions, or it does nothing until expiry. */
      if (state === "suspended") A.dropAllSessions(target.id);
      changes.push("state=" + state);
    }

    if (!changes.length) return res.status(400).json({ error: "Nothing to change." });

    audit(req.user.id, "user-update", `${target.username}: ${changes.join(" ")}`);
    const fresh = db.prepare("SELECT * FROM users WHERE id = ?").get(target.id);
    res.json({ user: S.adminUser(fresh) });
  } catch (err) { next(err); }
});

router.delete("/users/:id", adminOnly, (req, res) => {
  const target = db.prepare("SELECT * FROM users WHERE id = ?").get(Number(req.params.id));
  if (!target) return res.status(404).json({ error: "No such user." });
  if (target.id === req.user.id) return res.status(400).json({ error: "You can't delete yourself." });
  if (target.role === "owner") return res.status(403).json({ error: "The owner can't be deleted." });
  if (!outranks(req.user.role, target.role)) {
    return res.status(403).json({ error: "You can only delete accounts below your own rank." });
  }

  db.prepare("DELETE FROM users WHERE id = ?").run(target.id);
  audit(req.user.id, "user-delete", target.username);
  res.json({ ok: true });
});

/* ---------------------------------------------------------------- live view */

/* Who is here right now and what they are doing. Presence is derived from
   last_seen rather than a socket, so it survives a refresh and needs no
   persistent connection. */
router.get("/live", staff, (req, res) => {
  const cutoff = Date.now() - S.ONLINE_WINDOW;
  const rows = db.prepare(
    `SELECT id, username, display_name, role, state, last_seen, current_game, current_since
       FROM users WHERE last_seen > ? ORDER BY last_seen DESC LIMIT 200`
  ).all(cutoff);

  const playing = rows.filter((r) => r.current_game);

  res.json({
    online: rows.length,
    playing: playing.length,
    users: rows.map((r) => ({
      id: r.id,
      username: r.username,
      displayName: r.display_name || r.username,
      role: r.role,
      state: r.state,
      lastSeen: r.last_seen,
      game: r.current_game || null,
      since: r.current_since || 0
    })),
    /* What is being played, most popular first. */
    games: Object.entries(
      playing.reduce((acc, r) => {
        acc[r.current_game] = (acc[r.current_game] || 0) + 1;
        return acc;
      }, {})
    ).map(([id, n]) => ({ id, players: n })).sort((a, b) => b.players - a.players)
  });
});

router.get("/logins", staff, (req, res) => {
  const rows = db.prepare(
    `SELECT l.*, u.username FROM logins l
       LEFT JOIN users u ON u.id = l.user_id
      ORDER BY l.id DESC LIMIT 200`
  ).all();
  res.json({
    logins: rows.map((r) => ({
      id: r.id,
      username: r.username || "(deleted)",
      at: r.at,
      ip: r.ip,
      agent: r.agent,
      outcome: r.outcome
    }))
  });
});

router.get("/reports", staff, (req, res) => {
  const state = req.query.state === "closed" ? "closed" : "open";
  const rows = db.prepare(
    `SELECT r.*, u.username AS reporter
       FROM reports r LEFT JOIN users u ON u.id = r.reporter_id
      WHERE r.state = ? ORDER BY r.created_at DESC LIMIT 200`
  ).all(state);

  res.json({
    reports: rows.map((r) => ({
      id: r.id, kind: r.kind, target: r.target, reason: r.reason,
      state: r.state, at: r.created_at, reporter: r.reporter || "(deleted)"
    }))
  });
});

router.patch("/reports/:id", staff, (req, res) => {
  const state = req.body.state === "open" ? "open" : "closed";
  const report = db.prepare("SELECT * FROM reports WHERE id = ?").get(Number(req.params.id));
  if (!report) return res.status(404).json({ error: "No such report." });

  db.prepare("UPDATE reports SET state = ? WHERE id = ?").run(state, report.id);
  /* Close the loop for whoever raised it. */
  if (state === "closed" && report.state !== "closed" && report.reporter_id) {
    notify.on.reportClosed(report.reporter_id, report.target);
  }
  audit(req.user.id, "report-" + state, String(report.id));
  res.json({ ok: true });
});

router.get("/audit", staff, (req, res) => {
  const rows = db.prepare(
    `SELECT a.*, u.username AS actor
       FROM audit a LEFT JOIN users u ON u.id = a.actor_id
      ORDER BY a.id DESC LIMIT 200`
  ).all();
  res.json({
    entries: rows.map((r) => ({
      id: r.id, actor: r.actor || "system", action: r.action,
      detail: r.detail, at: r.created_at
    }))
  });
});

module.exports = router;

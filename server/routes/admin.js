/* Admin surface: overview, user moderation, reports, audit trail.
   Every route is role-gated on the server — hiding the tab in the UI is not
   the control, this is. */
"use strict";

const express = require("express");
const { db, audit } = require("../db");
const A = require("../auth");
const S = require("../shape");
const notify = require("../notify");

const router = express.Router();

const staff = A.requireRole("admin", "mod");
const adminOnly = A.requireRole("admin");

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

    const changes = [];

    if (req.body.role !== undefined) {
      const role = String(req.body.role);
      if (!["user", "mod", "admin"].includes(role)) throw S.fail("Unknown role.");
      if (target.id === req.user.id && role !== "admin") {
        return res.status(400).json({ error: "You can't demote yourself." });
      }
      if (target.role === "admin" && role !== "admin") {
        const { n } = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get();
        if (n <= 1) return res.status(400).json({ error: "That's the last admin." });
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
  if (target.role === "admin") return res.status(400).json({ error: "Demote them first." });

  db.prepare("DELETE FROM users WHERE id = ?").run(target.id);
  audit(req.user.id, "user-delete", target.username);
  res.json({ ok: true });
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

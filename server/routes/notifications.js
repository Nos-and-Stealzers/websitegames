/* The notification feed. */
"use strict";

const express = require("express");
const { db } = require("../db");
const A = require("../auth");
const S = require("../shape");
const notify = require("../notify");

const router = express.Router();

router.get("/notifications", A.requireUser, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 40, 100);
  const unreadOnly = req.query.unread === "1";

  const rows = db.prepare(
    `SELECT n.id, n.kind, n.body, n.link, n.read_at, n.created_at,
            u.username AS actor_name, u.display_name AS actor_display
       FROM notifications n
       LEFT JOIN users u ON u.id = n.actor_id
      WHERE n.user_id = ? ${unreadOnly ? "AND n.read_at = 0" : ""}
      ORDER BY n.id DESC LIMIT ?`
  ).all(req.user.id, limit);

  res.json({
    unread: notify.unreadCount(req.user.id),
    notifications: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      body: r.body,
      link: r.link,
      read: r.read_at > 0,
      at: r.created_at,
      actor: r.actor_name ? { username: r.actor_name, displayName: r.actor_display || r.actor_name } : null
    }))
  });
});

/* Mark one, several, or everything read. */
router.post("/notifications/read", A.requireUser, (req, res, next) => {
  try {
    const now = Date.now();

    if (req.body && req.body.all) {
      db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at = 0")
        .run(now, req.user.id);
      return res.json({ unread: 0 });
    }

    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
    if (!ids.length) throw S.fail("Nothing to mark.");

    const stmt = db.prepare(
      "UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at = 0"
    );
    const run = db.transaction((list) => {
      list.forEach((id) => stmt.run(now, Number(id), req.user.id));
    });
    run(ids.slice(0, 200));

    res.json({ unread: notify.unreadCount(req.user.id) });
  } catch (err) { next(err); }
});

router.delete("/notifications", A.requireUser, (req, res) => {
  db.prepare("DELETE FROM notifications WHERE user_id = ?").run(req.user.id);
  res.json({ ok: true, unread: 0 });
});

router.delete("/notifications/:id", A.requireUser, (req, res) => {
  const info = db.prepare("DELETE FROM notifications WHERE id = ? AND user_id = ?")
    .run(Number(req.params.id), req.user.id);
  if (!info.changes) return res.status(404).json({ error: "Not found." });
  res.json({ ok: true, unread: notify.unreadCount(req.user.id) });
});

module.exports = router;

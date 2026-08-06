/* Support tickets.
 *
 * Feedback is fire-and-forget: you send it, a moderator files it, maybe you
 * get one reply. A support ticket is a conversation that stays open until
 * someone closes it, which is what you want for "I lost my save" or
 * "someone is harassing me".
 */
"use strict";

const express = require("express");
const { db, audit } = require("../db");
const A = require("../auth");
const S = require("../shape");
const notify = require("../notify");

const router = express.Router();
const staff = A.requireRole("admin", "mod", "owner");

const CATEGORIES = ["account", "saves", "game", "safety", "billing", "other"];
const PRIORITIES = ["low", "normal", "high"];
const STATES = ["open", "waiting", "closed"];

/* Owner counts as staff everywhere in here — it outranks admin. */
function isStaff(user) {
  return !!user && ["mod", "admin", "owner"].includes(user.role);
}

/* Opening tickets is cheap for us and easy to abuse, so cap it. Replying to
   an existing ticket is not capped the same way — a back-and-forth is the
   point. */
const openLimit = A.rateLimit({
  name: "support-open",
  windowMs: 3600000,
  max: 10,
  key: (req) => String(req.user ? req.user.id : "")
});

const replyLimit = A.rateLimit({
  name: "support-reply",
  windowMs: 600000,
  max: 40,
  key: (req) => String(req.user ? req.user.id : "")
});

function shapeTicket(row, extra) {
  return Object.assign({
    id: row.id,
    subject: row.subject,
    category: row.category,
    priority: row.priority,
    state: row.state,
    at: row.created_at,
    updatedAt: row.updated_at,
    from: row.username || "(deleted account)",
    userId: row.user_id
  }, extra || {});
}

function shapeMessage(row) {
  return {
    id: row.id,
    body: row.body,
    staff: !!row.from_staff,
    author: row.username || (row.from_staff ? "Support" : "(deleted account)"),
    at: row.created_at
  };
}

/* ------------------------------------------------------------------ mine */

router.post("/support", A.requireUser, openLimit, (req, res, next) => {
  try {
    const subject = S.str(req.body.subject, { field: "Subject", min: 3, max: 140 });
    const body = S.str(req.body.body, { field: "Details", min: 10, max: 4000 });
    const category = CATEGORIES.includes(req.body.category) ? req.body.category : "other";

    /* Priority is a request, not a promise — staff can raise it, users can't
       jump the queue by ticking "high" on everything. */
    const priority = req.body.priority === "high" ? "normal"
      : (PRIORITIES.includes(req.body.priority) ? req.body.priority : "normal");

    const open = db.prepare(
      "SELECT COUNT(*) AS n FROM support_tickets WHERE user_id = ? AND state != 'closed'"
    ).get(req.user.id).n;
    if (open >= 5) throw S.fail("You already have five open tickets. Close one first.");

    const now = Date.now();
    const run = db.transaction(() => {
      const info = db.prepare(
        `INSERT INTO support_tickets (user_id, subject, category, priority, state, created_at, updated_at)
         VALUES (?,?,?,?,'open',?,?)`
      ).run(req.user.id, subject, category, priority, now, now);

      db.prepare(
        "INSERT INTO support_messages (ticket_id, sender_id, body, from_staff, created_at) VALUES (?,?,?,0,?)"
      ).run(info.lastInsertRowid, req.user.id, body, now);

      return info.lastInsertRowid;
    });

    res.status(201).json({ id: run() });
  } catch (err) { next(err); }
});

router.get("/support", A.requireUser, (req, res) => {
  const rows = db.prepare(
    `SELECT t.*, u.username,
            (SELECT COUNT(*) FROM support_messages m WHERE m.ticket_id = t.id) AS replies
       FROM support_tickets t LEFT JOIN users u ON u.id = t.user_id
      WHERE t.user_id = ?
      ORDER BY t.updated_at DESC LIMIT 50`
  ).all(req.user.id);
  res.json({ tickets: rows.map((r) => shapeTicket(r, { replies: r.replies })) });
});

/* One ticket with its thread. Staff may read any; everyone else only theirs. */
router.get("/support/:id", A.requireUser, (req, res) => {
  const row = db.prepare(
    "SELECT t.*, u.username FROM support_tickets t LEFT JOIN users u ON u.id = t.user_id WHERE t.id = ?"
  ).get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: "No such ticket." });

  if (row.user_id !== req.user.id && !isStaff(req.user)) {
    return res.status(403).json({ error: "That isn't your ticket." });
  }

  const messages = db.prepare(
    `SELECT m.*, u.username FROM support_messages m
       LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.ticket_id = ? ORDER BY m.id`
  ).all(row.id);

  res.json({ ticket: shapeTicket(row), messages: messages.map(shapeMessage) });
});

router.post("/support/:id/reply", A.requireUser, replyLimit, (req, res, next) => {
  try {
    const row = db.prepare("SELECT * FROM support_tickets WHERE id = ?").get(Number(req.params.id));
    if (!row) return res.status(404).json({ error: "No such ticket." });

    const fromStaff = isStaff(req.user);
    if (row.user_id !== req.user.id && !fromStaff) {
      return res.status(403).json({ error: "That isn't your ticket." });
    }
    if (row.state === "closed" && !fromStaff) {
      return res.status(409).json({ error: "This ticket is closed. Open a new one." });
    }

    const body = S.str(req.body.body, { field: "Reply", min: 1, max: 4000 });
    const now = Date.now();

    db.transaction(() => {
      db.prepare(
        "INSERT INTO support_messages (ticket_id, sender_id, body, from_staff, created_at) VALUES (?,?,?,?,?)"
      ).run(row.id, req.user.id, body, fromStaff ? 1 : 0, now);

      /* A staff reply parks the ticket on the user; a user reply hands it
         back to staff. That's what the queue filters on. */
      db.prepare("UPDATE support_tickets SET state = ?, updated_at = ? WHERE id = ?")
        .run(fromStaff ? "waiting" : "open", now, row.id);
    })();

    if (fromStaff && row.user_id && row.user_id !== req.user.id) {
      notify.push(row.user_id, "support", {
        actorId: req.user.id,
        body: "Support replied to: " + row.subject,
        link: "support.html#t" + row.id
      });
    }

    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

/* Users may close their own ticket; staff may close or reopen any. */
router.patch("/support/:id", A.requireUser, (req, res, next) => {
  try {
    const row = db.prepare("SELECT * FROM support_tickets WHERE id = ?").get(Number(req.params.id));
    if (!row) return res.status(404).json({ error: "No such ticket." });

    const fromStaff = isStaff(req.user);
    if (row.user_id !== req.user.id && !fromStaff) {
      return res.status(403).json({ error: "That isn't your ticket." });
    }

    const patch = {};
    if (req.body.state !== undefined) {
      if (!STATES.includes(req.body.state)) throw S.fail("Unknown state.");
      if (!fromStaff && req.body.state !== "closed") {
        throw S.fail("You can close your ticket; only staff can reopen it.");
      }
      patch.state = req.body.state;
    }
    if (req.body.priority !== undefined) {
      if (!fromStaff) throw S.fail("Only staff set priority.");
      if (!PRIORITIES.includes(req.body.priority)) throw S.fail("Unknown priority.");
      patch.priority = req.body.priority;
    }
    if (!Object.keys(patch).length) throw S.fail("Nothing to change.");

    patch.updated_at = Date.now();
    db.prepare(
      `UPDATE support_tickets SET ${Object.keys(patch).map((k) => k + " = ?").join(", ")} WHERE id = ?`
    ).run(...Object.keys(patch).map((k) => patch[k]), row.id);

    if (fromStaff) audit(req.user.id, "support-" + (patch.state || "priority"), String(row.id));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ----------------------------------------------------------------- queue */

router.get("/admin/support", staff, (req, res) => {
  const state = STATES.includes(req.query.state) ? req.query.state : "open";
  const rows = db.prepare(
    `SELECT t.*, u.username,
            (SELECT COUNT(*) FROM support_messages m WHERE m.ticket_id = t.id) AS replies,
            (SELECT body FROM support_messages m WHERE m.ticket_id = t.id ORDER BY m.id LIMIT 1) AS opening
       FROM support_tickets t LEFT JOIN users u ON u.id = t.user_id
      WHERE t.state = ?
      ORDER BY CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
               t.updated_at DESC
      LIMIT 200`
  ).all(state);

  const counts = {};
  STATES.forEach((s) => {
    counts[s] = db.prepare("SELECT COUNT(*) AS n FROM support_tickets WHERE state = ?").get(s).n;
  });

  res.json({
    counts,
    tickets: rows.map((r) => shapeTicket(r, { replies: r.replies, opening: r.opening || "" }))
  });
});

module.exports = router;

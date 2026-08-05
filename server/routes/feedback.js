/* Feedback, and the cross-device store for third-party game progress.
   Both are things the arcade collects *about* itself rather than social data,
   so they live together away from the messaging routes. */
"use strict";

const express = require("express");
const { db, audit } = require("../db");
const A = require("../auth");
const S = require("../shape");

const router = express.Router();

const KINDS = ["bug", "idea", "game", "other"];
const STATES = ["new", "triaged", "done", "declined"];

/* Anonymous feedback is allowed — a broken sign-up is exactly the thing
   people need to be able to report. Tighter cap, since there's no account
   behind it. */
const feedbackLimit = A.rateLimit({
  name: "feedback",
  windowMs: 3600000,
  max: 12
});

/* ------------------------------------------------------------- submitting */

router.post("/feedback", feedbackLimit, (req, res, next) => {
  try {
    const kind = S.str(req.body.kind, { field: "Kind", max: 12 });
    if (!KINDS.includes(kind)) throw S.fail("Pick what kind of feedback this is.");

    const subject = S.str(req.body.subject, { field: "Summary", min: 3, max: 120 });
    const body = S.str(req.body.body, { field: "Details", min: 10, max: 4000 });
    const page = req.body.page ? S.str(req.body.page, { field: "Page", max: 200 }) : "";
    const gameId = req.body.gameId ? S.str(req.body.gameId, { field: "Game", max: 120 }) : "";

    const now = Date.now();
    const info = db.prepare(
      `INSERT INTO feedback (user_id, kind, subject, body, page, game_id, agent, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      req.user ? req.user.id : null,
      kind, subject, body, page, gameId,
      String(req.headers["user-agent"] || "").slice(0, 200),
      now, now
    );

    res.status(201).json({ ok: true, id: info.lastInsertRowid });
  } catch (err) { next(err); }
});

/* What you've sent, and what came back. */
router.get("/feedback/mine", A.requireUser, (req, res) => {
  const rows = db.prepare(
    "SELECT id, kind, subject, body, state, reply, created_at FROM feedback WHERE user_id = ? ORDER BY id DESC LIMIT 50"
  ).all(req.user.id);

  res.json({
    feedback: rows.map((r) => ({
      id: r.id, kind: r.kind, subject: r.subject, body: r.body,
      state: r.state, reply: r.reply, at: r.created_at
    }))
  });
});

/* ------------------------------------------------------------ moderation */

const staff = A.requireRole("admin", "mod");

router.get("/admin/feedback", staff, (req, res) => {
  const state = STATES.includes(req.query.state) ? req.query.state : "new";
  const rows = db.prepare(
    `SELECT f.*, u.username FROM feedback f
       LEFT JOIN users u ON u.id = f.user_id
      WHERE f.state = ? ORDER BY f.id DESC LIMIT 200`
  ).all(state);

  const counts = {};
  STATES.forEach((s) => {
    counts[s] = db.prepare("SELECT COUNT(*) AS n FROM feedback WHERE state = ?").get(s).n;
  });

  res.json({
    counts,
    feedback: rows.map((r) => ({
      id: r.id, kind: r.kind, subject: r.subject, body: r.body,
      page: r.page, gameId: r.game_id, agent: r.agent,
      state: r.state, reply: r.reply,
      from: r.username || "(anonymous)",
      at: r.created_at
    }))
  });
});

router.patch("/admin/feedback/:id", staff, (req, res, next) => {
  try {
    const row = db.prepare("SELECT * FROM feedback WHERE id = ?").get(Number(req.params.id));
    if (!row) return res.status(404).json({ error: "No such feedback." });

    const patch = {};
    if (req.body.state !== undefined) {
      if (!STATES.includes(req.body.state)) throw S.fail("Unknown state.");
      patch.state = req.body.state;
    }
    if (req.body.reply !== undefined) {
      patch.reply = S.str(req.body.reply, { field: "Reply", max: 1000 });
    }
    const keys = Object.keys(patch);
    if (!keys.length) throw S.fail("Nothing to change.");

    patch.updated_at = Date.now();
    db.prepare(
      `UPDATE feedback SET ${Object.keys(patch).map((k) => k + " = ?").join(", ")} WHERE id = ?`
    ).run(...Object.keys(patch).map((k) => patch[k]), row.id);

    /* Tell the reporter something happened, when there is one. */
    if (row.user_id && (patch.state || patch.reply)) {
      require("../notify").push(row.user_id, "feedback", {
        actorId: req.user.id,
        body: patch.reply
          ? "A moderator replied to your feedback: " + row.subject
          : "Your feedback was marked " + patch.state + ": " + row.subject,
        link: "feedback.html"
      });
    }

    audit(req.user.id, "feedback-" + (patch.state || "reply"), String(row.id));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* --------------------------------------------------------- game progress */

/* Per host. Generous because IndexedDB saves carry binary — Unity keeps its
   whole virtual filesystem there — and it is base64'd to survive JSON, which
   inflates it by a third. The bridge caps its own side at 3 MB encoded. */
const MAX_SAVE_BYTES = 4 * 1024 * 1024;
const HOSTS = /^[a-z0-9._-]{1,64}$/i;

/* Third-party games keep progress in their own origin's localStorage. The
   browser bridge snapshots that and posts it here, keyed by host, so it can
   be restored on another device. We never interpret the contents. */
router.put("/game-saves/:host", A.requireUser, (req, res, next) => {
  try {
    const host = String(req.params.host);
    if (!HOSTS.test(host)) throw S.fail("Unknown game host.");

    const payload = req.body && req.body.payload;
    if (!payload || typeof payload !== "object") throw S.fail("No save data supplied.");

    const text = JSON.stringify(payload);
    if (text.length > MAX_SAVE_BYTES) {
      throw S.fail(`That host's saves are over ${Math.round(MAX_SAVE_BYTES / 1024)} KB.`);
    }

    db.prepare(
      `INSERT INTO game_saves (user_id, host, payload, keys, bytes, updated_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(user_id, host) DO UPDATE SET
         payload = excluded.payload, keys = excluded.keys,
         bytes = excluded.bytes, updated_at = excluded.updated_at`
    ).run(req.user.id, host, text, Object.keys(payload).length, text.length, Date.now());

    res.json({ ok: true, keys: Object.keys(payload).length, bytes: text.length });
  } catch (err) { next(err); }
});

router.get("/game-saves/:host", A.requireUser, (req, res) => {
  const row = db.prepare("SELECT * FROM game_saves WHERE user_id = ? AND host = ?")
    .get(req.user.id, String(req.params.host));
  if (!row) return res.json({ payload: {}, updatedAt: 0, keys: 0 });

  let payload = {};
  try { payload = JSON.parse(row.payload); } catch { /* corrupt row reads as empty */ }
  res.json({ payload, updatedAt: row.updated_at, keys: row.keys, bytes: row.bytes });
});

router.get("/game-saves", A.requireUser, (req, res) => {
  const rows = db.prepare(
    "SELECT host, keys, bytes, updated_at FROM game_saves WHERE user_id = ? ORDER BY host"
  ).all(req.user.id);
  res.json({
    hosts: rows.map((r) => ({
      host: r.host, keys: r.keys, bytes: r.bytes, updatedAt: r.updated_at
    }))
  });
});

router.delete("/game-saves/:host", A.requireUser, (req, res) => {
  db.prepare("DELETE FROM game_saves WHERE user_id = ? AND host = ?")
    .run(req.user.id, String(req.params.host));
  res.json({ ok: true });
});

module.exports = router;

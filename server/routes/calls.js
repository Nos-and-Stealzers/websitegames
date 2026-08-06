/* Voice / video / screen-share signalling.
 *
 * The media never touches this server. Browsers connect to each other
 * directly over WebRTC; all we do is carry the handful of setup messages
 * (offer, answer, ICE candidates) between them, and STUN — which is what
 * tells a browser its own public address — is free from Google's public
 * servers. So calling costs nothing to run.
 *
 * Signalling is a polled table rather than a socket server, so this works on
 * any host that can run the API at all. Rows are consumed on read and swept
 * after a minute; nothing here is durable and nothing here is media.
 *
 * The ceiling is real and worth stating: every peer connects to every other
 * peer (a mesh), so each extra person costs everyone another upload stream.
 * Fine to about four. Beyond that you need an SFU, which is a server that
 * relays video — and that is the part that costs money.
 */
"use strict";

const express = require("express");
const { db } = require("../db");
const A = require("../auth");
const S = require("../shape");
const notify = require("../notify");

const router = express.Router();

const MAX_PEERS = 4;
const RING_TIMEOUT = 45000;      // unanswered calls stop ringing
const SIGNAL_TTL = 60000;        // undelivered signals are stale after this
const KINDS = ["audio", "video", "screen"];
const SIGNALS = ["offer", "answer", "ice", "bye"];

/* ICE servers handed to the browser. STUN is free and public. TURN relays
   media when a network blocks direct connections — school networks often do —
   and it is the one piece that costs money, so it is opt-in through env
   rather than assumed. Without it, calls still work on most networks. */
function iceServers() {
  const list = [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }
  ];
  if (process.env.TURN_URL && process.env.TURN_USER && process.env.TURN_PASS) {
    list.push({
      urls: process.env.TURN_URL.split(",").map((s) => s.trim()).filter(Boolean),
      username: process.env.TURN_USER,
      credential: process.env.TURN_PASS
    });
  }
  return list;
}

router.get("/calls/ice", A.requireUser, (req, res) => {
  res.json({ iceServers: iceServers(), maxPeers: MAX_PEERS });
});

function sweep() {
  const now = Date.now();
  db.prepare("DELETE FROM call_signals WHERE created_at < ?").run(now - SIGNAL_TTL);
  db.prepare(
    "UPDATE calls SET state = 'ended', ended_at = ? WHERE state = 'ringing' AND created_at < ?"
  ).run(now, now - RING_TIMEOUT);
}

function peersOf(callId) {
  return db.prepare(
    `SELECT p.user_id, p.state, u.username, u.display_name
       FROM call_peers p JOIN users u ON u.id = p.user_id
      WHERE p.call_id = ?`
  ).all(callId).map((r) => ({
    id: r.user_id,
    username: r.username,
    displayName: r.display_name || r.username,
    state: r.state
  }));
}

function shapeCall(row) {
  return {
    id: row.id,
    threadId: row.thread_id,
    startedBy: row.started_by,
    kind: row.kind,
    state: row.state,
    at: row.created_at,
    peers: peersOf(row.id)
  };
}

/* You may only be signalled by someone in the same call as you. Without this
   check the signal table would be an open relay between any two accounts. */
function inCall(callId, userId) {
  return !!db.prepare("SELECT 1 FROM call_peers WHERE call_id = ? AND user_id = ?")
    .get(callId, userId);
}

/* ---------------------------------------------------------------- start */

const startLimit = A.rateLimit({
  name: "call-start",
  windowMs: 300000,
  max: 20,
  key: (req) => String(req.user ? req.user.id : "")
});

router.post("/calls", A.requireUser, startLimit, (req, res, next) => {
  try {
    const kind = KINDS.includes(req.body.kind) ? req.body.kind : "audio";
    const threadId = req.body.threadId ? Number(req.body.threadId) : null;

    let invite = [];
    if (threadId) {
      /* Membership of the thread is the permission here. Requiring everyone
         to also be pairwise friends would make group calls impossible the
         moment a group contains two people who haven't added each other —
         which is most groups. */
      const member = db.prepare("SELECT 1 FROM thread_members WHERE thread_id = ? AND user_id = ?")
        .get(threadId, req.user.id);
      if (!member) return res.status(403).json({ error: "You're not in that conversation." });

      invite = db.prepare("SELECT user_id FROM thread_members WHERE thread_id = ? AND user_id != ?")
        .all(threadId, req.user.id).map((r) => r.user_id);
    } else {
      const to = Number(req.body.userId);
      if (!to) throw S.fail("Say who you're calling.");

      /* A one-to-one call is friends-only. It's a live microphone into
         someone's room, so it earns a stricter bar than messaging. */
      const friends = db.prepare(
        `SELECT CASE WHEN requester_id = ? THEN addressee_id ELSE requester_id END AS other
           FROM friendships
          WHERE state = 'accepted' AND (requester_id = ? OR addressee_id = ?)`
      ).all(req.user.id, req.user.id, req.user.id).map((r) => r.other);

      if (!friends.includes(to)) throw S.fail("You can only call friends.");
      invite = [to];
    }

    if (!invite.length) throw S.fail("There's nobody to call.");
    if (invite.length + 1 > MAX_PEERS) {
      throw S.fail(`Calls hold ${MAX_PEERS} people. Bigger groups need a relay server we don't run.`);
    }

    sweep();
    const now = Date.now();

    const start = db.transaction(() => {
      const info = db.prepare(
        "INSERT INTO calls (thread_id, started_by, kind, state, created_at) VALUES (?,?,?,'ringing',?)"
      ).run(threadId, req.user.id, kind, now);
      const callId = info.lastInsertRowid;

      db.prepare("INSERT INTO call_peers (call_id, user_id, state, joined_at) VALUES (?,?,'joined',?)")
        .run(callId, req.user.id, now);
      const add = db.prepare("INSERT INTO call_peers (call_id, user_id, state) VALUES (?,?,'invited')");
      invite.forEach((id) => add.run(callId, id));

      return callId;
    })();

    const label = req.user.display_name || req.user.username;
    invite.forEach((id) => {
      notify.push(id, "call", {
        actorId: req.user.id,
        body: `${label} is calling you.`,
        link: "messages.html"
      });
    });

    const row = db.prepare("SELECT * FROM calls WHERE id = ?").get(start);
    res.status(201).json({ call: shapeCall(row), iceServers: iceServers() });
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------- incoming */

/* Anything ringing for me, plus calls I'm already in. The client polls this
   so a call can arrive on any page, including while a game is open. */
router.get("/calls/pending", A.requireUser, (req, res) => {
  sweep();
  const rows = db.prepare(
    `SELECT c.* FROM calls c
       JOIN call_peers p ON p.call_id = c.id AND p.user_id = ?
      WHERE c.state != 'ended' AND p.state != 'left'
      ORDER BY c.id DESC LIMIT 5`
  ).all(req.user.id);

  res.json({ calls: rows.map(shapeCall) });
});

router.post("/calls/:id/join", A.requireUser, (req, res) => {
  const call = db.prepare("SELECT * FROM calls WHERE id = ?").get(Number(req.params.id));
  if (!call) return res.status(404).json({ error: "No such call." });
  if (call.state === "ended") return res.status(409).json({ error: "That call already ended." });
  if (!inCall(call.id, req.user.id)) return res.status(403).json({ error: "You weren't invited." });

  const now = Date.now();
  db.prepare("UPDATE call_peers SET state = 'joined', joined_at = ? WHERE call_id = ? AND user_id = ?")
    .run(now, call.id, req.user.id);
  db.prepare("UPDATE calls SET state = 'live' WHERE id = ? AND state = 'ringing'").run(call.id);

  const fresh = db.prepare("SELECT * FROM calls WHERE id = ?").get(call.id);
  res.json({ call: shapeCall(fresh), iceServers: iceServers(), self: req.user.id });
});

/* Leaving is per-person. The call itself ends when the last peer drops, so a
   three-way doesn't collapse because one person hung up. */
router.post("/calls/:id/leave", A.requireUser, (req, res) => {
  const call = db.prepare("SELECT * FROM calls WHERE id = ?").get(Number(req.params.id));
  if (!call) return res.json({ ok: true });
  if (!inCall(call.id, req.user.id)) return res.status(403).json({ error: "You weren't in that call." });

  db.prepare("UPDATE call_peers SET state = 'left' WHERE call_id = ? AND user_id = ?")
    .run(call.id, req.user.id);

  /* Tell the others directly — they shouldn't have to wait for a poll to
     tear the peer connection down. */
  const now = Date.now();
  const others = db.prepare(
    "SELECT user_id FROM call_peers WHERE call_id = ? AND user_id != ? AND state = 'joined'"
  ).all(call.id, req.user.id);

  const bye = db.prepare(
    "INSERT INTO call_signals (call_id, from_id, to_id, kind, payload, created_at) VALUES (?,?,?,'bye',?,?)"
  );
  others.forEach((o) => bye.run(call.id, req.user.id, o.user_id, "{}", now));

  const left = db.prepare(
    "SELECT COUNT(*) AS n FROM call_peers WHERE call_id = ? AND state = 'joined'"
  ).get(call.id).n;
  if (left <= 1) {
    db.prepare("UPDATE calls SET state = 'ended', ended_at = ? WHERE id = ?").run(now, call.id);
  }

  res.json({ ok: true, ended: left <= 1 });
});

/* -------------------------------------------------------------- signals */

/* Offers and ICE candidates are opaque to us. We cap the size so a peer
   can't use the table as storage, and we never parse the contents. */
const MAX_SIGNAL = 16000;

router.post("/calls/:id/signal", A.requireUser, (req, res, next) => {
  try {
    const callId = Number(req.params.id);
    const call = db.prepare("SELECT * FROM calls WHERE id = ?").get(callId);
    if (!call) return res.status(404).json({ error: "No such call." });
    if (call.state === "ended") return res.status(409).json({ error: "That call already ended." });
    if (!inCall(callId, req.user.id)) return res.status(403).json({ error: "You're not in that call." });

    const kind = String(req.body.kind || "");
    if (!SIGNALS.includes(kind)) throw S.fail("Unknown signal.");

    const to = Number(req.body.to);
    if (!inCall(callId, to)) throw S.fail("That person isn't in this call.");

    const payload = JSON.stringify(req.body.payload || {});
    if (payload.length > MAX_SIGNAL) throw S.fail("That signal is too large.");

    db.prepare(
      "INSERT INTO call_signals (call_id, from_id, to_id, kind, payload, created_at) VALUES (?,?,?,?,?,?)"
    ).run(callId, req.user.id, to, kind, payload, Date.now());

    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

/* Read-and-consume. Signals are delivered once; a peer that drops them has
   to renegotiate, which WebRTC does anyway. */
router.get("/calls/:id/signal", A.requireUser, (req, res) => {
  const callId = Number(req.params.id);
  if (!inCall(callId, req.user.id)) return res.status(403).json({ error: "You're not in that call." });

  const take = db.transaction(() => {
    const rows = db.prepare(
      "SELECT * FROM call_signals WHERE call_id = ? AND to_id = ? ORDER BY id LIMIT 40"
    ).all(callId, req.user.id);
    if (rows.length) {
      db.prepare(
        `DELETE FROM call_signals WHERE id IN (${rows.map(() => "?").join(",")})`
      ).run(...rows.map((r) => r.id));
    }
    return rows;
  });

  const rows = take();
  const call = db.prepare("SELECT * FROM calls WHERE id = ?").get(callId);

  res.json({
    call: call ? shapeCall(call) : null,
    signals: rows.map((r) => {
      let payload = {};
      try { payload = JSON.parse(r.payload); } catch { /* drop malformed */ }
      return { id: r.id, from: r.from_id, kind: r.kind, payload, at: r.created_at };
    })
  });
});

module.exports = router;

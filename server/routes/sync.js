/* Save sync and reports.
   The browser stays the source of truth while signed out; on sign-in the two
   sides are merged so nothing a visitor built up locally is thrown away. */
"use strict";

const express = require("express");
const { db } = require("../db");
const A = require("../auth");
const S = require("../shape");

const router = express.Router();

const MAX_SAVE = 512 * 1024;

function emptySave() {
  return { version: 2, favorites: [], recents: [], stats: {}, ratings: {}, settings: {} };
}

function readSave(userId) {
  const row = db.prepare("SELECT payload, updated_at FROM saves WHERE user_id = ?").get(userId);
  if (!row) return { save: emptySave(), updatedAt: 0 };
  try {
    return { save: Object.assign(emptySave(), JSON.parse(row.payload)), updatedAt: row.updated_at };
  } catch {
    return { save: emptySave(), updatedAt: row.updated_at };
  }
}

/* Union favourites, newest-wins recents, max-wins stats and ratings. Merging
   rather than overwriting means signing in on a second device never destroys
   progress made on the first. */
function merge(mine, theirs) {
  const out = emptySave();

  out.favorites = [...new Set([...(theirs.favorites || []), ...(mine.favorites || [])])];

  const recents = new Map();
  [...(mine.recents || []), ...(theirs.recents || [])].forEach((r) => {
    if (!r || !r.id) return;
    const prev = recents.get(r.id);
    if (!prev || (r.at || 0) > prev.at) recents.set(r.id, { id: r.id, at: r.at || 0 });
  });
  out.recents = [...recents.values()].sort((a, b) => b.at - a.at).slice(0, 40);

  const ids = new Set([...Object.keys(mine.stats || {}), ...Object.keys(theirs.stats || {})]);
  ids.forEach((id) => {
    const a = (mine.stats || {})[id] || {};
    const b = (theirs.stats || {})[id] || {};
    out.stats[id] = {
      plays: Math.max(a.plays || 0, b.plays || 0),
      seconds: Math.max(a.seconds || 0, b.seconds || 0),
      last: Math.max(a.last || 0, b.last || 0)
    };
  });

  Object.assign(out.ratings, theirs.ratings || {}, mine.ratings || {});
  Object.assign(out.settings, theirs.settings || {}, mine.settings || {});
  return out;
}

function writeSave(userId, save) {
  const payload = JSON.stringify(save);
  if (payload.length > MAX_SAVE) throw S.fail("That save file is too large.");
  db.prepare(
    `INSERT INTO saves (user_id, payload, updated_at) VALUES (?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
  ).run(userId, payload, Date.now());
}

/* Aggregate counters, so "popular" reflects everyone rather than one browser. */
function bumpGameStats(before, after) {
  const stmt = db.prepare(
    `INSERT INTO game_stats (game_id, plays, seconds) VALUES (?,?,?)
     ON CONFLICT(game_id) DO UPDATE SET plays = plays + excluded.plays,
                                        seconds = seconds + excluded.seconds`
  );
  const apply = db.transaction((rows) => rows.forEach((r) => stmt.run(r.id, r.plays, r.seconds)));

  const rows = [];
  Object.keys(after.stats || {}).forEach((id) => {
    const a = (before.stats || {})[id] || { plays: 0, seconds: 0 };
    const b = after.stats[id];
    const plays = Math.max(0, (b.plays || 0) - (a.plays || 0));
    const seconds = Math.max(0, (b.seconds || 0) - (a.seconds || 0));
    if (plays || seconds) rows.push({ id: String(id).slice(0, 120), plays, seconds });
  });
  if (rows.length) apply(rows);
}

/* ------------------------------------------------------------------ API */

router.get("/sync", A.requireUser, (req, res) => {
  const { save, updatedAt } = readSave(req.user.id);
  res.json({ save, updatedAt });
});

/* Send the local save; get the merged result back to adopt. */
router.put("/sync", A.requireUser, (req, res, next) => {
  try {
    const incoming = req.body && typeof req.body.save === "object" ? req.body.save : null;
    if (!incoming) throw S.fail("No save supplied.");

    const { save: stored } = readSave(req.user.id);
    const merged = merge(incoming, stored);

    writeSave(req.user.id, merged);
    bumpGameStats(stored, merged);

    res.json({ save: merged, updatedAt: Date.now() });
  } catch (err) { next(err); }
});

/* Public leaderboard of what everyone actually plays. */
router.get("/games/popular", (req, res) => {
  const rows = db.prepare(
    "SELECT game_id, plays, seconds FROM game_stats ORDER BY seconds DESC, plays DESC LIMIT 40"
  ).all();
  res.json({ games: rows.map((r) => ({ id: r.game_id, plays: r.plays, seconds: r.seconds })) });
});

/* ------------------------------------------------------------- reports */

const reportLimit = A.rateLimit({ name: "reports", windowMs: 3600000, max: 10 });

router.post("/reports", A.requireUser, reportLimit, (req, res, next) => {
  try {
    const kind = S.str(req.body.kind, { field: "Kind", max: 16 });
    if (!["user", "message", "game"].includes(kind)) throw S.fail("Unknown report type.");
    const target = S.str(req.body.target, { field: "Target", min: 1, max: 200 });
    const reason = S.str(req.body.reason, { field: "Reason", min: 4, max: 1000 });

    db.prepare(
      "INSERT INTO reports (reporter_id, kind, target, reason, created_at) VALUES (?,?,?,?,?)"
    ).run(req.user.id, kind, target, reason, Date.now());

    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.merge = merge;

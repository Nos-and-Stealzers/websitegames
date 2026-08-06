/* Catalogue editing for the owner.
 *
 * data/games.json stays the bulk, version-controlled list. These are entries
 * layered over it at runtime, so a game can be added without a commit and a
 * deploy. A "removed" row is a tombstone that hides a games.json entry rather
 * than editing the file.
 *
 * Owner-only on purpose: this decides what the whole site serves, which is a
 * bigger blast radius than moderation.
 */
"use strict";

const express = require("express");
const { db, audit } = require("../db");
const A = require("../auth");
const S = require("../shape");

const router = express.Router();
const owner = A.requireRole("owner");

const CATEGORIES = [
  "arcade", "action", "puzzle", "strategy", "horror", "platformer", "sports",
  "racing", "adventure", "simulation", "rpg", "sandbox", "idle", "clicker", "other"
];
const RISKS = ["low", "medium", "high", "unknown"];

/* Anyone may read the overlay — the site needs it to render the catalogue. */
router.get("/catalog/custom", (req, res) => {
  const rows = db.prepare(
    "SELECT game_id, payload, removed, updated_at FROM custom_games ORDER BY id"
  ).all();

  const added = [];
  const removed = [];
  for (const row of rows) {
    if (row.removed) { removed.push(row.game_id); continue; }
    try { added.push(Object.assign(JSON.parse(row.payload), { id: row.game_id })); }
    catch { /* a corrupt row shouldn't take the catalogue down */ }
  }
  res.json({ added, removed, updatedAt: rows.reduce((n, r) => Math.max(n, r.updated_at), 0) });
});

function clean(body) {
  const id = S.str(body.id, { field: "Game id", min: 2, max: 80 })
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");        // punctuation at either end leaves a stub dash
  if (!id) throw S.fail("That id has no usable characters.");

  const category = CATEGORIES.includes(body.category) ? body.category : "other";
  const risk = RISKS.includes(body.schoolRisk) ? body.schoolRisk : "unknown";

  const source = S.str(body.source, { field: "Path or URL", min: 1, max: 400 });
  const host = body.host ? S.str(body.host, { field: "Host", max: 40 }) : "";

  /* A root-relative path with no host would resolve against the hub itself
     and quietly 404, so require one or the other. */
  if (!host && !/^https?:\/\//i.test(source)) {
    throw S.fail("Pick a host, or give a full https:// URL.");
  }

  return {
    id,
    title: S.str(body.title, { field: "Title", min: 1, max: 120 }),
    category,
    description: body.description ? S.str(body.description, { field: "Description", max: 400 }) : "",
    gradient: body.gradient ? S.str(body.gradient, { field: "Gradient", max: 200 })
                            : "linear-gradient(135deg,#3a3f4b,#6b7280)",
    host,
    source,
    direct: body.direct ? S.str(body.direct, { field: "Direct URL", max: 400 }) : source,
    platform: body.platform === "web" ? "web" : "local",
    embed: body.embed === false ? false : "allowed",
    preferDirect: body.preferDirect === true,
    schoolRisk: risk,
    notice: body.notice ? S.str(body.notice, { field: "Notice", max: 600 }) : "",
    icon: body.icon ? S.str(body.icon, { field: "Icon", max: 400 }) : ""
  };
}

router.post("/catalog/custom", owner, (req, res, next) => {
  try {
    const entry = clean(req.body);
    const now = Date.now();
    db.prepare(
      `INSERT INTO custom_games (game_id, payload, removed, added_by, created_at, updated_at)
       VALUES (?,?,0,?,?,?)
       ON CONFLICT(game_id) DO UPDATE SET
         payload = excluded.payload, removed = 0, updated_at = excluded.updated_at`
    ).run(entry.id, JSON.stringify(entry), req.user.id, now, now);

    audit(req.user.id, "catalog-save", entry.id);
    res.status(201).json({ game: entry });
  } catch (err) { next(err); }
});

/* Removing a runtime entry deletes it. Removing one that lives in games.json
   leaves a tombstone, since the file is not ours to edit from here. */
router.delete("/catalog/custom/:id", owner, (req, res) => {
  const id = String(req.params.id);
  const row = db.prepare("SELECT * FROM custom_games WHERE game_id = ?").get(id);
  const now = Date.now();

  if (row && !row.removed && req.query.hard === "1") {
    db.prepare("DELETE FROM custom_games WHERE game_id = ?").run(id);
  } else {
    db.prepare(
      `INSERT INTO custom_games (game_id, payload, removed, added_by, created_at, updated_at)
       VALUES (?,?,1,?,?,?)
       ON CONFLICT(game_id) DO UPDATE SET removed = 1, updated_at = excluded.updated_at`
    ).run(id, "{}", req.user.id, now, now);
  }

  audit(req.user.id, "catalog-remove", id);
  res.json({ ok: true });
});

/* Undo a tombstone, putting a games.json entry back. */
router.post("/catalog/custom/:id/restore", owner, (req, res) => {
  const id = String(req.params.id);
  const info = db.prepare("DELETE FROM custom_games WHERE game_id = ? AND removed = 1").run(id);
  if (!info.changes) return res.status(404).json({ error: "Nothing hidden under that id." });
  audit(req.user.id, "catalog-restore", id);
  res.json({ ok: true });
});

module.exports = router;

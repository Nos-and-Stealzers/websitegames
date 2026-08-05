/* Harvests a real icon for every catalog entry.
 *
 * For each game it fetches that game's own index.html (capped read), pulls the
 * icon it declares — apple-touch-icon, og:image, <link rel=icon> — resolves it,
 * verifies the file actually exists, and writes it back to data/games.json as
 * `icon`. Anything without a usable icon keeps the generated cover plate.
 *
 *   node tools/harvest-icons.js                  probe the configured host
 *   node tools/harvest-icons.js --host https://…  probe somewhere else
 *   node tools/harvest-icons.js --only 20         first 20 entries (dry run)
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CATALOG = path.join(ROOT, "data", "games.json");

const args = process.argv.slice(2);
function arg(flag, fallback) {
  const i = args.indexOf(flag);
  return i === -1 ? fallback : args[i + 1];
}

const HOST = (arg("--host", "https://arcadecampushub.online")).replace(/\/+$/, "");
const LIMIT = Number(arg("--only", "0")) || 0;
const CONCURRENCY = 8;
const HTML_CAP = 262144;          // stop reading a page after 256 KB
const TIMEOUT = 12000;

/* ---------------------------------------------------------------- fetching */

async function get(url, { cap = HTML_CAP } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: "follow" });
    if (!res.ok || !res.body) return { ok: false, status: res.status };

    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    while (size < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    reader.cancel().catch(() => {});
    return {
      ok: true,
      status: res.status,
      url: res.url,
      text: Buffer.concat(chunks).toString("utf8")
    };
  } catch (err) {
    return { ok: false, error: err.name };
  } finally {
    clearTimeout(timer);
  }
}

/* Confirm a candidate is a real image and not an HTML error page. */
async function verify(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    let res = await fetch(url, { method: "HEAD", signal: ctl.signal, redirect: "follow" });
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, { method: "GET", headers: { Range: "bytes=0-64" }, signal: ctl.signal });
    }
    if (!res.ok) return false;
    const type = (res.headers.get("content-type") || "").toLowerCase();
    if (type && !type.startsWith("image/")) return false;
    const len = Number(res.headers.get("content-length") || 0);
    if (len && len < 64) return false;      // 1×1 spacers and empty stubs
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/* ----------------------------------------------------------------- parsing */

function attr(tag, name) {
  const m = tag.match(new RegExp(name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', "i"));
  return m ? (m[2] ?? m[3] ?? m[4] ?? "").trim() : "";
}

/* Ordered best-first. `slug` is the game's own folder name — a very common
   naming convention for the cover image sitting next to index.html. */
function candidates(html, slug) {
  const out = [];

  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const rel = attr(tag, "rel").toLowerCase();
    const href = attr(tag, "href");
    if (!href || !rel.includes("icon")) continue;
    const sizes = attr(tag, "sizes");
    const px = parseInt(sizes, 10) || (rel.includes("apple") ? 180 : 0);
    out.push({ href, rank: rel.includes("apple") ? 0 : 2, px });
  }

  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const key = (attr(tag, "property") || attr(tag, "name")).toLowerCase();
    const val = attr(tag, "content");
    if (!val) continue;
    if (key === "og:image" || key === "twitter:image") out.push({ href: val, rank: 1, px: 0 });
  }

  /* Any <img> the page itself shows, before we start guessing. */
  for (const tag of (html.match(/<img\b[^>]*>/gi) || []).slice(0, 6)) {
    const src = attr(tag, "src");
    if (src && !/^data:/i.test(src) && !/\b(spacer|pixel|blank|loading|ajax)\b/i.test(src)) {
      out.push({ href: src, rank: 3, px: 0 });
    }
  }

  /* Naming conventions, tried only if nothing above verifies. */
  const guesses = [];
  const EXT = ["png", "jpg", "jpeg", "webp", "gif"];
  if (slug) EXT.forEach((e) => guesses.push(`${slug}.${e}`));
  EXT.forEach((e) => guesses.push(`icon.${e}`, `logo.${e}`, `thumb.${e}`, `cover.${e}`));
  guesses.push(
    "thumbnail.png", "splash.png", "screenshot.png",
    "favicon.png", "favicon.ico",
    "TemplateData/logo.png", "TemplateData/icon.png", "TemplateData/favicon.ico",
    "img/icon.png", "img/logo.png", "images/icon.png", "assets/icon.png", "assets/logo.png"
  );
  guesses.forEach((href) => out.push({ href, rank: 5, px: 0 }));

  const seen = new Set();
  return out
    .filter((c) => {
      const k = c.href.toLowerCase();
      if (seen.has(k) || k.startsWith("data:")) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.rank - b.rank || b.px - a.px)
    .slice(0, 44);
}

/* ------------------------------------------------------------------ resolve */

function gameDir(game) {
  const src = game.source || game.direct || "";
  const dir = src.replace(/[^/]*$/, "");
  return dir.startsWith("/") ? dir : "/" + dir;
}

/* Keep same-host results root-relative so js/config.js gameBase still applies. */
function toStored(absolute) {
  if (absolute.startsWith(HOST + "/")) return absolute.slice(HOST.length);
  return absolute;
}

async function harvest(game) {
  const dir = gameDir(game);
  if (!dir || dir === "/") return { id: game.id, icon: null, why: "no source path" };
  const slug = dir.replace(/\/$/, "").split("/").pop();

  const page = await get(HOST + dir + "index.html");
  if (!page.ok) return { id: game.id, icon: null, why: "page " + (page.status || page.error) };

  for (const cand of candidates(page.text, slug)) {
    let abs;
    try {
      abs = new URL(cand.href, HOST + dir).toString();
    } catch {
      continue;
    }
    /* A root-relative "/favicon.ico" resolves to the hub's own icon, which would
       make every such game look identical. Only accept files the game owns. */
    if (abs.startsWith(HOST) && !abs.startsWith(HOST + dir)) continue;

    if (await verify(abs)) {
      return { id: game.id, icon: toStored(abs), why: "rank " + cand.rank };
    }
  }
  return { id: game.id, icon: null, why: "none verified" };
}

/* --------------------------------------------------------------------- run */

async function pool(items, worker, size) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
      }
    })
  );
  return results;
}

(async () => {
  const games = JSON.parse(fs.readFileSync(CATALOG, "utf8").replace(/^﻿/, ""));
  const FILL = args.includes("--fill");     // only probe entries still without one
  let targets = FILL ? games.filter((g) => !g.icon) : games;
  if (LIMIT) targets = targets.slice(0, LIMIT);

  console.log(`Probing ${targets.length} titles on ${HOST} (${CONCURRENCY} at a time)…\n`);
  const started = Date.now();
  let done = 0;

  const found = await pool(targets, async (game) => {
    const res = await harvest(game);
    done++;
    if (done % 20 === 0) process.stdout.write(`  … ${done}/${targets.length}\n`);
    return res;
  }, CONCURRENCY);

  const hits = found.filter((r) => r.icon);
  const byId = new Map(found.map((r) => [r.id, r.icon]));

  for (const game of games) {
    const icon = byId.get(game.id);
    if (icon) game.icon = icon;
    else if (byId.has(game.id)) delete game.icon;
  }

  /* An icon shared by several titles is a site logo, not a cover — it makes
     those games indistinguishable, which is the opposite of the point. Drop it
     and let the generated plate (always unique) take over. */
  const usage = new Map();
  games.forEach((g) => { if (g.icon) usage.set(g.icon, (usage.get(g.icon) || 0) + 1); });
  const shared = [...usage.entries()].filter(([, n]) => n > 2);
  let dropped = 0;
  games.forEach((g) => {
    if (g.icon && usage.get(g.icon) > 2) { delete g.icon; dropped++; }
  });
  if (shared.length) {
    console.log(`\ndeduped: dropped ${dropped} icons shared across titles`);
    shared.forEach(([url, n]) => console.log(`  ${String(n).padStart(3)}×  ${url}`));
  }

  if (!LIMIT) {
    fs.writeFileSync(CATALOG, JSON.stringify(games, null, 2) + "\n", "utf8");
    console.log("\nWrote data/games.json");
  } else {
    console.log("\nDry run — catalog not written");
  }

  const reasons = {};
  found.filter((r) => !r.icon).forEach((r) => { reasons[r.why] = (reasons[r.why] || 0) + 1; });

  console.log(`\nicons found : ${hits.length}/${targets.length}`);
  console.log(`elapsed     : ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log("misses      :", reasons);
  console.log("\nsamples:");
  hits.slice(0, 8).forEach((h) => console.log("  " + h.id.padEnd(28) + h.icon));
})();

/* Which games actually save anything, and where?
 *
 * The admin editor and the backup bridge work per *origin*, not per game —
 * every title on a host shares that host's localStorage. So the real
 * questions are: does a game store progress at all, and does it use a
 * storage the bridge can see?
 *
 *   node tools/audit-game-saves.js            all titles
 *   node tools/audit-game-saves.js --only 20  a sample
 *
 * Fetches each game's page plus the scripts it loads, and looks for storage
 * calls. A game whose logic lives in a compiled blob (Unity .data, Flash)
 * may still save without matching — reported separately rather than as "no".
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const args = process.argv.slice(2);
const LIMIT = Number((args[args.indexOf("--only") + 1]) || 0) || 0;

const cfg = fs.readFileSync(path.join(ROOT, "js", "config.js"), "utf8");
const HOSTS = {};
cfg.match(/gameHosts:\s*\{([\s\S]*?)\}/)[1].split("\n").forEach((line) => {
  const m = line.match(/"([^"]+)":\s*"([^"]+)"/);
  if (m) HOSTS[m[1]] = m[2].replace(/\/+$/, "");
});

const games = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "games.json"), "utf8"))
  .filter((g) => !g.unavailable && g.host && HOSTS[g.host]);

function url(p, host) {
  return p.startsWith("/") ? HOSTS[host] + p : HOSTS[host] + "/" + p;
}

const STORAGE = [
  [/\blocalStorage\b/, "localStorage"],
  [/\bsessionStorage\b/, "sessionStorage"],
  [/\bindexedDB\b|\bopenDatabase\b/, "indexedDB"],
  [/document\.cookie/, "cookie"],
  [/FS_createDataFile|IDBFS|_JS_Log|unityFramework/, "unity-fs"]
];

/* Unity and Flash keep their logic in a binary the scanner cannot read. */
const OPAQUE = [/UnityLoader|unityFramework|\.unityweb|Build\/|createUnityInstance/i,
                /ruffle|\.swf\b/i];

async function grab(u, cap = 400000) {
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
    if (!r.ok || !r.body) return null;
    const reader = r.body.getReader();
    const chunks = [];
    let size = 0;
    while (size < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    reader.cancel().catch(() => {});
    return Buffer.concat(chunks).toString("utf8");
  } catch { return null; }
}

async function inspect(game) {
  const page = await grab(url(game.source, game.host));
  if (page === null) return { id: game.id, host: game.host, status: "unreachable" };

  let text = page;
  const opaque = OPAQUE.some((re) => re.test(page));

  /* Follow the scripts the page loads — most games keep their save code
     there rather than inline. */
  const srcs = [...page.matchAll(/<script[^>]+src\s*=\s*["']([^"']+)["']/gi)]
    .map((m) => m[1])
    .filter((s) => !/^https?:|^\/\//i.test(s))
    .slice(0, 4);

  const dir = url(game.source, game.host).replace(/[^/]*$/, "");
  for (const src of srcs) {
    let abs;
    try { abs = new URL(src, dir).toString(); } catch { continue; }
    const js = await grab(abs, 500000);
    if (js) text += "\n" + js;
  }

  const found = STORAGE.filter(([re]) => re.test(text)).map(([, name]) => name);
  return {
    id: game.id, host: game.host, opaque,
    storage: found,
    status: found.length ? "saves" : opaque ? "opaque" : "stateless"
  };
}

async function pool(items, worker, size) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (true) {
      const n = i++;
      if (n >= items.length) return;
      out[n] = await worker(items[n]);
    }
  }));
  return out;
}

(async () => {
  const targets = LIMIT ? games.slice(0, LIMIT) : games;
  console.log(`inspecting ${targets.length} titles\n`);

  let done = 0;
  const rows = await pool(targets, async (g) => {
    const r = await inspect(g);
    if (++done % 40 === 0) process.stdout.write(`  … ${done}/${targets.length}\n`);
    return r;
  }, 8);

  const by = { saves: [], opaque: [], stateless: [], unreachable: [] };
  rows.forEach((r) => by[r.status].push(r));

  const kinds = {};
  by.saves.forEach((r) => r.storage.forEach((s) => { kinds[s] = (kinds[s] || 0) + 1; }));

  console.log("\n=== results ===");
  console.log(`  saves progress        ${by.saves.length}`);
  console.log(`  can't tell (compiled) ${by.opaque.length}`);
  console.log(`  stores nothing        ${by.stateless.length}`);
  console.log(`  unreachable           ${by.unreachable.length}`);

  console.log("\n=== storage used ===");
  Object.entries(kinds).sort((a, b) => b[1] - a[1])
    .forEach(([k, n]) => {
      const covered = k === "localStorage" || k === "unity-fs";
      console.log(`  ${k.padEnd(16)} ${String(n).padStart(4)}   ` +
        (k === "localStorage" ? "bridge reads and writes this"
         : k === "sessionStorage" ? "dies with the tab; nothing to back up"
         : k === "indexedDB" ? "NOT covered by the bridge"
         : k === "cookie" ? "not covered; usually preferences, not saves"
         : "Unity writes into localStorage under IDBFS"));
      void covered;
    });

  const perHost = {};
  by.saves.forEach((r) => { perHost[r.host] = (perHost[r.host] || 0) + 1; });
  console.log("\n=== saving titles per host ===");
  Object.entries(perHost).forEach(([h, n]) => console.log(`  ${h.padEnd(12)} ${n}`));

  const idb = by.saves.filter((r) => r.storage.includes("indexedDB") &&
                                     !r.storage.includes("localStorage"));
  if (idb.length) {
    console.log("\n=== indexedDB only — the bridge cannot back these up ===");
    idb.slice(0, 15).forEach((r) => console.log("  " + r.id));
    if (idb.length > 15) console.log("  … and " + (idb.length - 15) + " more");
  }

  fs.writeFileSync(path.join(__dirname, "..", "data", "save-audit.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2) + "\n");
  console.log("\nwrote data/save-audit.json");
})();

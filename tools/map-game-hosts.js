/* Works out which repo serves each catalog entry, and reports what is left
 * unaccounted for.
 *
 *   node tools/map-game-hosts.js <dir-with-cloned-repos>
 *
 * The clones only need trees, not blobs:
 *   git clone --filter=blob:none --no-checkout --depth 1 <url> <name>
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const REPO_DIR = process.argv[2];
if (!REPO_DIR) {
  console.error("usage: node tools/map-game-hosts.js <dir-with-cloned-repos>");
  process.exit(1);
}

/* Catalog prefix → { repo, strip }. `strip` is removed from the front of the
   catalog path to get the path inside that repo. */
const MAP = [
  { prefix: "/games/huge/",      repo: "games-huge", strip: "/games/huge/" },
  { prefix: "/games-huge/",      repo: "games-huge", strip: "/games-huge/" },
  { prefix: "/games-swfgalaxy/", repo: "swfgalaxy",  strip: "/games-swfgalaxy/" },
  { prefix: "/games-flash/",     repo: "flashgames", strip: "/games-flash/" },
  { prefix: "/games/fnaf/",      repo: "hd_fnaf",    strip: "/games/fnaf/" }
];

function treeOf(repo) {
  const dir = path.join(REPO_DIR, repo);
  if (!fs.existsSync(dir)) return null;
  const out = execFileSync("git", ["-C", dir, "ls-tree", "-r", "--name-only", "HEAD"],
    { encoding: "utf8", maxBuffer: 1 << 28 });
  return new Set(out.split("\n").filter(Boolean));
}

const trees = {};
for (const repo of [...new Set(MAP.map((m) => m.repo))]) {
  trees[repo] = treeOf(repo);
  console.log(`${repo.padEnd(12)} ${trees[repo] ? trees[repo].size + " files" : "MISSING CLONE"}`);
}

const games = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "games.json"), "utf8"));

function normalise(p) {
  if (!p) return "";
  return p.startsWith("/") ? p : "/" + p;
}

/* Some entries point at a directory or an extensionless path; try the obvious
   variants before calling it missing. */
function variants(rel) {
  const out = [rel];
  if (!/\.[a-z0-9]+$/i.test(rel)) {
    out.push(rel + "/index.html", rel + ".html", rel + "/" + rel.split("/").pop() + ".html");
  }
  if (rel.endsWith("/")) out.push(rel + "index.html");

  /* A chunk of the catalog doubles the slug — "push-your-luck/push-your-luck/
     index.html" where the repo only has "push-your-luck/index.html". Collapse
     any immediately repeated path segment and try that too. */
  const collapsed = rel.replace(/(^|\/)([^/]+)\/\2(\/|$)/g, "$1$2$3");
  if (collapsed !== rel) out.push(collapsed, collapsed + "/index.html");

  return [...new Set(out)];
}

const resolved = [];
const missing = [];
const external = [];
const byRepo = {};

for (const game of games) {
  const src = normalise(game.source || game.direct || "");
  if (/^https?:/i.test(game.source || "") || /^\/https?:/i.test(src)) {
    external.push(game.id);
    continue;
  }

  const rule = MAP.find((m) => src.startsWith(m.prefix));
  if (!rule) { missing.push({ id: game.id, src, why: "no prefix rule" }); continue; }

  const tree = trees[rule.repo];
  if (!tree) { missing.push({ id: game.id, src, why: "clone missing" }); continue; }

  const rel = src.slice(rule.strip.length);
  const hit = variants(rel).find((v) => tree.has(v));

  if (hit) {
    resolved.push({ id: game.id, repo: rule.repo, rel: hit });
    byRepo[rule.repo] = (byRepo[rule.repo] || 0) + 1;
  } else {
    missing.push({ id: game.id, src, why: "not in " + rule.repo });
  }
}

console.log("\n=== coverage ===");
console.log(`resolved : ${resolved.length}/${games.length}`);
Object.entries(byRepo).sort((a, b) => b[1] - a[1])
  .forEach(([r, n]) => console.log(`  ${r.padEnd(12)} ${n}`));
console.log(`external : ${external.length}`);
console.log(`unmapped : ${missing.length}`);

const why = {};
missing.forEach((m) => { why[m.why] = (why[m.why] || 0) + 1; });
console.log("\n=== why unmapped ===");
Object.entries(why).forEach(([k, v]) => console.log(`  ${String(v).padStart(3)}  ${k}`));

console.log("\n=== unmapped sample ===");
missing.slice(0, 18).forEach((m) => console.log(`  ${m.id.padEnd(30)} ${m.src}`));

fs.writeFileSync(
  path.join(REPO_DIR, "resolution.json"),
  JSON.stringify({ resolved, missing, external }, null, 2)
);
console.log("\nwrote resolution.json");

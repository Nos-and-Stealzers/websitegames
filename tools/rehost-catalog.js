/* Rewrites data/games.json so every entry names which repo serves it and the
 * exact path inside that repo. Resolution happens once, here, against the real
 * git trees — the site then does no guessing at all.
 *
 *   node tools/rehost-catalog.js <dir-with-cloned-repos>
 *
 * Clone the trees first (no blobs, so it's quick even for 22k files):
 *   git clone --filter=blob:none --no-checkout --depth 1 <url> <name>
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const REPO_DIR = process.argv[2];
if (!REPO_DIR) {
  console.error("usage: node tools/rehost-catalog.js <dir-with-cloned-repos>");
  process.exit(1);
}

const MAP = [
  { prefix: "/games/huge/",      repo: "games-huge" },
  { prefix: "/games-huge/",      repo: "games-huge" },
  { prefix: "/games-swfgalaxy/", repo: "swfgalaxy"  },
  { prefix: "/games-flash/",     repo: "flashgames" },
  { prefix: "/games/fnaf/",      repo: "hd_fnaf"    }
];

const trees = {};
for (const repo of [...new Set(MAP.map((m) => m.repo))]) {
  const dir = path.join(REPO_DIR, repo);
  if (!fs.existsSync(dir)) { console.error("missing clone: " + repo); process.exit(1); }
  const out = execFileSync("git", ["-C", dir, "ls-tree", "-r", "--name-only", "HEAD"],
    { encoding: "utf8", maxBuffer: 1 << 28 });
  trees[repo] = new Set(out.split("\n").filter(Boolean));
}

function norm(p) {
  if (!p) return "";
  return p.startsWith("/") ? p : "/" + p;
}

function variants(rel) {
  const out = [rel];
  if (!/\.[a-z0-9]+$/i.test(rel)) {
    out.push(rel + "/index.html", rel + ".html", rel + "/" + rel.split("/").pop() + ".html");
  }
  if (rel.endsWith("/")) out.push(rel + "index.html");
  const collapsed = rel.replace(/(^|\/)([^/]+)\/\2(\/|$)/g, "$1$2$3");
  if (collapsed !== rel) out.push(collapsed, collapsed + "/index.html");
  return [...new Set(out)];
}

/* Returns { repo, path } or null. */
function resolve(raw) {
  const p = norm(raw);
  if (!p || /^\/?https?:/i.test(raw)) return null;

  const rule = MAP.find((m) => p.startsWith(m.prefix));
  if (!rule) return null;

  const rel = p.slice(rule.prefix.length);
  const hit = variants(rel).find((v) => trees[rule.repo].has(v));
  return hit ? { repo: rule.repo, path: hit } : null;
}

const games = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "games.json"), "utf8"));

let ok = 0, external = 0, lost = 0, icons = 0, iconsDropped = 0;
const byRepo = {};

for (const game of games) {
  /* Leave genuinely external titles alone. */
  if (/^https?:/i.test(game.source || "")) {
    game.host = "external";
    delete game.unavailable;
    external++;
    continue;
  }

  const src = resolve(game.source || game.direct);
  if (!src) {
    /* Keep the entry so the catalog still lists it, but say so plainly rather
       than handing the player a frame that will never load. */
    game.unavailable = true;
    delete game.host;
    delete game.icon;
    lost++;
    continue;
  }

  game.host = src.repo;
  game.source = src.path;
  game.direct = src.path;
  delete game.unavailable;
  byRepo[src.repo] = (byRepo[src.repo] || 0) + 1;
  ok++;

  /* Icons were harvested against the old domain; remap them the same way. */
  if (game.icon) {
    const ic = resolve(game.icon);
    if (ic && ic.repo === src.repo) { game.icon = ic.path; icons++; }
    else { delete game.icon; iconsDropped++; }
  }
  if (game.pfp) {
    const pf = resolve(game.pfp);
    if (pf && pf.repo === src.repo) game.pfp = pf.path;
    else delete game.pfp;
  }
}

fs.writeFileSync(path.join(ROOT, "data", "games.json"),
  JSON.stringify(games, null, 2) + "\n", "utf8");

console.log("=== rehosted ===");
console.log(`playable    : ${ok}/${games.length}`);
Object.entries(byRepo).sort((a, b) => b[1] - a[1])
  .forEach(([r, n]) => console.log(`  ${r.padEnd(12)} ${n}`));
console.log(`external    : ${external}`);
console.log(`unavailable : ${lost}`);
console.log(`icons kept  : ${icons}   (dropped ${iconsDropped})`);
console.log("\nWrote data/games.json — now run tools/build-sitemap.ps1");

/* Publishes the local Eaglercraft builds to their own GitHub repo and turns
 * on Pages.
 *
 * Its own repo on purpose: games-huge is already 3.7 GB, well past the 1 GB
 * Pages cap, so adding to it makes an existing problem worse. These three
 * builds total ~74 MB and sit comfortably in a fresh one.
 *
 *   node tools/publish-eaglercraft.js
 *
 * Uses git for the push rather than the contents API — one file is 31 MB,
 * which is far past what that API is meant for.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync, execFileSync } = require("child_process");

const OWNER = "LucasGrimm389";
const REPO = "eaglercraft";
const DOWNLOADS = path.join("c:", "\\", "Users", "lucas", "Downloads");

/* folder in Downloads -> folder in the repo */
const BUILDS = [
  ["eaglercraft-1.8.8-main/eaglercraft-1.8.8-main", "1.8.8"],
  ["EaglercraftX-1.12.2-u3-main/EaglercraftX-1.12.2-u3-main", "1.12.2"],
  ["Eaglercraft-26.1.2-main/Eaglercraft-26.1.2-main", "26.1.2"]
];

function token() {
  const out = execSync("git credential fill", {
    input: "protocol=https\nhost=github.com\n\n", encoding: "utf8"
  });
  return out.split("\n").find((l) => l.startsWith("password=")).slice(9).trim();
}

const TOK = token();
const H = {
  Authorization: "Bearer " + TOK,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "arcade-campus-hub",
  "Content-Type": "application/json"
};

async function gh(method, p, body) {
  const r = await fetch("https://api.github.com" + p, {
    method, headers: H, body: body ? JSON.stringify(body) : undefined
  });
  const t = await r.text();
  let d = null; if (t) { try { d = JSON.parse(t); } catch { d = t; } }
  return { status: r.status, data: d };
}

/* Copy a tree, skipping the junk macOS zips leave behind and anything git
   or CI related that would only confuse the deploy. */
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    /* .gitattributes matters here: the 26.1.2 download carries one routing
       .epk files through Git LFS. That account's LFS quota is spent, so the
       push fails outright. Dropping the file sends everything as ordinary
       git content instead. */
    if (entry.name === "__MACOSX" || entry.name === ".git" ||
        entry.name === ".github" || entry.name === ".gitattributes" ||
        entry.name.startsWith("._")) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

/* Eaglercraft 1.8.8 and 1.12.2 ship as one huge .html with no index name,
   so give each build a predictable entry point. */
function ensureIndex(dir) {
  const files = fs.readdirSync(dir);
  if (files.includes("index.html")) return "index.html";
  const html = files.find((f) => f.toLowerCase().endsWith(".html"));
  if (!html) return null;
  /* Rename rather than copy: these are 18-24 MB single-file builds, and
     copying doubled 1.12.2 to 48 MB in the repo for nothing. */
  fs.renameSync(path.join(dir, html), path.join(dir, "index.html"));
  return "index.html";
}

(async () => {
  const who = await gh("GET", "/user");
  console.log("authenticated as:", who.data && who.data.login);

  let repo = await gh("GET", `/repos/${OWNER}/${REPO}`);
  if (repo.status === 404) {
    console.log("creating " + OWNER + "/" + REPO + " …");
    repo = await gh("POST", "/user/repos", {
      name: REPO,
      description: "Eaglercraft builds served for Arcade Campus Hub",
      private: false,
      auto_init: false
    });
    if (repo.status !== 201) {
      console.error("could not create repo:", repo.status, JSON.stringify(repo.data).slice(0, 200));
      process.exit(1);
    }
  } else {
    console.log("repo already exists");
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "eagler-"));
  console.log("staging in", work);

  for (const [from, into] of BUILDS) {
    const src = path.join(DOWNLOADS, from.replace(/\//g, path.sep));
    if (!fs.existsSync(src)) { console.log("  MISSING " + from); continue; }
    const dst = path.join(work, into);
    copyTree(src, dst);
    const entry = ensureIndex(dst);
    const bytes = fs.readdirSync(dst).reduce((n, f) => {
      const s = fs.statSync(path.join(dst, f));
      return n + (s.isFile() ? s.size : 0);
    }, 0);
    console.log(`  ${into.padEnd(8)} -> ${entry}  (${(bytes / 1048576).toFixed(1)} MB)`);
  }

  /* The bridge is what lets game progress sync, and Eaglercraft keeps its
     worlds in IndexedDB — exactly what the bridge now covers. */
  fs.copyFileSync(path.join(__dirname, "save-bridge.html"),
                  path.join(work, "save-bridge.html"));

  fs.writeFileSync(path.join(work, "README.md"),
    "# Eaglercraft builds\n\n" +
    "Served for [Arcade Campus Hub](https://github.com/Nos-and-Stealzers/websitegames).\n\n" +
    "| Version | Path |\n| --- | --- |\n" +
    BUILDS.map(([, v]) => `| ${v} | \`/${v}/index.html\` |`).join("\n") +
    "\n\nWorlds are stored per version in the browser's IndexedDB and do **not**\n" +
    "carry between versions — 1.8.8 and 1.12.2 use different world formats.\n\n" +
    "`save-bridge.html` lets the hub back those worlds up to an account.\n");

  const git = (...a) => execFileSync("git", a, { cwd: work, stdio: "pipe", encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Nos-and-Stealzers");
  git("config", "user.email", "stealzers.com@gmail.com");
  git("add", "-A");
  git("commit", "-q", "-m",
      "Add Eaglercraft 1.8.8, 1.12.2 and 26.1.2\n\n" +
      "Each build gets its own folder and an index.html entry point.\n" +
      "save-bridge.html lets the hub back up worlds, which Eaglercraft\n" +
      "keeps in IndexedDB, per version.");
  git("remote", "add", "origin", `https://github.com/${OWNER}/${REPO}.git`);

  console.log("\npushing (~74 MB, this takes a moment) …");
  try {
    git("push", "-u", "origin", "main", "--force");
    console.log("pushed");
  } catch (e) {
    console.error("push failed:", String(e.stderr || e.message).slice(0, 300));
    process.exit(1);
  }

  const pages = await gh("GET", `/repos/${OWNER}/${REPO}/pages`);
  if (pages.status === 200) {
    console.log("pages already on ->", pages.data.html_url);
  } else {
    const made = await gh("POST", `/repos/${OWNER}/${REPO}/pages`,
      { source: { branch: "main", path: "/" } });
    console.log(made.status === 201
      ? "pages enabled -> " + (made.data.html_url || "(building)")
      : "pages: " + made.status + " " + String(made.data && made.data.message).slice(0, 80));
  }

  console.log(`\nhttps://${OWNER.toLowerCase()}.github.io/${REPO}/`);
})().catch((e) => { console.error(e.message); process.exit(1); });

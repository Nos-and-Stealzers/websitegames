/* Commits tools/save-bridge.html to the root of each game repo via the GitHub
   contents API. One additive file per repo; no existing file is touched. */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const BRIDGE = fs.readFileSync(path.join(ROOT, "tools", "save-bridge.html"), "utf8");
const B64 = Buffer.from(BRIDGE, "utf8").toString("base64");

/* Every repo named in SITE.gameHosts needs the bridge, or the games it serves
   are invisible to backup, restore and the save editor. */
const REPOS = [
  ["LucasGrimm389", "games-huge"],
  ["LucasGrimm389", "flashgames"],
  ["LucasGrimm389", "hd_fnaf"],
  ["LucasGrimm389", "eaglercraft"],
  ["Nos-and-Stealzers", "swfgalaxy"]
];

const TOK = execSync("git credential fill", {
  input: "protocol=https\nhost=github.com\n\n", encoding: "utf8"
}).split("\n").find((l) => l.startsWith("password=")).slice(9).trim();

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

(async () => {
  for (const [owner, repo] of REPOS) {
    const label = (owner + "/" + repo).padEnd(32);
    const info = await gh("GET", `/repos/${owner}/${repo}`);
    if (info.status !== 200) { console.log(label + "unreadable"); continue; }
    const branch = info.data.default_branch;

    /* If it's already there and identical, leave it alone. */
    const existing = await gh("GET", `/repos/${owner}/${repo}/contents/save-bridge.html?ref=${branch}`);
    let sha;
    if (existing.status === 200) {
      const current = Buffer.from(existing.data.content, "base64").toString("utf8");
      if (current === BRIDGE) { console.log(label + "already current"); continue; }
      sha = existing.data.sha;
    }

    const put = await gh("PUT", `/repos/${owner}/${repo}/contents/save-bridge.html`, {
      message: sha
        ? "Update Arcade Campus Hub save bridge"
        : "Add Arcade Campus Hub save bridge\n\nLets the hub back up and restore this origin's game\nprogress over postMessage. Additive; nothing else touched.",
      content: B64,
      branch,
      sha
    });

    if (put.status === 200 || put.status === 201) {
      console.log(label + (sha ? "updated" : "added") + " on " + branch);
    } else {
      console.log(label + "failed " + put.status + " " +
        String(put.data && put.data.message).slice(0, 70));
    }
  }
  console.log("\nPages will rebuild; the bridge answers once that finishes.");
})().catch((e) => { console.error(e.message); process.exit(1); });

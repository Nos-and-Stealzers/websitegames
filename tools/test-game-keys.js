/* Per-game key attribution.
 *
 * A host serves up to 145 games into one shared localStorage, so telling one
 * game's keys from the rest is the whole problem. This covers both halves of
 * the answer: watching what changes while a game is open, and guessing from
 * key names before anything has been watched.
 *
 *   node tools/test-game-keys.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");

let passed = 0;
const failures = [];
function ok(label, cond, extra) {
  if (cond) { passed++; console.log("  ok   " + label + (extra ? "   " + extra : "")); }
  else { failures.push(label); console.log("  FAIL " + label + (extra ? "   " + extra : "")); }
}

function sandbox() {
  const stored = {};
  const box = { console };
  box.window = box;
  box.localStorage = {
    getItem: (k) => (k in stored ? stored[k] : null),
    setItem: (k, v) => { stored[k] = String(v); },
    removeItem: (k) => { delete stored[k]; }
  };
  vm.createContext(box);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "js", "game-keys.js"), "utf8"),
                  box, { filename: "game-keys.js" });
  box._stored = stored;
  return box;
}

const BITLIFE = {
  id: "huge-bitlife", title: "BitLife", host: "games-huge",
  source: "bitlife/index.html"
};
const SNOW = {
  id: "snow-rider", title: "Snow Rider 3D", host: "games-huge",
  source: "snowrider3d/index.html"
};

console.log("watching what changes while a game is open");
{
  const b = sandbox();
  const before = { "bitlife_save": "1", "unrelated": "x", "snow_best": "10" };
  const after = { "bitlife_save": "2", "unrelated": "x", "snow_best": "10", "bl_money": "500" };

  const added = b.GameKeys.learnFromSnapshots(BITLIFE, "games-huge", before, after);
  ok("only the changed keys are attributed", added === 2, String(added));

  const owned = b.GameKeys.forGame(BITLIFE, after);
  ok("a value that moved counts", owned.watched.indexOf("bitlife_save") !== -1);
  ok("a key that appeared counts", owned.watched.indexOf("bl_money") !== -1);
  ok("an untouched key is not claimed", owned.watched.indexOf("unrelated") === -1);
  ok("another game's key is not claimed", owned.watched.indexOf("snow_best") === -1);
}

console.log("\nlearning is additive across sessions");
{
  const b = sandbox();
  b.GameKeys.learnFromSnapshots(BITLIFE, "games-huge", {}, { a: "1" });
  b.GameKeys.learnFromSnapshots(BITLIFE, "games-huge", { a: "1" }, { a: "1", z: "9" });

  const owned = b.GameKeys.forGame(BITLIFE, { a: "1", z: "9" });
  ok("keys from two sessions are both kept",
     owned.watched.length === 2, owned.watched.join(","));

  const again = b.GameKeys.learnFromSnapshots(BITLIFE, "games-huge", { a: "1" }, { a: "1" });
  ok("re-learning the same key does not duplicate it", again === 0);
}

console.log("\nguessing from the key name, before anything is watched");
{
  const b = sandbox();
  const present = {
    "bitlife_progress": "1",
    "BitLifeCash": "9",
    "snowrider3d.best": "3",
    "cfg": "x",
    "user_settings": "y"
  };

  const owned = b.GameKeys.forGame(BITLIFE, present);
  ok("a key carrying the id is guessed", owned.guessed.indexOf("bitlife_progress") !== -1,
     owned.guessed.join(","));
  ok("matching ignores case and punctuation", owned.guessed.indexOf("BitLifeCash") !== -1);
  ok("another game's key is not guessed", owned.guessed.indexOf("snowrider3d.best") === -1);
  ok("a generic key is not guessed", owned.guessed.indexOf("cfg") === -1);

  const snow = b.GameKeys.forGame(SNOW, present);
  ok("the folder name is matched too", snow.guessed.indexOf("snowrider3d.best") !== -1,
     snow.guessed.join(","));
}

console.log("\nwatched beats guessed");
{
  const b = sandbox();
  const present = { "bitlife_save": "1" };
  b.GameKeys.learnFromSnapshots(BITLIFE, "games-huge", {}, present);

  const owned = b.GameKeys.forGame(BITLIFE, present);
  ok("a watched key is not repeated as a guess",
     owned.watched.length === 1 && owned.guessed.length === 0,
     "watched=" + owned.watched.length + " guessed=" + owned.guessed.length);
}

console.log("\nkeys that have since gone away");
{
  const b = sandbox();
  b.GameKeys.learnFromSnapshots(BITLIFE, "games-huge", {}, { gone: "1", here: "2" });

  const owned = b.GameKeys.forGame(BITLIFE, { here: "2" });
  ok("a key no longer in storage is not offered",
     owned.watched.length === 1 && owned.watched[0] === "here",
     owned.watched.join(","));
}

console.log("\nshort and generic tokens are refused");
{
  const b = sandbox();
  /* A three-letter id would match half the keys on a shared host. */
  const tiny = { id: "io", title: "IO", host: "games-huge", source: "io/index.html" };
  const tokens = b.GameKeys.tokensFor(tiny);
  ok("tokens under four characters are dropped",
     tokens.every((t) => t.length >= 4), tokens.join(","));

  const owned = b.GameKeys.forGame(tiny, { "audio_volume": "1", "region": "eu" });
  ok("so nothing is falsely claimed", owned.guessed.length === 0, owned.guessed.join(","));
}

console.log("\nstorage hygiene");
{
  const b = sandbox();
  b.GameKeys.learnFromSnapshots(BITLIFE, "games-huge", {}, { a: "1" });
  ok("attribution is written to one namespaced key",
     Object.keys(b._stored).length === 1 && "ach:gamekeys" in b._stored,
     Object.keys(b._stored).join(","));

  b.GameKeys.forget(BITLIFE.id);
  ok("forget removes it", b.GameKeys.forGame(BITLIFE, { a: "1" }).watched.length === 0);

  const empty = sandbox();
  ok("an unknown game reads as empty rather than throwing",
     empty.GameKeys.forGame(SNOW, {}).watched.length === 0);
  ok("a missing game argument is tolerated",
     empty.GameKeys.forGame(null, {}).watched.length === 0);
}

console.log("\n" + "=".repeat(52));
if (failures.length) {
  console.log(failures.length + " FAILED of " + (passed + failures.length));
  failures.forEach((f) => console.log("  · " + f));
  process.exitCode = 1;
} else {
  console.log("All " + passed + " attribution checks passed.");
}

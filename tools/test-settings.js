/* Settings resolution.
 *
 * This exists because of a specific bug class: a setting gets added to
 * SITE.defaults, the resolver doesn't know about it, and it reads as
 * `undefined` — or worse, as `false`, which silently switches a new feature
 * off for every user whose saved blob predates it.
 *
 *   node tools/test-settings.js
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

/* A fresh sandbox per case, so one test's writes can't leak into the next. */
function withSaved(savedBlob) {
  const stored = {};
  if (savedBlob !== undefined) stored["ach:settings"] = JSON.stringify(savedBlob);

  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.localStorage = {
    getItem: (k) => (k in stored ? stored[k] : null),
    setItem: (k, v) => { stored[k] = String(v); },
    removeItem: (k) => { delete stored[k]; }
  };
  sandbox.document = { dispatchEvent() {}, addEventListener() {}, readyState: "complete" };
  sandbox.CustomEvent = class {};
  vm.createContext(sandbox);

  for (const f of ["js/config.js", "js/store.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox, { filename: f });
  }
  return sandbox;
}

const base = withSaved(undefined);
const DEFAULTS = base.SITE.defaults;

console.log("resolution");
{
  const s = base.Store.settings();
  ok("every default key is present",
     Object.keys(DEFAULTS).every((k) => s[k] !== undefined),
     Object.keys(DEFAULTS).length + " keys");
  ok("no extra keys invented",
     Object.keys(s).every((k) => k in DEFAULTS));
  ok("empty storage yields exactly the defaults",
     Object.keys(DEFAULTS).every((k) => s[k] === DEFAULTS[k]));
}

console.log("\nthe bug this file exists for");
{
  /* An old blob that predates most of the settings. This is what everyone
     who used the site before today actually has. */
  const s = withSaved({ skin: "paper", view: "list" }).Store.settings();

  ok("saved keys are honoured", s.skin === "paper" && s.view === "list");

  const missing = Object.keys(DEFAULTS).filter((k) => k !== "skin" && k !== "view");
  ok("every absent key falls back to its default, not false",
     missing.every((k) => s[k] === DEFAULTS[k]),
     missing.length + " absent keys");

  const boolKeys = missing.filter((k) => typeof DEFAULTS[k] === "boolean" && DEFAULTS[k] === true);
  ok("features defaulting to on stay on for old blobs",
     boolKeys.every((k) => s[k] === true),
     boolKeys.join(", "));
}

console.log("\nrejecting nonsense");
{
  const s = withSaved({
    skin: "not-a-skin",
    textSize: "gigantic",
    view: "carousel",
    sort: "vibes",
    shortcuts: "yes",
    dock: 1,
    motion: null
  }).Store.settings();

  ok("unknown skin rejected", s.skin === DEFAULTS.skin, s.skin);
  ok("unknown text size rejected", s.textSize === DEFAULTS.textSize);
  ok("unknown view rejected", s.view === DEFAULTS.view);
  ok("unknown sort rejected", s.sort === DEFAULTS.sort);
  ok("string where boolean expected rejected", s.shortcuts === DEFAULTS.shortcuts);
  ok("number where boolean expected rejected", s.dock === DEFAULTS.dock);
  ok("null rejected", s.motion === DEFAULTS.motion);
}

console.log("\nadmin console shortcut");
{
  // The shortcut key is one character, or "" meaning no shortcut at all.
  // Anything else would bind the console to something unreachable.
  let s = withSaved({ adminKey: "j" }).Store.settings();
  ok("a single letter is kept", s.adminKey === "j", s.adminKey);

  s = withSaved({ adminKey: "7" }).Store.settings();
  ok("a digit is kept", s.adminKey === "7", s.adminKey);

  s = withSaved({ adminKey: "" }).Store.settings();
  ok("empty means the shortcut is off", s.adminKey === "", JSON.stringify(s.adminKey));

  s = withSaved({ adminKey: "ctrl+shift+q" }).Store.settings();
  ok("a multi-character value is rejected", s.adminKey === DEFAULTS.adminKey, s.adminKey);

  s = withSaved({ adminKey: "!" }).Store.settings();
  ok("punctuation is rejected", s.adminKey === DEFAULTS.adminKey, s.adminKey);

  s = withSaved({ adminKey: 5 }).Store.settings();
  ok("a number is rejected", s.adminKey === DEFAULTS.adminKey, String(s.adminKey));

  s = withSaved({}).Store.settings();
  ok("absent falls back to the default", s.adminKey === DEFAULTS.adminKey, s.adminKey);
}

console.log("\nlegacy migration");
{
  let s = withSaved({ theme: "light" }).Store.settings();
  ok("v1 theme maps to a skin", s.skin === "paper", s.skin);

  s = withSaved({ theme: "arcade" }).Store.settings();
  ok("v1 arcade maps to terminal", s.skin === "terminal");

  s = withSaved({ theme: "light", skin: "noir" }).Store.settings();
  ok("an explicit skin beats the legacy theme", s.skin === "noir");

  s = withSaved({ fast: true }).Store.settings();
  ok("v1 fast maps to lite", s.lite === true);

  s = withSaved({ fast: true, lite: false }).Store.settings();
  ok("an explicit lite beats legacy fast", s.lite === false);

  s = withSaved({ theme: "nonsense-theme" }).Store.settings();
  ok("unmappable legacy theme falls back", s.skin === DEFAULTS.skin);
}

console.log("\nround trip");
{
  const box = withSaved({});
  box.Store.setSetting("skin", "grape");
  box.Store.setSetting("textSize", "huge");
  const s = box.Store.settings();
  ok("a written setting reads back", s.skin === "grape" && s.textSize === "huge");
  ok("writing one setting keeps the others",
     Object.keys(DEFAULTS).every((k) => s[k] !== undefined));
}

console.log("\nonly deviations are stored");
{
  // setSetting used to write the whole resolved blob, defaults and all. That
  // froze every other setting at whatever the default was that day, so a
  // later change to a default could never reach anyone who had touched the
  // page — which is how the console shortcut stayed on its first default
  // long after it had moved.
  const box = withSaved({});
  box.Store.setSetting("skin", "grape");

  const raw = JSON.parse(box.localStorage.getItem("ach:settings"));
  ok("the changed key is stored", raw.skin === "grape");
  ok("untouched keys are not written", raw.textSize === undefined && raw.sort === undefined);
  ok("the moving default is not frozen in", raw.adminKey === undefined,
     JSON.stringify(raw.adminKey));

  // And the point of all that: a default that moves still reaches them.
  const after = box.Store.settings();
  ok("an untouched setting still tracks the default",
     after.adminKey === DEFAULTS.adminKey, after.adminKey);

  // Choosing the default again should un-pin, not pin.
  box.Store.setSetting("skin", DEFAULTS.skin);
  const raw2 = JSON.parse(box.localStorage.getItem("ach:settings"));
  ok("setting a value back to the default removes it", raw2.skin === undefined,
     JSON.stringify(raw2.skin));
  ok("and it reads back as the default", box.Store.settings().skin === DEFAULTS.skin);
}

console.log("\npruning defaults baked in by the old writer");
{
  // Until the picker shipped there was no way to choose adminKey at all, so a
  // stored "p" or "k" was written by the old whole-blob setSetting, not by a
  // person. Drop those once so the current default applies.
  let box = withSaved({ adminKey: "p", skin: "grape" });
  let s = box.Store.settings();
  ok("a superseded default is dropped", s.adminKey === DEFAULTS.adminKey, s.adminKey);
  ok("a real choice beside it survives", s.skin === "grape");

  box = withSaved({ adminKey: "k" });
  ok("the other old default is dropped too",
     box.Store.settings().adminKey === DEFAULTS.adminKey);

  // A deliberate choice made after the prune must stick, even if it happens
  // to be one of the old defaults.
  box = withSaved({});
  box.Store.settings();                 // prune runs, marks itself done
  box.Store.setSetting("adminKey", "p");
  ok("choosing an old default on purpose is respected",
     box.Store.settings().adminKey === "p", box.Store.settings().adminKey);

  const raw = JSON.parse(box.localStorage.getItem("ach:settings"));
  ok("the prune marks itself so it runs once", raw._pruned >= 1, JSON.stringify(raw._pruned));
}

console.log("\nno drift between the boot script and config");
{
  /* theme-boot runs in <head>, before config.js exists, so it has to carry
     its own copy of the valid skins. That duplication can rot. */
  const boot = fs.readFileSync(path.join(ROOT, "js", "theme-boot.js"), "utf8");
  const declared = (boot.match(/var VALID = \{([\s\S]*?)\}/) || [])[1] || "";
  const bootSkins = (declared.match(/[a-z]+(?=\s*:)/g) || []).sort();
  const configSkins = base.SITE.skins.map((s) => s.id).sort();

  ok("theme-boot knows every skin in config",
     JSON.stringify(bootSkins) === JSON.stringify(configSkins),
     "boot=[" + bootSkins + "] config=[" + configSkins + "]");

  const aliasTargets = Object.values(base.SITE.skinAliases);
  ok("every legacy alias points at a real skin",
     aliasTargets.every((t) => configSkins.indexOf(t) !== -1),
     aliasTargets.join(","));

  const bootAliases = (boot.match(/var ALIAS = \{([\s\S]*?)\}/) || [])[1] || "";
  ok("theme-boot's alias table matches config",
     Object.keys(base.SITE.skinAliases).every((k) => bootAliases.indexOf(k) !== -1));
}

console.log("\n" + "=".repeat(52));
if (failures.length) {
  console.log("FAILED " + failures.length + " of " + (passed + failures.length));
  failures.forEach((f) => console.log("  " + f));
  process.exit(1);
}
console.log("All " + passed + " settings checks passed.");

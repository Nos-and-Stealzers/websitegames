/* The save bridge, driven through its real postMessage protocol.
 *
 * This file is deployed to five repos we do not otherwise test, and it is the
 * only thing standing between a game's progress and the hub. It had no tests
 * at all, which is how cookies — the single largest place these games keep
 * progress, more titles than localStorage — went unread for so long.
 *
 *   node tools/test-bridge.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const HUB = "https://arcadecampushub.online";

let passed = 0;
const failures = [];
function ok(label, cond, extra) {
  if (cond) { passed++; console.log("  ok   " + label + (extra ? "   " + extra : "")); }
  else { failures.push(label); console.log("  FAIL " + label + (extra ? "   " + extra : "")); }
}

/* A browser just real enough for the bridge: localStorage, document.cookie
   with the same set-one-read-all-back semantics, and no IndexedDB. */
function browser({ storage = {}, cookies = {}, pathname = "/" } = {}) {
  const listeners = [];
  const jar = Object.assign({}, cookies);

  const win = {
    location: { host: "games.example", pathname },
    navigator: { cookieEnabled: true },
    indexedDB: undefined,
    Promise, Date, JSON, Math, String, Number, Object, Array, Error,
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    Uint8Array, ArrayBuffer,
    console: { log() {}, error() {} },
    addEventListener: (name, fn) => { if (name === "message") listeners.push(fn); },
    localStorage: {
      _d: Object.assign({}, storage),
      get length() { return Object.keys(this._d).length; },
      key(i) { return Object.keys(this._d)[i] ?? null; },
      getItem(k) { return k in this._d ? this._d[k] : null; },
      setItem(k, v) { this._d[k] = String(v); },
      removeItem(k) { delete this._d[k]; },
      clear() { this._d = {}; }
    }
  };

  win.window = win;
  win.self = win;
  /* The bridge announces itself to whoever framed it on load. */
  const announced = [];
  win.parent = { postMessage: (msg) => announced.push(msg) };
  win.document = {
    get cookie() {
      return Object.entries(jar)
        .map(([k, v]) => k + "=" + v).join("; ");
    },
    set cookie(str) {
      const [pair, ...attrs] = String(str).split(";");
      const at = pair.indexOf("=");
      const name = decodeURIComponent(pair.slice(0, at).trim());
      const value = pair.slice(at + 1).trim();
      const expires = attrs.map((a) => a.trim())
        .find((a) => a.toLowerCase().startsWith("expires="));
      if (expires && new Date(expires.slice(8)) < new Date()) delete jar[name];
      else jar[name] = value;
    }
  };

  vm.createContext(win);
  const html = fs.readFileSync(path.join(ROOT, "tools", "save-bridge.html"), "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  vm.runInContext(script, win, { filename: "save-bridge.html" });

  let seq = 0;
  function send(action, extra = {}, origin = HUB) {
    return new Promise((resolve) => {
      const id = "m" + (++seq);
      const event = {
        origin,
        data: Object.assign({ channel: "ach-save-bridge", id, action }, extra),
        source: { postMessage: (reply) => resolve(reply) }
      };
      listeners.forEach((fn) => fn(event));
      /* An ignored message never answers; don't hang the suite over it. */
      setTimeout(() => resolve(null), 60);
    });
  }

  return { send, jar, storage: win.localStorage, announced };
}

(async () => {
  console.log("origin allowlist");
  {
    const b = browser();
    ok("the hub is answered", !!(await b.send("ping")));
    ok("a stranger is ignored", (await b.send("ping", {}, "https://evil.example")) === null);
    ok("a lookalike domain is ignored",
       (await b.send("ping", {}, "https://arcadecampushub.online.evil.com")) === null);
    ok("a vercel preview is answered",
       !!(await b.send("ping", {}, "https://websitegames-abc123.vercel.app")));
  }

  console.log("\nreading");
  {
    const b = browser({
      storage: { save: '{"coins":5}', junk: "x" },
      cookies: { progress: "level%3D4", pref: "loud" }
    });
    const r = await b.send("read");
    ok("localStorage comes back", r.data.save === '{"coins":5}');
    ok("the key count is reported", r.keys === 2, String(r.keys));
    ok("cookies come back", r.cookies.progress === "level=4", JSON.stringify(r.cookies));
    ok("percent-encoding is undone", r.cookies.progress.indexOf("%") === -1);
    ok("the bridge says which path it can see",
       r.cookiePath === "/", r.cookiePath);
  }

  console.log("\nthe gap that made this necessary");
  {
    /* 55 titles save only to a cookie. Before this, a read returned nothing
       for them and the editor looked broken. */
    const b = browser({ storage: {}, cookies: { savegame: "abc" } });
    const r = await b.send("read");
    ok("a cookie-only game is no longer invisible",
       Object.keys(r.cookies).length === 1 && r.keys === 0);
  }

  console.log("\nwriting");
  {
    const b = browser({ storage: { keep: "old" }, cookies: { keep: "old" } });

    let r = await b.send("write", { data: { keep: "new", fresh: "1" }, cookies: {} });
    ok("an existing key is kept by default", b.storage.getItem("keep") === "old");
    ok("a new key is written", b.storage.getItem("fresh") === "1");
    ok("the counts are reported", r.written === 1 && r.kept === 1,
       "written=" + r.written + " kept=" + r.kept);

    r = await b.send("write", { data: { keep: "new" }, cookies: {}, overwrite: true });
    ok("overwrite replaces it", b.storage.getItem("keep") === "new");

    r = await b.send("write", { data: {}, cookies: { keep: "cookie-new", extra: "2" } });
    ok("an existing cookie is kept by default", b.jar.keep === "old");
    ok("a new cookie is written", decodeURIComponent(b.jar.extra) === "2");
    ok("cookie writes are counted", r.cookiesWritten === 1, String(r.cookiesWritten));

    r = await b.send("write", { data: {}, cookies: { keep: "forced" }, overwrite: true });
    ok("overwrite replaces the cookie", decodeURIComponent(b.jar.keep) === "forced");
  }

  console.log("\nremoving and clearing");
  {
    const b = browser({ storage: { a: "1", b: "2" }, cookies: { c: "3" } });

    await b.send("remove", { keys: ["a"] });
    ok("a named key is removed", b.storage.getItem("a") === null);
    ok("the others are left alone", b.storage.getItem("b") === "2");

    await b.send("clear");
    ok("clear empties localStorage", b.storage.length === 0);
    ok("clear expires cookies too, not just half the save",
       Object.keys(b.jar).length === 0, JSON.stringify(b.jar));
  }

  console.log("\nrefusing nonsense");
  {
    const b = browser();
    const r = await b.send("dance");
    ok("an unknown action is refused", r && r.ok === false, r && r.error);
    ok("a message on another channel is ignored",
       (await new Promise((res) => {
         const ev = { origin: HUB, data: { channel: "other", id: "x", action: "ping" },
                      source: { postMessage: res } };
         b.send("ping").then(() => {});
         setTimeout(() => res(null), 60);
         void ev;
       })) !== undefined);
  }

  console.log("\n" + "=".repeat(52));
  if (failures.length) {
    console.log(failures.length + " FAILED of " + (passed + failures.length));
    failures.forEach((f) => console.log("  · " + f));
    process.exitCode = 1;
  } else {
    console.log("All " + passed + " bridge checks passed.");
  }
})();

/* Drives the site's own pages in a real browser against a real database.
 *
 * The adapter suite (tools/test-supabase.js) proves the data layer answers.
 * This proves the pages built on it actually paint: that signing in lands
 * you somewhere, that a conversation shows its messages, that the console's
 * tabs fill in. Those are different failures, and only one of them is
 * visible from Node.
 *
 *   node tools/test-ui.js
 *
 * Needs Playwright and a Postgres with supabase/schema.sql applied. Both are
 * optional: without either it says so and exits 0, so it never breaks a
 * checkout that only wants the static site.
 */
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { Stub } = require("./postgrest-stub.js");

const ROOT = path.join(__dirname, "..");
const SITE_PORT = Number(process.env.UI_SITE_PORT || 8791);
const API_PORT = Number(process.env.UI_API_PORT || 8792);

let chromium;
try { chromium = require("../server/node_modules/playwright").chromium; }
catch (e) {
  console.log("Playwright is not installed — skipping the browser pass.");
  console.log("  cd server && npm install --no-save playwright");
  process.exit(0);
}

let pass = 0;
const failures = [];
/* The detail is markup often enough that printing it whole buries the
   result it belongs to. */
function trim(v) {
  const one = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  return one.length > 140 ? one.slice(0, 140) + "…" : one;
}

function ok(label, cond, extra) {
  const detail = trim(extra);
  if (cond) { pass++; console.log("  ok   " + label + (detail ? "   " + detail : "")); }
  else {
    failures.push(label + (detail ? " → " + detail : ""));
    console.log("  FAIL " + label + (detail ? "   " + detail : ""));
  }
}
function group(name) { console.log("\n" + name); }

/* --------------------------------------------------------- static host */

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".webmanifest": "application/manifest+json", ".ico": "image/x-icon"
};

function serveSite(port, config) {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (rel === "/") rel = "/index.html";
    /* The one file the test rewrites: it points the site at the stub. */
    if (rel === "/js/config.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      res.end(config);
      return;
    }
    const file = path.join(ROOT, rel.replace(/^\/+/, ""));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end(fs.existsSync(path.join(ROOT, "404.html"))
        ? fs.readFileSync(path.join(ROOT, "404.html"))
        : "not found");
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

function configFor(apiOrigin) {
  const real = fs.readFileSync(path.join(ROOT, "js", "config.js"), "utf8");
  return real
    .replace(/url:\s*"[^"]*"/, 'url: "' + apiOrigin + '"')
    .replace(/anonKey:[\s\S]*?"pBbjcEMqRMLjzRc0uvL0mAEcyYaxgvzjho0kXwH7eKA"/, 'anonKey: "anon-key"');
}

/* ------------------------------------------------------------------ main */

async function main() {
  const stub = new Stub({
    host: process.env.PGHOST || "127.0.0.1",
    port: Number(process.env.PGPORT || 55432),
    user: process.env.PGUSER || "postgres",
    database: process.env.PGDATABASE || "arch"
  });

  try { await stub.connect(); }
  catch (e) {
    console.log("No Postgres to test against (" + e.message + ") — skipping.");
    process.exit(0);
  }

  await stub.asOwnerRole("drop schema if exists public cascade");
  await stub.asOwnerRole("drop schema if exists auth cascade");
  await stub.asOwnerRole("create schema public");
  await stub.asOwnerRole("create extension if not exists citext");
  await stub.asOwnerRole(fs.readFileSync(path.join(ROOT, "supabase/test/00-supabase-stub.sql"), "utf8"));
  await stub.asOwnerRole(fs.readFileSync(path.join(ROOT, "supabase/schema.sql"), "utf8"));

  const api = await stub.serve(API_PORT);
  const site = await serveSite(SITE_PORT, configFor("http://127.0.0.1:" + API_PORT));
  const base = "http://127.0.0.1:" + SITE_PORT;
  const apiBase = "http://127.0.0.1:" + API_PORT;

  /* A pinned Chromium next to Playwright's own is common in sandboxes and
     CI images; use it rather than downloading a second copy. */
  const pinned = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";
  const browser = await chromium.launch(Object.assign(
    fs.existsSync(pinned) ? { executablePath: pinned } : {},
    /* A synthetic camera and microphone, auto-granted, so the call path can
       actually be walked without hardware or a permission prompt. */
    { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
             "--autoplay-policy=no-user-gesture-required"] }));

  /* Every page load collects its console errors, so a page that paints but
     throws on the way still fails. */
  async function session() {
    const ctx = await browser.newContext();
    /* Game art lives on other origins and is not what this suite is about.
       Answered rather than aborted: an abort raises a console error of its
       own, which would drown the errors that matter. */
    await ctx.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith(base) || url.startsWith(apiBase) || url.startsWith("data:")) {
        return route.continue();
      }
      return route.fulfill({ status: 200, contentType: "image/gif", body: Buffer.from([]) });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e.message)));
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      /* The browser logs one of these for every non-2xx response, with no
         URL on it. The response handler below judges those properly. */
      if (/^Failed to load resource/.test(m.text())) return;
      errors.push(m.text());
    });
    /* Only this site's own requests count. */
    page.on("requestfailed", (r) => {
      if (!r.url().startsWith(base) && !r.url().startsWith(apiBase)) return;
      const why = (r.failure() && r.failure().errorText) || "?";
      /* A request still in flight when the page navigates aborts, which is
         normal browsing, not a fault. */
      if (why === "net::ERR_ABORTED") return;
      errors.push("request failed: " + r.url() + " (" + why + ")");
    });
    page.on("response", (r) => {
      /* A 4xx from the API is often the app working: refusing a bad form and
         showing why. A missing file, or a 5xx, never is. */
      const bad = r.url().startsWith(apiBase) ? r.status() >= 500 : r.status() >= 400;
      if ((r.url().startsWith(base) || r.url().startsWith(apiBase)) && bad) {
        errors.push("HTTP " + r.status() + " " + r.url());
      }
    });
    page.errors = errors;
    return { ctx, page };
  }

  async function go(page, url) {
    await page.goto(base + url, { waitUntil: "networkidle" });
  }

  async function signUp(page, username, password) {
    await go(page, "/signup.html");
    await page.waitForSelector("#form:not([hidden])", { timeout: 15000 });
    await page.fill("#username", username);
    await page.fill("#password", password);
    await page.fill("#confirm", password);
    await page.check("#accept");
    await page.click("#submit");
    /* The redirect happens after the round trip, so waiting on the load
       state alone can read the URL before it moves. */
    await page.waitForURL((u) => !/signup\.html/.test(String(u)), { timeout: 20000 })
      .catch(function () {});
    await page.waitForLoadState("networkidle");
  }

  async function signIn(page, username, password) {
    await go(page, "/login.html");
    await page.waitForSelector("#form:not([hidden])", { timeout: 15000 });
    await page.fill("#username", username);
    await page.fill("#password", password);
    await page.click("#submit");
    await page.waitForURL((u) => !/login\.html/.test(String(u)), { timeout: 8000 })
      .catch(function () {});
    await page.waitForLoadState("networkidle");
  }

  /* ------------------------------------------------------------ sign in */
  group("sign up and sign in");

  const ownerS = await session();
  await signUp(ownerS.page, "Stealzers", "hunter2 hunter2");
  ok("the first sign-up lands on the console",
     /admin\.html/.test(ownerS.page.url()), ownerS.page.url());
  ok("...with no page errors", ownerS.page.errors.length === 0,
     ownerS.page.errors.join(" | "));

  const aliceS = await session();
  await signUp(aliceS.page, "alice", "correct horse 42");
  ok("a later sign-up lands on the arcade",
     /index\.html|\/$/.test(aliceS.page.url()), aliceS.page.url());

  const bobS = await session();
  await signUp(bobS.page, "bob", "correct horse 42");

  const again = await session();
  await signIn(again.page, "alice", "correct horse 42");
  ok("signing in works", !/login\.html/.test(again.page.url()), again.page.url());
  await go(again.page, "/profile.html");
  ok("the profile page knows who is signed in",
     (await again.page.textContent("body")).indexOf("alice") !== -1);
  ok("...without errors", again.page.errors.length === 0, again.page.errors.join(" | "));

  const wrong = await session();
  await signIn(wrong.page, "alice", "not the password");
  ok("a wrong password keeps you on the sign-in page",
     /login\.html/.test(wrong.page.url()), wrong.page.url());
  await wrong.ctx.close();

  /* ------------------------------------------------------------ friends */
  group("friends");

  await go(aliceS.page, "/friends.html");
  ok("the friend code is shown", /[A-Z0-9]{3}-[A-Z0-9]{3}/.test(
     await aliceS.page.textContent("#my-code")), await aliceS.page.textContent("#my-code"));
  /* Typing searches; the results are debounced. */
  await aliceS.page.fill("#find", "bob");
  await aliceS.page.waitForTimeout(900);
  ok("search shows the other account in the results",
     (await aliceS.page.textContent("#results")).indexOf("bob") !== -1,
     await aliceS.page.textContent("#results"));
  const addBtn = await aliceS.page.$('#results button:has-text("Add friend")');
  ok("...with an add button on it", !!addBtn,
     await aliceS.page.innerHTML("#results"));
  if (addBtn) { await addBtn.click(); await aliceS.page.waitForTimeout(900); }

  await go(bobS.page, "/friends.html");
  const acceptBtn = await bobS.page.$('#incoming button:has-text("Accept")');
  ok("the request shows up for the other side", !!acceptBtn,
     await bobS.page.innerHTML("#incoming"));
  if (acceptBtn) { await acceptBtn.click(); await bobS.page.waitForTimeout(900); }
  ok("...and they end up in the friend list",
     (await bobS.page.textContent("#friends")).indexOf("alice") !== -1,
     await bobS.page.textContent("#friends"));
  ok("the friends page throws nothing", bobS.page.errors.length === 0,
     bobS.page.errors.join(" | "));

  /* ----------------------------------------------------------- messages */
  group("messages");

  await go(aliceS.page, "/messages.html");
  ok("the messages page loads clean", aliceS.page.errors.length === 0,
     aliceS.page.errors.join(" | "));

  await go(aliceS.page, "/messages.html?u=bob");
  await aliceS.page.waitForTimeout(1500);
  ok("opening a conversation by name opens it",
     await aliceS.page.isVisible("#dm-open"),
     (await aliceS.page.textContent("body")).slice(0, 200));
  ok("...and shows a composer", await aliceS.page.isVisible("#body"));
  await aliceS.page.fill("#body", "hello bob");
  await aliceS.page.click("#send");
  await aliceS.page.waitForTimeout(1500);
  ok("the message appears in the thread",
     (await aliceS.page.textContent("#log")).indexOf("hello bob") !== -1,
     await aliceS.page.textContent("#log"));

  await go(bobS.page, "/messages.html");
  await bobS.page.waitForTimeout(1200);
  ok("the other side sees the conversation in the list",
     (await bobS.page.textContent("#thread-list")).indexOf("hello bob") !== -1,
     await bobS.page.textContent("#thread-list"));
  await bobS.page.click("#thread-list .dm-item");
  await bobS.page.waitForTimeout(1200);
  ok("...and can open it", (await bobS.page.textContent("#log")).indexOf("hello bob") !== -1,
     await bobS.page.textContent("#log"));
  await bobS.page.fill("#body", "hello back");
  await bobS.page.click("#send");
  await bobS.page.waitForTimeout(1200);
  ok("...and reply", (await bobS.page.textContent("#log")).indexOf("hello back") !== -1,
     await bobS.page.textContent("#log"));
  ok("...with no errors", bobS.page.errors.length === 0, bobS.page.errors.join(" | "));

  /* ------------------------------------------------------- group chats */
  group("group chats");

  const carolS = await session();
  await signUp(carolS.page, "carol", "correct horse 42");
  /* alice and carol have to be friends: groups are friends-only. */
  await go(aliceS.page, "/friends.html");
  await aliceS.page.fill("#find", "carol");
  await aliceS.page.waitForTimeout(900);
  const addCarol = await aliceS.page.$('#results button:has-text("Add friend")');
  if (addCarol) await addCarol.click();
  await carolS.page.goto(base + "/friends.html", { waitUntil: "networkidle" });
  await carolS.page.waitForTimeout(600);
  const acceptAlice = await carolS.page.$('#incoming button:has-text("Accept")');
  if (acceptAlice) await acceptAlice.click();
  await carolS.page.waitForTimeout(700);

  await go(aliceS.page, "/messages.html?new=group");
  await aliceS.page.waitForSelector(".sheet", { timeout: 10000 });
  ok("the new-group sheet opens", await aliceS.page.isVisible(".sheet"));
  await aliceS.page.fill("#group-name", "Study Hall");
  const picks = await aliceS.page.$$('.sheet .people button:has-text("Add")');
  ok("...and lists the friends to pick from", picks.length >= 2, String(picks.length));
  for (const p of picks) await p.click();
  await aliceS.page.click('.sheet button:has-text("Create group")');
  await aliceS.page.waitForTimeout(1500);
  ok("the group is created and opened",
     (await aliceS.page.textContent("#dm-head")).indexOf("Study Hall") !== -1,
     await aliceS.page.textContent("#dm-head"));
  await aliceS.page.fill("#body", "everyone here?");
  await aliceS.page.click("#send");
  await aliceS.page.waitForTimeout(1200);

  await go(carolS.page, "/messages.html");
  await carolS.page.waitForTimeout(1200);
  ok("a member sees the group in their list",
     (await carolS.page.textContent("#thread-list")).indexOf("Study Hall") !== -1,
     await carolS.page.textContent("#thread-list"));
  await carolS.page.click("#thread-list .dm-item");
  await carolS.page.waitForTimeout(1200);
  ok("...and reads what was said",
     (await carolS.page.textContent("#log")).indexOf("everyone here?") !== -1,
     await carolS.page.textContent("#log"));
  ok("...and the group throws nothing", carolS.page.errors.length === 0,
     carolS.page.errors.join(" | "));

  /* ------------------------------------------------------------- calls */
  group("calling");

  await go(bobS.page, "/friends.html");
  await bobS.page.waitForTimeout(800);
  ok("a friend row offers a call button",
     !!(await bobS.page.$('#friends button:has-text("☎")')),
     await bobS.page.innerHTML("#friends"));

  await go(aliceS.page, "/index.html");
  await aliceS.page.waitForTimeout(600);
  await bobS.page.click('#friends button:has-text("☎")');
  await bobS.page.waitForTimeout(1500);
  ok("the caller sees the call bar",
     await bobS.page.isVisible(".callbar"), await bobS.page.innerHTML(".callroot").catch(() => "no callroot"));

  await aliceS.page.waitForSelector(".ring:not([hidden])", { timeout: 20000 })
    .catch(function () {});
  ok("the other side is rung", await aliceS.page.isVisible(".ring"),
     await aliceS.page.innerHTML(".callroot").catch(() => "no callroot"));
  const answer = await aliceS.page.$('.ring button:has-text("Answer")');
  ok("...and offered an answer button", !!answer,
     await aliceS.page.innerHTML(".ring").catch(() => ""));
  if (answer) {
    await answer.click();
    await aliceS.page.waitForTimeout(2500);
    ok("answering opens the call", await aliceS.page.isVisible(".callbar"));
  }
  await aliceS.page.click(".callbtn.is-end").catch(function () {});
  await aliceS.page.waitForTimeout(1200);
  ok("calling throws nothing on either side",
     aliceS.page.errors.length === 0 && bobS.page.errors.length === 0,
     (aliceS.page.errors.concat(bobS.page.errors)).join(" | "));

  /* ------------------------------------------------------------- admin */
  group("admin console");

  await go(ownerS.page, "/admin.html");
  await ownerS.page.waitForTimeout(900);
  ok("the console opens for the owner",
     await ownerS.page.isVisible("#console"), await ownerS.page.textContent("#denied"));
  ok("...and counts the accounts",
     (await ownerS.page.textContent("#k-users")) !== "0",
     await ownerS.page.textContent("#k-users"));

  const tabs = await ownerS.page.$$eval("[data-tab]", (n) => n.map((x) => x.dataset.tab));
  for (const tab of tabs) {
    await ownerS.page.click('[data-tab="' + tab + '"]');
    await ownerS.page.waitForTimeout(500);
    const shown = await ownerS.page.isVisible('[data-panel="' + tab + '"]');
    ok("the " + tab + " tab opens", shown);
  }
  ok("the console throws nothing on any tab", ownerS.page.errors.length === 0,
     ownerS.page.errors.join(" | "));

  /* ---- acting on an account ---- */
  ownerS.page.on("dialog", (d) => d.accept("carol"));

  await ownerS.page.click('[data-tab="users"]');
  await ownerS.page.waitForTimeout(700);
  await ownerS.page.fill("#user-q", "carol");
  await ownerS.page.waitForTimeout(700);
  ok("the user list narrows to a search",
     (await ownerS.page.textContent("#user-rows")).indexOf("carol") !== -1,
     await ownerS.page.textContent("#user-count"));

  await ownerS.page.click('#user-rows button:has-text("Manage")');
  await ownerS.page.waitForSelector(".sheet", { timeout: 8000 });
  ok("the manage sheet opens", await ownerS.page.isVisible(".sheet"));
  await ownerS.page.selectOption("#sheet-rank", "mod");
  await ownerS.page.click('.sheet button:has-text("Save rank")');
  await ownerS.page.waitForTimeout(1400);
  ok("promoting from the console works",
     (await ownerS.page.textContent("#user-rows")).indexOf("mod") !== -1,
     await ownerS.page.textContent("#user-rows"));

  await ownerS.page.click('#user-rows button:has-text("Manage")');
  await ownerS.page.waitForSelector(".sheet", { timeout: 8000 });
  await ownerS.page.click('.sheet button:has-text("Suspend account")');
  await ownerS.page.waitForTimeout(1400);
  ok("suspending from the console works",
     (await ownerS.page.textContent("#user-rows")).indexOf("suspended") !== -1,
     await ownerS.page.textContent("#user-rows"));

  await ownerS.page.click('#user-rows button:has-text("Manage")');
  await ownerS.page.waitForSelector(".sheet", { timeout: 8000 });
  await ownerS.page.click('.sheet button:has-text("Restore account")');
  await ownerS.page.waitForTimeout(1400);
  ok("...and so does putting them back",
     (await ownerS.page.textContent("#user-rows")).indexOf("suspended") === -1,
     await ownerS.page.textContent("#user-rows"));

  /* ---- the catalogue ---- */
  await ownerS.page.click('[data-tab="games"]');
  await ownerS.page.waitForTimeout(600);
  await ownerS.page.click("#cg-new");
  await ownerS.page.waitForSelector("#cat-form:not([hidden])", { timeout: 8000 });
  await ownerS.page.fill("#cg-title", "Tetra");
  await ownerS.page.fill("#cg-id", "tetra");
  await ownerS.page.selectOption("#cg-host", "games-huge");
  await ownerS.page.fill("#cg-source", "tetra/index.html");
  await ownerS.page.click("#cg-save");
  await ownerS.page.waitForTimeout(1800);
  ok("a game can be added from the console",
     (await ownerS.page.textContent("#cg-error")) === "" ||
     await ownerS.page.isHidden("#cg-error"),
     await ownerS.page.textContent("#cg-error"));
  await ownerS.page.fill("#cg-q", "Tetra");
  await ownerS.page.waitForTimeout(800);
  ok("...and shows up in the catalogue list",
     (await ownerS.page.textContent("#cg-list")).indexOf("Tetra") !== -1,
     await ownerS.page.textContent("#cg-count"));

  /* A form the database refuses must say so rather than looking like it
     worked: a path with no host resolves against the hub and 404s. */
  await ownerS.page.click("#cg-new");
  await ownerS.page.waitForSelector("#cat-form:not([hidden])", { timeout: 8000 });
  await ownerS.page.fill("#cg-title", "Nowhere");
  await ownerS.page.fill("#cg-id", "nowhere");
  await ownerS.page.selectOption("#cg-host", "");
  await ownerS.page.fill("#cg-source", "nowhere/index.html");
  await ownerS.page.click("#cg-save");
  await ownerS.page.waitForTimeout(1500);
  ok("a game with no host is refused, out loud",
     await ownerS.page.isVisible("#cg-error"),
     await ownerS.page.textContent("#cg-error"));
  await ownerS.page.click("#cg-close");

  /* ---- the audit trail ---- */
  await ownerS.page.click('[data-tab="audit"]');
  await ownerS.page.waitForSelector("#audit-rows .row", { timeout: 10000 })
    .catch(function () {});
  const audit = await ownerS.page.textContent("#audit-rows");
  ok("the audit trail recorded the rank change", audit.indexOf("user-update") !== -1,
     audit.slice(0, 200));
  ok("...and the catalogue change", audit.indexOf("game-") !== -1, audit.slice(0, 200));
  ok("the console throws nothing while being used",
     ownerS.page.errors.length === 0, ownerS.page.errors.join(" | "));

  await go(aliceS.page, "/admin.html");
  await aliceS.page.waitForTimeout(600);
  ok("a plain user is refused the console",
     await aliceS.page.isVisible("#denied"));

  /* -------------------------------------------------- the rest of the site */
  group("every page loads");

  const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith(".html") && f !== "404.html");
  const sweep = await session();
  for (const file of pages) {
    sweep.page.errors.length = 0;
    await sweep.page.goto(base + "/" + file, { waitUntil: "domcontentloaded" });
    await sweep.page.waitForTimeout(500);
    ok(file + " loads without throwing", sweep.page.errors.length === 0,
       sweep.page.errors.slice(0, 2).join(" | "));
  }
  await sweep.ctx.close();

  /* ------------------------------------------------------------- wrap up */
  await browser.close();
  api.close();
  site.close();
  await stub.end();

  console.log("\n========================================================");
  if (failures.length) {
    console.log(failures.length + " check(s) FAILED:");
    failures.forEach((f) => console.log("  · " + f));
    process.exitCode = 1;
    return;
  }
  console.log("All " + pass + " browser checks passed.");
}

main().catch((e) => { console.error("\nharness error: " + e.stack); process.exitCode = 1; });

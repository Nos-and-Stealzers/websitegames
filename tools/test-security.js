/* Adversarial pass over the Node backend.
 *
 * The other suites check that things work. This one checks that things that
 * should NOT work don't — privilege escalation, reading other people's data,
 * writing as someone else, and the rank rules that keep the owner reachable.
 *
 *   node server/../tools/test-security.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const DB = path.join(os.tmpdir(), "arcade-sec-" + Date.now() + ".db");
process.env.ARCADE_DB = DB;
process.env.NODE_ENV = "test";
process.env.ARCADE_OWNER = "stealzers";

const app = require(path.join(__dirname, "..", "server", "app.js"));

let base;
let pass = 0;
const failures = [];

function ok(label, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + label + (extra ? "   " + extra : "")); }
  else { failures.push(label + (extra ? " → " + extra : "")); console.log("  FAIL " + label + (extra ? "   " + extra : "")); }
}
function group(n) { console.log("\n" + n); }

function client() {
  const jar = new Map();
  return {
    async req(method, url, body, extraHeaders) {
      const headers = Object.assign({ "Content-Type": "application/json" }, extraHeaders || {});
      if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
      const res = await fetch(base + url, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body)
      });
      for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
        const [pair] = c.split(";");
        const i = pair.indexOf("=");
        const k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim();
        if (v === "" || /Max-Age=0/i.test(c)) jar.delete(k); else jar.set(k, v);
      }
      let data = null; try { data = await res.json(); } catch { /* non-JSON */ }
      return { status: res.status, data, headers: res.headers };
    },
    get(u) { return this.req("GET", u); },
    post(u, b, h) { return this.req("POST", u, b, h); },
    put(u, b) { return this.req("PUT", u, b); },
    patch(u, b) { return this.req("PATCH", u, b); },
    del(u, b) { return this.req("DELETE", u, b); },
    jar
  };
}

const signup = (c, u) => c.post("/api/auth/signup", {
  username: u, password: "hunter2pass", displayName: u, acceptedTerms: true
});

async function run() {
  const owner = client(), admin = client(), mod = client(), user = client(), other = client();

  group("setup");
  let r = await signup(owner, "stealzers");
  ok("owner claimed by name", r.data.user.role === "owner", r.data.user.role);
  await signup(admin, "adminacct");
  await signup(mod, "modacct");
  await signup(user, "plainuser");
  await signup(other, "otheruser");

  const id = async (c) => (await c.get("/api/auth/me")).data.user.id;
  const adminId = await id(admin), modId = await id(mod);
  const userId = await id(user), otherId = await id(other), ownerId = await id(owner);

  await owner.patch("/api/admin/users/" + adminId, { role: "admin" });
  await owner.patch("/api/admin/users/" + modId, { role: "mod" });
  ok("ranks assigned by the owner",
     (await owner.get("/api/admin/users")).data.users
       .filter((u) => u.role === "admin" || u.role === "mod").length === 2);

  /* ------------------------------------------------ privilege escalation */
  group("privilege escalation");

  r = await user.patch("/api/users/me", { role: "admin" });
  const meNow = (await user.get("/api/auth/me")).data.user;
  ok("a user cannot promote themselves through the profile route",
     meNow.role === "user", meNow.role);

  r = await user.patch("/api/admin/users/" + userId, { role: "admin" });
  ok("a user cannot reach the admin route at all", r.status === 403, "status " + r.status);

  r = await mod.patch("/api/admin/users/" + otherId, { role: "mod" });
  ok("a mod cannot change ranks", r.status === 403, "status " + r.status);

  r = await mod.patch("/api/admin/users/" + otherId, { state: "suspended" });
  ok("a mod cannot suspend", r.status === 403, "status " + r.status);

  r = await admin.patch("/api/admin/users/" + otherId, { role: "admin" });
  ok("an admin cannot promote to their own rank", r.status === 403, "status " + r.status);

  r = await admin.patch("/api/admin/users/" + otherId, { role: "owner" });
  ok("nobody can grant owner through the API", r.status === 403, "status " + r.status);

  /* ------------------------------------------------------ owner immunity */
  group("the owner is untouchable");

  r = await admin.patch("/api/admin/users/" + ownerId, { role: "user" });
  ok("an admin cannot demote the owner", r.status === 403, "status " + r.status);

  r = await admin.patch("/api/admin/users/" + ownerId, { state: "suspended" });
  ok("an admin cannot suspend the owner", r.status === 403, "status " + r.status);

  r = await admin.del("/api/admin/users/" + ownerId);
  ok("an admin cannot delete the owner", r.status === 403, "status " + r.status);

  const stillOwner = (await owner.get("/api/auth/me")).data.user;
  ok("the owner survived all of that",
     stillOwner.role === "owner" && stillOwner.state === "active",
     stillOwner.role + "/" + stillOwner.state);

  /* --------------------------------------------------- reading other data */
  group("reading what isn't yours");

  await user.put("/api/sync", { save: { favorites: ["secret-game"], version: 2 } });
  r = await other.get("/api/sync");
  ok("another account's save is not readable",
     !JSON.stringify(r.data).includes("secret-game"));

  await user.put("/api/game-saves/games-huge", { payload: { mySave: "private" } });
  r = await other.get("/api/game-saves/games-huge");
  ok("another account's game save is not readable",
     !JSON.stringify(r.data).includes("private"), JSON.stringify(r.data).slice(0, 60));

  r = await user.get("/api/admin/overview");
  ok("site totals are staff-only", r.status === 403, "status " + r.status);
  r = await user.get("/api/admin/logins");
  ok("the login history is staff-only", r.status === 403, "status " + r.status);
  r = await user.get("/api/admin/audit");
  ok("the audit trail is staff-only", r.status === 403, "status " + r.status);

  /* ------------------------------------------------------------- messages */
  group("messages and calls");

  await user.post("/api/friends/request", { username: "otheruser" });
  const inc = (await other.get("/api/friends")).data.incoming
    .find((u) => u.username === "plainuser");
  await other.post("/api/friends/" + inc.edgeId + "/accept");

  const thread = (await user.post("/api/messages/with/otheruser")).data.threadId;
  await user.post("/api/messages/threads/" + thread, { body: "private words" });

  r = await admin.get("/api/messages/threads/" + thread);
  ok("even an admin cannot read a thread they are not in through the normal route",
     r.status === 403 || r.status === 404, "status " + r.status);

  r = await mod.post("/api/messages/threads/" + thread, { body: "intruding" });
  ok("a non-member cannot post into a thread",
     r.status === 403 || r.status === 404, "status " + r.status);

  const call = await user.post("/api/calls", { userId: otherId, kind: "audio" });
  r = await admin.get(`/api/calls/${call.data.call.id}/signal`);
  ok("a stranger cannot read call signalling", r.status === 403, "status " + r.status);

  r = await admin.post(`/api/calls/${call.data.call.id}/signal`,
    { to: userId, kind: "offer", payload: {} });
  ok("a stranger cannot inject call signalling", r.status === 403, "status " + r.status);
  await user.post(`/api/calls/${call.data.call.id}/leave`, {});

  /* ------------------------------------------------------------- tickets */
  group("support tickets");

  const ticket = (await user.post("/api/support", {
    subject: "Private matter", body: "Something I only want staff to read."
  })).data.id;

  r = await other.get("/api/support/" + ticket);
  ok("another user cannot read a ticket", r.status === 403, "status " + r.status);
  r = await other.post("/api/support/" + ticket + "/reply", { body: "hi" });
  ok("another user cannot reply to it", r.status === 403, "status " + r.status);
  r = await user.patch("/api/support/" + ticket, { priority: "high" });
  ok("a user cannot set their own priority", r.status === 400, "status " + r.status);

  /* -------------------------------------------------------------- catalog */
  group("the catalogue");

  for (const [who, c] of [["a user", user], ["a mod", mod], ["an admin", admin]]) {
    r = await c.post("/api/catalog/custom", {
      id: "sneaky", title: "Sneaky", host: "games-huge", source: "x/index.html"
    });
    ok(who + " cannot add a game", r.status === 403, "status " + r.status);
  }
  r = await admin.del("/api/catalog/custom/anything");
  ok("an admin cannot hide a game either", r.status === 403, "status " + r.status);

  /* ------------------------------------------------------ request forgery */
  group("cross-origin and forgery");

  r = await user.post("/api/support", { subject: "Forged", body: "From another site." },
    { Origin: "https://evil.example" });
  ok("a state change from an unknown origin is refused", r.status === 403, "status " + r.status);

  r = await user.post("/api/support", { subject: "Lookalike", body: "From a lookalike host." },
    { Origin: "https://arcadecampushub.online.evil.com" });
  ok("a lookalike origin is refused too", r.status === 403, "status " + r.status);

  /* /auth/me answers 200 with user:null when signed out — the client reads it
     to decide whether to show account features, and a 401 there would be
     noise, not safety. What matters is that it hands back no identity. */
  const noCookie = client();
  r = await noCookie.get("/api/auth/me");
  ok("no session yields no identity", r.data && r.data.user === null,
     JSON.stringify(r.data).slice(0, 60));

  const forged = client();
  forged.jar.set("ach_session", "a".repeat(64));
  r = await forged.get("/api/auth/me");
  ok("a made-up session token yields no identity", r.data && r.data.user === null,
     JSON.stringify(r.data).slice(0, 60));

  /* And a forged token must not open anything that needs an account. */
  r = await forged.get("/api/auth/sessions");
  ok("a forged token cannot list sessions", r.status === 401, "status " + r.status);
  r = await forged.get("/api/messages/threads");
  ok("a forged token cannot read messages", r.status === 401, "status " + r.status);
  r = await forged.put("/api/sync", { save: { version: 2 } });
  ok("a forged token cannot write a save", r.status === 401, "status " + r.status);

  /* --------------------------------------------------------- input limits */
  group("input limits");

  r = await user.post("/api/support", { subject: "x".repeat(500), body: "y".repeat(50) });
  ok("an over-long subject is refused", r.status === 400, "status " + r.status);

  r = await user.put("/api/game-saves/../../etc/passwd", { payload: { a: 1 } });
  ok("a path-traversal host is refused", r.status === 400 || r.status === 404,
     "status " + r.status);

  r = await user.put("/api/game-saves/games-huge", {
    payload: { big: "x".repeat(5 * 1024 * 1024) }
  });
  ok("an oversized save is refused", r.status === 400 || r.status === 413,
     "status " + r.status);

  /* ------------------------------------------------------ headers on html */
  group("response headers");

  const page = await fetch(base + "/index.html");
  ok("nosniff is set", page.headers.get("x-content-type-options") === "nosniff");
  ok("framing is restricted", !!page.headers.get("x-frame-options"));
  const pp = page.headers.get("permissions-policy") || "";
  ok("the microphone is not switched off outright", !/microphone=\(\)/.test(pp), pp);

  const health = await fetch(base + "/api/health");
  const body = await health.json();
  ok("health does not leak account details",
     !("users" in body) || typeof body.users === "number",
     JSON.stringify(body).slice(0, 80));

  console.log("\n" + "=".repeat(56));
  if (failures.length) {
    console.log(failures.length + " FAILED of " + (pass + failures.length) + ":");
    failures.forEach((f) => console.log("  · " + f));
    process.exitCode = 1;
  } else {
    console.log("All " + pass + " security checks passed.");
  }
}

const server = app.listen(0, async () => {
  base = "http://127.0.0.1:" + server.address().port;
  try { await run(); }
  catch (err) { console.error(err); process.exitCode = 1; }
  finally {
    server.close();
    try { fs.unlinkSync(DB); } catch { /* windows may still hold it */ }
  }
});

/* End-to-end API tests. Boots the real app against a throwaway database and
   drives it over HTTP with real cookies.
 *
 *   node server/test/api.test.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const DB = path.join(os.tmpdir(), "arcade-test-" + Date.now() + ".db");
process.env.ARCADE_DB = DB;
process.env.NODE_ENV = "test";

const app = require("../app");

let base;
let pass = 0;
const failures = [];

function ok(label, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + label + (extra ? "  " + extra : "")); }
  else { failures.push(label + (extra ? "  → " + extra : "")); console.log("  FAIL " + label + (extra ? "  → " + extra : "")); }
}

function group(name) { console.log("\n" + name); }

/* Accept whatever pending request `username` has sent to this client. */
async function acceptFrom(who, username) {
  const d = (await who.get("/api/friends")).data;
  const edge = d.incoming.find((u) => u.username === username);
  if (edge) await who.post(`/api/friends/${edge.edgeId}/accept`);
  return !!edge;
}

/* A tiny cookie-aware client, one instance per simulated browser. */
function client() {
  const jar = new Map();
  return {
    async req(method, url, body) {
      const headers = { "Content-Type": "application/json" };
      if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
      const res = await fetch(base + url, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body)
      });
      const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of setCookie) {
        const [pair] = c.split(";");
        const i = pair.indexOf("=");
        const k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim();
        if (v === "" || /Max-Age=0/i.test(c)) jar.delete(k); else jar.set(k, v);
      }
      let data = null;
      try { data = await res.json(); } catch { /* non-JSON body */ }
      return { status: res.status, data };
    },
    get(u) { return this.req("GET", u); },
    post(u, b) { return this.req("POST", u, b); },
    put(u, b) { return this.req("PUT", u, b); },
    patch(u, b) { return this.req("PATCH", u, b); },
    del(u, b) { return this.req("DELETE", u, b); },
    raw(method, url, headers, body) {
      const h = Object.assign({ "Content-Type": "application/json" }, headers);
      if (jar.size) h.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
      return fetch(base + url, { method, headers: h, body: body && JSON.stringify(body) });
    }
  };
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = "http://127.0.0.1:" + server.address().port;

  const admin = client(), alice = client(), bob = client(), anon = client();
  let carol, dave;   // created during the friend-code tests, reused for groups

  /* ------------------------------------------------------------- health */
  group("health & setup");
  {
    const { status, data } = await anon.get("/api/health");
    ok("health responds", status === 200);
    ok("reports needing setup", data.needsSetup === true);
  }

  /* ------------------------------------------------------------ signup */
  group("signup & validation");
  {
    let r = await admin.post("/api/auth/signup", { username: "owner", password: "hunter2pass" });
    ok("first account created", r.status === 201, "status " + r.status);
    ok("first account is admin", r.data.user.role === "admin");
    ok("no password material leaked", !JSON.stringify(r.data).match(/pass_hash|pass_salt/));

    r = await alice.post("/api/auth/signup", { username: "alice", password: "wonderland1" });
    ok("second account created", r.status === 201);
    ok("second account is plain user", r.data.user.role === "user");

    r = await bob.post("/api/auth/signup", { username: "bob", password: "builder123" });
    ok("third account created", r.status === 201);

    r = await anon.post("/api/auth/signup", { username: "alice", password: "different1" });
    ok("duplicate username rejected", r.status === 409);

    r = await anon.post("/api/auth/signup", { username: "ok", password: "longenough1" });
    ok("short username rejected", r.status === 400);

    r = await anon.post("/api/auth/signup", { username: "9lives", password: "longenough1" });
    ok("username must start with a letter", r.status === 400);

    r = await anon.post("/api/auth/signup", { username: "admin", password: "longenough1" });
    ok("reserved username rejected", r.status === 400);

    r = await anon.post("/api/auth/signup", { username: "shorty", password: "abc" });
    ok("short password rejected", r.status === 400);

    r = await anon.post("/api/auth/signup", { username: "lettersonly", password: "abcdefghij" });
    ok("password needs a digit", r.status === 400);
  }

  /* ------------------------------------------------------------- login */
  group("login & sessions");
  {
    const c = client();
    let r = await c.post("/api/auth/login", { username: "alice", password: "nope" });
    ok("wrong password rejected", r.status === 401);

    r = await c.post("/api/auth/login", { username: "ghost", password: "whatever1" });
    ok("unknown user gives same error", r.status === 401 && r.data.error === "Wrong username or password.");

    r = await c.post("/api/auth/login", { username: "ALICE", password: "wonderland1" });
    ok("login is case-insensitive", r.status === 200);

    r = await c.get("/api/auth/me");
    ok("session recognised", r.data.user && r.data.user.username === "alice");

    r = await anon.get("/api/auth/me");
    ok("anonymous sees no user", r.data.user === null);

    r = await c.post("/api/auth/logout");
    ok("logout succeeds", r.status === 200);
    r = await c.get("/api/auth/me");
    ok("session cleared after logout", r.data.user === null);
  }

  /* --------------------------------------------------------- auth walls */
  group("authorisation");
  {
    let r = await anon.get("/api/friends");
    ok("friends needs auth", r.status === 401);
    r = await anon.get("/api/messages/threads");
    ok("messages needs auth", r.status === 401);
    r = await alice.get("/api/admin/overview");
    ok("plain user blocked from admin", r.status === 403);
    r = await anon.get("/api/admin/overview");
    ok("anon blocked from admin", r.status === 401);
    r = await admin.get("/api/admin/overview");
    ok("admin allowed", r.status === 200);
  }

  /* ------------------------------------------------------------ profile */
  group("profile");
  {
    let r = await alice.patch("/api/users/me", { displayName: "Alice A", bio: "hi there" });
    ok("profile updates", r.status === 200 && r.data.user.displayName === "Alice A");

    r = await alice.patch("/api/users/me", { bio: "x".repeat(400) });
    ok("overlong bio rejected", r.status === 400);

    r = await bob.get("/api/users/alice");
    ok("profile visible to others", r.status === 200 && r.data.user.username === "alice");
    ok("relation reported", r.data.user.relation === "none");
    ok("private flags hidden from others", r.data.user.acceptsDms === undefined);

    r = await bob.get("/api/users/nobody");
    ok("unknown profile 404s", r.status === 404);

    r = await bob.get("/api/users/search?q=al");
    ok("search finds alice", r.status === 200 && r.data.users.some((u) => u.username === "alice"));
    r = await bob.get("/api/users/search?q=a");
    ok("one-character search ignored", r.data.users.length === 0);
  }

  /* ------------------------------------------------------------ friends */
  group("friends");
  {
    let r = await alice.post("/api/friends/request", { username: "bob" });
    ok("request sent", r.status === 201 && r.data.state === "pending-out");

    r = await alice.post("/api/friends/request", { username: "bob" });
    ok("duplicate request rejected", r.status === 409);

    r = await alice.post("/api/friends/request", { username: "alice" });
    ok("cannot friend yourself", r.status === 400);

    r = await alice.post("/api/friends/request", { username: "ghost" });
    ok("unknown target 404s", r.status === 404);

    r = await bob.get("/api/friends");
    ok("bob sees incoming", r.data.incoming.length === 1 && r.data.incoming[0].username === "alice");
    const edgeId = r.data.incoming[0].edgeId;

    r = await alice.get("/api/friends");
    ok("alice sees outgoing", r.data.outgoing.length === 1);

    r = await bob.post(`/api/friends/${edgeId}/accept`);
    ok("request accepted", r.status === 200 && r.data.state === "friends");

    r = await alice.get("/api/friends");
    ok("alice now has a friend", r.data.friends.length === 1 && r.data.outgoing.length === 0);
    r = await bob.get("/api/friends");
    ok("bob now has a friend", r.data.friends.length === 1 && r.data.incoming.length === 0);

    r = await bob.get("/api/users/alice");
    ok("relation reads friends", r.data.user.relation === "friends");

    /* An outsider must not be able to accept someone else's request. */
    r = await admin.post("/api/friends/request", { username: "alice" });
    const adminEdge = (await alice.get("/api/friends")).data.incoming[0].edgeId;
    r = await bob.post(`/api/friends/${adminEdge}/accept`);
    ok("third party cannot accept", r.status === 404);
    r = await alice.del(`/api/friends/${adminEdge}`);
    ok("addressee can decline", r.status === 200);
  }

  /* ----------------------------------------------------------- messages */
  group("messages");
  {
    let r = await alice.post("/api/messages/with/bob");
    ok("thread opened", r.status === 200 && r.data.threadId > 0);
    const thread = r.data.threadId;

    r = await bob.post("/api/messages/with/alice");
    ok("same thread reused both ways", r.data.threadId === thread);

    r = await alice.post(`/api/messages/threads/${thread}`, { body: "hey bob" });
    ok("message sent", r.status === 201 && r.data.message.body === "hey bob");

    r = await alice.post(`/api/messages/threads/${thread}`, { body: "" });
    ok("empty message rejected", r.status === 400);
    r = await alice.post(`/api/messages/threads/${thread}`, { body: "x".repeat(2500) });
    ok("overlong message rejected", r.status === 400);

    r = await bob.get(`/api/messages/threads/${thread}`);
    ok("bob reads the thread", r.data.messages.length === 1 && r.data.messages[0].mine === false);

    r = await admin.get(`/api/messages/threads/${thread}`);
    ok("outsider cannot read the thread", r.status === 404);
    r = await admin.post(`/api/messages/threads/${thread}`, { body: "butting in" });
    ok("outsider cannot post to the thread", r.status === 404);

    r = await bob.get("/api/messages/unread");
    ok("unread cleared after reading", r.data.messages === 0);

    await bob.post(`/api/messages/threads/${thread}`, { body: "hi alice" });
    r = await alice.get("/api/messages/unread");
    ok("unread counts new inbound", r.data.messages === 1);

    r = await alice.get("/api/messages/threads");
    ok("thread listed with preview", r.data.threads.length === 1 &&
       r.data.threads[0].preview.body === "hi alice");

    /* Message body must survive verbatim — escaping is the browser's job. */
    const nasty = '<img src=x onerror="alert(1)">';
    await alice.post(`/api/messages/threads/${thread}`, { body: nasty });
    r = await bob.get(`/api/messages/threads/${thread}`);
    ok("html stored verbatim, not mangled",
       r.data.messages.some((m) => m.body === nasty));
  }

  /* ------------------------------------------------------ dm privacy */
  group("dm privacy & blocking");
  {
    let r = await admin.patch("/api/users/me", { acceptsDms: false });
    ok("dms can be set to friends-only", r.status === 200 && r.data.user.acceptsDms === false);

    r = await bob.post("/api/messages/with/owner");
    ok("non-friend blocked by dm setting", r.status === 403);

    await admin.patch("/api/users/me", { acceptsDms: true });
    r = await bob.post("/api/messages/with/owner");
    ok("allowed once dms reopened", r.status === 200);
    const t = r.data.threadId;

    r = await admin.post("/api/friends/block", { username: "bob" });
    ok("block recorded", r.status === 200 && r.data.state === "blocked");

    r = await bob.post(`/api/messages/threads/${t}`, { body: "hello?" });
    ok("blocked user cannot send", r.status === 403);

    r = await bob.get("/api/users/owner");
    ok("blocked user cannot see profile", r.status === 404);

    r = await bob.get("/api/users/search?q=own");
    ok("blocked user filtered from search", !r.data.users.some((u) => u.username === "owner"));
  }

  /* --------------------------------------------------------- save sync */
  group("save sync");
  {
    let r = await alice.get("/api/sync");
    ok("empty save to start", r.status === 200 && r.data.save.favorites.length === 0);

    r = await alice.put("/api/sync", {
      save: {
        favorites: ["snow-rider"],
        recents: [{ id: "snow-rider", at: 1000 }],
        stats: { "snow-rider": { plays: 2, seconds: 120, last: 1000 } },
        ratings: { "snow-rider": 4 }
      }
    });
    ok("save uploaded", r.status === 200 && r.data.save.favorites.includes("snow-rider"));

    /* A second device with different local data must not clobber the first. */
    r = await alice.put("/api/sync", {
      save: {
        favorites: ["boxhead2play"],
        recents: [{ id: "boxhead2play", at: 2000 }],
        stats: { "snow-rider": { plays: 1, seconds: 500, last: 2000 },
                 "boxhead2play": { plays: 3, seconds: 60, last: 2000 } },
        ratings: {}
      }
    });
    const s = r.data.save;
    ok("favourites union", s.favorites.includes("snow-rider") && s.favorites.includes("boxhead2play"));
    ok("stats take the max, not the last write", s.stats["snow-rider"].seconds === 500);
    ok("play counts keep the higher", s.stats["snow-rider"].plays === 2);
    ok("new game merged in", s.stats["boxhead2play"].plays === 3);
    ok("ratings preserved", s.ratings["snow-rider"] === 4);
    ok("recents newest first", s.recents[0].id === "boxhead2play");

    r = await alice.put("/api/sync", { save: null });
    ok("missing save rejected", r.status === 400);

    r = await anon.get("/api/games/popular");
    ok("popular list is public", r.status === 200 && Array.isArray(r.data.games));
    ok("popular reflects synced play", r.data.games.some((g) => g.id === "snow-rider"));
  }

  /* ----------------------------------------------------------- reports */
  group("reports");
  {
    let r = await bob.post("/api/reports", { kind: "user", target: "someone", reason: "being rude" });
    ok("report filed", r.status === 201);
    r = await bob.post("/api/reports", { kind: "nonsense", target: "x", reason: "because" });
    ok("unknown report kind rejected", r.status === 400,
       "got " + r.status + " " + JSON.stringify(r.data));
    r = await anon.post("/api/reports", { kind: "user", target: "x", reason: "because" });
    ok("anonymous cannot report", r.status === 401);

    r = await admin.get("/api/admin/reports");
    ok("admin sees open reports", r.data.reports.length === 1);
    const id = r.data.reports[0].id;
    r = await admin.patch(`/api/admin/reports/${id}`, { state: "closed" });
    ok("report closed", r.status === 200);
    r = await admin.get("/api/admin/reports");
    ok("closed report leaves the open list", r.data.reports.length === 0);
  }

  /* ---------------------------------------------------------- friend codes */
  group("friend codes");
  {
    let r = await alice.get("/api/auth/me");
    const aliceCode = r.data.user.friendCode;
    ok("account has a friend code", /^[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(aliceCode || ""), aliceCode);
    ok("code avoids ambiguous glyphs", !/[O0I1L]/.test(aliceCode), aliceCode);

    r = await bob.get("/api/auth/me");
    ok("codes are unique per account", r.data.user.friendCode !== aliceCode);
    ok("code is private to its owner",
       (await bob.get("/api/users/alice")).data.user.friendCode === undefined);

    r = await bob.post("/api/friends/code", { code: aliceCode });
    ok("lookup by code finds the account", r.status === 200 && r.data.user.username === "alice");

    /* Typed by hand, so casing/spacing/dashes must not matter. */
    r = await bob.post("/api/friends/code", { code: aliceCode.toLowerCase().replace("-", " ") });
    ok("lookup tolerates messy input", r.status === 200 && r.data.user.username === "alice");

    r = await bob.post("/api/friends/code", { code: "ZZZ-999" });
    ok("unknown code 404s", r.status === 404);
    r = await bob.post("/api/friends/code", { code: "nope" });
    ok("malformed code rejected", r.status === 400);

    r = await alice.post("/api/friends/code", { code: aliceCode });
    ok("cannot look up your own code", r.status === 400);

    /* Adding by code goes through the same request route as by username. */
    carol = client();
    await carol.post("/api/auth/signup", { username: "carol", password: "carolpass1" });
    r = await carol.post("/api/friends/request", { code: aliceCode });
    ok("friend request by code works", r.status === 201, JSON.stringify(r.data));

    r = await carol.get("/api/friends");
    ok("request shows as outgoing", r.data.outgoing.some((u) => u.username === "alice"));

    /* A code pasted into the username box should still resolve. */
    dave = client();
    await dave.post("/api/auth/signup", { username: "dave", password: "davepass12" });
    r = await dave.post("/api/friends/request", { username: aliceCode });
    ok("code pasted into the username box resolves", r.status === 201, JSON.stringify(r.data));

    r = await alice.post("/api/users/me/code");
    const rotated = r.data.friendCode;
    ok("code can be rotated", r.status === 200 && rotated && rotated !== aliceCode);
    r = await bob.post("/api/friends/code", { code: aliceCode });
    ok("old code stops working", r.status === 404);
    r = await bob.post("/api/friends/code", { code: rotated });
    ok("new code works", r.status === 200);
  }

  /* --------------------------------------------------------------- groups */
  group("group threads");
  {
    /* alice and bob are already friends; carol is not yet. */
    let r = await alice.post("/api/threads/group", { title: "Squad", usernames: ["bob"] });
    ok("group created", r.status === 201 && r.data.thread.isGroup === true, JSON.stringify(r.data));
    const gid = r.data.thread.id;
    ok("owner flagged", r.data.thread.owner === true);
    ok("member count includes you", r.data.thread.memberCount === 2);

    r = await alice.post("/api/threads/group", { title: "Nope", usernames: ["carol"] });
    ok("cannot group with a non-friend", r.status === 400, JSON.stringify(r.data));

    r = await alice.post("/api/threads/group", { title: "Empty", usernames: [] });
    ok("group needs someone in it", r.status === 400);

    r = await bob.get("/api/messages/threads/" + gid);
    ok("member can open the group", r.status === 200 && r.data.isGroup === true);
    ok("non-owner not flagged as owner", r.data.owner === false);

    r = await admin.get("/api/messages/threads/" + gid);
    ok("outsider cannot read the group", r.status === 404);
    r = await admin.post("/api/messages/threads/" + gid, { body: "hi" });
    ok("outsider cannot post to the group", r.status === 404);

    r = await alice.post("/api/messages/threads/" + gid, { body: "hello squad" });
    ok("group message sent", r.status === 201);
    r = await bob.get("/api/messages/threads/" + gid);
    ok("other member sees it", r.data.messages.some((m) => m.body === "hello squad"));
    ok("sender identified in group", r.data.messages[0].from.username === "alice");

    r = await bob.patch("/api/threads/" + gid, { title: "Hijack" });
    ok("non-owner cannot rename", r.status === 403);
    r = await alice.patch("/api/threads/" + gid, { title: "The Squad" });
    ok("owner can rename", r.status === 200 && r.data.thread.title === "The Squad");

    r = await bob.post("/api/threads/" + gid + "/members", { username: "carol" });
    ok("cannot add a non-friend to a group", r.status === 400);

    /* carol already requested alice during the code tests — accept it. */
    ok("pending request from carol accepted", await acceptFrom(alice, "carol"));
    r = await alice.post("/api/threads/" + gid + "/members", { username: "carol" });
    ok("owner adds a friend", r.status === 201 && r.data.thread.memberCount === 3);

    r = await bob.del("/api/threads/" + gid + "/members/" + 99999);
    ok("non-owner cannot remove others", r.status === 403);

    const bobId = (await admin.get("/api/admin/users")).data.users
      .find((u) => u.username === "bob").id;
    r = await bob.del("/api/threads/" + gid + "/members/" + bobId);
    ok("anyone can leave a group", r.status === 200);
    r = await bob.get("/api/messages/threads/" + gid);
    ok("leaving revokes access", r.status === 404);

    r = await bob.del("/api/threads/" + gid + "/members/" + bobId);
    ok("leaving twice is a 404, not a crash", r.status === 404);
  }

  /* ---------------------------------------------------------- attachments */
  group("image attachments");
  {
    /* A real 1×1 PNG. */
    const PNG =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk" +
      "YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

    let r = await alice.post("/api/messages/with/bob");
    const t = r.data.threadId;

    r = await alice.post("/api/messages/threads/" + t, {
      body: "look at this", image: { kind: "screenshot", dataUrl: PNG, width: 1, height: 1 }
    });
    ok("image message accepted", r.status === 201, JSON.stringify(r.data).slice(0, 120));
    ok("image metadata returned", r.data.message.image && r.data.message.image.mime === "image/png");
    const imgId = r.data.message.image.id;

    r = await alice.post("/api/messages/threads/" + t, {
      image: { kind: "camera", dataUrl: PNG, width: 1, height: 1 }
    });
    ok("image with no caption allowed", r.status === 201);

    r = await alice.post("/api/messages/threads/" + t, { body: "" });
    ok("empty message with no image rejected", r.status === 400);

    r = await alice.post("/api/messages/threads/" + t, {
      image: { kind: "upload", dataUrl: "data:text/html;base64,PGgxPmhpPC9oMT4=" }
    });
    ok("non-image mime rejected", r.status === 400, JSON.stringify(r.data));

    r = await alice.post("/api/messages/threads/" + t, {
      image: { kind: "upload", dataUrl: "not-a-data-url" }
    });
    ok("malformed data url rejected", r.status === 400);

    const huge = "data:image/png;base64," + "A".repeat(1200000);
    r = await alice.post("/api/messages/threads/" + t, { image: { kind: "upload", dataUrl: huge } });
    ok("oversized image rejected", r.status === 400 || r.status === 413, "status " + r.status);

    /* Serving is scoped to the thread the image was posted in. */
    let raw = await bob.raw("GET", "/api/attachments/" + imgId);
    ok("thread member can fetch the image", raw.status === 200);
    ok("served with the right content type",
       (raw.headers.get("content-type") || "").startsWith("image/png"));
    ok("not publicly cacheable",
       /private/.test(raw.headers.get("cache-control") || ""));

    raw = await admin.raw("GET", "/api/attachments/" + imgId);
    ok("outsider cannot fetch the image", raw.status === 404);

    raw = await anon.raw("GET", "/api/attachments/" + imgId);
    ok("anonymous cannot fetch the image", raw.status === 401 || raw.status === 404);

    /* Deleting the message must destroy the file, not orphan it. */
    r = await bob.get("/api/messages/threads/" + t);
    const withImage = r.data.messages.find((m) => m.image);
    r = await alice.del("/api/messages/" + withImage.id);
    ok("image message deleted", r.status === 200);
    raw = await bob.raw("GET", "/api/attachments/" + withImage.image.id);
    ok("attachment gone with the message", raw.status === 404);
  }

  /* ----------------------------------------------------- notifications */
  group("notifications");
  {
    /* alice ↔ bob became friends and exchanged messages earlier, so both
       should already have a feed. */
    let r = await bob.get("/api/notifications");
    ok("feed returns entries", r.status === 200 && r.data.notifications.length > 0,
       "n=" + (r.data.notifications || []).length);
    ok("friend request was notified",
       r.data.notifications.some((n) => n.kind === "friend-request"));
    ok("actor is attached",
       r.data.notifications.some((n) => n.actor && n.actor.username === "alice"));
    ok("entries carry a deep link",
       r.data.notifications.some((n) => n.link));

    r = await alice.get("/api/notifications");
    ok("acceptance notified the requester",
       r.data.notifications.some((n) => n.kind === "friend-accept"));
    ok("incoming message notified",
       r.data.notifications.some((n) => n.kind === "message"));

    /* Nobody should be told about their own actions. */
    ok("no self-notifications",
       !r.data.notifications.some((n) => n.actor && n.actor.username === "alice"));

    const before = (await alice.get("/api/notifications")).data.notifications
      .filter((n) => n.kind === "message").length;
    const thread = (await bob.post("/api/messages/with/alice")).data.threadId;
    await bob.post(`/api/messages/threads/${thread}`, { body: "spam one" });
    await bob.post(`/api/messages/threads/${thread}`, { body: "spam two" });
    await bob.post(`/api/messages/threads/${thread}`, { body: "spam three" });
    const after = (await alice.get("/api/notifications")).data.notifications
      .filter((n) => n.kind === "message").length;
    ok("a chatty sender collapses into one entry", after === before,
       `before=${before} after=${after}`);

    r = await alice.get("/api/messages/unread");
    ok("badge endpoint reports notifications", typeof r.data.notifications === "number");
    ok("unread count is positive", r.data.notifications > 0);

    r = await alice.get("/api/notifications?unread=1");
    const unreadIds = r.data.notifications.map((n) => n.id);
    ok("unread filter works", r.data.notifications.every((n) => !n.read));

    r = await alice.post("/api/notifications/read", { ids: [unreadIds[0]] });
    ok("marking one read lowers the count", r.data.unread === unreadIds.length - 1,
       "unread=" + r.data.unread);

    r = await alice.post("/api/notifications/read", { all: true });
    ok("mark-all clears the count", r.data.unread === 0);

    /* One user must not be able to touch another's feed. */
    const bobFeed = (await bob.get("/api/notifications")).data.notifications;
    const bobId = bobFeed[0].id;
    r = await alice.del(`/api/notifications/${bobId}`);
    ok("cannot dismiss someone else's notification", r.status === 404);
    r = await alice.post("/api/notifications/read", { ids: [bobId] });
    ok("cannot mark someone else's notification read", r.data.unread === 0);
    ok("their notification survived",
       (await bob.get("/api/notifications")).data.notifications.some((n) => n.id === bobId));

    r = await anon.get("/api/notifications");
    ok("feed needs auth", r.status === 401);

    r = await alice.del(`/api/notifications/${(await alice.get("/api/notifications")).data.notifications[0].id}`);
    ok("own notification dismissed", r.status === 200);

    r = await alice.del("/api/notifications");
    ok("clear-all empties the feed", r.status === 200);
    ok("feed is now empty",
       (await alice.get("/api/notifications")).data.notifications.length === 0);
  }

  /* ---------------------------------------------------------- feedback */
  group("feedback");
  {
    /* Anonymous must work — a broken sign-up is the thing people need to
       report, and they can't sign in to do it. */
    let r = await anon.post("/api/feedback", {
      kind: "bug", subject: "Cannot sign up", body: "The button does nothing at all."
    });
    ok("anonymous feedback accepted", r.status === 201, JSON.stringify(r.data));

    r = await bob.post("/api/feedback", {
      kind: "game", subject: "Add Slope", body: "Please add Slope, everyone plays it.",
      gameId: "slope", page: "browse.html"
    });
    ok("signed-in feedback accepted", r.status === 201);

    r = await bob.post("/api/feedback", { kind: "nonsense", subject: "hi", body: "some detail here" });
    ok("unknown kind rejected", r.status === 400);
    r = await bob.post("/api/feedback", { kind: "bug", subject: "x", body: "some detail here" });
    ok("too-short summary rejected", r.status === 400);
    r = await bob.post("/api/feedback", { kind: "bug", subject: "Real summary", body: "short" });
    ok("too-short details rejected", r.status === 400);

    r = await bob.get("/api/feedback/mine");
    ok("own feedback listed", r.data.feedback.length === 1);
    ok("anonymous entry not attributed to anyone",
       !r.data.feedback.some((f) => /Cannot sign up/.test(f.subject)));

    r = await alice.get("/api/admin/feedback");
    ok("plain user cannot read the queue", r.status === 403);
    r = await anon.get("/api/admin/feedback");
    ok("anon cannot read the queue", r.status === 401);

    r = await admin.get("/api/admin/feedback");
    ok("staff sees the queue", r.status === 200 && r.data.feedback.length === 2);
    ok("queue reports per-state counts", r.data.counts && r.data.counts.new === 2);
    ok("anonymous shows as anonymous",
       r.data.feedback.some((f) => f.from === "(anonymous)"));
    ok("browser recorded for triage",
       r.data.feedback.every((f) => typeof f.agent === "string"));

    const mine = r.data.feedback.find((f) => f.from === "bob");
    r = await admin.patch(`/api/admin/feedback/${mine.id}`, { state: "triaged" });
    ok("staff can change state", r.status === 200);

    r = await admin.patch(`/api/admin/feedback/${mine.id}`, { reply: "Good idea, queued it." });
    ok("staff can reply", r.status === 200);

    r = await bob.get("/api/feedback/mine");
    ok("reporter sees the reply", r.data.feedback[0].reply === "Good idea, queued it.");
    ok("reporter sees the new state", r.data.feedback[0].state === "triaged");

    r = await bob.get("/api/notifications");
    ok("reporter was notified", r.data.notifications.some((n) => n.kind === "feedback"));

    r = await alice.patch(`/api/admin/feedback/${mine.id}`, { state: "done" });
    ok("plain user cannot triage", r.status === 403);

    r = await admin.get("/api/admin/feedback?state=triaged");
    ok("filtering by state works", r.data.feedback.length === 1);
  }

  /* ------------------------------------------------- game progress sync */
  group("game save sync");
  {
    const host = "lucasgrimm389.github.io";
    let r = await bob.get(`/api/game-saves/${host}`);
    ok("empty to start", r.status === 200 && Object.keys(r.data.payload).length === 0);

    r = await bob.put(`/api/game-saves/${host}`, {
      payload: { "snowrider_best": "42", "bitlife_save": "{\"age\":19}" }
    });
    ok("snapshot stored", r.status === 200 && r.data.keys === 2);

    r = await bob.get(`/api/game-saves/${host}`);
    ok("snapshot returned verbatim", r.data.payload.snowrider_best === "42");
    ok("second key intact", r.data.payload.bitlife_save === '{"age":19}');

    r = await bob.get("/api/game-saves");
    ok("host listed", r.data.hosts.length === 1 && r.data.hosts[0].host === host);
    ok("key count reported", r.data.hosts[0].keys === 2);

    /* One account's game progress must never be visible to another. */
    r = await alice.get(`/api/game-saves/${host}`);
    ok("another account sees nothing", Object.keys(r.data.payload).length === 0);

    r = await anon.get(`/api/game-saves/${host}`);
    ok("anonymous refused", r.status === 401);
    r = await anon.put(`/api/game-saves/${host}`, { payload: {} });
    ok("anonymous cannot write", r.status === 401);

    r = await bob.put("/api/game-saves/not a host!", { payload: {} });
    ok("bad host rejected", r.status === 400);
    r = await bob.put(`/api/game-saves/${host}`, { payload: null });
    ok("missing payload rejected", r.status === 400);

    /* An IndexedDB snapshot is nested and can carry base64'd binary, so the
       shape the bridge actually sends must survive the round trip. */
    r = await bob.put(`/api/game-saves/${host}`, {
      payload: {
        local: { "snowrider_best": "42" },
        idb: { "UnityCache": { FILE_DATA: [{ k: "/idbfs/save", v: { $b: "AAECAwQ=" } }] } }
      }
    });
    ok("indexeddb-shaped snapshot stored", r.status === 200, JSON.stringify(r.data));
    r = await bob.get(`/api/game-saves/${host}`);
    ok("nested idb payload comes back intact",
       r.data.payload.idb.UnityCache.FILE_DATA[0].v.$b === "AAECAwQ=");
    ok("localStorage half still there", r.data.payload.local.snowrider_best === "42");

    /* Cap is 4 MB now that binary saves go through it, so the oversize probe
       has to actually exceed that. */
    const huge = {};
    for (let i = 0; i < 12000; i++) huge["k" + i] = "x".repeat(400);
    r = await bob.put(`/api/game-saves/${host}`, { payload: huge });
    ok("oversized snapshot rejected", r.status === 400 || r.status === 413, "status " + r.status);

    r = await bob.get(`/api/game-saves/${host}`);
    ok("rejected write left the old snapshot alone",
       r.data.payload.local && r.data.payload.local.snowrider_best === "42");

    r = await bob.del(`/api/game-saves/${host}`);
    ok("snapshot deleted", r.status === 200);
    r = await bob.get(`/api/game-saves/${host}`);
    ok("gone after delete", Object.keys(r.data.payload).length === 0);
  }

  /* ------------------------------------------------------------- admin */
  group("admin");
  {
    let r = await admin.get("/api/admin/overview");
    const accounts = r.data.users.total;
    ok("overview counts users", accounts >= 3, "total=" + accounts);
    ok("overview counts friendships", r.data.social.friendships >= 1);
    ok("overview counts messages", r.data.social.messages > 0);

    r = await admin.get("/api/admin/users");
    ok("user list returned", r.data.users.length === accounts,
       r.data.users.length + " rows vs " + accounts + " counted");
    ok("admin list still hides credentials", !JSON.stringify(r.data).match(/pass_hash|pass_salt/));

    const bobRow = r.data.users.find((u) => u.username === "bob");

    r = await alice.patch(`/api/admin/users/${bobRow.id}`, { role: "mod" });
    ok("non-admin cannot change roles", r.status === 403);

    r = await admin.patch(`/api/admin/users/${bobRow.id}`, { role: "mod" });
    ok("admin promotes to mod", r.status === 200 && r.data.user.role === "mod");

    r = await bob.get("/api/admin/overview");
    ok("mod can read admin overview", r.status === 200);
    r = await bob.patch(`/api/admin/users/${bobRow.id}`, { role: "admin" });
    ok("mod cannot change roles", r.status === 403);

    const ownRow = (await admin.get("/api/admin/users")).data.users.find((u) => u.username === "owner");
    r = await admin.patch(`/api/admin/users/${ownRow.id}`, { role: "user" });
    ok("last admin cannot demote self", r.status === 400);
    r = await admin.patch(`/api/admin/users/${ownRow.id}`, { state: "suspended" });
    ok("admin cannot suspend self", r.status === 400);

    /* Suspension must terminate live sessions, not just block future logins. */
    r = await admin.patch(`/api/admin/users/${bobRow.id}`, { state: "suspended" });
    ok("bob suspended", r.status === 200);
    r = await bob.get("/api/friends");
    ok("suspension kills the live session", r.status === 401);
    r = await bob.post("/api/auth/login", { username: "bob", password: "builder123" });
    ok("suspended account cannot log back in", r.status === 403);

    await admin.patch(`/api/admin/users/${bobRow.id}`, { state: "active" });
    r = await bob.post("/api/auth/login", { username: "bob", password: "builder123" });
    ok("reinstated account can log in", r.status === 200);

    r = await admin.get("/api/admin/audit");
    ok("audit trail recorded the changes", r.data.entries.some((e) => e.action === "user-update"));

    /* Moderation actions must reach the person they happened to. */
    const feed = (await bob.get("/api/notifications")).data.notifications;
    ok("promotion notified the user", feed.some((n) => n.kind === "role"));
    ok("suspension notified the user", feed.some((n) => n.kind === "state"));
  }

  /* ---------------------------------------------------------- password */
  group("password change");
  {
    let r = await alice.post("/api/auth/password", { current: "wrong", next: "newpass123" });
    ok("wrong current password rejected", r.status === 403);

    r = await alice.post("/api/auth/password", { current: "wonderland1", next: "short" });
    ok("weak replacement rejected", r.status === 400);

    /* A second signed-in device for alice, which must be cut loose on change. */
    const other = client();
    await other.post("/api/auth/login", { username: "alice", password: "wonderland1" });
    ok("second device signed in", (await other.get("/api/auth/me")).data.user !== null);

    r = await alice.post("/api/auth/password", { current: "wonderland1", next: "newpass123" });
    ok("password changed", r.status === 200);
    ok("other sessions revoked", (await other.get("/api/auth/me")).data.user === null);
    ok("current session survives", (await alice.get("/api/auth/me")).data.user !== null);

    r = await client().post("/api/auth/login", { username: "alice", password: "wonderland1" });
    ok("old password no longer works", r.status === 401);
    r = await client().post("/api/auth/login", { username: "alice", password: "newpass123" });
    ok("new password works", r.status === 200);
  }

  /* -------------------------------------------------------------- csrf */
  group("csrf & headers");
  {
    const res = await bob.raw("POST", "/api/reports",
      { Origin: "https://evil.example" }, { kind: "user", target: "x", reason: "csrf" });
    ok("cross-origin write rejected", res.status === 403);

    const same = await fetch(base + "/api/health");
    ok("nosniff header set", same.headers.get("x-content-type-options") === "nosniff");
    ok("frame options set", same.headers.get("x-frame-options") === "SAMEORIGIN");
    ok("no x-powered-by", same.headers.get("x-powered-by") === null);
  }

  /* ------------------------------------------------------- rate limits */
  group("rate limiting");
  {
    const c = client();
    let hit429 = false;
    for (let i = 0; i < 16; i++) {
      const r = await c.post("/api/auth/login", { username: "bob", password: "wrong" + i });
      if (r.status === 429) { hit429 = true; break; }
    }
    ok("brute force gets throttled", hit429);
  }

  /* --------------------------------------------- cross-origin deployment */
  group("cross-origin frontend");
  {
    /* A second app instance configured the way a Vercel + Render split is:
       static site on one origin, API on another. */
    const DB2 = path.join(os.tmpdir(), "arcade-cors-" + Date.now() + ".db");
    const saved = { db: process.env.ARCADE_DB, origins: process.env.ALLOWED_ORIGINS };
    process.env.ARCADE_DB = DB2;
    process.env.ALLOWED_ORIGINS = "https://websitegames.vercel.app, https://arcadecampushub.online/";

    for (const key of Object.keys(require.cache)) {
      if (key.includes(path.join("server"))) delete require.cache[key];
    }
    const app2 = require("../app");
    const srv2 = app2.listen(0);
    await new Promise((r) => srv2.once("listening", r));
    const base2 = "http://127.0.0.1:" + srv2.address().port;

    const good = "https://websitegames.vercel.app";
    const evil = "https://not-my-site.example";

    let res = await fetch(base2 + "/api/health", { headers: { Origin: good } });
    ok("allowed origin gets CORS headers",
       res.headers.get("access-control-allow-origin") === good);
    ok("credentials allowed", res.headers.get("access-control-allow-credentials") === "true");
    ok("response varies on origin", /Origin/i.test(res.headers.get("vary") || ""));

    res = await fetch(base2 + "/api/health", { headers: { Origin: evil } });
    ok("unknown origin gets no CORS grant",
       res.headers.get("access-control-allow-origin") === null);

    res = await fetch(base2 + "/api/auth/signup", {
      method: "OPTIONS", headers: { Origin: good }
    });
    ok("preflight from an allowed origin succeeds", res.status === 204);
    ok("preflight advertises the verbs",
       /POST/.test(res.headers.get("access-control-allow-methods") || ""));

    res = await fetch(base2 + "/api/auth/signup", {
      method: "OPTIONS", headers: { Origin: evil }
    });
    ok("preflight from an unknown origin is refused", res.status === 403);

    /* Trailing slashes in the env var must not break matching. */
    res = await fetch(base2 + "/api/health", {
      headers: { Origin: "https://arcadecampushub.online" }
    });
    ok("trailing slash in ALLOWED_ORIGINS is tolerated",
       res.headers.get("access-control-allow-origin") === "https://arcadecampushub.online");

    /* The real test: can a cross-origin frontend actually hold a session? */
    res = await fetch(base2 + "/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: good },
      body: JSON.stringify({ username: "corsuser", password: "crossorigin1" })
    });
    ok("cross-origin signup accepted", res.status === 201, "status " + res.status);

    const cookie = (res.headers.getSetCookie ? res.headers.getSetCookie() : [])[0] || "";
    ok("cookie is SameSite=None", /SameSite=None/i.test(cookie), cookie);
    ok("cookie is Secure", /;\s*Secure/i.test(cookie), cookie);
    ok("cookie stays HttpOnly", /HttpOnly/i.test(cookie));

    const jarValue = cookie.split(";")[0];
    res = await fetch(base2 + "/api/auth/me", {
      headers: { Origin: good, Cookie: jarValue }
    });
    const who = await res.json();
    ok("session works across origins", who.user && who.user.username === "corsuser");

    /* And a forged origin still cannot act with that cookie. */
    res = await fetch(base2 + "/api/users/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Origin: evil, Cookie: jarValue },
      body: JSON.stringify({ bio: "hijacked" })
    });
    ok("stolen-cookie write from a foreign origin is blocked", res.status === 403);

    /* Logout must clear a SameSite=None cookie with matching attributes. */
    res = await fetch(base2 + "/api/auth/logout", {
      method: "POST", headers: { Origin: good, Cookie: jarValue }
    });
    const cleared = (res.headers.getSetCookie ? res.headers.getSetCookie() : [])[0] || "";
    ok("logout cookie matches the set attributes",
       /SameSite=None/i.test(cleared) && /Secure/i.test(cleared) && /Max-Age=0/i.test(cleared),
       cleared);

    srv2.close();
    try { fs.unlinkSync(DB2); fs.unlinkSync(DB2 + "-wal"); fs.unlinkSync(DB2 + "-shm"); } catch {}
    process.env.ARCADE_DB = saved.db;
    if (saved.origins === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = saved.origins;
  }

  /* ----------------------------------------------------- static + 404 */
  group("static hosting");
  {
    const home = await fetch(base + "/index.html");
    ok("serves the site", home.status === 200);
    const missing = await fetch(base + "/api/nothing");
    ok("unknown api endpoint 404s as json", missing.status === 404 &&
       (missing.headers.get("content-type") || "").includes("json"));
    const page = await fetch(base + "/no-such-page");
    ok("unknown page falls back to 404.html", page.status === 404);
  }

  /* ------------------------------------------------------ account wipe */
  group("account deletion");
  {
    const doomed = client();
    await doomed.post("/api/auth/signup", { username: "tempuser", password: "temporary1" });
    let r = await doomed.del("/api/users/me", { confirm: "wrong" });
    ok("wrong confirmation rejected", r.status === 400);
    r = await doomed.del("/api/users/me", { confirm: "tempuser" });
    ok("account deleted", r.status === 200);
    r = await client().post("/api/auth/login", { username: "tempuser", password: "temporary1" });
    ok("deleted account cannot log in", r.status === 401);
  }

  server.close();
  try { fs.unlinkSync(DB); fs.unlinkSync(DB + "-wal"); fs.unlinkSync(DB + "-shm"); } catch {}

  console.log("\n" + "=".repeat(56));
  if (failures.length) {
    console.log(`FAILED ${failures.length} of ${pass + failures.length}`);
    failures.forEach((f) => console.log("  " + f));
    process.exit(1);
  }
  console.log(`All ${pass} API checks passed.`);
})().catch((err) => { console.error(err); process.exit(1); });

/* End-to-end tests for the three systems added last: owner catalogue editing,
   support tickets, and call signalling. Same shape as api.test.js — real app,
   throwaway database, driven over HTTP with real cookies.

     node server/test/live.test.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const DB = path.join(os.tmpdir(), "arcade-live-" + Date.now() + ".db");
process.env.ARCADE_DB = DB;
process.env.NODE_ENV = "test";
process.env.ARCADE_OWNER = "stealzers";

const app = require("../app");

let base;
let pass = 0;
const failures = [];

function ok(label, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + label + (extra ? "  " + extra : "")); }
  else { failures.push(label + (extra ? "  → " + extra : "")); console.log("  FAIL " + label + (extra ? "  → " + extra : "")); }
}

function group(name) { console.log("\n" + name); }

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
      try { data = await res.json(); } catch { /* non-JSON */ }
      return { status: res.status, data };
    },
    get(u) { return this.req("GET", u); },
    post(u, b) { return this.req("POST", u, b); },
    patch(u, b) { return this.req("PATCH", u, b); },
    del(u, b) { return this.req("DELETE", u, b); }
  };
}

async function signup(c, username, display) {
  return c.post("/api/auth/signup", {
    username, password: "hunter2pass", displayName: display || username, acceptedTerms: true
  });
}

/* Make a and b friends. */
async function befriend(a, aName, b, bName) {
  await a.post("/api/friends/request", { username: bName });
  const d = (await b.get("/api/friends")).data;
  const edge = d.incoming.find((u) => u.username === aName);
  if (edge) await b.post(`/api/friends/${edge.edgeId}/accept`);
  return !!edge;
}

async function run() {
  /* --------------------------------------------------------------------- */
  group("setup");

  const owner = client();      // first account + the ARCADE_OWNER name
  const alice = client();
  const bob = client();
  const carol = client();

  let r = await signup(owner, "stealzers", "Stealzers");
  ok("owner signs up", r.status === 201, "status " + r.status);
  ok("owner rank claimed by name", r.data && r.data.user.role === "owner",
     r.data && r.data.user.role);

  await signup(alice, "alice");
  await signup(bob, "bob");
  await signup(carol, "carol");

  ok("alice and bob are friends", await befriend(alice, "alice", bob, "bob"));
  ok("alice and carol are friends", await befriend(alice, "alice", carol, "carol"));

  /* ================================================================ catalogue */
  group("catalogue — owner only");

  r = await alice.post("/api/catalog/custom", {
    id: "sneaky", title: "Sneaky", host: "games-huge", source: "x/index.html"
  });
  ok("a normal account cannot add a game", r.status === 403, "status " + r.status);

  r = await owner.post("/api/catalog/custom", {
    id: "Test Game!!", title: "Test Game", category: "puzzle",
    host: "games-huge", source: "test-game/index.html",
    description: "Added at runtime.", schoolRisk: "low"
  });
  ok("owner adds a game", r.status === 201, "status " + r.status);
  ok("id is slugified", r.data && r.data.game.id === "test-game", r.data && r.data.game.id);

  r = await owner.post("/api/catalog/custom", { id: "no-host", title: "No Host", source: "a/b.html" });
  ok("a bare path with no host is rejected", r.status === 400, "status " + r.status);

  r = await owner.post("/api/catalog/custom", { id: "full-url", title: "Full URL",
    source: "https://example.com/game/index.html" });
  ok("a full URL needs no host", r.status === 201, "status " + r.status);

  r = await owner.post("/api/catalog/custom", { id: "test-game", title: "Test Game Renamed",
    host: "games-huge", source: "test-game/index.html" });
  ok("re-adding the same id updates it", r.status === 201);

  r = await alice.get("/api/catalog/custom");
  ok("anyone may read the overlay", r.status === 200, "status " + r.status);
  ok("the update replaced rather than duplicated",
     r.data.added.filter((g) => g.id === "test-game").length === 1);
  ok("the rename took", r.data.added.find((g) => g.id === "test-game").title === "Test Game Renamed");

  /* Hiding a shipped title leaves a tombstone rather than editing the file. */
  r = await owner.del("/api/catalog/custom/some-shipped-game");
  ok("owner can hide a shipped title", r.status === 200);
  r = await alice.get("/api/catalog/custom");
  ok("the tombstone shows in removed", r.data.removed.includes("some-shipped-game"));

  r = await owner.post("/api/catalog/custom/some-shipped-game/restore");
  ok("restore lifts the tombstone", r.status === 200);
  r = await alice.get("/api/catalog/custom");
  ok("removed is empty again", !r.data.removed.includes("some-shipped-game"));

  r = await owner.post("/api/catalog/custom/never-hidden/restore");
  ok("restoring nothing 404s", r.status === 404, "status " + r.status);

  r = await owner.del("/api/catalog/custom/full-url?hard=1");
  ok("hard delete removes a runtime entry", r.status === 200);
  r = await alice.get("/api/catalog/custom");
  ok("it is gone, not tombstoned",
     !r.data.added.some((g) => g.id === "full-url") && !r.data.removed.includes("full-url"));

  /* ================================================================== support */
  group("support tickets");

  r = await client().post("/api/support", { subject: "Hello there", body: "A".repeat(20) });
  ok("signed-out cannot open a ticket", r.status === 401, "status " + r.status);

  r = await alice.post("/api/support", { subject: "Hi", body: "short" });
  ok("too-short details rejected", r.status === 400, "status " + r.status);

  r = await alice.post("/api/support", {
    category: "saves", subject: "My save vanished",
    body: "I played FNAF World and my progress is gone after switching devices."
  });
  ok("alice opens a ticket", r.status === 201, "status " + r.status);
  const ticketId = r.data.id;

  r = await alice.post("/api/support", { category: "nonsense", subject: "Odd category",
    body: "This category does not exist at all." });
  ok("an unknown category falls back rather than failing", r.status === 201);

  r = await alice.post("/api/support", { subject: "Priority grab",
    body: "Trying to mark my own ticket as high priority.", priority: "high" });
  const grabbed = await alice.get("/api/support/" + r.data.id);
  ok("users cannot self-assign high priority",
     grabbed.data.ticket.priority === "normal", grabbed.data.ticket.priority);

  r = await bob.get("/api/support/" + ticketId);
  ok("another user cannot read someone's ticket", r.status === 403, "status " + r.status);

  r = await alice.get("/api/support/" + ticketId);
  ok("alice reads her own ticket", r.status === 200);
  ok("the opening post is the first message", r.data.messages.length === 1);
  ok("it is not marked as staff", r.data.messages[0].staff === false);

  r = await bob.get("/api/admin/support?state=open");
  ok("a normal account cannot see the queue", r.status === 403, "status " + r.status);

  r = await owner.get("/api/admin/support?state=open");
  ok("staff see the queue", r.status === 200, "status " + r.status);
  ok("alice's ticket is in it", r.data.tickets.some((t) => t.id === ticketId));
  ok("the queue carries the opening text",
     !!r.data.tickets.find((t) => t.id === ticketId).opening);

  r = await bob.post(`/api/support/${ticketId}/reply`, { body: "Let me in" });
  ok("a stranger cannot reply", r.status === 403, "status " + r.status);

  r = await owner.post(`/api/support/${ticketId}/reply`, {
    body: "Which device did you play on first? I can look at the sync record."
  });
  ok("staff reply accepted", r.status === 201, "status " + r.status);

  r = await alice.get("/api/support/" + ticketId);
  ok("the reply is in the thread", r.data.messages.length === 2);
  ok("it is flagged as staff", r.data.messages[1].staff === true);
  ok("a staff reply parks it on the user", r.data.ticket.state === "waiting",
     r.data.ticket.state);

  r = await alice.post(`/api/support/${ticketId}/reply`, { body: "Chromebook at school first." });
  ok("the user replies", r.status === 201);
  r = await alice.get("/api/support/" + ticketId);
  ok("a user reply hands it back to staff", r.data.ticket.state === "open", r.data.ticket.state);

  r = await alice.patch("/api/support/" + ticketId, { priority: "high" });
  ok("users cannot set priority", r.status === 400, "status " + r.status);

  r = await owner.patch("/api/support/" + ticketId, { priority: "high" });
  ok("staff can set priority", r.status === 200);

  r = await bob.patch("/api/support/" + ticketId, { state: "closed" });
  ok("a stranger cannot close it", r.status === 403, "status " + r.status);

  r = await alice.patch("/api/support/" + ticketId, { state: "closed" });
  ok("the owner of the ticket can close it", r.status === 200);

  r = await alice.post(`/api/support/${ticketId}/reply`, { body: "One more thing" });
  ok("a closed ticket refuses user replies", r.status === 409, "status " + r.status);

  r = await owner.post(`/api/support/${ticketId}/reply`, { body: "Staff can still add notes." });
  ok("staff can still reply to a closed ticket", r.status === 201, "status " + r.status);

  r = await alice.patch("/api/support/" + ticketId, { state: "open" });
  ok("users cannot reopen", r.status === 400, "status " + r.status);
  r = await owner.patch("/api/support/" + ticketId, { state: "open" });
  ok("staff can reopen", r.status === 200);

  /* The open-ticket cap keeps one person from filling the queue. */
  for (let i = 0; i < 6; i++) {
    r = await bob.post("/api/support", {
      subject: "Ticket number " + i, body: "Filling the queue up, entry " + i + "."
    });
  }
  ok("open tickets are capped per account", r.status === 400, "status " + r.status);

  r = await alice.get("/api/support");
  ok("alice lists her own tickets", r.status === 200);
  ok("she sees only hers", r.data.tickets.every((t) => t.from === "alice"));
  ok("reply counts are included", r.data.tickets.find((t) => t.id === ticketId).replies >= 4);

  /* ==================================================================== calls */
  group("calling");

  r = await alice.get("/api/calls/ice");
  ok("ice servers are handed out", r.status === 200 && r.data.iceServers.length > 0);
  ok("a free STUN server is in the list",
     JSON.stringify(r.data.iceServers).includes("stun:"));
  ok("the peer ceiling is stated", r.data.maxPeers >= 2);

  r = await alice.post("/api/calls", { userId: 999999, kind: "audio" });
  ok("you cannot call a stranger", r.status === 400, "status " + r.status);

  const bobMe = (await bob.get("/api/auth/me")).data.user;
  const aliceMe = (await alice.get("/api/auth/me")).data.user;
  const carolMe = (await carol.get("/api/auth/me")).data.user;

  r = await bob.post("/api/calls", { userId: carolMe.id, kind: "audio" });
  ok("bob cannot call carol — not friends", r.status === 400, "status " + r.status);

  r = await alice.post("/api/calls", { userId: bobMe.id, kind: "video" });
  ok("alice calls bob", r.status === 201, "status " + r.status);
  const callId = r.data.call.id;
  ok("the call starts ringing", r.data.call.state === "ringing", r.data.call.state);
  ok("both people are on it", r.data.call.peers.length === 2);
  ok("ice servers come back with it", r.data.iceServers.length > 0);

  r = await bob.get("/api/calls/pending");
  ok("bob sees it ringing", r.data.calls.some((c) => c.id === callId));

  r = await carol.get("/api/calls/pending");
  ok("carol sees nothing", !r.data.calls.some((c) => c.id === callId));

  r = await carol.post(`/api/calls/${callId}/join`, {});
  ok("an uninvited account cannot join", r.status === 403, "status " + r.status);

  r = await carol.get(`/api/calls/${callId}/signal`);
  ok("an uninvited account cannot read signals", r.status === 403, "status " + r.status);

  r = await carol.post(`/api/calls/${callId}/signal`, {
    to: bobMe.id, kind: "offer", payload: { sdp: "x" }
  });
  ok("an uninvited account cannot inject signals", r.status === 403, "status " + r.status);

  r = await bob.post(`/api/calls/${callId}/join`, {});
  ok("bob joins", r.status === 200, "status " + r.status);
  ok("the call goes live", r.data.call.state === "live", r.data.call.state);
  ok("join reports who you are", r.data.self === bobMe.id);

  r = await alice.post(`/api/calls/${callId}/signal`, {
    to: bobMe.id, kind: "offer", payload: { type: "offer", sdp: "v=0 fake" }
  });
  ok("alice sends an offer", r.status === 201, "status " + r.status);

  r = await alice.post(`/api/calls/${callId}/signal`, {
    to: bobMe.id, kind: "shout", payload: {}
  });
  ok("an unknown signal kind is rejected", r.status === 400, "status " + r.status);

  r = await alice.post(`/api/calls/${callId}/signal`, {
    to: carolMe.id, kind: "ice", payload: {}
  });
  ok("you cannot signal someone outside the call", r.status === 400, "status " + r.status);

  r = await alice.post(`/api/calls/${callId}/signal`, {
    to: bobMe.id, kind: "ice", payload: { candidate: "z".repeat(20000) }
  });
  ok("an oversized signal is rejected", r.status === 400, "status " + r.status);

  r = await bob.get(`/api/calls/${callId}/signal`);
  ok("bob receives the offer", r.status === 200 && r.data.signals.length === 1,
     "got " + (r.data.signals || []).length);
  ok("the sender is named", r.data.signals[0].from === aliceMe.id);
  ok("the payload survives the round trip", r.data.signals[0].payload.sdp === "v=0 fake");

  r = await bob.get(`/api/calls/${callId}/signal`);
  ok("signals are delivered once and consumed", r.data.signals.length === 0);

  r = await bob.post(`/api/calls/${callId}/leave`, {});
  ok("bob leaves", r.status === 200);
  ok("a two-person call ends when one leaves", r.data.ended === true);

  r = await alice.get(`/api/calls/${callId}/signal`);
  ok("alice gets the goodbye", r.data.signals.some((s) => s.kind === "bye"));
  ok("the call reads as ended", r.data.call.state === "ended", r.data.call && r.data.call.state);

  r = await alice.post(`/api/calls/${callId}/signal`, { to: bobMe.id, kind: "ice", payload: {} });
  ok("you cannot signal into an ended call", r.status === 409, "status " + r.status);

  /* --- group call --- */
  const trio = await alice.post("/api/calls", { userId: bobMe.id, kind: "audio" });
  const trioId = trio.data.call.id;
  await bob.post(`/api/calls/${trioId}/join`, {});

  r = await alice.post("/api/calls", { userId: bobMe.id, kind: "audio" });
  ok("starting a second call is allowed by the server", r.status === 201);
  await alice.post(`/api/calls/${r.data.call.id}/leave`, {});

  /* A thread call invites the whole thread. */
  const g = await alice.post("/api/threads/group", {
    title: "Squad", usernames: ["bob", "carol"]
  });
  ok("group thread created", g.status === 201, "status " + g.status);

  r = await alice.post("/api/calls", { threadId: g.data.thread.id, kind: "audio" });
  ok("calling a thread invites everyone in it", r.status === 201, "status " + r.status);
  ok("three peers on the call", r.data.call.peers.length === 3,
     r.data.call && r.data.call.peers.length);

  const groupCall = r.data.call.id;
  await bob.post(`/api/calls/${groupCall}/join`, {});
  await carol.post(`/api/calls/${groupCall}/join`, {});

  r = await bob.post(`/api/calls/${groupCall}/leave`, {});
  ok("a three-way survives one person leaving", r.data.ended === false);

  r = await carol.get(`/api/calls/${groupCall}/signal`);
  ok("the call is still live for the rest", r.data.call.state === "live", r.data.call.state);

  r = await bob.post("/api/calls", { threadId: g.data.thread.id, kind: "audio" });
  ok("a thread member may also start the call", r.status === 201, "status " + r.status);

  const outsider = client();
  await signup(outsider, "dave");
  r = await outsider.post("/api/calls", { threadId: g.data.thread.id, kind: "audio" });
  ok("a non-member cannot call the thread", r.status === 403, "status " + r.status);

  /* The mesh only scales so far, and the server has to say no rather than
     let five people melt each other's uplink. */
  const names = ["erin", "frank", "grace", "heidi"];
  for (const n of names) {
    const c = client();
    await signup(c, n);
    await befriend(alice, "alice", c, n);      // groups are friends-only to build
  }
  const big = await alice.post("/api/threads/group", {
    title: "Too many", usernames: ["bob", "carol", ...names]
  });
  ok("a big group thread is fine", big.status === 201, "status " + big.status);
  r = await alice.post("/api/calls", { threadId: big.data.thread.id, kind: "audio" });
  ok("a call bigger than the mesh handles is refused", r.status === 400, "status " + r.status);
  ok("and it says why", /relay|people/i.test((r.data && r.data.error) || ""),
     r.data && r.data.error);

  /* Blocking has to cut the call path too, not just messages. */
  await alice.post("/api/friends/block", { username: "carol" });
  r = await alice.post("/api/calls", { userId: carolMe.id, kind: "audio" });
  ok("you cannot call someone you blocked", r.status === 400, "status " + r.status);
  r = await carol.post("/api/calls", { userId: aliceMe.id, kind: "audio" });
  ok("someone who blocked you cannot call you either", r.status === 400, "status " + r.status);

  /* ------------------------------------------------------- deploy headers */
  group("headers, both deployments");

  /* The site ships from two places — this Express app, and Vercel in
     production — and each sets its own security headers. They drifted once
     already: Permissions-Policy was fixed here to allow the microphone and
     camera for calling, and vercel.json kept the empty allowlist, so calling
     was blocked on the live site only, silently. Assert they agree. */
  {
    const vercel = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "..", "vercel.json"), "utf8"));

    const catchAll = vercel.headers.find((h) => h.source === "/(.*)");
    ok("vercel.json has a catch-all header block", !!catchAll);

    const pp = catchAll && catchAll.headers.find((h) => h.key === "Permissions-Policy");
    ok("it sets Permissions-Policy", !!pp);

    const res = await fetch(base + "/index.html");
    const here = res.headers.get("permissions-policy") || "";

    ok("the two deployments send the same Permissions-Policy",
       !!pp && pp.value === here, "vercel=" + (pp && pp.value) + "  node=" + here);

    /* The specific thing that broke: an empty allowlist blocks getUserMedia
       before the permission prompt can appear, so calling cannot work at all. */
    const value = (pp && pp.value) || "";
    ok("the microphone is not switched off outright", !/microphone=\(\)/.test(value), value);
    ok("the camera is not switched off outright", !/camera=\(\)/.test(value), value);
    ok("screen sharing is allowed", /display-capture=\(self\)/.test(value));

    /* Script URLs carry no content hash, so a long max-age ships new HTML
       against stale JS — which reads as a broken feature, not a cache. */
    const scripts = vercel.headers.find((h) => h.source === "/(css|js)/(.*)");
    ok("css and js have their own cache rule", !!scripts);
    const cc = scripts && scripts.headers.find((h) => h.key === "Cache-Control");
    ok("un-hashed scripts revalidate every time",
       !!cc && /max-age=0/.test(cc.value), cc && cc.value);
  }

  /* --------------------------------------------------------------------- */
  console.log("\n" + "=".repeat(56));
  if (failures.length) {
    console.log(failures.length + " FAILED of " + (pass + failures.length) + ":");
    failures.forEach((f) => console.log("  · " + f));
    process.exitCode = 1;
  } else {
    console.log("All " + pass + " checks passed.");
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

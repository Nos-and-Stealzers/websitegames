/* End-to-end pass over js/api-supabase.js — the adapter the live site runs.
 *
 * The Node backend has had a suite since it was written; this side had none,
 * which is why bugs in it reached the site. Nothing is mocked below the
 * adapter: every call lands in a real Postgres with supabase/schema.sql
 * applied, as the `authenticated` role, so row-level security answers.
 *
 *   node tools/test-supabase.js                  # needs PGHOST/PGPORT/PGUSER
 *   PGDATABASE=arch node tools/test-supabase.js
 *
 * supabase/test/run.sh starts a throwaway cluster and runs this for you.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { Stub } = require("./postgrest-stub.js");

const ROOT = path.join(__dirname, "..");

let pass = 0;
const failures = [];

function ok(label, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + label + (extra ? "   " + extra : "")); }
  else {
    failures.push(label + (extra ? " → " + extra : ""));
    console.log("  FAIL " + label + (extra ? "   " + extra : ""));
  }
}
function group(name) { console.log("\n" + name); }

async function throws(label, promise, want) {
  try {
    await promise;
    ok(label, false, "no error raised");
  } catch (e) {
    const hit = !want || String(e.message).toLowerCase().includes(want.toLowerCase());
    ok(label, hit, hit ? "" : e.message);
  }
}

/* ---------------------------------------------------------------- loader */

/* Loads the adapter into a bare window, so the file under test is the exact
   file the browser gets. */
function loadAdapter(stub) {
  const store = new Map();
  const sandbox = {
    console,
    setTimeout, clearTimeout, Promise, JSON, Math, Date, Object, Array, String,
    Number, Boolean, Error, encodeURIComponent, decodeURIComponent, isNaN, parseInt, parseFloat
  };
  sandbox.navigator = { userAgent: "test-suite" };
  sandbox.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };
  sandbox.window = sandbox;
  sandbox.fetch = stub.fetch();
  sandbox.URL = URL;
  sandbox.SITE = {
    domain: "arcade.test",
    backend: "supabase",
    supabase: { url: "https://stub.local", anonKey: "anon-key" }
  };

  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(ROOT, "js", "api-supabase.js"), "utf8");
  vm.runInContext(src, sandbox, { filename: "js/api-supabase.js" });
  if (!sandbox.API) throw new Error("api-supabase.js did not install window.API");
  sandbox.API.__clear = () => store.clear();
  return sandbox.API;
}

/* --------------------------------------------------------------- fixture */

async function freshSchema(stub) {
  const files = [
    path.join(ROOT, "supabase", "test", "00-supabase-stub.sql"),
    path.join(ROOT, "supabase", "schema.sql")
  ];
  await stub.asOwnerRole("drop schema if exists public cascade");
  await stub.asOwnerRole("drop schema if exists auth cascade");
  await stub.asOwnerRole("create schema public");
  await stub.asOwnerRole("create extension if not exists citext");
  for (const f of files) {
    await stub.asOwnerRole(fs.readFileSync(f, "utf8"));
  }
}

/* Each account gets its own adapter instance, which is what two browsers
   signed in as two people actually is. */
async function account(stub, username, password) {
  const api = loadAdapter(stub);
  await api.signup(username, password || "correct horse", username);
  return api;
}

/* ------------------------------------------------------------------ main */

async function main() {
  const stub = new Stub({
    host: process.env.PGHOST || "127.0.0.1",
    port: Number(process.env.PGPORT || 55432),
    user: process.env.PGUSER || "postgres",
    database: process.env.PGDATABASE || "arch"
  });
  await stub.connect();
  await freshSchema(stub);

  /* ------------------------------------------------------------ sign in */
  group("sign in");

  const owner = loadAdapter(stub);
  ok("the backend reports itself available", await owner.available() === true);

  const first = await owner.signup("Stealzers", "hunter2 hunter2", "Stealzers");
  ok("the first account signs up", !!first.user, JSON.stringify(first.user || {}));
  ok("...and lands on the owner rank", first.user && first.user.role === "owner",
     first.user && first.user.role);
  ok("...and is reported as the first account", first.firstAccount === true);
  ok("...and is signed in straight away", (await owner.me()).user !== null);

  const alice = await account(stub, "alice");
  const bob = await account(stub, "bob");
  const carol = await account(stub, "carol");
  const dave = await account(stub, "dave");

  ok("a later account is a plain user",
     (await alice.me()).user.role === "user", (await alice.me()).user.role);

  await throws("the same name cannot be taken twice",
               loadAdapter(stub).signup("alice", "another one", "alice"), "");

  const aliceAgain = loadAdapter(stub);
  const signedIn = await aliceAgain.login("alice", "correct horse");
  ok("signing in works", signedIn.user && signedIn.user.username === "alice",
     JSON.stringify(signedIn.user || {}));
  await throws("a wrong password is refused",
               loadAdapter(stub).login("alice", "nope"), "wrong username or password");
  await throws("an unknown account is refused the same way",
               loadAdapter(stub).login("nobody", "correct horse"), "wrong username or password");

  ok("a signed-in session survives a reload",
     (await aliceAgain.me()).user.username === "alice");
  await aliceAgain.logout();
  ok("signing out clears the session", (await aliceAgain.me()).user === null);

  ok("the profile carries a friend code",
     !!(await alice.me()).user.friendCode, (await alice.me()).user.friendCode);

  await alice.updateProfile({ displayName: "Alice A", bio: "hi" });
  ok("editing the profile sticks", (await alice.me()).user.displayName === "Alice A",
     (await alice.me()).user.displayName);

  /* ------------------------------------------------------------ friends */
  group("friends");

  await alice.addFriend("bob");
  const bobRequests = await bob.friends();
  ok("the request reaches the other side", bobRequests.incoming.length === 1,
     JSON.stringify(bobRequests.incoming));
  ok("...and carries an edge id to act on",
     bobRequests.incoming[0] && bobRequests.incoming[0].edgeId != null,
     JSON.stringify(bobRequests.incoming[0] || {}));
  await bob.acceptFriend(bobRequests.incoming[0].edgeId);
  ok("accepting makes them friends", (await alice.friends()).friends.length === 1);
  ok("...and tells the requester",
     (await alice.notifications()).notifications.some((n) => n.kind === "friend-accept"),
     JSON.stringify((await alice.notifications()).notifications.map((n) => n.kind)));

  for (const [a, b] of [[alice, carol], [bob, carol]]) {
    await a.addFriend((await b.me()).user.username);
    const inbox = await b.friends();
    await b.acceptFriend(inbox.incoming[0].edgeId);
  }

  const code = (await bob.me()).user.friendCode;
  const found = await alice.lookupCode(code);
  ok("a friend code finds the account", found && found.user && found.user.username === "bob",
     JSON.stringify(found || {}));

  const searched = await alice.searchUsers("bo");
  ok("search finds people", searched.users.some((u) => u.username === "bob"),
     JSON.stringify(searched.users.map((u) => u.username)));

  /* ----------------------------------------------------------- messages */
  group("direct messages");

  const opened = await alice.openThread("bob");
  ok("opening a conversation works", opened.threadId > 0, JSON.stringify(opened));
  await alice.send(opened.threadId, "hello bob");

  const aliceList = await alice.threads();
  ok("the conversation is in the list", aliceList.threads.length === 1,
     JSON.stringify(aliceList.threads));
  ok("...with a preview", aliceList.threads[0].preview &&
     aliceList.threads[0].preview.body === "hello bob",
     JSON.stringify(aliceList.threads[0].preview));
  ok("...and names the other person", aliceList.threads[0].title === "bob",
     aliceList.threads[0].title);

  const bobBadges = await bob.unread();
  ok("the recipient gets an unread badge", bobBadges.messages === 1, JSON.stringify(bobBadges));

  const bobThread = await bob.thread(opened.threadId);
  ok("the recipient can read the message", bobThread.messages.length === 1,
     JSON.stringify(bobThread.messages));
  ok("...and it names the sender",
     bobThread.messages[0] && bobThread.messages[0].from.displayName === "Alice A",
     JSON.stringify(bobThread.messages[0] && bobThread.messages[0].from));
  ok("...and the thread says posting is allowed", bobThread.canSend === true,
     bobThread.lockedReason);
  ok("reading it clears the badge", (await bob.unread()).messages === 0,
     JSON.stringify(await bob.unread()));

  const since = bobThread.messages[0].id;
  await alice.send(opened.threadId, "still there?");
  const delta = await bob.thread(opened.threadId, since);
  ok("the incremental poll returns only what is new", delta.messages.length === 1,
     JSON.stringify(delta.messages.map((m) => m.body)));

  await throws("an outsider cannot read the conversation",
               dave.thread(opened.threadId), "no such thread");
  await throws("an outsider cannot post into it",
               dave.send(opened.threadId, "intruding"), "");

  await alice.deleteMessage(delta.messages[0].id);
  const afterRetract = await bob.thread(opened.threadId);
  ok("a retracted message reads as removed",
     afterRetract.messages.some((m) => m.deleted), JSON.stringify(afterRetract.messages));
  await throws("nobody can retract someone else's message",
               bob.deleteMessage(afterRetract.messages[0].id), "not yours");

  /* ------------------------------------------------------------- groups */
  group("group chats");

  const grp = (await alice.createGroup("Study", ["bob", "carol"])).thread;
  ok("a group opens", grp.id > 0, JSON.stringify(grp));
  await alice.send(grp.id, "meet at six");

  const carolGroup = (await carol.threads()).threads.filter((t) => t.isGroup)[0];
  ok("members see the group", !!carolGroup, JSON.stringify((await carol.threads()).threads));
  ok("...under its title", carolGroup && carolGroup.title === "Study", carolGroup && carolGroup.title);
  ok("...with everyone else listed", carolGroup && carolGroup.memberCount === 3,
     carolGroup && String(carolGroup.memberCount));
  ok("a group message counts toward the badge", (await carol.unread()).messages === 1,
     JSON.stringify(await carol.unread()));

  const carolView = await carol.thread(grp.id);
  ok("a member reads the group", carolView.messages.length === 1);
  ok("...and is told it is a group", carolView.isGroup === true);
  ok("...and is not the owner", carolView.owner === false);

  await alice.renameGroup(grp.id, "Study Hall");
  ok("the owner can rename it",
     (await carol.thread(grp.id)).title === "Study Hall",
     (await carol.thread(grp.id)).title);
  await throws("a member cannot rename it",
               carol.renameGroup(grp.id, "Mine"), "only the owner");
  await throws("a stranger cannot be added",
               alice.addToGroup(grp.id, "dave"), "friends");
  await throws("an outsider sees nothing of it", dave.thread(grp.id), "no such thread");

  await carol.removeFromGroup(grp.id, (await carol.me()).user.id);
  ok("leaving works", (await carol.threads()).threads.filter((t) => t.isGroup).length === 0);
  await alice.addToGroup(grp.id, "carol");
  ok("...and rejoining by invitation works",
     (await carol.threads()).threads.filter((t) => t.isGroup).length === 1);

  /* -------------------------------------------------------------- calls */
  group("calling");

  await throws("you cannot call a stranger", dave.startCall({ userId: (await alice.me()).user.id }),
               "only call friends");

  const started = (await alice.startCall({ userId: (await bob.me()).user.id, kind: "video" })).call;
  ok("a call starts", started && started.id > 0, JSON.stringify(started));

  const ringing = await bob.pendingCalls();
  ok("the callee hears it ring", ringing.calls.length === 1, JSON.stringify(ringing));
  ok("...and knows it is a video call", ringing.calls[0] && ringing.calls[0].kind === "video",
     ringing.calls[0] && ringing.calls[0].kind);
  ok("...and knows who is calling",
     ringing.calls[0] && ringing.calls[0].peers.some((p) => p.username === "alice"),
     JSON.stringify(ringing.calls[0] && ringing.calls[0].peers));
  ok("the callee is notified",
     (await bob.notifications()).notifications.some((n) => n.kind === "call"));
  ok("an outsider hears nothing", (await dave.pendingCalls()).calls.length === 0);

  await bob.joinCall(started.id);
  await bob.sendSignal(started.id, (await alice.me()).user.id, "offer", { sdp: "x" });
  const signals = await alice.pollSignals(started.id);
  ok("the handshake arrives", signals.signals.length === 1, JSON.stringify(signals.signals));
  ok("...with its payload intact",
     signals.signals[0] && signals.signals[0].payload.sdp === "x",
     JSON.stringify(signals.signals[0] && signals.signals[0].payload));
  ok("...and the call reads as live", signals.call && signals.call.state === "live",
     signals.call && signals.call.state);
  ok("a signal is delivered once",
     (await alice.pollSignals(started.id)).signals.length === 0);
  await throws("an outsider cannot poll the call", dave.pollSignals(started.id), "not in that call");

  await alice.leaveCall(started.id);
  const bye = await bob.pollSignals(started.id);
  ok("hanging up sends a bye", bye.signals.some((s) => s.kind === "bye"),
     JSON.stringify(bye.signals));
  ok("...and the call is over", (await bob.pendingCalls()).calls.length === 0);

  const groupCall = (await alice.startCall({ threadId: grp.id, kind: "audio" })).call;
  ok("a group call rings everyone else",
     (await bob.pendingCalls()).calls.length === 1 &&
     (await carol.pendingCalls()).calls.length === 1);
  await bob.leaveCall(groupCall.id);
  await carol.leaveCall(groupCall.id);
  await alice.leaveCall(groupCall.id);

  /* --------------------------------------------------------- cloud save */
  group("cloud saves");

  const synced = await alice.putSave({
    favorites: ["pac"], recents: ["pac"],
    stats: { pac: { plays: 2, seconds: 60, last: 1 } }
  });
  ok("the first sync stores a save", synced.save.stats.pac.plays === 2,
     JSON.stringify(synced.save.stats));

  const merged = await alice.putSave({
    favorites: ["dig"], stats: { pac: { plays: 5, seconds: 90, last: 2 } }
  });
  ok("a second sync merges rather than replaces", merged.save.stats.pac.plays === 5,
     JSON.stringify(merged.save.stats));
  ok("...and keeps the earlier favourite", merged.save.favorites.indexOf("pac") !== -1,
     JSON.stringify(merged.save.favorites));

  const rollback = await alice.putSave({ stats: { pac: { plays: 1, seconds: 10, last: 1 } } });
  ok("a stale device cannot roll the totals back", rollback.save.stats.pac.plays === 5,
     JSON.stringify(rollback.save.stats));

  const pulled = await alice.getSave();
  ok("the save reads back", pulled.save && pulled.save.stats.pac.seconds === 90,
     JSON.stringify(pulled.save && pulled.save.stats));
  ok("...on a second device too",
     (await aliceAgain.login("alice", "correct horse"), (await aliceAgain.getSave()).save
       .stats.pac.seconds) === 90);
  ok("someone else's save is not readable",
     JSON.stringify((await bob.getSave()).save || {}) !== JSON.stringify(pulled.save));

  await alice.putGameSave("hd_fnaf", { "fnaf1": "{\"stars\":1}" });
  const back = await alice.getGameSave("hd_fnaf");
  ok("per-game progress saves and reads back",
     back.payload && back.payload.fnaf1 === "{\"stars\":1}", JSON.stringify(back));
  ok("...and is listed", (await alice.listGameSaves()).hosts.some((h) => h.host === "hd_fnaf"),
     JSON.stringify((await alice.listGameSaves()).hosts));
  ok("...and nobody else can read it",
     Object.keys((await bob.getGameSave("hd_fnaf")).payload || {}).length === 0,
     JSON.stringify(await bob.getGameSave("hd_fnaf")));
  await alice.dropGameSave("hd_fnaf");
  ok("...and can be dropped", (await alice.listGameSaves()).hosts.length === 0);

  ok("the leaderboard counted the plays",
     (await alice.popular()).games.some((g) => g.id === "pac"),
     JSON.stringify((await alice.popular()).games));

  /* -------------------------------------------------------------- admin */
  group("admin console");

  await throws("a plain user cannot open the overview", alice.adminOverview(), "access");
  await throws("a plain user cannot list accounts", alice.adminUsers(), "access");
  await throws("a plain user cannot read the audit trail", alice.adminAudit(), "staff");
  await throws("a plain user cannot see who is online", alice.adminLive(), "staff");
  await throws("a plain user cannot read the sign-in log", alice.adminLogins(), "staff");
  await throws("a plain user cannot read reports", alice.adminReports(), "staff");
  await throws("a plain user cannot read the ticket queue", alice.adminTickets(), "staff");
  await throws("a plain user cannot promote anybody",
               alice.adminUpdateUser((await bob.me()).user.id, { role: "admin" }), "access");

  const overview = await owner.adminOverview();
  ok("the owner reads the overview", overview.users.total === 5, JSON.stringify(overview.users));
  const users = await owner.adminUsers();
  ok("...and lists every account", users.users.length === 5, String(users.users.length));
  ok("...and can search them", (await owner.adminUsers("ali")).users.length === 1,
     JSON.stringify((await owner.adminUsers("ali")).users.map((u) => u.username)));

  const bobId = (await bob.me()).user.id;
  await owner.adminUpdateUser(bobId, { role: "mod" });
  ok("promoting works", (await bob.me()).user.role === "mod", (await bob.me()).user.role);
  ok("...and is written to the audit trail",
     (await owner.adminAudit()).entries.some((a) => a.action === "user-update"),
     JSON.stringify((await owner.adminAudit()).entries.map((a) => a.action)));
  ok("the promoted account is told",
     (await bob.notifications()).notifications.some((n) => n.kind === "role"));

  await throws("a mod cannot promote anybody",
               bob.adminUpdateUser((await carol.me()).user.id, { role: "mod" }), "administrators");
  ok("a mod can read the report queue", Array.isArray((await bob.adminReports()).reports));
  ok("a mod can read the ticket queue", Array.isArray((await bob.adminTickets()).tickets));

  await alice.report("user", "dave", "spam");
  const queue = await owner.adminReports("open");
  ok("a report reaches the queue", queue.reports.length === 1, JSON.stringify(queue.reports));
  await owner.adminCloseReport(queue.reports[0].id, "closed");
  ok("...and can be closed", (await owner.adminReports("open")).reports.length === 0);
  ok("...and the reporter is told",
     (await alice.notifications()).notifications.some((n) => n.kind === "report"));

  await alice.sendFeedback({ kind: "bug", subject: "Sound", body: "There is no audio in Pac at all." });
  const fb = await owner.adminFeedback("new");
  ok("feedback reaches the console", fb.feedback.length === 1, JSON.stringify(fb.feedback));
  await owner.adminUpdateFeedback(fb.feedback[0].id, { reply: "Fixed, thanks.", state: "done" });
  ok("...and can be answered",
     (await alice.myFeedback()).feedback[0].reply === "Fixed, thanks.",
     JSON.stringify((await alice.myFeedback()).feedback[0]));

  const ticket = await alice.openTicket({ subject: "Cannot save", body: "My progress vanishes every time I close the tab.", category: "bug" });
  ok("a support ticket opens", ticket.id > 0, JSON.stringify(ticket));
  ok("...and the owner sees it in the queue",
     (await owner.adminTickets("open")).tickets.length === 1,
     JSON.stringify((await owner.adminTickets("open")).tickets));
  ok("...and the person who raised it sees it",
     (await alice.myTickets()).tickets.length === 1);
  await owner.replyTicket(ticket.id, "Looking now.");
  const thread = await alice.ticket(ticket.id);
  ok("...and a staff reply reaches them", thread.messages.length === 2,
     JSON.stringify(thread.messages.map((m) => m.body)));
  await throws("someone else's ticket is not readable", dave.ticket(ticket.id), "no such ticket");
  await owner.updateTicket(ticket.id, { state: "closed" });
  ok("...and it can be closed",
     (await owner.adminTickets("closed")).tickets.length === 1);

  await owner.saveCatalogEntry({ id: "tetra", title: "Tetra", category: "puzzle",
                                host: "games-huge", path: "tetra/index.html" });
  ok("the owner adds a game", (await alice.customCatalog()).added.some((g) => g.id === "tetra"),
     JSON.stringify((await alice.customCatalog()).added.map((g) => g.id)));
  await owner.removeCatalogEntry("tetra");
  ok("...and can hide it",
     (await alice.customCatalog()).removed.indexOf("tetra") !== -1,
     JSON.stringify(await alice.customCatalog()));
  await owner.restoreCatalogEntry("tetra");
  const restored = await alice.customCatalog();
  ok("...and restoring brings the game back, not a blank",
     restored.added.some((g) => g.id === "tetra" && g.title === "Tetra"),
     JSON.stringify(restored));

  const daveId = (await dave.me()).user.id;
  await owner.adminUpdateUser(daveId, { state: "suspended" });
  ok("suspending works", (await owner.adminUsers("dave")).users[0].state === "suspended");
  await throws("a suspended account cannot start a conversation",
               dave.openThread("alice"), "suspended");
  await throws("a suspended account cannot call anybody",
               dave.startCall({ userId: (await alice.me()).user.id }), "suspended");
  await owner.adminUpdateUser(daveId, { state: "active" });
  ok("reinstating works", (await owner.adminUsers("dave")).users[0].state === "active");

  await owner.adminDeleteUser(daveId);
  ok("deleting an account works", (await owner.adminUsers()).users.length === 4,
     String((await owner.adminUsers()).users.length));

  const live = await owner.adminLive();
  ok("the live view answers", Array.isArray(live.users) && live.online === live.users.length,
     JSON.stringify(live));
  ok("the sign-in log answers", Array.isArray((await owner.adminLogins()).logins),
     JSON.stringify(await owner.adminLogins()));

  /* ------------------------------------------------- blocking and privacy */
  group("blocking and privacy");

  const erin = await account(stub, "erin");
  const frank = await account(stub, "frank");

  await erin.addFriend("frank");
  await frank.acceptFriend((await frank.friends()).incoming[0].edgeId);
  const erinFrank = await erin.openThread("frank");
  await erin.send(erinFrank.threadId, "hi frank");

  await frank.blockUser("erin");
  ok("blocking drops the friendship", (await frank.friends()).friends.length === 0,
     JSON.stringify((await frank.friends()).friends));
  const blockedView = await erin.thread(erinFrank.threadId);
  ok("the blocked person is told they cannot post", blockedView.canSend === false,
     blockedView.lockedReason);
  await throws("...and posting is actually refused",
               erin.send(erinFrank.threadId, "still here"), "");
  await throws("...and calling is refused too",
               erin.startCall({ userId: (await frank.me()).user.id }), "");
  await throws("a blocked person cannot be found by name", erin.user("frank"), "no such user");

  await carol.updateProfile({ acceptsDms: false });
  await throws("friends-only DMs turn strangers away",
               frank.openThread("carol"), "only accepts messages from friends");
  ok("...but a friend still gets through",
     (await alice.openThread("carol")).threadId > 0);
  await carol.updateProfile({ acceptsDms: true });

  /* ------------------------------------------------------------- images */
  group("images in messages");

  const pixel = "data:image/png;base64," +
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const sent = await alice.send(opened.id || opened.threadId, "look", {
    dataUrl: pixel, width: 1, height: 1, kind: "upload"
  });
  ok("an image posts", !!sent.message, JSON.stringify(sent.message || {}));
  const withImage = await bob.thread(opened.threadId);
  const shot = withImage.messages.filter((m) => m.image)[0];
  ok("...and the other side sees it", !!shot, JSON.stringify(withImage.messages.slice(-1)));
  ok("...with its dimensions", shot && shot.image.width === 1 && shot.image.mime === "image/png",
     JSON.stringify(shot && shot.image));
  const data = await shot.image.fetchData();
  ok("...and the bytes load", data.indexOf("data:image/png;base64,") === 0, data.slice(0, 30));
  await throws("a non-image attachment is refused",
               alice.send(opened.threadId, "nope",
                          { dataUrl: "data:text/html;base64,PHNjcmlwdD4=", width: 1, height: 1 }),
               "jpeg");

  await alice.deleteMessage(shot.id);
  const gone = await bob.thread(opened.threadId);
  ok("retracting takes the image with it",
     gone.messages.filter((m) => m.image).length === 0);

  /* ------------------------------------------------------ notifications */
  group("notifications");

  const feed = await bob.notifications();
  ok("the feed has entries", feed.notifications.length > 0, String(feed.notifications.length));
  ok("...and names who caused them",
     feed.notifications.every((n) => n.actor === null || !!n.actor.username),
     JSON.stringify(feed.notifications.map((n) => n.actor && n.actor.username)));
  ok("...and the unread count agrees", feed.unread === feed.notifications.filter((n) => !n.read).length,
     feed.unread + " vs " + feed.notifications.filter((n) => !n.read).length);
  await bob.markRead([feed.notifications[0].id]);
  ok("marking one read sticks",
     (await bob.notifications()).notifications.filter((n) => n.id === feed.notifications[0].id)[0].read);
  await bob.markRead();
  ok("marking all read clears the badge", (await bob.notifications()).unread === 0);
  await bob.dismissNotification(feed.notifications[0].id);
  ok("dismissing removes it",
     !(await bob.notifications()).notifications.some((n) => n.id === feed.notifications[0].id));
  await bob.clearNotifications();
  ok("clearing empties the feed", (await bob.notifications()).notifications.length === 0);
  ok("...and nobody else's feed moved", (await alice.notifications()).notifications.length > 0);

  /* ------------------------------------------------------ account safety */
  group("account safety");

  await throws("a wrong current password is refused",
               frank.changePassword("not it", "a longer new one"), "current password is wrong");
  await frank.changePassword("correct horse", "brand new passphrase");
  ok("changing the password works",
     (await loadAdapter(stub).login("frank", "brand new passphrase")).user.username === "frank");
  await throws("...and the old one stops working",
               loadAdapter(stub).login("frank", "correct horse"), "wrong username or password");

  await throws("deleting an account needs the name typed exactly",
               frank.deleteAccount("Frank"), "type your username");
  await frank.deleteAccount("frank");
  ok("deleting an account works", (await frank.me()).user === null);
  ok("...and it disappears from search",
     !(await alice.searchUsers("frank")).users.some((u) => u.username === "frank"));

  /* --------------------------------------------------------- presence */
  group("presence");

  await alice.setPlaying("pac");
  const playing = await owner.adminLive();
  ok("the live view shows what somebody is playing",
     playing.users.some((u) => u.username === "alice" && u.game === "pac"),
     JSON.stringify(playing.users.map((u) => [u.username, u.game])));
  await alice.setPlaying(null);
  ok("...and clears when they stop",
     (await owner.adminLive()).users.every((u) => u.game !== "pac"));

  /* ------------------------------------------------------------- wrap up */
  await stub.end();

  console.log("\n========================================================");
  if (failures.length) {
    console.log(failures.length + " check(s) FAILED:");
    failures.forEach((f) => console.log("  · " + f));
    process.exitCode = 1;
    return;
  }
  console.log("All " + pass + " Supabase adapter checks passed.");
}

main().catch((e) => {
  console.error("\nharness error: " + e.stack);
  process.exitCode = 1;
});

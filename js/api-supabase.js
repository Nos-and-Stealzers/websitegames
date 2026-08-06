/* Supabase adapter.
 *
 * Implements the same surface as js/api.js against Supabase Auth (GoTrue) and
 * PostgREST, so session.js and every page work unchanged — only SITE.backend
 * decides which one is live.
 *
 * Deliberately dependency-free: no supabase-js from a CDN. The official client
 * is ~120 KB and, more to the point, a blocked CDN would take accounts down on
 * exactly the networks this site exists for. Everything here is fetch.
 *
 * The anon key is public by design; row-level security is what protects the
 * data. Nothing here should ever hold a service-role key.
 */
(function () {
  "use strict";

  var SITE = window.SITE || {};
  if ((SITE.backend || "auto") !== "supabase") return;

  var conf = SITE.supabase || {};
  var URL_BASE = String(conf.url || "").replace(/\/+$/, "");
  var ANON = String(conf.anonKey || "");

  /* No fetch means no backend, full stop. Bailing here keeps callers on their
     normal error path instead of a ReferenceError that would leave
     Session.ready pending forever and hang every gated page. */
  if (typeof window.fetch !== "function") {
    window.API = Object.assign({}, window.API, {
      available: function () { return Promise.resolve(false); },
      configError: "This browser can't reach the hub's server."
    });
    return;
  }

  if (!URL_BASE || !ANON) {
    /* Misconfigured is not the same as absent: say so rather than silently
       falling back to a backend that isn't there. */
    window.API = Object.assign({}, window.API, {
      available: function () { return Promise.resolve(false); },
      configError: "Supabase URL or anon key missing from js/config.js"
    });
    return;
  }

  var TOKEN_KEY = "ach:sb-session";

  /* Supabase Auth needs an address. The hub is username-only, so one is
     derived. Nothing is ever sent to it — turn OFF "Confirm email" in
     Authentication → Providers → Email, or signup will hang unconfirmed. */
  var MAIL_DOMAIN = "users." + (SITE.domain || "arcade.local");
  function emailFor(username) {
    return String(username).toLowerCase() + "@" + MAIL_DOMAIN;
  }

  /* ------------------------------------------------------------- session */

  var session = null;
  try { session = JSON.parse(window.localStorage.getItem(TOKEN_KEY) || "null"); } catch (e) {}

  function keepSession(next) {
    session = next;
    try {
      if (next) window.localStorage.setItem(TOKEN_KEY, JSON.stringify(next));
      else window.localStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* private mode */ }
  }

  function fail(message, status) {
    var err = new Error(message);
    err.status = status || 400;
    return err;
  }

  function readError(body, status) {
    if (!body) return "Request failed (" + status + ")";
    /* PostgREST puts RAISE EXCEPTION text in `message`; GoTrue uses several
       shapes depending on the endpoint. */
    return body.message || body.error_description || body.msg || body.error ||
           body.hint || ("Request failed (" + status + ")");
  }

  var refreshing = null;

  function refresh() {
    if (!session || !session.refresh_token) return Promise.reject(fail("Signed out.", 401));
    if (refreshing) return refreshing;

    refreshing = fetch(URL_BASE + "/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      headers: { apikey: ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: session.refresh_token })
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (body) {
        if (!res.ok || !body || !body.access_token) {
          keepSession(null);
          throw fail("Your session expired — sign in again.", 401);
        }
        keepSession(body);
        return body;
      });
    }).then(function (v) { refreshing = null; return v; },
            function (e) { refreshing = null; throw e; });

    return refreshing;
  }

  function authHeader() {
    return session && session.access_token ? "Bearer " + session.access_token : "Bearer " + ANON;
  }

  /* One fetch wrapper for both APIs, with a single transparent token retry. */
  function call(path, opts, retried) {
    opts = opts || {};
    var headers = Object.assign({
      apikey: ANON,
      Authorization: authHeader(),
      "Content-Type": "application/json"
    }, opts.headers || {});

    return fetch(URL_BASE + path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
    }).then(function (res) {
      if (res.status === 204) return null;
      return res.text().then(function (text) {
        var body = null;
        if (text) { try { body = JSON.parse(text); } catch (e) { body = text; } }

        if (res.status === 401 && session && !retried) {
          return refresh().then(function () { return call(path, opts, true); });
        }
        if (!res.ok) throw fail(readError(body, res.status), res.status);
        return body;
      });
    });
  }

  function rest(path, opts) { return call("/rest/v1" + path, opts); }
  function rpc(fn, args) {
    return call("/rest/v1/rpc/" + fn, { method: "POST", body: args || {} });
  }

  /* PostgREST returns arrays; most of our reads want one row. */
  function one(rows) { return Array.isArray(rows) ? rows[0] || null : rows; }

  /* --------------------------------------------------------------- shapes */

  var ONLINE_MS = 150000;

  function shapeUser(row, extra) {
    if (!row) return null;
    var seen = row.last_seen ? Date.parse(row.last_seen) : 0;
    return Object.assign({
      id: row.id,
      username: row.username,
      displayName: row.display_name || row.username,
      bio: row.bio || "",
      role: row.role,
      state: row.state,
      online: !!seen && Date.now() - seen < ONLINE_MS,
      lastSeen: seen,
      createdAt: row.created_at ? Date.parse(row.created_at) : 0
    }, extra || {});
  }

  function shapeSelf(row) {
    return Object.assign(shapeUser(row), {
      acceptsDms: !!row.accepts_dms,
      showActivity: !!row.show_activity,
      friendCode: row.friend_code || ""
    });
  }

  function ms(value) { return value ? Date.parse(value) : 0; }

  /* PostgREST returns an embedded count as [{ count: n }]. */
  function embeddedCount(value) {
    if (Array.isArray(value)) return (value[0] && value[0].count) || 0;
    return Number(value) || 0;
  }

  function shapeTicket(t, from) {
    return {
      id: t.id,
      subject: t.subject,
      category: t.category,
      priority: t.priority,
      state: t.state,
      at: ms(t.created_at),
      updatedAt: ms(t.updated_at),
      from: from || "(deleted account)",
      userId: t.user_id,
      replies: embeddedCount(t.support_messages)
    };
  }

  var PROFILE_COLS = "id,username,display_name,bio,role,state,accepts_dms,show_activity," +
                     "friend_code,created_at,last_seen";

  function me() {
    if (!session) return Promise.resolve(null);
    return rest("/profiles?select=" + PROFILE_COLS + "&id=eq." + session.user.id)
      .then(one);
  }

  /* Cached so relation lookups don't refetch the whole graph per row. */
  var edgesCache = null;

  function edges(force) {
    if (edgesCache && !force) return Promise.resolve(edgesCache);
    if (!session) return Promise.resolve([]);
    var id = session.user.id;
    return rest("/friendships?select=*&or=(requester.eq." + id + ",addressee.eq." + id + ")")
      .then(function (rows) { edgesCache = rows || []; return edgesCache; });
  }

  function relationOf(rows, otherId) {
    if (!session) return "none";
    if (otherId === session.user.id) return "self";
    var me = session.user.id;
    var row = rows.filter(function (r) {
      return (r.requester === me && r.addressee === otherId) ||
             (r.requester === otherId && r.addressee === me);
    })[0];
    if (!row) return "none";
    if (row.state === "accepted") return "friends";
    if (row.state === "blocked") return row.blocked_by === me ? "blocked" : "blocked-by";
    return row.requester === me ? "pending-out" : "pending-in";
  }

  /* ------------------------------------------------------------------ API */

  var API = {
    backend: "supabase",
    health: { ok: true, supabase: true },

    available: function () {
      return rest("/game_stats?select=game_id&limit=1")
        .then(function () { return true; })
        .catch(function (err) {
          /* A 404 here means the schema was never applied — worth saying so
             plainly, because everything else will fail confusingly. */
          if (err.status === 404) {
            API.configError = "Supabase reachable, but the schema isn't applied. " +
              "Run supabase/schema.sql in the SQL editor.";
          }
          return false;
        });
    },

    /* --- auth --- */

    me: function () {
      if (!session) return Promise.resolve({ user: null });
      return me().then(function (row) {
        if (!row) { keepSession(null); return { user: null }; }
        rpc("touch_last_seen").catch(function () {});
        return { user: shapeSelf(row) };
      }).catch(function () { return { user: null }; });
    },

    signup: function (username, password, displayName) {
      return call("/auth/v1/signup", {
        method: "POST",
        body: {
          email: emailFor(username),
          password: password,
          data: { username: username, display_name: displayName || username }
        }
      }).then(function (body) {
        if (!body || !body.access_token) {
          /* Almost always email confirmation still switched on. */
          throw fail("Account created but not signed in — turn off " +
                     "\"Confirm email\" in Supabase Authentication settings.", 400);
        }
        keepSession(body);
        edgesCache = null;
        return me().then(function (row) {
          return { user: shapeSelf(row), firstAccount: row && row.role === "admin" };
        });
      });
    },

    login: function (username, password) {
      return call("/auth/v1/token?grant_type=password", {
        method: "POST",
        body: { email: emailFor(username), password: password }
      }).then(function (body) {
        if (!body || !body.access_token) throw fail("Wrong username or password.", 401);
        keepSession(body);
        edgesCache = null;
        /* Record the sign-in for the staff log. Best-effort — a failure here
           must never turn a good login into a bad one. */
        rpc("record_login", { agent: String(navigator.userAgent || "").slice(0, 200) })
          .catch(function () {});
        return me().then(function (row) { return { user: shapeSelf(row) }; });
      }).catch(function (err) {
        /* Never leak whether the account exists. */
        if (err.status === 400 || err.status === 401) throw fail("Wrong username or password.", 401);
        throw err;
      });
    },

    logout: function () {
      var had = session;
      keepSession(null);
      edgesCache = null;
      if (!had) return Promise.resolve({ ok: true });
      return call("/auth/v1/logout", { method: "POST" })
        .catch(function () { return null; })
        .then(function () { return { ok: true }; });
    },

    changePassword: function (current, next) {
      if (!session) return Promise.reject(fail("Signed out.", 401));
      /* Re-authenticate first: GoTrue would otherwise let anyone holding the
         tab change the password without knowing the old one. */
      return call("/auth/v1/token?grant_type=password", {
        method: "POST",
        body: { email: session.user.email, password: current }
      }).catch(function () {
        throw fail("Current password is wrong.", 403);
      }).then(function () {
        return call("/auth/v1/user", { method: "PUT", body: { password: next } });
      }).then(function () { return { ok: true }; });
    },

    sessions: function () {
      /* Supabase does not expose a per-device session list to the client. */
      return Promise.resolve({
        sessions: session ? [{
          current: true,
          createdAt: Date.now(),
          expiresAt: (session.expires_at || 0) * 1000,
          agent: "This device"
        }] : []
      });
    },

    signOutEverywhere: function () {
      return call("/auth/v1/logout?scope=others", { method: "POST" })
        .then(function () { return { ok: true }; });
    },

    /* --- profile --- */

    updateProfile: function (patch) {
      if (!session) return Promise.reject(fail("Signed out.", 401));
      var row = {};
      if (patch.displayName !== undefined) row.display_name = String(patch.displayName).slice(0, 32);
      if (patch.bio !== undefined) row.bio = String(patch.bio).slice(0, 300);
      if (patch.acceptsDms !== undefined) row.accepts_dms = !!patch.acceptsDms;
      if (patch.showActivity !== undefined) row.show_activity = !!patch.showActivity;

      return rest("/profiles?id=eq." + session.user.id, {
        method: "PATCH", body: row, headers: { Prefer: "return=representation" }
      }).then(function (rows) { return { user: shapeSelf(one(rows)) }; });
    },

    deleteAccount: function (confirm) {
      return me().then(function (row) {
        if (!row || confirm !== row.username) {
          throw fail("Type your username exactly to confirm.", 400);
        }
        /* Removing the profile cascades everything owned by it. The auth user
           itself needs the service role, so it is left orphaned and inert. */
        return rest("/profiles?id=eq." + session.user.id, { method: "DELETE" });
      }).then(function () {
        keepSession(null);
        return { ok: true };
      });
    },

    user: function (username) {
      return Promise.all([
        rest("/profiles?select=" + PROFILE_COLS + "&username=eq." + encodeURIComponent(username)),
        edges(true)
      ]).then(function (out) {
        var row = one(out[0]);
        if (!row) throw fail("No such user.", 404);
        var rel = relationOf(out[1], row.id);
        if (rel === "blocked-by") throw fail("No such user.", 404);

        var user = shapeUser(row, { relation: rel });
        if (rel === "self") user.friendCode = row.friend_code || "";

        if (!row.show_activity || (rel !== "friends" && rel !== "self")) {
          return { user: user };
        }
        return rest("/saves?select=payload&user_id=eq." + row.id).then(function (saves) {
          var save = one(saves);
          if (save && save.payload) {
            var stats = save.payload.stats || {};
            user.activity = {
              totalSeconds: Object.keys(stats).reduce(function (n, k) {
                return n + (stats[k].seconds || 0);
              }, 0),
              gamesPlayed: Object.keys(stats).length,
              recent: (save.payload.recents || []).slice(0, 5).map(function (r) { return r.id; })
            };
          }
          return { user: user };
        }).catch(function () { return { user: user }; });
      });
    },

    searchUsers: function (q) {
      if (!q || q.length < 2) return Promise.resolve({ users: [] });
      var safe = String(q).toLowerCase().replace(/[%,()*]/g, "");
      return Promise.all([
        rest("/profiles?select=" + PROFILE_COLS + "&username=ilike." +
             encodeURIComponent(safe + "%") + "&state=eq.active&limit=20"),
        edges(true)
      ]).then(function (out) {
        var mine = session ? session.user.id : null;
        return {
          users: (out[0] || [])
            .filter(function (r) { return r.id !== mine; })
            .map(function (r) { return shapeUser(r, { relation: relationOf(out[1], r.id) }); })
            .filter(function (u) { return u.relation !== "blocked-by"; })
        };
      });
    },

    /* --- friends --- */

    friends: function () {
      if (!session) return Promise.reject(fail("Signed out.", 401));
      var mine = session.user.id;

      return edges(true).then(function (rows) {
        var ids = rows.map(function (r) {
          return r.requester === mine ? r.addressee : r.requester;
        });
        if (!ids.length) return { friends: [], incoming: [], outgoing: [], blocked: [] };

        return rest("/profiles?select=" + PROFILE_COLS + "&id=in.(" + ids.join(",") + ")")
          .then(function (people) {
            var byId = {};
            (people || []).forEach(function (p) { byId[p.id] = p; });

            var out = { friends: [], incoming: [], outgoing: [], blocked: [] };
            rows.forEach(function (edge) {
              var otherId = edge.requester === mine ? edge.addressee : edge.requester;
              var row = byId[otherId];
              if (!row) return;
              var person = shapeUser(row, { edgeId: edge.id });

              if (edge.state === "accepted") out.friends.push(person);
              else if (edge.state === "blocked") {
                if (edge.blocked_by === mine) out.blocked.push(person);
              } else if (edge.requester === mine) out.outgoing.push(person);
              else out.incoming.push(person);
            });

            out.friends.sort(function (a, b) {
              return Number(b.online) - Number(a.online) || a.username.localeCompare(b.username);
            });
            return out;
          });
      });
    },

    addFriend: function (username) {
      return rest("/profiles?select=id&username=eq." + encodeURIComponent(String(username).replace(/^@/, "")))
        .then(one)
        .then(function (row) {
          if (!row) throw fail("No such user.", 404);
          return sendRequest(row.id);
        });
    },

    addFriendByCode: function (code) {
      return rpc("find_by_code", { code: code }).then(function (hit) {
        return sendRequest(hit.id);
      });
    },

    lookupCode: function (code) {
      return rpc("find_by_code", { code: code }).then(function (hit) {
        return edges(true).then(function (rows) {
          return { user: hit, relation: relationOf(rows, hit.id) };
        });
      });
    },

    rotateCode: function () {
      return rpc("rotate_friend_code").then(function (code) {
        return { friendCode: code };
      });
    },

    acceptFriend: function (id) {
      return rest("/friendships?id=eq." + id, {
        method: "PATCH", body: { state: "accepted", updated_at: new Date().toISOString() }
      }).then(function () { edgesCache = null; return { state: "friends" }; });
    },

    removeFriend: function (id) {
      return rest("/friendships?id=eq." + id, { method: "DELETE" })
        .then(function () { edgesCache = null; return { ok: true }; });
    },

    blockUser: function (username) {
      if (!session) return Promise.reject(fail("Signed out.", 401));
      var mine = session.user.id;
      return rest("/profiles?select=id&username=eq." + encodeURIComponent(username))
        .then(one)
        .then(function (row) {
          if (!row) throw fail("No such user.", 404);
          return edges(true).then(function (rows) {
            var existing = rows.filter(function (r) {
              return (r.requester === mine && r.addressee === row.id) ||
                     (r.requester === row.id && r.addressee === mine);
            })[0];
            var patch = { state: "blocked", blocked_by: mine, updated_at: new Date().toISOString() };
            if (existing) {
              return rest("/friendships?id=eq." + existing.id, { method: "PATCH", body: patch });
            }
            return rest("/friendships", {
              method: "POST",
              body: Object.assign({ requester: mine, addressee: row.id }, patch)
            });
          });
        })
        .then(function () { edgesCache = null; return { state: "blocked" }; });
    },

    /* --- messages --- */

    threads: function () {
      if (!session) return Promise.reject(fail("Signed out.", 401));
      var mine = session.user.id;

      return rest("/thread_members?select=thread_id,threads!inner(id,is_group,title,owner_id,last_at)" +
                  "&user_id=eq." + mine + "&order=thread_id.desc")
        .then(function (rows) {
          var threads = (rows || []).map(function (r) { return r.threads; })
            .filter(function (t) { return t && t.last_at; });
          if (!threads.length) return { threads: [] };

          var ids = threads.map(function (t) { return t.id; });
          return Promise.all([
            rest("/thread_members?select=thread_id,user_id,profiles!inner(" + PROFILE_COLS + ")" +
                 "&thread_id=in.(" + ids.join(",") + ")"),
            rest("/messages?select=thread_id,body,sender,created_at,read_at,attachment_id," +
                 "profiles!inner(username,display_name)" +
                 "&thread_id=in.(" + ids.join(",") + ")&order=id.desc&limit=400")
          ]).then(function (out) {
            var members = {}, last = {}, unread = {};

            (out[0] || []).forEach(function (m) {
              if (m.user_id === mine) return;
              (members[m.thread_id] = members[m.thread_id] || []).push(shapeUser(m.profiles));
            });
            (out[1] || []).forEach(function (m) {
              if (!last[m.thread_id]) {
                last[m.thread_id] = {
                  body: m.body || (m.attachment_id ? "sent an image" : ""),
                  mine: m.sender === mine,
                  who: m.profiles ? (m.profiles.display_name || m.profiles.username) : "",
                  at: ms(m.created_at)
                };
              }
              if (m.sender !== mine && !m.read_at) {
                unread[m.thread_id] = (unread[m.thread_id] || 0) + 1;
              }
            });

            return {
              threads: threads.map(function (t) {
                var people = members[t.id] || [];
                return {
                  id: t.id,
                  isGroup: !!t.is_group,
                  title: t.is_group
                    ? (t.title || people.map(function (p) { return p.displayName; }).join(", ") || "Group")
                    : (people[0] ? people[0].displayName : "Conversation"),
                  with: t.is_group ? null : (people[0] || null),
                  members: people,
                  memberCount: people.length + 1,
                  owner: t.owner_id === mine,
                  lastAt: ms(t.last_at),
                  unread: unread[t.id] || 0,
                  preview: last[t.id] || null
                };
              }).sort(function (a, b) { return b.lastAt - a.lastAt; })
            };
          });
        });
    },

    thread: function (id, after) {
      if (!session) return Promise.reject(fail("Signed out.", 401));
      var mine = session.user.id;

      return Promise.all([
        rest("/threads?select=*&id=eq." + id).then(one),
        rest("/thread_members?select=user_id,profiles!inner(" + PROFILE_COLS + ")&thread_id=eq." + id),
        rest("/messages?select=id,sender,body,created_at,deleted,attachment_id," +
             "profiles!inner(username,display_name)," +
             "attachments(id,mime,width,height,bytes,kind)" +
             "&thread_id=eq." + id + "&id=gt." + (after || 0) + "&order=id.asc&limit=200")
      ]).then(function (out) {
        var t = out[0];
        if (!t) throw fail("No such thread.", 404);

        var people = (out[1] || [])
          .filter(function (m) { return m.user_id !== mine; })
          .map(function (m) { return shapeUser(m.profiles); });

        /* Mark anything of theirs we just read. */
        rest("/messages?thread_id=eq." + id + "&sender=neq." + mine + "&read_at=is.null", {
          method: "PATCH", body: { read_at: new Date().toISOString() }
        }).catch(function () {});

        return {
          threadId: t.id,
          isGroup: !!t.is_group,
          title: t.is_group
            ? (t.title || people.map(function (p) { return p.displayName; }).join(", ") || "Group")
            : (people[0] ? people[0].displayName : "Conversation"),
          with: t.is_group ? null : (people[0] || null),
          members: people,
          memberCount: people.length + 1,
          owner: t.owner_id === mine,
          canSend: true,
          messages: (out[2] || []).map(function (m) {
            var att = Array.isArray(m.attachments) ? m.attachments[0] : m.attachments;
            return {
              id: m.id,
              mine: m.sender === mine,
              from: {
                username: m.profiles.username,
                displayName: m.profiles.display_name || m.profiles.username
              },
              body: m.deleted ? "" : (m.body || ""),
              deleted: !!m.deleted,
              at: ms(m.created_at),
              image: att && !m.deleted ? {
                id: att.id,
                url: URL_BASE + "/rest/v1/attachments?select=data&id=eq." + att.id,
                mime: att.mime, width: att.width, height: att.height,
                bytes: att.bytes, kind: att.kind,
                /* PostgREST can't stream a blob to an <img>, so the adapter
                   hands back a loader the UI resolves into a data URL. */
                fetchData: function () {
                  return rest("/attachments?select=data,mime&id=eq." + att.id)
                    .then(one)
                    .then(function (row) {
                      return row ? "data:" + row.mime + ";base64," + row.data : "";
                    });
                }
              } : null
            };
          })
        };
      });
    },

    send: function (id, body, image) {
      return rpc("send_message", { t: Number(id), body: body || "", image: image || null })
        .then(function (messageId) {
          return {
            message: {
              id: messageId,
              mine: true,
              from: {
                username: session.user.user_metadata.username,
                displayName: session.user.user_metadata.display_name ||
                             session.user.user_metadata.username
              },
              body: body || "",
              deleted: false,
              at: Date.now(),
              image: image ? {
                id: 0, url: image.dataUrl, mime: "image/jpeg",
                width: image.width, height: image.height, kind: image.kind
              } : null
            }
          };
        });
    },

    openThread: function (username) {
      return rpc("open_thread", { with_username: String(username).replace(/^@/, "") })
        .then(function (threadId) { return { threadId: threadId }; });
    },

    deleteMessage: function (id) {
      return rest("/messages?id=eq." + id, {
        method: "PATCH", body: { deleted: true, body: "" }
      }).then(function () { return { ok: true }; });
    },

    unread: function () {
      return rpc("badge_counts").then(function (counts) {
        return {
          messages: (counts && counts.messages) || 0,
          requests: (counts && counts.requests) || 0,
          notifications: (counts && counts.notifications) || 0
        };
      });
    },

    /* --- groups --- */

    createGroup: function (title, usernames) {
      return rpc("create_group", { title: title || "", usernames: usernames })
        .then(function (id) { return { thread: { id: id, isGroup: true, title: title, owner: true, memberCount: usernames.length + 1 } }; });
    },
    renameGroup: function (id, title) {
      /* Parameter is `new_title`, not `title` — see the note in schema.sql. */
      return rpc("rename_group", { t: Number(id), new_title: title })
        .then(function () { return { ok: true }; });
    },
    addToGroup: function (id, username) {
      return rpc("add_to_group", { t: Number(id), username: username }).then(function () { return { ok: true }; });
    },
    removeFromGroup: function (id, userId) {
      return rpc("leave_thread", { t: Number(id), who: userId || null }).then(function () { return { ok: true }; });
    },

    /* --- notifications --- */

    notifications: function (opts) {
      opts = opts || {};
      var q = "/notifications?select=id,kind,body,link,read_at,created_at," +
              "profiles:actor_id(username,display_name)" +
              "&order=id.desc&limit=" + (opts.limit || 40);
      if (opts.unreadOnly) q += "&read_at=is.null";

      return Promise.all([rest(q), rpc("badge_counts")]).then(function (out) {
        return {
          unread: (out[1] && out[1].notifications) || 0,
          notifications: (out[0] || []).map(function (n) {
            return {
              id: n.id, kind: n.kind, body: n.body, link: n.link,
              read: !!n.read_at, at: ms(n.created_at),
              actor: n.profiles ? {
                username: n.profiles.username,
                displayName: n.profiles.display_name || n.profiles.username
              } : null
            };
          })
        };
      });
    },

    markRead: function (ids) {
      return rpc("mark_notifications_read", { ids: ids === "all" ? null : ids })
        .then(function (unread) { return { unread: unread || 0 }; });
    },
    dismissNotification: function (id) {
      return rest("/notifications?id=eq." + id, { method: "DELETE" })
        .then(function () { return { ok: true }; });
    },
    clearNotifications: function () {
      if (!session) return Promise.reject(fail("Signed out.", 401));
      return rest("/notifications?user_id=eq." + session.user.id, { method: "DELETE" })
        .then(function () { return { ok: true, unread: 0 }; });
    },

    /* --- save sync --- */

    getSave: function () {
      if (!session) return Promise.reject(fail("Signed out.", 401));
      return rest("/saves?select=payload,updated_at&user_id=eq." + session.user.id)
        .then(one)
        .then(function (row) {
          return {
            save: (row && row.payload) || { version: 2, favorites: [], recents: [], stats: {}, ratings: {} },
            updatedAt: row ? ms(row.updated_at) : 0
          };
        });
    },

    putSave: function (save) {
      return rpc("sync_save", { incoming: save }).then(function (merged) {
        return { save: merged, updatedAt: Date.now() };
      });
    },

    popular: function () {
      return rest("/game_stats?select=game_id,plays,seconds&order=seconds.desc&limit=40")
        .then(function (rows) {
          return {
            games: (rows || []).map(function (r) {
              return { id: r.game_id, plays: r.plays, seconds: r.seconds };
            })
          };
        });
    },

    /* --- reports --- */

    report: function (kind, target, reason) {
      if (!session) return Promise.reject(fail("Signed out.", 401));
      return rest("/reports", {
        method: "POST",
        body: { reporter: session.user.id, kind: kind, target: target, reason: reason }
      }).then(function () { return { ok: true }; });
    },

    /* --- feedback --- */

    sendFeedback: function (payload) {
      var row = {
        user_id: session ? session.user.id : null,
        kind: payload.kind,
        subject: payload.subject,
        body: payload.body,
        page: String(payload.page || "").slice(0, 200),
        game_id: String(payload.gameId || "").slice(0, 120),
        agent: String(navigator.userAgent || "").slice(0, 200)
      };
      return rest("/feedback", { method: "POST", body: row })
        .then(function () { return { ok: true }; });
    },

    myFeedback: function () {
      if (!session) return Promise.resolve({ feedback: [] });
      return rest("/feedback?select=id,kind,subject,body,state,reply,created_at" +
                  "&user_id=eq." + session.user.id + "&order=id.desc&limit=50")
        .then(function (rows) {
          return {
            feedback: (rows || []).map(function (f) {
              return {
                id: f.id, kind: f.kind, subject: f.subject, body: f.body,
                state: f.state, reply: f.reply, at: ms(f.created_at)
              };
            })
          };
        });
    },

    adminFeedback: function (state) {
      var want = state || "new";
      return Promise.all([
        rest("/feedback?select=*,profiles:user_id(username)&state=eq." + want +
             "&order=id.desc&limit=200"),
        /* PostgREST returns the count in a header, so ask per state rather
           than pulling every row just to length them. */
        Promise.all(["new", "triaged", "done", "declined"].map(function (s) {
          return call("/rest/v1/feedback?select=id&state=eq." + s + "&limit=1000")
            .then(function (rows) { return [s, (rows || []).length]; })
            .catch(function () { return [s, 0]; });
        }))
      ]).then(function (out) {
        var counts = {};
        out[1].forEach(function (pair) { counts[pair[0]] = pair[1]; });
        return {
          counts: counts,
          feedback: (out[0] || []).map(function (f) {
            return {
              id: f.id, kind: f.kind, subject: f.subject, body: f.body,
              page: f.page, gameId: f.game_id, agent: f.agent,
              state: f.state, reply: f.reply,
              from: f.profiles ? f.profiles.username : "(anonymous)",
              at: ms(f.created_at)
            };
          })
        };
      });
    },

    adminUpdateFeedback: function (id, patch) {
      var row = {};
      if (patch.state !== undefined) row.state = patch.state;
      if (patch.reply !== undefined) row.reply = String(patch.reply).slice(0, 1000);
      row.updated_at = new Date().toISOString();
      return rest("/feedback?id=eq." + id, { method: "PATCH", body: row })
        .then(function () { return { ok: true }; });
    },

    /* --- presence and sign-in history --- */

    setPlaying: function (gameId) {
      if (!session) return Promise.resolve({ ok: true });
      return rpc("set_playing", { game: gameId || null })
        .then(function () { return { ok: true }; });
    },

    adminLive: function () {
      return rpc("admin_live");
    },

    /* On this backend the password check happens inside Supabase Auth, in a
       schema the anon key cannot read — so only successful sign-ins appear
       here. Failed attempts are in the Supabase dashboard under
       Authentication → Logs. The Node backend records both. */
    adminLogins: function () {
      return rpc("admin_logins").then(function (rows) {
        return { logins: rows || [], failuresVisible: false };
      });
    },

    /* --- support tickets --- */

    /* Reads go straight to the tables — RLS already limits them to your own
       tickets, or everything if you're staff. Writes go through RPCs, because
       RLS grants rows and not columns: an update policy would let anyone set
       their own ticket to high priority, or flip from_staff on their own
       messages and impersonate support. */

    openTicket: function (payload) {
      return rpc("open_ticket", {
        subject: payload.subject, body: payload.body, category: payload.category || "other"
      }).then(function (id) { return { id: id }; });
    },

    myTickets: function () {
      if (!session) return Promise.resolve({ tickets: [] });
      return rest("/support_tickets?select=*,support_messages(count)" +
                  "&user_id=eq." + session.user.id + "&order=updated_at.desc&limit=50")
        .then(function (rows) {
          return {
            tickets: (rows || []).map(function (t) {
              return shapeTicket(t, session.user.username);
            })
          };
        });
    },

    ticket: function (id) {
      return Promise.all([
        rest("/support_tickets?select=*,profiles:user_id(username)&id=eq." + Number(id)),
        rest("/support_messages?select=*,profiles:sender_id(username,display_name)" +
             "&ticket_id=eq." + Number(id) + "&order=id.asc")
      ]).then(function (out) {
        var t = one(out[0]);
        if (!t) throw fail("No such ticket.", 404);
        return {
          ticket: shapeTicket(t, t.profiles && t.profiles.username),
          messages: (out[1] || []).map(function (m) {
            var who = m.profiles;
            return {
              id: m.id,
              body: m.body,
              staff: !!m.from_staff,
              author: who ? (who.display_name || who.username)
                          : (m.from_staff ? "Support" : "(deleted account)"),
              at: ms(m.created_at)
            };
          })
        };
      });
    },

    replyTicket: function (id, body) {
      return rpc("reply_ticket", { t: Number(id), body: body })
        .then(function () { return { ok: true }; });
    },

    updateTicket: function (id, patch) {
      var jobs = [];
      if (patch.state !== undefined) {
        jobs.push(rpc("set_ticket_state", { t: Number(id), next_state: patch.state }));
      }
      if (patch.priority !== undefined) {
        jobs.push(rpc("set_ticket_priority", { t: Number(id), next_priority: patch.priority }));
      }
      if (!jobs.length) return Promise.reject(fail("Nothing to change.", 400));
      return Promise.all(jobs).then(function () { return { ok: true }; });
    },

    adminTickets: function (state) {
      return rpc("admin_tickets", { want_state: state || "open" });
    },

    /* --- calling --- */

    /* Signalling only; the media is peer-to-peer and never reaches Supabase.
       STUN is Google's free public service, so there is nothing to pay for
       and nothing to configure. */
    iceServers: function () {
      return Promise.resolve({
        iceServers: [
          { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }
        ],
        maxPeers: 4
      });
    },

    startCall: function (payload) {
      return rpc("start_call", {
        target: payload.userId || null,
        t: payload.threadId ? Number(payload.threadId) : null,
        call_kind: payload.kind || "audio"
      }).then(function (id) {
        return API.pollSignals(id).then(function (res) {
          return { call: res.call, iceServers: [
            { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }
          ] };
        });
      });
    },

    pendingCalls: function () {
      if (!session) return Promise.resolve({ calls: [] });
      return rpc("pending_calls").then(function (calls) {
        return { calls: calls || [] };
      });
    },

    joinCall: function (id) {
      return rpc("join_call", { c: Number(id) }).then(function () {
        return API.pollSignals(id).then(function (res) {
          return {
            call: res.call,
            self: session ? session.user.id : null,
            iceServers: [
              { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }
            ]
          };
        });
      });
    },

    leaveCall: function (id) {
      return rpc("leave_call", { c: Number(id) }).then(function () { return { ok: true }; });
    },

    sendSignal: function (id, to, kind, payload) {
      return rpc("send_signal", {
        c: Number(id), target: to, signal_kind: kind, body: payload || {}
      }).then(function () { return { ok: true }; });
    },

    pollSignals: function (id) {
      return rpc("take_signals", { c: Number(id) }).then(function (res) {
        return { call: (res && res.call) || null, signals: (res && res.signals) || [] };
      });
    },

    /* --- catalogue (owner) --- */

    customCatalog: function () {
      return rest("/custom_games_public?select=game_id,payload,removed").then(function (rows) {
        var added = [], removed = [];
        (rows || []).forEach(function (r) {
          if (r.removed) removed.push(r.game_id);
          else if (r.payload) added.push(Object.assign({}, r.payload, { id: r.game_id }));
        });
        return { added: added, removed: removed };
      });
    },

    saveCatalogEntry: function (entry) {
      return rpc("save_custom_game", { entry: entry }).then(function (game) {
        return { game: game };
      });
    },

    removeCatalogEntry: function (id, hard) {
      return rpc("remove_custom_game", { slug: id, hard: !!hard })
        .then(function () { return { ok: true }; });
    },

    restoreCatalogEntry: function (id) {
      return rpc("restore_custom_game", { slug: id })
        .then(function () { return { ok: true }; });
    },

    /* --- third-party game progress --- */

    putGameSave: function (host, payload) {
      return rpc("put_game_save", { host: host, payload: payload })
        .then(function (keys) { return { ok: true, keys: keys }; });
    },

    getGameSave: function (host) {
      if (!session) return Promise.reject(fail("Signed out.", 401));
      return rest("/game_saves?select=payload,keys,updated_at&user_id=eq." +
                  session.user.id + "&host=eq." + encodeURIComponent(host))
        .then(one)
        .then(function (row) {
          return row
            ? { payload: row.payload || {}, keys: row.keys, updatedAt: ms(row.updated_at) }
            : { payload: {}, keys: 0, updatedAt: 0 };
        });
    },

    listGameSaves: function () {
      if (!session) return Promise.reject(fail("Signed out.", 401));
      return rest("/game_saves?select=host,keys,updated_at&user_id=eq." + session.user.id +
                  "&order=host")
        .then(function (rows) {
          return {
            hosts: (rows || []).map(function (r) {
              return { host: r.host, keys: r.keys, bytes: 0, updatedAt: ms(r.updated_at) };
            })
          };
        });
    },

    dropGameSave: function (host) {
      if (!session) return Promise.reject(fail("Signed out.", 401));
      return rest("/game_saves?user_id=eq." + session.user.id +
                  "&host=eq." + encodeURIComponent(host), { method: "DELETE" })
        .then(function () { return { ok: true }; });
    },

    /* --- admin --- */

    /* Both go through RPCs that check is_staff() server-side. Assembling these
       from table reads would have handed account totals to any signed-in user,
       because `profiles` is readable by all of them and RLS answers with an
       empty set rather than an error — so it would have looked like it worked. */
    adminOverview: function () {
      return rpc("admin_overview");
    },

    adminUsers: function (q) {
      return rpc("admin_users", { q: q || null }).then(function (rows) {
        return {
          users: (rows || []).map(function (r) {
            return Object.assign(shapeUser(r), {
              acceptsDms: !!r.accepts_dms,
              sessions: 0,
              friends: Number(r.friends) || 0,
              messages: Number(r.messages) || 0
            });
          })
        };
      });
    },

    adminUpdateUser: function (id, patch) {
      var row = {};
      if (patch.role !== undefined) row.role = patch.role;
      if (patch.state !== undefined) row.state = patch.state;
      return rest("/profiles?id=eq." + id, {
        method: "PATCH", body: row, headers: { Prefer: "return=representation" }
      }).then(function (rows) {
        var updated = one(rows);
        if (!updated) throw fail("That change was refused.", 403);
        return { user: shapeUser(updated) };
      });
    },

    adminDeleteUser: function (id) {
      return rest("/profiles?id=eq." + id, { method: "DELETE" })
        .then(function () { return { ok: true }; });
    },

    adminReports: function (state) {
      return rest("/reports?select=*,profiles:reporter(username)&state=eq." +
                  (state || "open") + "&order=created_at.desc&limit=200")
        .then(function (rows) {
          return {
            reports: (rows || []).map(function (r) {
              return {
                id: r.id, kind: r.kind, target: r.target, reason: r.reason,
                state: r.state, at: ms(r.created_at),
                reporter: r.profiles ? r.profiles.username : "(deleted)"
              };
            })
          };
        });
    },

    adminCloseReport: function (id, state) {
      return rest("/reports?id=eq." + id, { method: "PATCH", body: { state: state || "closed" } })
        .then(function () { return { ok: true }; });
    },

    adminAudit: function () {
      return rest("/audit?select=*,profiles:actor(username)&order=id.desc&limit=200")
        .then(function (rows) {
          return {
            entries: (rows || []).map(function (r) {
              return {
                id: r.id, actor: r.profiles ? r.profiles.username : "system",
                action: r.action, detail: r.detail, at: ms(r.created_at)
              };
            })
          };
        });
    },

  };

  function sendRequest(otherId) {
    if (!session) return Promise.reject(fail("Signed out.", 401));
    var mine = session.user.id;
    if (otherId === mine) throw fail("That's you.", 400);

    return edges(true).then(function (rows) {
      var existing = rows.filter(function (r) {
        return (r.requester === mine && r.addressee === otherId) ||
               (r.requester === otherId && r.addressee === mine);
      })[0];

      if (existing) {
        if (existing.state === "accepted") throw fail("Already friends.", 409);
        if (existing.state === "blocked") throw fail("That isn't possible.", 403);
        if (existing.requester === mine) throw fail("Request already sent.", 409);
        /* They asked first — treat this as accepting. */
        return rest("/friendships?id=eq." + existing.id, {
          method: "PATCH", body: { state: "accepted" }
        }).then(function () { edgesCache = null; return { state: "friends" }; });
      }

      return rest("/friendships", {
        method: "POST", body: { requester: mine, addressee: otherId, state: "pending" }
      }).then(function () { edgesCache = null; return { state: "pending-out" }; });
    });
  }

  window.API = API;
})();

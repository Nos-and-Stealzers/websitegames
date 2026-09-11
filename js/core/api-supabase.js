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

  /* Login accepts either a username or a real email in one box (email_for_login
     resolves a username to the account's real address server-side, since the
     client has no way to read auth.users directly). Signup now collects a real
     email — Confirm Email is ON, so a placeholder address nobody can receive
     mail at would leave every new account stuck unconfirmed forever. */

  /* ------------------------------------------------------------- session */

  var session = null;
  try { session = JSON.parse(window.localStorage.getItem(TOKEN_KEY) || "null"); } catch (e) {}

  function keepSession(next) {
    session = next;
    selfProfile = null;
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
      isPlus: !!row.is_plus,
      banned: !!row.banned,
      banReason: row.ban_reason || "",
      createdAt: row.created_at ? Date.parse(row.created_at) : 0
    }, extra || {});
  }

  function shapeSelf(row) {
    return Object.assign(shapeUser(row), {
      acceptsDms: !!row.accepts_dms,
      showActivity: !!row.show_activity,
      emailVerified: !!row.email_verified,
      email: row.email || "",
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
                     "friend_code,created_at,last_seen,is_plus,banned,ban_reason,email_verified";

  /* The signed-in account's own profile row.
     `session.user.user_metadata` is NOT a substitute: it is whatever was set
     at sign-up, so it goes stale the moment someone edits their display name,
     and a session restored from an older token may not carry it at all —
     which is how sending a message could throw on `.username` of undefined. */
  var selfProfile = null;

  function me(force) {
    if (!session) return Promise.resolve(null);
    if (selfProfile && !force) return Promise.resolve(selfProfile);
    return rest("/profiles?select=" + PROFILE_COLS + "&id=eq." + session.user.id)
      .then(one)
      .then(function (row) {
        /* The email lives on the auth session, not the profiles row — attach
           it so callers (verify-email, settings) can show it. */
        if (row && session && session.user) row.email = session.user.email || "";
        selfProfile = row;
        return row;
      });
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

  function edgeOf(rows, otherId) {
    if (!session) return null;
    var mine = session.user.id;
    return (rows || []).filter(function (r) {
      return (r.requester === mine && r.addressee === otherId) ||
             (r.requester === otherId && r.addressee === mine);
    })[0] || null;
  }

  function relationOf(rows, otherId) {
    if (!session) return "none";
    if (otherId === session.user.id) return "self";
    var me = session.user.id;
    var row = edgeOf(rows, otherId);
    if (!row) return "none";
    if (row.state === "accepted") return "friends";
    if (row.state === "blocked") return row.blocked_by === me ? "blocked" : "blocked-by";
    return row.requester === me ? "pending-out" : "pending-in";
  }

  /* Every people-shaped response carries the edge id as well as the relation.
     Without it, the Accept / Cancel / Remove / Unblock buttons that the
     friends page builds from `relation` had nothing to address, and fired a
     DELETE at `/friendships?id=eq.undefined`. */
  function withRelation(rows, row) {
    var edge = edgeOf(rows, row.id);
    return shapeUser(row, {
      relation: relationOf(rows, row.id),
      edgeId: edge ? edge.id : null
    });
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

    /* Always re-read: this is the call every page boots on, and a stale copy
       is how a role change or a suspension went unnoticed until the tab was
       closed. */
    me: function () {
      if (!session) return Promise.resolve({ user: null });
      return me(true).then(function (row) {
        if (!row) { keepSession(null); return { user: null }; }
        rpc("touch_last_seen").catch(function () {});
        return { user: shapeSelf(row) };
      }).catch(function () { return { user: null }; });
    },

    signup: function (username, password, displayName, email) {
      return call("/auth/v1/signup", {
        method: "POST",
        body: {
          email: String(email).trim().toLowerCase(),
          password: password,
          data: { username: username, display_name: displayName || username }
        }
      }).then(function (body) {
        if (!body || !body.access_token) {
          /* Supabase Auth deliberately never says "that email is already
             registered" outright (it would let anyone probe which emails
             have accounts) — a re-signup on an existing address comes back
             200 OK with a fake user object, an EMPTY identities array, and
             NO email actually sent. Telling the caller "check your inbox"
             here is a dead end: nothing arrives, ever. identities.length
             is the one field that tells the two cases apart, so use it. */
          var alreadyRegistered = body && Array.isArray(body.identities) && body.identities.length === 0;
          if (alreadyRegistered) {
            throw fail("An account already uses that email. Try signing in instead, " +
              "or use \u201cForgot your password\u201d if you don't remember it.", 409);
          }
          /* Confirm Email is ON: the account was genuinely just created and
             needs the link in their inbox clicked before a session is handed
             out. That's success, not an error — just a different next step. */
          return { user: null, needsConfirmation: true };
        }
        keepSession(body);
        edgesCache = null;
        return me().then(function (row) {
          return { user: shapeSelf(row), firstAccount: row && row.role === "admin" };
        });
      }).catch(function (err) {
        /* The trigger that creates the profiles row surfaces Postgres'
           raw constraint-violation text ("duplicate key value violates
           unique constraint \"profiles_username_key\"") which means nothing
           to someone filling in a form. Translate the one case that's
           actually reachable from here — a username someone else has. */
        if (err && /profiles_username_key/i.test(err.message || "")) {
          throw fail("That username is already taken.", 409);
        }
        throw err;
      });
    },

    login: function (identifier, password) {
      /* The box takes a username or an email — resolve it server-side to
         the real address before the password grant, since Supabase Auth's
         token endpoint only ever accepts an email. */
      return rpc("email_for_login", { identifier: identifier }).then(function (email) {
        return call("/auth/v1/token?grant_type=password", {
          method: "POST",
          body: { email: email || identifier, password: password }
        });
      }).then(function (body) {
        if (!body || !body.access_token) throw fail("Wrong username/email or password.", 401);
        keepSession(body);
        edgesCache = null;
        /* Record the sign-in for the staff log. Best-effort — a failure here
           must never turn a good login into a bad one. */
        rpc("record_login", { agent: String(navigator.userAgent || "").slice(0, 200) })
          .catch(function () {});
        return me().then(function (row) { return { user: shapeSelf(row) }; });
      }).catch(function (err) {
        /* A banned account gets a clear message (with the staff-set reason)
           instead of the generic wrong-password error. */
        var bannedSignal = err && (err.code === "user_banned" ||
          /banned/i.test(err.message || ""));
        if (bannedSignal || err.status === 400 || err.status === 401 || err.status === 403) {
          return rpc("login_ban_reason", { identifier: identifier })
            .then(function (reason) {
              if (reason) throw fail("Banned: " + reason, 403);
              throw fail("Wrong username/email or password.", 401);
            }, function () {
              throw fail("Wrong username/email or password.", 401);
            });
        }
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

    /* Forgot-password flow. GoTrue emails a link back to `redirectTo` with a
       recovery token in the URL fragment; reset-password.html reads that
       fragment, turns it into a session, then calls resetPassword to set the
       new password on it. Always resolves ok — whether or not the address
       has an account is never revealed. */
    requestPasswordReset: function (email) {
      var redirectTo = encodeURIComponent(window.location.origin + "/reset-password.html");
      return call("/auth/v1/recover?redirect_to=" + redirectTo, {
        method: "POST",
        body: { email: String(email).trim().toLowerCase() }
      }).then(function () { return { ok: true }; })
        .catch(function () { return { ok: true }; });
    },

    /* Called on reset-password.html once the recovery link has handed back
       an access token (see that page's script for how the fragment becomes
       a session). */
    resetPassword: function (accessToken, next) {
      return fetch(URL_BASE + "/auth/v1/user", {
        method: "PUT",
        headers: {
          apikey: ANON,
          Authorization: "Bearer " + accessToken,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ password: next })
      }).then(function (res) {
        return res.json().catch(function () { return null; }).then(function (body) {
          if (!res.ok) throw fail(readError(body, res.status), res.status);
          return { ok: true };
        });
      });
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
      }).then(function (rows) {
        selfProfile = one(rows);
        return { user: shapeSelf(selfProfile) };
      });
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

        var user = withRelation(out[1], row);
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
            .map(function (r) { return withRelation(out[1], r); })
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
              var person = shapeUser(row, {
                edgeId: edge.id,
                relation: relationOf(rows, otherId)
              });

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
      var name = String(username).replace(/^@/, "");
      /* A six-character handle typed into the username box is a friend
         code, not a username — the Node backend already tolerates that. */
      if (/^[A-Za-z0-9]{3}[- ]?[A-Za-z0-9]{3}$/.test(name)) {
        return API.addFriendByCode(name).catch(function (err) {
          if (err.status === 404 || /no account uses that code/i.test(err.message)) {
            return lookupUser(name).then(function (row) { return sendRequest(row.id); });
          }
          throw err;
        });
      }
      return lookupUser(name).then(function (row) { return sendRequest(row.id); });
    },

    addFriendByCode: function (code) {
      return rpc("find_by_code", { code: code }).then(function (hit) {
        return sendRequest(hit.id);
      });
    },

    /* find_by_code now returns a full person plus the relation and edge id,
       so a code lookup renders exactly like a search hit — buttons and all. */
    lookupCode: function (code) {
      return rpc("find_by_code", { code: code }).then(function (hit) {
        edgesCache = null;
        return { user: hit, relation: hit.relation || "none" };
      });
    },

    rotateCode: function () {
      return rpc("rotate_friend_code").then(function (code) {
        if (selfProfile) selfProfile.friend_code = code;
        return { friendCode: code };
      });
    },

    /* Through an RPC rather than a PATCH: the update policy grants the row to
       both sides of an edge, so a direct PATCH let the person who SENT a
       request accept it themselves, and aiming at the wrong edge came back
       200-with-zero-rows, which looked like success. */
    acceptFriend: function (id) {
      return rpc("accept_request", { edge: Number(id) })
        .then(function () { edgesCache = null; return { state: "friends" }; });
    },

    removeFriend: function (id) {
      if (id == null || id === "" || !isFinite(Number(id))) {
        return Promise.reject(fail("That request is no longer there — reload the page.", 400));
      }
      return rest("/friendships?id=eq." + Number(id), {
        method: "DELETE", headers: { Prefer: "return=representation" }
      }).then(function (rows) {
        edgesCache = null;
        /* A block raised by the other person is not yours to lift, and the
           delete policy refuses it by returning nothing rather than erroring. */
        if (Array.isArray(rows) && !rows.length) {
          throw fail("That isn't yours to undo.", 403);
        }
        return { ok: true };
      });
    },

    blockUser: function (username) {
      return lookupUser(String(username).replace(/^@/, ""))
        .then(function (row) { return rpc("block_user", { target: row.id }); })
        .then(function () { edgesCache = null; return { state: "blocked" }; });
    },

    /* --- messages --- */

    /* One RPC.
       The old version pulled the newest 400 messages across every thread at
       once and worked the previews and unread counts out in the browser, so
       on a busy account everything past the first few conversations came back
       with no preview and an unread count of zero. */
    threads: function () {
      if (!session) return Promise.reject(fail("Signed out.", 401));

      return rpc("thread_list").then(function (rows) {
        return {
          threads: (rows || []).map(function (t) {
            var people = (t.members || []).map(function (m) {
              return {
                id: m.id,
                username: m.username,
                displayName: m.displayName || m.username,
                role: m.role,
                state: m.state,
                lastSeen: Number(m.lastSeen) || 0,
                online: !!m.lastSeen && Date.now() - Number(m.lastSeen) < ONLINE_MS
              };
            });
            return {
              id: t.id,
              isGroup: !!t.isGroup,
              title: t.isGroup
                ? (t.rawTitle || people.map(function (p) { return p.displayName; }).join(", ") || "Group")
                : (people[0] ? people[0].displayName : "Conversation"),
              with: t.isGroup ? null : (people[0] || null),
              members: people,
              memberCount: people.length + 1,
              owner: !!t.owner,
              lastAt: Number(t.lastAt) || 0,
              unread: Number(t.unread) || 0,
              preview: t.preview && t.preview.at ? {
                body: t.preview.body || "",
                mine: !!t.preview.mine,
                who: t.preview.who || "",
                at: Number(t.preview.at) || 0
              } : null
            };
          })
        };
      });
    },

    /* `after` means "the caller already has the conversation open and only
       wants what is new". That is a 5-second poll, so it fetches messages
       alone: the thread row, the member list and the can-I-post check do not
       change between two ticks, and asking for them anyway was four requests
       every five seconds for three unchanging answers. */
    thread: function (id, after) {
      if (!session) return Promise.reject(fail("Signed out.", 401));
      var mine = session.user.id;
      var incremental = Number(after) > 0;

      var newMessages =
        rest("/messages?select=id,sender,body,created_at,deleted,attachment_id," +
             "profiles!inner(username,display_name)," +
             "attachments(id,mime,width,height,bytes,kind)" +
             "&thread_id=eq." + id + "&id=gt." + (Number(after) || 0) +
             "&order=id.asc&limit=200");

      return Promise.all(incremental ? [null, null, newMessages, null] : [
        rest("/threads?select=*&id=eq." + id).then(one),
        rest("/thread_members?select=user_id,profiles!inner(" + PROFILE_COLS + ")&thread_id=eq." + id),
        newMessages,
        /* Whether posting here is actually allowed. It used to be hardcoded
           true, so a conversation with someone who has since blocked you, or
           turned off open DMs, looked normal right up until send failed. */
        rpc("post_block_reason", { t: Number(id) }).catch(function () { return null; })
      ]).then(function (out) {
        var messages = out[2] || [];

        /* Mark anything of theirs we just read. Through an RPC, because the
           blanket "any member may update any message" policy this used to
           rely on also let one group member retract another's. Only worth a
           round trip when something actually arrived. */
        if (!incremental || messages.length) {
          rpc("mark_thread_read", { t: Number(id) }).catch(function () {});
        }

        if (incremental) {
          return { threadId: Number(id), messages: messages.map(shapeMessage) };
        }

        var t = out[0];
        if (!t) throw fail("No such thread.", 404);

        var people = (out[1] || [])
          .filter(function (m) { return m.user_id !== mine; })
          .map(function (m) { return shapeUser(m.profiles); });

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
          canSend: !out[3],
          lockedReason: out[3] || "",
          messages: messages.map(shapeMessage)
        };

        function shapeMessage(m) {
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
        }
      });
    },

    /* The echoed message needs a name on it. It used to read that out of
       `session.user.user_metadata`, which is a snapshot taken at sign-up: it
       goes stale when someone renames themselves, and a session restored from
       an older token may not carry it at all — in which case sending threw a
       TypeError instead of posting. */
    send: function (id, body, image) {
      return me().then(function (self) {
        return rpc("send_message", { t: Number(id), body: body || "", image: image || null })
          .then(function (messageId) {
            return {
              message: {
                id: messageId,
                mine: true,
                from: {
                  username: (self && self.username) || "you",
                  displayName: (self && (self.display_name || self.username)) || "You"
                },
                body: body || "",
                deleted: false,
                at: Date.now(),
                image: image ? {
                  id: 0, url: image.dataUrl,
                  mime: String(image.dataUrl || "").slice(5).split(";")[0] || "image/jpeg",
                  width: image.width, height: image.height, kind: image.kind
                } : null
              }
            };
          });
      });
    },

    openThread: function (username) {
      return rpc("open_thread", { with_username: String(username).replace(/^@/, "") })
        .then(function (threadId) { return { threadId: threadId }; });
    },

    /* Through an RPC so the attachment goes with it. A retracted message used
       to keep its image row, still readable by everyone else in the thread —
       "message removed" on screen and the picture still served underneath. */
    deleteMessage: function (id) {
      return rpc("retract_message", { m: Number(id) })
        .then(function () { return { ok: true }; });
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
      return rpc("put_game_save", { p_host: host, payload: payload })
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
              email: r.email || "",
              acceptsDms: !!r.accepts_dms,
              showActivity: !!r.show_activity,
              sessions: 0,
              friends: Number(r.friends) || 0,
              messages: Number(r.messages) || 0,
              reports: Number(r.reports) || 0,
              playing: r.current_game || "",
              lastLogin: ms(r.last_login),
              mutedUntil: r.muted_until || null
            });
          })
        };
      });
    },

    /* Every one of these used to be a direct table write, which meant none of
       the rank rules existed on this backend: an admin could promote anyone to
       admin, demote another admin, and — because the guard trigger reverts a
       refused change silently — get a 200 back with the row unchanged, which
       reads exactly like it worked. The RPC enforces the ladder, refuses out
       loud, and writes the audit row that was never being written. */
    adminUpdateUser: function (id, patch) {
      return rpc("admin_set_user", {
        target: id,
        next_role: patch.role === undefined ? null : patch.role,
        next_state: patch.state === undefined ? null : patch.state
      }).then(function (user) { return { user: user }; });
    },

    /* Staff-issued password reset — the account-recovery answer to "I lost
       access". A real password can never be shown to staff (Supabase Auth
       only ever stores a one-way hash, on this or any platform), so this
       sets a NEW one instead and immediately invalidates every existing
       session/refresh token, exactly like Discord/every real platform's
       support-side recovery flow. */
    adminSetPassword: function (id, newPassword) {
      return rpc("admin_set_password", { target: id, new_password: newPassword });
    },

    adminDeleteUser: function (id) {
      return rpc("admin_delete_user", { target: id })
        .then(function () { return { ok: true }; });
    },

    /* Staff-only notes on an account — never visible to the user themselves.
       Lets a report or ticket carry context ("already warned 3/1") without
       leaking it to the person it's about. */
    adminAddNote: function (id, body) {
      return rpc("admin_add_note", { target: id, note_body: body });
    },
    adminListNotes: function (id) {
      return rpc("admin_list_notes", { target: id });
    },
    adminDeleteNote: function (noteId) {
      return rpc("admin_delete_note", { note_id: noteId })
        .then(function () { return { ok: true }; });
    },

    /* Site-wide banner, admin+ only. One row is live at a time. */
    adminSetAnnouncement: function (body, severity, ttlHours) {
      return rpc("admin_set_announcement", {
        body_text: body, severity_level: severity || "info",
        ttl_hours: ttlHours || null
      });
    },
    adminClearAnnouncement: function () {
      return rpc("admin_clear_announcement", {}).then(function () { return { ok: true }; });
    },
    currentAnnouncement: function () {
      return rpc("current_announcement", {});
    },

    /* Chat mute — refused at the database, same as `suspended` already is. */
    adminSetMute: function (id, minutes) {
      return rpc("admin_set_mute", { target: id, minutes: minutes });
    },

    /* ---- Campus+ : YouTube-link playlists ---- */
    createPlaylist: function (title, description, isPublic) {
      return rpc("create_playlist", {
        p_title: title, p_description: description || "", p_is_public: !!isPublic
      });
    },
    updatePlaylist: function (id, patch) {
      return rpc("update_playlist", {
        p_id: id,
        p_title: patch.title === undefined ? null : patch.title,
        p_description: patch.description === undefined ? null : patch.description,
        p_is_public: patch.isPublic === undefined ? null : patch.isPublic
      });
    },
    deletePlaylist: function (id) {
      return rpc("delete_playlist", { p_id: id }).then(function () { return { ok: true }; });
    },
    addPlaylistItem: function (playlistId, videoId, title) {
      return rpc("add_playlist_item", {
        p_playlist_id: playlistId, p_video_id: videoId, p_title: title || ""
      });
    },
    removePlaylistItem: function (itemId) {
      return rpc("remove_playlist_item", { p_item_id: itemId }).then(function () { return { ok: true }; });
    },
    reorderPlaylistItem: function (itemId, position) {
      return rpc("reorder_playlist_item", { p_item_id: itemId, p_position: position })
        .then(function () { return { ok: true }; });
    },
    myPlaylists: function () {
      return rpc("my_playlists", {});
    },
    publicPlaylists: function (q) {
      return rpc("public_playlists", { q: q || null });
    },
    playlistDetail: function (id) {
      return rpc("playlist_detail", { p_id: id });
    },
    acceptPolicy: function (version) {
      return rpc("accept_policy", { version: version });
    },
    myLogins: function () {
      return rpc("my_logins");
    },
    requestEmailCode: function () {
      return rpc("request_email_code");
    },
    verifyEmailCode: function (code) {
      return rpc("verify_email_code", { code: String(code || "") });
    },
    myEmailVerified: function () {
      return rpc("my_email_verified");
    },
    adminListPlaylists: function (q) {
      return rpc("admin_list_playlists", { q: q || null });
    },
    adminDeletePlaylist: function (id) {
      return rpc("delete_playlist", { p_id: id }).then(function () { return { ok: true }; });
    },
    adminSetPlus: function (id, grant) {
      return rpc("admin_set_plus", { target: id, grant_it: !!grant });
    },
    adminSetBanned: function (id, ban, reason) {
      return rpc("admin_set_banned", { target: id, ban: !!ban, reason: reason || null });
    },

    adminReports: function (state) {
      return rpc("admin_reports", { want_state: state || "open" }).then(function (rows) {
        return {
          reports: (rows || []).map(function (r) {
            return {
              id: r.id, kind: r.kind, target: r.target, reason: r.reason,
              state: r.state, at: Number(r.at) || 0,
              reporter: r.reporter || "(deleted)",
              subject: r.subject || null
            };
          })
        };
      });
    },

    adminCloseReport: function (id, state) {
      return rpc("admin_set_report", { r: Number(id), next_state: state || "closed" })
        .then(function () { return { ok: true }; });
    },

    adminAudit: function (q) {
      return rpc("admin_audit", { q: q || null, limit_to: 300 }).then(function (rows) {
        return {
          entries: (rows || []).map(function (r) {
            return {
              id: r.id, actor: r.actor || "system",
              action: r.action, detail: r.detail, at: Number(r.at) || 0
            };
          })
        };
      });
    }
  };

  /* One place that turns a typed handle into a row, so every caller reports
     a missing account the same way. A profile hidden by a block reads as
     absent here, which is the point of a block. */
  function lookupUser(username) {
    return rest("/profiles?select=id,username,state&username=eq." +
                encodeURIComponent(String(username)))
      .then(one)
      .then(function (row) {
        if (!row) throw fail("No such user.", 404);
        return row;
      });
  }

  function sendRequest(otherId) {
    if (!session) return Promise.reject(fail("Signed out.", 401));
    var mine = session.user.id;
    if (otherId === mine) return Promise.reject(fail("That's you.", 400));

    return Promise.all([
      edges(true),
      rest("/profiles?select=id,state&id=eq." + otherId).then(one)
    ]).then(function (out) {
      var rows = out[0];
      var them = out[1];
      if (!them) throw fail("No such user.", 404);
      if (them.state === "suspended") throw fail("That account is suspended.", 403);

      var existing = edgeOf(rows, otherId);

      if (existing) {
        if (existing.state === "accepted") throw fail("Already friends.", 409);
        if (existing.state === "blocked") throw fail("That isn't possible.", 403);
        if (existing.requester === mine) throw fail("Request already sent.", 409);
        /* They asked first — treat this as accepting. */
        return rpc("accept_request", { edge: existing.id })
          .then(function () { edgesCache = null; return { state: "friends" }; });
      }

      return rest("/friendships", {
        method: "POST", body: { requester: mine, addressee: otherId, state: "pending" }
      }).then(function () { edgesCache = null; return { state: "pending-out" }; });
    });
  }

  window.API = API;
})();

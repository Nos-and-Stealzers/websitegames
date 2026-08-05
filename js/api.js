/* Thin API client.
   The site is still a static site: if no backend answers, `API.available`
   settles to false and every account feature quietly hides itself rather than
   erroring. Nothing here is required for browsing or playing. */
(function () {
  "use strict";

  /* Same origin by default; SITE.apiBase points it at a separately hosted
     backend (static site on Vercel, API on a Node host, say). */
  var BASE = String((window.SITE && window.SITE.apiBase) || "").replace(/\/+$/, "") + "/api";
  var CROSS_ORIGIN = BASE.charAt(0) !== "/";

  /* Thrown for any non-2xx so callers can `catch (err) { err.message }`. */
  function ApiError(message, status, data) {
    var err = new Error(message);
    err.status = status;
    err.data = data;
    return err;
  }

  var CAN_FETCH = typeof window.fetch === "function";

  function request(method, path, body) {
    /* No fetch means no backend, full stop. Rejecting here keeps every caller
       on its normal error path instead of throwing a ReferenceError that would
       leave Session.ready pending forever and hang the gated pages. */
    if (!CAN_FETCH) {
      return Promise.reject(ApiError("This browser can't reach the hub's server.", 0, null));
    }

    var opts = {
      method: method,
      /* Cross-origin needs "include" or the session cookie is never sent. */
      credentials: CROSS_ORIGIN ? "include" : "same-origin",
      headers: { "Accept": "application/json" }
    };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }

    return fetch(BASE + path, opts).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) {
          throw ApiError((data && data.error) || "Request failed (" + res.status + ")",
                         res.status, data);
        }
        return data;
      });
    });
  }

  var probe = null;

  /* Resolves true/false once, then caches.
     `backend: "none"` skips the probe entirely, so a static deploy does not
     fire a doomed /api/health request on every page load. */
  function available() {
    if (!probe) {
      var mode = (window.SITE && window.SITE.backend) || "auto";
      if (mode === "none" || mode === "supabase") {
        probe = Promise.resolve(false);
      } else {
        probe = request("GET", "/health")
          .then(function (info) { API.health = info; return true; })
          .catch(function () { return false; });
      }
    }
    return probe;
  }

  var API = {
    available: available,
    health: null,

    get: function (p) { return request("GET", p); },
    post: function (p, b) { return request("POST", p, b); },
    put: function (p, b) { return request("PUT", p, b); },
    patch: function (p, b) { return request("PATCH", p, b); },
    del: function (p, b) { return request("DELETE", p, b); },

    /* --- auth --- */
    me: function () { return request("GET", "/auth/me"); },
    login: function (username, password) {
      return request("POST", "/auth/login", { username: username, password: password });
    },
    signup: function (username, password, displayName, acceptedTerms) {
      return request("POST", "/auth/signup", {
        username: username, password: password, displayName: displayName,
        acceptedTerms: acceptedTerms === true
      });
    },

    /* Presence, for the staff live view. Failures are ignored by callers —
       it is telemetry, not something to interrupt play over. */
    setPlaying: function (gameId) {
      return request("POST", "/users/me/playing", { gameId: gameId || "" });
    },
    adminLive: function () { return request("GET", "/admin/live"); },
    adminLogins: function () { return request("GET", "/admin/logins"); },
    logout: function () { return request("POST", "/auth/logout"); },
    changePassword: function (current, next) {
      return request("POST", "/auth/password", { current: current, next: next });
    },
    sessions: function () { return request("GET", "/auth/sessions"); },
    signOutEverywhere: function () { return request("POST", "/auth/signout-everywhere"); },

    /* --- profile --- */
    updateProfile: function (patch) { return request("PATCH", "/users/me", patch); },
    deleteAccount: function (confirm) { return request("DELETE", "/users/me", { confirm: confirm }); },
    user: function (username) { return request("GET", "/users/" + encodeURIComponent(username)); },
    searchUsers: function (q) { return request("GET", "/users/search?q=" + encodeURIComponent(q)); },

    /* --- friends --- */
    friends: function () { return request("GET", "/friends"); },
    addFriend: function (username) { return request("POST", "/friends/request", { username: username }); },
    addFriendByCode: function (code) { return request("POST", "/friends/request", { code: code }); },
    lookupCode: function (code) { return request("POST", "/friends/code", { code: code }); },
    rotateCode: function () { return request("POST", "/users/me/code"); },
    acceptFriend: function (id) { return request("POST", "/friends/" + id + "/accept"); },
    removeFriend: function (id) { return request("DELETE", "/friends/" + id); },
    blockUser: function (username) { return request("POST", "/friends/block", { username: username }); },

    /* --- messages --- */
    threads: function () { return request("GET", "/messages/threads"); },
    thread: function (id, after) {
      return request("GET", "/messages/threads/" + id + (after ? "?after=" + after : ""));
    },
    send: function (id, body, image) {
      return request("POST", "/messages/threads/" + id, { body: body, image: image || undefined });
    },
    openThread: function (username) {
      return request("POST", "/messages/with/" + encodeURIComponent(username));
    },

    /* --- groups --- */
    createGroup: function (title, usernames) {
      return request("POST", "/threads/group", { title: title, usernames: usernames });
    },
    renameGroup: function (id, title) { return request("PATCH", "/threads/" + id, { title: title }); },
    addToGroup: function (id, username) {
      return request("POST", "/threads/" + id + "/members", { username: username });
    },
    removeFromGroup: function (id, userId) {
      return request("DELETE", "/threads/" + id + "/members/" + userId);
    },
    deleteMessage: function (id) { return request("DELETE", "/messages/" + id); },
    unread: function () { return request("GET", "/messages/unread"); },

    /* --- notifications --- */
    notifications: function (opts) {
      opts = opts || {};
      return request("GET", "/notifications?limit=" + (opts.limit || 40) +
        (opts.unreadOnly ? "&unread=1" : ""));
    },
    markRead: function (ids) {
      return request("POST", "/notifications/read",
        ids === "all" ? { all: true } : { ids: ids });
    },
    dismissNotification: function (id) { return request("DELETE", "/notifications/" + id); },
    clearNotifications: function () { return request("DELETE", "/notifications"); },

    /* --- save sync --- */
    getSave: function () { return request("GET", "/sync"); },
    putSave: function (save) { return request("PUT", "/sync", { save: save }); },
    popular: function () { return request("GET", "/games/popular"); },

    /* --- reports --- */
    report: function (kind, target, reason) {
      return request("POST", "/reports", { kind: kind, target: target, reason: reason });
    },

    /* --- feedback --- */
    sendFeedback: function (payload) { return request("POST", "/feedback", payload); },
    myFeedback: function () { return request("GET", "/feedback/mine"); },
    adminFeedback: function (state) {
      return request("GET", "/admin/feedback?state=" + (state || "new"));
    },
    adminUpdateFeedback: function (id, patch) {
      return request("PATCH", "/admin/feedback/" + id, patch);
    },

    /* --- third-party game progress --- */
    putGameSave: function (host, payload) {
      return request("PUT", "/game-saves/" + encodeURIComponent(host), { payload: payload });
    },
    getGameSave: function (host) {
      return request("GET", "/game-saves/" + encodeURIComponent(host));
    },
    listGameSaves: function () { return request("GET", "/game-saves"); },
    dropGameSave: function (host) {
      return request("DELETE", "/game-saves/" + encodeURIComponent(host));
    },

    /* --- admin --- */
    adminOverview: function () { return request("GET", "/admin/overview"); },
    adminUsers: function (q) { return request("GET", "/admin/users" + (q ? "?q=" + encodeURIComponent(q) : "")); },
    adminUpdateUser: function (id, patch) { return request("PATCH", "/admin/users/" + id, patch); },
    adminDeleteUser: function (id) { return request("DELETE", "/admin/users/" + id); },
    adminReports: function (state) { return request("GET", "/admin/reports?state=" + (state || "open")); },
    adminCloseReport: function (id, state) {
      return request("PATCH", "/admin/reports/" + id, { state: state || "closed" });
    },
    adminAudit: function () { return request("GET", "/admin/audit"); }
  };

  window.API = API;
})();

/* Thin API client.
   The site is still a static site: if no backend answers, `API.available`
   settles to false and every account feature quietly hides itself rather than
   erroring. Nothing here is required for browsing or playing. */
(function () {
  "use strict";

  var BASE = "/api";

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
      credentials: "same-origin",
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

  /* Resolves true/false once, then caches. */
  function available() {
    if (!probe) {
      probe = request("GET", "/health")
        .then(function (info) { API.health = info; return true; })
        .catch(function () { return false; });
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
    signup: function (username, password, displayName) {
      return request("POST", "/auth/signup",
        { username: username, password: password, displayName: displayName });
    },
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
    acceptFriend: function (id) { return request("POST", "/friends/" + id + "/accept"); },
    removeFriend: function (id) { return request("DELETE", "/friends/" + id); },
    blockUser: function (username) { return request("POST", "/friends/block", { username: username }); },

    /* --- messages --- */
    threads: function () { return request("GET", "/messages/threads"); },
    thread: function (id, after) {
      return request("GET", "/messages/threads/" + id + (after ? "?after=" + after : ""));
    },
    send: function (id, body) { return request("POST", "/messages/threads/" + id, { body: body }); },
    openThread: function (username) {
      return request("POST", "/messages/with/" + encodeURIComponent(username));
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

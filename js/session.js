/* Who's signed in, and keeping their local save in step with the server.
   Signed out, the site behaves exactly as it always has — localStorage only. */
(function () {
  "use strict";

  var user = null;
  var backend = false;
  var badges = { messages: 0, requests: 0, notifications: 0 };
  var readyResolve;
  var ready = new Promise(function (r) { readyResolve = r; });
  var pushTimer = null;

  function emit(name, detail) {
    document.dispatchEvent(new CustomEvent(name, { detail: detail }));
  }

  function setUser(next) {
    user = next || null;
    emit("session:change", { user: user });
    return user;
  }

  /* ------------------------------------------------------------ save sync */

  /* Push the local save up and adopt whatever the server merges back, so a
     second device never wipes what the first one built up. */
  function pushSave() {
    if (!user) return Promise.resolve(null);
    return window.API.putSave(window.Store.exportAll())
      .then(function (res) {
        window.Store.importAll(res.save, { silent: true });
        emit("session:synced", { at: res.updatedAt });
        return res.save;
      })
      .catch(function () { return null; });   // offline is not an error here
  }

  /* Coalesce bursts of local changes into one upload. */
  function schedulePush() {
    if (!user) return;
    window.clearTimeout(pushTimer);
    pushTimer = window.setTimeout(pushSave, 2500);
  }

  /* ------------------------------------------------------------- lifecycle */

  function refreshBadges() {
    if (!user) {
      badges = { messages: 0, requests: 0, notifications: 0 };
      return Promise.resolve(badges);
    }
    return window.API.unread()
      .then(function (res) {
        badges = {
          messages: res.messages || 0,
          requests: res.requests || 0,
          notifications: res.notifications || 0
        };
        emit("session:badges", badges);
        return badges;
      })
      .catch(function () { return badges; });
  }

  function boot() {
    return window.API.available().then(function (ok) {
      backend = ok;
      if (!ok) { readyResolve({ user: null, backend: false }); return; }

      return window.API.me()
        .then(function (res) { setUser(res.user); })
        .catch(function () { setUser(null); })
        .then(function () {
          readyResolve({ user: user, backend: true });
          if (user) {
            pushSave();
            refreshBadges();
            window.setInterval(refreshBadges, 45000);
          }
        });
    });
  }

  function login(username, password) {
    return window.API.login(username, password).then(function (res) {
      setUser(res.user);
      return pushSave().then(function () {
        refreshBadges();
        return res.user;
      });
    });
  }

  function signup(username, password, displayName) {
    return window.API.signup(username, password, displayName).then(function (res) {
      setUser(res.user);
      /* Everything played before signing up comes along. */
      return pushSave().then(function () {
        refreshBadges();
        return res;
      });
    });
  }

  function logout() {
    /* Flush before dropping the session, then keep the local copy as-is. */
    return pushSave()
      .then(function () { return window.API.logout(); })
      .catch(function () { /* log out locally regardless */ })
      .then(function () {
        setUser(null);
        badges = { messages: 0, requests: 0, notifications: 0 };
      });
  }

  /* Send the visitor to the sign-in page, remembering where they were. */
  function requireUser() {
    return ready.then(function () {
      if (user) return user;
      var back = window.location.pathname.split("/").pop() + window.location.search;
      window.location.href = "login.html?next=" + encodeURIComponent(back);
      return null;
    });
  }

  var Session = {
    ready: ready,
    get user() { return user; },
    get backend() { return backend; },
    get badges() { return badges; },
    isStaff: function () { return !!user && (user.role === "admin" || user.role === "mod"); },
    isAdmin: function () { return !!user && user.role === "admin"; },
    login: login,
    signup: signup,
    logout: logout,
    setUser: setUser,
    pushSave: pushSave,
    schedulePush: schedulePush,
    refreshBadges: refreshBadges,
    requireUser: requireUser
  };

  window.Session = Session;

  /* Any local change while signed in eventually reaches the server. */
  document.addEventListener("store:change", function (event) {
    if (event.detail && event.detail.silent) return;
    schedulePush();
  });
  window.addEventListener("beforeunload", function () {
    if (user && pushTimer) { window.clearTimeout(pushTimer); pushSave(); }
  });

  boot();
})();

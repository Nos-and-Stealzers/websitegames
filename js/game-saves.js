/* Cross-device game progress.
 *
 * Games keep their progress in localStorage belonging to the origin that
 * serves them — not to this site. The same-origin policy means the hub simply
 * cannot read it, and no amount of cleverness changes that.
 *
 * The way through is a page on that origin: save-bridge.html sits at the root
 * of each game repo. The hub loads it in a hidden iframe and asks it, over
 * postMessage, to hand back a snapshot or put one back. That snapshot is what
 * syncs to the account.
 *
 * Restores merge rather than overwrite, so pulling a save onto a device that
 * has newer progress can't wipe it.
 */
(function () {
  "use strict";

  var CHANNEL = "ach-save-bridge";
  var TIMEOUT = 8000;

  var frames = {};      // host -> { iframe, ready, queue }
  var seq = 0;
  var waiting = {};     // id -> { resolve, reject, timer }

  function hostsFromConfig() {
    var out = [];
    var map = (window.SITE && window.SITE.gameHosts) || {};
    Object.keys(map).forEach(function (key) {
      var origin = String(map[key] || "").replace(/\/+$/, "");
      if (!origin) return;
      if (out.indexOf(origin) === -1) out.push(origin);
    });
    return out;
  }

  /* A GitHub Pages project site lives under /<repo>/, so the bridge sits at
     the repo root, not the domain root. Deriving it from the configured game
     base keeps that correct for any host. */
  function bridgeUrl(origin) {
    return origin.replace(/\/+$/, "") + "/save-bridge.html";
  }

  function keyFor(origin) {
    try { return new URL(origin).host; } catch (e) { return origin; }
  }

  window.addEventListener("message", function (event) {
    var msg = event.data;
    if (!msg || msg.channel !== CHANNEL) return;

    if (msg.action === "ready") {
      Object.keys(frames).forEach(function (origin) {
        if (origin.indexOf(msg.host) !== -1) frames[origin].ready = true;
      });
      return;
    }

    var pending = waiting[msg.id];
    if (!pending) return;
    delete waiting[msg.id];
    window.clearTimeout(pending.timer);
    if (msg.ok) pending.resolve(msg);
    else pending.reject(new Error(msg.error || "Bridge refused"));
  });

  function frameFor(origin) {
    if (frames[origin]) return Promise.resolve(frames[origin]);

    return new Promise(function (resolve, reject) {
      var iframe = document.createElement("iframe");
      iframe.src = bridgeUrl(origin);
      iframe.setAttribute("aria-hidden", "true");
      iframe.setAttribute("tabindex", "-1");
      iframe.title = "Save bridge";
      iframe.style.cssText =
        "position:absolute;width:1px;height:1px;left:-9999px;top:-9999px;border:0;";

      var settled = false;
      iframe.addEventListener("load", function () {
        if (settled) return;
        settled = true;
        frames[origin] = { iframe: iframe, ready: true };
        resolve(frames[origin]);
      });
      iframe.addEventListener("error", function () {
        if (settled) return;
        settled = true;
        reject(new Error("No save bridge on " + origin));
      });

      document.body.appendChild(iframe);

      window.setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error("Save bridge on " + origin + " did not load"));
      }, TIMEOUT);
    });
  }

  function ask(origin, payload) {
    return frameFor(origin).then(function (entry) {
      return new Promise(function (resolve, reject) {
        var id = ++seq;
        waiting[id] = {
          resolve: resolve,
          reject: reject,
          timer: window.setTimeout(function () {
            delete waiting[id];
            reject(new Error("Save bridge timed out"));
          }, TIMEOUT)
        };
        entry.iframe.contentWindow.postMessage(
          Object.assign({ channel: CHANNEL, id: id }, payload), origin
        );
      });
    });
  }

  /* ------------------------------------------------------------- public */

  /* Pull every host's game storage up to the account. */
  function backup(onProgress) {
    if (!window.Session || !window.Session.user) {
      return Promise.reject(new Error("Sign in to sync game progress."));
    }
    var origins = hostsFromConfig();
    var done = [];

    return origins.reduce(function (chain, origin) {
      return chain.then(function () {
        if (onProgress) onProgress(keyFor(origin), "reading");
        return ask(origin, { action: "read" })
          .then(function (res) {
            if (!res.keys) { done.push({ host: keyFor(origin), keys: 0, skipped: true }); return; }
            return window.API.putGameSave(keyFor(origin), res.data).then(function (out) {
              done.push({ host: keyFor(origin), keys: res.keys, bytes: out && out.bytes });
            });
          })
          .catch(function (err) {
            done.push({ host: keyFor(origin), error: err.message });
          });
      });
    }, Promise.resolve()).then(function () { return done; });
  }

  /* Push the account's copy back down into each origin. */
  function restore(overwrite, onProgress) {
    if (!window.Session || !window.Session.user) {
      return Promise.reject(new Error("Sign in to restore game progress."));
    }
    var origins = hostsFromConfig();
    var done = [];

    return origins.reduce(function (chain, origin) {
      return chain.then(function () {
        var host = keyFor(origin);
        if (onProgress) onProgress(host, "restoring");
        return window.API.getGameSave(host)
          .then(function (res) {
            var keys = Object.keys(res.payload || {});
            if (!keys.length) { done.push({ host: host, written: 0, empty: true }); return; }
            return ask(origin, { action: "write", data: res.payload, overwrite: !!overwrite })
              .then(function (out) {
                done.push({ host: host, written: out.written, kept: out.kept });
              });
          })
          .catch(function (err) {
            done.push({ host: host, error: err.message });
          });
      });
    }, Promise.resolve()).then(function () { return done; });
  }

  /* Is the bridge actually deployed on each host? */
  function probe() {
    return Promise.all(hostsFromConfig().map(function (origin) {
      return ask(origin, { action: "ping" })
        .then(function () { return { host: keyFor(origin), ok: true }; })
        .catch(function (err) { return { host: keyFor(origin), ok: false, error: err.message }; });
    }));
  }

  window.GameSaves = {
    hosts: hostsFromConfig,
    backup: backup,
    restore: restore,
    probe: probe
  };
})();

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
            /* Many games — anything Unity, most newer HTML5 ones — keep their
               save in IndexedDB rather than localStorage, so a snapshot with
               no localStorage keys is not necessarily an empty one. */
            var idbNames = Object.keys(res.idb || {});
            if (!res.keys && !idbNames.length) {
              done.push({
                host: keyFor(origin), keys: 0, skipped: true,
                note: res.idbUnsupported ? "this browser can't list IndexedDB" : null
              });
              return;
            }

            var payload = { local: res.data || {}, idb: res.idb || {} };
            return window.API.putGameSave(keyFor(origin), payload).then(function (out) {
              done.push({
                host: keyFor(origin),
                keys: res.keys,
                databases: idbNames.length,
                bytes: out && out.bytes
              });
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
            var stored = res.payload || {};

            /* Snapshots taken before IndexedDB support were a flat map of
               localStorage keys. Read both shapes so older backups still
               restore. */
            var local = stored.local || (stored.idb ? {} : stored);
            var idb = stored.idb || {};

            if (!Object.keys(local).length && !Object.keys(idb).length) {
              done.push({ host: host, written: 0, empty: true });
              return;
            }

            return ask(origin, {
              action: "write", data: local, idb: idb, overwrite: !!overwrite
            }).then(function (out) {
              done.push({
                host: host,
                written: (out.written || 0) + (out.idbWritten || 0),
                kept: out.kept
              });
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

  /* ---- direct access, for the admin game-data editor ---- */

  function originFor(hostOrOrigin) {
    if (/^https?:/i.test(hostOrOrigin)) return hostOrOrigin.replace(/\/+$/, "");
    var match = hostsFromConfig().filter(function (o) {
      return keyFor(o) === hostOrOrigin;
    })[0];
    return match || null;
  }

  function readAll(hostOrOrigin) {
    var origin = originFor(hostOrOrigin);
    if (!origin) return Promise.reject(new Error("Unknown game host."));
    return ask(origin, { action: "read" }).then(function (res) {
      return { host: keyFor(origin), data: res.data || {}, skipped: res.skipped || 0 };
    });
  }

  /* overwrite defaults true here: the editor exists precisely to change
     values that already exist. */
  function writeKeys(hostOrOrigin, data, overwrite) {
    var origin = originFor(hostOrOrigin);
    if (!origin) return Promise.reject(new Error("Unknown game host."));
    return ask(origin, {
      action: "write", data: data, overwrite: overwrite !== false
    });
  }

  function removeKeys(hostOrOrigin, keys) {
    var origin = originFor(hostOrOrigin);
    if (!origin) return Promise.reject(new Error("Unknown game host."));
    return ask(origin, { action: "remove", keys: keys });
  }

  window.GameSaves = {
    hosts: hostsFromConfig,
    hostKey: keyFor,
    backup: backup,
    restore: restore,
    probe: probe,
    readAll: readAll,
    writeKeys: writeKeys,
    removeKeys: removeKeys
  };
})();

/* Which saved keys belong to which game.
 *
 * There is no way to know this in advance. A host serves up to 145 games into
 * one shared localStorage, the games are third-party, and there are 219 of
 * them with no common convention — so a hand-written list per game would be
 * both enormous and wrong within a week.
 *
 * So it is learned instead, two ways:
 *
 *   1. By name. Most games namespace their keys with something close to their
 *      own folder or title. That is a guess, so it is labelled as one.
 *
 *   2. By watching. The player takes a snapshot of the host's storage when a
 *      game loads and again after you have played. Whatever appeared or
 *      changed in between belongs to that game. That is not a guess, and it
 *      is what turns the shared key soup into a per-game view.
 *
 * Attribution lives on the device, next to the settings. It describes what
 * this browser has seen, so it is never wrong about someone else's install.
 */
(function () {
  "use strict";

  var KEY = "ach:gamekeys";
  var MAX_GAMES = 400;          // plenty for the catalogue, bounded regardless

  function read() {
    try {
      var raw = window.localStorage.getItem(KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      return (parsed && typeof parsed === "object") ? parsed : {};
    } catch (err) { return {}; }
  }

  function write(all) {
    try {
      /* Trim the oldest if this ever grows past the cap, so a long-lived
         install cannot fill its storage quota with attribution data. */
      var ids = Object.keys(all);
      if (ids.length > MAX_GAMES) {
        ids.sort(function (a, b) { return (all[a].at || 0) - (all[b].at || 0); })
           .slice(0, ids.length - MAX_GAMES)
           .forEach(function (id) { delete all[id]; });
      }
      window.localStorage.setItem(KEY, JSON.stringify(all));
    } catch (err) { /* private mode, or quota */ }
  }

  /* Tokens worth matching against a key name. A game's id is prefixed with
     its host in the catalogue ("huge-bitlife"), and the useful part is what
     follows, plus the words of the title. */
  function tokensFor(game) {
    if (!game) return [];
    var out = {};
    var id = String(game.id || "");

    [id, id.replace(/^(huge|swfgalaxy|flashgames|hd_fnaf|eaglercraft)[-_]/, "")]
      .forEach(function (s) { if (s.length >= 4) out[s.toLowerCase()] = true; });

    /* The last path segment is usually the game's own folder. */
    var source = String(game.source || "");
    source.split("/").filter(Boolean).forEach(function (part) {
      var clean = part.replace(/\.(html?|swf|php)$/i, "");
      if (clean.length >= 4 && clean !== "index" && clean !== "games") {
        out[clean.toLowerCase()] = true;
      }
    });

    String(game.title || "").toLowerCase().split(/[^a-z0-9]+/)
      .forEach(function (w) { if (w.length >= 4) out[w] = true; });

    return Object.keys(out);
  }

  function looksLike(keyName, tokens) {
    var flat = String(keyName).toLowerCase().replace(/[^a-z0-9]/g, "");
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i].replace(/[^a-z0-9]/g, "");
      if (t.length >= 4 && flat.indexOf(t) !== -1) return true;
    }
    return false;
  }

  /* What changed between two snapshots of the same host. Both are plain
     name → value maps; a value that moved counts, and so does a new name. */
  function diff(before, after) {
    var changed = [];
    Object.keys(after || {}).forEach(function (name) {
      if (!before || !Object.prototype.hasOwnProperty.call(before, name) ||
          before[name] !== after[name]) {
        changed.push(name);
      }
    });
    return changed;
  }

  var GameKeys = {
    /* Everything this device has attributed to a game, watched or guessed. */
    forGame: function (game, available) {
      if (!game) return { watched: [], guessed: [] };

      var all = read();
      var entry = all[game.id] || {};
      var have = available || null;

      var watched = (entry.keys || []).filter(function (k) {
        return !have || Object.prototype.hasOwnProperty.call(have, k);
      });

      var seen = {};
      watched.forEach(function (k) { seen[k] = true; });

      var tokens = tokensFor(game);
      var guessed = Object.keys(have || {}).filter(function (k) {
        return !seen[k] && looksLike(k, tokens);
      });

      return { watched: watched, guessed: guessed, at: entry.at || 0 };
    },

    /* Record that these keys moved while `game` was open. Additive: a game
       written to on two different days keeps both sets. */
    learn: function (game, host, keys) {
      if (!game || !keys || !keys.length) return 0;

      var all = read();
      var entry = all[game.id] || { host: host, keys: [] };
      var seen = {};
      entry.keys.forEach(function (k) { seen[k] = true; });

      var added = 0;
      keys.forEach(function (k) {
        if (seen[k]) return;
        seen[k] = true;
        entry.keys.push(k);
        added++;
      });

      entry.host = host;
      entry.at = Date.now();
      all[game.id] = entry;
      write(all);
      return added;
    },

    /* Compare two snapshots and attribute the difference. */
    learnFromSnapshots: function (game, host, before, after) {
      return GameKeys.learn(game, host, diff(before, after));
    },

    /* Games this device has learned anything about. */
    known: function () {
      var all = read();
      return Object.keys(all).map(function (id) {
        return { id: id, host: all[id].host, keys: (all[id].keys || []).length, at: all[id].at };
      }).sort(function (a, b) { return b.at - a.at; });
    },

    forget: function (gameId) {
      var all = read();
      delete all[gameId];
      write(all);
    },

    /* Exposed for tests and for the editor's "why is this here" note. */
    tokensFor: tokensFor,
    diff: diff
  };

  window.GameKeys = GameKeys;
})();

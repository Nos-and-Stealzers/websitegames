/* Local-first persistence. Everything the site remembers about you lives in
   this browser — no account, no server round-trip. */
(function () {
  "use strict";

  var PREFIX = "ach:";
  var memory = {};            // fallback when localStorage is unavailable
  var hasLS = (function () {
    try {
      window.localStorage.setItem(PREFIX + "probe", "1");
      window.localStorage.removeItem(PREFIX + "probe");
      return true;
    } catch (err) {
      return false;
    }
  })();

  function read(key, fallback) {
    var raw = hasLS ? window.localStorage.getItem(PREFIX + key) : memory[key];
    if (raw == null) return fallback;
    try {
      var parsed = JSON.parse(raw);
      return parsed == null ? fallback : parsed;
    } catch (err) {
      return fallback;
    }
  }

  /* `silent` marks writes that came *from* the server, so the sync layer does
     not immediately push them straight back up again. */
  function write(key, value, silent) {
    var raw = JSON.stringify(value);
    if (hasLS) {
      try { window.localStorage.setItem(PREFIX + key, raw); }
      catch (err) { memory[key] = raw; }
    } else {
      memory[key] = raw;
    }
    document.dispatchEvent(new CustomEvent("store:change", {
      detail: { key: key, value: value, silent: !!silent }
    }));
    return value;
  }

  var MAX_RECENTS = 40;

  /* Enumerated settings and the values they accept. Anything not listed here
     is validated by type alone. Built from SITE where the list already exists,
     so adding a skin doesn't mean remembering to update this too. */
  var ALLOWED = {
    skin: (window.SITE.skins || []).map(function (s) { return s.id; }),
    textSize: ["normal", "large", "huge"],
    view: ["grid", "list"],
    sort: ["relevance", "title", "title-desc", "category", "played", "recent", "random"]
  };

  var Store = {
    available: hasLS,

    /* ---------------- settings ---------------- */

    /* Resolved settings: every key in SITE.defaults, always.
     *
     * Derived from the defaults rather than hand-listed. The hand-listed
     * version had a real failure mode — add a key to defaults, forget to add
     * it here, and it reads as `undefined` everywhere. An earlier version was
     * worse: it fell back to `false`, which would switch a newly added feature
     * off for every existing user, because their saved blob predates the key.
     *
     * A saved value is honoured only if it still makes sense: right type, and
     * for enumerated settings a value that is actually offered. That stops a
     * stale or hand-edited blob putting the interface into a state the CSS has
     * no rules for. */
    settings: function () {
      var d = window.SITE.defaults;
      var saved = read("settings", {}) || {};
      var out = {};

      Object.keys(d).forEach(function (key) {
        var value = saved[key];
        var usable = value !== null && value !== undefined &&
                     typeof value === typeof d[key];

        if (usable && ALLOWED[key] && ALLOWED[key].indexOf(value) === -1) {
          usable = false;              // known key, value no longer offered
        }
        out[key] = usable ? value : d[key];
      });

      /* Migrations. v1 stored `theme` and `fast`; only consult them when the
         current key is absent, so a later explicit choice always wins. */
      if (saved.skin === undefined && saved.theme) {
        var mapped = window.SITE.skinAliases[saved.theme];
        if (mapped && ALLOWED.skin.indexOf(mapped) !== -1) out.skin = mapped;
      }
      if (typeof saved.lite !== "boolean" && typeof saved.fast === "boolean") {
        out.lite = saved.fast;
      }

      return out;
    },

    /* The values each enumerated setting accepts, so tests and UI read from
       one place instead of restating them. */
    allowed: function () { return ALLOWED; },

    setSetting: function (key, value) {
      var s = Store.settings();
      s[key] = value;
      return write("settings", s);
    },

    /* ---------------- favorites ---------------- */

    favorites: function () { return read("favorites", []); },

    isFavorite: function (id) { return Store.favorites().indexOf(id) !== -1; },

    toggleFavorite: function (id) {
      var list = Store.favorites();
      var at = list.indexOf(id);
      if (at === -1) list.unshift(id); else list.splice(at, 1);
      write("favorites", list);
      return at === -1;
    },

    /* ---------------- recents ---------------- */

    recents: function () { return read("recents", []); },

    pushRecent: function (id) {
      var list = Store.recents().filter(function (entry) { return entry.id !== id; });
      list.unshift({ id: id, at: Date.now() });
      write("recents", list.slice(0, MAX_RECENTS));
    },

    clearRecents: function () { write("recents", []); },

    /* ---------------- play stats ---------------- */

    stats: function () { return read("stats", {}); },

    statFor: function (id) {
      var s = Store.stats()[id];
      return s || { plays: 0, seconds: 0, last: 0 };
    },

    recordPlay: function (id) {
      var all = Store.stats();
      var s = all[id] || { plays: 0, seconds: 0, last: 0 };
      s.plays += 1;
      s.last = Date.now();
      all[id] = s;
      write("stats", all);
    },

    addSeconds: function (id, seconds) {
      if (!seconds || seconds < 1) return;
      var all = Store.stats();
      var s = all[id] || { plays: 0, seconds: 0, last: 0 };
      s.seconds += Math.round(seconds);
      s.last = Date.now();
      all[id] = s;
      write("stats", all);
    },

    totalSeconds: function () {
      var all = Store.stats(), total = 0;
      Object.keys(all).forEach(function (id) { total += all[id].seconds || 0; });
      return total;
    },

    totalPlays: function () {
      var all = Store.stats(), total = 0;
      Object.keys(all).forEach(function (id) { total += all[id].plays || 0; });
      return total;
    },

    /* ---------------- ratings ---------------- */

    ratings: function () { return read("ratings", {}); },
    ratingFor: function (id) { return Store.ratings()[id] || 0; },
    setRating: function (id, value) {
      var all = Store.ratings();
      if (value) all[id] = value; else delete all[id];
      write("ratings", all);
    },

    /* ---------------- backup ---------------- */

    exportAll: function () {
      return {
        version: 2,
        exportedAt: new Date().toISOString(),
        settings: Store.settings(),
        favorites: Store.favorites(),
        recents: Store.recents(),
        stats: Store.stats(),
        ratings: Store.ratings()
      };
    },

    importAll: function (payload, opts) {
      if (!payload || typeof payload !== "object") throw new Error("Not a valid save file.");
      var silent = !!(opts && opts.silent);
      /* Server saves carry no skin/lite preference worth overriding the local
         one with, so settings only come from an explicit file import. */
      if (payload.settings && !silent) write("settings", payload.settings, silent);
      if (Array.isArray(payload.favorites)) write("favorites", payload.favorites, silent);
      if (Array.isArray(payload.recents)) write("recents", payload.recents, silent);
      if (payload.stats) write("stats", payload.stats, silent);
      if (payload.ratings) write("ratings", payload.ratings, silent);
    },

    resetAll: function () {
      ["settings", "favorites", "recents", "stats", "ratings"].forEach(function (key) {
        if (hasLS) window.localStorage.removeItem(PREFIX + key);
        delete memory[key];
      });
      document.dispatchEvent(new CustomEvent("store:change", { detail: { key: "*" } }));
    }
  };

  window.Store = Store;
})();

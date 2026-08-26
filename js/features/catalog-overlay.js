/* Runtime catalogue changes, layered over data/games.js.
 *
 * The shipped list is a static file, which is what makes the site fast and
 * lets it work with no backend at all. Anything the owner adds through the
 * admin console lives on the server instead — so this reads a cached copy of
 * those changes *synchronously* and folds them into window.GAME_CATALOG
 * before catalog.js indexes it, then refreshes the cache in the background
 * for the next page load.
 *
 * That means an edit shows up on your next navigation rather than instantly.
 * The alternative — blocking every page on a network round-trip, or forcing a
 * reload mid-game — is a far worse trade for something that changes maybe
 * once a week.
 *
 * Must be loaded after data/games.js and before js/catalog.js.
 */
(function () {
  "use strict";

  var KEY = "ach:catalog-overlay";
  var MAX_AGE = 300000;         // refresh the cache at most every 5 minutes

  function cached() {
    try {
      var raw = window.localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (err) { return null; }
  }

  function store(overlay) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(
        { added: overlay.added || [], removed: overlay.removed || [], at: Date.now() }
      ));
    } catch (err) { /* private mode; we just don't cache */ }
  }

  /* Added entries win over a shipped one with the same id — that's how you
     repoint a game whose host moved without touching the file. */
  function apply(overlay) {
    if (!overlay) return;
    var list = window.GAME_CATALOG || (window.GAME_CATALOG = []);

    var hidden = {};
    (overlay.removed || []).forEach(function (id) { hidden[id] = true; });

    var replaced = {};
    (overlay.added || []).forEach(function (g) { if (g && g.id) replaced[g.id] = g; });

    var out = [];
    list.forEach(function (g) {
      if (hidden[g.id]) return;
      out.push(replaced[g.id] || g);
      delete replaced[g.id];
    });
    /* Whatever's left is genuinely new. */
    Object.keys(replaced).forEach(function (id) { out.push(replaced[id]); });

    window.GAME_CATALOG = out;
  }

  var have = cached();
  apply(have);

  function refresh() {
    var mode = (window.SITE && window.SITE.backend) || "auto";
    if (mode === "none" || typeof window.fetch !== "function") return;

    var base = String((window.SITE && window.SITE.apiBase) || "").replace(/\/+$/, "");
    var conf = (window.SITE && window.SITE.supabase) || {};

    /* Supabase serves the same overlay from a view; the Node API from a
       route. Either way it's a plain GET with no credentials needed. */
    var url = mode === "supabase"
      ? String(conf.url || "").replace(/\/+$/, "") +
        "/rest/v1/custom_games_public?select=game_id,payload,removed"
      : base + "/api/catalog/custom";

    var opts = {};
    if (mode === "supabase") {
      if (!conf.url || !conf.anonKey) return;
      opts.headers = {
        apikey: conf.anonKey,
        Authorization: "Bearer " + conf.anonKey
      };
    }

    window.fetch(url, opts).then(function (res) {
      return res.ok ? res.json() : null;
    }).then(function (data) {
      if (!data) return;

      var overlay = Array.isArray(data)
        ? data.reduce(function (acc, row) {
            if (row.removed) acc.removed.push(row.game_id);
            else if (row.payload) acc.added.push(Object.assign({}, row.payload, { id: row.game_id }));
            return acc;
          }, { added: [], removed: [] })
        : data;

      store(overlay);
    }).catch(function () { /* offline; the cache stands */ });
  }

  if (!have || Date.now() - (have.at || 0) > MAX_AGE) {
    /* After load, so it never delays first paint. */
    if (document.readyState === "complete") window.setTimeout(refresh, 0);
    else window.addEventListener("load", function () { window.setTimeout(refresh, 300); });
  }

  window.CatalogOverlay = {
    /* The admin console calls this after an edit so the owner's own next
       navigation is current instead of waiting out the cache window. */
    invalidate: function () {
      try { window.localStorage.removeItem(KEY); } catch (err) { /* fine */ }
      refresh();
    }
  };
})();

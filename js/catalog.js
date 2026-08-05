/* Catalog: normalisation, search, filtering, sorting and recommendations.
   The raw list is loaded by data/games.js as window.GAME_CATALOG. */
(function () {
  "use strict";

  var SITE = window.SITE;

  function slugTitle(entry) {
    return (entry.title || entry.id || "Untitled").trim();
  }

  function initialsOf(title) {
    var words = title.replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
    if (!words.length) return "??";
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  /* Each catalog entry names the repo that serves it; SITE.gameHosts maps that
     to an origin. Entries without a host fall back to gameBase, which keeps
     older catalogs and self-hosted setups working unchanged. */
  function originFor(host) {
    var hosts = SITE.gameHosts || {};
    var base = (host && hosts[host]) || SITE.gameBase || "";
    return String(base).replace(/\/+$/, "");
  }

  function resolveUrl(path, host) {
    if (!path) return "";
    if (/^(https?:)?\/\//i.test(path)) return path;
    var base = originFor(host);
    if (path.charAt(0) === "/") return base + path;
    return base ? base + "/" + path : path;
  }

  function normalise(entry, index) {
    var title = slugTitle(entry);
    var category = (entry.category || "other").toLowerCase();
    if (!SITE.categories[category]) category = "other";

    var embeddable = entry.embed === true || entry.embed === "allowed";
    var preferDirect = entry.preferDirect === true || (!embeddable && !!entry.direct);

    return {
      id: entry.id || "game-" + index,
      title: title,
      titleLower: title.toLowerCase(),
      category: category,
      categoryLabel: SITE.categories[category].label,
      description: entry.description || "",
      descriptionLower: (entry.description || "").toLowerCase(),
      gradient: entry.gradient || "linear-gradient(135deg,#3a3f4b,#6b7280)",
      /* Real cover art, where a title ships one — `icon` is harvested from the
         game's own page by tools/harvest-icons.js. Resolved through the same
         base as the game itself; the generated plate takes over if it 404s. */
      art: resolveUrl(entry.icon || entry.pfp || entry.image || "", entry.host),
      host: entry.host || "",
      /* Titles no repo actually carries. Kept in the index so the catalog
         stays honest, but the player says so instead of showing a dead frame. */
      unavailable: !!entry.unavailable,
      source: entry.source || entry.direct || "",
      direct: entry.direct || entry.source || "",
      sourceUrl: resolveUrl(entry.source || entry.direct || "", entry.host),
      directUrl: resolveUrl(entry.direct || entry.source || "", entry.host),
      platform: entry.platform || "local",
      embeddable: embeddable,
      preferDirect: preferDirect,
      sandbox: entry.sandbox || "",
      risk: entry.schoolRisk || "unknown",
      initials: initialsOf(title),
      index: index
    };
  }

  var all = (window.GAME_CATALOG || []).map(normalise);
  var byId = {};
  all.forEach(function (g) { byId[g.id] = g; });

  /* ---- category counts ---- */
  var counts = {};
  all.forEach(function (g) { counts[g.category] = (counts[g.category] || 0) + 1; });

  var categories = Object.keys(counts)
    .map(function (key) {
      var meta = SITE.categories[key] || SITE.categories.other;
      return { id: key, label: meta.label, icon: meta.icon, count: counts[key] };
    })
    .sort(function (a, b) { return b.count - a.count || a.label.localeCompare(b.label); });

  /* ---- search ---- */

  function score(game, q) {
    if (game.titleLower === q) return 120;
    if (game.titleLower.indexOf(q) === 0) return 100;
    var wordStart = game.titleLower.indexOf(" " + q);
    if (wordStart !== -1) return 80;
    if (game.titleLower.indexOf(q) !== -1) return 60;
    if (game.categoryLabel.toLowerCase().indexOf(q) !== -1) return 30;
    if (game.descriptionLower.indexOf(q) !== -1) return 20;
    return 0;
  }

  function search(query, pool) {
    var list = pool || all;
    var q = (query || "").trim().toLowerCase();
    if (!q) return list.slice();
    var terms = q.split(/\s+/);
    var hits = [];
    list.forEach(function (game) {
      var total = 0;
      for (var i = 0; i < terms.length; i++) {
        var s = score(game, terms[i]);
        if (s === 0) return;          // every term must match somewhere
        total += s;
      }
      hits.push({ game: game, s: total });
    });
    hits.sort(function (a, b) { return b.s - a.s || a.game.title.localeCompare(b.game.title); });
    return hits.map(function (h) { return h.game; });
  }

  /* ---- filter + sort ---- */

  /* Titles no host carries. They stay in the index so the catalog is honest,
     but anything that *picks* a game for you should never land on one. */
  var playable = all.filter(function (g) { return !g.unavailable; });

  function filter(opts) {
    opts = opts || {};
    var list = opts.includeUnavailable ? all : playable;

    if (opts.category && opts.category !== "all") {
      list = list.filter(function (g) { return g.category === opts.category; });
    }
    if (opts.embeddableOnly) {
      list = list.filter(function (g) { return g.embeddable; });
    }
    if (opts.lowRiskOnly) {
      list = list.filter(function (g) { return g.risk === "low"; });
    }
    if (opts.localOnly) {
      list = list.filter(function (g) { return g.platform === "local"; });
    }
    if (opts.favoritesOnly) {
      var favs = window.Store.favorites();
      list = list.filter(function (g) { return favs.indexOf(g.id) !== -1; });
    }
    if (opts.query) list = search(opts.query, list);
    return list;
  }

  var sorters = {
    relevance: null,   // preserve search order
    title: function (a, b) { return a.title.localeCompare(b.title); },
    "title-desc": function (a, b) { return b.title.localeCompare(a.title); },
    category: function (a, b) { return a.categoryLabel.localeCompare(b.categoryLabel) || a.title.localeCompare(b.title); },
    played: function (a, b) {
      var sa = window.Store.statFor(a.id), sb = window.Store.statFor(b.id);
      return (sb.plays - sa.plays) || (sb.seconds - sa.seconds) || a.title.localeCompare(b.title);
    },
    recent: function (a, b) {
      return window.Store.statFor(b.id).last - window.Store.statFor(a.id).last || a.title.localeCompare(b.title);
    },
    random: null
  };

  function sort(list, mode) {
    var out = list.slice();
    if (mode === "random") return shuffle(out, daySeed());
    var fn = sorters[mode];
    if (fn) out.sort(fn);
    return out;
  }

  /* ---- deterministic daily picks ---- */

  function daySeed() {
    var d = new Date();
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }

  function rng(seed) {
    var s = seed % 2147483647;
    if (s <= 0) s += 2147483646;
    return function () { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  }

  function shuffle(list, seed) {
    var next = rng(seed);
    for (var i = list.length - 1; i > 0; i--) {
      var j = Math.floor(next() * (i + 1));
      var tmp = list[i]; list[i] = list[j]; list[j] = tmp;
    }
    return list;
  }

  function daily(count, pool) {
    return shuffle((pool || playable).slice(), daySeed()).slice(0, count || 12);
  }

  function randomGame() {
    return playable[Math.floor(Math.random() * playable.length)];
  }

  /* ---- recommendations ---- */

  function related(game, count) {
    if (!game) return [];
    var sameCat = playable.filter(function (g) {
      return g.id !== game.id && g.category === game.category;
    });
    var picked = shuffle(sameCat, daySeed() + game.index).slice(0, count || 8);
    if (picked.length < (count || 8)) {
      var filler = shuffle(playable.filter(function (g) {
        return g.id !== game.id && picked.indexOf(g) === -1 && g.category !== game.category;
      }), daySeed()).slice(0, (count || 8) - picked.length);
      picked = picked.concat(filler);
    }
    return picked;
  }

  /* Games from the categories you actually play, that you have not played. */
  function forYou(count) {
    var stats = window.Store.stats();
    var played = Object.keys(stats);
    if (!played.length) return daily(count);

    var weight = {};
    played.forEach(function (id) {
      var g = byId[id];
      if (!g) return;
      weight[g.category] = (weight[g.category] || 0) + (stats[id].plays || 1);
    });

    var unplayed = playable.filter(function (g) { return played.indexOf(g.id) === -1; });
    unplayed.sort(function (a, b) {
      return (weight[b.category] || 0) - (weight[a.category] || 0);
    });
    var top = unplayed.slice(0, Math.max(count * 3, 24));
    return shuffle(top, daySeed()).slice(0, count || 12);
  }

  function recentGames(count) {
    return window.Store.recents()
      .map(function (entry) { return byId[entry.id]; })
      .filter(Boolean)
      .slice(0, count || 12);
  }

  function favoriteGames(count) {
    var list = window.Store.favorites().map(function (id) { return byId[id]; }).filter(Boolean);
    return count ? list.slice(0, count) : list;
  }

  window.Catalog = {
    all: all,
    playable: playable,
    byId: function (id) { return byId[id] || null; },
    categories: categories,
    counts: counts,
    search: search,
    filter: filter,
    sort: sort,
    sortModes: Object.keys(sorters),
    daily: daily,
    related: related,
    forYou: forYou,
    recentGames: recentGames,
    favoriteGames: favoriteGames,
    randomGame: randomGame,
    resolveUrl: resolveUrl
  };
})();

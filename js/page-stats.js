/* Activity: totals, category breakdown, top ten, untouched categories. */
(function () {
  "use strict";

  function meter(keyNode, value, max, valueText) {
    var UI = window.UI;
    var row = UI.el("div", "meter");
    var k = UI.el("span", "k");
    k.appendChild(keyNode);
    row.appendChild(k);

    var track = UI.el("div", "track");
    var fill = UI.el("div", "fill");
    fill.style.width = (max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0) + "%";
    track.appendChild(fill);
    row.appendChild(track);

    row.appendChild(UI.el("span", "v", valueText));
    return row;
  }

  function init() {
    var Catalog = window.Catalog;
    var Store = window.Store;
    var UI = window.UI;

    var stats = Store.stats();
    var ids = Object.keys(stats).filter(function (id) { return Catalog.byId(id); });

    document.getElementById("s-time").textContent = UI.formatDuration(Store.totalSeconds());
    document.getElementById("s-plays").textContent = Store.totalPlays();
    document.getElementById("s-tried").textContent = ids.length;
    document.getElementById("s-pct").textContent =
      Math.round((ids.length / Catalog.all.length) * 100) + "%";
    document.getElementById("s-pins").textContent = Store.favorites().length;

    /* ---- by category ---- */
    var byCat = {};
    ids.forEach(function (id) {
      var g = Catalog.byId(id);
      byCat[g.category] = (byCat[g.category] || 0) + (stats[id].seconds || 0);
    });

    var rows = Object.keys(byCat)
      .map(function (k) { return { k: k, seconds: byCat[k] }; })
      .sort(function (a, b) { return b.seconds - a.seconds; });

    var catHost = document.getElementById("m-cats");
    if (!rows.length) {
      catHost.appendChild(UI.el("p", "dim", "Play something and this fills in."));
      document.getElementById("s-top").textContent = "—";
    } else {
      var topMeta = window.SITE.categories[rows[0].k] || window.SITE.categories.other;
      var topCell = document.getElementById("s-top");
      topCell.textContent = topMeta.label;
      topCell.style.fontSize = "1.2rem";

      var max = rows[0].seconds;
      rows.forEach(function (row) {
        var meta = window.SITE.categories[row.k] || window.SITE.categories.other;
        var link = UI.el("a", null, meta.icon + " " + meta.label);
        link.href = "browse.html?category=" + row.k;
        catHost.appendChild(meter(link, row.seconds, max, UI.formatDuration(row.seconds)));
      });
    }

    /* ---- top ten ---- */
    var topHost = document.getElementById("m-top");
    var top = ids.sort(function (a, b) {
      return (stats[b].seconds || 0) - (stats[a].seconds || 0);
    }).slice(0, 10);

    if (!top.length) {
      topHost.appendChild(UI.el("p", "dim", "No sessions recorded yet."));
    } else {
      var maxGame = stats[top[0]].seconds || 1;
      top.forEach(function (id) {
        var g = Catalog.byId(id);
        var link = UI.el("a", null, g.title);
        link.href = UI.playHref(g);
        topHost.appendChild(meter(link, stats[id].seconds || 0, maxGame,
          UI.formatDuration(stats[id].seconds) + " · " + stats[id].plays + "×"));
      });
    }

    /* ---- untouched ---- */
    var touched = {};
    ids.forEach(function (id) { touched[Catalog.byId(id).category] = true; });
    var fresh = Catalog.all.filter(function (g) { return !touched[g.category]; });

    UI.render(document.getElementById("g-fresh"),
      Catalog.sort(fresh, "random").slice(0, 8), {
        desc: false,
        emptyTitle: "Every category sampled",
        emptyBody: "Nice. Shuffle the index for something you have not opened yet.",
        emptyAction: { label: "⇄ Shuffle the index", href: "browse.html?sort=random" }
      });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

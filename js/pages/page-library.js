/* Your shelf: pins, history, ratings, most played. */
(function () {
  "use strict";

  function init() {
    var Catalog = window.Catalog;
    var Store = window.Store;
    var UI = window.UI;

    document.getElementById("a-settings").addEventListener("click", window.Shell.openSettings);

    document.getElementById("a-clear").addEventListener("click", function () {
      if (!Store.recents().length) { UI.toast("No history to clear"); return; }
      if (window.confirm("Clear the history list? Playtime totals are kept.")) {
        Store.clearRecents();
        draw();
        UI.toast("History cleared");
      }
    });

    function draw() {
      var pinned = Catalog.favoriteGames();
      var stats = Store.stats();
      var ratings = Store.ratings();
      var playedIds = Object.keys(stats).filter(function (id) { return Catalog.byId(id); });

      document.getElementById("r-pins").textContent = pinned.length;
      document.getElementById("r-played").textContent = playedIds.length;
      document.getElementById("r-rated").textContent = Object.keys(ratings).length;
      document.getElementById("r-time").textContent = UI.formatDuration(Store.totalSeconds());

      UI.render(document.getElementById("g-pinned"), pinned, {
        emptyTitle: "Nothing pinned yet",
        emptyBody: "Hit ☆ on any tile — or press F while playing — to keep it here.",
        emptyAction: { label: "Open the index", href: "browse.html" },
        onFavorite: function () { window.setTimeout(draw, 10); }
      });

      UI.renderList(document.getElementById("l-history"), Catalog.recentGames(30), {
        emptyTitle: "Nothing played yet",
        emptyBody: "Titles you open show up here so you can jump straight back in.",
        emptyAction: { label: "Find something", href: "browse.html" },
        onFavorite: function () { window.setTimeout(draw, 10); }
      });

      var rated = Object.keys(ratings)
        .map(function (id) { return Catalog.byId(id); })
        .filter(Boolean)
        .sort(function (a, b) { return ratings[b.id] - ratings[a.id]; })
        .slice(0, 12);
      document.getElementById("b-rated").hidden = rated.length === 0;
      if (rated.length) UI.render(document.getElementById("g-rated"), rated, { desc: false });

      var most = playedIds
        .map(function (id) { return Catalog.byId(id); })
        .sort(function (a, b) {
          return (stats[b.id].seconds || 0) - (stats[a.id].seconds || 0) ||
                 (stats[b.id].plays || 0) - (stats[a.id].plays || 0);
        })
        .slice(0, 12);
      document.getElementById("b-most").hidden = most.length === 0;
      if (most.length) UI.render(document.getElementById("g-most"), most, { desc: false, numbered: true });
    }

    draw();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

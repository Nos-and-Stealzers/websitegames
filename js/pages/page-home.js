/* Overview page. */
(function () {
  "use strict";

  function marquee(game) {
    var UI = window.UI;
    var host = document.getElementById("marquee");
    host.innerHTML = "";

    var art = window.UI.el("div", "marquee-art");
    UI.coverInto(art, game);
    host.appendChild(art);

    var body = UI.el("div", "marquee-body");
    body.appendChild(UI.el("span", "label", "No. 01 · " + game.categoryLabel));
    var h = UI.el("h2");
    var link = UI.el("a", null, game.title);
    link.href = UI.playHref(game);
    link.style.color = "inherit";
    h.appendChild(link);
    body.appendChild(h);
    body.appendChild(UI.el("p", null, game.description || "No description on file."));

    var specs = UI.el("div", "marquee-specs");
    specs.appendChild(UI.el("span", null, "launch · " + UI.launchLabel(game).toLowerCase()));
    specs.appendChild(UI.el("span", null, "compat · " + UI.riskLabel(game).toLowerCase()));
    specs.appendChild(UI.el("span", null, "host · " + game.platform));
    body.appendChild(specs);

    var acts = UI.el("div", "marquee-acts");
    var play = UI.el("a", "btn btn-cta", "▶ Play now");
    play.href = UI.playHref(game);
    acts.appendChild(play);
    var more = UI.el("a", "btn", "More " + game.categoryLabel);
    more.href = "browse.html?category=" + game.category;
    acts.appendChild(more);
    var dice = UI.el("button", "btn btn-flat", "⇢ Something else");
    dice.type = "button";
    dice.addEventListener("click", window.Shell.playRandom);
    acts.appendChild(dice);
    body.appendChild(acts);

    host.appendChild(body);
  }

  function init() {
    var Catalog = window.Catalog;
    var Store = window.Store;
    var UI = window.UI;

    var inPage = Catalog.all.filter(function (g) { return g.embeddable; });

    document.getElementById("r-games").textContent = Catalog.all.length;
    document.getElementById("r-cats").textContent = Catalog.categories.length;
    document.getElementById("r-inpage").textContent = inPage.length;
    document.getElementById("r-time").textContent = UI.formatDuration(Store.totalSeconds());
    document.getElementById("r-date").textContent =
      new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

    marquee(Catalog.daily(1)[0]);

    var recents = Catalog.recentGames(10);
    if (recents.length) {
      document.getElementById("b-resume").hidden = false;
      UI.render(document.getElementById("s-resume"), recents, { desc: false });
    }

    var pinned = Catalog.favoriteGames(10);
    if (pinned.length) {
      document.getElementById("b-pinned").hidden = false;
      UI.render(document.getElementById("s-pinned"), pinned, { desc: false });
    }

    document.getElementById("sug-why").textContent = Store.totalPlays()
      ? "based on what you play"
      : "based on the whole index";
    UI.render(document.getElementById("g-suggested"), Catalog.forYou(8), { numbered: true });

    var cats = document.getElementById("g-cats");
    Catalog.categories.forEach(function (cat) {
      var a = UI.el("a", "cat");
      a.href = "browse.html?category=" + cat.id;
      a.appendChild(UI.el("span", "ico", cat.icon));
      a.appendChild(UI.el("strong", null, cat.label));
      a.appendChild(UI.el("span", "n", cat.count + " titles"));
      cats.appendChild(a);
    });

    var stable = Catalog.sort(inPage.filter(function (g) { return g.risk === "low"; }), "random");
    UI.render(document.getElementById("g-inpage"), stable.slice(0, 12), { desc: false });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

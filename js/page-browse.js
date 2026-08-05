/* Index page: search, filters, sort, grid/list view and paging — all mirrored
   into the URL so any view can be bookmarked or shared. */
(function () {
  "use strict";

  var PAGE = 40;

  function init() {
    var Catalog = window.Catalog;
    var Store = window.Store;
    var UI = window.UI;

    var qBox = document.getElementById("page-q");
    var sortBox = document.getElementById("sort");
    var flagRow = document.getElementById("f-flags");
    var catRow = document.getElementById("f-cats");
    var gridOut = document.getElementById("out-grid");
    var listOut = document.getElementById("out-list");
    var countLine = document.getElementById("count");
    var moreBtn = document.getElementById("more");
    var vGrid = document.getElementById("v-grid");
    var vList = document.getElementById("v-list");
    var titleEl = document.getElementById("p-title");
    var subEl = document.getElementById("p-sub");

    var p = UI.params();
    var state = {
      q: p.get("q") || "",
      category: p.get("category") || "all",
      sort: p.get("sort") || "relevance",
      embed: p.get("embed") === "1",
      risk: p.get("risk") === "low",
      local: p.get("local") === "1",
      fav: p.get("fav") === "1",
      view: p.get("view") || Store.settings().view,
      shown: PAGE
    };

    qBox.value = state.q;
    sortBox.value = state.sort;

    /* ---- category pills ---- */
    var allPill = UI.el("button", "pill", "All · " + Catalog.all.length);
    allPill.type = "button";
    allPill.dataset.category = "all";
    catRow.appendChild(allPill);
    Catalog.categories.forEach(function (cat) {
      var pill = UI.el("button", "pill", cat.icon + " " + cat.label + " · " + cat.count);
      pill.type = "button";
      pill.dataset.category = cat.id;
      catRow.appendChild(pill);
    });

    /* ---- events ---- */
    catRow.addEventListener("click", function (e) {
      var pill = e.target.closest("[data-category]");
      if (!pill) return;
      state.category = pill.dataset.category;
      state.shown = PAGE;
      apply();
    });

    flagRow.addEventListener("click", function (e) {
      var pill = e.target.closest("[data-flag]");
      if (!pill) return;
      state[pill.dataset.flag] = !state[pill.dataset.flag];
      state.shown = PAGE;
      apply();
    });

    qBox.addEventListener("input", UI.debounce(function () {
      state.q = qBox.value;
      state.shown = PAGE;
      apply();
    }, 150));

    sortBox.addEventListener("change", function () {
      state.sort = sortBox.value;
      apply();
    });

    function setView(view) {
      state.view = view;
      Store.setSetting("view", view);
      apply();
    }
    vGrid.addEventListener("click", function () { setView("grid"); });
    vList.addEventListener("click", function () { setView("list"); });

    moreBtn.addEventListener("click", function () {
      state.shown += PAGE;
      apply();
    });

    document.getElementById("reset").addEventListener("click", function () {
      state.q = ""; state.category = "all"; state.sort = "relevance";
      state.embed = state.risk = state.local = state.fav = false;
      state.shown = PAGE;
      qBox.value = "";
      sortBox.value = "relevance";
      apply();
    });

    window.addEventListener("popstate", function () {
      var n = UI.params();
      state.q = n.get("q") || "";
      state.category = n.get("category") || "all";
      state.sort = n.get("sort") || "relevance";
      state.embed = n.get("embed") === "1";
      state.risk = n.get("risk") === "low";
      state.local = n.get("local") === "1";
      state.fav = n.get("fav") === "1";
      qBox.value = state.q;
      sortBox.value = state.sort;
      apply({ silent: true });
    });

    /* ---- render ---- */

    function syncControls() {
      catRow.querySelectorAll("[data-category]").forEach(function (pill) {
        pill.classList.toggle("on", pill.dataset.category === state.category);
      });
      flagRow.querySelectorAll("[data-flag]").forEach(function (pill) {
        pill.setAttribute("aria-pressed", state[pill.dataset.flag] ? "true" : "false");
      });
      vGrid.setAttribute("aria-pressed", state.view === "grid" ? "true" : "false");
      vList.setAttribute("aria-pressed", state.view === "list" ? "true" : "false");
    }

    function headline() {
      if (state.q) return "“" + state.q + "”";
      if (state.fav) return "Pinned";
      if (state.category !== "all") {
        var cat = Catalog.categories.filter(function (c) { return c.id === state.category; })[0];
        return cat ? cat.label : "All games";
      }
      if (state.embed) return "Plays in page";
      if (state.risk) return "Stable only";
      return "All games";
    }

    function apply(opts) {
      opts = opts || {};
      syncControls();

      var list = Catalog.filter({
        query: state.q,
        category: state.category,
        embeddableOnly: state.embed,
        lowRiskOnly: state.risk,
        localOnly: state.local,
        favoritesOnly: state.fav
      });

      var mode = state.sort;
      if (mode === "relevance" && !state.q) mode = "title";
      list = Catalog.sort(list, mode);

      titleEl.textContent = headline();
      subEl.textContent = state.q
        ? "Matched against titles, categories and descriptions."
        : "Search the whole index, then narrow it with the filters below.";

      var page = list.slice(0, state.shown);
      var empty = {
        emptyTitle: "Nothing matches those filters",
        emptyBody: "Drop a filter or shorten the search term.",
        emptyAction: { label: "Reset filters", href: "browse.html" }
      };

      var isList = state.view === "list";
      gridOut.hidden = isList;
      listOut.hidden = !isList;
      if (isList) UI.renderList(listOut, page, empty);
      else UI.render(gridOut, page, empty);

      countLine.textContent = list.length
        ? UI.pad(page.length) + " / " + list.length + " titles" +
          (state.sort === "random" ? " · shuffled" : "")
        : "";
      moreBtn.hidden = page.length >= list.length;

      if (!opts.silent) {
        UI.setParams({
          q: state.q,
          category: state.category === "all" ? "" : state.category,
          sort: state.sort === "relevance" ? "" : state.sort,
          embed: state.embed ? "1" : "",
          risk: state.risk ? "low" : "",
          local: state.local ? "1" : "",
          fav: state.fav ? "1" : "",
          view: state.view === "grid" ? "" : state.view
        }, true);
      }
    }

    apply({ silent: true });
    if (state.q) qBox.focus();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

/* Categories: the index tiles plus one sample strip per category. */
(function () {
  "use strict";

  function init() {
    var Catalog = window.Catalog;
    var UI = window.UI;

    document.getElementById("r-cats").textContent = Catalog.categories.length;
    document.getElementById("r-games").textContent = Catalog.all.length;
    document.getElementById("r-top").textContent =
      Catalog.categories[0].label.toLowerCase() + " (" + Catalog.categories[0].count + ")";

    var index = document.getElementById("cat-index");
    Catalog.categories.forEach(function (cat) {
      var a = UI.el("a", "cat");
      a.href = "browse.html?category=" + cat.id;
      a.appendChild(UI.el("span", "ico", cat.icon));
      a.appendChild(UI.el("strong", null, cat.label));
      a.appendChild(UI.el("span", "n", cat.count + " titles"));
      index.appendChild(a);
    });

    var samples = document.getElementById("samples");
    Catalog.categories.forEach(function (cat) {
      var pool = Catalog.all.filter(function (g) { return g.category === cat.id; });
      if (!pool.length) return;

      var section = UI.el("section", "block");
      section.dataset.category = cat.id;

      var head = UI.el("div", "block-head");
      var h2 = UI.el("h2", null, cat.icon + "  " + cat.label);
      head.appendChild(h2);
      head.appendChild(UI.el("span", "fill"));
      var link = UI.el("a", "more", "All " + cat.count + " →");
      link.href = "browse.html?category=" + cat.id;
      head.appendChild(link);
      section.appendChild(head);

      var strip = UI.el("div", "strip");
      section.appendChild(strip);
      samples.appendChild(section);

      UI.render(strip, Catalog.sort(pool, "random").slice(0, 10), { desc: false });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

/* 404: random-title button plus a few suggestions. */
(function () {
  "use strict";

  function init() {
    document.getElementById("a-random").addEventListener("click", window.Shell.playRandom);
    window.UI.render(document.getElementById("g-suggest"),
      window.Catalog.daily(8), { desc: false });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

/* Manual: live counts and a settings shortcut. */
(function () {
  "use strict";

  function init() {
    document.getElementById("n-games").textContent = window.Catalog.all.length;
    document.getElementById("n-cats").textContent = window.Catalog.categories.length;
    document.getElementById("a-settings").addEventListener("click", window.Shell.openSettings);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

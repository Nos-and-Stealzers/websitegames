/* Admin-only embedded search. A plain iframe pointed at DuckDuckGo's
   HTML-only endpoint, which — unlike the JS-heavy main site — reliably
   allows itself to be framed. Nothing searched here touches this site's
   own backend; it's a lookup tool, not a feature with data of its own. */
(function () {
  "use strict";

  var ENDPOINT = "https://html.duckduckgo.com/html/";
  var PLACEHOLDER =
    "<body style=\"margin:0;font:14px system-ui,sans-serif;color:#8a8f98;" +
    "background:#0c0d10;display:grid;place-items:center;height:100vh\">" +
    "<p>Type a search above.</p></body>";

  function init() {
    window.SocialUI.gate(function () {
      if (!window.Session.isAdmin()) {
        document.getElementById("denied").hidden = false;
        return;
      }
      document.getElementById("tool").hidden = false;

      var form = document.getElementById("search-form");
      var input = document.getElementById("q");
      var frame = document.getElementById("results");
      var openTab = document.getElementById("open-tab");

      frame.srcdoc = PLACEHOLDER;

      function run(q) {
        var url = ENDPOINT + "?q=" + encodeURIComponent(q);
        frame.removeAttribute("srcdoc");
        frame.src = url;
        openTab.href = url;
      }

      form.addEventListener("submit", function (event) {
        event.preventDefault();
        var q = input.value.trim();
        if (!q) return;
        run(q);
      });

      /* Land straight on a query if one was shared, e.g. admin.html linking
         here with something already typed. */
      var params = new URLSearchParams(window.location.search);
      var initial = (params.get("q") || "").trim();
      if (initial) {
        input.value = initial;
        run(initial);
      }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

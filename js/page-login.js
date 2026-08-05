/* Sign-in form. */
(function () {
  "use strict";

  function init() {
    var form = document.getElementById("form");
    var offline = document.getElementById("offline");
    var errorBox = document.getElementById("error");
    var submit = document.getElementById("submit");

    function nextPage() {
      var next = window.UI.params().get("next") || "index.html";
      /* Only ever bounce to a page on this site. */
      if (/^[a-z0-9_-]+\.html(\?.*)?$/i.test(next)) return next;
      return "index.html";
    }

    window.Session.ready.then(function (state) {
      if (!state.backend) { offline.hidden = false; return; }
      if (state.user) { window.location.replace(nextPage()); return; }
      form.hidden = false;
      document.getElementById("username").focus();
    });

    function fail(message) {
      errorBox.textContent = message;
      errorBox.hidden = false;
      submit.disabled = false;
      submit.textContent = "Sign in";
    }

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      errorBox.hidden = true;

      var username = document.getElementById("username").value.trim();
      var password = document.getElementById("password").value;
      if (!username || !password) return fail("Fill in both fields.");

      submit.disabled = true;
      submit.textContent = "Signing in…";

      window.Session.login(username, password)
        .then(function () { window.location.href = nextPage(); })
        .catch(function (err) { fail(err.message || "Could not sign in."); });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

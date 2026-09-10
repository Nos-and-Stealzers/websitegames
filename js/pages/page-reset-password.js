/* Landing page for the "reset password" email link.
   Supabase's recovery link redirects here with the session in the URL
   fragment (#access_token=...&type=recovery&...) — never as a query
   string, so it's never sent to the server or logged anywhere. */
(function () {
  "use strict";

  function parseFragment() {
    var hash = window.location.hash.replace(/^#/, "");
    var out = {};
    hash.split("&").forEach(function (pair) {
      if (!pair) return;
      var idx = pair.indexOf("=");
      if (idx < 0) return;
      out[decodeURIComponent(pair.slice(0, idx))] = decodeURIComponent(pair.slice(idx + 1));
    });
    return out;
  }

  function init() {
    var intro = document.getElementById("intro");
    var invalid = document.getElementById("invalid");
    var form = document.getElementById("form");
    var errorBox = document.getElementById("error");
    var submit = document.getElementById("submit");

    var frag = parseFragment();
    var token = frag.access_token;
    var isRecovery = frag.type === "recovery";

    /* Clear the token out of the visible URL/history as soon as it's read,
       so it doesn't linger in browser history or get shared accidentally
       via copy-paste of the address bar. */
    if (token) {
      window.history.replaceState(null, "", window.location.pathname);
    }

    if (!token || !isRecovery) {
      intro.hidden = true;
      invalid.hidden = false;
      return;
    }

    intro.textContent = "Choose a new password for your account.";
    form.hidden = false;
    document.getElementById("password").focus();

    window.wirePasswordToggle("password", "pw-toggle");
    window.wirePasswordToggle("confirm", "confirm-toggle");

    function fail(message) {
      errorBox.textContent = message;
      errorBox.hidden = false;
      submit.disabled = false;
      submit.textContent = "Set password";
    }

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      errorBox.hidden = true;

      var password = document.getElementById("password").value;
      var confirm = document.getElementById("confirm").value;

      if (password !== confirm) return fail("The two passwords don't match.");
      if (password.length < 8) return fail("Password must be at least 8 characters.");
      if (!/[a-z]/i.test(password) || !/[0-9]/.test(password)) {
        return fail("Password needs at least one letter and one number.");
      }

      submit.disabled = true;
      submit.textContent = "Setting…";

      window.API.resetPassword(token, password)
        .then(function () {
          window.UI.toast("Password updated — sign in with it now.");
          window.location.href = "login.html";
        })
        .catch(function (err) { fail(err.message || "Could not set the new password. The link may have expired — request a new one."); });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

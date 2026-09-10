/* Forgot-password request form. */
(function () {
  "use strict";

  function init() {
    var form = document.getElementById("form");
    var offline = document.getElementById("offline");
    var errorBox = document.getElementById("error");
    var sent = document.getElementById("sent");
    var submit = document.getElementById("submit");

    window.Session.ready.then(function (state) {
      if (!state.backend) { offline.hidden = false; return; }
      form.hidden = false;
      document.getElementById("email").focus();
    });

    function fail(message) {
      errorBox.textContent = message;
      errorBox.hidden = false;
      submit.disabled = false;
      submit.textContent = "Send reset link";
    }

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      errorBox.hidden = true;
      sent.hidden = true;

      var email = document.getElementById("email").value.trim();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return fail("Enter a valid email address.");
      }

      submit.disabled = true;
      submit.textContent = "Sending…";

      window.API.requestPasswordReset(email)
        .then(function () {
          sent.hidden = false;
          submit.disabled = false;
          submit.textContent = "Send reset link";
          form.reset();
        })
        .catch(function (err) { fail(err.message || "Could not send the reset link."); });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

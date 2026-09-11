/* Email verification: enter the 6-digit code we emailed, unlock social
   features. Requesting a code triggers a server-side email (Resend via
   pg_net); the code itself never comes back to the browser. */
(function () {
  "use strict";

  function init() {
    var UI = window.UI, API = window.API, Session = window.Session;

    var signedOut = document.getElementById("ve-signedout");
    var done = document.getElementById("ve-done");
    var form = document.getElementById("ve-form");
    var emailEl = document.getElementById("ve-email");
    var codeInput = document.getElementById("ve-code");
    var errorBox = document.getElementById("ve-error");
    var note = document.getElementById("ve-note");
    var submit = document.getElementById("ve-submit");
    var resend = document.getElementById("ve-resend");

    function fail(msg) {
      errorBox.textContent = msg;
      errorBox.hidden = false;
    }
    function tell(msg) {
      note.textContent = msg;
      note.hidden = false;
    }

    Session.ready.then(function (state) {
      if (!state.backend) { signedOut.hidden = false; return; }
      if (!state.user) { signedOut.hidden = false; return; }

      if (state.user.emailVerified) { done.hidden = false; return; }

      if (emailEl && state.user.email) emailEl.textContent = state.user.email;
      form.hidden = false;
      codeInput.focus();

      /* Auto-send a first code on arrival, unless one was just sent. */
      sendCode(true);
    });

    function sendCode(quiet) {
      return API.requestEmailCode().then(function (res) {
        var to = (res && res.sentTo) || "your email";
        tell("Code sent to " + to + ". It expires in 15 minutes.");
      }).catch(function (err) {
        if (!quiet) fail(err.message || "Couldn't send a code.");
        else tell(err.message || "");
      });
    }

    resend.addEventListener("click", function (e) {
      e.preventDefault();
      errorBox.hidden = true;
      resend.textContent = "Sending…";
      sendCode(false).then(function () { resend.textContent = "Send a new code"; });
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      errorBox.hidden = true;
      var code = codeInput.value.trim();
      if (!/^[0-9]{6}$/.test(code)) return fail("Enter the 6-digit code.");

      submit.disabled = true;
      submit.textContent = "Verifying…";
      API.verifyEmailCode(code).then(function () {
        /* Refresh the session so emailVerified flips everywhere. */
        UI.toast("Email verified 🎉");
        var next = new URLSearchParams(location.search).get("next") || "index.html";
        window.location.href = next;
      }).catch(function (err) {
        submit.disabled = false;
        submit.textContent = "Verify";
        fail(err.message || "That code didn't work.");
      });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

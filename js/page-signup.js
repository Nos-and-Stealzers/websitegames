/* Account creation, including the strength meter and the "your local save
   comes with you" note. */
(function () {
  "use strict";

  function strengthOf(value) {
    var score = 0;
    if (value.length >= 8) score++;
    if (value.length >= 12) score++;
    if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score++;
    if (/[0-9]/.test(value)) score++;
    if (/[^A-Za-z0-9]/.test(value)) score++;
    return Math.min(score, 4);
  }

  var LABELS = ["Too short", "Weak", "Okay", "Good", "Strong"];

  function init() {
    var form = document.getElementById("form");
    var offline = document.getElementById("offline");
    var firstRun = document.getElementById("first-run");
    var errorBox = document.getElementById("error");
    var submit = document.getElementById("submit");
    var pass = document.getElementById("password");
    var meter = document.getElementById("strength");

    window.Session.ready.then(function (state) {
      if (!state.backend) { offline.hidden = false; return; }
      if (state.user) { window.location.replace("index.html"); return; }
      form.hidden = false;
      if (window.API.health && window.API.health.needsSetup) firstRun.hidden = false;
      document.getElementById("username").focus();
    });

    /* Tell them exactly what gets carried over — it's the reason to sign up. */
    var carry = document.getElementById("carry");
    var pins = window.Store.favorites().length;
    var played = Object.keys(window.Store.stats()).length;
    if (pins || played) {
      carry.textContent = "Your " + pins + " pinned title" + (pins === 1 ? "" : "s") +
        " and " + played + " played title" + (played === 1 ? "" : "s") +
        " on this device will be attached to the new account.";
    }

    pass.addEventListener("input", function () {
      var value = pass.value;
      if (!value) { meter.hidden = true; return; }
      var score = strengthOf(value);
      meter.hidden = false;
      meter.dataset.score = score;
      meter.firstElementChild.style.width = ((score / 4) * 100) + "%";
      meter.setAttribute("aria-label", "Password strength: " + LABELS[score]);
      meter.title = LABELS[score];
    });

    function fail(message) {
      errorBox.textContent = message;
      errorBox.hidden = false;
      submit.disabled = false;
      submit.textContent = "Create account";
    }

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      errorBox.hidden = true;

      var username = document.getElementById("username").value.trim();
      var display = document.getElementById("display").value.trim();
      var password = pass.value;
      var confirm = document.getElementById("confirm").value;

      if (password !== confirm) return fail("The two passwords don't match.");
      if (password.length < 8) return fail("Password must be at least 8 characters.");
      if (!/[a-z]/i.test(password) || !/[0-9]/.test(password)) {
        return fail("Password needs at least one letter and one number.");
      }

      submit.disabled = true;
      submit.textContent = "Creating…";

      window.Session.signup(username, password, display)
        .then(function (res) {
          window.UI.toast(res.firstAccount ? "Admin account created" : "Welcome, " + username);
          window.location.href = res.firstAccount ? "admin.html" : "index.html";
        })
        .catch(function (err) { fail(err.message || "Could not create the account."); });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

/* Feedback form. Works signed out — a broken sign-up is exactly the thing
   someone needs to be able to report. */
(function () {
  "use strict";

  var STATE_LABEL = {
    new: "Waiting", triaged: "Looking into it", done: "Done", declined: "Won't do"
  };
  var STATE_TONE = { done: "flag-good", declined: "flag-bad", triaged: "flag-warn" };

  function init() {
    var UI = window.UI;
    var API = window.API;

    var form = document.getElementById("form");
    var offline = document.getElementById("offline");
    var errorBox = document.getElementById("error");
    var submit = document.getElementById("submit");
    var body = document.getElementById("body");
    var kind = "bug";

    /* Prefill the game box from wherever they came from. */
    var params = UI.params();
    var fromGame = params.get("game") || "";

    window.Session.ready.then(function (state) {
      if (!state.backend) { offline.hidden = false; return; }
      form.hidden = false;

      document.getElementById("anon-note").textContent = state.user
        ? "Sending as @" + state.user.username + " — replies show up below."
        : "Sending anonymously. Sign in first if you want to see a reply.";

      if (state.user) loadMine();
      document.getElementById("subject").focus();
    });

    /* ---- kind ---- */
    var kinds = document.getElementById("kinds");
    kinds.addEventListener("click", function (event) {
      var pill = event.target.closest("[data-kind]");
      if (!pill) return;
      kind = pill.dataset.kind;
      kinds.querySelectorAll(".pill").forEach(function (p) {
        p.classList.toggle("on", p === pill);
      });
      document.getElementById("game-field").hidden = kind !== "game" && kind !== "bug";
    });

    /* ---- game picker ---- */
    var list = document.getElementById("game-list");
    window.Catalog.all.slice().sort(function (a, b) {
      return a.title.localeCompare(b.title);
    }).forEach(function (g) {
      var opt = document.createElement("option");
      opt.value = g.title;
      list.appendChild(opt);
    });
    if (fromGame) {
      var g = window.Catalog.byId(fromGame);
      if (g) {
        kind = "bug";
        document.getElementById("game").value = g.title;
        document.getElementById("game-field").hidden = false;
        document.getElementById("subject").value = "Problem with " + g.title;
      }
    }

    body.addEventListener("input", function () {
      document.getElementById("body-count").textContent = body.value.length;
    });

    /* Context that saves a round trip of "which browser / what page". */
    document.getElementById("context").textContent =
      "We'll also record the page you came from and your browser version — nothing else.";

    /* ---- submit ---- */
    function fail(message) {
      errorBox.textContent = message;
      errorBox.hidden = false;
      submit.disabled = false;
      submit.textContent = "Send feedback";
    }

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      errorBox.hidden = true;

      var subject = document.getElementById("subject").value.trim();
      var text = body.value.trim();
      if (subject.length < 3) return fail("Give it a one-line summary.");
      if (text.length < 10) return fail("Add a bit more detail — at least 10 characters.");

      submit.disabled = true;
      submit.textContent = "Sending…";

      var titled = document.getElementById("game").value.trim();
      var match = window.Catalog.all.filter(function (x) { return x.title === titled; })[0];

      API.sendFeedback({
        kind: kind,
        subject: subject,
        body: text,
        page: document.referrer || window.location.href,
        gameId: match ? match.id : titled
      }).then(function () {
        form.hidden = true;
        document.getElementById("thanks").hidden = false;
        document.getElementById("thanks-note").textContent = window.Session.user
          ? "You'll see any reply below and get a notification."
          : "Sent anonymously, so there's no way to reply — sign in next time if you'd like one.";
        if (window.Session.user) loadMine();
      }).catch(function (err) { fail(err.message || "Could not send that."); });
    });

    document.getElementById("again").addEventListener("click", function () {
      form.reset();
      document.getElementById("body-count").textContent = "0";
      document.getElementById("thanks").hidden = true;
      form.hidden = false;
      submit.disabled = false;
      submit.textContent = "Send feedback";
      document.getElementById("subject").focus();
    });

    /* ---- your history ---- */
    function loadMine() {
      API.myFeedback().then(function (res) {
        if (!res.feedback.length) return;
        document.getElementById("mine-block").hidden = false;
        var host = document.getElementById("mine");
        host.innerHTML = "";

        res.feedback.forEach(function (f) {
          var row = UI.el("article", "note");
          var icon = UI.el("span", "note-icon" +
            (STATE_TONE[f.state] ? " tone-" + STATE_TONE[f.state].replace("flag-", "") : ""));
          icon.textContent = f.kind === "bug" ? "🐞" : f.kind === "game" ? "🎮" : "💡";
          row.appendChild(icon);

          var mid = UI.el("div", "note-mid");
          var head = UI.el("p", "note-body");
          head.textContent = f.subject;
          mid.appendChild(head);

          var meta = UI.el("p", "note-meta");
          meta.textContent = (STATE_LABEL[f.state] || f.state) + " · " + UI.formatWhen(f.at);
          mid.appendChild(meta);

          if (f.reply) {
            var reply = UI.el("p", "note-reply");
            reply.textContent = f.reply;        // untrusted staff text
            mid.appendChild(reply);
          }
          row.appendChild(mid);
          host.appendChild(row);
        });
      }).catch(function () { /* non-critical */ });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

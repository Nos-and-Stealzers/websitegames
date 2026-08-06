/* The notification feed. */
(function () {
  "use strict";

  var GLYPH = {
    "friend-request": "◆",
    "friend-accept": "✓",
    "message": "✉",
    "role": "▲",
    "state": "!",
    "report": "⚑"
  };

  var TONE = {
    "friend-accept": "good",
    "state": "bad",
    "role": "accent"
  };

  function init() {
    window.SocialUI.gate(function () {
      var UI = window.UI;
      var API = window.API;

      var feed = document.getElementById("feed");
      var filter = "all";

      document.querySelectorAll("[data-filter]").forEach(function (pill) {
        pill.addEventListener("click", function () {
          document.querySelectorAll("[data-filter]").forEach(function (p) {
            p.classList.toggle("on", p === pill);
          });
          filter = pill.dataset.filter;
          load();
        });
      });

      document.getElementById("mark-all").addEventListener("click", function () {
        API.markRead("all")
          .then(function () {
            UI.toast("All marked read");
            window.Session.refreshBadges();
            load();
          })
          .catch(function (err) { UI.toast(err.message); });
      });

      document.getElementById("clear-all").addEventListener("click", function () {
        if (!window.confirm("Clear every notification? This can't be undone.")) return;
        API.clearNotifications()
          .then(function () {
            UI.toast("Cleared");
            window.Session.refreshBadges();
            load();
          })
          .catch(function (err) { UI.toast(err.message); });
      });

      function card(n) {
        var row = UI.el("article", "note" + (n.read ? "" : " unread"));

        var icon = UI.el("span", "note-icon" + (TONE[n.kind] ? " tone-" + TONE[n.kind] : ""));
        icon.textContent = GLYPH[n.kind] || "•";
        row.appendChild(icon);

        var mid = UI.el("div", "note-mid");
        var body = UI.el("p", "note-body");
        body.textContent = n.body;          // untrusted text
        mid.appendChild(body);

        var meta = UI.el("p", "note-meta");
        meta.textContent = UI.formatWhen(n.at);
        if (n.actor) meta.textContent += " · @" + n.actor.username;
        mid.appendChild(meta);
        row.appendChild(mid);

        var acts = UI.el("div", "note-acts");
        if (n.link) {
          var go = UI.el("a", "btn btn-sm btn-cta", "Open");
          go.href = n.link;
          go.addEventListener("click", function () {
            /* Reading it is the point of clicking through. */
            if (!n.read) API.markRead([n.id]).catch(function () {});
          });
          acts.appendChild(go);
        }
        var drop = UI.el("button", "btn btn-sm btn-flat", "×");
        drop.type = "button";
        drop.title = "Dismiss";
        drop.setAttribute("aria-label", "Dismiss this notification");
        drop.addEventListener("click", function () {
          API.dismissNotification(n.id)
            .then(function () { window.Session.refreshBadges(); load(); })
            .catch(function (err) { UI.toast(err.message); });
        });
        acts.appendChild(drop);
        row.appendChild(acts);

        return row;
      }

      function load() {
        return API.notifications({ limit: 60, unreadOnly: filter === "unread" })
          .then(function (res) {
            document.getElementById("r-unread").textContent = res.unread;
            document.getElementById("r-total").textContent = res.notifications.length;

            feed.innerHTML = "";
            if (!res.notifications.length) {
              var v = UI.el("div", "void");
              v.appendChild(UI.el("strong", null,
                filter === "unread" ? "Nothing unread" : "No notifications yet"));
              v.appendChild(UI.el("p", null,
                filter === "unread"
                  ? "You're all caught up."
                  : "Friend requests, messages and account changes show up here."));
              var a = UI.el("a", "btn btn-cta", "Find people");
              a.href = "friends.html";
              v.appendChild(a);
              feed.appendChild(v);
              return;
            }
            res.notifications.forEach(function (n) { feed.appendChild(card(n)); });
          })
          .catch(function (err) { UI.toast(err.message); });
      }

      load();
      window.setInterval(load, 30000);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

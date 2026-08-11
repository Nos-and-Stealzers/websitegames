/* The notification feed. */
(function () {
  "use strict";

  /* Every kind the backends actually emit. The list used to stop at six, so
     group invites, calls, feedback replies, support replies and closed
     reports — five of the eleven — all arrived as an anonymous bullet with
     no colour, which made the feed unreadable at a glance. */
  var GLYPH = {
    "friend-request": "◆",
    "friend-accept": "✓",
    "message": "✉",
    "group": "◍",
    "call": "☎",
    "role": "▲",
    "state": "!",
    "report": "⚑",
    "feedback": "✎",
    "support": "⛑"
  };

  var TONE = {
    "friend-accept": "good",
    "message": "accent",
    "group": "accent",
    "call": "accent",
    "state": "bad",
    "role": "accent",
    "support": "good"
  };

  /* Which pill a notification answers to. */
  var GROUPS = {
    "friend-request": "social",
    "friend-accept": "social",
    "message": "social",
    "group": "social",
    "call": "social",
    "role": "account",
    "state": "account",
    "report": "account",
    "feedback": "account",
    "support": "account"
  };

  function init() {
    window.SocialUI.gate(function () {
      var UI = window.UI;
      var API = window.API;

      var feed = document.getElementById("feed");
      var filter = "all";
      var loaded = [];
      var timer = null;

      document.querySelectorAll("[data-filter]").forEach(function (pill) {
        pill.addEventListener("click", function () {
          document.querySelectorAll("[data-filter]").forEach(function (p) {
            p.classList.toggle("on", p === pill);
            p.setAttribute("aria-pressed", p === pill ? "true" : "false");
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
        row.dataset.kind = n.kind;

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
          /* Marking read used to be fired off during the navigation the click
             had already started, so the browser was free to cancel it and
             frequently did — you opened the thing and the bell stayed lit.
             Hold the navigation for the round trip instead. */
          go.addEventListener("click", function (event) {
            if (n.read || event.metaKey || event.ctrlKey || event.shiftKey) return;
            event.preventDefault();
            var to = go.href;
            API.markRead([n.id])
              .catch(function () {})
              .then(function () { window.location.href = to; });
          });
          acts.appendChild(go);
        }

        if (!n.read) {
          var seen = UI.el("button", "btn btn-sm btn-flat", "Mark read");
          seen.type = "button";
          seen.addEventListener("click", function () {
            API.markRead([n.id])
              .then(function () { window.Session.refreshBadges(); load(); })
              .catch(function (err) { UI.toast(err.message); });
          });
          acts.appendChild(seen);
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

      function matches(n) {
        if (filter === "all") return true;
        if (filter === "unread") return !n.read;
        return GROUPS[n.kind] === filter;
      }

      function draw() {
        var shown = loaded.filter(matches);
        var unread = loaded.filter(function (n) { return !n.read; }).length;

        document.getElementById("r-unread").textContent = unread;
        /* "Total" meant "however many this page happened to fetch", which is
           not a total. Say what it is. */
        document.getElementById("r-shown").textContent = shown.length;

        feed.innerHTML = "";
        if (!shown.length) {
          var v = UI.el("div", "void");
          v.appendChild(UI.el("strong", null,
            filter === "all" ? "No notifications yet" : "Nothing here"));
          v.appendChild(UI.el("p", null,
            filter === "unread" ? "You're all caught up."
              : filter === "all"
                ? "Friend requests, messages and account changes show up here."
                : "Nothing in this category."));
          var a = UI.el("a", "btn btn-cta", "Find people");
          a.href = "friends.html";
          v.appendChild(a);
          feed.appendChild(v);
          return;
        }
        shown.forEach(function (n) { feed.appendChild(card(n)); });
      }

      function load() {
        /* Always fetch everything and filter here: asking the server for
           unread-only meant the "unread" count went to zero the moment you
           looked at that tab, because the count was derived from the page. */
        return API.notifications({ limit: 80 })
          .then(function (res) {
            loaded = res.notifications || [];
            draw();
          })
          .catch(function (err) { UI.toast(err.message); });
      }

      /* Reloading the feed under someone's cursor every 30 seconds moves the
         buttons out from under them. Poll only while the tab is in front. */
      function retime() {
        window.clearInterval(timer);
        if (document.hidden) return;
        timer = window.setInterval(load, 30000);
      }
      document.addEventListener("visibilitychange", function () {
        retime();
        if (!document.hidden) load();
      });

      load();
      retime();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

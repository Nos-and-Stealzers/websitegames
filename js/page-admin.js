/* Admin console. The server enforces every one of these permissions; hiding
   controls here is convenience, not security. */
(function () {
  "use strict";

  function init() {
    window.SocialUI.gate(function (me) {
      var UI = window.UI;
      var API = window.API;

      if (!window.Session.isStaff()) {
        document.getElementById("denied").hidden = false;
        return;
      }

      var isAdmin = window.Session.isAdmin();
      document.getElementById("console").hidden = false;
      document.getElementById("r-role").textContent = me.role;

      /* ----------------------------------------------------------- tabs */
      var tabs = document.getElementById("tabs");
      tabs.addEventListener("click", function (event) {
        var tab = event.target.closest("[data-tab]");
        if (!tab) return;
        tabs.querySelectorAll(".tab").forEach(function (t) {
          var on = t === tab;
          t.classList.toggle("on", on);
          t.setAttribute("aria-selected", on ? "true" : "false");
        });
        document.querySelectorAll("[data-panel]").forEach(function (p) {
          p.hidden = p.dataset.panel !== tab.dataset.tab;
        });
        if (tab.dataset.tab === "users") loadUsers();
        if (tab.dataset.tab === "reports") loadReports();
        if (tab.dataset.tab === "feedback") loadFeedback();
        if (tab.dataset.tab === "gamedata" && window.initGameData) window.initGameData();
        if (tab.dataset.tab === "audit") loadAudit();
      });

      /* ------------------------------------------------------- overview */
      function loadOverview() {
        return API.adminOverview().then(function (d) {
          document.getElementById("k-users").textContent = d.users.total;
          document.getElementById("k-online").textContent = d.users.online;
          document.getElementById("k-new").textContent = d.users.newThisWeek;
          document.getElementById("k-suspended").textContent = d.users.suspended;
          document.getElementById("k-friends").textContent = d.social.friendships;
          document.getElementById("k-messages").textContent = d.social.messages;
          document.getElementById("k-today").textContent = d.social.messagesToday;
          document.getElementById("k-sessions").textContent = d.sessions;

          document.getElementById("r-reports").textContent = d.reports.open;
          document.getElementById("r-online").textContent = d.users.online;

          var host = document.getElementById("top-games");
          host.innerHTML = "";
          if (!d.topGames.length) {
            host.appendChild(UI.el("p", "dim", "Nobody has synced any playtime yet."));
            return;
          }
          var max = d.topGames[0].seconds || 1;
          d.topGames.forEach(function (row) {
            var game = window.Catalog.byId(row.id);
            var meter = UI.el("div", "meter");
            var k = UI.el("span", "k");
            if (game) {
              var a = UI.el("a", null, game.title);
              a.href = UI.playHref(game);
              k.appendChild(a);
            } else {
              k.textContent = row.id;
            }
            meter.appendChild(k);
            var track = UI.el("div", "track");
            var fill = UI.el("div", "fill");
            fill.style.width = Math.max(2, Math.round((row.seconds / max) * 100)) + "%";
            track.appendChild(fill);
            meter.appendChild(track);
            meter.appendChild(UI.el("span", "v",
              UI.formatDuration(row.seconds) + " · " + row.plays + "×"));
            host.appendChild(meter);
          });
        });
      }

      /* ---------------------------------------------------------- users */
      var userQ = document.getElementById("user-q");
      userQ.addEventListener("input", UI.debounce(function () { loadUsers(); }, 220));

      function loadUsers() {
        return API.adminUsers(userQ.value.trim()).then(function (res) {
          var host = document.getElementById("user-rows");
          host.innerHTML = "";

          var head = UI.el("div", "rows-head");
          head.style.gridTemplateColumns = "1fr 6rem 6rem 5rem 12rem";
          ["User", "Role", "State", "Social", "Actions"].forEach(function (h) {
            head.appendChild(UI.el("span", null, h));
          });
          host.appendChild(head);

          res.users.forEach(function (u) {
            var row = UI.el("div", "row");
            row.style.gridTemplateColumns = "1fr 6rem 6rem 5rem 12rem";

            var who = UI.el("a", "admin-who");
            who.href = "profile.html?u=" + encodeURIComponent(u.username);
            who.appendChild(window.SocialUI.avatar(u));
            who.appendChild(window.SocialUI.nameBlock(u, { presence: true }));
            row.appendChild(who);

            row.appendChild(UI.el("span", "cat", u.role));

            var state = UI.el("span", "flag " + (u.state === "active" ? "flag-good" : "flag-bad"));
            state.textContent = u.state;
            row.appendChild(state);

            row.appendChild(UI.el("span", "plays", u.friends + "f " + u.messages + "m"));

            var acts = UI.el("span", "admin-acts");
            if (isAdmin && u.id !== me.id) {
              var roleBox = UI.el("select");
              ["user", "mod", "admin"].forEach(function (r) {
                var o = UI.el("option", null, r);
                o.value = r;
                if (u.role === r) o.selected = true;
                roleBox.appendChild(o);
              });
              roleBox.addEventListener("change", function () {
                API.adminUpdateUser(u.id, { role: roleBox.value })
                  .then(function () { UI.toast(u.username + " is now " + roleBox.value); loadUsers(); })
                  .catch(function (err) { UI.toast(err.message); loadUsers(); });
              });
              acts.appendChild(roleBox);

              var toggle = UI.el("button", "btn btn-sm",
                u.state === "active" ? "Suspend" : "Restore");
              toggle.type = "button";
              toggle.addEventListener("click", function () {
                var next = u.state === "active" ? "suspended" : "active";
                if (next === "suspended" &&
                    !window.confirm("Suspend " + u.username + "? They'll be signed out immediately.")) return;
                API.adminUpdateUser(u.id, { state: next })
                  .then(function () { UI.toast(u.username + " " + next); loadUsers(); })
                  .catch(function (err) { UI.toast(err.message); });
              });
              acts.appendChild(toggle);
            } else if (u.id === me.id) {
              acts.appendChild(UI.el("span", "tiny dimmer", "that's you"));
            } else {
              acts.appendChild(UI.el("span", "tiny dimmer", "admins only"));
            }
            row.appendChild(acts);
            host.appendChild(row);
          });
        }).catch(function (err) { UI.toast(err.message); });
      }

      /* -------------------------------------------------------- reports */
      var reportState = "open";
      document.querySelectorAll("[data-state]").forEach(function (pill) {
        pill.addEventListener("click", function () {
          document.querySelectorAll("[data-state]").forEach(function (p) {
            p.classList.toggle("on", p === pill);
          });
          reportState = pill.dataset.state;
          loadReports();
        });
      });

      function loadReports() {
        return API.adminReports(reportState).then(function (res) {
          var host = document.getElementById("report-list");
          host.innerHTML = "";
          if (!res.reports.length) {
            var v = UI.el("div", "void");
            v.appendChild(UI.el("strong", null, "Nothing here"));
            v.appendChild(UI.el("p", null,
              reportState === "open" ? "No open reports. Quiet day." : "No closed reports yet."));
            host.appendChild(v);
            return;
          }
          res.reports.forEach(function (r) {
            var card = UI.el("div", "report");
            var top = UI.el("div", "report-top");
            top.appendChild(UI.el("span", "pill on", r.kind));
            var target = UI.el("span", "report-target");
            target.textContent = r.target;
            top.appendChild(target);
            var when = UI.el("span", "tiny dimmer");
            when.textContent = UI.formatWhen(r.at) + " · by " + r.reporter;
            when.style.marginLeft = "auto";
            top.appendChild(when);
            card.appendChild(top);

            var reason = UI.el("p", "report-reason");
            reason.textContent = r.reason;      // untrusted
            card.appendChild(reason);

            var act = UI.el("button", "btn btn-sm",
              r.state === "open" ? "Mark handled" : "Reopen");
            act.type = "button";
            act.addEventListener("click", function () {
              API.adminCloseReport(r.id, r.state === "open" ? "closed" : "open")
                .then(function () { loadReports(); loadOverview(); })
                .catch(function (err) { UI.toast(err.message); });
            });
            card.appendChild(act);
            host.appendChild(card);
          });
        }).catch(function (err) { UI.toast(err.message); });
      }

      /* ------------------------------------------------------- feedback */
      var fbState = "new";
      document.querySelectorAll("[data-fb]").forEach(function (pill) {
        pill.addEventListener("click", function () {
          document.querySelectorAll("[data-fb]").forEach(function (p) {
            p.classList.toggle("on", p === pill);
          });
          fbState = pill.dataset.fb;
          loadFeedback();
        });
      });

      var KIND_GLYPH = { bug: "🐞", game: "🎮", idea: "💡", other: "💬" };

      function loadFeedback() {
        return API.adminFeedback(fbState).then(function (res) {
          /* Put the queue depth on the tabs so nothing rots unnoticed. */
          document.querySelectorAll("[data-fb]").forEach(function (p) {
            var n = res.counts[p.dataset.fb] || 0;
            p.textContent = p.textContent.replace(/\s*\(\d+\)$/, "") + (n ? " (" + n + ")" : "");
          });

          var host = document.getElementById("fb-list");
          host.innerHTML = "";
          if (!res.feedback.length) {
            var v = UI.el("div", "void");
            v.appendChild(UI.el("strong", null, "Nothing here"));
            v.appendChild(UI.el("p", null, "No feedback in this state."));
            host.appendChild(v);
            return;
          }

          res.feedback.forEach(function (f) {
            var card = UI.el("div", "report");

            var top = UI.el("div", "report-top");
            top.appendChild(UI.el("span", "pill on", (KIND_GLYPH[f.kind] || "") + " " + f.kind));
            var subj = UI.el("span", "report-target");
            subj.textContent = f.subject;
            top.appendChild(subj);
            var when = UI.el("span", "tiny dimmer");
            when.textContent = UI.formatWhen(f.at) + " · " + f.from;
            when.style.marginLeft = "auto";
            top.appendChild(when);
            card.appendChild(top);

            var text = UI.el("p", "report-reason");
            text.textContent = f.body;          // untrusted
            card.appendChild(text);

            if (f.gameId) {
              var g = window.Catalog.byId(f.gameId);
              var link = UI.el("p", "tiny dimmer");
              link.style.margin = "0 0 0.6rem";
              link.textContent = "Game: ";
              if (g) {
                var a = UI.el("a", null, g.title);
                a.href = UI.playHref(g);
                link.appendChild(a);
              } else {
                link.appendChild(document.createTextNode(f.gameId));
              }
              card.appendChild(link);
            }

            if (f.agent) {
              var ua = UI.el("p", "tiny dimmer");
              ua.style.margin = "0 0 0.6rem";
              ua.textContent = f.agent.slice(0, 110);
              card.appendChild(ua);
            }

            if (f.reply) {
              var reply = UI.el("p", "note-reply");
              reply.textContent = f.reply;
              card.appendChild(reply);
            }

            var acts = UI.el("div", "btn-row");
            [["Looking into it", "triaged"], ["Done", "done"], ["Won't do", "declined"]]
              .filter(function (pair) { return pair[1] !== f.state; })
              .forEach(function (pair) {
                var b = UI.el("button", "btn btn-sm", pair[0]);
                b.type = "button";
                b.addEventListener("click", function () {
                  API.adminUpdateFeedback(f.id, { state: pair[1] })
                    .then(function () { UI.toast("Marked " + pair[1]); loadFeedback(); loadOverview(); })
                    .catch(function (err) { UI.toast(err.message); });
                });
                acts.appendChild(b);
              });

            var replyBtn = UI.el("button", "btn btn-sm btn-cta", f.reply ? "Edit reply" : "Reply");
            replyBtn.type = "button";
            replyBtn.addEventListener("click", function () {
              var text2 = window.prompt("Reply to “" + f.subject + "”", f.reply || "");
              if (text2 === null) return;
              API.adminUpdateFeedback(f.id, { reply: text2.trim() })
                .then(function () { UI.toast("Reply sent"); loadFeedback(); })
                .catch(function (err) { UI.toast(err.message); });
            });
            acts.appendChild(replyBtn);

            card.appendChild(acts);
            host.appendChild(card);
          });
        }).catch(function (err) { UI.toast(err.message); });
      }

      /* ---------------------------------------------------------- audit */
      function loadAudit() {
        return API.adminAudit().then(function (res) {
          var host = document.getElementById("audit-rows");
          host.innerHTML = "";

          var head = UI.el("div", "rows-head");
          head.style.gridTemplateColumns = "3rem 8rem 10rem 1fr 7rem";
          ["#", "Actor", "Action", "Detail", "When"].forEach(function (h) {
            head.appendChild(UI.el("span", null, h));
          });
          host.appendChild(head);

          res.entries.forEach(function (e, i) {
            var row = UI.el("div", "row");
            row.style.gridTemplateColumns = "3rem 8rem 10rem 1fr 7rem";
            row.appendChild(UI.el("span", "idx", UI.pad(i + 1)));
            row.appendChild(UI.el("span", "cat", e.actor));
            row.appendChild(UI.el("span", "cat", e.action));
            var detail = UI.el("span", "name");
            detail.textContent = e.detail || "—";
            row.appendChild(detail);
            row.appendChild(UI.el("span", "plays", UI.formatWhen(e.at)));
            host.appendChild(row);
          });
        }).catch(function (err) { UI.toast(err.message); });
      }

      loadOverview().catch(function (err) { UI.toast(err.message); });
      window.setInterval(loadOverview, 30000);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

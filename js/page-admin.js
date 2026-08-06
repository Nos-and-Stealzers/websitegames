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
        if (tab.dataset.tab === "live") loadLive();
        if (tab.dataset.tab === "support") loadSupport();
        if (tab.dataset.tab === "logins") loadLogins();
        if (tab.dataset.tab === "games") loadCatalog();
        if (tab.dataset.tab === "reports") loadReports();
        if (tab.dataset.tab === "feedback") loadFeedback();
        if (tab.dataset.tab === "gamedata" && window.initGameData) window.initGameData();
        if (tab.dataset.tab === "audit") loadAudit();
        if (tab.dataset.tab === "help") loadHelp();
      });

      var isOwner = window.Session.isOwner();
      document.querySelectorAll("[data-owner]").forEach(function (n) { n.hidden = !isOwner; });

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
            /* The owner is deliberately untouchable — the server refuses any
               change to that account, so don't render controls that only
               produce a 403. */
            if (u.role === "owner" && u.id !== me.id) {
              acts.appendChild(UI.el("span", "tiny dimmer", "owner — can't be changed"));
            } else if (isAdmin && u.id !== me.id) {
              var roleBox = UI.el("select");
              /* You can never promote to your own rank or above, so only
                 offer the ranks below yours. */
              var RANKS = ["user", "mod", "admin", "owner"];
              RANKS.slice(0, Math.max(1, RANKS.indexOf(me.role))).forEach(function (r) {
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

      /* ----------------------------------------------------------- live */

      /* Refreshed on a timer, but only while its tab is showing — polling a
         hidden panel every ten seconds is just noise. */
      var liveTimer = null;

      function loadLive() {
        window.clearInterval(liveTimer);
        liveTimer = window.setInterval(function () {
          var panel = document.querySelector('[data-panel="live"]');
          if (!panel || panel.hidden) { window.clearInterval(liveTimer); return; }
          fetchLive();
        }, 12000);
        return fetchLive();
      }

      function fetchLive() {
        return API.adminLive().then(function (res) {
          var host = document.getElementById("live-rows");
          host.innerHTML = "";

          var cols = "1fr 7rem 1fr 7rem";
          var head = UI.el("div", "rows-head");
          head.style.gridTemplateColumns = cols;
          ["User", "Role", "Playing", "Last seen"].forEach(function (h) {
            head.appendChild(UI.el("span", null, h));
          });
          host.appendChild(head);

          if (!res.users.length) {
            host.appendChild(UI.el("p", "dim", "Nobody is online right now."));
            return;
          }

          res.users.forEach(function (u) {
            var row = UI.el("div", "row");
            row.style.gridTemplateColumns = cols;

            var who = UI.el("a", "admin-who");
            who.href = "profile.html?u=" + encodeURIComponent(u.username);
            who.appendChild(window.SocialUI.avatar(u));
            who.appendChild(window.SocialUI.nameBlock(u, { presence: true }));
            row.appendChild(who);

            row.appendChild(UI.el("span", "cat", u.role));

            var what = UI.el("span", "name");
            var game = u.game ? window.Catalog.byId(u.game) : null;
            if (game) {
              var a = UI.el("a", null, game.title);
              a.href = UI.playHref(game);
              what.appendChild(a);
              if (u.since) {
                what.appendChild(UI.el("span", "tiny dimmer",
                  " · " + UI.formatDuration(Math.round((Date.now() - u.since) / 1000))));
              }
            } else {
              what.textContent = u.game || "— browsing";
            }
            row.appendChild(what);

            row.appendChild(UI.el("span", "plays", UI.formatWhen(u.lastSeen)));
            host.appendChild(row);
          });
        }).catch(function (err) { UI.toast(err.message); });
      }

      /* --------------------------------------------------------- logins */
      function loadLogins() {
        return API.adminLogins().then(function (res) {
          var host = document.getElementById("login-rows");
          host.innerHTML = "";

          var cols = "1fr 6rem 1fr 8rem";
          var head = UI.el("div", "rows-head");
          head.style.gridTemplateColumns = cols;
          ["Account", "Result", "Where from", "When"].forEach(function (h) {
            head.appendChild(UI.el("span", null, h));
          });
          host.appendChild(head);

          /* The Supabase backend can't see failed attempts — the password
             check happens inside Supabase Auth. Say so rather than let the
             list read as "nobody has ever failed a login". */
          if (res.failuresVisible === false) {
            var note = UI.el("p", "tiny dimmer");
            note.style.margin = "0.6rem 0";
            note.textContent = "Successful sign-ins only on this backend — " +
              "failed attempts are in the Supabase dashboard under Authentication → Logs.";
            host.appendChild(note);
          }

          if (!res.logins.length) {
            host.appendChild(UI.el("p", "dim", "No sign-ins recorded yet."));
            return;
          }

          res.logins.forEach(function (l) {
            var row = UI.el("div", "row");
            row.style.gridTemplateColumns = cols;

            var name = UI.el("span", "name");
            name.textContent = l.username || "(unknown)";
            row.appendChild(name);

            var ok = l.outcome === "ok";
            var flag = UI.el("span", "flag " + (ok ? "flag-good" : "flag-bad"));
            flag.textContent = l.outcome;
            row.appendChild(flag);

            var where = UI.el("span", "cat");
            where.textContent = (l.ip || "?") + (l.agent ? " · " + l.agent.slice(0, 40) : "");
            row.appendChild(where);

            row.appendChild(UI.el("span", "plays", UI.formatWhen(l.at)));
            host.appendChild(row);
          });
        }).catch(function (err) { UI.toast(err.message); });
      }

      /* -------------------------------------------------------- support */
      var supState = "open";
      document.querySelectorAll("[data-sup]").forEach(function (pill) {
        pill.addEventListener("click", function () {
          document.querySelectorAll("[data-sup]").forEach(function (p) {
            p.classList.toggle("on", p === pill);
          });
          supState = pill.dataset.sup;
          loadSupport();
        });
      });

      function loadSupport() {
        return API.adminTickets(supState).then(function (res) {
          document.querySelectorAll("[data-sup]").forEach(function (p) {
            var n = res.counts[p.dataset.sup] || 0;
            p.textContent = p.textContent.replace(/\s*\(\d+\)$/, "") + (n ? " (" + n + ")" : "");
          });

          var host = document.getElementById("sup-list");
          host.innerHTML = "";
          if (!res.tickets.length) {
            var v = UI.el("div", "void");
            v.appendChild(UI.el("strong", null, "Nothing here"));
            v.appendChild(UI.el("p", null, "No tickets in this state."));
            host.appendChild(v);
            return;
          }

          res.tickets.forEach(function (t) { host.appendChild(ticketCard(t)); });
        }).catch(function (err) { UI.toast(err.message); });
      }

      function ticketCard(t) {
        var card = UI.el("div", "report");

        var top = UI.el("div", "report-top");
        var pri = UI.el("span", "pri", t.priority);
        pri.dataset.p = t.priority;
        top.appendChild(pri);
        top.appendChild(UI.el("span", "pill on", t.category));

        var subj = UI.el("span", "report-target");
        subj.textContent = t.subject;
        top.appendChild(subj);

        var when = UI.el("span", "tiny dimmer");
        when.textContent = UI.formatWhen(t.updatedAt) + " · " + t.from +
          " · " + t.replies + " message" + (t.replies === 1 ? "" : "s");
        when.style.marginLeft = "auto";
        top.appendChild(when);
        card.appendChild(top);

        var opening = UI.el("p", "report-reason");
        opening.textContent = t.opening || "";      // untrusted
        card.appendChild(opening);

        /* The whole conversation, loaded on demand — a queue of a hundred
           tickets shouldn't pull every message with it. */
        var thread = UI.el("div", "ticket-thread");
        thread.hidden = true;
        card.appendChild(thread);

        var acts = UI.el("div", "btn-row");

        var openBtn = UI.el("button", "btn btn-sm", "Open thread");
        openBtn.type = "button";
        openBtn.addEventListener("click", function () {
          if (!thread.hidden) { thread.hidden = true; openBtn.textContent = "Open thread"; return; }
          API.ticket(t.id).then(function (res) {
            thread.innerHTML = "";
            res.messages.forEach(function (m) {
              var wrap = UI.el("div", "tmsg" + (m.staff ? " is-staff" : ""));
              wrap.appendChild(UI.el("span", "who",
                (m.staff ? "Staff · " : "") + m.author + " · " + UI.formatWhen(m.at)));
              var body = UI.el("div", "body");
              body.textContent = m.body;            // untrusted
              wrap.appendChild(body);
              thread.appendChild(wrap);
            });
            thread.hidden = false;
            openBtn.textContent = "Hide thread";
          }).catch(function (err) { UI.toast(err.message); });
        });
        acts.appendChild(openBtn);

        var reply = UI.el("button", "btn btn-sm btn-cta", "Reply");
        reply.type = "button";
        reply.addEventListener("click", function () {
          var text = window.prompt("Reply to “" + t.subject + "”");
          if (text === null || !text.trim()) return;
          API.replyTicket(t.id, text.trim())
            .then(function () { UI.toast("Reply sent"); loadSupport(); })
            .catch(function (err) { UI.toast(err.message); });
        });
        acts.appendChild(reply);

        if (t.state !== "closed") {
          var close = UI.el("button", "btn btn-sm", "Close");
          close.type = "button";
          close.addEventListener("click", function () {
            API.updateTicket(t.id, { state: "closed" })
              .then(function () { loadSupport(); })
              .catch(function (err) { UI.toast(err.message); });
          });
          acts.appendChild(close);
        } else {
          var reopen = UI.el("button", "btn btn-sm", "Reopen");
          reopen.type = "button";
          reopen.addEventListener("click", function () {
            API.updateTicket(t.id, { state: "open" })
              .then(function () { loadSupport(); })
              .catch(function (err) { UI.toast(err.message); });
          });
          acts.appendChild(reopen);
        }

        var bump = UI.el("button", "btn btn-sm btn-flat",
          t.priority === "high" ? "Lower priority" : "Raise priority");
        bump.type = "button";
        bump.addEventListener("click", function () {
          API.updateTicket(t.id, { priority: t.priority === "high" ? "normal" : "high" })
            .then(function () { loadSupport(); })
            .catch(function (err) { UI.toast(err.message); });
        });
        acts.appendChild(bump);

        card.appendChild(acts);
        return card;
      }

      /* ----------------------------------------------------------- help */

      /* Written out here rather than in the HTML so the admin combo shows the
         key that is actually configured, and so rows for things you can't
         reach don't appear at all. */
      function loadHelp() {
        var mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
        var mod = mac ? "⌘" : "Ctrl";
        var fallback = (window.SITE.defaults && window.SITE.defaults.adminKey) || "k";
        var adminKey = (window.Store.settings().adminKey || fallback).toUpperCase();

        var TABS = [
          ["Overview", "Counts for the whole site and the most-played titles across every " +
            "account. Refreshes itself every 30 seconds."],
          ["Live", "Who is signed in right now and what they have open. Presence comes from " +
            "the player page, so it lags by up to a minute and stops when someone closes the tab. " +
            "It is not a location log — it only knows the game, not the person."],
          ["Users", "Search accounts, change someone's rank, suspend or restore them. " +
            "Suspending signs that person out immediately and blocks them from signing back in."],
          ["Support", "The ticket queue. “Needs a reply” is waiting on staff; " +
            "“waiting on them” means you have replied and it is with the user. " +
            "Replying moves it between those two by itself, so the queue stays honest without " +
            "anyone filing it."],
          ["Reports", "What people have reported — users, messages or games. Marking one " +
            "handled tells the reporter it was looked at."],
          ["Feedback", "One-way notes: bugs, ideas, game requests. Unlike a ticket, there is " +
            "no back-and-forth — you set a state and can leave one reply."],
          ["Logins", "Every sign-in attempt. A run of failures against one account is what a " +
            "break-in attempt looks like."],
          ["Games", "Owner only. Adds a title to the live catalogue without a commit and a " +
            "deploy, repoints one whose host moved, or hides one. It stores a pointer, not the " +
            "game files — those still have to be hosted somewhere."],
          ["Game data", "A save editor for whatever a game has stored in <b>your own browser</b>. " +
            "It edits your copy only; nothing here touches anyone else's progress."],
          ["Audit", "Every staff action, with who did it and when. It is append-only, and it " +
            "records your actions too."]
        ];

        var host = document.getElementById("help-tabs");
        host.innerHTML = "";
        TABS.forEach(function (pair) {
          /* Don't document a tab this account can't open. */
          if (pair[0] === "Games" && !isOwner) return;
          var dt = UI.el("dt", null, pair[0]);
          var dd = UI.el("dd");
          dd.innerHTML = pair[1];        // fixed copy above, not user input
          host.appendChild(dt);
          host.appendChild(dd);
        });

        var KEYS = [
          [mod + " + " + adminKey, "Jump straight to this console", "anywhere, even mid-game", true],
          ["Esc", "Close the finder, the settings sheet or the sidebar", "anywhere"],
          ["/", "Jump to the search box", "anywhere"],
          ["K", "Open the finder — search every game by name", "anywhere"],
          ["R", "Play something at random", "anywhere"],
          ["?", "Open quick settings", "anywhere"],
          ["P", "Play, or reload the game", "a game page"],
          ["F", "Pin the title you're on", "a game page"]
        ];

        var body = document.getElementById("help-keys");
        body.innerHTML = "";
        KEYS.forEach(function (row) {
          var tr = UI.el("tr");
          var kb = UI.el("td");
          var key = UI.el("kbd", null, row[0]);
          kb.appendChild(key);
          if (row[3]) kb.appendChild(UI.el("span", "tiny dimmer", " staff only"));
          tr.appendChild(kb);
          tr.appendChild(UI.el("td", null, row[1]));
          tr.appendChild(UI.el("td", "dimmer", row[2]));
          body.appendChild(tr);
        });

        var RANKS = [
          ["user", "The default. No console."],
          ["mod", "Reports, feedback, support, the live view and the login history. " +
            "Cannot change anyone's rank or suspend anyone."],
          ["admin", "Everything a mod has, plus promoting people to mod and suspending " +
            "accounts. Cannot promote anyone to admin — that is the rank rule, not an oversight."],
          ["owner", "Everything, plus the catalogue editor. Set by the server from the " +
            "configured owner name, never granted through this panel. The owner cannot be " +
            "demoted, suspended or deleted by anyone, including another owner — it exists so " +
            "there is always one account that a compromised admin cannot lock out."]
        ];

        var rankHost = document.getElementById("help-ranks");
        rankHost.innerHTML = "";
        RANKS.forEach(function (pair) {
          var dt = UI.el("dt", null, pair[0]);
          if (pair[0] === me.role) dt.appendChild(UI.el("span", "tiny dimmer", " ← you"));
          rankHost.appendChild(dt);
          rankHost.appendChild(UI.el("dd", null, pair[1]));
        });

        var NOTES = [
          "Every permission here is checked again on the server. A hidden button is " +
            "a convenience, not a lock.",
          "Admins and owners can change the console shortcut in Settings — the " +
            "letter only, " + mod + " is fixed. The picker marks which letters the " +
            "browser already wants, and which of those it will not give up at all.",
          "Suspending someone drops their sessions immediately; they are signed out on " +
            "their next request, not whenever they next close the tab.",
          "Support tickets and feedback are different things on purpose. Feedback is a " +
            "note you file; a ticket is a conversation that stays open until someone closes it.",
          "Adding a game through the Games tab points at files hosted elsewhere. If that " +
            "host goes away, so does the game — the catalogue entry is a link, not a copy.",
          "Messages are stored in plain text and moderators can read and remove them. " +
            "That is worth saying out loud to anyone who asks."
        ];

        var notes = document.getElementById("help-notes");
        notes.innerHTML = "";
        NOTES.forEach(function (text) { notes.appendChild(UI.el("li", null, text)); });
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

      /* ------------------------------------------------- catalogue (owner) */

      var CATEGORIES = [
        "arcade", "action", "puzzle", "strategy", "horror", "platformer", "sports",
        "racing", "adventure", "simulation", "rpg", "sandbox", "idle", "clicker", "other"
      ];

      function catField(id) { return document.getElementById(id); }

      function fillCatalogForm() {
        var hostBox = catField("cg-host");
        if (hostBox.options.length) return;         // already built

        var none = UI.el("option", null, "— full URL below —");
        none.value = "";
        hostBox.appendChild(none);
        Object.keys(window.SITE.gameHosts || {}).forEach(function (h) {
          var o = UI.el("option", null, h);
          o.value = h;
          hostBox.appendChild(o);
        });

        var catBox = catField("cg-category");
        CATEGORIES.forEach(function (c) {
          var o = UI.el("option", null, c);
          o.value = c;
          if (c === "arcade") o.selected = true;
          catBox.appendChild(o);
        });

        /* Typing a title suggests a slug, but stops the moment the id is
           edited by hand — silently overwriting a deliberate choice is worse
           than making them type it. */
        var idTouched = false;
        catField("cg-id").addEventListener("input", function () { idTouched = true; preview(); });
        catField("cg-title").addEventListener("input", function () {
          if (!idTouched) {
            catField("cg-id").value = catField("cg-title").value
              .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
          }
          preview();
        });
        ["cg-source", "cg-host"].forEach(function (f) {
          catField(f).addEventListener("input", preview);
          catField(f).addEventListener("change", preview);
        });

        catField("cat-form").addEventListener("submit", saveEntry);
        catField("cg-reset").addEventListener("click", function () {
          catField("cat-form").reset();
          idTouched = false;
          preview();
        });
      }

      function resolvedUrl() {
        var host = catField("cg-host").value;
        var source = catField("cg-source").value.trim();
        if (!source) return "";
        if (/^https?:\/\//i.test(source)) return source;
        if (!host) return "";
        var base = (window.SITE.gameHosts || {})[host] || "";
        return base.replace(/\/+$/, "") + "/" + source.replace(/^\/+/, "");
      }

      function preview() {
        var title = catField("cg-title").value.trim();
        var url = resolvedUrl();
        catField("cg-pv-title").textContent = title || "Preview";
        catField("cg-pv-url").textContent = url ||
          "Pick a host and give a path, or paste a full https:// URL.";

        var shot = catField("cg-shot");
        shot.innerHTML = "";
        if (title) shot.appendChild(window.Art.cover({ id: catField("cg-id").value || title, title: title }));
      }

      function saveEntry(event) {
        event.preventDefault();
        var err = catField("cg-error");
        err.hidden = true;

        var embed = catField("cg-embed").value;
        var entry = {
          id: catField("cg-id").value.trim(),
          title: catField("cg-title").value.trim(),
          category: catField("cg-category").value,
          host: catField("cg-host").value,
          source: catField("cg-source").value.trim(),
          description: catField("cg-desc").value.trim(),
          notice: catField("cg-notice").value.trim(),
          schoolRisk: catField("cg-risk").value,
          embed: embed === "allowed" ? "allowed" : false,
          preferDirect: embed !== "allowed"
        };

        catField("cg-save").disabled = true;
        API.saveCatalogEntry(entry).then(function () {
          UI.toast("“" + entry.title + "” is live.");
          catField("cat-form").reset();
          preview();
          loadCatalog();
        }).catch(function (e2) {
          err.textContent = e2.message || "Could not save that.";
          err.hidden = false;
        }).then(function () { catField("cg-save").disabled = false; });
      }

      function loadCatalog() {
        fillCatalogForm();
        preview();

        /* Drop the cached overlay so the owner's own next page view shows the
           edit straight away instead of waiting out the cache window. */
        if (window.CatalogOverlay) window.CatalogOverlay.invalidate();

        return API.customCatalog().then(function (res) {
          drawAdded(res.added || []);
          drawHidden(res.removed || []);
        }).catch(function (err) { UI.toast(err.message); });
      }

      function drawAdded(added) {
        var host = document.getElementById("cg-rows");
        host.innerHTML = "";

        var cols = "1fr 7rem 1fr 9rem";
        var head = UI.el("div", "rows-head");
        head.style.gridTemplateColumns = cols;
        ["Title", "Category", "Points at", ""].forEach(function (h) {
          head.appendChild(UI.el("span", null, h));
        });
        host.appendChild(head);

        if (!added.length) {
          host.appendChild(UI.el("p", "dim", "Nothing added here yet — the catalogue is all from the shipped list."));
          return;
        }

        added.forEach(function (g) {
          var row = UI.el("div", "row");
          row.style.gridTemplateColumns = cols;

          var link = UI.el("a", "name", g.title);
          link.href = UI.playHref(g);
          row.appendChild(link);

          row.appendChild(UI.el("span", "cat", g.category));

          var where = UI.el("span", "cat");
          where.textContent = (g.host ? g.host + " / " : "") + g.source;
          where.title = where.textContent;
          row.appendChild(where);

          var acts = UI.el("span", "admin-acts");

          var edit = UI.el("button", "btn btn-sm", "Edit");
          edit.type = "button";
          edit.addEventListener("click", function () { intoForm(g); });
          acts.appendChild(edit);

          var drop = UI.el("button", "btn btn-sm btn-flat", "Delete");
          drop.type = "button";
          drop.addEventListener("click", function () {
            if (!window.confirm("Remove “" + g.title + "” from the catalogue?")) return;
            API.removeCatalogEntry(g.id, true)
              .then(function () { UI.toast("Removed"); loadCatalog(); })
              .catch(function (e) { UI.toast(e.message); });
          });
          acts.appendChild(drop);

          row.appendChild(acts);
          host.appendChild(row);
        });
      }

      function drawHidden(removed) {
        var host = document.getElementById("cg-hidden");
        host.innerHTML = "";

        if (!removed.length) {
          host.appendChild(UI.el("p", "dim", "Nothing hidden. Every shipped title is showing."));
          return;
        }

        removed.forEach(function (id) {
          var row = UI.el("div", "row");
          row.style.gridTemplateColumns = "1fr 9rem";

          var game = window.Catalog.byId(id);
          var name = UI.el("span", "name");
          name.textContent = game ? game.title : id;
          row.appendChild(name);

          var back = UI.el("button", "btn btn-sm", "Show again");
          back.type = "button";
          back.addEventListener("click", function () {
            API.restoreCatalogEntry(id)
              .then(function () { UI.toast("Back in the catalogue"); loadCatalog(); })
              .catch(function (e) { UI.toast(e.message); });
          });
          row.appendChild(back);
          host.appendChild(row);
        });
      }

      function intoForm(g) {
        catField("cg-title").value = g.title || "";
        catField("cg-id").value = g.id || "";
        catField("cg-host").value = g.host || "";
        catField("cg-category").value = g.category || "arcade";
        catField("cg-source").value = g.source || "";
        catField("cg-desc").value = g.description || "";
        catField("cg-notice").value = g.notice || "";
        catField("cg-risk").value = g.schoolRisk || "unknown";
        catField("cg-embed").value = g.embed === false ? "direct" : "allowed";
        preview();
        catField("cg-title").scrollIntoView({ block: "center" });
      }

      loadOverview().catch(function (err) { UI.toast(err.message); });
      window.setInterval(loadOverview, 30000);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

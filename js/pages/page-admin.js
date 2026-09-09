/* Admin console.
 *
 * Rebuilt. What was here before had the right tabs and the wrong plumbing:
 *
 *   · The audit tab read a table that nothing on the Supabase backend ever
 *     wrote to, so it was permanently empty — an audit trail that recorded
 *     nothing while claiming to record everything.
 *   · Role and state changes went straight at the users table, so none of the
 *     rank rules were enforced, and a change the database quietly refused came
 *     back looking exactly like one it had accepted.
 *   · The rank picker only listed ranks below yours, so a row for someone at
 *     or above your rank displayed "user" as their current rank. Touching it
 *     then demoted them.
 *   · Every tab reloaded from scratch on every visit, and the overview polled
 *     every thirty seconds whether or not you were looking at it.
 *
 * The permissions themselves are enforced on the server, in one RPC per
 * action. Hiding a control here is convenience; it is not the lock.
 */
(function () {
  "use strict";

  var RANKS = ["user", "mod", "admin", "owner"];
  function rankOf(role) { return Math.max(0, RANKS.indexOf(role)); }

  function init() {
    window.SocialUI.gate(function (me) {
      var UI = window.UI;
      var API = window.API;

      if (!window.Session.isStaff()) {
        document.getElementById("denied").hidden = false;
        return;
      }

      var isAdmin = window.Session.isAdmin();
      var isOwner = window.Session.isOwner();

      document.getElementById("console").hidden = false;
      document.getElementById("r-role").textContent = me.role;
      document.querySelectorAll("[data-owner]").forEach(function (n) { n.hidden = !isOwner; });
      document.querySelectorAll("[data-owner-or-admin]").forEach(function (n) { n.hidden = !isAdmin; });

      /* ------------------------------------------------------------ tabs */

      /* Each tab knows how to load itself and whether it already has. A tab
         is fetched when you first open it and then left alone until you ask
         for it again — the old console refetched everything on every click. */
      var TABS = {
        overview: { load: loadOverview, poll: 30000 },
        live:     { load: loadLive, poll: 12000 },
        users:    { load: loadUsers },
        support:  { load: loadSupport },
        reports:  { load: loadReports },
        feedback: { load: loadFeedback },
        logins:   { load: loadLogins },
        games:    { load: loadCatalog },
        workbench: { load: function () {} },
        gamedata: { load: function () { if (window.initGameData) window.initGameData(); } },
        audit:    { load: loadAudit },
        help:     { load: loadHelp }
      };

      var active = "overview";
      var loadedOnce = {};
      var pollTimer = null;

      var tabs = document.getElementById("tabs");
      tabs.addEventListener("click", function (event) {
        var tab = event.target.closest("[data-tab]");
        if (tab) show(tab.dataset.tab);
      });

      /* The tab lives in the URL, so a refresh — or a link someone pastes to
         a colleague — lands where it was rather than back on Overview. */
      /* Hiding the nav button is convenience, not a lock — the data behind
         every other tab is re-checked on the server. Workbench has no server
         call to fall back on (it's just a link), so it gets an explicit
         client-side gate here rather than relying on the button being hidden. */
      var OWNER_ONLY_TABS = { workbench: true };

      function show(name, force) {
        if (!TABS[name] || (OWNER_ONLY_TABS[name] && !isOwner)) name = "overview";
        active = name;

        tabs.querySelectorAll(".admin-nav-link[role='tab']").forEach(function (t) {
          var on = t.dataset.tab === name;
          t.classList.toggle("on", on);
          t.setAttribute("aria-selected", on ? "true" : "false");
        });
        document.querySelectorAll("[data-panel]").forEach(function (p) {
          p.hidden = p.dataset.panel !== name;
        });

        if (window.location.hash.slice(1) !== name) {
          window.history.replaceState({}, "", window.location.pathname + "#" + name);
        }

        window.clearInterval(pollTimer);
        pollTimer = null;

        var spec = TABS[name];
        if (force || !loadedOnce[name]) {
          loadedOnce[name] = true;
          run(spec.load);
        }
        /* Only the tab you are actually looking at is allowed a timer. */
        if (spec.poll) {
          pollTimer = window.setInterval(function () {
            if (document.hidden) return;
            run(spec.load);
          }, spec.poll);
        }
      }

      function run(fn) {
        var out;
        try { out = fn(); } catch (err) { UI.toast(err.message); return; }
        if (out && out.catch) out.catch(function (err) { UI.toast(err.message); });
      }

      document.getElementById("refresh").addEventListener("click", function () {
        show(active, true);
        loadOverview();          // the header counts, whichever tab is open
        UI.toast("Refreshed");
      });

      window.addEventListener("hashchange", function () {
        show(window.location.hash.slice(1) || "overview");
      });

      /* ------------------------------------------------------- overview */

      function setText(id, value) {
        var node = document.getElementById(id);
        if (node) node.textContent = value;
      }

      /* Queue depth belongs on the tab, not buried inside it — the whole
         point of a moderation console is seeing what is waiting. */
      function paintQueues(q) {
        [["reports", q.reports], ["support", q.tickets], ["feedback", q.feedback]]
          .forEach(function (pair) {
            var tab = tabs.querySelector('[data-tab="' + pair[0] + '"]');
            if (!tab) return;
            var badge = tab.querySelector(".admin-nav-n");
            if (!badge) {
              badge = UI.el("span", "admin-nav-n");
              tab.appendChild(badge);
            }
            badge.textContent = pair[1] > 99 ? "99+" : String(pair[1] || 0);
            badge.hidden = !pair[1];
          });
      }

      var ACTION_TONE = {
        "user-delete": "bad", "user-update": "accent", "message-remove": "bad",
        "report-closed": "good", "report-open": "accent",
        "game-delete": "bad", "game-hide": "accent", "game-save": "accent",
        "game-restore": "good"
      };

      /* A dashboard's landing tab should show a pulse, not just a static
         snapshot — so Overview borrows a slice of the audit trail rather
         than making that the only reason to open the Audit tab. */
      function loadRecentActivity() {
        var host = document.getElementById("recent-audit");
        if (!host) return Promise.resolve();
        return API.adminAudit("").then(function (res) {
          host.innerHTML = "";
          var entries = (res.entries || []).slice(0, 6);
          if (!entries.length) {
            host.appendChild(UI.el("p", "dim", "Nothing yet."));
            return;
          }
          var cols = "1fr 5rem";
          entries.forEach(function (e) {
            var row = UI.el("div", "row");
            row.style.gridTemplateColumns = cols;

            var detail = UI.el("span", "name");
            var action = UI.el("span", "flag " +
              ({ bad: "flag-bad", good: "flag-good", accent: "flag-warn" }[ACTION_TONE[e.action]] || ""));
            action.textContent = e.action;
            detail.appendChild(action);
            detail.appendChild(document.createTextNode(
              " " + e.actor + (e.detail ? " — " + e.detail : "")));
            detail.title = detail.textContent;
            row.appendChild(detail);

            row.appendChild(UI.el("span", "plays", UI.formatWhen(e.at)));
            host.appendChild(row);
          });
        }).catch(function () { /* non-critical */ });
      }

      function loadOverview() {
        loadRecentActivity();
        return API.adminOverview().then(function (d) {
          var q = d.queues || {
            reports: (d.reports && d.reports.open) || 0, tickets: 0, feedback: 0, calls: 0
          };

          setText("k-users", d.users.total);
          setText("k-online", d.users.online);
          setText("k-new", d.users.newThisWeek);
          setText("k-suspended", d.users.suspended);
          setText("k-staff", d.users.staff == null ? "—" : d.users.staff);
          setText("k-friends", d.social.friendships);
          setText("k-messages", d.social.messages);
          setText("k-today", d.social.messagesToday);

          setText("q-reports", q.reports || 0);
          setText("q-support", q.tickets || 0);
          setText("q-feedback", q.feedback || 0);
          setText("q-calls", q.calls == null ? "—" : q.calls);

          setText("r-reports", q.reports || 0);
          setText("r-online", d.users.online);
          paintQueues(q);

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

      /* The queue tiles are shortcuts, so a moderator lands on the work
         rather than reading a number and then hunting for the tab. */
      document.querySelectorAll("[data-goto]").forEach(function (tile) {
        tile.addEventListener("click", function () { show(tile.dataset.goto); });
      });

      /* ---------------------------------------------------------- users */

      var userQ = document.getElementById("user-q");
      var userFilter = document.getElementById("user-filter");
      var userCache = [];
      var selectedUserId = null;

      userQ.addEventListener("input", UI.debounce(function () { loadUsers(); }, 240));
      userFilter.addEventListener("change", function () { drawUsers(); });

      function loadUsers() {
        return API.adminUsers(userQ.value.trim()).then(function (res) {
          userCache = res.users || [];
          drawUsers();
        });
      }

      function drawUsers() {
        var want = userFilter.value;
        var rows = userCache.filter(function (u) {
          if (want === "staff") return u.role !== "user";
          if (want === "suspended") return u.state === "suspended";
          if (want === "online") return u.online;
          if (want === "reported") return (u.reports || 0) > 0;
          return true;
        });

        var host = document.getElementById("user-rows");
        host.innerHTML = "";
        setText("user-count", rows.length + " of " + userCache.length);

        var cols = "1fr 5.5rem 6rem 7rem 6rem";
        var head = UI.el("div", "rows-head");
        head.style.gridTemplateColumns = cols;
        ["Account", "Rank", "State", "Activity", ""].forEach(function (h) {
          head.appendChild(UI.el("span", null, h));
        });
        host.appendChild(head);

        if (!rows.length) {
          host.appendChild(UI.el("p", "dim", "Nobody matches that."));
          return;
        }

        rows.forEach(function (u) {
          var row = UI.el("div", "row");
          row.style.gridTemplateColumns = cols;

          var who = UI.el("a", "admin-who");
          who.href = "profile.html?u=" + encodeURIComponent(u.username);
          who.appendChild(window.SocialUI.avatar(u));
          who.appendChild(window.SocialUI.nameBlock(u, { presence: true }));
          row.appendChild(who);

          row.appendChild(UI.el("span", "cat", u.role));

          var state = UI.el("span", "flag " + (u.state === "active" ? "flag-good" : "flag-bad"));
          state.textContent = u.state;
          row.appendChild(state);

          var stats = UI.el("span", "plays");
          stats.textContent = u.friends + "f · " + u.messages + "m" +
            (u.reports ? " · " + u.reports + "⚑" : "");
          stats.title = u.friends + " friends, " + u.messages + " messages" +
            (u.reports ? ", " + u.reports + " reports against them" : "");
          row.appendChild(stats);

          var acts = UI.el("span", "admin-acts");
          /* One rule decides whether anything is offered at all, and it is
             the same rule the server applies: you may act only on someone
             below your own rank. Everything else is a label saying why not. */
          var manageable = u.id !== me.id && u.role !== "owner" &&
            isAdmin && rankOf(me.role) > rankOf(u.role);
          if (u.id === me.id) {
            acts.appendChild(UI.el("span", "tiny dimmer", "that's you"));
          } else if (u.role === "owner") {
            acts.appendChild(UI.el("span", "tiny dimmer", "owner"));
          } else if (!isAdmin || rankOf(me.role) <= rankOf(u.role)) {
            acts.appendChild(UI.el("span", "tiny dimmer",
              isAdmin ? "outranks you" : "admins only"));
          } else {
            acts.appendChild(UI.el("span", "tiny dimmer", "›"));
          }
          row.appendChild(acts);

          /* The row itself opens the detail pane beside the list — clicking
             the account link still goes to the profile page as before. */
          row.classList.add("user-row");
          row.dataset.userId = u.id;
          row.tabIndex = 0;
          row.setAttribute("role", "button");
          row.setAttribute("aria-label", "Manage @" + u.username);
          function open(event) {
            if (event && event.target.closest("a")) return;
            selectUser(u, row, manageable);
          }
          row.addEventListener("click", open);
          row.addEventListener("keydown", function (event) {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); }
          });
          if (selectedUserId === u.id) row.classList.add("is-on");

          host.appendChild(row);
        });
      }

      /* Clicking a row selects it and fills the pane beside the list — a
         master-detail layout rather than a sheet stacked over the list you
         were just scanning. Deleting an account is still not one stray
         click away: it lives behind a typed confirmation either way. */
      function selectUser(u, row, manageable) {
        selectedUserId = u.id;
        document.querySelectorAll("#user-rows .user-row").forEach(function (r) {
          r.classList.toggle("is-on", r === row);
        });
        renderUserDetail(u, manageable);
      }

      function renderUserDetail(u, manageable) {
        var body = document.getElementById("user-detail");
        body.innerHTML = "";
        body.appendChild(UI.el("span", "label", "@" + u.username));

        var summary = UI.el("p", "tiny dimmer");
        summary.style.margin = "0 0 1rem";
        summary.textContent = [
          "joined " + (u.createdAt ? new Date(u.createdAt).toLocaleDateString() : "—"),
          "last seen " + (u.online ? "now" : UI.formatWhen(u.lastSeen)),
          u.lastLogin ? "last sign-in " + UI.formatWhen(u.lastLogin) : null,
          u.friends + " friends",
          u.messages + " messages",
          u.reports ? u.reports + " reports against them" : null,
          u.playing ? "playing " + u.playing : null
        ].filter(Boolean).join(" · ");
        body.appendChild(summary);

        if (!manageable) {
          body.appendChild(UI.el("p", "tiny dimmer",
            u.id === me.id ? "That's you." :
            u.role === "owner" ? "The owner can't be managed by anyone." :
            isAdmin ? "This account outranks you." : "Admins and owners only."));
          return;
        }

        function clearDetail() {
          var host = document.getElementById("user-detail");
          host.innerHTML = "";
          host.appendChild(UI.el("p", "user-detail-empty", "Select an account to manage it."));
          selectedUserId = null;
        }

        /* Rank.
           Only the ranks you are allowed to hand out are listed — and because
           you can only be here at all when you outrank them, their current
           rank is always one of those. The old picker listed the same subset
           but rendered it for everyone, so a row it could not represent
           showed the first option instead and quietly proposed a demotion. */
        var rankField = UI.el("div", "field");
        var rankLabel = UI.el("label", null, "Rank");
        rankLabel.setAttribute("for", "detail-rank");
        rankField.appendChild(rankLabel);

        var rankBox = UI.el("select");
        rankBox.id = "detail-rank";
        RANKS.slice(0, rankOf(me.role)).forEach(function (r) {
          var o = UI.el("option", null, r);
          o.value = r;
          if (u.role === r) o.selected = true;
          rankBox.appendChild(o);
        });
        rankField.appendChild(rankBox);
        var rankNote = UI.el("p", "tiny dimmer");
        rankNote.style.margin = "0.3rem 0 0";
        rankNote.textContent = "You can grant any rank below your own. " +
          "Owner is set by the server and never handed out here.";
        rankField.appendChild(rankNote);
        body.appendChild(rankField);

        var apply = UI.el("button", "btn btn-cta", "Save rank");
        apply.type = "button";
        apply.style.marginTop = "0.6rem";
        apply.addEventListener("click", function () {
          if (rankBox.value === u.role) { UI.toast("That's already their rank"); return; }
          if (!window.confirm("Make @" + u.username + " a " + rankBox.value + "?")) return;
          busy(apply, API.adminUpdateUser(u.id, { role: rankBox.value })
            .then(function () {
              UI.toast("@" + u.username + " is now " + rankBox.value);
              clearDetail();
              loadUsers();
            }));
        });
        body.appendChild(apply);

        body.appendChild(UI.el("hr", "sheet-rule"));

        /* Suspension. */
        var suspended = u.state === "suspended";
        var stateNote = UI.el("p", "tiny dimmer");
        stateNote.style.margin = "0 0 0.6rem";
        stateNote.textContent = suspended
          ? "Suspended. Friends, messages and calls are refused by the database, " +
            "not just hidden from them."
          : "Suspending stops friend requests, messages and calls at the database. " +
            "Playing signed out still works.";
        body.appendChild(stateNote);

        var toggle = UI.el("button", "btn", suspended ? "Restore account" : "Suspend account");
        toggle.type = "button";
        toggle.addEventListener("click", function () {
          var next = suspended ? "active" : "suspended";
          if (next === "suspended" &&
              !window.confirm("Suspend @" + u.username + "?")) return;
          busy(toggle, API.adminUpdateUser(u.id, { state: next })
            .then(function () {
              UI.toast("@" + u.username + " " + next);
              clearDetail();
              loadUsers();
            }));
        });
        body.appendChild(toggle);

        body.appendChild(UI.el("hr", "sheet-rule"));

        /* Deletion. There is no password reset on this hub, so this is also
           the only answer to "I've forgotten mine" — worth saying, because
           it is the one action here that cannot be undone. */
        var dangerNote = UI.el("p", "tiny dimmer");
        dangerNote.style.margin = "0 0 0.6rem";
        dangerNote.textContent = "Deleting removes the profile, their friends, " +
          "messages and saved progress. It cannot be undone, and it does not " +
          "free the account to be recreated by them.";
        body.appendChild(dangerNote);

        var wipe = UI.el("button", "btn btn-flat is-danger", "Delete account");
        wipe.type = "button";
        wipe.addEventListener("click", function () {
          var typed = window.prompt("Type " + u.username + " to confirm deletion.");
          if (typed === null) return;
          if (typed.trim().toLowerCase() !== u.username.toLowerCase()) {
            UI.toast("That didn't match — nothing was deleted");
            return;
          }
          busy(wipe, API.adminDeleteUser(u.id).then(function () {
            UI.toast("@" + u.username + " deleted");
            clearDetail();
            loadUsers();
          }));
        });
        body.appendChild(wipe);
        rankBox.focus();
      }

      /* Every action in the pane reports its own failure, rather than
         leaving a disabled button and no explanation. */
      function busy(button, promise) {
        button.disabled = true;
        return promise.catch(function (err) {
          UI.toast(err.message || "That didn't work");
        }).then(function () { button.disabled = false; });
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
          res.reports.forEach(function (r) { host.appendChild(reportCard(r)); });
        });
      }

      function reportCard(r) {
        var card = UI.el("div", "report");

        var top = UI.el("div", "report-top");
        top.appendChild(UI.el("span", "pill on", r.kind));

        /* A report on an account links to that account. Reading "@someone"
           as flat text and then going to find them by hand was most of the
           work of handling one. */
        if (r.kind === "user") {
          var link = UI.el("a", "report-target");
          link.href = "profile.html?u=" + encodeURIComponent(String(r.target).replace(/^@/, ""));
          link.textContent = r.target;
          top.appendChild(link);
        } else {
          var target = UI.el("span", "report-target");
          target.textContent = r.target;
          top.appendChild(target);
        }

        var when = UI.el("span", "tiny dimmer");
        when.textContent = UI.formatWhen(r.at) + " · by " + r.reporter;
        when.style.marginLeft = "auto";
        top.appendChild(when);
        card.appendChild(top);

        var reason = UI.el("p", "report-reason");
        reason.textContent = r.reason;      // untrusted
        card.appendChild(reason);

        var acts = UI.el("div", "btn-row");

        var act = UI.el("button", "btn btn-sm btn-cta",
          r.state === "open" ? "Mark handled" : "Reopen");
        act.type = "button";
        act.addEventListener("click", function () {
          busy(act, API.adminCloseReport(r.id, r.state === "open" ? "closed" : "open")
            .then(function () { loadReports(); loadOverview(); }));
        });
        acts.appendChild(act);

        /* Acting on the report without leaving the queue. Only offered when
           the target is an account this moderator actually outranks — the
           server refuses anything else anyway. */
        var subject = r.subject;
        if (subject && isAdmin && subject.id !== me.id &&
            rankOf(me.role) > rankOf(subject.role)) {
          var next = subject.state === "suspended" ? "active" : "suspended";
          var punish = UI.el("button", "btn btn-sm",
            next === "suspended" ? "Suspend @" + subject.username : "Restore @" + subject.username);
          punish.type = "button";
          punish.addEventListener("click", function () {
            if (next === "suspended" &&
                !window.confirm("Suspend @" + subject.username + "?")) return;
            busy(punish, API.adminUpdateUser(subject.id, { state: next })
              .then(function () {
                UI.toast("@" + subject.username + " " + next);
                loadReports();
              }));
          });
          acts.appendChild(punish);
        }

        card.appendChild(acts);
        return card;
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
          /* Put the queue depth on the pills so nothing rots unnoticed. */
          document.querySelectorAll("[data-fb]").forEach(function (p) {
            var n = res.counts[p.dataset.fb] || 0;
            var label = p.dataset.label || p.textContent.replace(/\s*\(\d+\)$/, "");
            p.dataset.label = label;
            p.textContent = label + (n ? " (" + n + ")" : "");
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
                  busy(b, API.adminUpdateFeedback(f.id, { state: pair[1] })
                    .then(function () {
                      UI.toast("Marked " + pair[1]);
                      loadFeedback();
                      loadOverview();
                    }));
                });
                acts.appendChild(b);
              });

            var replyBtn = UI.el("button", "btn btn-sm btn-cta", f.reply ? "Edit reply" : "Reply");
            replyBtn.type = "button";
            replyBtn.addEventListener("click", function () {
              var text2 = window.prompt("Reply to “" + f.subject + "”", f.reply || "");
              if (text2 === null) return;
              busy(replyBtn, API.adminUpdateFeedback(f.id, { reply: text2.trim() })
                .then(function () { UI.toast("Reply sent"); loadFeedback(); }));
            });
            acts.appendChild(replyBtn);

            card.appendChild(acts);
            host.appendChild(card);
          });
        });
      }

      /* ----------------------------------------------------------- live */

      function loadLive() {
        return API.adminLive().then(function (res) {
          var host = document.getElementById("live-rows");
          host.innerHTML = "";

          setText("live-online", res.online || 0);
          setText("live-playing", res.playing || 0);

          var cols = "1fr 6rem 1fr 7rem";
          var head = UI.el("div", "rows-head");
          head.style.gridTemplateColumns = cols;
          ["User", "Rank", "Playing", "Last seen"].forEach(function (h) {
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
        });
      }

      /* --------------------------------------------------------- logins */

      function loadLogins() {
        return API.adminLogins().then(function (res) {
          var host = document.getElementById("login-rows");
          host.innerHTML = "";

          var note = document.getElementById("login-note");
          /* The Supabase backend cannot see failed attempts — the password
             check happens inside Supabase Auth. Say so, or the list reads as
             "nobody has ever failed a sign-in", which is a dangerous thing to
             believe about a security log. */
          note.hidden = res.failuresVisible !== false;

          var cols = "1fr 5rem 1fr 7rem";
          var head = UI.el("div", "rows-head");
          head.style.gridTemplateColumns = cols;
          ["Account", "Result", "Where from", "When"].forEach(function (h) {
            head.appendChild(UI.el("span", null, h));
          });
          host.appendChild(head);

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
            where.title = where.textContent;
            row.appendChild(where);

            row.appendChild(UI.el("span", "plays", UI.formatWhen(l.at)));
            host.appendChild(row);
          });
        });
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
            var label = p.dataset.label || p.textContent.replace(/\s*\(\d+\)$/, "");
            p.dataset.label = label;
            p.textContent = label + (n ? " (" + n + ")" : "");
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
        });
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
          busy(openBtn, API.ticket(t.id).then(function (res) {
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
          }));
        });
        acts.appendChild(openBtn);

        var reply = UI.el("button", "btn btn-sm btn-cta", "Reply");
        reply.type = "button";
        reply.addEventListener("click", function () {
          var text = window.prompt("Reply to “" + t.subject + "”");
          if (text === null || !text.trim()) return;
          busy(reply, API.replyTicket(t.id, text.trim())
            .then(function () { UI.toast("Reply sent"); loadSupport(); }));
        });
        acts.appendChild(reply);

        var flip = UI.el("button", "btn btn-sm", t.state === "closed" ? "Reopen" : "Close");
        flip.type = "button";
        flip.addEventListener("click", function () {
          busy(flip, API.updateTicket(t.id, { state: t.state === "closed" ? "open" : "closed" })
            .then(function () { loadSupport(); loadOverview(); }));
        });
        acts.appendChild(flip);

        var bump = UI.el("button", "btn btn-sm btn-flat",
          t.priority === "high" ? "Lower priority" : "Raise priority");
        bump.type = "button";
        bump.addEventListener("click", function () {
          busy(bump, API.updateTicket(t.id, { priority: t.priority === "high" ? "normal" : "high" })
            .then(function () { loadSupport(); }));
        });
        acts.appendChild(bump);

        card.appendChild(acts);
        return card;
      }

      /* ---------------------------------------------------------- audit */

      var auditQ = document.getElementById("audit-q");
      auditQ.addEventListener("input", UI.debounce(function () { loadAudit(); }, 260));

      /* Staff actions are grouped by what they touch, so a trail can be read
         at a glance rather than parsed word by word. Tone map lives beside
         loadRecentActivity() above, which reuses it for the Overview slice. */
      function loadAudit() {
        return API.adminAudit(auditQ.value.trim()).then(function (res) {
          var host = document.getElementById("audit-rows");
          host.innerHTML = "";

          var cols = "4.5rem 9rem 10rem 1fr 7rem";
          var head = UI.el("div", "rows-head");
          head.style.gridTemplateColumns = cols;
          ["Entry", "Who", "Did", "To what", "When"].forEach(function (h) {
            head.appendChild(UI.el("span", null, h));
          });
          host.appendChild(head);

          if (!res.entries.length) {
            var empty = UI.el("div", "void");
            empty.appendChild(UI.el("strong", null,
              auditQ.value.trim() ? "Nothing matches" : "Nothing recorded yet"));
            empty.appendChild(UI.el("p", null, auditQ.value.trim()
              ? "Try a username, an action like “suspend”, or clear the search."
              : "Rank changes, suspensions, deletions, closed reports and " +
                "catalogue edits all land here as they happen."));
            host.appendChild(empty);
            return;
          }

          res.entries.forEach(function (e) {
            var row = UI.el("div", "row");
            row.style.gridTemplateColumns = cols;

            /* The row number used to be the position on screen, which changed
               as soon as anything new arrived. The entry's own id doesn't. */
            row.appendChild(UI.el("span", "idx", "#" + e.id));
            row.appendChild(UI.el("span", "cat", e.actor));

            var action = UI.el("span", "flag " +
              ({ bad: "flag-bad", good: "flag-good", accent: "flag-warn" }[ACTION_TONE[e.action]] || ""));
            action.textContent = e.action;
            row.appendChild(action);

            var detail = UI.el("span", "name");
            detail.textContent = e.detail || "—";
            detail.title = e.detail || "";
            row.appendChild(detail);

            row.appendChild(UI.el("span", "plays", UI.formatWhen(e.at)));
            host.appendChild(row);
          });
        });
      }

      /* ----------------------------------------------------------- help */

      function loadHelp() {
        var mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
        var mod = mac ? "⌘" : "Ctrl";
        var fallback = (window.SITE.defaults && window.SITE.defaults.adminKey) || "k";
        var adminKey = (window.Store.settings().adminKey || fallback).toUpperCase();

        var TAB_HELP = [
          ["Overview", "Counts for the whole site, the queues waiting on staff, and the " +
            "most-played titles across every account. Refreshes itself while you're on it."],
          ["Live", "Who is signed in right now and what they have open. Presence comes from " +
            "the player page, so it lags by up to a minute and stops when someone closes the tab. " +
            "It is not a location log — it only knows the game, not the person."],
          ["Users", "Search accounts and open one to change its rank, suspend it or delete it. " +
            "A suspension is enforced in the database: friend requests, messages and calls are " +
            "refused, not merely hidden."],
          ["Support", "The ticket queue. “Needs a reply” is waiting on staff; " +
            "“waiting on them” means you have replied and it is with the user. " +
            "Replying moves it between those two by itself, so the queue stays honest without " +
            "anyone filing it."],
          ["Reports", "What people have reported — users, messages or games. A report about an " +
            "account can be acted on from the card, so you don't have to go and find them. " +
            "Marking one handled tells the reporter it was looked at."],
          ["Feedback", "One-way notes: bugs, ideas, game requests. Unlike a ticket, there is " +
            "no back-and-forth — you set a state and can leave one reply."],
          ["Logins", "Sign-in history. A run of failures against one account is what a " +
            "break-in attempt looks like. On the Supabase backend only successes are visible; " +
            "the tab says so when that applies."],
          ["Games", "Owner only. Adds a title to the live catalogue without a commit and a " +
            "deploy, repoints one whose host moved, or hides one. It stores a pointer, not the " +
            "game files — those still have to be hosted somewhere."],
          ["Workbench", "Owner only. A link out to a machine you've set up for this, reachable " +
            "from any device — full keyboard and mouse, direct and end-to-end encrypted. It " +
            "opens in its own tab; this page has no way to reach into it."],
          ["Game data", "A save editor for whatever a game has stored in <b>your own browser</b>. " +
            "It edits your copy only; nothing here touches anyone else's progress."],
          ["Audit", "Every staff action, with who did it and when — rank changes, suspensions, " +
            "deletions, removed messages, closed reports, catalogue edits. Append-only, and it " +
            "records your actions too. Searchable."]
        ];

        var host = document.getElementById("help-tabs");
        host.innerHTML = "";
        TAB_HELP.forEach(function (pair) {
          /* Don't document a tab this account can't open. */
          if ((pair[0] === "Games" || pair[0] === "Workbench") && !isOwner) return;
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
          kb.appendChild(UI.el("kbd", null, row[0]));
          if (row[3]) kb.appendChild(UI.el("span", "tiny dimmer", " staff only"));
          tr.appendChild(kb);
          tr.appendChild(UI.el("td", null, row[1]));
          tr.appendChild(UI.el("td", "dimmer", row[2]));
          body.appendChild(tr);
        });

        var RANK_HELP = [
          ["user", "The default. No console."],
          ["mod", "Reports, feedback, support, the live view and the sign-in history. " +
            "Cannot change anyone's rank or suspend anyone."],
          ["admin", "Everything a mod has, plus ranks up to mod, suspensions and deletions. " +
            "Cannot promote anyone to admin — that is the rank rule, not an oversight."],
          ["owner", "Everything, plus the catalogue editor. Set by the server from the " +
            "configured owner name, never granted through this panel. The owner cannot be " +
            "demoted, suspended or deleted by anyone, including another owner — it exists so " +
            "there is always one account that a compromised admin cannot lock out."]
        ];

        var rankHost = document.getElementById("help-ranks");
        rankHost.innerHTML = "";
        RANK_HELP.forEach(function (pair) {
          var dt = UI.el("dt", null, pair[0]);
          if (pair[0] === me.role) dt.appendChild(UI.el("span", "tiny dimmer", " ← you"));
          rankHost.appendChild(dt);
          rankHost.appendChild(UI.el("dd", null, pair[1]));
        });

        var NOTES = [
          "Every permission here is checked again on the server, in the same function " +
            "that performs the action. A hidden button is a convenience, not a lock.",
          "You can only act on someone below your own rank, and you can never grant your " +
            "own rank. That is why a row for another admin offers you nothing.",
          "Suspending is enforced by the database, not the interface: a suspended account " +
            "is refused friend requests, messages and calls even if it keeps a valid session.",
          "There is no password reset on this hub. If someone forgets theirs, deleting the " +
            "account is the only thing anyone can do — including you.",
          "Admins and owners can change the console shortcut in Settings — the " +
            "letter only, " + mod + " is fixed. The picker marks which letters the " +
            "browser already wants, and which of those it will not give up at all.",
          "Support tickets and feedback are different things on purpose. Feedback is a " +
            "note you file; a ticket is a conversation that stays open until someone closes it.",
          "Adding a game through the Games tab points at files hosted elsewhere. If that " +
            "host goes away, so does the game — the catalogue entry is a link, not a copy.",
          "Messages are stored in plain text and moderators can read and remove them. " +
            "Removing one is recorded in the audit trail under your name."
        ];

        var notes = document.getElementById("help-notes");
        notes.innerHTML = "";
        NOTES.forEach(function (text) { notes.appendChild(UI.el("li", null, text)); });
      }

      /* ------------------------------------------------- catalogue (owner) */

      var CATEGORIES = [
        "arcade", "action", "puzzle", "strategy", "horror", "platformer", "sports",
        "racing", "adventure", "simulation", "rpg", "sandbox", "idle", "clicker",
        "cards", "board", "trivia", "music", "other"
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
          hideForm();
          preview();
          reloadCatalog();
        }).catch(function (e2) {
          err.textContent = e2.message || "Could not save that.";
          err.hidden = false;
        }).then(function () { catField("cg-save").disabled = false; });
      }

      /* The catalogue manager lists the whole catalogue and marks where each
         title comes from, so the tab is useful on an install where nothing
         has been added here yet. */

      var overlay = { added: [], removed: [] };
      var LIST_CAP = 60;
      var filtersReady = false;

      function loadCatalog() {
        fillCatalogForm();
        fillFilters();
        preview();

        /* Drop the cached overlay so the owner's own next page view shows the
           edit straight away instead of waiting out the cache window. */
        if (window.CatalogOverlay) window.CatalogOverlay.invalidate();

        return API.customCatalog().then(function (res) {
          overlay = { added: res.added || [], removed: res.removed || [] };
          drawCatalog();
        }).catch(function (err) {
          UI.toast(err.message);
          drawCatalog();            // still show the shipped list
        });
      }

      function fillFilters() {
        if (filtersReady) return;
        filtersReady = true;

        var box = document.getElementById("cg-filter-cat");
        var any = UI.el("option", null, "All categories");
        any.value = "";
        box.appendChild(any);
        window.Catalog.categories.forEach(function (c) {
          var o = UI.el("option", null, c.label + " (" + c.count + ")");
          o.value = c.id;
          box.appendChild(o);
        });

        var redraw = UI.debounce(drawCatalog, 160);
        document.getElementById("cg-q").addEventListener("input", redraw);
        box.addEventListener("change", drawCatalog);
        document.getElementById("cg-filter-state").addEventListener("change", drawCatalog);
        document.getElementById("cg-new").addEventListener("click", function () { showForm(null); });
        document.getElementById("cg-close").addEventListener("click", hideForm);
      }

      /* Where a title comes from, and whether it is currently showing. */
      function statusOf(game) {
        if (overlay.removed.indexOf(game.id) !== -1) return "hidden";
        if (overlay.added.some(function (g) { return g.id === game.id; })) return "added";
        if (game.unavailable) return "gone";
        return "shipped";
      }

      var STATUS_LABEL = {
        hidden: "hidden", added: "added here", gone: "no host", shipped: "shipped"
      };

      function drawCatalog() {
        var host = document.getElementById("cg-list");
        var q = document.getElementById("cg-q").value.trim().toLowerCase();
        var cat = document.getElementById("cg-filter-cat").value;
        var want = document.getElementById("cg-filter-state").value;

        /* Catalog.all already has the overlay folded in, so a title added
           here appears exactly as a shipped one does. */
        var all = window.Catalog.all;
        var added = 0, gone = 0;
        all.forEach(function (g) {
          var st = statusOf(g);
          if (st === "added") added++;
          if (st === "gone") gone++;
        });

        setText("cg-k-total", all.length);
        setText("cg-k-added", added);
        setText("cg-k-hidden", overlay.removed.length);
        setText("cg-k-gone", gone);

        var matches = all.filter(function (g) {
          if (cat && g.category !== cat) return false;
          if (want !== "all" && statusOf(g) !== want) return false;
          if (q && g.titleLower.indexOf(q) === -1 && g.id.indexOf(q) === -1) return false;
          return true;
        });

        /* A hidden title is not in Catalog.all — the overlay drops it before
           the page ever indexes it — so list those separately or they would
           be unrecoverable from this screen. */
        var ghosts = [];
        if (want === "all" || want === "hidden") {
          overlay.removed.forEach(function (id) {
            if (all.some(function (g) { return g.id === id; })) return;
            if (q && id.indexOf(q) === -1) return;
            ghosts.push({ id: id, title: id, category: "—", ghost: true });
          });
        }

        var total = matches.length + ghosts.length;
        var shown = Math.min(matches.length, LIST_CAP) + ghosts.length;

        setText("cg-count", total === 0
          ? "Nothing matches that."
          : "Showing " + shown + " of " + total +
            (total > shown ? " — narrow the search to see the rest." : ""));

        host.innerHTML = "";
        ghosts.forEach(function (g) { host.appendChild(gameRow(g, "hidden")); });
        matches.slice(0, LIST_CAP).forEach(function (g) {
          host.appendChild(gameRow(g, statusOf(g)));
        });

        if (!total) {
          var v = UI.el("div", "void");
          v.appendChild(UI.el("strong", null, "Nothing matches"));
          v.appendChild(UI.el("p", null, "Try a different search, or clear the filters."));
          host.appendChild(v);
        }
      }

      function gameRow(game, status) {
        var row = UI.el("div", "game-row");
        row.dataset.status = status;

        var shot = UI.el("div", "game-row-shot");
        if (!game.ghost) shot.appendChild(window.Art.cover(game));
        row.appendChild(shot);

        var mid = UI.el("div", "game-row-mid");
        var name = UI.el("span", "game-row-title");
        name.textContent = game.title;
        mid.appendChild(name);

        var where = UI.el("span", "game-row-where");
        where.textContent = game.ghost
          ? "hidden — id " + game.id
          : (game.host ? game.host + " / " : "") + (game.source || "—");
        where.title = where.textContent;
        mid.appendChild(where);
        row.appendChild(mid);

        row.appendChild(UI.el("span", "game-row-cat", game.categoryLabel || game.category));

        var tag = UI.el("span", "game-row-tag", STATUS_LABEL[status] || status);
        tag.dataset.s = status;
        row.appendChild(tag);

        var acts = UI.el("span", "game-row-acts");

        if (status === "hidden") {
          var back = UI.el("button", "btn btn-sm btn-cta", "Show");
          back.type = "button";
          back.addEventListener("click", function () {
            busy(back, API.restoreCatalogEntry(game.id)
              .then(function () { UI.toast("Back in the catalogue"); reloadCatalog(); }));
          });
          acts.appendChild(back);
        } else {
          var play = UI.el("a", "btn btn-sm btn-flat", "Open");
          play.href = UI.playHref(game);
          acts.appendChild(play);

          var edit = UI.el("button", "btn btn-sm", "Edit");
          edit.type = "button";
          edit.addEventListener("click", function () { showForm(game); });
          acts.appendChild(edit);

          var hide = UI.el("button", "btn btn-sm btn-flat", "Hide");
          hide.type = "button";
          hide.title = status === "added"
            ? "Removes it — it was added here, so there is nothing underneath"
            : "Hides it from everyone; you can put it back";
          hide.addEventListener("click", function () {
            var hard = status === "added";
            if (!window.confirm(hard
              ? "Remove " + game.title + "? It was added here, so this deletes it."
              : "Hide " + game.title + " from the catalogue? You can put it back.")) return;
            busy(hide, API.removeCatalogEntry(game.id, hard)
              .then(function () { UI.toast(hard ? "Removed" : "Hidden"); reloadCatalog(); }));
          });
          acts.appendChild(hide);
        }

        row.appendChild(acts);
        return row;
      }

      /* A change to the overlay changes what Catalog.all should hold, and that
         is built once at page load. Re-reading the overlay keeps the counts
         and badges here honest; the catalogue itself picks it up on the next
         navigation. */
      function reloadCatalog() {
        return API.customCatalog().then(function (res) {
          overlay = { added: res.added || [], removed: res.removed || [] };
          if (window.CatalogOverlay) window.CatalogOverlay.invalidate();
          drawCatalog();
        }).catch(function (err) { UI.toast(err.message); });
      }

      function showForm(game) {
        document.getElementById("cg-form-head").hidden = false;
        document.getElementById("cg-form-note").hidden = false;
        document.getElementById("cat-form").hidden = false;
        setText("cg-form-title", game ? "Edit " + game.title : "Add a game");
        setText("cg-save", game ? "Save changes" : "Add to the catalogue");

        if (game) intoForm(game);
        else { document.getElementById("cat-form").reset(); preview(); }

        /* Nice-to-have, and not worth throwing over — older browsers and
           non-browser DOMs do not all implement it. */
        var head = document.getElementById("cg-form-head");
        if (head.scrollIntoView) head.scrollIntoView({ block: "start" });
      }

      function hideForm() {
        document.getElementById("cg-form-head").hidden = true;
        document.getElementById("cg-form-note").hidden = true;
        document.getElementById("cat-form").hidden = true;
      }

      function intoForm(g) {
        catField("cg-title").value = g.title || "";
        catField("cg-id").value = g.id || "";
        catField("cg-host").value = g.host || "";
        catField("cg-category").value = g.category || "arcade";
        catField("cg-source").value = g.source || "";
        catField("cg-desc").value = g.description || "";
        catField("cg-notice").value = g.notice || "";
        catField("cg-risk").value = g.risk || g.schoolRisk || "unknown";
        catField("cg-embed").value = (g.embeddable === false || g.embed === false)
          ? "direct" : "allowed";
        preview();
      }

      /* ----------------------------------------------------------- boot */

      /* The header counts are wanted on every tab, so they load regardless of
         which one the URL asks for — and marking overview loaded stops it
         being fetched twice when that is also the tab being shown. */
      loadedOnce.overview = true;
      run(loadOverview);
      show(window.location.hash.slice(1) || "overview");
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

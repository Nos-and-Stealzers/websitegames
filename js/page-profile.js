/* A player's profile. No ?u= means your own. */
(function () {
  "use strict";

  function init() {
    window.SocialUI.gate(function (me) {
      var UI = window.UI;
      var S = window.SocialUI;
      var API = window.API;

      var wanted = UI.params().get("u") || me.username;

      function load() {
        return API.user(wanted).then(draw).catch(function () {
          document.getElementById("missing").hidden = false;
        });
      }

      function draw(res) {
        var user = res.user;
        var mine = user.relation === "self";

        document.getElementById("view").hidden = false;
        document.title = (user.displayName || user.username) + " — " + window.SITE.name;

        var who = document.getElementById("who");
        who.innerHTML = "";
        who.appendChild(S.avatar(user, "lg"));
        var block = UI.el("div");
        var h1 = UI.el("h1");
        h1.textContent = user.displayName || user.username;
        block.appendChild(h1);
        var handle = UI.el("p", "handle");
        handle.textContent = "@" + user.username;
        if (user.role !== "user") handle.appendChild(UI.el("span", "role", user.role));
        if (user.state === "suspended") handle.appendChild(UI.el("span", "role bad", "suspended"));
        block.appendChild(handle);
        var presence = UI.el("p", "tiny dimmer");
        presence.textContent = user.online ? "● online now" : "last seen " + UI.formatWhen(user.lastSeen);
        block.appendChild(presence);
        who.appendChild(block);

        if (user.bio) {
          var bio = document.getElementById("bio");
          bio.textContent = user.bio;      // untrusted text
          bio.hidden = false;
        }

        /* ---- actions ---- */
        var acts = document.getElementById("acts");
        acts.innerHTML = "";

        function button(label, kind, onClick) {
          var b = UI.el("button", "btn" + (kind ? " " + kind : ""), label);
          b.type = "button";
          b.addEventListener("click", function () {
            b.disabled = true;
            Promise.resolve(onClick())
              .catch(function (err) { UI.toast(err.message || "That didn't work"); })
              .then(function () { b.disabled = false; });
          });
          acts.appendChild(b);
          return b;
        }

        if (mine) {
          var edit = UI.el("a", "btn btn-cta", "Edit profile");
          edit.href = "settings.html";
          acts.appendChild(edit);
          var lib = UI.el("a", "btn", "My shelf");
          lib.href = "library.html";
          acts.appendChild(lib);
        } else {
          S.relationActions(user, {
            add: function () { return API.addFriend(user.username).then(after("Request sent")); },
            accept: function () { return API.friends().then(function (d) {
              var edge = d.incoming.filter(function (u) { return u.username === user.username; })[0];
              return edge ? API.acceptFriend(edge.edgeId).then(after("You're now friends")) : null;
            }); },
            remove: function () { return API.friends().then(function (d) {
              var all = d.friends.concat(d.incoming, d.outgoing);
              var edge = all.filter(function (u) { return u.username === user.username; })[0];
              return edge ? API.removeFriend(edge.edgeId).then(after("Removed")) : null;
            }); },
            cancel: function () { return API.friends().then(function (d) {
              var edge = d.outgoing.filter(function (u) { return u.username === user.username; })[0];
              return edge ? API.removeFriend(edge.edgeId).then(after("Request cancelled")) : null;
            }); },
            unblock: function () { return API.friends().then(function (d) {
              var edge = d.blocked.filter(function (u) { return u.username === user.username; })[0];
              return edge ? API.removeFriend(edge.edgeId).then(after("Unblocked")) : null;
            }); },
            message: function () {
              return API.openThread(user.username).then(function (r) {
                window.location.href = "messages.html?thread=" + r.threadId;
              });
            }
          }).forEach(function (a) {
            button(a.label, a.kind === "cta" ? "btn-cta" : "", a.onClick);
          });

          button("Message", "", function () {
            return API.openThread(user.username).then(function (r) {
              window.location.href = "messages.html?thread=" + r.threadId;
            });
          });

          if (user.relation !== "blocked") {
            button("Block", "btn-flat", function () {
              if (!window.confirm("Block " + user.username + "?")) return Promise.resolve();
              return API.blockUser(user.username).then(after("Blocked"));
            });
          }

          button("Report", "btn-flat", function () {
            var reason = window.prompt("Why are you reporting " + user.username + "?");
            if (!reason || reason.trim().length < 4) return Promise.resolve();
            return API.report("user", user.username, reason.trim())
              .then(function () { UI.toast("Report sent"); });
          });
        }

        function after(message) {
          return function () { UI.toast(message); return load(); };
        }

        /* ---- activity ---- */
        var metrics = document.getElementById("metrics");
        if (res.user.activity) {
          var a = res.user.activity;
          metrics.hidden = false;
          document.getElementById("m-time").textContent = UI.formatDuration(a.totalSeconds);
          document.getElementById("m-games").textContent = a.gamesPlayed;
          document.getElementById("m-since").textContent =
            new Date(user.createdAt).toLocaleDateString(undefined, { month: "short", year: "numeric" });
          document.getElementById("m-seen").textContent =
            user.online ? "now" : UI.formatWhen(user.lastSeen);

          var games = a.recent.map(function (id) { return window.Catalog.byId(id); }).filter(Boolean);
          if (games.length) {
            document.getElementById("b-recent").hidden = false;
            UI.render(document.getElementById("g-recent"), games, { desc: false });
          }
        } else if (!mine) {
          document.getElementById("private").hidden = false;
        }
      }

      load();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

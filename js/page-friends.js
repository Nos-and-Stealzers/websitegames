/* Friends: search, requests in and out, the friend list and blocks. */
(function () {
  "use strict";

  function init() {
    window.SocialUI.gate(function () {
      var UI = window.UI;
      var S = window.SocialUI;
      var API = window.API;

      var handlers = {
        add: function (u) {
          return API.addFriend(u.username).then(function () {
            UI.toast("Request sent to " + u.username);
            return load();
          });
        },
        accept: function (u) {
          return API.acceptFriend(u.edgeId).then(function () {
            UI.toast("You're now friends with " + u.username);
            return load();
          });
        },
        remove: function (u) {
          return API.removeFriend(u.edgeId).then(function () { return load(); });
        },
        cancel: function (u) {
          return API.removeFriend(u.edgeId).then(function () {
            UI.toast("Request cancelled");
            return load();
          });
        },
        unblock: function (u) {
          return API.removeFriend(u.edgeId).then(function () {
            UI.toast("Unblocked " + u.username);
            return load();
          });
        },
        block: function (u) {
          if (!window.confirm("Block " + u.username + "? They won't be able to message you or see your profile.")) {
            return Promise.resolve();
          }
          return API.blockUser(u.username).then(function () {
            UI.toast("Blocked " + u.username);
            return load();
          });
        },
        /* Open it in the dock rather than navigating away — you can keep
           browsing, or keep playing, with the conversation alongside. */
        message: function (u) {
          if (window.ChatDock) return window.ChatDock.openWith(u.username);
          return API.openThread(u.username).then(function (res) {
            window.location.href = "messages.html?thread=" + res.threadId;
          });
        }
      };

      /* ---- your code ---- */
      var codeEl = document.getElementById("my-code");

      function showCode(code) { codeEl.textContent = code || "···-···"; }
      showCode(window.Session.user.friendCode);

      document.getElementById("copy-code").addEventListener("click", function () {
        var code = codeEl.textContent;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(code).then(
            function () { UI.toast("Code copied"); },
            function () { window.prompt("Your friend code:", code); }
          );
        } else {
          window.prompt("Your friend code:", code);
        }
      });

      document.getElementById("new-code").addEventListener("click", function () {
        if (!window.confirm("Get a new code? The old one stops working immediately.")) return;
        API.rotateCode().then(function (res) {
          showCode(res.friendCode);
          UI.toast("New code issued");
        }).catch(function (err) { UI.toast(err.message); });
      });

      /* ---- add someone: one box, username or code ---- */
      var findBox = document.getElementById("find");
      var results = document.getElementById("results");
      var hint = document.getElementById("find-hint");

      function looksLikeCode(v) {
        return /^[A-Za-z0-9]{3}[- ]?[A-Za-z0-9]{3}$/.test(v.trim());
      }

      function show(users) {
        results.innerHTML = "";
        users.forEach(function (u) {
          results.appendChild(S.person(u, { actions: S.relationActions(u, handlers) }));
        });
      }

      document.getElementById("add-form").addEventListener("submit", function (event) {
        event.preventDefault();
        var value = findBox.value.trim();
        if (!value) return;

        /* A code is exact, so resolve it and show who it belongs to before
           firing off a request — you should see who you're adding. */
        if (looksLikeCode(value)) {
          API.lookupCode(value).then(function (res) {
            hint.textContent = "Found @" + res.user.username + ".";
            show([Object.assign(res.user, { relation: res.relation })]);
          }).catch(function (err) {
            hint.textContent = err.message;
            results.innerHTML = "";
          });
          return;
        }

        handlers.add({ username: value.replace(/^@/, "") })
          .then(function () { findBox.value = ""; results.innerHTML = ""; })
          .catch(function (err) { hint.textContent = err.message; });
      });

      findBox.addEventListener("input", UI.debounce(function () {
        var q = findBox.value.trim();
        if (looksLikeCode(q)) {
          hint.textContent = "Looks like a friend code — press enter to look it up.";
          results.innerHTML = "";
          return;
        }
        if (q.length < 2) {
          results.innerHTML = "";
          hint.textContent = "Start typing to search, or paste a code like ABC-123 and hit enter.";
          return;
        }
        API.searchUsers(q).then(function (res) {
          hint.textContent = res.users.length
            ? res.users.length + " match" + (res.users.length === 1 ? "" : "es")
            : "Nobody by that name. If they gave you a code, paste it instead.";
          show(res.users);
        }).catch(function (err) { hint.textContent = err.message; });
      }, 220));

      /* ---- lists ---- */
      function load() {
        return API.friends().then(function (data) {
          var online = data.friends.filter(function (u) { return u.online; }).length;
          document.getElementById("r-friends").textContent = data.friends.length;
          document.getElementById("r-online").textContent = online;
          document.getElementById("r-in").textContent = data.incoming.length;
          document.getElementById("r-out").textContent = data.outgoing.length;

          document.getElementById("b-incoming").hidden = data.incoming.length === 0;
          S.renderPeople(document.getElementById("incoming"), data.incoming, function (u) {
            return S.person(u, {
              actions: [
                { label: "Accept", kind: "cta", onClick: function () { return handlers.accept(u); } },
                { label: "Decline", onClick: function () { return handlers.remove(u); } },
                { label: "Block", onClick: function () { return handlers.block(u); } }
              ]
            });
          });

          document.getElementById("b-outgoing").hidden = data.outgoing.length === 0;
          S.renderPeople(document.getElementById("outgoing"), data.outgoing, function (u) {
            return S.person(u, {
              note: "awaiting reply",
              actions: [{ label: "Cancel", onClick: function () { return handlers.cancel(u); } }]
            });
          });

          S.renderPeople(document.getElementById("friends"), data.friends, function (u) {
            return S.person(u, {
              actions: [
                { label: "Message", kind: "cta", onClick: function () { return handlers.message(u); } },
                { label: "Remove", onClick: function () { return handlers.remove(u); } }
              ]
            });
          }, {
            title: "No friends yet",
            body: "Search for someone above and send a request."
          });

          document.getElementById("b-blocked").hidden = data.blocked.length === 0;
          S.renderPeople(document.getElementById("blocked"), data.blocked, function (u) {
            return S.person(u, {
              presence: false,
              actions: [{ label: "Unblock", onClick: function () { return handlers.unblock(u); } }]
            });
          });

          window.Session.refreshBadges();
        });
      }

      load().catch(function (err) { UI.toast(err.message); });
      window.setInterval(load, 30000);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

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
        message: function (u) {
          return API.openThread(u.username).then(function (res) {
            window.location.href = "messages.html?thread=" + res.threadId;
          });
        }
      };

      /* ---- search ---- */
      var findBox = document.getElementById("find");
      var results = document.getElementById("results");
      var hint = document.getElementById("find-hint");

      findBox.addEventListener("input", UI.debounce(function () {
        var q = findBox.value.trim();
        if (q.length < 2) {
          results.innerHTML = "";
          hint.textContent = "Type at least two characters.";
          return;
        }
        API.searchUsers(q).then(function (res) {
          hint.textContent = res.users.length
            ? res.users.length + " match" + (res.users.length === 1 ? "" : "es")
            : "Nobody by that name.";
          results.innerHTML = "";
          res.users.forEach(function (u) {
            results.appendChild(S.person(u, { actions: S.relationActions(u, handlers) }));
          });
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

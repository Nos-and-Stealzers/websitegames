/* Direct messages: thread list on the left, conversation on the right.
   Polls for new messages while a thread is open. */
(function () {
  "use strict";

  var current = null;      // { id, with, canSend }
  var lastId = 0;
  var poll = null;

  function init() {
    window.SocialUI.gate(function () {
      var UI = window.UI;
      var S = window.SocialUI;
      var API = window.API;

      var listHost = document.getElementById("thread-list");
      var log = document.getElementById("log");
      var head = document.getElementById("dm-head");
      var compose = document.getElementById("compose");
      var bodyBox = document.getElementById("body");
      var sendBtn = document.getElementById("send");
      var locked = document.getElementById("locked");

      /* ---------------------------------------------------- thread list */

      function drawList(threads) {
        listHost.innerHTML = "";
        if (!threads.length) {
          var v = UI.el("div", "void");
          v.appendChild(UI.el("strong", null, "No conversations"));
          v.appendChild(UI.el("p", null, "Start one from Friends."));
          listHost.appendChild(v);
          return;
        }
        threads.forEach(function (t) {
          var b = UI.el("button", "dm-item");
          b.type = "button";
          if (current && current.id === t.id) b.classList.add("on");
          b.appendChild(S.avatar(t.with));

          var mid = UI.el("span", "dm-item-mid");
          var top = UI.el("span", "dm-item-top");
          top.textContent = t.with.displayName || t.with.username;
          mid.appendChild(top);
          var prev = UI.el("span", "dm-item-prev");
          prev.textContent = t.preview
            ? (t.preview.mine ? "You: " : "") + t.preview.body
            : "No messages yet";
          mid.appendChild(prev);
          b.appendChild(mid);

          var right = UI.el("span", "dm-item-right");
          right.appendChild(UI.el("span", "dm-when", UI.formatWhen(t.lastAt)));
          if (t.unread) right.appendChild(UI.el("span", "badge", String(t.unread)));
          b.appendChild(right);

          b.addEventListener("click", function () { open(t.id); });
          listHost.appendChild(b);
        });
      }

      function loadList() {
        return API.threads()
          .then(function (res) { drawList(res.threads); })
          .catch(function () { /* transient */ });
      }

      /* ------------------------------------------------------ one thread */

      function drawHead(user) {
        head.innerHTML = "";
        var link = UI.el("a", "dm-who");
        link.href = "profile.html?u=" + encodeURIComponent(user.username);
        link.appendChild(S.avatar(user));
        link.appendChild(S.nameBlock(user, { presence: true }));
        head.appendChild(link);

        var spacer = UI.el("span");
        spacer.style.flex = "1";
        head.appendChild(spacer);

        var report = UI.el("button", "btn btn-sm btn-flat", "Report");
        report.type = "button";
        report.addEventListener("click", function () {
          var reason = window.prompt("What's wrong with this conversation?");
          if (!reason || reason.trim().length < 4) return;
          API.report("user", user.username, reason.trim())
            .then(function () { UI.toast("Report sent to the moderators"); })
            .catch(function (err) { UI.toast(err.message); });
        });
        head.appendChild(report);
      }

      function appendMessages(messages) {
        messages.forEach(function (m) {
          var row = UI.el("div", "bubble-row" + (m.mine ? " mine" : ""));
          var bubble = UI.el("div", "bubble" + (m.deleted ? " gone" : ""));
          /* textContent, never innerHTML: message bodies are untrusted. */
          bubble.textContent = m.deleted ? "message removed" : m.body;
          row.appendChild(bubble);

          var meta = UI.el("span", "bubble-meta");
          meta.textContent = UI.formatWhen(m.at);
          if (m.mine && !m.deleted) {
            var x = UI.el("button", "bubble-x", "×");
            x.type = "button";
            x.title = "Delete this message";
            x.setAttribute("aria-label", "Delete this message");
            x.addEventListener("click", function () {
              API.deleteMessage(m.id).then(function () {
                bubble.classList.add("gone");
                bubble.textContent = "message removed";
                x.remove();
              }).catch(function (err) { UI.toast(err.message); });
            });
            meta.appendChild(x);
          }
          row.appendChild(meta);
          log.appendChild(row);
          if (m.id > lastId) lastId = m.id;
        });
      }

      function open(id) {
        window.clearInterval(poll);
        lastId = 0;
        log.innerHTML = "";
        document.getElementById("dm-empty").hidden = true;
        document.getElementById("dm-open").hidden = false;

        return API.thread(id).then(function (res) {
          current = { id: res.threadId, with: res.with, canSend: res.canSend };
          drawHead(res.with);
          appendMessages(res.messages);
          log.scrollTop = log.scrollHeight;

          locked.hidden = res.canSend;
          compose.hidden = !res.canSend;
          if (!res.canSend) locked.textContent = "You can't send messages in this conversation.";

          UI.setParams({ thread: res.threadId }, true);
          loadList();
          window.Session.refreshBadges();

          poll = window.setInterval(tick, 5000);
        }).catch(function (err) {
          UI.toast(err.message);
          document.getElementById("dm-open").hidden = true;
          document.getElementById("dm-empty").hidden = false;
        });
      }

      function tick() {
        if (!current) return;
        API.thread(current.id, lastId).then(function (res) {
          if (!res.messages.length) return;
          var atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
          appendMessages(res.messages);
          if (atBottom) log.scrollTop = log.scrollHeight;
          loadList();
          window.Session.refreshBadges();
        }).catch(function () { /* transient */ });
      }

      /* -------------------------------------------------------- sending */

      function submit(event) {
        if (event) event.preventDefault();
        var text = bodyBox.value.trim();
        if (!text || !current) return;

        sendBtn.disabled = true;
        API.send(current.id, text).then(function (res) {
          bodyBox.value = "";
          bodyBox.style.height = "auto";
          appendMessages([res.message]);
          log.scrollTop = log.scrollHeight;
          loadList();
        }).catch(function (err) {
          UI.toast(err.message);
        }).then(function () {
          sendBtn.disabled = false;
          bodyBox.focus();
        });
      }

      compose.addEventListener("submit", submit);

      /* Enter sends, Shift+Enter makes a new line. */
      bodyBox.addEventListener("keydown", function (event) {
        if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); }
      });
      bodyBox.addEventListener("input", function () {
        bodyBox.style.height = "auto";
        bodyBox.style.height = Math.min(bodyBox.scrollHeight, 160) + "px";
      });

      /* ----------------------------------------------------------- boot */

      loadList().then(function () {
        var wanted = UI.params().get("thread");
        var who = UI.params().get("u");
        if (wanted) return open(Number(wanted));
        if (who) {
          return API.openThread(who)
            .then(function (res) { return open(res.threadId); })
            .catch(function (err) { UI.toast(err.message); });
        }
      });

      window.setInterval(loadList, 20000);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

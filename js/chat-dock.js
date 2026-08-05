/* Floating chat, bottom-right, on every page — including while a game is
   running. Collapsed it's a single pill; open it's a conversation list; you
   can pop out one thread and keep playing.

   Deliberately lives outside the page's own DOM concerns: it mounts itself,
   polls on its own timer, and remembers its open/closed state per device. */
(function () {
  "use strict";

  var POLL_IDLE = 20000;     // just the thread list
  var POLL_LIVE = 5000;      // a conversation is open
  var KEY = "dock";

  var el, root, listPane, chatPane, badge, titleEl, logEl, inputEl;
  var open = false;
  var current = null;        // { id, title, isGroup }
  var lastId = 0;
  var timer = null;
  var pending = null;        // staged image awaiting send
  var threadsCache = [];

  /* ------------------------------------------------------------- state */

  function remembered() {
    try {
      return JSON.parse(window.localStorage.getItem("ach:" + KEY) || "{}") || {};
    } catch (err) { return {}; }
  }

  function remember(patch) {
    try {
      var next = Object.assign(remembered(), patch);
      window.localStorage.setItem("ach:" + KEY, JSON.stringify(next));
    } catch (err) { /* private mode */ }
  }

  /* -------------------------------------------------------------- build */

  function build() {
    el = window.UI.el;

    root = el("div", "dock");
    root.hidden = true;

    /* --- collapsed pill --- */
    var pill = el("button", "dock-pill");
    pill.type = "button";
    pill.setAttribute("aria-label", "Open chat");
    pill.appendChild(el("span", "dock-pill-icon", "✉"));
    pill.appendChild(el("span", "dock-pill-text", "Chat"));
    badge = el("span", "badge");
    badge.dataset.badge = "messages";
    badge.hidden = true;
    pill.appendChild(badge);
    pill.addEventListener("click", function () { setOpen(!open); });
    root.appendChild(pill);

    /* --- panel --- */
    var panel = el("div", "dock-panel");
    panel.hidden = true;

    var head = el("div", "dock-head");
    var back = el("button", "dock-back", "‹");
    back.type = "button";
    back.hidden = true;
    back.setAttribute("aria-label", "Back to conversations");
    back.addEventListener("click", function () { showList(); });
    head.appendChild(back);

    titleEl = el("span", "dock-title", "Chat");
    head.appendChild(titleEl);

    var expand = el("a", "dock-btn", "⤢");
    expand.title = "Open full messages page";
    expand.setAttribute("aria-label", "Open full messages page");
    expand.href = "messages.html";
    head.appendChild(expand);

    var shut = el("button", "dock-btn", "✕");
    shut.type = "button";
    shut.setAttribute("aria-label", "Close chat");
    shut.addEventListener("click", function () { setOpen(false); });
    head.appendChild(shut);
    panel.appendChild(head);

    listPane = el("div", "dock-list");
    panel.appendChild(listPane);

    chatPane = el("div", "dock-chat");
    chatPane.hidden = true;
    logEl = el("div", "dock-log");
    chatPane.appendChild(logEl);

    var form = el("form", "dock-compose");
    var tools = el("div", "dock-tools");
    [
      ["▣", "Share a screenshot", function () { return window.Capture.screenshot(); }],
      ["◉", "Take a photo", function () { return window.Capture.cameraDialog(); }],
      ["⊞", "Attach an image", function () { return window.Capture.fromFile(); }]
    ].forEach(function (spec) {
      var b = el("button", "dock-tool", spec[0]);
      b.type = "button";
      b.title = spec[1];
      b.setAttribute("aria-label", spec[1]);
      b.addEventListener("click", function () { stage(spec[2]); });
      tools.appendChild(b);
    });
    form.appendChild(tools);

    inputEl = document.createElement("textarea");
    inputEl.className = "dock-input";
    inputEl.rows = 1;
    inputEl.maxLength = 2000;
    inputEl.placeholder = "Message…";
    inputEl.setAttribute("aria-label", "Message");
    form.appendChild(inputEl);

    var send = el("button", "dock-send", "➤");
    send.type = "submit";
    send.setAttribute("aria-label", "Send");
    form.appendChild(send);

    form.addEventListener("submit", function (e) { e.preventDefault(); submit(); });
    inputEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
    });
    inputEl.addEventListener("input", function () {
      inputEl.style.height = "auto";
      inputEl.style.height = Math.min(inputEl.scrollHeight, 96) + "px";
    });

    chatPane.appendChild(form);
    panel.appendChild(chatPane);

    root.appendChild(panel);
    root.dataset.panel = "";
    document.body.appendChild(root);

    root._panel = panel;
    root._back = back;
    return root;
  }

  /* --------------------------------------------------------- open/close */

  function setOpen(next) {
    open = next;
    root._panel.hidden = !open;
    root.classList.toggle("is-open", open);
    remember({ open: open });
    if (open) {
      loadList();
      if (current) tick();
    }
    retime();
  }

  function showList() {
    current = null;
    lastId = 0;
    chatPane.hidden = true;
    listPane.hidden = false;
    root._back.hidden = true;
    titleEl.textContent = "Chat";
    remember({ thread: null });
    retime();
    loadList();
  }

  function retime() {
    window.clearInterval(timer);
    if (!window.Session || !window.Session.user) return;
    timer = window.setInterval(function () {
      if (current && open) tick();
      else if (open) loadList();
    }, current && open ? POLL_LIVE : POLL_IDLE);
  }

  /* -------------------------------------------------------------- list */

  function loadList() {
    if (!open) return Promise.resolve();
    return window.API.threads().then(function (res) {
      threadsCache = res.threads;
      drawList(res.threads);
    }).catch(function () { /* transient */ });
  }

  function drawList(threads) {
    listPane.innerHTML = "";

    var actions = el("div", "dock-actions");
    var newGroup = el("button", "btn btn-sm", "＋ New group");
    newGroup.type = "button";
    newGroup.addEventListener("click", function () { window.location.href = "messages.html?new=group"; });
    var friends = el("a", "btn btn-sm btn-flat", "Friends");
    friends.href = "friends.html";
    actions.appendChild(newGroup);
    actions.appendChild(friends);
    listPane.appendChild(actions);

    if (!threads.length) {
      var v = el("div", "dock-empty");
      v.appendChild(el("strong", null, "No conversations"));
      var p = el("p", null, "Add a friend, then start one.");
      v.appendChild(p);
      listPane.appendChild(v);
      return;
    }

    threads.forEach(function (t) {
      var row = el("button", "dock-row");
      row.type = "button";

      var pic = el("span", "dock-avatar");
      if (t.isGroup) {
        pic.classList.add("is-group");
        pic.textContent = "◍";
      } else if (t.with) {
        pic.appendChild(window.Art.avatar(t.with.username));
        if (t.with.online) pic.appendChild(el("i", "dot"));
      }
      row.appendChild(pic);

      var mid = el("span", "dock-row-mid");
      var top = el("span", "dock-row-name");
      top.textContent = t.title;
      mid.appendChild(top);
      var prev = el("span", "dock-row-prev");
      prev.textContent = t.preview
        ? (t.preview.mine ? "You: " : (t.isGroup ? t.preview.who + ": " : "")) + t.preview.body
        : "No messages yet";
      mid.appendChild(prev);
      row.appendChild(mid);

      if (t.unread) {
        var b = el("span", "badge");
        b.textContent = t.unread > 9 ? "9+" : String(t.unread);
        row.appendChild(b);
      }

      row.addEventListener("click", function () { openThread(t); });
      listPane.appendChild(row);
    });
  }

  /* ------------------------------------------------------------ thread */

  function openThread(t) {
    current = { id: t.id, title: t.title, isGroup: t.isGroup };
    lastId = 0;
    logEl.innerHTML = "";
    listPane.hidden = true;
    chatPane.hidden = false;
    root._back.hidden = false;
    titleEl.textContent = t.title;
    remember({ thread: t.id, open: true });
    retime();
    return tick(true);
  }

  function tick(first) {
    if (!current) return Promise.resolve();
    return window.API.thread(current.id, lastId).then(function (res) {
      if (!res.messages.length && !first) return;
      var atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 60;
      res.messages.forEach(addBubble);
      if (first || atBottom) logEl.scrollTop = logEl.scrollHeight;
      if (res.messages.length) { loadList(); window.Session.refreshBadges(); }
    }).catch(function (err) {
      if (err && err.status === 404) showList();
    });
  }

  function addBubble(m) {
    if (m.id <= lastId) return;
    lastId = Math.max(lastId, m.id);

    var row = el("div", "dock-bubble-row" + (m.mine ? " mine" : ""));

    if (!m.mine && current && current.isGroup) {
      var who = el("span", "dock-who");
      who.textContent = m.from ? (m.from.displayName || m.from.username) : "";
      row.appendChild(who);
    }

    var bubble = el("div", "dock-bubble" + (m.deleted ? " gone" : ""));
    if (m.image) {
      var img = document.createElement("img");
      img.className = "dock-img";
      img.src = m.image.url;
      img.alt = m.image.kind === "screenshot" ? "Shared screenshot" : "Shared image";
      img.loading = "lazy";
      bubble.appendChild(img);
    }
    if (m.deleted) {
      bubble.appendChild(document.createTextNode("message removed"));
    } else if (m.body) {
      var text = el("span", "dock-text");
      text.textContent = m.body;        // untrusted
      bubble.appendChild(text);
    }
    row.appendChild(bubble);
    logEl.appendChild(row);
  }

  /* ------------------------------------------------------------ sending */

  function stage(grab) {
    grab()
      .then(function (shot) {
        pending = shot;
        showPending();
      })
      .catch(function (err) {
        if (err && /cancel|Permission|denied|abort/i.test(err.message || "")) return;
        window.UI.toast(err.message || "Capture failed");
      });
  }

  function showPending() {
    var old = chatPane.querySelector(".dock-pending");
    if (old) old.remove();
    if (!pending) return;

    var wrap = el("div", "dock-pending");
    var img = document.createElement("img");
    img.src = pending.dataUrl;
    img.alt = "Attachment preview";
    wrap.appendChild(img);

    var drop = el("button", "dock-pending-x", "✕");
    drop.type = "button";
    drop.setAttribute("aria-label", "Remove attachment");
    drop.addEventListener("click", function () { pending = null; showPending(); });
    wrap.appendChild(drop);

    chatPane.insertBefore(wrap, chatPane.lastElementChild);
  }

  function submit() {
    var text = inputEl.value.trim();
    if ((!text && !pending) || !current) return;

    var image = pending;
    inputEl.value = "";
    inputEl.style.height = "auto";
    pending = null;
    showPending();

    window.API.send(current.id, text, image).then(function (res) {
      addBubble(res.message);
      logEl.scrollTop = logEl.scrollHeight;
      loadList();
    }).catch(function (err) {
      window.UI.toast(err.message || "Could not send");
      inputEl.value = text;         // give it back rather than losing it
      pending = image;
      showPending();
    });
  }

  /* --------------------------------------------------------------- boot */

  function mount() {
    if (!window.Session || !window.API || !window.UI) return;

    window.Session.ready.then(function (state) {
      if (!state.backend || !state.user) return;

      build();
      root.hidden = false;

      var saved = remembered();
      if (saved.open) {
        setOpen(true);
        if (saved.thread) {
          window.API.threads().then(function (res) {
            var t = res.threads.filter(function (x) { return x.id === saved.thread; })[0];
            if (t) openThread(t); else drawList(res.threads);
          }).catch(function () {});
        }
      } else {
        retime();
      }

      document.addEventListener("session:badges", function (e) {
        var n = (e.detail && e.detail.messages) || 0;
        badge.textContent = n > 99 ? "99+" : String(n);
        badge.hidden = n === 0;
        /* A message arriving while the dock is shut should still surface. */
        if (n && !open) root.classList.add("has-unread");
        else root.classList.remove("has-unread");
      });
    });
  }

  window.ChatDock = {
    openWith: function (username) {
      return window.API.openThread(username).then(function (res) {
        if (!root) return null;
        setOpen(true);
        return loadList().then(function () {
          var t = threadsCache.filter(function (x) { return x.id === res.threadId; })[0];
          return openThread(t || { id: res.threadId, title: username, isGroup: false });
        });
      });
    },
    close: function () { if (root) setOpen(false); }
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();

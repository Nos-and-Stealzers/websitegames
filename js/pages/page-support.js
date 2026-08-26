/* Support tickets — the user's side.
   A list of your tickets on the left, and on the right either the form for a
   new one or the conversation for the one you picked. */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var el, current = null, poll = null;

  var LABELS = {
    account: "Account", saves: "Saves", game: "Game",
    safety: "Safety", billing: "Billing", other: "Other"
  };

  function boot() {
    el = window.UI.el;

    window.Session.ready.then(function (s) {
      if (!s.backend) { $("offline").hidden = false; return; }
      if (!s.user) { $("gate").hidden = false; return; }

      $("app").hidden = false;
      wire();
      load().then(openFromHash);
    });
  }

  function wire() {
    var body = $("body"), count = $("count");
    body.addEventListener("input", function () { count.textContent = String(body.value.length); });

    $("new-ticket").addEventListener("click", showForm);
    $("form").addEventListener("submit", submit);
    $("reply-form").addEventListener("submit", reply);
    $("close-ticket").addEventListener("click", closeTicket);
    window.addEventListener("hashchange", openFromHash);
  }

  /* -------------------------------------------------------------- list */

  function load() {
    return window.API.myTickets().then(function (res) {
      draw(res.tickets || []);
      return res.tickets || [];
    }).catch(function (err) {
      window.UI.toast(err.message || "Could not load your tickets.");
      return [];
    });
  }

  var lastList = [];

  function draw(tickets) {
    lastList = tickets;
    var list = $("list");
    list.innerHTML = "";

    if (!tickets.length) {
      var v = el("div", "empty");
      v.style.padding = "1.2rem";
      v.appendChild(el("strong", null, "No tickets yet"));
      v.appendChild(el("p", "dim tiny", "Open one and someone will get back to you."));
      list.appendChild(v);
      return;
    }

    tickets.forEach(function (t) {
      var row = el("button", "ticket-row");
      row.type = "button";
      if (current && current.id === t.id) row.classList.add("is-on");

      var mid = el("div", "mid");
      mid.appendChild(el("span", "subject", t.subject));
      mid.appendChild(el("span", "meta",
        LABELS[t.category] + " · " + t.replies + " message" + (t.replies === 1 ? "" : "s") +
        " · " + window.UI.formatWhen(t.updatedAt)));
      row.appendChild(mid);

      var tag = el("span", "state-tag", t.state === "waiting" ? "reply" : t.state);
      tag.dataset.s = t.state;
      row.appendChild(tag);

      row.addEventListener("click", function () { window.location.hash = "t" + t.id; });
      list.appendChild(row);
    });
  }

  /* ------------------------------------------------------------- detail */

  function openFromHash() {
    var m = /^#t(\d+)$/.exec(window.location.hash || "");
    if (!m) return showForm();
    open(Number(m[1]));
  }

  function showForm() {
    current = null;
    window.clearInterval(poll);
    if (window.location.hash) window.location.hash = "";
    $("detail").hidden = true;
    $("form").hidden = false;
    $("detail-head").textContent = "Open a ticket";
    draw(lastList);
  }

  function open(id) {
    return window.API.ticket(id).then(function (res) {
      current = res.ticket;
      $("form").hidden = true;
      $("detail").hidden = false;
      $("detail-head").textContent = res.ticket.subject;
      drawThread(res.messages);

      /* A closed ticket is read-only for the person who opened it. */
      var closed = res.ticket.state === "closed";
      $("reply").disabled = closed;
      $("reply").placeholder = closed ? "This ticket is closed." : "Reply…";
      $("close-ticket").hidden = closed;

      window.clearInterval(poll);
      if (!closed) poll = window.setInterval(refreshThread, 15000);
      load();
    }).catch(function (err) {
      window.UI.toast(err.message || "Could not open that ticket.");
      showForm();
    });
  }

  function refreshThread() {
    if (!current) return;
    window.API.ticket(current.id).then(function (res) {
      drawThread(res.messages);
    }).catch(function () { /* transient */ });
  }

  function drawThread(messages) {
    var box = $("thread");
    var atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    box.innerHTML = "";

    messages.forEach(function (m) {
      var wrap = el("div", "tmsg" + (m.staff ? " is-staff" : ""));
      wrap.appendChild(el("span", "who",
        (m.staff ? "Support · " : "") + m.author + " · " + window.UI.formatWhen(m.at)));
      var body = el("div", "body");
      body.textContent = m.body;           // untrusted
      wrap.appendChild(body);
      box.appendChild(wrap);
    });

    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  /* ------------------------------------------------------------ actions */

  function submit(e) {
    e.preventDefault();
    var err = $("error");
    err.hidden = true;

    var payload = {
      category: $("category").value,
      subject: $("subject").value.trim(),
      body: $("body").value.trim()
    };

    $("submit").disabled = true;
    window.API.openTicket(payload).then(function (res) {
      $("subject").value = "";
      $("body").value = "";
      $("count").textContent = "0";
      return load().then(function () { window.location.hash = "t" + res.id; });
    }).catch(function (e2) {
      err.textContent = e2.message || "Could not open that ticket.";
      err.hidden = false;
    }).then(function () { $("submit").disabled = false; });
  }

  function reply(e) {
    e.preventDefault();
    var box = $("reply");
    var text = box.value.trim();
    if (!text || !current) return;

    box.value = "";
    window.API.replyTicket(current.id, text).then(function () {
      return refreshThread();
    }).catch(function (err) {
      window.UI.toast(err.message || "Could not send that.");
      box.value = text;                    // hand it back rather than lose it
    });
  }

  function closeTicket() {
    if (!current) return;
    if (!window.confirm("Close this ticket? Staff can reopen it if it isn't actually done.")) return;

    var id = current.id;
    window.API.updateTicket(id, { state: "closed" })
      .then(function () { return open(id); })
      .catch(function (err) { window.UI.toast(err.message || "Could not close it."); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

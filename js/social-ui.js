/* Shared people-rendering used by friends, profile, messages and admin.
   Every value that came from another user goes in via textContent — never
   innerHTML — so a display name or bio can't inject markup. */
(function () {
  "use strict";

  var el = window.UI.el;

  function avatar(user, size) {
    var wrap = el("span", "avatar" + (size ? " avatar-" + size : ""));
    wrap.appendChild(window.Art.avatar(user.username));
    if (user.online) wrap.appendChild(el("i", "dot"));
    return wrap;
  }

  function nameBlock(user, opts) {
    opts = opts || {};
    var box = el("span", "names");
    var line = el("span", "n1");
    line.textContent = user.displayName || user.username;
    if (user.role && user.role !== "user") {
      line.appendChild(el("span", "role", user.role));
    }
    box.appendChild(line);

    var sub = el("span", "n2");
    sub.textContent = "@" + user.username;
    if (opts.presence) {
      sub.textContent += " · " + (user.online ? "online" : window.UI.formatWhen(user.lastSeen));
    }
    box.appendChild(sub);
    return box;
  }

  /* A single person row. `actions` is an array of {label, kind, onClick}. */
  function person(user, opts) {
    opts = opts || {};
    var row = el("div", "person");
    row.dataset.username = user.username;

    var link = el("a", "person-main");
    link.href = "profile.html?u=" + encodeURIComponent(user.username);
    link.appendChild(avatar(user));
    link.appendChild(nameBlock(user, { presence: opts.presence !== false }));
    row.appendChild(link);

    if (opts.note) {
      var note = el("span", "person-note");
      note.textContent = opts.note;
      row.appendChild(note);
    }

    if (opts.actions && opts.actions.length) {
      var acts = el("div", "person-acts");
      opts.actions.forEach(function (action) {
        if (!action) return;
        var b = el("button", "btn btn-sm" + (action.kind === "cta" ? " btn-cta" : ""));
        b.type = "button";
        b.textContent = action.label;
        b.addEventListener("click", function (event) {
          event.preventDefault();
          b.disabled = true;
          Promise.resolve(action.onClick())
            .catch(function (err) { window.UI.toast(err.message || "That didn't work"); })
            .then(function () { b.disabled = false; });
        });
        acts.appendChild(b);
      });
      row.appendChild(acts);
    }
    return row;
  }

  function renderPeople(host, users, build, empty) {
    if (!host) return 0;
    host.innerHTML = "";
    if (!users.length) {
      var v = el("div", "void");
      v.appendChild(el("strong", null, (empty && empty.title) || "Nobody here"));
      v.appendChild(el("p", null, (empty && empty.body) || ""));
      host.appendChild(v);
      return 0;
    }
    users.forEach(function (u) { host.appendChild(build(u)); });
    return users.length;
  }

  /* Turns a relation string into the buttons that make sense for it. */
  function relationActions(user, handlers) {
    switch (user.relation) {
      case "friends":
        return [
          { label: "Message", kind: "cta", onClick: function () { return handlers.message(user); } },
          { label: "Remove", onClick: function () { return handlers.remove(user); } }
        ];
      case "pending-out":
        return [{ label: "Requested", onClick: function () { return handlers.cancel(user); } }];
      case "pending-in":
        return [
          { label: "Accept", kind: "cta", onClick: function () { return handlers.accept(user); } },
          { label: "Decline", onClick: function () { return handlers.remove(user); } }
        ];
      case "blocked":
        return [{ label: "Unblock", onClick: function () { return handlers.unblock(user); } }];
      case "self":
        return [];
      default:
        return [
          { label: "Add friend", kind: "cta", onClick: function () { return handlers.add(user); } }
        ];
    }
  }

  /* Guard used by every account-only page. */
  function gate(onReady) {
    window.Session.ready.then(function (state) {
      if (!state.backend) {
        var main = document.getElementById("main");
        main.innerHTML = "";
        var box = el("div", "panel");
        box.style.marginTop = "2rem";
        box.appendChild(el("strong", null, "The hub's server isn't running"));
        var p = el("p", "dim");
        p.style.margin = "0.4rem 0 0";
        p.textContent = "Accounts, friends and messages need the backend. Browsing and playing don't.";
        box.appendChild(p);
        var a = el("a", "btn btn-cta", "Back to the arcade");
        a.href = "index.html";
        a.style.marginTop = "0.9rem";
        box.appendChild(a);
        main.appendChild(box);
        return;
      }
      if (!state.user) {
        var back = window.location.pathname.split("/").pop() + window.location.search;
        window.location.replace("login.html?next=" + encodeURIComponent(back));
        return;
      }
      onReady(state.user);
    });
  }

  window.SocialUI = {
    avatar: avatar,
    nameBlock: nameBlock,
    person: person,
    renderPeople: renderPeople,
    relationActions: relationActions,
    gate: gate
  };
})();

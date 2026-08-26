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

  /* Turns a relation string into the buttons that make sense for it.
     `handlers` may leave any of these out; a missing one drops its button
     rather than wiring up something that throws when clicked. */
  function relationActions(user, handlers) {
    function act(label, name, kind) {
      if (typeof handlers[name] !== "function") return null;
      return {
        label: label, kind: kind,
        onClick: function () { return handlers[name](user); }
      };
    }

    var list;
    switch (user.relation) {
      case "friends":
        list = [act("Message", "message", "cta"), act("Remove", "remove")];
        break;
      case "pending-out":
        list = [act("Requested", "cancel")];
        break;
      case "pending-in":
        list = [act("Accept", "accept", "cta"), act("Decline", "remove")];
        break;
      case "blocked":
        list = [act("Unblock", "unblock")];
        break;
      /* They blocked you. There is nothing to offer, and the old code fell
         through to "Add friend" — a button whose only possible outcome was
         an error, which also told them they had been blocked. */
      case "blocked-by":
      case "self":
        list = [];
        break;
      default:
        list = [act("Add friend", "add", "cta")];
    }
    return list.filter(Boolean);
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
      /* A suspension is enforced in the database, so a suspended account
         reaching one of these pages would just watch every action fail with
         no explanation. Say what happened instead. */
      if (state.user.state === "suspended") {
        var main2 = document.getElementById("main");
        main2.innerHTML = "";
        var panel = el("div", "panel");
        panel.style.marginTop = "2rem";
        panel.appendChild(el("strong", null, "This account is suspended"));
        var line = el("p", "dim");
        line.style.margin = "0.4rem 0 0";
        line.textContent = "Friends, messages and calls are switched off while a " +
          "suspension is in place. Playing still works, and you can appeal through support.";
        panel.appendChild(line);
        var row = el("div", "btn-row");
        row.style.marginTop = "0.9rem";
        var help = el("a", "btn btn-cta", "Contact support");
        help.href = "support.html";
        row.appendChild(help);
        var home = el("a", "btn btn-flat", "Back to the arcade");
        home.href = "index.html";
        row.appendChild(home);
        panel.appendChild(row);
        main2.appendChild(panel);
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

/* Settings. The display half works with no account and no backend; the account
   half appears only once you're signed in. */
(function () {
  "use strict";

  /* ------------------------------------------------------------- display */

  function displaySection() {
    var UI = window.UI;
    var Store = window.Store;
    var s = Store.settings();

    var skins = document.getElementById("skins");
    window.SITE.skins.forEach(function (skin) {
      var b = UI.el("button", "skin");
      b.type = "button";
      b.title = skin.label;
      b.setAttribute("aria-label", skin.label + " skin");
      b.setAttribute("aria-pressed", s.skin === skin.id ? "true" : "false");
      skin.chips.forEach(function (c) {
        var i = UI.el("i");
        i.style.background = c;
        b.appendChild(i);
      });
      b.addEventListener("click", function () {
        Store.setSetting("skin", skin.id);
        document.documentElement.setAttribute("data-skin", skin.id);
        skins.querySelectorAll(".skin").forEach(function (n) {
          n.setAttribute("aria-pressed", n === b ? "true" : "false");
        });
        UI.toast("Skin · " + skin.label);
      });
      skins.appendChild(b);
    });

    function bindToggle(id, key, onChange) {
      var box = document.getElementById(id);
      box.checked = !!s[key];
      box.addEventListener("change", function () {
        Store.setSetting(key, box.checked);
        if (onChange) onChange(box.checked);
      });
    }

    bindToggle("lite", "lite", function (on) {
      document.documentElement.setAttribute("data-lite", on ? "on" : "off");
    });
    bindToggle("autofull", "autoFullscreen");
    bindToggle("confirm-ext", "confirmExternal");

    var grid = document.getElementById("view-grid");
    var list = document.getElementById("view-list");
    function paintView() {
      var view = Store.settings().view;
      grid.setAttribute("aria-pressed", view === "grid" ? "true" : "false");
      list.setAttribute("aria-pressed", view === "list" ? "true" : "false");
    }
    grid.addEventListener("click", function () { Store.setSetting("view", "grid"); paintView(); });
    list.addEventListener("click", function () { Store.setSetting("view", "list"); paintView(); });
    paintView();
  }

  /* ---------------------------------------------------------- local data */

  function dataSection(user) {
    var UI = window.UI;
    var note = document.getElementById("data-note");
    var syncState = document.getElementById("sync-state");
    var syncBtn = document.getElementById("sync-now");

    note.textContent = user
      ? "Your pins, history and playtime sync to the hub while you're signed in. You can still keep an offline copy."
      : "Everything is stored in this browser only. Export a copy if you want it somewhere safe.";

    if (user) {
      syncBtn.hidden = false;
      syncBtn.addEventListener("click", function () {
        window.Session.pushSave().then(function (save) {
          if (save) { UI.toast("Synced"); showSync(Date.now()); }
          else UI.toast("Could not reach the server");
        });
      });

      window.API.getSave().then(function (res) {
        if (res.updatedAt) showSync(res.updatedAt);
      }).catch(function () { /* non-critical */ });

      document.addEventListener("session:synced", function (e) { showSync(e.detail.at); });
    }

    function showSync(at) {
      syncState.textContent = "Last synced " + (at ? UI.formatWhen(at) : "just now") + ".";
    }

    document.getElementById("export").addEventListener("click", function () {
      var blob = new Blob([JSON.stringify(window.Store.exportAll(), null, 2)],
        { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "arcade-hub-" + (user ? user.username + "-" : "") +
        new Date().toISOString().slice(0, 10) + ".json";
      a.click();
      URL.revokeObjectURL(a.href);
      UI.toast("Save exported");
    });

    document.getElementById("import").addEventListener("click", function () {
      var input = document.createElement("input");
      input.type = "file";
      input.accept = "application/json,.json";
      input.addEventListener("change", function () {
        var file = input.files && input.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
          try {
            window.Store.importAll(JSON.parse(String(reader.result)));
            if (user) {
              window.Session.pushSave().then(function () { UI.toast("Imported and synced"); });
            } else {
              UI.toast("Save imported");
            }
            window.setTimeout(function () { window.location.reload(); }, 700);
          } catch (err) { UI.toast("Could not read that file"); }
        };
        reader.readAsText(file);
      });
      input.click();
    });

    document.getElementById("wipe-local").addEventListener("click", function () {
      if (!window.confirm("Erase pins, history and playtime stored in this browser?" +
          (user ? " Your synced copy on the server is kept." : ""))) return;
      window.Store.resetAll();
      window.location.reload();
    });
  }

  /* ------------------------------------------------------------- account */

  function accountSection(user) {
    var UI = window.UI;
    var API = window.API;

    document.getElementById("account-area").hidden = false;
    document.getElementById("r-user").textContent = "@" + user.username;
    document.getElementById("r-role").textContent = user.role;
    document.getElementById("r-since").textContent =
      new Date(user.createdAt).toLocaleDateString(undefined, { month: "short", year: "numeric" });

    /* ---- profile ---- */
    var display = document.getElementById("display");
    var bio = document.getElementById("bio");
    var bioCount = document.getElementById("bio-count");

    display.value = user.displayName || "";
    bio.value = user.bio || "";
    bioCount.textContent = bio.value.length;
    bio.addEventListener("input", function () { bioCount.textContent = bio.value.length; });

    document.getElementById("profile-form").addEventListener("submit", function (event) {
      event.preventDefault();
      API.updateProfile({ displayName: display.value.trim(), bio: bio.value.trim() })
        .then(function (res) { window.Session.setUser(res.user); UI.toast("Profile saved"); })
        .catch(function (err) { UI.toast(err.message); });
    });

    /* ---- privacy ---- */
    var privacy = document.getElementById("privacy");

    function toggleRow(key, title, hint, value) {
      var row = UI.el("div", "opt");
      var text = UI.el("div");
      text.appendChild(UI.el("div", "k", title));
      text.appendChild(UI.el("div", "d", hint));
      row.appendChild(text);

      var wrap = UI.el("label", "toggle");
      var input = UI.el("input");
      input.type = "checkbox";
      input.checked = !!value;
      input.addEventListener("change", function () {
        var patch = {};
        patch[key] = input.checked;
        API.updateProfile(patch)
          .then(function (res) { window.Session.setUser(res.user); UI.toast("Saved"); })
          .catch(function (err) { input.checked = !input.checked; UI.toast(err.message); });
      });
      wrap.appendChild(input);
      wrap.appendChild(UI.el("i"));
      row.appendChild(wrap);
      privacy.appendChild(row);
    }

    toggleRow("acceptsDms", "Accept messages from anyone",
      "Off means only friends can start a conversation with you.", user.acceptsDms);
    toggleRow("showActivity", "Share activity with friends",
      "Your playtime and recent titles on your profile, friends only.", user.showActivity);

    /* ---- password ---- */
    var pwError = document.getElementById("pw-error");
    document.getElementById("password-form").addEventListener("submit", function (event) {
      event.preventDefault();
      pwError.hidden = true;

      var current = document.getElementById("current").value;
      var next = document.getElementById("next").value;
      var next2 = document.getElementById("next2").value;

      if (next !== next2) {
        pwError.textContent = "The new passwords don't match.";
        pwError.hidden = false;
        return;
      }

      API.changePassword(current, next)
        .then(function () {
          UI.toast("Password changed — other devices signed out");
          event.target.reset();
          loadSessions();
        })
        .catch(function (err) {
          pwError.textContent = err.message;
          pwError.hidden = false;
        });
    });

    /* ---- sessions ---- */
    function loadSessions() {
      API.sessions().then(function (res) {
        var host = document.getElementById("sessions");
        host.innerHTML = "";
        res.sessions.forEach(function (s, i) {
          var row = UI.el("div", "row");
          row.style.gridTemplateColumns = "3rem 1fr auto";
          row.appendChild(UI.el("span", "idx", UI.pad(i + 1)));

          var mid = UI.el("span", "name");
          mid.textContent = (s.agent || "Unknown device").slice(0, 70);
          if (s.current) mid.appendChild(UI.el("span", "role", "this device"));
          row.appendChild(mid);

          row.appendChild(UI.el("span", "plays", "started " + UI.formatWhen(s.createdAt)));
          host.appendChild(row);
        });
      }).catch(function () { /* non-critical */ });
    }
    loadSessions();

    document.getElementById("signout-all").addEventListener("click", function () {
      if (!window.confirm("Sign out of every other device?")) return;
      API.signOutEverywhere()
        .then(function () { UI.toast("Other devices signed out"); loadSessions(); })
        .catch(function (err) { UI.toast(err.message); });
    });

    /* ---- delete ---- */
    var delError = document.getElementById("del-error");
    document.getElementById("delete-form").addEventListener("submit", function (event) {
      event.preventDefault();
      delError.hidden = true;

      var typed = document.getElementById("confirm-name").value.trim();
      if (typed !== user.username) {
        delError.textContent = "That doesn't match your username.";
        delError.hidden = false;
        return;
      }
      if (!window.confirm("Permanently delete @" + user.username + "? This cannot be undone.")) return;

      API.deleteAccount(typed)
        .then(function () {
          window.Session.setUser(null);
          window.location.href = "index.html";
        })
        .catch(function (err) {
          delError.textContent = err.message;
          delError.hidden = false;
        });
    });
  }

  /* ---------------------------------------------------------------- boot */

  function init() {
    /* Display preferences must not wait on — or require — the backend. */
    displaySection();

    window.Session.ready.then(function (state) {
      if (!state.backend) {
        document.getElementById("no-backend").hidden = false;
        dataSection(null);
        return;
      }
      if (!state.user) {
        document.getElementById("signed-out").hidden = false;
        dataSection(null);
        return;
      }
      dataSection(state.user);
      accountSection(state.user);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

/* Settings. The display half works with no account and no backend; the account
   half appears only once you're signed in. */
(function () {
  "use strict";

  /* ------------------------------------------------------------- display */

  function displaySection() {
    var UI = window.UI;
    var Store = window.Store;
    var s = Store.settings();

    /* A gallery of real previews rather than two colour chips — each card is
       painted with that skin's own tokens, so you see what you're choosing. */
    var skins = document.getElementById("skins");
    window.SITE.skins.forEach(function (skin) {
      var card = UI.el("button", "skin-card");
      card.type = "button";
      card.dataset.skin = skin.id;
      card.setAttribute("aria-pressed", s.skin === skin.id ? "true" : "false");
      card.setAttribute("aria-label", skin.label + " skin");

      var preview = UI.el("span", "skin-preview");
      preview.style.background = skin.chips[0];
      var bar = UI.el("span", "skin-bar");
      bar.style.background = skin.chips[1];
      preview.appendChild(bar);
      ["68%", "45%", "80%"].forEach(function (w) {
        var line = UI.el("span", "skin-line");
        line.style.width = w;
        line.style.background = skin.chips[1];
        line.style.opacity = "0.35";
        preview.appendChild(line);
      });
      card.appendChild(preview);

      var foot = UI.el("span", "skin-foot");
      foot.appendChild(UI.el("span", "skin-name", skin.label));
      foot.appendChild(UI.el("span", "skin-mode", skin.dark ? "dark" : "light"));
      card.appendChild(foot);

      function apply() {
        Store.setSetting("skin", skin.id);
        document.documentElement.setAttribute("data-skin", skin.id);
        skins.querySelectorAll(".skin-card").forEach(function (n) {
          n.setAttribute("aria-pressed", n === card ? "true" : "false");
        });
      }

      /* Hovering previews it live; leaving puts your real choice back. */
      card.addEventListener("mouseenter", function () {
        document.documentElement.setAttribute("data-skin", skin.id);
      });
      card.addEventListener("mouseleave", function () {
        document.documentElement.setAttribute("data-skin", Store.settings().skin);
      });
      card.addEventListener("focus", function () {
        document.documentElement.setAttribute("data-skin", skin.id);
      });
      card.addEventListener("blur", function () {
        document.documentElement.setAttribute("data-skin", Store.settings().skin);
      });
      card.addEventListener("click", function () {
        apply();
        UI.toast("Skin · " + skin.label);
      });

      skins.appendChild(card);
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
    bindToggle("motion", "motion", function (on) {
      document.documentElement.setAttribute("data-motion", on ? "on" : "off");
    });
    bindToggle("autofull", "autoFullscreen");
    bindToggle("confirm-ext", "confirmExternal");

    /* Behaviour switches. The dock and shortcuts ones only take effect on the
       next page load, so say so rather than leaving people wondering. */
    bindToggle("shortcuts", "shortcuts");
    bindToggle("dock", "dock", function () {
      UI.toast("Applies on the next page you open");
    });
    bindToggle("autobackup", "autoBackup");
    bindToggle("hide-gone", "hideUnavailable");

    var sortPick = document.getElementById("default-sort");
    if (sortPick) {
      sortPick.value = s.sort;
      sortPick.addEventListener("change", function () {
        Store.setSetting("sort", sortPick.value);
        UI.toast("Default sort saved");
      });
    }

    /* Text size */
    var textButtons = document.querySelectorAll("[data-textsize]");
    function paintText() {
      var now = Store.settings().textSize;
      textButtons.forEach(function (b) {
        b.setAttribute("aria-pressed", b.dataset.textsize === now ? "true" : "false");
      });
    }
    textButtons.forEach(function (b) {
      b.addEventListener("click", function () {
        Store.setSetting("textSize", b.dataset.textsize);
        document.documentElement.setAttribute("data-text", b.dataset.textsize);
        paintText();
      });
    });
    paintText();

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

  /* -------------------------------------------------- third-party saves */

  function gameProgressSection() {
    if (!window.GameSaves) return;
    var UI = window.UI;
    var section = document.getElementById("game-progress");
    var state = document.getElementById("gs-state");
    var list = document.getElementById("gs-list");
    section.hidden = false;

    function say(text) { state.textContent = text; }

    function draw() {
      window.API.listGameSaves().then(function (res) {
        list.innerHTML = "";
        if (!res.hosts.length) {
          say("Nothing backed up yet.");
          return;
        }
        res.hosts.forEach(function (h, i) {
          var row = UI.el("div", "row");
          row.style.gridTemplateColumns = "3rem 1fr auto auto";
          row.appendChild(UI.el("span", "idx", UI.pad(i + 1)));

          var name = UI.el("span", "name");
          name.textContent = h.host;
          row.appendChild(name);

          row.appendChild(UI.el("span", "plays",
            h.keys + " keys · " + Math.max(1, Math.round(h.bytes / 1024)) + " KB"));

          var drop = UI.el("button", "btn btn-sm btn-flat", "Forget");
          drop.type = "button";
          drop.addEventListener("click", function () {
            if (!window.confirm("Delete the backed-up progress for " + h.host + "?")) return;
            window.API.dropGameSave(h.host)
              .then(function () { UI.toast("Removed"); draw(); })
              .catch(function (err) { UI.toast(err.message); });
          });
          row.appendChild(drop);
          list.appendChild(row);
        });
        say("Last backed up " + UI.formatWhen(
          Math.max.apply(null, res.hosts.map(function (h) { return h.updatedAt; }))) + ".");
      }).catch(function () { say("Could not read your backups."); });
    }

    function report(results) {
      var ok = results.filter(function (r) { return !r.error; });
      var bad = results.filter(function (r) { return r.error; });
      var parts = [];
      ok.forEach(function (r) {
        if (r.keys !== undefined) parts.push(r.host + ": " + r.keys + " keys");
        else if (r.written !== undefined) parts.push(r.host + ": " + r.written + " restored" +
          (r.kept ? ", " + r.kept + " kept" : ""));
      });
      bad.forEach(function (r) { parts.push(r.host + ": " + r.error); });
      say(parts.join(" · ") || "Nothing to do.");
    }

    function run(label, fn) {
      say(label + "…");
      return fn().then(function (results) {
        report(results);
        draw();
      }).catch(function (err) { say(err.message); });
    }

    document.getElementById("gs-backup").addEventListener("click", function () {
      run("Reading game storage", function () {
        return window.GameSaves.backup(function (host, phase) { say(phase + " " + host + "…"); });
      });
    });

    document.getElementById("gs-restore").addEventListener("click", function () {
      run("Restoring", function () { return window.GameSaves.restore(false); });
    });

    document.getElementById("gs-force").addEventListener("click", function () {
      if (!window.confirm(
        "Overwrite this device's game progress with the backed-up copy? " +
        "Anything newer here is lost.")) return;
      run("Overwriting", function () { return window.GameSaves.restore(true); });
    });

    draw();
  }

  /* ---------------------------------------------------------------- boot */

  /* ------------------------------------------------------------- staff */

  /* Admin and above only. A moderator can reach the console, but changing how
     it opens is an owner/admin concern and there is no point showing everyone
     else a control that would do nothing for them.

     This is presentation, not protection — the console checks rank on the
     server. All this setting decides is which key *you* press. */
  function staffSection(user) {
    var Store = window.Store;
    var UI = window.UI;
    if (!window.Session.isAdmin()) return;

    var block = document.getElementById("staff-block");
    if (!block) return;
    block.hidden = false;
    document.getElementById("staff-role").textContent = user.role;

    var mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
    document.getElementById("combo-mod").textContent = mac ? "⌘" : "Ctrl";

    /* Keys the browser itself claims. Offering them isn't wrong — the page
       calls preventDefault — but people should know what they're taking. */
    var TAKEN = {
      p: "your browser's print dialog",
      s: "save page",
      f: "find on page",
      d: "bookmark this page",
      n: "new window",
      t: "new tab",
      w: "close tab",
      r: "reload",
      l: "focus the address bar",
      a: "select all",
      j: "downloads",
      o: "open a file"
    };

    var select = document.getElementById("admin-key");
    var warn = document.getElementById("admin-key-warn");
    var warnText = document.getElementById("admin-key-warn-text");
    var toggle = document.getElementById("admin-key-on");

    "abcdefghijklmnopqrstuvwxyz0123456789".split("").forEach(function (ch) {
      var o = UI.el("option", null, ch.toUpperCase() + (TAKEN[ch] ? "  ·  taken" : ""));
      o.value = ch;
      select.appendChild(o);
    });

    var saved = Store.settings().adminKey;
    var enabled = !!saved;
    select.value = (saved || "p").toLowerCase();
    toggle.checked = enabled;
    select.disabled = !enabled;

    function paintWarning() {
      var clash = TAKEN[select.value];
      if (clash && !select.disabled) {
        warnText.textContent = "That combo is normally " + clash +
          ". The hub takes it over on its own pages, which works, but it will " +
          "not reach the console from inside a game that has grabbed the key " +
          "for itself. Pick something less contested if that bites.";
        warn.hidden = false;
      } else {
        warn.hidden = true;
      }
    }

    select.addEventListener("change", function () {
      Store.setSetting("adminKey", select.value);
      paintWarning();
      UI.toast("Console shortcut · " + (mac ? "⌘" : "Ctrl") + " + " + select.value.toUpperCase());
    });

    toggle.addEventListener("change", function () {
      /* An empty string is the off state — shell.js treats a falsy adminKey
         as "no shortcut", so there is no second flag to keep in step. */
      Store.setSetting("adminKey", toggle.checked ? select.value : "");
      select.disabled = !toggle.checked;
      paintWarning();
      UI.toast(toggle.checked ? "Shortcut on" : "Shortcut off — use the sidebar");
    });

    paintWarning();
  }

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
      gameProgressSection();
      staffSection(state.user);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

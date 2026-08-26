/* Admin game-data editor.
 *
 * Games store progress in localStorage on the origin that serves them. The
 * save bridge already gives the hub read/write access to that, so this is a
 * viewer and editor over it.
 *
 * Two things worth being clear about:
 *   * it edits *this browser's* copy, not a server record — there is no
 *     server-side game state to change, so this cheats only for you;
 *   * save formats are the games' own, and there are 216 of them. Rather
 *     than pretend to know each one, this reads whatever is there, decodes
 *     JSON where it finds it, and surfaces every number as an editable
 *     field. data/game-cheats.json adds friendly labels for keys as you
 *     identify them.
 */
(function () {
  "use strict";

  var presets = null;
  var current = { host: null, data: {} };

  function el() { return window.UI.el.apply(null, arguments); }

  function looksJson(value) {
    var t = String(value).trim();
    if (!t || (t[0] !== "{" && t[0] !== "[")) return false;
    try { JSON.parse(t); return true; } catch (e) { return false; }
  }

  function loadPresets() {
    if (presets) return Promise.resolve(presets);
    return fetch("data/game-cheats.json")
      .then(function (r) { return r.ok ? r.json() : { hosts: {} }; })
      .catch(function () { return { hosts: {} }; })
      .then(function (json) { presets = json || { hosts: {} }; return presets; });
  }

  function labelFor(host, key) {
    var forHost = (presets && presets.hosts && presets.hosts[host]) || {};
    return forHost[key] || null;
  }

  window.initGameData = function initGameData() {
    var UI = window.UI;
    if (!window.GameSaves) return;

    var hostSel = document.getElementById("gd-host");
    var gameSel = document.getElementById("gd-game");
    var scopeNote = document.getElementById("gd-scope");
    var filter = document.getElementById("gd-filter");
    var state = document.getElementById("gd-state");
    var keysHost = document.getElementById("gd-keys");
    var presetHost = document.getElementById("gd-presets");

    if (hostSel.dataset.ready) return;
    hostSel.dataset.ready = "1";

    window.GameSaves.hosts().forEach(function (origin) {
      var opt = el("option", null, window.GameSaves.hostKey(origin));
      opt.value = window.GameSaves.hostKey(origin);
      hostSel.appendChild(opt);
    });

    /* The per-game view. A host's storage is shared by every game it serves —
       up to 145 of them — so "all keys on games-huge" is not a mod menu for
       anything. Picking a game narrows it to what that game actually wrote,
       which js/game-keys.js learns by watching the storage change while you
       play, and guesses from key names in the meantime. */
    buildGameList();

    function buildGameList() {
      var any = el("option", null, "Everything on this host");
      any.value = "";
      gameSel.appendChild(any);

      var host = hostSel.value;
      var games = window.Catalog.all.filter(function (g) { return g.host === host; });
      var learned = {};
      (window.GameKeys ? window.GameKeys.known() : []).forEach(function (k) {
        learned[k.id] = k.keys;
      });

      /* Games this device has already learned about float to the top, since
         those are the ones with something to show. */
      games.sort(function (a, b) {
        var d = (learned[b.id] || 0) - (learned[a.id] || 0);
        return d || a.title.localeCompare(b.title);
      });

      games.forEach(function (g) {
        var opt = el("option", null,
          g.title + (learned[g.id] ? "  ·  " + learned[g.id] + " keys seen" : ""));
        opt.value = g.id;
        gameSel.appendChild(opt);
      });
    }

    function rebuildGameList() {
      gameSel.innerHTML = "";
      buildGameList();
    }

    function say(text) { state.textContent = text; }

    /* Entries are { value, from, name }. Older call sites handed round a bare
       string, so tolerate both rather than crash on a stale shape. */
    function entryOf(key) {
      var e = current.data[key];
      if (e && typeof e === "object" && "value" in e) return e;
      return { value: e, from: "localStorage" };
    }

    function kv(key, value) {
      var out = {};
      out[key] = value;
      return out;
    }

    /* ---------------------------------------------------------- loading */

    function load() {
      var host = hostSel.value;
      say("Reading " + host + "…");
      keysHost.innerHTML = "";
      presetHost.hidden = true;

      return loadPresets()
        .then(function () { return window.GameSaves.readAll(host); })
        .then(function (res) {
          /* Cookies are the single largest place these games keep progress —
             more titles than localStorage — so they are shown as first-class
             entries here, tagged by where they came from. */
          var merged = {};
          Object.keys(res.data || {}).forEach(function (k) {
            merged[k] = { value: res.data[k], from: "localStorage" };
          });
          Object.keys(res.cookies || {}).forEach(function (k) {
            /* A cookie and a localStorage key can share a name. */
            var id = merged[k] ? k + " (cookie)" : k;
            merged[id] = { value: res.cookies[k], from: "cookie", name: k };
          });

          current = { host: res.host, data: merged, info: res };

          var local = Object.keys(res.data || {}).length;
          var cookies = Object.keys(res.cookies || {}).length;
          var dbs = Object.keys(res.idb || {}).length;
          var bits = [];
          if (local) bits.push(local + " localStorage");
          if (cookies) bits.push(cookies + " cookie" + (cookies === 1 ? "" : "s"));
          if (dbs) bits.push(dbs + " database" + (dbs === 1 ? "" : "s"));

          say(bits.length
            ? bits.join(" · ") + " on " + res.host +
              (res.skipped ? " (" + res.skipped + " too large to show)" : "")
            : "Nothing readable on " + res.host + " in this browser yet.");
          draw();
        })
        .catch(function (err) {
          say(err.message + " — the save bridge may still be deploying on that host.");
        });
    }

    /* ---------------------------------------------------------- drawing */

    function draw() {
      var q = filter.value.trim().toLowerCase();
      keysHost.innerHTML = "";

      var keys = Object.keys(current.data).sort();
      keys = narrowToGame(keys);
      if (q) {
        keys = keys.filter(function (k) {
          return k.toLowerCase().indexOf(q) !== -1 ||
                 String(entryOf(k).value).toLowerCase().indexOf(q) !== -1;
        });
      }

      if (!keys.length) {
        var v = el("div", "void");
        v.appendChild(el("strong", null, q ? "No keys match" : "Nothing readable here"));

        if (q) {
          v.appendChild(el("p", null, "Try a shorter filter."));
        } else {
          /* An empty list has several very different causes, and saying which
             is the difference between a tool that looks broken and one that
             is being honest. */
          v.appendChild(el("p", null,
            "Play a game on this host in this browser, then load again. " +
            "If you have played one and it is still empty, it is one of these:"));

          var why = el("ul");
          why.style.textAlign = "left";
          why.style.margin = "0.8rem auto 0";
          why.style.maxWidth = "34rem";
          [
            "The game keeps its save in a cookie scoped to its own folder. " +
              "The bridge runs at " + ((current.info && current.info.cookiePath) || "/") +
              ", and a browser only hands a page the cookies whose path it sits under — " +
              "so those stay out of reach from here.",
            "It is a compiled build (Unity, Flash, Clickteam) that keeps its save " +
              "as one opaque blob. It backs up and restores fine; there is nothing " +
              "meaningful to edit field by field.",
            "It genuinely saves nothing — about a quarter of the catalogue is " +
              "score-attack or arcade with no progress to keep."
          ].forEach(function (line) { why.appendChild(el("li", null, line)); });
          v.appendChild(why);
        }

        keysHost.appendChild(v);
        return;
      }

      keys.forEach(function (key) { keysHost.appendChild(card(key)); });
    }

    /* Keys this game is known to have written, plus ones whose name looks
       like it. The guess is labelled as a guess. */
    function narrowToGame(keys) {
      scopeNote.textContent = "";
      var id = gameSel.value;
      if (!id || !window.GameKeys) return keys;

      var game = window.Catalog.byId(id);
      if (!game) return keys;

      var owned = window.GameKeys.forGame(game, current.data);
      var seen = {};
      owned.watched.forEach(function (k) { seen[k] = "watched"; });
      owned.guessed.forEach(function (k) { seen[k] = "guessed"; });
      scopeOf = seen;

      var narrowed = keys.filter(function (k) { return seen[k]; });

      if (!narrowed.length) {
        scopeNote.textContent = "Nothing attributed to " + game.title + " yet. " +
          "Play it for a minute and come back — the player watches what changes " +
          "while a game is open and files those keys against it. Until then, " +
          "switch to “Everything on this host” to see the shared list.";
      } else {
        var w = owned.watched.length, g = owned.guessed.length;
        scopeNote.textContent = narrowed.length + " key" +
          (narrowed.length === 1 ? "" : "s") + " for " + game.title + " — " +
          w + " seen change while you played" +
          (g ? ", " + g + " matched by name (a guess)" : "") + ".";
      }
      return narrowed;
    }

    var scopeOf = {};

    function card(key) {
      var entry = entryOf(key);
      var raw = entry.value;
      var box = el("div", "gd-card");
      box.dataset.from = entry.from;

      var head = el("div", "gd-head");
      var name = el("span", "gd-key");
      name.textContent = key;
      head.appendChild(name);

      /* Which store this came from decides how it is written back, so it is
         worth showing rather than leaving the two indistinguishable. */
      var where = el("span", "gd-from", entry.from === "cookie" ? "cookie" : "local");
      where.dataset.from = entry.from;
      head.appendChild(where);

      /* A guessed key can belong to a different game entirely, so say which
         kind of claim this is rather than presenting both as fact. */
      if (gameSel.value && scopeOf[key]) {
        var how = el("span", "gd-from", scopeOf[key] === "watched" ? "seen" : "guess");
        how.dataset.how = scopeOf[key];
        head.appendChild(how);
      }

      var nice = labelFor(current.host, key);
      if (nice) head.appendChild(el("span", "pill on", nice));

      var size = el("span", "tiny dimmer");
      size.style.marginLeft = "auto";
      size.textContent = String(raw).length + " chars";
      head.appendChild(size);
      box.appendChild(head);

      var kind = window.SaveFormats ? window.SaveFormats.detect(raw) : (looksJson(raw) ? "json" : "raw");
      if (kind === "json") box.appendChild(jsonEditor(key, raw));
      else if (kind === "clickteam-ini") box.appendChild(iniEditor(key, raw));
      else box.appendChild(rawEditor(key, raw));

      return box;
    }

    /* A JSON save gets a field per leaf, so a number can be changed without
       hand-editing a wall of text. Anything nested still shows raw below. */
    function jsonEditor(key, raw) {
      var parsed = JSON.parse(raw);
      var wrap = el("div");
      var fields = el("div", "gd-fields");
      var edited = JSON.parse(raw);

      function walk(obj, path) {
        Object.keys(obj).forEach(function (k) {
          var value = obj[k];
          var here = path.concat(k);
          if (value !== null && typeof value === "object") {
            if (here.length < 3) walk(value, here);
            return;
          }
          var row = el("label", "gd-field");
          var lab = el("span", "gd-field-name");
          lab.textContent = here.join(" › ");
          row.appendChild(lab);

          var input = el("input");
          input.type = typeof value === "number" ? "number" : "text";
          input.value = String(value);
          if (typeof value === "boolean") {
            input.type = "text";
            input.setAttribute("list", "gd-bools");
          }
          input.addEventListener("input", function () {
            var next = input.value;
            var cast = typeof value === "number" ? Number(next)
              : typeof value === "boolean" ? (next === "true")
              : next;
            var target = edited;
            for (var i = 0; i < here.length - 1; i++) target = target[here[i]];
            target[here[here.length - 1]] = cast;
          });
          row.appendChild(input);
          fields.appendChild(row);
        });
      }

      if (parsed && typeof parsed === "object") walk(parsed, []);
      wrap.appendChild(fields);

      var acts = el("div", "btn-row");
      acts.style.marginTop = "0.7rem";

      var save = el("button", "btn btn-sm btn-cta", "Save changes");
      save.type = "button";
      save.addEventListener("click", function () {
        writeKey(key, JSON.stringify(edited));
      });
      acts.appendChild(save);

      var showRaw = el("button", "btn btn-sm btn-flat", "Edit raw JSON");
      showRaw.type = "button";
      showRaw.addEventListener("click", function () {
        wrap.innerHTML = "";
        wrap.appendChild(rawEditor(key, JSON.stringify(edited, null, 2)));
      });
      acts.appendChild(showRaw);
      acts.appendChild(removeButton(key));

      wrap.appendChild(acts);
      return wrap;
    }

    /* Clickteam Fusion keeps its INI object in one localStorage value, lines
       joined by a literal "{@24}". Every FNAF title here is built with it, so
       without this their whole save is a single unreadable line in a
       textarea. Split into sections and fields it is an actual mod menu.

       Writes go through SaveFormats.set and stringify, which rebuild the
       exact original shape — separator or newlines — so a game that expects
       one is not handed the other. */
    function iniEditor(key, raw) {
      var SF = window.SaveFormats;
      var model = SF.parse(raw);
      var wrap = el("div", "gd-ini");

      var head = el("p", "tiny dimmer");
      head.style.margin = "0 0 0.7rem";
      head.textContent = "Clickteam save · " + SF.countValues(model) + " value" +
        (SF.countValues(model) === 1 ? "" : "s") + " across " + model.length +
        " section" + (model.length === 1 ? "" : "s") +
        ". Editing one writes the whole file back unchanged apart from that value.";
      wrap.appendChild(head);

      model.forEach(function (group) {
        if (group.section !== "") {
          wrap.appendChild(el("div", "gd-ini-section", "[" + group.section + "]"));
        }
        group.entries.forEach(function (entry) {
          if ("raw" in entry) return;          // comment; shown by the raw view
          wrap.appendChild(iniField(key, raw, model, group.section, entry));
        });
      });

      var showRaw = el("button", "btn btn-sm btn-flat", "Edit the whole file");
      showRaw.type = "button";
      showRaw.addEventListener("click", function () {
        showRaw.remove();
        wrap.appendChild(rawEditor(key, raw));
      });
      wrap.appendChild(showRaw);

      return wrap;
    }

    function iniField(key, raw, model, section, entry) {
      var row = el("div", "gd-field");
      row.appendChild(el("label", "gd-field-key", entry.key));

      var input = document.createElement("input");
      input.type = "text";
      input.className = "gd-field-input";
      input.value = entry.value;
      /* Numbers are what people come here to change, so make them steppable
         without forcing a number input on values that are not numbers. */
      if (/^-?\d+$/.test(entry.value)) input.inputMode = "numeric";
      row.appendChild(input);

      var save = el("button", "btn btn-sm", "Set");
      save.type = "button";
      save.addEventListener("click", function () {
        if (!window.SaveFormats.set(model, section, entry.key, input.value)) {
          window.UI.toast("Could not find that field any more — reload and retry.");
          return;
        }
        entry.value = input.value;
        writeKey(key, window.SaveFormats.stringify(model, raw));
      });
      row.appendChild(save);

      return row;
    }

    function rawEditor(key, raw) {
      var wrap = el("div");
      var area = document.createElement("textarea");
      area.className = "gd-raw";
      area.rows = Math.min(10, Math.max(2, String(raw).split("\n").length));
      area.value = raw;
      wrap.appendChild(area);

      var acts = el("div", "btn-row");
      acts.style.marginTop = "0.5rem";

      var save = el("button", "btn btn-sm btn-cta", "Save");
      save.type = "button";
      save.addEventListener("click", function () {
        var value = area.value;
        /* Re-minify valid JSON so games that parse strictly still read it. */
        if (looksJson(value)) {
          try { value = JSON.stringify(JSON.parse(value)); } catch (e) { /* keep as typed */ }
        }
        writeKey(key, value);
      });
      acts.appendChild(save);
      acts.appendChild(removeButton(key));

      wrap.appendChild(acts);
      return wrap;
    }

    function removeButton(key) {
      var b = el("button", "btn btn-sm btn-flat", "Delete key");
      b.type = "button";
      b.addEventListener("click", function () {
        if (!window.confirm("Delete “" + key + "” from " + current.host + "?")) return;
        var entry = entryOf(key);
        var job = entry.from === "cookie"
          ? window.GameSaves.writeCookies(current.host, kv(entry.name || key, ""))
          : window.GameSaves.removeKeys(current.host, [key]);
        job.then(function () {
          window.UI.toast("Deleted");
          load();
        }).catch(function (err) { window.UI.toast(err.message); });
      });
      return b;
    }

    function writeKey(key, value) {
      var entry = entryOf(key);
      var job = entry.from === "cookie"
        ? window.GameSaves.writeCookies(current.host, kv(entry.name || key, value))
        : window.GameSaves.writeKeys(current.host, kv(key, value), true);

      job.then(function () {
        current.data[key] = { value: value, from: entry.from, name: entry.name };
        window.UI.toast("Saved · " + key);
        say("Wrote " + key + " to " + current.host + ".");
      }).catch(function (err) { window.UI.toast(err.message); });
    }

    /* ------------------------------------------------------------ wiring */

    document.getElementById("gd-load").addEventListener("click", load);
    hostSel.addEventListener("change", function () { rebuildGameList(); load(); });
    gameSel.addEventListener("change", draw);
    filter.addEventListener("input", UI.debounce(draw, 150));

    document.getElementById("gd-new").addEventListener("click", function () {
      var key = window.prompt("New key name for " + hostSel.value);
      if (!key || !key.trim()) return;
      var value = window.prompt("Value for “" + key.trim() + "”", "0");
      if (value === null) return;
      current.data[key.trim()] = { value: value, from: "localStorage" };
      writeKey(key.trim(), value);
      draw();
    });

    /* Boolean helper for the JSON field editor. */
    if (!document.getElementById("gd-bools")) {
      var dl = document.createElement("datalist");
      dl.id = "gd-bools";
      ["true", "false"].forEach(function (v) {
        var o = document.createElement("option");
        o.value = v;
        dl.appendChild(o);
      });
      document.body.appendChild(dl);
    }

    load();
  };
})();

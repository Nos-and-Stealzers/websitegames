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

    function say(text) { state.textContent = text; }

    /* ---------------------------------------------------------- loading */

    function load() {
      var host = hostSel.value;
      say("Reading " + host + "…");
      keysHost.innerHTML = "";
      presetHost.hidden = true;

      return loadPresets()
        .then(function () { return window.GameSaves.readAll(host); })
        .then(function (res) {
          current = { host: res.host, data: res.data };
          var n = Object.keys(res.data).length;
          say(n
            ? n + " key" + (n === 1 ? "" : "s") + " on " + res.host +
              (res.skipped ? " (" + res.skipped + " too large to show)" : "")
            : "Nothing saved on " + res.host + " in this browser yet — play something first.");
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
      if (q) {
        keys = keys.filter(function (k) {
          return k.toLowerCase().indexOf(q) !== -1 ||
                 String(current.data[k]).toLowerCase().indexOf(q) !== -1;
        });
      }

      if (!keys.length) {
        var v = el("div", "void");
        v.appendChild(el("strong", null, q ? "No keys match" : "Nothing stored"));
        v.appendChild(el("p", null, q
          ? "Try a shorter filter."
          : "Play a game on this host, then load again."));
        keysHost.appendChild(v);
        return;
      }

      keys.forEach(function (key) { keysHost.appendChild(card(key)); });
    }

    function card(key) {
      var raw = current.data[key];
      var box = el("div", "gd-card");

      var head = el("div", "gd-head");
      var name = el("span", "gd-key");
      name.textContent = key;
      head.appendChild(name);

      var nice = labelFor(current.host, key);
      if (nice) head.appendChild(el("span", "pill on", nice));

      var size = el("span", "tiny dimmer");
      size.style.marginLeft = "auto";
      size.textContent = String(raw).length + " chars";
      head.appendChild(size);
      box.appendChild(head);

      if (looksJson(raw)) box.appendChild(jsonEditor(key, raw));
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
        window.GameSaves.removeKeys(current.host, [key]).then(function () {
          window.UI.toast("Deleted");
          load();
        }).catch(function (err) { window.UI.toast(err.message); });
      });
      return b;
    }

    function writeKey(key, value) {
      var patch = {};
      patch[key] = value;
      window.GameSaves.writeKeys(current.host, patch, true).then(function () {
        current.data[key] = value;
        window.UI.toast("Saved · " + key);
        say("Wrote " + key + " to " + current.host + ".");
      }).catch(function (err) { window.UI.toast(err.message); });
    }

    /* ------------------------------------------------------------ wiring */

    document.getElementById("gd-load").addEventListener("click", load);
    hostSel.addEventListener("change", load);
    filter.addEventListener("input", UI.debounce(draw, 150));

    document.getElementById("gd-new").addEventListener("click", function () {
      var key = window.prompt("New key name for " + hostSel.value);
      if (!key || !key.trim()) return;
      var value = window.prompt("Value for “" + key.trim() + "”", "0");
      if (value === null) return;
      writeKey(key.trim(), value);
      current.data[key.trim()] = value;
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

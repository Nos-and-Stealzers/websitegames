/* Save formats the editor can take apart.
 *
 * A saved value is just a string until something recognises it. JSON was
 * already handled; this adds the other format that actually matters here.
 *
 * Clickteam Fusion — which is what every FNAF title in the catalogue is built
 * with, and a good share of the other compiled games — stores its INI object
 * in localStorage as the INI file's lines joined by the literal separator
 * "{@24}". So a save looks like:
 *
 *   [Game]{@24}Night=3{@24}Stars=2{@24}[Options]{@24}Volume=10
 *
 * which is a wall of text in a textarea unless you split it, and a per-field
 * mod menu the moment you do. The separator is not a guess: it is
 * CIni.separator in the runtime those games ship.
 */
(function () {
  "use strict";

  var CT_SEP = "{@24}";

  function looksJson(value) {
    var t = String(value).trim();
    if (!t || (t[0] !== "{" && t[0] !== "[")) return false;
    try { JSON.parse(t); return true; } catch (err) { return false; }
  }

  /* Clickteam if it carries the separator, or if it reads as plain INI —
     some builds write real newlines instead. Requiring a key=value pair
     stops any old newline-separated text being claimed as a save file. */
  function looksClickteam(value) {
    var t = String(value);
    if (t.indexOf(CT_SEP) !== -1) return true;
    if (t.indexOf("\n") === -1) return false;
    return /^\s*\[[^\]\n]+\]\s*$/m.test(t) && /^\s*[^=\n\[]+=[^\n]*$/m.test(t);
  }

  function detect(value) {
    if (looksJson(value)) return "json";
    if (looksClickteam(value)) return "clickteam-ini";
    return "raw";
  }

  function splitLines(raw) {
    var text = String(raw);
    return text.indexOf(CT_SEP) !== -1 ? text.split(CT_SEP) : text.split(/\r?\n/);
  }

  /* [{ section, entries: [{ key, value }] }].
   *
   * Anything before the first [Section] goes into one unnamed group rather
   * than being dropped — a value you cannot see is worse than an ugly
   * heading. Comments and blank lines are kept in order so writing the file
   * back does not quietly rewrite it. */
  function parse(raw) {
    var out = [];
    var current = { section: "", entries: [] };
    var started = false;

    splitLines(raw).forEach(function (line) {
      var trimmed = String(line).trim();

      var head = /^\[([^\]]*)\]$/.exec(trimmed);
      if (head) {
        if (started || current.entries.length) out.push(current);
        current = { section: head[1], entries: [] };
        started = true;
        return;
      }

      var at = trimmed.indexOf("=");
      if (at > 0) {
        current.entries.push({
          key: trimmed.slice(0, at).trim(),
          value: trimmed.slice(at + 1)
        });
      } else if (trimmed !== "") {
        current.entries.push({ raw: trimmed });    // comment or stray line
      }
    });

    if (started || current.entries.length) out.push(current);
    return out;
  }

  /* Back to the exact shape it came in as, so a game that expects the
     separator gets the separator and one that wrote newlines gets newlines. */
  function stringify(model, originalRaw) {
    var sep = String(originalRaw || "").indexOf(CT_SEP) !== -1 ? CT_SEP : "\n";
    var lines = [];

    model.forEach(function (group) {
      if (group.section !== "") lines.push("[" + group.section + "]");
      group.entries.forEach(function (e) {
        lines.push("raw" in e ? e.raw : e.key + "=" + e.value);
      });
    });

    return lines.join(sep);
  }

  /* Set one value without disturbing anything else. */
  function set(model, sectionName, key, value) {
    for (var i = 0; i < model.length; i++) {
      if (model[i].section !== sectionName) continue;
      for (var j = 0; j < model[i].entries.length; j++) {
        if (model[i].entries[j].key === key) {
          model[i].entries[j].value = String(value);
          return true;
        }
      }
    }
    return false;
  }

  function countValues(model) {
    return model.reduce(function (n, g) {
      return n + g.entries.filter(function (e) { return !("raw" in e); }).length;
    }, 0);
  }

  window.SaveFormats = {
    SEPARATOR: CT_SEP,
    detect: detect,
    looksJson: looksJson,
    looksClickteam: looksClickteam,
    parse: parse,
    stringify: stringify,
    set: set,
    countValues: countValues
  };
})();

/* Runs in <head>, before first paint, so the skin never flashes.
   Kept dependency-free — the alias table is duplicated here on purpose so this
   file can load before config.js. */
(function () {
  "use strict";

  var ALIAS = {
    light: "paper", gray: "slate", black: "noir",
    midnight: "blueprint", arcade: "terminal"
  };
  var VALID = {
    noir: 1, paper: 1, slate: 1, terminal: 1, blueprint: 1,
    grape: 1, ember: 1, linen: 1
  };

  var skin = "noir";
  var lite = false;
  var motion = true;
  var textSize = "normal";

  try {
    var raw = window.localStorage.getItem("ach:settings");
    if (raw) {
      var s = JSON.parse(raw) || {};
      var want = s.skin || ALIAS[s.theme] || s.theme;
      if (want && VALID[want]) skin = want;
      lite = !!(s.lite || s.fast);
      if (typeof s.motion === "boolean") motion = s.motion;
      if (s.textSize) textSize = s.textSize;
    }
  } catch (err) { /* private mode, blocked storage — defaults are fine */ }

  /* Honour the OS setting when the user hasn't expressed one here. */
  try {
    if (motion && window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      motion = false;
    }
  } catch (err) { /* no matchMedia */ }

  var root = document.documentElement;
  root.setAttribute("data-skin", skin);
  root.setAttribute("data-lite", lite ? "on" : "off");
  root.setAttribute("data-motion", motion ? "on" : "off");
  root.setAttribute("data-text", textSize);

  /* Smooth page-in, so navigating between pages fades instead of flashing a
     jarring content pop (the "lags out for a sec" feel). Only when motion is
     allowed. We mark the document not-ready now (before first paint) and clear
     it once the DOM is in, letting CSS fade the body up. A hard timeout makes
     sure content is never stuck hidden if something goes wrong. */
  if (motion && !lite) {
    root.setAttribute("data-loading", "");
    var reveal = function () { root.removeAttribute("data-loading"); };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", reveal);
    } else {
      reveal();
    }
    window.setTimeout(reveal, 1200);
  }
})();

/* Runs in <head>, before first paint, so the skin never flashes.
   Kept dependency-free — the alias table is duplicated here on purpose so this
   file can load before config.js. */
(function () {
  "use strict";

  var ALIAS = {
    light: "paper", gray: "slate", black: "noir",
    midnight: "blueprint", arcade: "terminal"
  };
  var VALID = { noir: 1, paper: 1, slate: 1, terminal: 1, blueprint: 1 };

  var skin = "noir";
  var lite = false;

  try {
    var raw = window.localStorage.getItem("ach:settings");
    if (raw) {
      var s = JSON.parse(raw) || {};
      var want = s.skin || ALIAS[s.theme] || s.theme;
      if (want && VALID[want]) skin = want;
      lite = !!(s.lite || s.fast);
    }
  } catch (err) { /* private mode, blocked storage — defaults are fine */ }

  var root = document.documentElement;
  root.setAttribute("data-skin", skin);
  root.setAttribute("data-lite", lite ? "on" : "off");
})();

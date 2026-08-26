/* Generated cover art.
   Every game gets a deterministic geometric plate built from its own id and
   palette — no image files, no network, identical on every device. */
(function () {
  "use strict";

  var NS = "http://www.w3.org/2000/svg";
  var FALLBACK = ["#2b2f3a", "#6b7280"];

  function hash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h;
  }

  /* Pull the stops out of whatever gradient string the catalog carries. */
  function palette(game) {
    var found = String(game.gradient || "").match(/#[0-9a-f]{3,8}|rgba?\([^)]+\)/gi);
    if (!found || !found.length) return FALLBACK.slice();
    if (found.length === 1) return [found[0], found[0]];
    return [found[0], found[found.length - 1]];
  }

  function node(name, attrs) {
    var e = document.createElementNS(NS, name);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }

  /* --- motifs, each drawing into a 160×100 field --- */

  var MOTIFS = [
    function rings(g, rnd) {
      for (var r = 8; r <= 74; r += 11) {
        g.appendChild(node("circle", {
          cx: 40 + rnd(60), cy: 50, r: r, fill: "none",
          "stroke-width": 2, opacity: (1 - r / 90).toFixed(2)
        }));
      }
    },
    function bars(g, rnd) {
      var step = 12 + rnd(8);
      for (var x = -100; x < 200; x += step) {
        g.appendChild(node("rect", {
          x: x, y: -30, width: step * 0.42, height: 160,
          transform: "rotate(" + (rnd(50) - 25) + " 80 50)", opacity: 0.55
        }));
      }
    },
    function matrix(g, rnd) {
      var gap = 10 + rnd(6);
      for (var y = gap / 2; y < 100; y += gap) {
        for (var x = gap / 2; x < 160; x += gap) {
          g.appendChild(node("circle", {
            cx: x, cy: y, r: 1.6 + (x + y) % 3, opacity: 0.5
          }));
        }
      }
    },
    function chevrons(g, rnd) {
      var w = 26 + rnd(10);
      for (var i = -1; i < 8; i++) {
        var x = i * w;
        g.appendChild(node("polygon", {
          points: x + ",100 " + (x + w / 2) + ",30 " + (x + w) + ",100",
          opacity: i % 2 ? 0.32 : 0.6
        }));
      }
    },
    function frames(g, rnd) {
      var cx = 30 + rnd(100), cy = 20 + rnd(60);
      for (var i = 0; i < 6; i++) {
        var s = 12 + i * 13;
        g.appendChild(node("rect", {
          x: cx - s / 2, y: cy - s / 2, width: s, height: s,
          fill: "none", "stroke-width": 2, opacity: (0.7 - i * 0.09).toFixed(2)
        }));
      }
    },
    function arcs(g, rnd) {
      for (var i = 0; i < 5; i++) {
        var r = 22 + i * 16;
        g.appendChild(node("path", {
          d: "M " + (-10) + " " + (110 - r) + " A " + r + " " + r + " 0 0 1 " + (-10 + r) + " 110",
          fill: "none", "stroke-width": 3, opacity: (0.65 - i * 0.1).toFixed(2),
          transform: "translate(" + rnd(40) + " 0)"
        }));
      }
    },
    function bricks(g, rnd) {
      var h = 12, w = 26 + rnd(8);
      for (var row = 0, y = 0; y < 100; y += h, row++) {
        for (var x = (row % 2 ? -w / 2 : 0); x < 160; x += w) {
          g.appendChild(node("rect", {
            x: x + 1, y: y + 1, width: w - 3, height: h - 3,
            opacity: ((x + y) % 5) / 9 + 0.16
          }));
        }
      }
    },
    function crosses(g, rnd) {
      var gap = 18 + rnd(8);
      for (var y = gap / 2; y < 108; y += gap) {
        for (var x = gap / 2; x < 168; x += gap) {
          g.appendChild(node("path", {
            d: "M" + (x - 4) + " " + y + " h8 M" + x + " " + (y - 4) + " v8",
            "stroke-width": 2, opacity: 0.45
          }));
        }
      }
    }
  ];

  /* --- public --- */

  function cover(game, opts) {
    opts = opts || {};
    var seed = hash(game.id || game.title || "x");
    var rnd = (function () {
      var s = seed;
      return function (max) { s = (s * 1103515245 + 12345) >>> 0; return (s >>> 8) % max; };
    })();

    var pair = palette(game);
    var svg = node("svg", {
      viewBox: "0 0 160 100",
      preserveAspectRatio: "xMidYMid slice",
      role: "img",
      "aria-label": game.title + " cover"
    });

    var defs = node("defs");
    var gradId = "ag-" + seed.toString(36);
    var lg = node("linearGradient", { id: gradId, x1: "0", y1: "0", x2: "1", y2: "1" });
    lg.appendChild(node("stop", { offset: "0", "stop-color": pair[0] }));
    lg.appendChild(node("stop", { offset: "1", "stop-color": pair[1] }));
    defs.appendChild(lg);
    svg.appendChild(defs);

    svg.appendChild(node("rect", { width: "160", height: "100", fill: "url(#" + gradId + ")" }));

    var layer = node("g", { fill: "#000", stroke: "#000", "stroke-linecap": "square", opacity: "0.42" });
    MOTIFS[seed % MOTIFS.length](layer, rnd);
    svg.appendChild(layer);

    /* >>> keeps the shift unsigned; >> would wrap negative and index off the end. */
    var light = node("g", { fill: "#fff", stroke: "#fff", "stroke-linecap": "square", opacity: "0.2" });
    MOTIFS[(seed >>> 3) % MOTIFS.length](light, rnd);
    svg.appendChild(light);

    if (!opts.plain) {
      var glyph = node("text", {
        x: "154", y: "94", "text-anchor": "end",
        "font-family": "ui-monospace, monospace",
        "font-size": "34", "font-weight": "700",
        fill: "#fff", opacity: "0.26", "letter-spacing": "-2"
      });
      glyph.textContent = game.initials || "";
      svg.appendChild(glyph);
    }

    return svg;
  }

  /* Deterministic account avatar: a mirrored 5×5 cell block, like an identicon,
     seeded off the username so it is stable everywhere and needs no upload. */
  var AVATAR_HUES = [8, 28, 48, 96, 150, 175, 200, 225, 265, 292, 320, 342];

  function avatar(seed) {
    var h = hash(String(seed || "?").toLowerCase());
    var hue = AVATAR_HUES[h % AVATAR_HUES.length];
    var ink = "hsl(" + hue + ", 62%, 58%)";
    var bg = "hsl(" + hue + ", 32%, 16%)";

    var svg = node("svg", {
      viewBox: "0 0 5 5",
      "shape-rendering": "crispEdges",
      role: "img",
      "aria-label": "Avatar for " + seed
    });
    svg.appendChild(node("rect", { width: "5", height: "5", fill: bg }));

    var bits = h;
    for (var x = 0; x < 3; x++) {
      for (var y = 0; y < 5; y++) {
        bits = (bits * 1103515245 + 12345) >>> 0;
        if ((bits >>> 16) % 100 < 48) continue;
        svg.appendChild(node("rect", { x: x, y: y, width: 1, height: 1, fill: ink }));
        if (x < 2) svg.appendChild(node("rect", { x: 4 - x, y: y, width: 1, height: 1, fill: ink }));
      }
    }
    return svg;
  }

  window.Art = { cover: cover, palette: palette, avatar: avatar };
})();

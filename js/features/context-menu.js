/* Fully custom right-click menu.
 *
 * Replaces the browser's default context menu everywhere on the site with one
 * that matches the skin and is aware of what you clicked:
 *
 *   - on a game tile/row  → Play, Play in new tab, Pin/Unpin, Copy link, Details
 *   - on a link           → Open, Open in new tab, Copy link
 *   - on selected text     → Copy, Search the catalogue for it
 *   - anywhere else        → quick nav (Home, All games, Campus+, Library, Settings)
 *
 * It never blocks inside form fields and inputs (you still want the native
 * menu there for spellcheck/paste), and it closes on click, scroll, Escape or
 * a second right-click elsewhere. Dependency-free; injects its own styles.
 */
(function () {
  "use strict";

  var menu = null;

  function injectStyles() {
    if (document.getElementById("ctx-menu-style")) return;
    var css =
      "#ctx-menu{position:fixed;z-index:2147482000;min-width:12.5rem;max-width:17rem;" +
      "background:var(--card,#14161c);color:var(--foreground,#e9edf3);" +
      "border:1px solid var(--border,#2a2f3a);border-radius:12px;padding:.35rem;" +
      "box-shadow:0 18px 48px rgba(0,0,0,.5);font:0.9rem/1.3 system-ui,-apple-system," +
      "'Segoe UI',Roboto,sans-serif;user-select:none;animation:ctxpop .09s ease-out;}" +
      "@keyframes ctxpop{from{opacity:0;transform:scale(.97) translateY(-3px)}" +
      "to{opacity:1;transform:none}}" +
      "#ctx-menu .ctx-item{display:flex;align-items:center;gap:.6rem;padding:.5rem .6rem;" +
      "border-radius:8px;cursor:pointer;white-space:nowrap;overflow:hidden;" +
      "text-overflow:ellipsis;color:var(--foreground,#e9edf3);}" +
      "#ctx-menu .ctx-item:hover{background:var(--accent,#ff5c33);color:#111;}" +
      "#ctx-menu .ctx-item .ctx-ico{flex:0 0 1.1rem;text-align:center;opacity:.85;}" +
      "#ctx-menu .ctx-item .ctx-key{margin-left:auto;font-size:.72rem;opacity:.5;}" +
      "#ctx-menu .ctx-sep{height:1px;margin:.3rem .2rem;background:var(--border,#2a2f3a);}" +
      "#ctx-menu .ctx-head{padding:.4rem .6rem .2rem;font-size:.72rem;letter-spacing:.04em;" +
      "text-transform:uppercase;opacity:.55;overflow:hidden;text-overflow:ellipsis;}";
    var el = document.createElement("style");
    el.id = "ctx-menu-style";
    el.textContent = css;
    (document.head || document.documentElement).appendChild(el);
  }

  function close() {
    if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
    menu = null;
  }

  function toast(msg) {
    if (window.UI && typeof window.UI.toast === "function") window.UI.toast(msg);
  }

  function copy(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () { toast("Copied"); },
          function () { legacyCopy(text); }
        );
      } else { legacyCopy(text); }
    } catch (e) { legacyCopy(text); }
  }

  function legacyCopy(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;top:0;";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      toast("Copied");
    } catch (e) { toast("Couldn't copy"); }
  }

  function gameFromTarget(target) {
    var node = target;
    while (node && node !== document.body) {
      if (node.dataset && node.dataset.gameId) return node.dataset.gameId;
      node = node.parentNode;
    }
    return null;
  }

  function linkFromTarget(target) {
    var node = target;
    while (node && node !== document.body) {
      if (node.tagName === "A" && node.href) return node.href;
      node = node.parentNode;
    }
    return null;
  }

  function inEditable(target) {
    var node = target;
    while (node && node !== document.body) {
      var tag = node.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || node.isContentEditable) return true;
      node = node.parentNode;
    }
    return false;
  }

  function absolute(href) {
    try { return new URL(href, location.href).href; } catch (e) { return href; }
  }

  /* Build the list of items appropriate to what was clicked. */
  function itemsFor(target) {
    var items = [];
    var selection = String(window.getSelection ? window.getSelection() : "").trim();
    var gameId = gameFromTarget(target);
    var link = linkFromTarget(target);

    if (gameId && window.Catalog) {
      var game = window.Catalog.byId ? window.Catalog.byId(gameId) : null;
      var href = absolute((window.UI && window.UI.playHref)
        ? window.UI.playHref({ id: gameId }) : "play.html?id=" + encodeURIComponent(gameId));
      var pinned = window.Store && window.Store.favorites &&
        window.Store.favorites().indexOf(gameId) !== -1;

      if (game && game.title) items.push({ head: game.title });
      items.push({ ico: "▶", label: "Play", act: function () { location.href = href; } });
      items.push({ ico: "⧉", label: "Play in new tab",
        act: function () { window.open(href, "_blank", "noopener"); } });
      if (window.Store && window.Store.toggleFavorite) {
        items.push({ ico: pinned ? "★" : "☆", label: pinned ? "Unpin" : "Pin to library",
          act: function () { window.Store.toggleFavorite(gameId); toast(pinned ? "Unpinned" : "Pinned"); } });
      }
      items.push({ ico: "🔗", label: "Copy game link", act: function () { copy(href); } });
      items.push({ sep: true });
    } else if (link) {
      items.push({ ico: "↗", label: "Open", act: function () { location.href = link; } });
      items.push({ ico: "⧉", label: "Open in new tab",
        act: function () { window.open(link, "_blank", "noopener"); } });
      items.push({ ico: "🔗", label: "Copy link", act: function () { copy(link); } });
      items.push({ sep: true });
    }

    if (selection) {
      var short = selection.length > 24 ? selection.slice(0, 24) + "…" : selection;
      items.push({ ico: "⧉", label: "Copy", act: function () { copy(selection); } });
      items.push({ ico: "🔎", label: 'Search for "' + short + '"',
        act: function () { location.href = "browse.html?q=" + encodeURIComponent(selection); } });
      items.push({ sep: true });
    }

    /* Always-available quick nav. */
    items.push({ head: "Go to" });
    items.push({ ico: "◧", label: "Home", act: function () { location.href = "index.html"; } });
    items.push({ ico: "▤", label: "All games", act: function () { location.href = "browse.html"; } });
    items.push({ ico: "▶", label: "Campus+", act: function () { location.href = "campus-plus.html"; } });
    items.push({ ico: "★", label: "Library", act: function () { location.href = "library.html"; } });
    items.push({ ico: "⚙", label: "Settings", act: function () { location.href = "settings.html"; } });
    return items;
  }

  function open(x, y, target) {
    close();
    injectStyles();

    menu = document.createElement("div");
    menu.id = "ctx-menu";
    menu.setAttribute("role", "menu");

    itemsFor(target).forEach(function (item) {
      if (item.sep) { menu.appendChild(mk("div", "ctx-sep")); return; }
      if (item.head) {
        var h = mk("div", "ctx-head");
        h.textContent = item.head;
        menu.appendChild(h);
        return;
      }
      var row = mk("div", "ctx-item");
      row.setAttribute("role", "menuitem");
      row.tabIndex = 0;
      var ico = mk("span", "ctx-ico"); ico.textContent = item.ico || "";
      var lbl = mk("span"); lbl.textContent = item.label;
      row.appendChild(ico); row.appendChild(lbl);
      row.addEventListener("click", function () {
        close();
        try { item.act(); } catch (e) {}
      });
      menu.appendChild(row);
    });

    document.body.appendChild(menu);

    /* Keep it on-screen. */
    var r = menu.getBoundingClientRect();
    var vw = window.innerWidth, vh = window.innerHeight;
    if (x + r.width > vw - 6) x = Math.max(6, vw - r.width - 6);
    if (y + r.height > vh - 6) y = Math.max(6, vh - r.height - 6);
    menu.style.left = x + "px";
    menu.style.top = y + "px";
  }

  function mk(tag, cls) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }

  document.addEventListener("contextmenu", function (e) {
    /* Leave inputs/textareas to the browser so paste & spellcheck still work.
       Hold Shift to force the native menu anywhere (an escape hatch). */
    if (e.shiftKey) return;
    if (inEditable(e.target)) return;
    /* Don't hijack right-click while a game is actively running in its frame —
       the game may want it, and our overlay can't reach into the iframe anyway. */
    if (document.body && document.body.dataset && document.body.dataset.gameActive) return;
    e.preventDefault();
    open(e.clientX, e.clientY, e.target);
  });

  document.addEventListener("click", function (e) {
    if (menu && !menu.contains(e.target)) close();
  });
  document.addEventListener("scroll", close, true);
  window.addEventListener("resize", close);
  window.addEventListener("blur", close);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") close();
  });

  window.ContextMenu = { close: close };
})();

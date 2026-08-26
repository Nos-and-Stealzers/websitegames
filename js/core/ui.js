/* Rendering helpers: tiles, list rows, flags, toasts, formatting. */
(function () {
  "use strict";

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function playHref(game) {
    return "play.html?id=" + encodeURIComponent(game.id);
  }

  function pad(n) { return n < 10 ? "0" + n : String(n); }

  function formatDuration(seconds) {
    seconds = Math.max(0, Math.round(seconds || 0));
    if (seconds < 60) return seconds + "s";
    var m = Math.floor(seconds / 60);
    if (m < 60) return m + "m";
    var h = Math.floor(m / 60);
    var rem = m % 60;
    return rem ? h + "h" + pad(rem) : h + "h";
  }

  function formatWhen(ts) {
    if (!ts) return "—";
    var min = Math.floor((Date.now() - ts) / 60000);
    if (min < 1) return "now";
    if (min < 60) return min + "m ago";
    var hr = Math.floor(min / 60);
    if (hr < 24) return hr + "h ago";
    var day = Math.floor(hr / 24);
    if (day < 7) return day + "d ago";
    return new Date(ts).toLocaleDateString();
  }

  var RISK = {
    low:     { cls: "flag-good", label: "Stable" },
    medium:  { cls: "flag-warn", label: "Patchy" },
    high:    { cls: "flag-bad",  label: "Blocked often" },
    unknown: { cls: "",          label: "Untested" }
  };

  function riskFlag(game) {
    var meta = RISK[game.risk] || RISK.unknown;
    return el("span", "flag " + meta.cls, meta.label);
  }

  function riskLabel(game) {
    return (RISK[game.risk] || RISK.unknown).label;
  }

  function launchLabel(game) {
    return game.embeddable && !game.preferDirect ? "In-page" : "New tab";
  }

  /* The generated plate always goes down first. A harvested icon — usually a
     small square logo — sits on top, contained rather than cropped, so it reads
     as a badge over its own colour field. A 404 just leaves the plate. */
  function coverInto(host, game) {
    host.appendChild(window.Art.cover(game, { plain: !!game.art }));
    if (!game.art) return;

    var img = el("img", "badge");
    img.src = game.art;
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.addEventListener("error", function () { img.remove(); });
    host.appendChild(img);
  }

  function starButton(game, className, onChange) {
    var b = el("button", className);
    b.type = "button";
    var on = window.Store.isFavorite(game.id);
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.setAttribute("aria-label", (on ? "Unpin " : "Pin ") + game.title);
    b.textContent = on ? "★" : "☆";
    b.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      var now = window.Store.toggleFavorite(game.id);
      b.setAttribute("aria-pressed", now ? "true" : "false");
      b.setAttribute("aria-label", (now ? "Unpin " : "Pin ") + game.title);
      b.textContent = now ? "★" : "☆";
      toast(now ? "Pinned · " + game.title : "Unpinned · " + game.title);
      if (onChange) onChange(game, now);
    });
    return b;
  }

  /* opts: { no (index badge), desc (default true), onFavorite } */
  function tile(game, opts) {
    opts = opts || {};
    var root = el("article", "tile");
    root.dataset.gameId = game.id;

    var art = el("div", "tile-art");
    coverInto(art, game);
    if (opts.no) art.appendChild(el("span", "tile-no", pad(opts.no)));
    art.appendChild(starButton(game, "tile-star", opts.onFavorite));
    root.appendChild(art);

    var hit = el("a", "tile-hit");
    hit.href = playHref(game);
    hit.tabIndex = -1;
    hit.setAttribute("aria-hidden", "true");
    root.appendChild(hit);

    var body = el("div", "tile-body");
    var name = el("div", "tile-name");
    var link = el("a", null, game.title);
    link.href = playHref(game);
    name.appendChild(link);
    body.appendChild(name);

    if (opts.desc !== false && game.description) {
      body.appendChild(el("p", "tile-desc", game.description));
    }

    var foot = el("div", "tile-foot");
    foot.appendChild(el("span", "tile-cat", game.categoryLabel));
    /* Say it on the card, not after the click. */
    foot.appendChild(game.unavailable
      ? el("span", "flag flag-bad", "Unavailable")
      : riskFlag(game));
    body.appendChild(foot);

    if (game.unavailable) root.classList.add("is-gone");

    root.appendChild(body);
    return root;
  }

  function row(game, index, opts) {
    opts = opts || {};
    var r = el("div", "row");
    r.dataset.gameId = game.id;

    r.appendChild(el("span", "idx", pad(index)));

    var name = el("span", "name");
    var link = el("a", null, game.title);
    link.href = playHref(game);
    name.appendChild(link);
    r.appendChild(name);

    r.appendChild(el("span", "cat", game.categoryLabel));

    var compat = el("span", "compat");
    compat.appendChild(riskFlag(game));
    r.appendChild(compat);

    var s = window.Store.statFor(game.id);
    r.appendChild(el("span", "plays", s.plays ? s.plays + "× " + formatDuration(s.seconds) : "—"));

    r.appendChild(starButton(game, "star", opts.onFavorite));
    return r;
  }

  function emptyBlock(opts) {
    var v = el("div", "void");
    v.appendChild(el("strong", null, opts.title || "Nothing here"));
    v.appendChild(el("p", null, opts.body || "Try a different filter."));
    if (opts.action) {
      var a = el("a", "btn btn-cta", opts.action.label);
      a.href = opts.action.href;
      v.appendChild(a);
    }
    return v;
  }

  /* Renders tiles into a container. Returns the count rendered. */
  function render(container, games, opts) {
    if (!container) return 0;
    opts = opts || {};
    container.innerHTML = "";

    if (!games.length) {
      container.appendChild(emptyBlock({
        title: opts.emptyTitle, body: opts.emptyBody, action: opts.emptyAction
      }));
      return 0;
    }

    var frag = document.createDocumentFragment();
    games.forEach(function (game, i) {
      frag.appendChild(tile(game, {
        no: opts.numbered ? i + 1 : 0,
        desc: opts.desc,
        onFavorite: opts.onFavorite
      }));
    });
    container.appendChild(frag);
    return games.length;
  }

  /* Renders the dense table view. */
  function renderList(container, games, opts) {
    if (!container) return 0;
    opts = opts || {};
    container.innerHTML = "";

    if (!games.length) {
      container.appendChild(emptyBlock({
        title: opts.emptyTitle, body: opts.emptyBody, action: opts.emptyAction
      }));
      return 0;
    }

    var head = el("div", "rows-head");
    ["#", "Title", "Category", "Compatibility", "You", ""].forEach(function (h) {
      head.appendChild(el("span", null, h));
    });
    container.appendChild(head);

    var frag = document.createDocumentFragment();
    games.forEach(function (game, i) {
      frag.appendChild(row(game, i + 1, opts));
    });
    container.appendChild(frag);
    return games.length;
  }

  /* ---- toasts ---- */

  var host = null;
  function toast(message, ms) {
    if (!host) {
      host = el("div", "toasts");
      document.body.appendChild(host);
    }
    var node = el("div", "toast", message);
    host.appendChild(node);
    window.setTimeout(function () { node.remove(); }, ms || 2100);
  }

  /* Chat attachments arrive differently per backend: the Node API serves a
     real URL, while PostgREST can only hand back base64 in a JSON row. The
     adapter attaches a `fetchData` loader in that case, so renderers set the
     source through here and don't have to care which backend is live. */
  function attachImage(img, image) {
    if (!image) return img;
    if (typeof image.fetchData === "function") {
      img.dataset.loading = "1";
      image.fetchData().then(function (src) {
        if (src) img.src = src;
        delete img.dataset.loading;
      }).catch(function () {
        img.remove();
      });
    } else {
      img.src = image.url;
    }
    return img;
  }

  /* ---- image lightbox ---- */

  function lightbox(src, alt) {
    var view = el("div", "shot-view");
    var img = el("img");
    img.src = src;
    img.alt = alt || "";
    view.appendChild(img);
    view.addEventListener("click", function () { view.remove(); });
    document.addEventListener("keydown", function esc(event) {
      if (event.key === "Escape") { view.remove(); document.removeEventListener("keydown", esc); }
    });
    document.body.appendChild(view);
  }

  /* Delegated once, so every chat image everywhere is zoomable without each
     renderer having to remember to wire it. */
  document.addEventListener("click", function (event) {
    var img = event.target.closest && event.target.closest("img.dock-img, img.chat-img");
    if (img) { event.preventDefault(); lightbox(img.src, img.alt); }
  });

  /* ---- url helpers ---- */

  function params() { return new URLSearchParams(window.location.search); }

  function setParams(map, replace) {
    var qs = new URLSearchParams(window.location.search);
    Object.keys(map).forEach(function (key) {
      var value = map[key];
      if (value === "" || value == null || value === false) qs.delete(key);
      else qs.set(key, value);
    });
    var next = window.location.pathname + (qs.toString() ? "?" + qs.toString() : "");
    if (replace) window.history.replaceState({}, "", next);
    else window.history.pushState({}, "", next);
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, self = this;
      window.clearTimeout(t);
      t = window.setTimeout(function () { fn.apply(self, args); }, ms || 180);
    };
  }

  window.UI = {
    el: el,
    pad: pad,
    tile: tile,
    row: row,
    render: render,
    renderList: renderList,
    emptyBlock: emptyBlock,
    riskFlag: riskFlag,
    riskLabel: riskLabel,
    launchLabel: launchLabel,
    coverInto: coverInto,
    playHref: playHref,
    attachImage: attachImage,
    lightbox: lightbox,
    toast: toast,
    formatDuration: formatDuration,
    formatWhen: formatWhen,
    params: params,
    setParams: setParams,
    debounce: debounce
  };
})();

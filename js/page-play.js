/* Player page: loads one title, tracks playtime, falls back to a new tab when
   a game refuses to be framed. */
(function () {
  "use strict";

  var game = null;
  var frame = null;
  var since = 0;
  var tall = false;
  var loaded = false;

  function $(id) { return document.getElementById(id); }
  function stage() { return $("stage"); }
  function curtain() { return $("curtain"); }

  /* ------------------------------------------------------------------ boot */

  function init() {
    var UI = window.UI;
    game = window.Catalog.byId(UI.params().get("id") || "");

    if (!game) {
      $("missing").hidden = false;
      $("miss-random").addEventListener("click", window.Shell.playRandom);
      document.title = "Not found — " + window.SITE.name;
      return;
    }

    $("player").hidden = false;
    document.title = game.title + " — " + window.SITE.name;
    var meta = document.querySelector('meta[name="description"]');
    if (meta && game.description) meta.setAttribute("content", game.description);

    details();
    actions();
    stars();
    window.UI.render($("g-related"), window.Catalog.related(game, 12), { desc: false });

    if (game.unavailable) unavailable();
    else if (game.embeddable && !game.preferDirect) embed();
    else prompt();

    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        flush();
        /* Tabbing away is the most common way a session ends, so treat it as
           a save point rather than waiting for the interval. */
        if (playedLongEnough()) backupProgress("hidden");
      } else if (frame) {
        since = Date.now();
      }
    });

    window.addEventListener("beforeunload", function () {
      flush();
      if (playedLongEnough()) backupProgress("unload");
    });
    window.setInterval(flush, 30000);

    window.Session.ready.then(watchProgress);
    document.addEventListener("session:change", watchProgress);
  }

  /* --------------------------------------------------------------- details */

  function details() {
    var UI = window.UI;

    $("crumb").textContent = game.categoryLabel + " · " + game.id;
    $("g-title").textContent = game.title;
    $("g-desc").textContent = game.description || "No description on file for this one.";

    var catHref = "browse.html?category=" + game.category;
    $("cat-link").href = catHref;
    $("cat-link").textContent = game.categoryLabel + " →";

    var flags = $("g-flags");
    flags.appendChild(UI.riskFlag(game));
    var launch = UI.el("span", "flag " + (game.embeddable && !game.preferDirect ? "flag-good" : "flag-warn"),
      game.embeddable && !game.preferDirect ? "Plays in page" : "Opens a new tab");
    flags.appendChild(launch);
    if (game.platform === "local") flags.appendChild(UI.el("span", "flag", "Hosted here"));

    /* Pre-fills the game on the feedback form, so a broken title takes one
       click to report from the place you noticed it. */
    $("a-report").href = "feedback.html?game=" + encodeURIComponent(game.id);

    $("m-cat").textContent = game.categoryLabel;
    $("m-risk").textContent = UI.riskLabel(game);
    $("m-launch").textContent = UI.launchLabel(game);

    counters();
    pinButton(window.Store.isFavorite(game.id));
  }

  function counters() {
    var UI = window.UI;
    var s = window.Store.statFor(game.id);
    $("m-plays").textContent = s.plays;
    $("m-time").textContent = UI.formatDuration(s.seconds);
    $("m-last").textContent = UI.formatWhen(s.last);
  }

  function pinButton(on) {
    var b = $("a-pin");
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.textContent = on ? "★ Pinned" : "☆ Pin";
  }

  /* ----------------------------------------------------------------- stage */

  function embed() {
    var url = game.sourceUrl || game.directUrl;
    if (!url) { prompt("This entry has no playable URL on file."); return; }

    if (frame) frame.remove();
    frame = document.createElement("iframe");
    frame.src = url;
    frame.title = game.title;
    frame.allow = "autoplay; fullscreen; gamepad; clipboard-write";
    frame.setAttribute("allowfullscreen", "");
    if (game.sandbox) frame.setAttribute("sandbox", game.sandbox);

    loaded = false;
    showLoading(true);
    frame.addEventListener("load", function () {
      loaded = true;
      showLoading(false);
      window.setTimeout(function () { try { frame.focus(); } catch (e) {} }, 60);
    });
    stage().insertBefore(frame, curtain());

    curtain().hidden = true;
    window.Store.recordPlay(game.id);
    window.Store.pushRecent(game.id);
    since = Date.now();
    counters();
    $("a-play").textContent = "↻ Reload";

    if (window.Store.settings().autoFullscreen) fullscreen();
    watchdog();
  }

  /* No repo carries this title's files. Say so, rather than loading a frame
     that will only ever 404. */
  function unavailable() {
    var c = curtain();
    c.hidden = false;
    c.dataset.mode = "gone";
    $("c-label").textContent = "Unavailable";
    $("c-title").textContent = "This one isn't hosted anywhere";
    $("c-body").textContent =
      "It's still listed so the index stays honest, but none of the game hosts " +
      "carry its files. Nothing to load.";
    $("c-action").textContent = "⇢ Play something else";
    $("c-alt").hidden = true;

    ["a-play", "a-full", "a-tab"].forEach(function (id) { $(id).disabled = true; });
  }

  function prompt(reason) {
    var c = curtain();
    c.hidden = false;
    c.dataset.mode = "direct";
    $("c-label").textContent = reason ? "Blocked" : "External";
    $("c-title").textContent = reason ? "Can't load in the page" : "This one opens in its own tab";
    $("c-body").textContent = reason ||
      "The game refuses to be framed, so it runs in a fresh tab. Your time still counts.";
    $("c-action").textContent = "↗ Open " + game.title;

    var alt = $("c-alt");
    alt.hidden = false;
    alt.textContent = "Try loading it in the page anyway";
  }

  function newTab() {
    var url = game.directUrl || game.sourceUrl;
    if (!url) { window.UI.toast("No launch URL on file"); return; }
    var win = window.open(url, "_blank", "noopener");
    if (!win) { window.UI.toast("Pop-up blocked — allow it and retry"); return; }
    window.Store.recordPlay(game.id);
    window.Store.pushRecent(game.id);
    counters();
  }

  function fullscreen() {
    var node = stage();
    var req = node.requestFullscreen || node.webkitRequestFullscreen || node.msRequestFullscreen;
    if (!req) { window.UI.toast("Fullscreen unavailable here"); return; }
    var out = req.call(node);
    if (out && out.catch) out.catch(function () { window.UI.toast("Fullscreen was blocked"); });
  }

  /* Some of these are large Unity builds on a CDN, so a blank black box for
     ten seconds is normal, not broken. Say so instead of showing nothing. */
  function showLoading(on) {
    var box = $("stage-loading");
    if (!box) return;
    box.hidden = !on;
  }

  /* If a framed game never loads at all, offer the new-tab route.
     This used to read frame.contentDocument, which silently stopped working
     the moment games moved to their own origin — cross-origin access always
     throws, and the catch treated that as success, so the fallback could
     never fire. The load event crosses origins; the document does not. */
  function watchdog() {
    window.setTimeout(function () {
      if (!frame || loaded) return;
      showLoading(false);
      var c = curtain();
      c.hidden = false;
      c.dataset.mode = "direct";
      $("c-label").textContent = "Timed out";
      $("c-title").textContent = "This one is taking too long";
      $("c-body").textContent =
        "It may be blocked on this network, or the host is slow. A separate " +
        "tab usually works — the game keeps loading there.";
      $("c-action").textContent = "↗ Open in a new tab";
      $("c-alt").hidden = false;
      $("c-alt").textContent = "Keep waiting";
    }, 20000);
  }

  /* -------------------------------------------------------------- playtime */

  function flush() {
    if (!since) return;
    var seconds = (Date.now() - since) / 1000;
    since = document.hidden ? 0 : Date.now();
    window.Store.addSeconds(game.id, seconds);
    counters();
  }

  /* ------------------------------------------------------- progress backup */

  /* The game writes its own progress into its origin's localStorage as you
     play. Backing that up only when someone remembers to press a button in
     Settings is how saves get lost, so it happens here instead: once the
     session has been long enough to be worth keeping, and again on the way
     out. Silent — it is not something to interrupt play over. */
  var MIN_SESSION = 45;          // seconds before a backup is worth doing
  var backupTimer = null;
  var lastBackup = 0;

  /* A two-second glance at a game has no progress worth storing, and backing
     up then would only overwrite a good save with an empty one. */
  function playedLongEnough() {
    if (!since) return false;
    return (Date.now() - since) / 1000 >= MIN_SESSION ||
           window.Store.statFor(game.id).seconds >= MIN_SESSION;
  }

  function canBackup() {
    return window.GameSaves && window.Session && window.Session.user &&
           game && game.host && !game.unavailable;
  }

  function markSaved(text, tone) {
    var badge = $("save-state");
    if (!badge) return;
    badge.hidden = false;
    badge.textContent = text;
    badge.className = "save-state" + (tone ? " " + tone : "");
  }

  function backupProgress(reason) {
    if (!canBackup()) return Promise.resolve();
    if (Date.now() - lastBackup < 20000) return Promise.resolve();
    lastBackup = Date.now();

    var origin = (window.SITE.gameHosts || {})[game.host];
    if (!origin) return Promise.resolve();

    return window.GameSaves.readAll(window.GameSaves.hostKey(origin))
      .then(function (res) {
        var keys = Object.keys(res.data || {});
        if (!keys.length) return null;
        return window.API.putGameSave(res.host, res.data).then(function () {
          markSaved("progress saved", "ok");
          return keys.length;
        });
      })
      .catch(function () {
        /* Offline, bridge not deployed, or storage blocked — say so quietly
           rather than pretending it worked. */
        markSaved("progress not synced", "warn");
      });
  }

  function watchProgress() {
    if (!canBackup()) return;
    markSaved("progress syncs to your account", "");
    window.clearInterval(backupTimer);
    backupTimer = window.setInterval(function () {
      if (!document.hidden && frame) backupProgress("interval");
    }, 120000);
  }

  /* --------------------------------------------------------------- actions */

  function actions() {
    $("a-play").addEventListener("click", function () {
      if (game.embeddable && !game.preferDirect) embed();
      else newTab();
    });

    $("c-action").addEventListener("click", function () {
      var mode = curtain().dataset.mode;
      if (mode === "gone") window.Shell.playRandom();
      else if (mode === "embed") embed();
      else newTab();
    });

    $("c-alt").addEventListener("click", function () {
      curtain().dataset.mode = "embed";
      embed();
    });

    $("a-tab").addEventListener("click", function () {
      if (window.Store.settings().confirmExternal &&
          !window.confirm("Open " + game.title + " in a new tab?")) return;
      newTab();
    });

    $("a-full").addEventListener("click", function () {
      if (!frame) {
        if (game.embeddable) embed();
        else { newTab(); return; }
      }
      fullscreen();
    });

    $("a-pin").addEventListener("click", function () {
      var on = window.Store.toggleFavorite(game.id);
      pinButton(on);
      window.UI.toast(on ? "Pinned" : "Unpinned");
    });

    var aspect = $("a-aspect");
    aspect.addEventListener("click", function () {
      tall = !tall;
      stage().classList.toggle("tall", tall);
      aspect.textContent = tall ? "16:9" : "4:3";
    });

    $("a-share").addEventListener("click", function () {
      var url = window.location.href;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(
          function () { window.UI.toast("Link copied"); },
          function () { window.prompt("Copy this link:", url); }
        );
      } else {
        window.prompt("Copy this link:", url);
      }
    });

    document.addEventListener("keydown", function (event) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      var t = event.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (event.key === "f" || event.key === "F") $("a-pin").click();
      else if (event.key === "p" || event.key === "P") $("a-play").click();
    });
  }

  /* ---------------------------------------------------------------- rating */

  function stars() {
    var host = $("stars");
    host.innerHTML = "";
    var current = window.Store.ratingFor(game.id);
    for (var i = 1; i <= 5; i++) {
      (function (value) {
        var b = window.UI.el("button", value <= current ? "on" : "", value <= current ? "★" : "☆");
        b.type = "button";
        b.setAttribute("aria-label", "Rate " + value + " of 5");
        b.addEventListener("click", function () {
          var next = current === value ? 0 : value;
          window.Store.setRating(game.id, next);
          window.UI.toast(next ? "Rated " + next + "/5" : "Rating cleared");
          stars();
        });
        host.appendChild(b);
      })(i);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

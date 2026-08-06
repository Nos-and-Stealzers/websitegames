/* App chrome: the fixed rail, the mobile topbar/tabbar, the settings sheet,
   the finder palette and the global shortcuts. Every page mounts this by
   dropping <div data-shell="chrome"></div> as its first body element. */
(function () {
  "use strict";

  var SITE = window.SITE;
  var el = window.UI.el;

  var NAV = [
    { href: "index.html", icon: "◧", label: "Overview" },
    { href: "browse.html", icon: "▤", label: "All games", count: function () { return window.Catalog.all.length; } },
    { href: "categories.html", icon: "◫", label: "Categories", count: function () { return window.Catalog.categories.length; } },
    { href: "library.html", icon: "★", label: "Pinned", count: function () { return window.Store.favorites().length; } },
    { href: "stats.html", icon: "◔", label: "Activity" },
    { href: "feedback.html", icon: "✎", label: "Feedback" },
    { href: "support.html", icon: "☂", label: "Support" },
    { href: "about.html", icon: "?", label: "Manual" }
  ];

  /* Social always shows once a backend answers, signed in or not — hiding it
     when signed out just makes the features undiscoverable. Clicking through
     signed out lands on the sign-in page, which is the point. */
  var SOCIAL_NAV = [
    { href: "friends.html", icon: "◆", label: "Friends", badge: "requests" },
    { href: "messages.html", icon: "✉", label: "Messages", badge: "messages" },
    { href: "notifications.html", icon: "◈", label: "Notifications", badge: "notifications" }
  ];

  var ACCOUNT_NAV = [
    { href: "profile.html", icon: "◉", label: "My profile" },
    { href: "settings.html", icon: "⚙", label: "Settings" },
    { href: "admin.html", icon: "▲", label: "Admin", staffOnly: true }
  ];

  var TABS = [
    { href: "index.html", icon: "◧", label: "Home" },
    { href: "browse.html", icon: "▤", label: "Games" },
    { href: "categories.html", icon: "◫", label: "Cats" },
    { href: "library.html", icon: "★", label: "Pinned" },
    { href: "stats.html", icon: "◔", label: "You" }
  ];

  function page() {
    var file = window.location.pathname.split("/").pop();
    return file === "" ? "index.html" : file;
  }

  var rail, scrim;

  /* ------------------------------------------------------------------ rail */

  function buildRail(here) {
    var aside = el("aside", "rail");
    aside.id = "rail";

    var brand = el("a", "rail-brand");
    brand.href = "index.html";
    brand.appendChild(el("span", "mark", SITE.mark));
    var names = el("span");
    names.appendChild(el("span", "name", SITE.name));
    names.appendChild(el("span", "sub", SITE.build + " · " + SITE.domain));
    brand.appendChild(names);
    aside.appendChild(brand);

    var search = el("div", "rail-search");
    var box = el("div", "box");
    var input = el("input");
    input.type = "search";
    input.placeholder = "Search titles";
    input.setAttribute("aria-label", "Search games");
    input.id = "rail-q";
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && input.value.trim()) {
        window.location.href = "browse.html?q=" + encodeURIComponent(input.value.trim());
      }
    });
    box.appendChild(input);
    box.appendChild(el("span", "hint", "/"));
    search.appendChild(box);
    aside.appendChild(search);

    var nav = el("nav", "rail-nav");
    nav.setAttribute("aria-label", "Sections");

    nav.appendChild(el("span", "label", "Library"));
    NAV.forEach(function (item) {
      nav.appendChild(navLink(item, here));
    });

    /* Social + account sections fill in once Session settles. */
    var social = el("div");
    social.id = "rail-social";
    social.hidden = true;
    nav.appendChild(social);

    var account = el("div");
    account.id = "rail-account-nav";
    nav.appendChild(account);

    nav.appendChild(el("span", "label", "Shortlists"));
    [
      { href: "browse.html?embed=1", icon: "▶", label: "Plays in page",
        count: function () { return window.Catalog.filter({ embeddableOnly: true }).length; } },
      { href: "browse.html?risk=low", icon: "✓", label: "Stable only",
        count: function () { return window.Catalog.filter({ lowRiskOnly: true }).length; } },
      { href: "browse.html?sort=random", icon: "⇄", label: "Shuffled" },
      { href: "browse.html?sort=played", icon: "▲", label: "Your most played" }
    ].forEach(function (item) {
      nav.appendChild(navLink(item, ""));
    });

    aside.appendChild(nav);

    var foot = el("div", "rail-foot");

    var row = el("div", "row");
    var dice = el("button", "btn", "⇢ Random");
    dice.type = "button";
    dice.title = "Play something at random";
    dice.addEventListener("click", playRandom);

    var gear = el("button", "btn btn-sq", "⚙");
    gear.type = "button";
    gear.title = "Quick settings";
    gear.setAttribute("aria-label", "Quick settings");
    gear.setAttribute("aria-expanded", "false");
    gear.addEventListener("click", function () { toggleQuick(gear); });

    row.appendChild(dice);
    row.appendChild(gear);
    foot.appendChild(row);

    var quick = el("div", "quick");
    quick.id = "rail-quick";
    quick.hidden = true;
    foot.appendChild(quick);

    var account = el("div");
    account.id = "rail-account";
    foot.appendChild(account);

    var meta = el("div", "meta");
    meta.appendChild(el("div", null, window.Catalog.all.length + " titles indexed"));
    meta.appendChild(el("div", null, "press K to jump"));
    foot.appendChild(meta);
    aside.appendChild(foot);

    return aside;
  }

  function navLink(item, here) {
    var a = el("a");
    a.href = item.href;
    a.appendChild(el("span", "ico", item.icon));
    a.appendChild(el("span", null, item.label));
    if (item.count) {
      a.appendChild(el("span", "n", item.count()));
    }
    if (item.badge) {
      var b = el("span", "badge");
      b.dataset.badge = item.badge;
      b.hidden = true;
      a.appendChild(b);
    }
    if (item.href === here) a.setAttribute("aria-current", "page");
    return a;
  }

  /* ------------------------------------------------------- account block */

  function actionLink(href, icon, label, className) {
    var a = el("a", className || null);
    a.href = href;
    a.appendChild(el("span", "ico", icon));
    a.appendChild(el("span", null, label));
    return a;
  }

  function buildAccountBlock(here) {
    var social = document.getElementById("rail-social");
    var account = document.getElementById("rail-account-nav");
    var foot = document.getElementById("rail-account");
    if (!account) return;

    var hasBackend = window.Session && window.Session.backend;
    var user = hasBackend ? window.Session.user : null;

    /* ---- social ---- */
    if (social) {
      social.innerHTML = "";
      social.hidden = !hasBackend;
      if (hasBackend) {
        social.appendChild(el("span", "label", "Social"));
        SOCIAL_NAV.forEach(function (item) { social.appendChild(navLink(item, here)); });
      }
    }

    /* ---- account ---- */
    account.innerHTML = "";
    account.appendChild(el("span", "label", "Account"));

    if (hasBackend && !user) {
      account.appendChild(actionLink("login.html", "→", "Sign in", "signin"));
      account.appendChild(actionLink("signup.html", "＋", "Create account"));
    } else if (user) {
      ACCOUNT_NAV.forEach(function (item) {
        if (item.staffOnly && !window.Session.isStaff()) return;
        account.appendChild(navLink(item, here));
      });
    }

    /* Display preferences work with no backend and no account, so this entry
       is here unconditionally — it's the one people hunt for. */
    var prefs = el("a");
    prefs.href = "#";
    prefs.appendChild(el("span", "ico", "◐"));
    prefs.appendChild(el("span", null, "Display & skins"));
    prefs.addEventListener("click", function (event) {
      event.preventDefault();
      openSettings();
    });
    account.appendChild(prefs);

    /* ---- identity strip in the rail foot ---- */
    if (foot) {
      foot.innerHTML = "";
      if (user) {
        var who = el("a", "whoami");
        who.href = "profile.html";
        var pic = el("span", "avatar");
        pic.appendChild(window.Art.avatar(user.username));
        who.appendChild(pic);
        var names = el("span", "names");
        names.appendChild(el("span", "n1", user.displayName || user.username));
        names.appendChild(el("span", "n2", "@" + user.username +
          (user.role !== "user" ? " · " + user.role : "")));
        who.appendChild(names);
        foot.appendChild(who);

        var out = el("button", "btn btn-sm btn-flat", "Sign out");
        out.type = "button";
        out.style.width = "100%";
        out.style.marginTop = "0.5rem";
        out.addEventListener("click", function () {
          out.disabled = true;
          window.Session.logout().then(function () { window.location.reload(); });
        });
        foot.appendChild(out);
      } else if (hasBackend) {
        var cta = el("a", "btn btn-cta", "Sign in");
        cta.href = "login.html";
        cta.style.width = "100%";
        foot.appendChild(cta);
      }
    }

    paintBadges(window.Session ? window.Session.badges : null);
  }

  function paintBadges(counts) {
    document.querySelectorAll("[data-badge]").forEach(function (node) {
      var n = (counts && counts[node.dataset.badge]) || 0;
      node.textContent = n > 99 ? "99+" : String(n);
      node.hidden = n === 0;
    });
  }

  /* Toast when something new lands mid-session. `seen` starts null so the
     first poll after a page load never fires — otherwise every navigation
     would re-announce everything already waiting. */
  var seen = null;

  function announce(counts) {
    if (!counts) return;
    var total = (counts.notifications || 0) + (counts.messages || 0);
    if (seen !== null && total > seen) {
      var fresh = total - seen;
      window.UI.toast(fresh === 1 ? "1 new notification" : fresh + " new notifications");
      pulse();
    }
    seen = total;
  }

  function pulse() {
    document.querySelectorAll('[data-badge="notifications"], [data-badge="messages"]')
      .forEach(function (node) {
        if (node.hidden) return;
        node.classList.remove("pop");
        void node.offsetWidth;      // restart the animation
        node.classList.add("pop");
      });
  }

  /* -------------------------------------------------------- mobile chrome */

  function buildTopbar() {
    var bar = el("header", "topbar");
    var burger = el("button", "btn btn-sq", "≡");
    burger.type = "button";
    burger.setAttribute("aria-label", "Open menu");
    burger.setAttribute("aria-controls", "rail");
    burger.setAttribute("aria-expanded", "false");
    burger.addEventListener("click", function () { toggleRail(true); });
    bar.appendChild(burger);

    bar.appendChild(el("span", "mark", SITE.mark));
    bar.appendChild(el("span", "name", SITE.name));

    var spacer = el("span");
    spacer.style.flex = "1";
    bar.appendChild(spacer);

    var find = el("button", "btn btn-sq", "⌕");
    find.type = "button";
    find.setAttribute("aria-label", "Find a game");
    find.addEventListener("click", openFinder);
    bar.appendChild(find);

    /* Bell with its own badge — the mobile equivalent of the rail entry. */
    var bell = el("a", "btn btn-sq bell");
    bell.href = "notifications.html";
    bell.setAttribute("aria-label", "Notifications");
    bell.appendChild(el("span", null, "◈"));
    var mark = el("span", "badge dot-badge");
    mark.dataset.badge = "notifications";
    mark.hidden = true;
    bell.appendChild(mark);
    bar.appendChild(bell);

    return bar;
  }

  function buildTabbar(here) {
    var nav = el("nav", "tabbar");
    nav.setAttribute("aria-label", "Primary");
    TABS.forEach(function (tab) {
      var a = el("a");
      a.href = tab.href;
      a.appendChild(el("span", "ico", tab.icon));
      a.appendChild(el("span", null, tab.label));
      if (tab.href === here) a.setAttribute("aria-current", "page");
      nav.appendChild(a);
    });
    return nav;
  }

  function toggleRail(open) {
    if (!rail) return;
    rail.classList.toggle("open", open);
    scrim.hidden = !open;
    var burger = document.querySelector(".topbar .btn");
    if (burger) burger.setAttribute("aria-expanded", open ? "true" : "false");
  }

  /* ------------------------------------------------------- quick settings */

  /* The gear used to open the same modal as the full Settings page, which was
     both redundant and slower than just going there. It is now an inline
     panel with the three things people actually change often — skin, text
     size, motion — and a link to the rest. */
  function toggleQuick(gear) {
    var panel = document.getElementById("rail-quick");
    if (!panel) return;

    var open = panel.hidden;
    panel.hidden = !open;
    gear.setAttribute("aria-expanded", open ? "true" : "false");
    if (!open) return;

    panel.innerHTML = "";
    var s = window.Store.settings();

    /* --- skins --- */
    panel.appendChild(el("span", "label", "Skin"));
    var swatches = el("div", "quick-skins");
    SITE.skins.forEach(function (skin) {
      var b = el("button", "quick-skin");
      b.type = "button";
      b.title = skin.label;
      b.setAttribute("aria-label", skin.label);
      b.setAttribute("aria-pressed", s.skin === skin.id ? "true" : "false");
      b.style.background = "linear-gradient(135deg," + skin.chips[0] + " 55%," +
                           skin.chips[1] + " 55%)";
      b.addEventListener("click", function () {
        window.Store.setSetting("skin", skin.id);
        document.documentElement.setAttribute("data-skin", skin.id);
        swatches.querySelectorAll(".quick-skin").forEach(function (n) {
          n.setAttribute("aria-pressed", n === b ? "true" : "false");
        });
      });
      swatches.appendChild(b);
    });
    panel.appendChild(swatches);

    /* --- text size --- */
    panel.appendChild(el("span", "label", "Text"));
    var sizes = el("div", "quick-seg");
    [["normal", "A"], ["large", "A"], ["huge", "A"]].forEach(function (pair, i) {
      var b = el("button", "quick-size", pair[1]);
      b.type = "button";
      b.style.fontSize = [0.75, 0.9, 1.1][i] + "rem";
      b.title = pair[0];
      b.setAttribute("aria-label", "Text size " + pair[0]);
      b.setAttribute("aria-pressed", s.textSize === pair[0] ? "true" : "false");
      b.addEventListener("click", function () {
        window.Store.setSetting("textSize", pair[0]);
        document.documentElement.setAttribute("data-text", pair[0]);
        sizes.querySelectorAll(".quick-size").forEach(function (n) {
          n.setAttribute("aria-pressed", n === b ? "true" : "false");
        });
      });
      sizes.appendChild(b);
    });
    panel.appendChild(sizes);

    /* --- switches --- */
    [
      ["motion", "Animations", "data-motion"],
      ["lite", "Lite mode", "data-lite"]
    ].forEach(function (spec) {
      var row = el("label", "quick-row");
      row.appendChild(el("span", null, spec[1]));
      var wrap = el("span", "toggle");
      var input = el("input");
      input.type = "checkbox";
      input.checked = !!s[spec[0]];
      input.addEventListener("change", function () {
        window.Store.setSetting(spec[0], input.checked);
        document.documentElement.setAttribute(spec[2], input.checked ? "on" : "off");
      });
      wrap.appendChild(input);
      wrap.appendChild(el("i"));
      row.appendChild(wrap);
      panel.appendChild(row);
    });

    var more = el("a", "quick-more", "All settings →");
    more.href = "settings.html";
    panel.appendChild(more);
  }

  /* -------------------------------------------------------------- settings */

  var sheet = null;

  function opt(k, d, control) {
    var row = el("div", "opt");
    var text = el("div");
    text.appendChild(el("div", "k", k));
    if (d) text.appendChild(el("div", "d", d));
    row.appendChild(text);
    row.appendChild(control);
    return row;
  }

  function toggle(checked, onChange) {
    var wrap = el("label", "toggle");
    var input = el("input");
    input.type = "checkbox";
    input.checked = !!checked;
    input.addEventListener("change", function () { onChange(input.checked); });
    wrap.appendChild(input);
    wrap.appendChild(el("i"));
    return wrap;
  }

  function buildSettings() {
    var root = el("div", "sheet");
    root.hidden = true;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "Settings");

    var card = el("div", "sheet-card");
    var head = el("div", "sheet-head");
    head.appendChild(el("span", "label", "Settings"));
    var x = el("button", "btn btn-sq", "✕");
    x.type = "button";
    x.setAttribute("aria-label", "Close");
    x.addEventListener("click", closeSettings);
    head.appendChild(x);
    card.appendChild(head);

    var body = el("div", "sheet-body");
    var s = window.Store.settings();

    var skins = el("div", "skins");
    SITE.skins.forEach(function (skin) {
      var b = el("button", "skin");
      b.type = "button";
      b.title = skin.label;
      b.setAttribute("aria-label", skin.label + " skin");
      b.setAttribute("aria-pressed", s.skin === skin.id ? "true" : "false");
      skin.chips.forEach(function (c) {
        var i = el("i");
        i.style.background = c;
        b.appendChild(i);
      });
      b.addEventListener("click", function () {
        window.Store.setSetting("skin", skin.id);
        document.documentElement.setAttribute("data-skin", skin.id);
        skins.querySelectorAll(".skin").forEach(function (node) {
          node.setAttribute("aria-pressed", node === b ? "true" : "false");
        });
        window.UI.toast("Skin · " + skin.label);
      });
      skins.appendChild(b);
    });
    body.appendChild(opt("Skin", "Five palettes. Saved on this device.", skins));

    body.appendChild(opt("Lite mode", "Kills motion and the grid overlay on slow machines.",
      toggle(s.lite, function (on) {
        window.Store.setSetting("lite", on);
        document.documentElement.setAttribute("data-lite", on ? "on" : "off");
      })));

    body.appendChild(opt("Auto fullscreen", "Expand the stage as soon as a game loads.",
      toggle(s.autoFullscreen, function (on) { window.Store.setSetting("autoFullscreen", on); })));

    body.appendChild(opt("Confirm new-tab launches", "Ask before opening a game outside the page.",
      toggle(s.confirmExternal, function (on) { window.Store.setSetting("confirmExternal", on); })));

    var acts = el("div", "row");
    acts.style.display = "flex";
    acts.style.gap = "0.35rem";
    [["Export", exportSave], ["Import", importSave], ["Wipe", wipe]].forEach(function (pair) {
      var b = el("button", "btn btn-sm", pair[0]);
      b.type = "button";
      b.addEventListener("click", pair[1]);
      acts.appendChild(b);
    });
    body.appendChild(opt("Your data", "Pins, history and playtime never leave this browser.", acts));

    var keys = el("p", "tiny dimmer");
    keys.style.margin = "1rem 0 0";
    keys.innerHTML =
      "<kbd>/</kbd> search &nbsp; <kbd>K</kbd> finder &nbsp; <kbd>R</kbd> random &nbsp; " +
      "<kbd>P</kbd> play &nbsp; <kbd>F</kbd> pin &nbsp; <kbd>Esc</kbd> close";
    body.appendChild(keys);

    card.appendChild(body);
    root.appendChild(card);
    root.addEventListener("click", function (e) { if (e.target === root) closeSettings(); });
    document.body.appendChild(root);
    return root;
  }

  function openSettings() {
    if (!sheet) sheet = buildSettings();
    sheet.hidden = false;
    var first = sheet.querySelector(".skin");
    if (first) first.focus();
  }
  function closeSettings() { if (sheet) sheet.hidden = true; }

  function exportSave() {
    var blob = new Blob([JSON.stringify(window.Store.exportAll(), null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "arcade-hub-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
    window.UI.toast("Save exported");
  }

  function importSave() {
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
          window.UI.toast("Save imported");
          window.setTimeout(function () { window.location.reload(); }, 450);
        } catch (err) {
          window.UI.toast("Could not read that file");
        }
      };
      reader.readAsText(file);
    });
    input.click();
  }

  function wipe() {
    if (window.confirm("Erase pins, history and playtime on this device?")) {
      window.Store.resetAll();
      window.location.reload();
    }
  }

  /* ---------------------------------------------------------------- finder */

  var finder = null, finderInput = null, hits = [], hitList = null, cursor = 0;

  function buildFinder() {
    var root = el("div", "finder");
    root.hidden = true;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "Find a game");

    var card = el("div", "finder-card");
    finderInput = el("input");
    finderInput.type = "search";
    finderInput.placeholder = "Type a title…";
    finderInput.setAttribute("aria-label", "Type a title");
    card.appendChild(finderInput);

    hitList = el("ul", "hits");
    card.appendChild(hitList);

    var foot = el("div", "finder-foot");
    foot.innerHTML = "<span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>⏎</kbd> open</span>" +
      "<span><kbd>Esc</kbd> close</span>";
    card.appendChild(foot);

    root.appendChild(card);
    root.addEventListener("click", function (e) { if (e.target === root) closeFinder(); });

    finderInput.addEventListener("input", function () { fillFinder(finderInput.value); });
    finderInput.addEventListener("keydown", function (event) {
      if (event.key === "ArrowDown") { event.preventDefault(); moveCursor(1); }
      else if (event.key === "ArrowUp") { event.preventDefault(); moveCursor(-1); }
      else if (event.key === "Enter" && hits[cursor]) {
        window.location.href = window.UI.playHref(hits[cursor]);
      }
    });

    document.body.appendChild(root);
    return root;
  }

  function fillFinder(query) {
    var Catalog = window.Catalog;
    hits = query.trim()
      ? Catalog.search(query).slice(0, 14)
      : Catalog.recentGames(5).concat(Catalog.daily(9));
    hits = hits.filter(function (g, i, arr) { return arr.indexOf(g) === i; }).slice(0, 14);
    cursor = 0;
    hitList.innerHTML = "";

    if (!hits.length) {
      var li = el("li");
      var p = el("span", "tiny dimmer", "No titles match that.");
      p.style.display = "block";
      p.style.padding = "0.8rem 1rem";
      li.appendChild(p);
      hitList.appendChild(li);
      return;
    }

    hits.forEach(function (g, i) {
      var li = el("li");
      if (i === 0) li.className = "on";
      var a = el("a");
      a.href = window.UI.playHref(g);
      var sw = el("span", "sw");
      sw.appendChild(window.Art.cover(g, { plain: true }));
      a.appendChild(sw);
      a.appendChild(el("span", null, g.title));
      a.appendChild(el("span", "c", g.categoryLabel));
      li.appendChild(a);
      hitList.appendChild(li);
    });
  }

  function moveCursor(delta) {
    var items = hitList.querySelectorAll("li");
    if (!items.length || !hits.length) return;
    if (items[cursor]) items[cursor].classList.remove("on");
    cursor = (cursor + delta + hits.length) % hits.length;
    items[cursor].classList.add("on");
    items[cursor].scrollIntoView({ block: "nearest" });
  }

  function openFinder() {
    if (!finder) finder = buildFinder();
    finder.hidden = false;
    finderInput.value = "";
    fillFinder("");
    finderInput.focus();
  }
  function closeFinder() { if (finder) finder.hidden = true; }

  /* ------------------------------------------------------------- shortcuts */

  function playRandom() {
    var g = window.Catalog.randomGame();
    if (g) window.location.href = window.UI.playHref(g);
  }

  function typing(target) {
    if (!target) return false;
    var tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
  }

  function bindKeys() {
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        closeFinder(); closeSettings(); toggleRail(false);
        return;
      }

      /* Staff jump to the console with a modifier combo, so it works even
         while a game is running — the single-key shortcuts deliberately do
         not. Configurable, because Ctrl+P is the browser's print dialog and
         some people would rather keep that. */
      if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        var combo = (window.Store.settings().adminKey || "p").toLowerCase();
        if (combo && event.key.toLowerCase() === combo &&
            window.Session && window.Session.isStaff()) {
          event.preventDefault();
          window.location.href = "admin.html";
        }
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (typing(event.target)) return;
      if (!window.Store.settings().shortcuts) return;

      /* A running game owns the keyboard. R would navigate away from it and
         K would drop a dialog over it — both from a stray keypress after the
         iframe lost focus. Escape above still works, deliberately. */
      if (document.body.dataset.gameActive) return;

      if (event.key === "/") {
        event.preventDefault();
        var box = document.getElementById("page-q") || document.getElementById("rail-q");
        if (box && box.offsetParent !== null) box.focus();
        else openFinder();
      } else if (event.key === "k" || event.key === "K") {
        event.preventDefault(); openFinder();
      } else if (event.key === "r" || event.key === "R") {
        playRandom();
      } else if (event.key === "?") {
        openSettings();
      }
    });
  }

  /* ------------------------------------------------------------------ boot */

  function boot() {
    var mount = document.querySelector('[data-shell="chrome"]');
    var here = page();

    if (mount) {
      var frag = document.createDocumentFragment();
      rail = buildRail(here);
      scrim = el("div", "scrim");
      scrim.hidden = true;
      scrim.addEventListener("click", function () { toggleRail(false); });
      frag.appendChild(buildTopbar());
      frag.appendChild(rail);
      frag.appendChild(scrim);
      mount.replaceWith(frag);
      document.body.appendChild(buildTabbar(here));
    }

    var foot = document.querySelector('[data-shell="foot"]');
    if (foot) {
      var f = el("div", "foot");
      f.appendChild(el("span", null, SITE.name + " · " + SITE.build + " · " +
        window.Catalog.all.length + " titles"));
      var links = el("span");
      [["Manual", "about.html"], ["All games", "browse.html"], ["Categories", "categories.html"]]
        .forEach(function (pair, i) {
          if (i) links.appendChild(document.createTextNode(" · "));
          var a = el("a", null, pair[0]);
          a.href = pair[1];
          links.appendChild(a);
        });
      f.appendChild(links);
      f.appendChild(el("span", null, "stored locally · no accounts · no tracking"));
      foot.replaceWith(f);
    }

    bindKeys();

    /* Render once immediately so "Display & skins" is there even with no
       backend, then again when the session resolves. */
    buildAccountBlock(here);
    if (window.Session) {
      window.Session.ready.then(function () { buildAccountBlock(here); });
      document.addEventListener("session:change", function () { buildAccountBlock(here); });
      document.addEventListener("session:badges", function (e) {
        paintBadges(e.detail);
        announce(e.detail);
      });
    }

    if ("serviceWorker" in navigator && window.location.protocol.indexOf("http") === 0) {
      navigator.serviceWorker.register("sw.js").catch(function () { /* optional */ });
    }
  }

  window.Shell = {
    openSettings: openSettings,
    openFinder: openFinder,
    playRandom: playRandom
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

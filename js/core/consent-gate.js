/* Mandatory consent gate.
 *
 * Everyone must accept the Terms of Use and Privacy Notice before using the
 * site. This shows a blocking, non-dismissible overlay on the first visit and
 * again whenever the policy version changes, records the acceptance (locally
 * always, and against the account when signed in), and only then lets the page
 * be used.
 *
 * It is deliberately dependency-free and injects its own styles, so it works
 * on every page regardless of load order and even if something else is broken.
 * It runs as early as possible and, crucially, does NOT gate the two policy
 * pages themselves or the auth pages — you have to be able to read what you're
 * agreeing to, and an already-signed-in flow shouldn't deadlock.
 */
(function () {
  "use strict";

  /* Bump this when Terms/Privacy change materially. Must match the versions
     shown on terms.html / privacy.html. Changing it re-prompts everyone. */
  var POLICY_VERSION = "2026-09-10";
  var LS_KEY = "ach:consent";

  /* Pages that must stay reachable without having accepted yet. */
  var EXEMPT = [
    "terms.html", "privacy.html", "login.html", "signup.html",
    "forgot-password.html", "reset-password.html", "404.html"
  ];

  function currentPage() {
    var path = String(location.pathname || "");
    var last = path.split("/").pop();
    return last || "index.html";
  }

  function alreadyAccepted() {
    try {
      var raw = window.localStorage.getItem(LS_KEY);
      if (!raw) return false;
      var rec = JSON.parse(raw);
      return rec && rec.version === POLICY_VERSION;
    } catch (e) { return false; }
  }

  function record() {
    var rec = { version: POLICY_VERSION, at: new Date().toISOString() };
    try { window.localStorage.setItem(LS_KEY, JSON.stringify(rec)); } catch (e) {}
    /* Best-effort: also stamp it on the account if one is signed in and the
       API supports it. Never blocks the UI on this. */
    try {
      if (window.API && typeof window.API.acceptPolicy === "function") {
        window.API.acceptPolicy(POLICY_VERSION).catch(function () {});
      }
    } catch (e) {}
  }

  function injectStyles() {
    if (document.getElementById("consent-gate-style")) return;
    var css =
      "#consent-gate{position:fixed;inset:0;z-index:2147483000;display:flex;" +
      "align-items:center;justify-content:center;padding:1.25rem;" +
      "background:rgba(4,5,8,.86);backdrop-filter:blur(6px);" +
      "-webkit-backdrop-filter:blur(6px);font-family:system-ui,-apple-system," +
      "'Segoe UI',Roboto,sans-serif;}" +
      "#consent-gate .cg-card{max-width:34rem;width:100%;max-height:90vh;" +
      "overflow:auto;background:#14161c;color:#e9edf3;border:1px solid #2a2f3a;" +
      "border-radius:16px;padding:1.6rem 1.6rem 1.4rem;box-shadow:0 24px 80px " +
      "rgba(0,0,0,.6);}" +
      "#consent-gate h2{margin:.1rem 0 .2rem;font-size:1.35rem;line-height:1.2;}" +
      "#consent-gate .cg-mark{display:inline-flex;align-items:center;gap:.5rem;" +
      "font-weight:700;letter-spacing:.02em;color:#ff5c33;margin-bottom:.6rem;}" +
      "#consent-gate .cg-mark span{width:1.6rem;height:1.6rem;border-radius:6px;" +
      "background:#ff5c33;color:#14161c;display:inline-flex;align-items:center;" +
      "justify-content:center;font-size:.8rem;}" +
      "#consent-gate p{margin:.55rem 0;line-height:1.5;color:#c3cad6;font-size:.95rem;}" +
      "#consent-gate a{color:#ff8a6b;font-weight:600;}" +
      "#consent-gate .cg-points{margin:.6rem 0;padding-left:1.1rem;color:#c3cad6;" +
      "font-size:.9rem;line-height:1.55;}" +
      "#consent-gate .cg-check{display:flex;gap:.6rem;align-items:flex-start;" +
      "margin:1rem 0 .4rem;padding:.75rem;border:1px solid #2a2f3a;border-radius:10px;" +
      "background:#0f1116;cursor:pointer;}" +
      "#consent-gate .cg-check input{margin-top:.15rem;width:1.1rem;height:1.1rem;" +
      "flex:0 0 auto;accent-color:#ff5c33;cursor:pointer;}" +
      "#consent-gate .cg-check label{cursor:pointer;font-size:.92rem;color:#e9edf3;}" +
      "#consent-gate .cg-actions{display:flex;gap:.6rem;margin-top:1rem;flex-wrap:wrap;}" +
      "#consent-gate .cg-btn{flex:1;min-width:9rem;border:0;border-radius:10px;" +
      "padding:.8rem 1rem;font-size:.98rem;font-weight:700;cursor:pointer;}" +
      "#consent-gate .cg-accept{background:#ff5c33;color:#14161c;}" +
      "#consent-gate .cg-accept:disabled{opacity:.4;cursor:not-allowed;}" +
      "#consent-gate .cg-decline{background:transparent;color:#9aa4b2;" +
      "border:1px solid #2a2f3a;}" +
      "#consent-gate .cg-age{font-size:.8rem;color:#7f8a99;margin-top:.9rem;}" +
      "html.cg-locked,body.cg-locked{overflow:hidden !important;}";
    var el = document.createElement("style");
    el.id = "consent-gate-style";
    el.textContent = css;
    (document.head || document.documentElement).appendChild(el);
  }

  function build() {
    injectStyles();
    document.documentElement.classList.add("cg-locked");
    if (document.body) document.body.classList.add("cg-locked");

    var gate = document.createElement("div");
    gate.id = "consent-gate";
    gate.setAttribute("role", "dialog");
    gate.setAttribute("aria-modal", "true");
    gate.setAttribute("aria-labelledby", "cg-title");

    gate.innerHTML =
      '<div class="cg-card">' +
        '<div class="cg-mark"><span>AC</span> Arcade Campus Hub</div>' +
        '<h2 id="cg-title">Before you come in</h2>' +
        '<p>This site has accounts, messaging, video playlists and hundreds of ' +
          'games. To use any of it, you need to agree to our rules and how your ' +
          'data is handled.</p>' +
        '<ul class="cg-points">' +
          '<li>Be decent to other people — no harassment or inappropriate content.</li>' +
          '<li>Your messages can be seen by moderators if reported.</li>' +
          '<li>Games and videos are third-party and provided as-is.</li>' +
          '<li>We store no ad or analytics trackers, and never sell your data.</li>' +
        '</ul>' +
        '<label class="cg-check" for="cg-agree">' +
          '<input type="checkbox" id="cg-agree">' +
          '<label for="cg-agree">I have read and agree to the ' +
            '<a href="terms.html" target="_blank" rel="noopener">Terms of Use</a> ' +
            'and the ' +
            '<a href="privacy.html" target="_blank" rel="noopener">Privacy Notice</a>' +
            ', and I am old enough to use this site (or have permission from a ' +
            'parent, guardian or school).</label>' +
        '</label>' +
        '<div class="cg-actions">' +
          '<button type="button" class="cg-btn cg-accept" id="cg-accept" disabled>' +
            'Agree &amp; enter</button>' +
          '<button type="button" class="cg-btn cg-decline" id="cg-decline">' +
            'No thanks</button>' +
        '</div>' +
        '<p class="cg-age">Policy version ' + POLICY_VERSION + '. If they change, ' +
          'you\'ll be asked again.</p>' +
      '</div>';

    (document.body || document.documentElement).appendChild(gate);

    var check = gate.querySelector("#cg-agree");
    var accept = gate.querySelector("#cg-accept");
    var decline = gate.querySelector("#cg-decline");

    check.addEventListener("change", function () {
      accept.disabled = !check.checked;
    });

    accept.addEventListener("click", function () {
      if (!check.checked) return;
      record();
      close(gate);
    });

    decline.addEventListener("click", function () {
      /* Declining means you can't use the site. Send them somewhere neutral
         that explains, rather than leaving a locked page behind. */
      window.location.href = "about:blank";
    });

    /* Keep focus trapped lightly: focus the checkbox so keyboard users land
       inside the dialog. */
    try { check.focus(); } catch (e) {}
  }

  function close(gate) {
    document.documentElement.classList.remove("cg-locked");
    if (document.body) document.body.classList.remove("cg-locked");
    if (gate && gate.parentNode) gate.parentNode.removeChild(gate);
    document.dispatchEvent(new CustomEvent("consent:accepted",
      { detail: { version: POLICY_VERSION } }));
  }

  function maybeGate() {
    if (EXEMPT.indexOf(currentPage()) !== -1) return;
    if (alreadyAccepted()) return;
    build();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", maybeGate);
  } else {
    maybeGate();
  }

  /* Expose the version so other code (e.g. signup) can record the same one. */
  window.ConsentGate = { version: POLICY_VERSION, accepted: alreadyAccepted };
})();

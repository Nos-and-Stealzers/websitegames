/* Site-wide configuration. Edit this file, not the page markup. */
(function () {
  "use strict";

  window.SITE = {
    name: "Arcade Campus Hub",
    short: "Arcade Hub",
    mark: "AC",
    tagline: "An index of playable things",
    description:
      "A local-first browser arcade: compatibility flags, favourites and playtime, all stored on your device.",
    domain: "arcadecampushub.online",
    build: "v2",

    /* Where the games are served from.
       Each catalog entry names its `host`; this maps that to an origin.
       The four repos are separate GitHub Pages sites — enable Pages on each
       (Settings → Pages → Deploy from branch → main → /root) and these URLs
       start working. Swap any of them for Vercel/Netlify/your own host and
       only this table changes. */
    gameHosts: {
      "games-huge": "https://lucasgrimm389.github.io/games-huge",
      "swfgalaxy":  "https://nos-and-stealzers.github.io/swfgalaxy",
      "flashgames": "https://lucasgrimm389.github.io/flashgames",
      "hd_fnaf":    "https://lucasgrimm389.github.io/hd_fnaf",
      "eaglercraft": "https://lucasgrimm389.github.io/eaglercraft"
    },

    /* Fallback for any entry without a `host`, and for legacy catalogs whose
       paths are still root-relative. Empty means "same origin as this site". */
    gameBase: "",

    /* ---------------------------------------------------------------
       Accounts backend. Pick ONE, or neither.

       "supabase" — hosted Postgres + Auth. Talks straight from the
                    browser, so the whole thing runs on Vercel with no
                    second server. Fill in `supabase` below and run
                    supabase/schema.sql once in the SQL editor.

       "node"     — the Express + SQLite server in server/. Needs a host
                    that runs a real process with a persistent disk.
                    Set `apiBase` to its URL (or leave empty when the
                    same server is also serving this site).

       "none"     — no accounts at all. Every account feature hides
                    itself and the arcade works exactly as it does now.

       "auto"     — (default) probe this origin for a node backend. Right
                    for local development; on static hosting it finds
                    nothing and quietly settles on "none".
       --------------------------------------------------------------- */
    backend: "supabase",

    /* Used when backend === "supabase".
       The anon key is MEANT to be public — row-level security is what
       protects the data. NEVER put a `sb_secret_…` / service-role key
       here; it bypasses RLS and would hand every visitor full database
       access. If one has ever been pasted anywhere public, rotate it. */
    supabase: {
      url: "https://jtpostzpnhyyvuvywbiy.supabase.co",
      anonKey:
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
        "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp0cG9zdHpwbmh5eXZ1dnl3Yml5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4OTEyNjgsImV4cCI6MjEwMTQ2NzI2OH0." +
        "pBbjcEMqRMLjzRc0uvL0mAEcyYaxgvzjho0kXwH7eKA"
    },

    /* Used when backend === "node". Empty means same origin. */
    apiBase: "",

    defaults: {
      skin: "noir",            // see `skins` below
      lite: false,             // drop motion + grid overlay on slow hardware
      motion: true,            // animations; separate from lite mode
      textSize: "normal",      // normal | large | huge
      autoFullscreen: false,
      confirmExternal: true,
      view: "grid",            // grid | list
      sort: "title",           // default ordering in the index
      shortcuts: true,         // single-key shortcuts (/ K R P F)
      dock: true,              // floating chat, bottom right
      autoBackup: true,        // push game progress to the account as you play
      hideUnavailable: false,  // drop unhosted titles from the index entirely
      adminKey: "p"            // Ctrl/Cmd + this opens the console (staff only)
    },

    /* Category presentation: label, glyph, accent used by the index tiles. */
    categories: {
      arcade:     { label: "Arcade",     icon: "◈" },
      action:     { label: "Action",     icon: "✷" },
      puzzle:     { label: "Puzzle",     icon: "◱" },
      strategy:   { label: "Strategy",   icon: "⬢" },
      horror:     { label: "Horror",     icon: "☾" },
      platformer: { label: "Platformer", icon: "▟" },
      sports:     { label: "Sports",     icon: "◎" },
      racing:     { label: "Racing",     icon: "➤" },
      adventure:  { label: "Adventure",  icon: "⛰" },
      simulation: { label: "Simulation", icon: "⚙" },
      rpg:        { label: "RPG",        icon: "✦" },
      sandbox:    { label: "Sandbox",    icon: "▦" },
      idle:       { label: "Idle",       icon: "◔" },
      clicker:    { label: "Clicker",    icon: "◉" },
      other:      { label: "Other",      icon: "◇" }
    },

    /* Skin picker. `chips` are the two swatch bands in the settings sheet. */
    skins: [
      { id: "noir",      label: "Noir",      dark: true,  chips: ["#0c0d10", "#ff5c33"] },
      { id: "slate",     label: "Slate",     dark: true,  chips: ["#1a1e24", "#ffa03d"] },
      { id: "blueprint", label: "Blueprint", dark: true,  chips: ["#071021", "#4dd9ff"] },
      { id: "terminal",  label: "Terminal",  dark: true,  chips: ["#060a07", "#38e07b"] },
      { id: "grape",     label: "Grape",     dark: true,  chips: ["#140a1f", "#b06cff"] },
      { id: "ember",     label: "Ember",     dark: true,  chips: ["#160d0a", "#ff8a3d"] },
      { id: "paper",     label: "Paper",     dark: false, chips: ["#f7f5f1", "#d13a12"] },
      { id: "linen",     label: "Linen",     dark: false, chips: ["#f4f6f8", "#0f6fd1"] }
    ],

    /* Old v1 theme ids → v2 skins, so saved settings survive the redesign. */
    skinAliases: {
      light: "paper",
      gray: "slate",
      black: "noir",
      midnight: "blueprint",
      arcade: "terminal"
    }
  };
})();

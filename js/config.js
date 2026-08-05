/* Site-wide configuration. Edit this file, not the page markup. */
(function () {
  "use strict";

  window.SITE = {
    name: "Arcade Campus Hub",
    short: "Arcade Hub",
    mark: "AC",
    tagline: "An index of 216 playable things",
    description:
      "A local-first browser arcade: 216 games, compatibility flags, favourites and playtime, all stored on your device.",
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
      "hd_fnaf":    "https://lucasgrimm389.github.io/hd_fnaf"
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
    /* Stays "auto" until the Supabase client adapter lands — the credentials
       below are wired and supabase/schema.sql is ready, but flipping this to
       "supabase" now would just switch accounts off, because nothing yet
       speaks to Supabase. "auto" keeps the tested Node backend working. */
    backend: "auto",

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
      skin: "noir",            // noir | paper | slate | terminal | blueprint
      lite: false,             // drop motion + grid overlay on slow hardware
      autoFullscreen: false,
      confirmExternal: true,
      view: "grid"             // grid | list
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
      { id: "noir",      label: "Noir",      chips: ["#0c0d10", "#ff5c33"] },
      { id: "paper",     label: "Paper",     chips: ["#f7f5f1", "#d13a12"] },
      { id: "slate",     label: "Slate",     chips: ["#1a1e24", "#ffa03d"] },
      { id: "terminal",  label: "Terminal",  chips: ["#060a07", "#38e07b"] },
      { id: "blueprint", label: "Blueprint", chips: ["#071021", "#4dd9ff"] }
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

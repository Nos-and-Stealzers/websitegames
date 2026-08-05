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

    /* Where the actual game folders live.
       - ""  ................. games/ sits next to this site (self-hosted)
       - "https://host" ...... games are served from another origin
       Root-relative sources in the catalog ("/games/...") get this prefix. */
    gameBase: "https://arcadecampushub.online",

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
    backend: "auto",

    /* Used when backend === "supabase".
       The anon key is MEANT to be public — row-level security is what
       protects the data. NEVER put a `sb_secret_…` / service-role key
       here; it bypasses RLS and would hand every visitor full database
       access. If one has ever been pasted anywhere public, rotate it. */
    supabase: {
      url: "",          // https://xxxxxxxxxxxx.supabase.co
      anonKey: ""       // sb_publishable_…  or  eyJhbGciOi…
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

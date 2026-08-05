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

    /* Where the accounts backend lives.
       - ""  ................. same origin (running `node server/app.js`)
       - "https://host" ...... backend hosted separately, e.g. the static site
                               is on Vercel and the API is on Render/Railway.
       Leave empty and the account features simply won't appear — the arcade
       still works. When you do set it, add this site's origin to the server's
       ALLOWED_ORIGINS so its cookies survive the cross-origin trip. */
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

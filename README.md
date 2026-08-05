# Arcade Campus Hub

A browser arcade for **arcadecampushub.online**. 216 games, no build step, no tracking,
no webfonts. Two halves that work independently:

- **The site** — static HTML/CSS/JS. Deploys anywhere, works offline, needs nothing.
- **The hub** — an optional Node + SQLite backend in [`server/`](server/README.md) adding
  accounts, friends, direct messages, save sync and moderation.

Without the backend running, every account feature detects its absence and hides itself.
The arcade carries on exactly as before.

## The interface

A flat "catalogue" system rather than a storefront:

- **Fixed left rail** instead of a top header — brand, search, sections with live counts,
  shortlists, random + settings pinned to the bottom. On phones it becomes a drawer plus a
  five-slot bottom tab bar.
- **Hairline geometry.** 1px borders, 3px radius, zero drop shadows. Grids are a single
  border sheet with 1px gaps, so tiles share edges instead of floating.
- **Monospace metadata.** Counts, flags, timings, IDs and section labels are all set in the
  system mono face with wide tracking. Headings are tight, heavy system sans.
- **Generated cover art.** Every title gets a deterministic geometric plate built from its own
  id and palette — 8 motifs, layered dark over light, seeded by an FNV hash. 216 unique covers,
  zero image files. Titles that ship real art use it, with the generated plate as fallback.
- **No network fonts.** Everything uses `ui-sans-serif` / `ui-monospace` stacks, so nothing
  degrades when a network blocks font CDNs.
- **Five skins:** Noir (default, dark), Paper, Slate, Terminal (phosphor green + grid overlay),
  Blueprint (indigo + cyan). Each carries its own accent colour.

## Pages

| Page | What it does |
| --- | --- |
| `index.html` | Readout strip, featured marquee, resume, pinned, suggested, category index, in-page picks |
| `browse.html` | Search, category pills, compatibility filters, 7 sorts, **grid or dense list view**, paging — all mirrored into the URL |
| `categories.html` | Category index plus a sample strip per category |
| `play.html?id=…` | Player: in-page frame or new-tab launch, fullscreen, aspect toggle, spec sheet, rating, related titles |
| `library.html` | Pins (grid), history (list), top rated, most played |
| `stats.html` | Total time, time-by-category meters, top ten, untouched categories |
| `about.html` | Manual: build notes, flag legend, storage, keys, catalog schema |
| `404.html` | Not-found + suggestions |

### Account pages (need the backend)

| Page | What it does |
| --- | --- |
| `login.html` / `signup.html` | Sign in or register, with a strength meter and a note of exactly what local data comes with you |
| `profile.html?u=…` | Avatar, bio, presence, friend actions, shared activity |
| `friends.html` | User search, incoming/outgoing requests, friend list, blocks |
| `messages.html` | Direct messages — thread list, polling conversation, retractable messages |
| `notifications.html` | Feed of requests, messages and account activity; mark read, dismiss, clear |
| `admin.html` | Overview, user/role moderation, reports queue, audit trail |

`settings.html` is **not** account-only — see below.

## The sidebar

Everything account-related lives in the rail, and stays visible whether or not you're
signed in, so nothing is hidden behind a state you have to reach first:

```
LIBRARY      Overview · All games · Categories · Pinned · Activity · Manual
SOCIAL       Friends · Messages · Notifications          (badged, when a backend answers)
ACCOUNT      Sign in / Create account   — or —   My profile · Settings · Admin
             Display & skins                            (always, even with no backend)
SHORTLISTS   Plays in page · Stable only · Shuffled · Your most played
```

Clicking a social link while signed out lands on sign-in with `?next=` set, rather than
the link simply not being there. When no backend answers at all, the social block is
removed rather than left as dead ends — but **Display & skins** never goes away.

`settings.html` splits in two: **Display** (skins, lite mode, default view, fullscreen,
launch confirmation) works with no account and no server; the profile, privacy, password,
device and deletion sections appear only once signed in.

## Features

- One shareable URL per game (`play.html?id=snow-rider`).
- Playtime tracking — counts only while the tab is visible, flushed every 30s.
- Star ratings, pins and history, all per-device.
- Finder palette (<kbd>K</kbd>) for instant jump-to-title.
- Grid ⇄ list view, remembered across sessions.
- JSON export / import of everything you've saved.
- PWA: installable, offline for everything except the games themselves.
- Catalog loaded as a script, so the site runs straight off the filesystem.
- Accessibility: skip link, visible focus rings, `aria-pressed` toggles, `aria-current` nav,
  reduced-motion support, and a Lite mode that kills motion and the grid overlay.
- v1 saved settings migrate automatically (`light→paper`, `gray→slate`, `black→noir`,
  `midnight→blueprint`, `arcade→terminal`).

### With an account
- Your save follows you: pins, history, ratings and playtime sync across devices.
- **Merging, not overwriting** — signing in on a second device takes the union of your pins
  and the higher playtime, so it can never wipe the first device's progress.
- Signing up **adopts whatever you already played** signed out.
- Friends: search, requests, accept/decline, remove, block.
- Direct messages with unread badges, presence dots and retractable messages.
- Notifications for friend requests, acceptances, new messages, role changes,
  suspensions and closed reports — badged in the rail, toasted when they land
  mid-session, and coalesced so a chatty friend produces one bell, not forty.
- Deterministic identicon avatars generated from the username — nothing to upload.
- Admin console: live metrics, role management, suspensions, reports queue, audit trail.

## Game icons

Every title is visually distinct. 71 games serve their own icon, harvested from the game's
own page by [`tools/harvest-icons.js`](tools/harvest-icons.js) and layered over a generated
plate; the other 145 get a plate alone. All 216 are unique.

```bash
node tools/harvest-icons.js          # probe every title
node tools/harvest-icons.js --fill   # only ones still missing an icon
node tools/harvest-icons.js --only 10  # dry run
```

It reads each game's `index.html`, takes the icon that page declares (`apple-touch-icon`,
`og:image`, `<link rel=icon>`), falls back to naming conventions, and verifies the file is a
real image before recording it. Two guards keep it honest: candidates resolving outside the
game's own folder are rejected (or every game inherits the site favicon), and any icon claimed
by more than two games is dropped as a shared logo.

## Layout

```
index.html browse.html categories.html play.html library.html stats.html about.html 404.html
login.html signup.html profile.html friends.html messages.html notifications.html
settings.html admin.html
css/style.css              tokens, skins, every component
js/config.js               name, gameBase, categories, skins  ← edit this
js/theme-boot.js           applies the saved skin before first paint
js/store.js                localStorage: settings, pins, recents, stats, ratings
js/catalog.js              normalise, search, filter, sort, recommendations
js/art.js                  generated cover plates + identicon avatars
js/ui.js                   tiles, list rows, flags, toasts, formatting
js/api.js                  API client; degrades to "no backend" cleanly
js/session.js              who's signed in, save sync, unread badges
js/social-ui.js            people rows, relation buttons, page gating
js/shell.js                rail, topbar, tabbar, settings sheet, finder, shortcuts
js/page-*.js               one file per page
data/games.json            the catalog (source of truth)
data/games.js              generated from games.json
server/                    optional Node + SQLite backend — see server/README.md
tools/build-sitemap.ps1    regenerates games.js + sitemap.xml
tools/harvest-icons.js     finds each game's own icon
sw.js manifest.json robots.txt sitemap.xml assets/icon.svg
```

## Where the games come from

The catalog stores root-relative paths like `/games/huge/snow-rider/index.html`.
`js/config.js` decides what host those resolve against — game sources *and* cover images:

```js
gameBase: "https://arcadecampushub.online"   // games served from the live site
gameBase: ""                                 // games/ folder sits next to this site
```

Set it to `""` once you copy the `games/` directory in beside these files.

## Running it locally

**With accounts** (serves the API and the site together):

```powershell
cd c:\Users\lucas\Desktop\websiteforgames\server
npm install
node app.js                     # http://localhost:8787
```

The first account you create becomes the administrator.

**Site only**, no accounts:

```powershell
cd c:\Users\lucas\Desktop\websiteforgames
python -m http.server 8080      # or: npx serve .
```

Opening `index.html` from disk works too — that's why the catalog is a script rather than a
fetched JSON file — but the service worker stays off over `file://`.

## Tests

```powershell
node server\test\api.test.js    # 117 end-to-end API checks
```

The API suite boots the real app against a throwaway SQLite file and drives it over HTTP with
real cookies, covering auth, authorisation, friends, DM privacy, blocking, save-merge
semantics, moderation guard rails, CSRF, rate limits and account deletion.

## Adding games

1. Append an entry to `data/games.json`:

   ```json
   {
     "id": "my-game",
     "title": "My Game",
     "category": "arcade",
     "description": "One line about it.",
     "gradient": "linear-gradient(135deg, #ff5c33, #7c2d12)",
     "source": "/games/my-game/index.html",
     "direct": "/games/my-game/index.html",
     "platform": "local",
     "embed": "allowed",
     "schoolRisk": "low"
   }
   ```

2. Regenerate the derived files:

   ```powershell
   powershell -ExecutionPolicy Bypass -File tools\build-sitemap.ps1
   ```

`embed` is `"allowed"`/`true` for in-page play or `false` to force a new tab; `preferDirect: true`
skips the player even when framing works; `schoolRisk` is `low` | `medium` | `high`; `gradient`
seeds the generated cover; `pfp` supplies real cover art if you have it; unknown categories fall
back to **Other**.

## Deploying

Upload the folder to the web root and point the host's 404 handler at `404.html`.
After changing any shell file, bump `SHELL_VERSION` in `sw.js` so visitors get the new build
instead of the cached one.

## Privacy

No analytics and no ad trackers, ever. Signed out there are no cookies at all — pins, history,
ratings, playtime and skin live in `localStorage` under the `ach:` prefix and never leave the
browser.

Signed in, one `HttpOnly` `SameSite=Lax` session cookie is set, and everything except your skin
choice syncs to your own server. Passwords are salted scrypt hashes. Nothing is sent to any
third party. See [`server/README.md`](server/README.md) for the full security model.

There is no email and no password reset — **if a user forgets their password, an admin can only
delete the account, not recover it.**

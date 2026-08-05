# Deploying

The site and the accounts backend deploy separately, because they need
different kinds of hosting.

| Half | What it needs | Where |
| --- | --- | --- |
| The site | Static file hosting | Vercel, Netlify, GitHub Pages, GoDaddy |
| The backend | A long-running Node process + a disk that persists | Render, Railway, Fly, a VPS |

**You can stop after step 1.** The arcade works fully as a static site — every
account feature detects the missing backend and hides itself.

---

## 1 · The site, on Vercel

Import the repo and press Deploy. No configuration needed:

| Setting | Value |
| --- | --- |
| Framework Preset | **Other** |
| Root Directory | `./` |
| Build Command | *(leave empty)* |
| Output Directory | *(leave empty)* |
| Install Command | *(leave empty)* |

[`vercel.json`](vercel.json) already sets the caching and security headers, and
[`.vercelignore`](.vercelignore) keeps `server/` out of the static deploy.

There is no build step and no dependency install — it's plain HTML, CSS and
JavaScript. A deploy takes a few seconds.

### Why the backend can't go here too

Vercel runs serverless functions. They have no persistent filesystem and no
long-lived process, so:

- `arcade.db` would be wiped on every cold start — accounts would work for
  minutes, then silently vanish.
- `app.listen()` never runs in a serverless handler.

Losing accounts intermittently is worse than not offering them, so the backend
goes somewhere that can actually keep them.

---

## 2 · Accounts on Supabase (recommended)

Supabase is hosted Postgres + Auth, so the browser talks to it directly and
there is **no second server to run**. This is the path that works with the
Vercel deploy above.

1. **Apply the schema.** Supabase dashboard → *SQL Editor → New query* → paste
   all of [`supabase/schema.sql`](supabase/schema.sql) → **Run**. It is
   idempotent, so re-running after an update is safe.

2. **Turn off email confirmation.** *Authentication → Providers → Email* →
   uncheck **Confirm email**.

   > The hub is username-only. Supabase Auth needs an address, so one is
   > derived (`you@users.arcadecampushub.online`) and never used. Leave
   > confirmation on and every signup hangs waiting for an email that will
   > never arrive.

3. **Switch the frontend over** in [`js/config.js`](js/config.js):

   ```js
   backend: "supabase",
   ```

   The URL and anon key are already filled in.

4. Push. Vercel redeploys, and the first account you create becomes the
   **administrator**.

### About that anon key

It is *supposed* to be public — it identifies the project, and row-level
security is what actually protects the data. Every table is RLS-enabled and
deny-by-default.

**Never put a `sb_secret_…` / service-role key in `js/config.js`.** It bypasses
RLS entirely, and anything in that file is readable by every visitor. If one has
ever been pasted somewhere public, rotate it in *Project Settings → API Keys*.

### What Supabase can't do that the Node backend can

- **Per-device session list.** Supabase doesn't expose one to the client, so
  Settings shows only the current device.
- **Deleting the auth user.** Deleting your account removes the profile and
  cascades everything it owns; the underlying auth row needs the service role,
  so it is left orphaned and inert. The username frees up.
- **Server-side rate limits.** Supabase applies its own; the per-route limits in
  the Node backend have no equivalent here.

---

## 3 · Or: the Node backend, on Render

Only needed if you want accounts, friends, messages and notifications.

1. **Render → New → Blueprint**, point it at this repo. It reads
   [`render.yaml`](render.yaml): Node runtime, `server/` as root, a 1 GB disk
   mounted at `/var/data`, and `ARCADE_DB=/var/data/arcade.db`.

   > The disk matters. Put the database anywhere inside the code directory and
   > the next deploy replaces it, taking every account with it.

2. Set **`ALLOWED_ORIGINS`** to wherever the site is served from — comma
   separated, no trailing slashes:

   ```
   https://websitegames.vercel.app,https://arcadecampushub.online
   ```

3. Copy the service URL Render gives you (e.g.
   `https://arcade-campus-hub-api.onrender.com`).

Railway, Fly or any VPS work the same way — the only requirements are Node 18+,
a persistent volume, and HTTPS.

---

## 3 · Point the site at the backend

Edit [`js/config.js`](js/config.js):

```js
apiBase: "https://arcade-campus-hub-api.onrender.com",
```

Commit and push; Vercel redeploys automatically. The account features appear.

**The first account created becomes the administrator.** Make yours immediately
after the backend goes live.

### Why both sides need configuring

The session cookie has to survive a cross-origin request, which means
`SameSite=None; Secure`. The server switches to that automatically as soon as
`ALLOWED_ORIGINS` is set, and rejects state-changing requests from any origin
not on that list. So:

- `apiBase` unset → no account features at all.
- `apiBase` set but the origin missing from `ALLOWED_ORIGINS` → sign-in fails
  with a CORS error.
- Either side on plain HTTP → the browser drops the cookie, because
  `SameSite=None` requires `Secure`.

---

## Same-origin alternative

If you'd rather run everything from one place, skip Vercel entirely and let the
Node server host the site too — it already does:

```bash
cd server && npm install && node app.js     # serves the API *and* the site
```

Leave `apiBase` empty and `ALLOWED_ORIGINS` unset. Cookies stay `SameSite=Lax`,
there's no CORS involved, and there's one thing to deploy instead of two. Point
your domain at that host and you're done.

---

## Checklist

- [ ] Site deploys and loads
- [ ] `games/` reachable — check a title actually plays (`gameBase` in
      `js/config.js` decides where those files come from)
- [ ] Backend `/api/health` returns `{"ok":true}`
- [ ] `ARCADE_DB` points at a persistent disk, not the code directory
- [ ] `ALLOWED_ORIGINS` lists every frontend origin
- [ ] `apiBase` set in `js/config.js`
- [ ] First account created — that's your admin
- [ ] `SHELL_VERSION` in `sw.js` bumped, if you changed any shell file

## Backups

The whole system is one SQLite file. Copy it while the process is stopped, or
live with:

```bash
sqlite3 /var/data/arcade.db ".backup /tmp/arcade-backup.db"
```

There is no password reset — no email is collected. A forgotten password can
only be resolved by deleting the account.

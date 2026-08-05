# Arcade Campus Hub — server

Accounts, friends, direct messages, save sync and moderation for the hub.
Node + Express + SQLite. No external services, no build step.

**It is optional.** Without it the site is still a complete static arcade — every
account feature detects the missing backend and hides itself.

## Run it

```bash
cd server
npm install
node app.js            # http://localhost:8787 — serves the API *and* the site
```

The first account you create becomes the **administrator**. There is no seed user
and no default password.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Listen port |
| `ARCADE_DB` | `server/arcade.db` | SQLite file path |
| `NODE_ENV` | — | Set to `production` to add `Secure` to the session cookie |
| `SIGNUPS_PER_HOUR` | `30` | Per-IP signup cap |

```bash
npm test               # 117 end-to-end API checks against a throwaway database
```

## Security model

- **Passwords** — scrypt (N=16384, r=8, p=1) with a 16-byte per-user salt, compared
  in constant time. Never logged, never returned by any endpoint.
- **Sessions** — 32 random bytes, `HttpOnly` + `SameSite=Lax`, 30 days, swept on
  expiry. Changing a password revokes every other session. Suspending an account
  terminates its live sessions immediately rather than waiting for expiry.
- **CSRF** — the API rejects any state-changing request carrying a cross-origin
  `Origin` header. `SameSite=Lax` is the second layer.
- **Authorisation** — enforced per route by `requireUser` / `requireRole`. Hiding
  the admin tab in the UI is convenience; these checks are the control.
- **Login enumeration** — a wrong username and a wrong password return the same
  401 and the same message.
- **Rate limits** — namespaced per limiter so unrelated endpoints can't exhaust
  each other: signup 30/h per IP, login 12/15min per username+IP, messages
  30/min, reports 10/h.
- **XSS** — bodies are stored verbatim and every client render path uses
  `textContent`. The server never emits HTML.
- **Guard rails** — the last admin cannot be demoted or deleted; nobody can
  suspend or demote themselves.

## Notifications

Emitted from one place ([`notify.js`](notify.js)) so every event that deserves a
bell goes through the same door:

| Event | Goes to |
| --- | --- |
| Friend request sent | the recipient |
| Friend request accepted | the original requester |
| Direct message sent | the recipient, **coalesced to one per sender per 5 min** |
| Role changed | the promoted/demoted user |
| Account suspended or reinstated | that user |
| Report closed | whoever raised it |

Self-notifications are dropped, and each user's feed is trimmed to the newest 200
rows. Unread counts ride along on `GET /api/messages/unread` so the rail paints
all three badges in a single round trip.

## Schema

`users` · `sessions` · `friendships` · `threads` · `messages` · `notifications` ·
`saves` · `game_stats` · `reports` · `audit`

Created and migrated on first require, idempotently. Friendships are one row per
pair; threads are keyed on the ordered user pair so two people can never end up
with duplicate conversations.

## Save sync

`PUT /api/sync` **merges** rather than overwrites: union of pins, newest-wins
recents, max-wins playtime and play counts. Signing in on a second device can
never destroy progress made on the first.

## API

Everything is JSON under `/api`. Auth is the session cookie.

```
GET    /api/health

POST   /api/auth/signup            {username, password, displayName?}
POST   /api/auth/login             {username, password}
POST   /api/auth/logout
GET    /api/auth/me
GET    /api/auth/sessions
POST   /api/auth/password          {current, next}
POST   /api/auth/signout-everywhere

PATCH  /api/users/me               {displayName?, bio?, acceptsDms?, showActivity?}
DELETE /api/users/me               {confirm}
GET    /api/users/search?q=
GET    /api/users/:username

GET    /api/friends
POST   /api/friends/request        {username}
POST   /api/friends/:id/accept
DELETE /api/friends/:id
POST   /api/friends/block          {username}

GET    /api/messages/threads
GET    /api/messages/unread          -> {messages, requests, notifications}
POST   /api/messages/with/:username
GET    /api/messages/threads/:id?after=
POST   /api/messages/threads/:id   {body}
DELETE /api/messages/:id

GET    /api/notifications?limit=&unread=1
POST   /api/notifications/read      {all:true} | {ids:[…]}
DELETE /api/notifications
DELETE /api/notifications/:id

GET    /api/sync
PUT    /api/sync                   {save}
GET    /api/games/popular
POST   /api/reports                {kind, target, reason}

GET    /api/admin/overview
GET    /api/admin/users?q=
PATCH  /api/admin/users/:id        {role?, state?}
DELETE /api/admin/users/:id
GET    /api/admin/reports?state=
PATCH  /api/admin/reports/:id      {state}
GET    /api/admin/audit
```

## Deploying

Any host that runs Node: Render, Railway, Fly, a VPS. Put it behind HTTPS, set
`NODE_ENV=production`, and keep `arcade.db` on a persistent volume — a container
filesystem that resets will take every account with it.

GoDaddy **shared** hosting cannot run this (PHP only). The static site deploys
there fine on its own; the account features just won't appear.

Back up by copying `arcade.db` while the process is stopped, or with
`sqlite3 arcade.db ".backup out.db"` while it runs.

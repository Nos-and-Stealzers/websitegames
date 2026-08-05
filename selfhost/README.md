# Hosting it yourself

Short answer to "couldn't I just be the VPS": **yes, and for one specific
thing you probably should.**

Run `node selfhost/check-readiness.js` first — it tells you in a few seconds
whether your ISP allows this at all.

---

## What self-hosting actually fixes

| Piece | Where it is now | Should you move it? |
| --- | --- | --- |
| The site | Vercel | **No.** Free, fast, global, zero maintenance. |
| Accounts | Supabase | **No.** Free tier, managed backups. |
| **Game files** | GitHub Pages | **Yes — this is the real win.** |
| PC game streaming | nowhere | Possible, but read the bandwidth section. |

`games-huge` is **3.7 GB** and `hd_fnaf` is **4.2 GB**. GitHub Pages caps a
published site at **1 GB** and rejects any single file over 100 MB. They build
today, but you are well over the line and there is no way to get under it
without deleting games. Serving those files yourself has no such limit.

That also unblocks the 730 MB FNaF World Refreshed build — too big for GitHub
by an order of magnitude, unremarkable on your own disk.

---

## Three ways to expose it

### 1 · Tailscale Funnel — easiest, and you already have Tailscale

The readiness check found Tailscale running on this machine. Funnel puts a
local port on the public internet over HTTPS with **no port forwarding and
without publishing your home IP**.

```bash
tailscale funnel 443 on
tailscale funnel status
```

Free, survives a changing IP, works behind CGNAT. The catch is you get a
`*.ts.net` hostname rather than your own domain, and throughput is lower than
a direct connection.

### 2 · Cloudflare Tunnel — your own domain, IP still hidden

```bash
cloudflared tunnel create arcade
cloudflared tunnel route dns arcade games.arcadecampushub.online
cloudflared tunnel run --url http://localhost:8080 arcade
```

No ports opened, works behind CGNAT, free, and Cloudflare absorbs traffic
before it reaches your house. Best balance for what you're doing.

### 3 · Port forwarding — fastest, most exposed

Your check came back with a **real public IP (not CGNAT)**, so this will work:

1. Router admin (`192.168.1.1`) → Port Forwarding
2. Forward **80** and **443** → this machine's LAN IP
3. Give the machine a **static DHCP reservation**, or the LAN IP will move and
   the rule will silently point at nothing
4. Residential IPs change, so add dynamic DNS — DuckDNS, No-IP, or Cloudflare's
   API with a small updater
5. Point `games.arcadecampushub.online` at it

This publishes your home IP address in DNS. Anyone can look it up, and it is
tied to where you live. Options 1 and 2 avoid that.

---

## Running it

```bash
# put the game folders where the Caddyfile expects them
#   /srv/games/games-huge/...
#   /srv/games/swfgalaxy/...
caddy run --config selfhost/Caddyfile
```

Caddy gets and renews its own HTTPS certificate. No certbot, no cron.

Then point the hub at it — [`js/config.js`](../js/config.js):

```js
gameHosts: {
  "games-huge": "https://games.arcadecampushub.online/games-huge",
  "swfgalaxy":  "https://games.arcadecampushub.online/swfgalaxy",
  "flashgames": "https://games.arcadecampushub.online/flashgames",
  "hd_fnaf":    "https://games.arcadecampushub.online/hd_fnaf"
}
```

Copy `tools/save-bridge.html` to the root of each folder so cross-device game
progress keeps working, and add your new origin to the bridge's `ALLOWED` list.

---

## Measured on this connection

```
download   223 Mbps
upload      38 Mbps        <- the number that matters
latency     64 ms idle
           147 ms while uploading    (2.3x worse)
```

Download speed is irrelevant to hosting. **Upload** decides everything, and
saturated upload is what makes the rest of the house feel slow — that 64 →
147 ms is real and you would notice it on a call or in a game.

| What | Upload per player | Concurrent, on 38 Mbps |
| --- | --- | --- |
| Serving game files | ~3 Mbps while loading | ~8 |
| Streaming a PC game | ~20 Mbps, continuously | **1** |

So streaming FNaF World Refreshed is a one-player-at-a-time thing, and no
router or PC upgrade changes that.

### Caching is what makes serving files not hurt

Put Cloudflare in front and the picture changes completely. Game files are
static and immutable, so with the `Cache-Control` headers in the Caddyfile,
**your line uploads each file once** and Cloudflare serves every player after
that from its own edge.

- Cold cache: a handful of players will briefly push upload, same as above.
- Warm cache: near zero. Your latency stays at 64 ms.

This is the difference between "hosting lags my wifi" and "hosting is
invisible". Do not skip it — without those headers Cloudflare revalidates
constantly and you pay the upload every single time.

One caveat worth knowing: Cloudflare's free plan is intended for web content,
and serving a lot of large video through it is against their terms. The games
are HTML/JS/images/audio, which is fine. The two FNaF cutscene `.mp4`s (23 MB)
are the only thing in that grey area.

---

## Before you point a domain at your house

- **The machine must stay on.** Sleep, reboots and power cuts take the site
  with them.
- **Most residential ISP terms prohibit running public servers.** Enforcement
  varies, but read yours before your school's traffic starts arriving.
- **Your IP is your address.** A tunnel hides it; an A record advertises it.
- **You become the security boundary.** Anything you expose is exposed from
  your home network. Keep the server on its own VLAN or a spare machine if you
  can.

---

## What this actually costs to set up

Four things have to happen, and three of them need you:

1. **Move the domain's nameservers to Cloudflare.** Tunnel with your own
   hostname requires it. This also moves the DNS records that currently point
   `arcadecampushub.online` at Vercel — they have to be recreated, and the site
   is briefly in flux while nameservers propagate. This is the disruptive step.
2. **Download the games.** They live in GitHub, not on this machine: roughly
   **9 GB** across the four repos, and 9 GB of disk to keep them on.
3. **Install and log into `cloudflared`** — opens a browser to authorise
   against your Cloudflare account.
4. Point `gameHosts` at the new origin and copy `save-bridge.html` into each
   folder.

## What I would actually do

**Nothing, for now.**

GitHub Pages is serving all 204 games today — verified, every one returning
200. The 1 GB cap is a rule you are over, not an outage you are having;
GitHub has not enforced it. You would be trading something that works and
costs nothing for something that needs a 9 GB download, a machine that never
sleeps, an ISP that tolerates it, and a nameserver migration.

Move when one of these happens:

- GitHub actually enforces the cap and a repo stops serving
- You want to host the 730 MB FNaF World Refreshed build, which GitHub will
  never accept
- You outgrow Pages' bandwidth

At that point the setup here is ready and the caching config means it will not
slow your network down.

Keep the site on Vercel and accounts on Supabase regardless — they cost
nothing and never page you at midnight. And treat streaming the PC build as a
separate experiment, not part of the arcade: one player at a time is a
demo, not a feature.

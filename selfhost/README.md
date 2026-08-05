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

## Bandwidth is the real limit

Download speed is not the number that matters. **Upload** is.

| What | Upload per player |
| --- | --- |
| Serving game files | ~2–5 Mbps while loading, then near zero |
| Streaming a PC game | ~15–25 Mbps, continuously, each |

Residential upload is commonly 10–40 Mbps *total*. So:

- **Serving files: fine.** Loads are bursty and then stop. Dozens of players is
  realistic.
- **Streaming FNaF World Refreshed: one or two people at once, and that is a
  hard ceiling.** Not a machine problem — you cannot buy your way past your
  upload rate with a router.

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

## What I would actually do

Keep the site on Vercel and accounts on Supabase — they cost nothing and never
page you at midnight. Move **only the game files** here, behind a Cloudflare
Tunnel. That fixes the one real problem (the 1 GB cap), keeps your IP private,
and leaves everything else alone.

Treat streaming the PC build as a separate experiment, not part of the arcade.

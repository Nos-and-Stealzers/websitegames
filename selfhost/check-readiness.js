/* Can this machine actually be a server?
 *
 * Buying a router doesn't decide that — your ISP does. The two things that
 * stop most home setups are CGNAT (you have no public address to forward to)
 * and upload bandwidth. This checks both, plus whether anything is already
 * listening where a web server would need to.
 *
 *   node selfhost/check-readiness.js
 *
 * Read-only: it opens no ports and changes nothing.
 */
"use strict";

const os = require("os");
const net = require("net");
const { execSync } = require("child_process");

function ok(label, value, note) {
  console.log("  " + label.padEnd(26) + String(value) + (note ? "   " + note : ""));
}

/* 100.64.0.0/10 is the shared range ISPs use for carrier-grade NAT. */
function isCgnatRange(ip) {
  const m = /^(\d+)\.(\d+)\./.exec(ip || "");
  if (!m) return false;
  const a = +m[1], b = +m[2];
  return a === 100 && b >= 64 && b <= 127;
}

function isPrivate(ip) {
  return /^10\./.test(ip) || /^192\.168\./.test(ip) ||
         /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

function gateway() {
  try {
    const out = execSync("route print 0.0.0.0", { encoding: "utf8", windowsHide: true });
    const line = out.split("\n").find((l) => /^\s*0\.0\.0\.0\s+0\.0\.0\.0/.test(l));
    return line ? line.trim().split(/\s+/)[2] : null;
  } catch (e) { return null; }
}

function localIPs() {
  const out = [];
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach((name) => {
    (nets[name] || []).forEach((n) => {
      if (n.family === "IPv4" && !n.internal) out.push({ name, address: n.address });
    });
  });
  return out;
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "0.0.0.0");
  });
}

(async () => {
  console.log("=== this machine ===");
  const ips = localIPs();
  ips.forEach((i) => ok(i.name.slice(0, 24), i.address, isPrivate(i.address) ? "(private, normal)" : ""));
  const gw = gateway();
  ok("default gateway", gw || "unknown", "<- your router's admin page");

  console.log("\n=== your ISP ===");
  let publicIp = null;
  for (const url of ["https://api.ipify.org", "https://ifconfig.me/ip", "https://icanhazip.com"]) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (r.ok) { publicIp = (await r.text()).trim(); break; }
    } catch (e) { /* try the next one */ }
  }

  if (!publicIp) {
    ok("public IP", "could not determine", "(no internet, or all lookups blocked)");
  } else {
    ok("public IP", publicIp);

    const cgnat = isCgnatRange(publicIp);
    const alsoPrivate = isPrivate(publicIp);

    if (cgnat || alsoPrivate) {
      console.log("\n  >> CARRIER-GRADE NAT DETECTED");
      console.log("     Your public address is in a shared ISP range, so there is no");
      console.log("     address that belongs to you to forward a port to. No router");
      console.log("     you buy changes this. Use a tunnel (see selfhost/README.md)");
      console.log("     or ask your ISP for a public IPv4 address.");
    } else {
      console.log("\n  >> Looks like a real public IP — port forwarding should be possible.");
      console.log("     Confirm on the router that its WAN address matches " + publicIp + ".");
      console.log("     If the router shows a 100.64.x.x address instead, you are behind CGNAT.");
    }
  }

  console.log("\n=== ports a web server would want ===");
  for (const p of [80, 443, 8787]) {
    const free = await portFree(p);
    ok("port " + p, free ? "free" : "IN USE", free ? "" : "<- something already listening");
  }

  console.log("\n=== upload bandwidth ===");
  console.log("  Not measured here — run a speed test and read the UPLOAD number.");
  console.log("  Rough guide for what you were asking about:");
  console.log("    serving the game files   ~2-5 Mbps up per player");
  console.log("    streaming a PC game      ~15-25 Mbps up per player, each");
  console.log("  Residential upload is often 10-40 Mbps total, so game streaming");
  console.log("  realistically means one or two people at once.");

  console.log("\n=== notes ===");
  console.log("  * Your home IP is tied to your address. Putting it in DNS publishes it.");
  console.log("    A tunnel or Cloudflare proxy hides it; a bare A record does not.");
  console.log("  * Most residential ISP terms disallow running public servers. Enforcement");
  console.log("    varies, but it is worth knowing before you point a domain at your house.");
  console.log("  * The machine has to stay on. Sleep, reboots and power cuts take the site");
  console.log("    down with them.");
})();

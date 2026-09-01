// ICE server configuration comes from the signaling Worker rather than being hardcoded here, so
// adding TURN later is a `wrangler secret put` on one service instead of a redeploy of the client
// *and* a rebuild of every installed host.
//
// TURN matters more than it sounds: plain STUN can't punch through symmetric NAT, which is what a
// lot of corporate networks, mobile carriers, and some consumer routers do. Without a relay to
// fall back on, those connections simply fail after ~30 seconds of ICE checks with nothing useful
// to tell the user. See signaling/src/worker.ts's /ice handler.

const FALLBACK: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
];

let cached: RTCIceServer[] | null = null;

export async function fetchIceServers(workerBaseUrl: string): Promise<RTCIceServer[]> {
  if (cached) return cached;
  try {
    const res = await fetch(`${workerBaseUrl}/ice`);
    if (res.ok) {
      const body = (await res.json()) as { iceServers?: RTCIceServer[] };
      if (body.iceServers?.length) {
        cached = body.iceServers;
        return cached;
      }
    }
  } catch {
    // Worker unreachable or misconfigured — STUN-only still connects on most home networks, so
    // this is worth attempting rather than failing the whole session up front.
  }
  cached = FALLBACK;
  return cached;
}

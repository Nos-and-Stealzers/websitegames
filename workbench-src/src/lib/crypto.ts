/** SHA-256 of a UTF-8 string, hex-encoded — mirrors the host and signaling Worker's own
 *  sha256Hex (see host/Host/Clipboard aside: HostSession.ts, signaling/src/supabaseAdmin.ts).
 *  Used to hash a connect PIN client-side before it ever reaches the network — the server only
 *  ever sees the hash, never the PIN itself, same trust shape as the host's own token. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

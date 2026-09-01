import { supabase } from "../lib/supabase";

// One-time setup keys. This is the whole of what "you never have to go back to the machine"
// rests on: you generate a key here, type it into the host once while you're installing it
// anyway, and from then on the computer belongs to your account. Access for other people is
// granted and revoked from the web — there is no second code to fetch off the host's screen,
// ever.
//
// Only the key's SHA-256 hash is stored. The plaintext exists in this browser tab and nowhere
// else, so a leaked database row can't be used to claim a machine.

const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no O/0/I/1 — this gets read off a screen and typed
const GROUPS = 3;
const GROUP_LENGTH = 4;

export interface IssuedKey {
  /** Shown once, never stored. */
  key: string;
  expiresAt: Date;
}

function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(GROUPS * GROUP_LENGTH));
  const chars = Array.from(bytes, (b) => KEY_ALPHABET[b % KEY_ALPHABET.length]);
  const groups: string[] = [];
  for (let i = 0; i < GROUPS; i++) {
    groups.push(chars.slice(i * GROUP_LENGTH, (i + 1) * GROUP_LENGTH).join(""));
  }
  return `PRD-${groups.join("-")}`;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const VALID_FOR_MS = 60 * 60 * 1000;

export async function issueEnrollmentKey(label?: string): Promise<IssuedKey> {
  const { data: userData } = await supabase.auth.getUser();
  const ownerId = userData.user?.id;
  if (!ownerId) throw new Error("You need to be signed in to set up a computer.");

  const key = randomKey();
  const expiresAt = new Date(Date.now() + VALID_FOR_MS);

  const { error } = await supabase.from("enrollment_keys").insert({
    owner_id: ownerId,
    key_hash: await sha256Hex(key),
    key_prefix: key.slice(0, 8),
    label: label?.trim() || null,
    expires_at: expiresAt.toISOString(),
  });
  if (error) throw error;

  return { key, expiresAt };
}

/** Housekeeping so the "pending setup" list doesn't fill with keys nobody used. */
export async function discardExpiredKeys(): Promise<void> {
  await supabase
    .from("enrollment_keys")
    .delete()
    .is("used_at", null)
    .lt("expires_at", new Date().toISOString());
}

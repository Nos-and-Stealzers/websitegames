import { supabase } from "../lib/supabase";
import type { Computer, Profile } from "../lib/database.types";
import { sha256Hex } from "../lib/crypto";

// Everything the dashboard reads and writes about computers. All of it goes straight to Supabase
// under row-level security — there's no server of ours in the middle to trust or to go down, and
// the policies in supabase/migrations/0001_init.sql are what actually enforce that you only ever
// see the computers you own or have been granted.

export interface ComputerEntry {
  /** The computer_access row id — the grant, not the computer. Needed to delete a share. */
  accessId: string;
  role: "owner" | "guest";
  lastConnectedAt: string | null;
  computer: Computer;
}

/** A host is only really reachable if its socket is up *and* it has checked in recently. Without
 *  the second half, a host that lost power leaves `online = true` behind forever and the dashboard
 *  cheerfully offers a Connect button that can only ever time out. */
const STALE_AFTER_MS = 90_000;

export function isComputerOnline(computer: Computer): boolean {
  if (!computer.online) return false;
  if (!computer.last_seen_at) return false;
  return Date.now() - new Date(computer.last_seen_at).getTime() < STALE_AFTER_MS;
}

export async function listComputers(): Promise<ComputerEntry[]> {
  const { data, error } = await supabase
    .from("computer_access")
    .select("id, role, last_connected_at, computer:computers(*)");
  if (error) throw error;

  const rows = (data ?? []) as unknown as Array<{
    id: string;
    role: "owner" | "guest";
    last_connected_at: string | null;
    computer: Computer | null;
  }>;

  return rows
    .filter((row): row is typeof row & { computer: Computer } => row.computer !== null)
    .map((row) => ({
      accessId: row.id,
      role: row.role,
      lastConnectedAt: row.last_connected_at,
      computer: row.computer,
    }))
    .sort((a, b) => {
      // Reachable machines first — that's what the page is for — then most recently used.
      const onlineDelta = Number(isComputerOnline(b.computer)) - Number(isComputerOnline(a.computer));
      if (onlineDelta !== 0) return onlineDelta;
      return (b.lastConnectedAt ?? "").localeCompare(a.lastConnectedAt ?? "");
    });
}

export async function renameComputer(computerId: string, name: string): Promise<void> {
  const { error } = await supabase.from("computers").update({ name }).eq("id", computerId);
  if (error) throw error;
}

/** Sets, changes, or (pin === null) clears this computer's connect PIN — an owner-only,
 *  no-share-needed way for someone to reach it via Connect by Host ID. Only the SHA-256 hash
 *  ever leaves the browser, same as the host's own token; the plaintext PIN is never sent
 *  anywhere or stored anywhere. */
export async function setComputerPin(computerId: string, pin: string | null): Promise<void> {
  const pinHash = pin ? await sha256Hex(pin) : null;
  const { error } = await supabase.from("computers").update({ pin_hash: pinHash }).eq("id", computerId);
  if (error) throw error;
}

/** Owner-only: unregisters the machine entirely. Every grant on it cascades away, and the host's
 *  token stops working — it would have to be enrolled again from scratch. */
export async function deleteComputer(computerId: string): Promise<void> {
  const { error } = await supabase.from("computers").delete().eq("id", computerId);
  if (error) throw error;
}

/** Guest-only: drops this computer off your own dashboard without touching anyone else's access. */
export async function leaveComputer(accessId: string): Promise<void> {
  const { error } = await supabase.from("computer_access").delete().eq("id", accessId);
  if (error) throw error;
}

export interface Grant {
  accessId: string;
  role: "owner" | "guest";
  createdAt: string;
  profile: Profile | null;
}

export async function listGrants(computerId: string): Promise<Grant[]> {
  const { data, error } = await supabase
    .from("computer_access")
    .select("id, role, created_at, account_id, profile:profiles(*)")
    .eq("computer_id", computerId);
  if (error) throw error;

  const rows = (data ?? []) as unknown as Array<{
    id: string;
    role: "owner" | "guest";
    created_at: string;
    profile: Profile | null;
  }>;

  // Owner first, then whoever was invited, oldest first — a stable order so the list doesn't
  // reshuffle under someone's cursor after a revoke.
  return rows.sort((a, b) => {
    if (a.role !== b.role) return a.role === "owner" ? -1 : 1;
    return a.created_at.localeCompare(b.created_at);
  }).map((row) => ({
    accessId: row.id,
    role: row.role,
    createdAt: row.created_at,
    profile: row.profile,
  }));
}

export async function findProfileByUsername(username: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("username", username.toLowerCase().trim())
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function shareComputer(computerId: string, accountId: string): Promise<void> {
  const { error } = await supabase
    .from("computer_access")
    .insert({ computer_id: computerId, account_id: accountId, role: "guest" });
  // 23505 is a unique violation: they already have access, which is the outcome the caller wanted
  // anyway, so it isn't worth surfacing as a failure.
  if (error && error.code !== "23505") throw error;
}

export async function revokeAccess(accessId: string): Promise<void> {
  const { error } = await supabase.from("computer_access").delete().eq("id", accessId);
  if (error) throw error;
}

/** Bumps `last_connected_at` after a successful connection so the dashboard's ordering reflects
 *  what you actually use. Best-effort: a failure here must never break an established session. */
export async function touchLastConnected(computerId: string): Promise<void> {
  await supabase
    .from("computer_access")
    .update({ last_connected_at: new Date().toISOString() })
    .eq("computer_id", computerId)
    .eq("account_id", (await supabase.auth.getUser()).data.user?.id ?? "");
}

/** Subscribes to every change on `computers` the signed-in user is allowed to see — realtime
 *  respects RLS, so this delivers only their own machines. Returns an unsubscribe function. */
export function subscribeToComputers(onChange: () => void): () => void {
  const channel = supabase
    .channel("computers-presence")
    .on("postgres_changes", { event: "*", schema: "public", table: "computers" }, onChange)
    .subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
}

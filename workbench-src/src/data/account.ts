import { supabase } from "../lib/supabase";
import { WORKER_URL } from "../config";
import { getAccessToken } from "../auth/AuthProvider";

// Everything a signed-in account can do to itself: change its profile, email, or password
// (all direct Supabase Auth/Postgres calls, scoped by RLS to `auth.uid()`), and delete itself
// entirely (which needs the Worker, since removing an auth.users row requires the service-role
// key — a browser can never hold that).

export async function updateProfile(displayName: string, username: string): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const id = userData.user?.id;
  if (!id) throw new Error("You're not signed in.");

  const { error } = await supabase
    .from("profiles")
    .update({ display_name: displayName.trim(), username: username.trim() })
    .eq("id", id);

  if (error) {
    if (error.code === "23505") throw new Error("That username is already taken.");
    throw error;
  }
}

/** Starts an email change — Supabase sends a confirmation link to the new address (and, if
 *  "secure email change" is on, another to the old one) before it actually takes effect. */
export async function changeEmail(newEmail: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ email: newEmail.trim() });
  if (error) throw error;
}

export async function changePassword(newPassword: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

/** Permanently deletes the signed-in account. Cascades through every table that references it —
 *  every computer you own, every access grant naming you — see supabase/migrations/0001_init.sql.
 *  Irreversible; the caller is responsible for confirming with the person first. */
export async function deleteAccount(): Promise<void> {
  const token = await getAccessToken();
  if (!token) throw new Error("You're not signed in.");

  const res = await fetch(`${WORKER_URL}/account`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(await res.text());
}

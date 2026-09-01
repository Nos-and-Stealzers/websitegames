import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import type { Profile } from "../lib/database.types";

export interface AuthValue {
  /** undefined while the stored session is still being restored — distinct from null ("definitely
   *  signed out"), so the UI can hold a splash instead of flashing the sign-in screen at someone
   *  who is in fact already signed in. */
  session: Session | null | undefined;
  profile: Profile | null;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [profile, setProfile] = useState<Profile | null>(null);

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (active) setSession(data.session);
    });

    // Fires for sign-in, sign-out, token refresh, and the initial restore. Keeping the whole app
    // driven off this one subscription means a session that expires mid-use drops straight back
    // to the sign-in screen instead of leaving a dead dashboard behind.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const userId = session?.user.id;

  const loadProfile = useCallback(async () => {
    if (!userId || !session) {
      setProfile(null);
      return;
    }
    const { data } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
    if (data) {
      setProfile(data);
      return;
    }

    // No profile row for this account at all - not a timing issue, a genuinely missing row (this
    // happened to every account created before the signup trigger that creates one existed on
    // this project; see supabase/migrations/0002_backfill_missing_profiles.sql). Self-heals by
    // creating one from the same signup metadata the trigger itself would have used, rather than
    // leaving Account Settings permanently stuck blank with no way to recover.
    const meta = session.user.user_metadata as { username?: string; display_name?: string } | undefined;
    const fallbackUsername = (meta?.username || `user_${userId.replace(/-/g, "").slice(0, 8)}`).toLowerCase();

    const { data: created, error: insertError } = await supabase
      .from("profiles")
      .insert({ id: userId, username: fallbackUsername, display_name: meta?.display_name ?? null })
      .select("*")
      .maybeSingle();

    if (created) {
      setProfile(created);
      return;
    }

    // Username collision or some other one-off failure — try once more with a random suffix
    // before giving up gracefully (a still-missing profile just means Account Settings looks
    // empty again, not a crash).
    if (insertError) {
      const { data: retried } = await supabase
        .from("profiles")
        .insert({
          id: userId,
          username: `${fallbackUsername.slice(0, 19)}_${Math.random().toString(36).slice(2, 6)}`,
          display_name: meta?.display_name ?? null,
        })
        .select("*")
        .maybeSingle();
      setProfile(retried ?? null);
      return;
    }

    setProfile(null);
  }, [userId, session]);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setProfile(null);
  }, []);

  const value = useMemo<AuthValue>(
    () => ({ session: session, profile, signOut, refreshProfile: loadProfile }),
    [session, profile, signOut, loadProfile],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside <AuthProvider>");
  return value;
}

/** The access token to present to a host, guaranteed fresh: supabase-js refreshes it in the
 *  background, but a laptop waking from sleep can still hold an expired one, and a host would
 *  reject that. Always call this immediately before connecting rather than caching the result. */
export async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

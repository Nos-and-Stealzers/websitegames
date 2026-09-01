import { createClient } from "@supabase/supabase-js";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "../config";

// Deliberately untyped: passing our hand-written Database type (see database.types.ts) as
// createClient's generic collapses every query's row type to `never` under the TypeScript
// version this project builds with (6.0.x) — supabase-js's generic Schema-resolution machinery
// wasn't validated against it yet. The application code stays fully typed regardless: every
// function in src/data/*.ts declares its own return type and casts the client's result into it
// at the boundary, which is exactly where a schema mismatch would need to be caught anyway.
// Re-adding `createClient<Database>(...)` is worth retrying next time either package updates.

/** The one Supabase client for the whole app. Sessions persist in localStorage and refresh
 *  themselves in the background, which is what makes "quick login" actually quick: a returning
 *  visitor is signed in before the first paint, with no round trip to block on. */
export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: "poprd-auth",
  },
});

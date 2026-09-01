// Deployment-time configuration.
//
// The defaults point at the live deployment so a plain `npm run build` (and Vercel, which has no
// env vars set) works with no configuration at all. Override any of them with a VITE_* env var in
// .env.local — most usefully VITE_SIGNALING_URL, to point at a local `wrangler dev` server while
// working on /signaling itself.
//
// The Supabase publishable key below is *designed* to be public: it identifies the project and
// nothing more. Every table it can reach is guarded by row-level security (see
// supabase/migrations/0001_init.sql), so holding it grants no access to anyone's data. The
// service-role key — which does bypass RLS — lives only in the signaling Worker's secrets and
// never appears in this bundle.

export const WORKER_URL =
  import.meta.env.VITE_SIGNALING_URL ?? "https://poprd-signaling.stealzers-com.workers.dev";

export const SUPABASE_URL =
  import.meta.env.VITE_SUPABASE_URL ?? "https://agwjsuadacwjppkxadup.supabase.co";

export const SUPABASE_PUBLISHABLE_KEY =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "sb_publishable_4Zu7hWK_roUKZFR8O5XzTg_jbdvKFUZ";

-- =====================================================================
-- Arcade Campus Hub — quick repair / diagnostic
--
-- Run this FIRST if you see "Could not find the function ... in the
-- schema cache" for something that IS in schema.sql. It does three
-- things, in order, and tells you which one actually fixes it:
--
--   1. Checks whether the function exists in Postgres at all.
--   2. Re-grants EXECUTE on it (and everything else) in case the earlier
--      paste of schema.sql errored out partway through and silently
--      rolled back everything after the error line.
--   3. Forces PostgREST to drop its cached schema and re-read it, which
--      is the single most common cause of this exact error: the
--      function is really there, Postgres will run it fine, but the API
--      layer in front of it is holding a stale picture until this fires.
--
-- Paste this whole file into Supabase SQL Editor and run it once.
-- =====================================================================

-- ---- 1. does the function actually exist? ----
do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'accept_request'
  ) then
    raise notice 'accept_request EXISTS in Postgres. This is a PostgREST cache problem — step 3 below will fix it.';
  else
    raise notice 'accept_request is MISSING from Postgres. Your last paste of schema.sql errored out before reaching it and rolled back. Re-run the FULL schema.sql end to end, read every red error line it prints, and fix the first one — everything after that line silently never ran.';
  end if;
end $$;

-- ---- 2. re-assert every grant, in case of a partial apply ----
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;
grant select on public.custom_games_public to anon, authenticated;

do $$
declare r record;
begin
  for r in
    select p.proname as name,
           pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      -- don't touch the handful that are deliberately locked down to
      -- SECURITY DEFINER internals only (nothing here should be callable
      -- by the client) — everything else in this schema is meant to be
      -- reachable from authenticated.
      and p.proname not in ('handle_new_user', 'guard_profile_update',
        'guard_last_admin', 'guard_friendship_update', 'notify',
        'on_friendship_change', 'on_message_sent', 'on_message_touch',
        'on_profile_moderated', 'on_feedback_touched', 'log_audit',
        'make_friend_code', 'owner_username', 'blocked_between',
        'are_friends', 'in_thread', 'is_staff', 'is_admin', 'is_owner')
  loop
    begin
      execute format('grant execute on function public.%I(%s) to authenticated', r.name, r.args);
    exception when others then
      raise notice 'could not grant on %(%): %', r.name, r.args, sqlerrm;
    end;
  end loop;
end $$;

-- ---- 3. force PostgREST to forget its stale cache ----
NOTIFY pgrst, 'reload schema';

select 'done — reload the site now (hard refresh, Ctrl+Shift+R)' as result;

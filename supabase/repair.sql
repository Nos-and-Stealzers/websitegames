-- =====================================================================
-- Arcade Campus Hub — quick repair / diagnostic
--
-- Run this if you see "Could not find the function ... in the schema
-- cache" for something that IS in schema.sql — including after you've
-- already re-run schema.sql and/or this file once and it's STILL
-- showing up. This checks three separate causes, in order, and tells
-- you in plain text which one is actually happening on YOUR project:
--
--   1. The function doesn't exist at all (an earlier paste of
--      schema.sql hit an error partway through and rolled back).
--   2. It exists, but under a DIFFERENT signature than the client is
--      calling — PostgREST reports this with the exact same "could not
--      find the function" wording as "doesn't exist at all", which is
--      what makes this error so misleading. This happens when an old
--      accept_request from months ago (different parameter name/type)
--      is still sitting in the database alongside the current one —
--      CREATE OR REPLACE only overwrites a function with the identical
--      argument TYPES; a leftover with different types is a second,
--      separate function that just sits there confusing PostgREST.
--   3. It exists under the right signature, but PostgREST's cached
--      picture of the schema is stale.
--
-- Paste this whole file into Supabase SQL Editor and run it once.
-- =====================================================================

-- ---- 1 & 2. list every function actually named accept_request ----
do $$
declare
  r record;
  n int := 0;
begin
  for r in
    select pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n2 on n2.oid = p.pronamespace
    where n2.nspname = 'public' and p.proname = 'accept_request'
  loop
    n := n + 1;
    raise notice 'FOUND: public.accept_request(%)', r.args;
  end loop;

  if n = 0 then
    raise notice '=> accept_request is MISSING entirely. Your last paste of schema.sql errored out before reaching it and rolled back. Re-run the FULL schema.sql end to end and read every red error line — the FIRST one is the one that matters, everything after it silently never ran.';
  elsif n = 1 then
    raise notice '=> Exactly one accept_request exists. If the app still can''t find it, this is almost certainly a stale PostgREST cache (see step 3 below), not a database problem — proceed.';
  else
    raise notice '=> % DIFFERENT versions of accept_request exist side by side. This is very likely the real bug: the client calls accept_request with an argument named "edge" (bigint), and PostgREST can''t tell which of the % overloads you mean, so it reports "not found" even though one of them is correct. Run the DROP statements this script prints below, then re-run schema.sql once to recreate the single correct one.', n, n;

    for r in
      select pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p
      join pg_namespace n2 on n2.oid = p.pronamespace
      where n2.nspname = 'public' and p.proname = 'accept_request'
        and pg_get_function_identity_arguments(p.oid) <> 'edge bigint'
    loop
      raise notice 'RUN THIS MANUALLY:  drop function if exists public.accept_request(%);', r.args;
    end loop;
  end if;
end $$;

-- ---- same overload check for every other RPC the client calls by name ----
-- (excludes anything owned by an installed extension — citext, pg_trgm,
-- etc. legitimately ship multiple overloads of the same name and that
-- is normal, not a bug; only names below are things schema.sql defines.)
select p.proname as function_name,
       count(*) as how_many_versions,
       string_agg(pg_get_function_identity_arguments(p.oid), '  |  ') as signatures
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and not exists (
    select 1 from pg_depend d
    where d.objid = p.oid and d.deptype = 'e'
  )
group by p.proname
having count(*) > 1
order by p.proname;
-- ^ if this returns ANY rows, every one of those names has the same
--   "which overload did you mean" problem. Drop the wrong-signature one(s)
--   the same way as accept_request above, using the exact text this
--   query gives you.

-- ---- 3. re-assert every grant, in case of a partial apply ----
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

-- ---- 4. force PostgREST to forget its stale cache ----
NOTIFY pgrst, 'reload schema';

-- =====================================================================
-- If it STILL says "could not find the function" after all of the
-- above and a hard refresh (Ctrl+Shift+R) of the site:
--
-- NOTIFY pgrst, 'reload schema' asks PostgREST to reload right now, but
-- on Supabase's hosted platform that signal doesn't always reach the
-- pooled PostgREST instance your project's API is actually behind. The
-- guaranteed fix that always works on hosted Supabase:
--
--   Dashboard -> Project Settings -> General -> "Restart project"
--
-- This does a full restart of the API layer, which re-reads the schema
-- from scratch no matter what. It takes about a minute and briefly
-- drops connections, but nothing is destroyed — it is not the same as
-- pausing/deleting the project.
-- =====================================================================

select 'ran — check the NOTICE messages above, then read the note near the bottom of this file' as result;

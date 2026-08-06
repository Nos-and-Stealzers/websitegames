-- Behaviour of the owner rank, run against the real schema.sql on a real
-- Postgres. Each block prints PASS or FAIL.

\set ON_ERROR_STOP off
\pset pager off

create or replace function test_ok(label text, cond boolean, detail text default '')
returns void language plpgsql as $$
begin
  raise notice '%  %  %', case when cond then 'ok  ' else 'FAIL' end, rpad(label, 58), detail;
end;
$$;

-- ---------------------------------------------------------------- case 1
-- Stealzers signs up FIRST. Owner should be claimed at creation, not admin.

insert into auth.users (raw_user_meta_data)
values ('{"username":"Stealzers","display_name":"Stealzers"}'::jsonb);

select test_ok('first signup as the owner name gets owner',
  (select role from public.profiles where username = 'Stealzers') = 'owner',
  coalesce((select role from public.profiles where username = 'Stealzers'), 'no row'));

-- ---------------------------------------------------------------- case 2
-- Someone else signs up. Should be a plain user — the "first account is
-- admin" rule already spent itself.

insert into auth.users (raw_user_meta_data)
values ('{"username":"someone"}'::jsonb);

select test_ok('a later signup is a plain user',
  (select role from public.profiles where username = 'someone') = 'user',
  (select role from public.profiles where username = 'someone'));

-- ---------------------------------------------------------------- case 3
-- A bare UPDATE with no signed-in user changes nothing. This is the exact
-- trap the owner promotion fell into: it reports "UPDATE 1" and silently
-- reverts, because guard_profile_update asks is_admin() and auth.uid() is
-- NULL when you run SQL from the dashboard.

select set_config('test.uid', '', false);
update public.profiles set role = 'admin' where username = 'someone';
select test_ok('a role change with nobody signed in is a silent no-op',
  (select role from public.profiles where username = 'someone') = 'user',
  (select role from public.profiles where username = 'someone'));

-- Promote properly: as the owner, who is an admin and then some.
select set_config('test.uid',
  (select id::text from public.profiles where username = 'Stealzers'), false);
update public.profiles set role = 'admin' where username = 'someone';
select test_ok('the owner can promote someone to admin',
  (select role from public.profiles where username = 'someone') = 'admin',
  (select role from public.profiles where username = 'someone'));

-- ---------------------------------------------------------------- case 3b
-- Now that admin is real, check they cannot touch the owner.

select set_config('test.uid',
  (select id::text from public.profiles where username = 'someone'), false);

update public.profiles set role = 'user' where username = 'Stealzers';
select test_ok('an admin cannot demote the owner',
  (select role from public.profiles where username = 'Stealzers') = 'owner',
  (select role from public.profiles where username = 'Stealzers'));

update public.profiles set state = 'suspended' where username = 'Stealzers';
select test_ok('an admin cannot suspend the owner',
  (select state from public.profiles where username = 'Stealzers') = 'active',
  (select state from public.profiles where username = 'Stealzers'));

-- ---------------------------------------------------------------- case 4
-- The owner cannot demote themselves either — the rank exists so there is
-- always a way back in, including from your own mistake.

select set_config('test.uid',
  (select id::text from public.profiles where username = 'Stealzers'), false);
update public.profiles set role = 'user' where username = 'Stealzers';
select test_ok('the owner cannot demote themselves',
  (select role from public.profiles where username = 'Stealzers') = 'owner',
  (select role from public.profiles where username = 'Stealzers'));

-- ---------------------------------------------------------------- case 5
-- An admin CAN still moderate a normal account, or the guard is too broad.

insert into auth.users (raw_user_meta_data) values ('{"username":"bystander"}'::jsonb);
select set_config('test.uid',
  (select id::text from public.profiles where username = 'someone'), false);
update public.profiles set state = 'suspended' where username = 'bystander';
select test_ok('an admin can still suspend a normal account',
  (select state from public.profiles where username = 'bystander') = 'suspended',
  (select state from public.profiles where username = 'bystander'));

-- ---------------------------------------------------------------- case 6
-- is_staff / is_admin must treat owner as at least an admin.

select set_config('test.uid',
  (select id::text from public.profiles where username = 'Stealzers'), false);
select test_ok('is_owner true for the owner', public.is_owner());
select test_ok('is_admin true for the owner', public.is_admin());
select test_ok('is_staff true for the owner', public.is_staff());

select set_config('test.uid',
  (select id::text from public.profiles where username = 'bystander'), false);
select test_ok('is_owner false for everyone else', not public.is_owner());
select test_ok('is_staff false for a plain user', not public.is_staff());

-- ---------------------------------------------------------------- case 7
-- Only the owner may edit the catalogue.

select set_config('test.uid',
  (select id::text from public.profiles where username = 'someone'), false);
do $$
begin
  perform public.save_custom_game(
    '{"id":"x","title":"X","host":"games-huge","source":"a/b.html"}'::jsonb);
  perform test_ok('an admin cannot edit the catalogue', false, 'it was allowed');
exception when others then
  perform test_ok('an admin cannot edit the catalogue', true, SQLERRM);
end
$$;

select set_config('test.uid',
  (select id::text from public.profiles where username = 'Stealzers'), false);
do $$
begin
  perform public.save_custom_game(
    '{"id":"My Game!!","title":"My Game","host":"games-huge","source":"a/b.html"}'::jsonb);
  perform test_ok('the owner can add a game', true);
exception when others then
  perform test_ok('the owner can add a game', false, SQLERRM);
end
$$;

select test_ok('the id was slugified with no trailing dash',
  exists (select 1 from public.custom_games where game_id = 'my-game'),
  coalesce((select game_id from public.custom_games limit 1), 'no row'));

-- ---------------------------------------------------------------- case 8
-- The lockout guard must count an owner as an administrator.

select test_ok('owner counts toward the admin lockout guard',
  (select count(*) from public.profiles where role in ('admin','owner')) = 2,
  (select count(*)::text from public.profiles where role in ('admin','owner')));

reset all;

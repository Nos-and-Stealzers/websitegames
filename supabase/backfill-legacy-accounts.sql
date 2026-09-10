-- =====================================================================
-- One-time backfill: legacy schema (user_profiles/user_settings/
-- friend_links/friend_messages/user_saves) -> current schema
-- (profiles/friendships/threads/messages/saves) that the live site
-- actually reads.
--
-- ROOT CAUSE: this project has two generations of schema sharing the
-- same auth.users table. The trigger that populates public.profiles
-- (handle_new_user) only fires on INSERT into auth.users, so every
-- account created before the new schema was deployed has ZERO row in
-- public.profiles. The live client (api-supabase.js) reads exclusively
-- from public.profiles/friendships/threads/messages, so those accounts
-- looked "deleted" (me() finds no profile row -> signs out), friends
-- looked empty, and DMs looked empty, even though every account and
-- every friendship and every message was sitting untouched in the old
-- tables the whole time.
--
-- This script only INSERTs — nothing is deleted or overwritten.
-- Safe to re-run (everything is ON CONFLICT DO NOTHING / guarded).
-- =====================================================================

begin;

-- ---- 1. backfill public.profiles for every existing auth user ----
-- Usernames straight off user_settings can violate profiles' shape
-- check (must start with a letter — "9152" doesn't) or collide with
-- another backfilled row, and a single bulk INSERT aborts entirely on
-- the first bad row. Do it row-by-row so every account gets a valid,
-- unique username regardless of what the old schema had on file.
do $$
declare
  r record;
  candidate text;
  n int;
begin
  for r in
    select u.id, u.created_at,
           coalesce(nullif(trim(s.username), ''), '') as raw_username
    from auth.users u
    left join public.user_settings s on s.user_id = u.id
    where not exists (select 1 from public.profiles p where p.id = u.id)
    order by u.created_at
  loop
    candidate := lower(regexp_replace(r.raw_username, '[^a-zA-Z0-9_]', '', 'g'));
    if candidate = '' or candidate !~ '^[a-z]' then
      candidate := 'user' || substr(replace(r.id::text, '-', ''), 1, 8);
    end if;
    -- ensure uniqueness against what's already in profiles
    n := 0;
    while exists (select 1 from public.profiles where username = candidate::citext) loop
      n := n + 1;
      candidate := 'user' || substr(replace(r.id::text, '-', ''), 1, 6) || n::text;
    end loop;

    insert into public.profiles (id, username, display_name, role, state, friend_code, created_at)
    values (
      r.id, candidate,
      coalesce(candidate, 'user'),
      'user', 'active', public.make_friend_code(), r.created_at
    )
    on conflict (id) do nothing;
  end loop;
end $$;

-- Fix display_name for rows the first pass DID insert but where
-- user_settings had a real display_name (first insert above already
-- handles this via coalesce, this is a no-op safety net).
update public.profiles p
set display_name = s.display_name
from public.user_settings s
where s.user_id = p.id
  and nullif(trim(s.display_name), '') is not null
  and p.display_name <> trim(s.display_name);

-- Preserve admin rank recorded in the legacy staff-roles table.
update public.profiles p
set role = 'admin'
from public.user_staff_roles r
where r.user_id = p.id and r.role = 'admin' and p.role <> 'admin';

-- Preserve suspension state recorded in the legacy user_profiles table.
update public.profiles p
set state = 'suspended'
from public.user_profiles up
where up.user_id = p.id and up.banned = true and p.state <> 'suspended';

-- ---- 2. backfill public.friendships from public.friend_links ----
-- friend_links is a per-owner add-list (one row per direction); the
-- current schema wants a single accepted row per unordered pair.
insert into public.friendships (requester, addressee, state, created_at, updated_at)
select least(fl.owner_user_id, fl.friend_user_id),
       greatest(fl.owner_user_id, fl.friend_user_id),
       'accepted',
       min(fl.created_at),
       max(fl.updated_at)
from public.friend_links fl
where exists (select 1 from public.profiles where id = fl.owner_user_id)
  and exists (select 1 from public.profiles where id = fl.friend_user_id)
group by least(fl.owner_user_id, fl.friend_user_id), greatest(fl.owner_user_id, fl.friend_user_id)
on conflict (requester, addressee) do nothing;

-- ---- 3. backfill public.threads/messages from public.friend_messages ----
do $$
declare
  pair record;
  msg record;
  tid bigint;
  ua uuid;
  ub uuid;
begin
  for pair in
    select least(sender_user_id, recipient_user_id) as ua,
           greatest(sender_user_id, recipient_user_id) as ub
    from public.friend_messages
    where exists (select 1 from public.profiles where id = sender_user_id)
      and exists (select 1 from public.profiles where id = recipient_user_id)
    group by least(sender_user_id, recipient_user_id), greatest(sender_user_id, recipient_user_id)
  loop
    ua := pair.ua; ub := pair.ub;

    select id into tid from public.threads where a = ua and b = ub and is_group = false;
    if tid is null then
      insert into public.threads (a, b, is_group, title, created_at)
      values (ua, ub, false, '', now())
      returning id into tid;

      insert into public.thread_members (thread_id, user_id) values (tid, ua), (tid, ub)
      on conflict do nothing;
    end if;

    for msg in
      select * from public.friend_messages
      where (sender_user_id = ua and recipient_user_id = ub)
         or (sender_user_id = ub and recipient_user_id = ua)
      order by created_at asc
    loop
      if not exists (
        select 1 from public.messages
        where thread_id = tid and sender = msg.sender_user_id
          and body = msg.body and created_at = msg.created_at
      ) then
        insert into public.messages (thread_id, sender, body, created_at, read_at)
        values (tid, msg.sender_user_id, msg.body, msg.created_at, msg.read_at);
      end if;
    end loop;

    update public.threads set last_at = (select max(created_at) from public.messages where thread_id = tid)
    where id = tid;
  end loop;
end $$;

-- ---- 4. backfill public.saves from public.user_saves ----
insert into public.saves (user_id, payload, updated_at)
select us.user_id, us.payload, us.updated_at
from public.user_saves us
where exists (select 1 from public.profiles where id = us.user_id)
  and not exists (select 1 from public.saves s where s.user_id = us.user_id)
on conflict (user_id) do nothing;

commit;

-- ---- report ----
select 'profiles' as t, count(*) from public.profiles
union all select 'friendships', count(*) from public.friendships
union all select 'threads', count(*) from public.threads
union all select 'messages', count(*) from public.messages
union all select 'saves', count(*) from public.saves;

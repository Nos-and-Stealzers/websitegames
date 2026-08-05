-- =====================================================================
-- Arcade Campus Hub — Supabase schema
--
-- Run this ONCE in the Supabase SQL editor (Dashboard → SQL Editor → New
-- query → paste → Run). It is idempotent; re-running is safe.
--
-- Identity comes from Supabase Auth (auth.users). Everything else lives
-- here, guarded by row-level security so the browser's anon key can talk
-- to the database directly without a server in front of it.
--
-- READ THIS: every table has RLS enabled and a deny-by-default posture.
-- If you add a table later, enable RLS on it too, or it is world-readable
-- and world-writable by anyone holding the public anon key.
-- =====================================================================

create extension if not exists citext;

-- ---------------------------------------------------------------------
-- 1 · TABLES
-- ---------------------------------------------------------------------

create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  username      citext not null unique,
  display_name  text   not null default '',
  bio           text   not null default '',
  role          text   not null default 'user'   check (role  in ('user','mod','admin')),
  state         text   not null default 'active' check (state in ('active','suspended')),
  accepts_dms   boolean not null default true,
  show_activity boolean not null default true,
  created_at    timestamptz not null default now(),
  last_seen     timestamptz not null default now(),
  constraint username_shape check (username ~ '^[A-Za-z][A-Za-z0-9_]{2,19}$')
);

create table if not exists public.friendships (
  id         bigint generated always as identity primary key,
  requester  uuid not null references public.profiles(id) on delete cascade,
  addressee  uuid not null references public.profiles(id) on delete cascade,
  state      text not null check (state in ('pending','accepted','blocked')),
  blocked_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint no_self_friendship check (requester <> addressee),
  constraint one_row_per_pair unique (requester, addressee)
);
-- A pair must not appear twice in opposite directions either.
create unique index if not exists friendship_pair_uniq
  on public.friendships (least(requester, addressee), greatest(requester, addressee));

create table if not exists public.threads (
  id         bigint generated always as identity primary key,
  a          uuid not null references public.profiles(id) on delete cascade,
  b          uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_at    timestamptz,
  -- a is always the lower uuid, so a pair can never get two threads.
  constraint ordered_pair check (a < b),
  constraint one_thread_per_pair unique (a, b)
);

create table if not exists public.messages (
  id         bigint generated always as identity primary key,
  thread_id  bigint not null references public.threads(id) on delete cascade,
  sender     uuid   not null references public.profiles(id) on delete cascade,
  body       text   not null check (length(body) between 1 and 2000),
  created_at timestamptz not null default now(),
  read_at    timestamptz,
  deleted    boolean not null default false
);
create index if not exists messages_thread_idx on public.messages (thread_id, id);

create table if not exists public.notifications (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  kind       text not null,
  actor_id   uuid references public.profiles(id) on delete set null,
  body       text not null default '',
  link       text not null default '',
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications (user_id, id desc);

create table if not exists public.saves (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  payload    jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.game_stats (
  game_id text primary key,
  plays   bigint not null default 0,
  seconds bigint not null default 0
);

create table if not exists public.reports (
  id         bigint generated always as identity primary key,
  reporter   uuid references public.profiles(id) on delete set null,
  kind       text not null check (kind in ('user','message','game')),
  target     text not null,
  reason     text not null check (length(reason) between 4 and 1000),
  state      text not null default 'open' check (state in ('open','closed')),
  created_at timestamptz not null default now()
);

create table if not exists public.audit (
  id         bigint generated always as identity primary key,
  actor      uuid references public.profiles(id) on delete set null,
  action     text not null,
  detail     text not null default '',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2 · HELPERS
--
-- SECURITY DEFINER with a pinned search_path. These are called from RLS
-- policies; without DEFINER the policy would re-enter RLS on the same
-- table and recurse forever.
-- ---------------------------------------------------------------------

create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
     where id = auth.uid() and role in ('admin','mod')
  );
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
     where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.blocked_between(x uuid, y uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.friendships f
     where f.state = 'blocked'
       and ((f.requester = x and f.addressee = y)
         or (f.requester = y and f.addressee = x))
  );
$$;

create or replace function public.are_friends(x uuid, y uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.friendships f
     where f.state = 'accepted'
       and ((f.requester = x and f.addressee = y)
         or (f.requester = y and f.addressee = x))
  );
$$;

create or replace function public.in_thread(t bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.threads
     where id = t and (a = auth.uid() or b = auth.uid())
  );
$$;

-- ---------------------------------------------------------------------
-- 3 · PROFILE CREATION
--
-- A profile is minted by trigger the moment Supabase Auth creates a user,
-- so the client never inserts into profiles directly. The very first
-- account becomes the administrator — otherwise a fresh project has no
-- way in.
-- ---------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  wanted text;
  is_first boolean;
begin
  wanted := coalesce(new.raw_user_meta_data->>'username', 'user' || left(new.id::text, 8));
  select count(*) = 0 into is_first from public.profiles;

  insert into public.profiles (id, username, display_name, role)
  values (
    new.id,
    wanted,
    coalesce(nullif(new.raw_user_meta_data->>'display_name',''), wanted),
    case when is_first then 'admin' else 'user' end
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- 4 · PRIVILEGE GUARD
--
-- THE most important trigger here. Without it, RLS would happily let a
-- user run  update profiles set role='admin' where id = auth.uid()
-- because the row is theirs. RLS grants row access, not column access.
-- ---------------------------------------------------------------------

create or replace function public.guard_profile_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    new.role  := old.role;    -- silently ignore attempts to change these
    new.state := old.state;
  end if;
  new.id         := old.id;
  new.username   := old.username;   -- handles are permanent
  new.created_at := old.created_at;
  return new;
end;
$$;

drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard
  before update on public.profiles
  for each row execute function public.guard_profile_update();

-- Losing the last admin would lock the project out permanently.
create or replace function public.guard_last_admin()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.role = 'admin' and new.role <> 'admin' then
    if (select count(*) from public.profiles where role = 'admin') <= 1 then
      raise exception 'That is the last administrator.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_last_admin on public.profiles;
create trigger profiles_last_admin
  before update on public.profiles
  for each row execute function public.guard_last_admin();

-- ---------------------------------------------------------------------
-- 5 · ROW LEVEL SECURITY
--
-- Enabled on every table. No policy means no access, which is the
-- posture we want for anything reached with a public anon key.
-- ---------------------------------------------------------------------

alter table public.profiles      enable row level security;
alter table public.friendships   enable row level security;
alter table public.threads       enable row level security;
alter table public.messages      enable row level security;
alter table public.notifications enable row level security;
alter table public.saves         enable row level security;
alter table public.game_stats    enable row level security;
alter table public.reports       enable row level security;
alter table public.audit         enable row level security;

-- ---- profiles ----
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select
  to authenticated
  using (
    id = auth.uid()
    or public.is_staff()
    or not public.blocked_between(auth.uid(), id)   -- blocks hide both ways
  );

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update
  to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

drop policy if exists profiles_delete_own on public.profiles;
create policy profiles_delete_own on public.profiles for delete
  to authenticated
  using (id = auth.uid() or public.is_admin());

-- ---- friendships ----
drop policy if exists friendships_read on public.friendships;
create policy friendships_read on public.friendships for select
  to authenticated
  using (requester = auth.uid() or addressee = auth.uid() or public.is_staff());

drop policy if exists friendships_insert on public.friendships;
create policy friendships_insert on public.friendships for insert
  to authenticated
  with check (
    requester = auth.uid()
    and addressee <> auth.uid()
    and not public.blocked_between(auth.uid(), addressee)
  );

drop policy if exists friendships_update on public.friendships;
create policy friendships_update on public.friendships for update
  to authenticated
  using (requester = auth.uid() or addressee = auth.uid())
  with check (requester = auth.uid() or addressee = auth.uid());

drop policy if exists friendships_delete on public.friendships;
create policy friendships_delete on public.friendships for delete
  to authenticated
  using (requester = auth.uid() or addressee = auth.uid());

-- ---- threads ----
drop policy if exists threads_read on public.threads;
create policy threads_read on public.threads for select
  to authenticated
  using (a = auth.uid() or b = auth.uid());

drop policy if exists threads_insert on public.threads;
create policy threads_insert on public.threads for insert
  to authenticated
  with check (
    (a = auth.uid() or b = auth.uid())
    and not public.blocked_between(a, b)
  );

drop policy if exists threads_update on public.threads;
create policy threads_update on public.threads for update
  to authenticated
  using (a = auth.uid() or b = auth.uid())
  with check (a = auth.uid() or b = auth.uid());

-- ---- messages ----
drop policy if exists messages_read on public.messages;
create policy messages_read on public.messages for select
  to authenticated
  using (public.in_thread(thread_id));

drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert
  to authenticated
  with check (sender = auth.uid() and public.in_thread(thread_id));

-- Retract your own; moderators can remove anything.
drop policy if exists messages_update on public.messages;
create policy messages_update on public.messages for update
  to authenticated
  using (sender = auth.uid() or public.is_staff() or public.in_thread(thread_id))
  with check (sender = auth.uid() or public.is_staff() or public.in_thread(thread_id));

-- ---- notifications ----
-- Read/modify your own only. Inserts happen through SECURITY DEFINER
-- triggers, never from the client, so nobody can spam someone's bell.
drop policy if exists notifications_own on public.notifications;
create policy notifications_own on public.notifications for select
  to authenticated using (user_id = auth.uid());

drop policy if exists notifications_update_own on public.notifications;
create policy notifications_update_own on public.notifications for update
  to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists notifications_delete_own on public.notifications;
create policy notifications_delete_own on public.notifications for delete
  to authenticated using (user_id = auth.uid());

-- ---- saves ----
drop policy if exists saves_own on public.saves;
create policy saves_own on public.saves for all
  to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---- game_stats ----
-- Public leaderboard; writes go through the sync RPC only.
drop policy if exists game_stats_read on public.game_stats;
create policy game_stats_read on public.game_stats for select
  to anon, authenticated using (true);

-- ---- reports ----
drop policy if exists reports_insert on public.reports;
create policy reports_insert on public.reports for insert
  to authenticated with check (reporter = auth.uid());

drop policy if exists reports_staff_read on public.reports;
create policy reports_staff_read on public.reports for select
  to authenticated using (public.is_staff() or reporter = auth.uid());

drop policy if exists reports_staff_update on public.reports;
create policy reports_staff_update on public.reports for update
  to authenticated using (public.is_staff()) with check (public.is_staff());

-- ---- audit ----
drop policy if exists audit_staff_read on public.audit;
create policy audit_staff_read on public.audit for select
  to authenticated using (public.is_staff());

-- ---------------------------------------------------------------------
-- 6 · NOTIFICATION TRIGGERS
--
-- Server-authoritative: the client cannot insert notifications, so these
-- are the only way a bell appears.
-- ---------------------------------------------------------------------

create or replace function public.notify(
  target uuid, kind text, actor uuid, body text, link text,
  quiet_minutes int default 0
) returns void language plpgsql security definer set search_path = public as $$
declare recent bigint;
begin
  if target is null or target = actor then return; end if;

  if quiet_minutes > 0 then
    select id into recent from public.notifications
     where user_id = target and notifications.kind = notify.kind
       and coalesce(actor_id, '00000000-0000-0000-0000-000000000000'::uuid)
           = coalesce(actor,  '00000000-0000-0000-0000-000000000000'::uuid)
       and created_at > now() - make_interval(mins => quiet_minutes)
     order by id desc limit 1;

    if recent is not null then
      update public.notifications
         set created_at = now(), read_at = null, body = notify.body
       where id = recent;
      return;
    end if;
  end if;

  insert into public.notifications (user_id, kind, actor_id, body, link)
  values (target, notify.kind, actor, left(notify.body, 300), left(notify.link, 200));
end;
$$;

create or replace function public.on_friendship_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare who text;
begin
  if TG_OP = 'INSERT' and new.state = 'pending' then
    select coalesce(nullif(display_name,''), username) into who
      from public.profiles where id = new.requester;
    perform public.notify(new.addressee, 'friend-request', new.requester,
      who || ' sent you a friend request', 'friends.html');

  elsif TG_OP = 'UPDATE' and new.state = 'accepted' and old.state = 'pending' then
    select coalesce(nullif(display_name,''), username) into who
      from public.profiles where id = new.addressee;
    perform public.notify(new.requester, 'friend-accept', new.addressee,
      who || ' accepted your friend request', 'friends.html');
  end if;
  return new;
end;
$$;

drop trigger if exists friendships_notify on public.friendships;
create trigger friendships_notify
  after insert or update on public.friendships
  for each row execute function public.on_friendship_change();

create or replace function public.on_message_sent()
returns trigger language plpgsql security definer set search_path = public as $$
declare other uuid; who text;
begin
  select case when a = new.sender then b else a end into other
    from public.threads where id = new.thread_id;

  select coalesce(nullif(display_name,''), username) into who
    from public.profiles where id = new.sender;

  -- One ping per sender per 5 minutes, so a chatty friend is one bell.
  perform public.notify(other, 'message', new.sender,
    'New message from ' || who,
    'messages.html?thread=' || new.thread_id, 5);

  update public.threads set last_at = now() where id = new.thread_id;
  return new;
end;
$$;

drop trigger if exists messages_notify on public.messages;
create trigger messages_notify
  after insert on public.messages
  for each row execute function public.on_message_sent();

create or replace function public.on_profile_moderated()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.role <> old.role then
    perform public.notify(new.id, 'role', auth.uid(),
      case when new.role = 'user' then 'Your staff access was removed'
           when new.role = 'admin' then 'You were made an administrator'
           else 'You were made a moderator' end,
      case when new.role = 'user' then '' else 'admin.html' end);
  end if;

  if new.state <> old.state then
    perform public.notify(new.id, 'state', auth.uid(),
      case when new.state = 'suspended' then 'Your account was suspended'
           else 'Your account was reinstated' end, '');
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_moderation_notify on public.profiles;
create trigger profiles_moderation_notify
  after update on public.profiles
  for each row execute function public.on_profile_moderated();

-- ---------------------------------------------------------------------
-- 7 · RPCs
--
-- Operations that need logic the client must not be trusted with.
-- ---------------------------------------------------------------------

-- Merge rather than overwrite: union of pins, newest-wins recents,
-- max-wins playtime. A second device can never wipe the first.
create or replace function public.sync_save(incoming jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  stored jsonb;
  merged jsonb;
  gid text;
  before_plays bigint;
  before_secs bigint;
begin
  if auth.uid() is null then raise exception 'Not signed in.'; end if;
  if pg_column_size(incoming) > 524288 then raise exception 'That save is too large.'; end if;

  select payload into stored from public.saves where user_id = auth.uid();
  stored := coalesce(stored, '{}'::jsonb);

  merged := jsonb_build_object(
    'version', 2,
    'favorites', (
      select coalesce(jsonb_agg(distinct v), '[]'::jsonb) from (
        select jsonb_array_elements_text(coalesce(stored->'favorites','[]'::jsonb)) v
        union
        select jsonb_array_elements_text(coalesce(incoming->'favorites','[]'::jsonb))
      ) s
    ),
    'recents', coalesce(incoming->'recents', stored->'recents', '[]'::jsonb),
    'ratings', coalesce(stored->'ratings','{}'::jsonb) || coalesce(incoming->'ratings','{}'::jsonb),
    'stats', (
      select coalesce(jsonb_object_agg(k, jsonb_build_object(
               'plays',   greatest((coalesce(stored->'stats'->k->>'plays','0'))::bigint,
                                   (coalesce(incoming->'stats'->k->>'plays','0'))::bigint),
               'seconds', greatest((coalesce(stored->'stats'->k->>'seconds','0'))::bigint,
                                   (coalesce(incoming->'stats'->k->>'seconds','0'))::bigint),
               'last',    greatest((coalesce(stored->'stats'->k->>'last','0'))::bigint,
                                   (coalesce(incoming->'stats'->k->>'last','0'))::bigint)
             )), '{}'::jsonb)
      from (
        select jsonb_object_keys(coalesce(stored->'stats','{}'::jsonb)) k
        union
        select jsonb_object_keys(coalesce(incoming->'stats','{}'::jsonb))
      ) keys
    )
  );

  -- Roll the delta into the public leaderboard.
  for gid in select jsonb_object_keys(merged->'stats') loop
    before_plays := coalesce((stored->'stats'->gid->>'plays')::bigint, 0);
    before_secs  := coalesce((stored->'stats'->gid->>'seconds')::bigint, 0);

    insert into public.game_stats (game_id, plays, seconds)
    values (
      left(gid, 120),
      greatest((merged->'stats'->gid->>'plays')::bigint   - before_plays, 0),
      greatest((merged->'stats'->gid->>'seconds')::bigint - before_secs, 0)
    )
    on conflict (game_id) do update
      set plays   = public.game_stats.plays   + excluded.plays,
          seconds = public.game_stats.seconds + excluded.seconds;
  end loop;

  insert into public.saves (user_id, payload, updated_at)
  values (auth.uid(), merged, now())
  on conflict (user_id) do update set payload = excluded.payload, updated_at = now();

  return merged;
end;
$$;

-- Open (or reuse) the thread with someone, enforcing the DM privacy rules.
create or replace function public.open_thread(with_username text)
returns bigint language plpgsql security definer set search_path = public as $$
declare other uuid; lo uuid; hi uuid; tid bigint; ok_dm boolean; other_state text;
begin
  if auth.uid() is null then raise exception 'Not signed in.'; end if;

  select id, accepts_dms, state into other, ok_dm, other_state
    from public.profiles where username = with_username;

  if other is null then raise exception 'No such user.'; end if;
  if other = auth.uid() then raise exception 'You cannot message yourself.'; end if;
  if other_state = 'suspended' then raise exception 'That account is suspended.'; end if;
  if public.blocked_between(auth.uid(), other) then raise exception 'You cannot message this person.'; end if;
  if not ok_dm and not public.are_friends(auth.uid(), other) then
    raise exception 'This person only accepts messages from friends.';
  end if;

  lo := least(auth.uid(), other);
  hi := greatest(auth.uid(), other);

  select id into tid from public.threads where a = lo and b = hi;
  if tid is null then
    insert into public.threads (a, b) values (lo, hi) returning id into tid;
  end if;
  return tid;
end;
$$;

create or replace function public.mark_notifications_read(ids bigint[] default null)
returns bigint language plpgsql security definer set search_path = public as $$
begin
  if ids is null then
    update public.notifications set read_at = now()
     where user_id = auth.uid() and read_at is null;
  else
    update public.notifications set read_at = now()
     where user_id = auth.uid() and read_at is null and id = any(ids);
  end if;
  return (select count(*) from public.notifications
           where user_id = auth.uid() and read_at is null);
end;
$$;

-- Rail badges in one round trip.
create or replace function public.badge_counts()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'messages', (
      select count(*) from public.messages m join public.threads t on t.id = m.thread_id
       where (t.a = auth.uid() or t.b = auth.uid())
         and m.sender <> auth.uid() and m.read_at is null and not m.deleted
    ),
    'requests', (
      select count(*) from public.friendships
       where addressee = auth.uid() and state = 'pending'
    ),
    'notifications', (
      select count(*) from public.notifications
       where user_id = auth.uid() and read_at is null
    )
  );
$$;

create or replace function public.touch_last_seen()
returns void language sql security definer set search_path = public as $$
  update public.profiles set last_seen = now() where id = auth.uid();
$$;

-- ---------------------------------------------------------------------
-- 8 · GRANTS
--
-- RLS decides rows; these decide who may call the functions at all.
-- ---------------------------------------------------------------------

revoke all on function public.sync_save(jsonb) from public, anon;
revoke all on function public.open_thread(text) from public, anon;
revoke all on function public.mark_notifications_read(bigint[]) from public, anon;
revoke all on function public.badge_counts() from public, anon;
revoke all on function public.touch_last_seen() from public, anon;
revoke all on function public.notify(uuid, text, uuid, text, text, int) from public, anon, authenticated;

grant execute on function public.sync_save(jsonb)                  to authenticated;
grant execute on function public.open_thread(text)                 to authenticated;
grant execute on function public.mark_notifications_read(bigint[]) to authenticated;
grant execute on function public.badge_counts()                    to authenticated;
grant execute on function public.touch_last_seen()                 to authenticated;

-- =====================================================================
-- Done. Next:
--   1. Authentication → Providers → Email: turn OFF "Confirm email"
--      (the hub signs up with username-derived addresses, so there is
--       no inbox to confirm from).
--   2. Create your account in the app — the FIRST one becomes admin.
-- =====================================================================

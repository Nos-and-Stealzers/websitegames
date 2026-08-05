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
-- 9 · FRIEND CODES, GROUPS, ATTACHMENTS
--
-- Parity with the Node backend. Everything below is additive and
-- idempotent, so re-running this whole file is safe.
-- =====================================================================

-- ---- friend codes ----

alter table public.profiles add column if not exists friend_code text;
create unique index if not exists profiles_code_uniq on public.profiles (friend_code);

-- Ambiguous glyphs (O/0, I/1/L) left out so a code survives being read aloud.
create or replace function public.make_friend_code()
returns text language plpgsql security definer set search_path = public as $$
declare
  alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  candidate text;
  i int;
begin
  for attempt in 1..40 loop
    candidate := '';
    for i in 1..6 loop
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    candidate := substr(candidate, 1, 3) || '-' || substr(candidate, 4, 3);
    if not exists (select 1 from public.profiles where friend_code = candidate) then
      return candidate;
    end if;
  end loop;
  raise exception 'Could not allocate a friend code.';
end;
$$;

update public.profiles set friend_code = public.make_friend_code() where friend_code is null;

create or replace function public.rotate_friend_code()
returns text language plpgsql security definer set search_path = public as $$
declare fresh text;
begin
  if auth.uid() is null then raise exception 'Not signed in.'; end if;
  fresh := public.make_friend_code();
  update public.profiles set friend_code = fresh where id = auth.uid();
  return fresh;
end;
$$;

-- A code is a lookup key, not a public field: this returns only the bare
-- minimum, and never exposes anyone else's code.
create or replace function public.find_by_code(code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare tidy text; hit public.profiles%rowtype;
begin
  if auth.uid() is null then raise exception 'Not signed in.'; end if;
  tidy := upper(regexp_replace(coalesce(code, ''), '[^A-Za-z0-9]', '', 'g'));
  if length(tidy) <> 6 then raise exception 'Friend codes are six characters, like ABC-123.'; end if;
  tidy := substr(tidy, 1, 3) || '-' || substr(tidy, 4, 3);

  select * into hit from public.profiles where friend_code = tidy;
  if hit.id is null then raise exception 'No account uses that code.'; end if;
  if hit.id = auth.uid() then raise exception 'That is your own code.'; end if;
  if public.blocked_between(auth.uid(), hit.id) then raise exception 'No account uses that code.'; end if;

  return jsonb_build_object(
    'id', hit.id, 'username', hit.username,
    'displayName', coalesce(nullif(hit.display_name, ''), hit.username),
    'online', (now() - hit.last_seen) < interval '150 seconds'
  );
end;
$$;

-- ---- groups ----

alter table public.threads add column if not exists is_group boolean not null default false;
alter table public.threads add column if not exists title text not null default '';
alter table public.threads add column if not exists owner_id uuid references public.profiles(id) on delete set null;

-- A group has no pair, so the ordered-pair constraint can only apply to DMs.
alter table public.threads drop constraint if exists ordered_pair;
alter table public.threads drop constraint if exists one_thread_per_pair;
alter table public.threads alter column a drop not null;
alter table public.threads alter column b drop not null;
create unique index if not exists threads_dm_uniq on public.threads (a, b) where is_group = false;

create table if not exists public.thread_members (
  thread_id bigint not null references public.threads(id) on delete cascade,
  user_id   uuid   not null references public.profiles(id) on delete cascade,
  role      text   not null default 'member',
  joined_at timestamptz not null default now(),
  primary key (thread_id, user_id)
);
create index if not exists thread_members_user on public.thread_members (user_id);

-- Back-fill membership for threads created before groups existed.
insert into public.thread_members (thread_id, user_id)
  select t.id, t.a from public.threads t where t.a is not null
   on conflict do nothing;
insert into public.thread_members (thread_id, user_id)
  select t.id, t.b from public.threads t where t.b is not null
   on conflict do nothing;

alter table public.thread_members enable row level security;

drop policy if exists thread_members_read on public.thread_members;
create policy thread_members_read on public.thread_members for select
  to authenticated using (public.in_thread(thread_id));

-- Membership changes go through the RPCs below, never direct writes.

-- Membership is now the single source of truth for thread access.
create or replace function public.in_thread(t bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.thread_members where thread_id = t and user_id = auth.uid()
  );
$$;

drop policy if exists threads_read on public.threads;
create policy threads_read on public.threads for select
  to authenticated using (public.in_thread(id));

drop policy if exists threads_insert on public.threads;
drop policy if exists threads_update on public.threads;

-- ---- attachments ----

create table if not exists public.attachments (
  id          bigint generated always as identity primary key,
  thread_id   bigint not null references public.threads(id) on delete cascade,
  uploader    uuid   not null references public.profiles(id) on delete cascade,
  kind        text   not null default 'upload',
  mime        text   not null,
  width       int    not null default 0,
  height      int    not null default 0,
  bytes       int    not null,
  data        text   not null,          -- base64, capped by send_message
  created_at  timestamptz not null default now()
);
create index if not exists attachments_thread on public.attachments (thread_id);

alter table public.messages add column if not exists attachment_id bigint
  references public.attachments(id) on delete set null;

alter table public.attachments enable row level security;

drop policy if exists attachments_read on public.attachments;
create policy attachments_read on public.attachments for select
  to authenticated using (public.in_thread(thread_id));

-- Messages may now carry an image instead of text, so the length floor moves
-- into send_message where both halves can be checked together.
alter table public.messages drop constraint if exists messages_body_check;

-- ---- group RPCs ----

create or replace function public.create_group(title text, usernames text[])
returns bigint language plpgsql security definer set search_path = public as $$
declare tid bigint; name text; other uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in.'; end if;
  if coalesce(array_length(usernames, 1), 0) = 0 then raise exception 'Pick at least one person.'; end if;
  if array_length(usernames, 1) > 25 then raise exception 'Groups hold 25 people.'; end if;

  insert into public.threads (is_group, title, owner_id, last_at)
  values (true, left(coalesce(title, ''), 60), auth.uid(), now())
  returning id into tid;

  insert into public.thread_members (thread_id, user_id, role) values (tid, auth.uid(), 'owner');

  foreach name in array usernames loop
    select id into other from public.profiles where username = ltrim(name, '@');
    if other is null then raise exception 'No user called %.', name; end if;
    if other <> auth.uid() then
      -- Friends only, or a group becomes a way around friends-only DMs.
      if not public.are_friends(auth.uid(), other) then
        raise exception 'You can only add friends to a group — % is not one yet.', name;
      end if;
      insert into public.thread_members (thread_id, user_id) values (tid, other)
        on conflict do nothing;
      perform public.notify(other, 'group', auth.uid(),
        'You were added to ' || coalesce(nullif(title, ''), 'a group'),
        'messages.html?thread=' || tid);
    end if;
  end loop;

  return tid;
end;
$$;

create or replace function public.add_to_group(t bigint, username text)
returns void language plpgsql security definer set search_path = public as $$
declare other uuid; grp public.threads%rowtype;
begin
  select * into grp from public.threads where id = t;
  if grp.id is null or not public.in_thread(t) then raise exception 'No such thread.'; end if;
  if not grp.is_group then raise exception 'Make a group first.'; end if;
  if (select count(*) from public.thread_members where thread_id = t) >= 25 then
    raise exception 'That group is full.';
  end if;

  select id into other from public.profiles where profiles.username = ltrim(add_to_group.username, '@');
  if other is null then raise exception 'No such user.'; end if;
  if not public.are_friends(auth.uid(), other) then
    raise exception 'You can only add your own friends to a group.';
  end if;

  insert into public.thread_members (thread_id, user_id) values (t, other) on conflict do nothing;
  perform public.notify(other, 'group', auth.uid(),
    'You were added to ' || coalesce(nullif(grp.title, ''), 'a group'),
    'messages.html?thread=' || t);
end;
$$;

create or replace function public.leave_thread(t bigint, who uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare grp public.threads%rowtype; target uuid; remaining uuid;
begin
  select * into grp from public.threads where id = t;
  if grp.id is null or not public.in_thread(t) then raise exception 'No such thread.'; end if;
  if not grp.is_group then raise exception 'You cannot leave a direct message.'; end if;

  target := coalesce(who, auth.uid());
  if target <> auth.uid() and grp.owner_id <> auth.uid() then
    raise exception 'Only the owner can remove people.';
  end if;

  delete from public.thread_members where thread_id = t and user_id = target;

  select user_id into remaining from public.thread_members where thread_id = t limit 1;
  if remaining is null then
    delete from public.threads where id = t;
  elsif grp.owner_id = target then
    -- Hand ownership on rather than leaving the group headless.
    update public.threads set owner_id = remaining where id = t;
    update public.thread_members set role = 'owner' where thread_id = t and user_id = remaining;
  end if;
end;
$$;

-- The parameter is deliberately not called `title`: UPDATE ... SET takes a
-- bare column name (SET threads.title is a syntax error), so a same-named
-- parameter would be unresolvable.
--
-- Dropped first because CREATE OR REPLACE refuses to rename an input
-- parameter, and an earlier revision of this file shipped it as `title`.
drop function if exists public.rename_group(bigint, text);
create or replace function public.rename_group(t bigint, new_title text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.threads where id = t and owner_id = auth.uid()) then
    raise exception 'Only the owner can rename this.';
  end if;
  update public.threads set title = left(coalesce(new_title, ''), 60) where id = t;
end;
$$;

-- One entry point for sending, so the body/image rules and the per-thread
-- notification fan-out live in exactly one place.
create or replace function public.send_message(t bigint, body text, image jsonb default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  att bigint;
  mid bigint;
  clean text;
  raw text;
  member record;
  sender_name text;
begin
  if auth.uid() is null then raise exception 'Not signed in.'; end if;
  if not public.in_thread(t) then raise exception 'No such thread.'; end if;

  clean := btrim(coalesce(body, ''));
  if clean = '' and image is null then raise exception 'Say something or attach an image.'; end if;
  if length(clean) > 2000 then raise exception 'Message must be 2000 characters or fewer.'; end if;

  if image is not null then
    raw := image->>'dataUrl';
    if raw is null or raw !~ '^data:image/(jpeg|png|webp|gif);base64,' then
      raise exception 'Only JPEG, PNG, WebP and GIF images are allowed.';
    end if;
    raw := split_part(raw, ',', 2);
    -- base64 inflates 4/3, so this is roughly a 600 KB decoded ceiling.
    if length(raw) > 820000 then raise exception 'That image is too large.'; end if;

    insert into public.attachments (thread_id, uploader, kind, mime, width, height, bytes, data)
    values (t, auth.uid(),
            coalesce(image->>'kind', 'upload'),
            split_part(split_part(image->>'dataUrl', ';', 1), ':', 2),
            coalesce((image->>'width')::int, 0),
            coalesce((image->>'height')::int, 0),
            (length(raw) * 3) / 4,
            raw)
    returning id into att;
  end if;

  insert into public.messages (thread_id, sender, body, attachment_id)
  values (t, auth.uid(), clean, att)
  returning id into mid;

  update public.threads set last_at = now() where id = t;

  select coalesce(nullif(display_name, ''), username) into sender_name
    from public.profiles where id = auth.uid();

  for member in select user_id from public.thread_members
                 where thread_id = t and user_id <> auth.uid() loop
    perform public.notify(member.user_id, 'message', auth.uid(),
      'New message from ' || sender_name, 'messages.html?thread=' || t, 5);
  end loop;

  return mid;
end;
$$;

-- send_message is now the only way in: it enforces the body/image rules and
-- fans out notifications. Allowing a direct INSERT would bypass both, so the
-- insert policy goes away and the old notify trigger with it.
drop policy if exists messages_insert on public.messages;
drop trigger if exists messages_notify on public.messages;

create or replace function public.on_message_touch()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.threads set last_at = now() where id = new.thread_id;
  return new;
end;
$$;

drop trigger if exists messages_touch on public.messages;
create trigger messages_touch
  after insert on public.messages
  for each row execute function public.on_message_touch();

-- =====================================================================
-- 10 · FEEDBACK AND GAME PROGRESS
-- =====================================================================

create table if not exists public.feedback (
  id         bigint generated always as identity primary key,
  user_id    uuid references public.profiles(id) on delete set null,
  kind       text not null check (kind in ('bug','idea','game','other')),
  subject    text not null check (length(subject) between 3 and 120),
  body       text not null check (length(body) between 10 and 4000),
  page       text not null default '',
  game_id    text not null default '',
  agent      text not null default '',
  state      text not null default 'new' check (state in ('new','triaged','done','declined')),
  reply      text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists feedback_state on public.feedback (state, id desc);

-- One row per (account, game host): a snapshot of that origin's localStorage,
-- which is where third-party games keep progress. Never interpreted here.
create table if not exists public.game_saves (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  host       text not null,
  payload    jsonb not null default '{}'::jsonb,
  keys       int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, host)
);

alter table public.feedback   enable row level security;
alter table public.game_saves enable row level security;

-- Anonymous feedback is allowed on purpose: a broken sign-up is exactly the
-- thing someone needs to be able to report.
drop policy if exists feedback_insert on public.feedback;
create policy feedback_insert on public.feedback for insert
  to anon, authenticated
  with check (user_id is null or user_id = auth.uid());

drop policy if exists feedback_read on public.feedback;
create policy feedback_read on public.feedback for select
  to authenticated using (user_id = auth.uid() or public.is_staff());

drop policy if exists feedback_staff_update on public.feedback;
create policy feedback_staff_update on public.feedback for update
  to authenticated using (public.is_staff()) with check (public.is_staff());

drop policy if exists game_saves_own on public.game_saves;
create policy game_saves_own on public.game_saves for all
  to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Tell the reporter when staff act on their feedback.
create or replace function public.on_feedback_touched()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.user_id is null then return new; end if;
  if new.state is distinct from old.state or new.reply is distinct from old.reply then
    perform public.notify(new.user_id, 'feedback', auth.uid(),
      case when new.reply is distinct from old.reply and new.reply <> ''
           then 'A moderator replied to your feedback: ' || new.subject
           else 'Your feedback was marked ' || new.state || ': ' || new.subject end,
      'feedback.html');
  end if;
  return new;
end;
$$;

drop trigger if exists feedback_notify on public.feedback;
create trigger feedback_notify
  after update on public.feedback
  for each row execute function public.on_feedback_touched();

create or replace function public.put_game_save(host text, payload jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if auth.uid() is null then raise exception 'Not signed in.'; end if;
  if host !~ '^[A-Za-z0-9._-]{1,64}$' then raise exception 'Unknown game host.'; end if;
  if pg_column_size(payload) > 1048576 then raise exception 'That host''s saves are too large.'; end if;

  n := (select count(*) from jsonb_object_keys(coalesce(payload, '{}'::jsonb)));

  insert into public.game_saves (user_id, host, payload, keys, updated_at)
  values (auth.uid(), put_game_save.host, coalesce(payload, '{}'::jsonb), n, now())
  on conflict (user_id, host) do update
    set payload = excluded.payload, keys = excluded.keys, updated_at = now();

  return n;
end;
$$;

revoke all on function public.put_game_save(text, jsonb) from public, anon;
grant execute on function public.put_game_save(text, jsonb) to authenticated;

-- ---- admin ----
--
-- The admin console cannot be assembled from plain table reads. `profiles` is
-- readable by every signed-in user (search needs it), so building aggregates
-- client-side would hand account totals to anyone with a session — and RLS
-- returns an empty set rather than an error, so it would look like it worked.
-- These two check is_staff() and raise otherwise, restoring the same
-- server-side gate the Node backend has.

create or replace function public.admin_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare online_cut timestamptz := now() - interval '150 seconds';
begin
  if not public.is_staff() then raise exception 'You do not have access to that.'; end if;

  return jsonb_build_object(
    'users', jsonb_build_object(
      'total',       (select count(*) from public.profiles),
      'active',      (select count(*) from public.profiles where state = 'active'),
      'suspended',   (select count(*) from public.profiles where state = 'suspended'),
      'online',      (select count(*) from public.profiles where last_seen > online_cut),
      'newToday',    (select count(*) from public.profiles where created_at > now() - interval '1 day'),
      'newThisWeek', (select count(*) from public.profiles where created_at > now() - interval '7 days')
    ),
    'social', jsonb_build_object(
      'friendships',   (select count(*) from public.friendships where state = 'accepted'),
      'pending',       (select count(*) from public.friendships where state = 'pending'),
      'blocks',        (select count(*) from public.friendships where state = 'blocked'),
      'threads',       (select count(*) from public.threads),
      'messages',      (select count(*) from public.messages where not deleted),
      'messagesToday', (select count(*) from public.messages where created_at > now() - interval '1 day')
    ),
    'reports', jsonb_build_object(
      'open',  (select count(*) from public.reports where state = 'open'),
      'total', (select count(*) from public.reports)
    ),
    'sessions', 0,
    'topGames', coalesce((
      select jsonb_agg(g) from (
        select game_id as id, plays, seconds
          from public.game_stats order by seconds desc limit 10
      ) g
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.admin_users(q text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'You do not have access to that.'; end if;

  return coalesce((
    select jsonb_agg(row_to_json(u)) from (
      select p.id, p.username, p.display_name, p.bio, p.role, p.state,
             p.accepts_dms, p.created_at, p.last_seen,
             (select count(*) from public.friendships f
               where f.state = 'accepted'
                 and (f.requester = p.id or f.addressee = p.id)) as friends,
             (select count(*) from public.messages m
               where m.sender = p.id and not m.deleted)          as messages
        from public.profiles p
       where q is null or p.username ilike q || '%'
       order by p.created_at desc limit 200
    ) u
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.admin_overview()   from public, anon;
revoke all on function public.admin_users(text)  from public, anon;
grant execute on function public.admin_overview()  to authenticated;
grant execute on function public.admin_users(text) to authenticated;

-- ---- grants ----

-- Only the SECURITY DEFINER functions above may mint codes; nobody calls
-- this one directly.
revoke all on function public.make_friend_code() from public, anon, authenticated;

revoke all on function public.rotate_friend_code()               from public, anon;
revoke all on function public.find_by_code(text)                 from public, anon;
revoke all on function public.create_group(text, text[])         from public, anon;
revoke all on function public.add_to_group(bigint, text)         from public, anon;
revoke all on function public.leave_thread(bigint, uuid)         from public, anon;
revoke all on function public.rename_group(bigint, text)         from public, anon;
revoke all on function public.send_message(bigint, text, jsonb)  from public, anon;

grant execute on function public.rotate_friend_code()              to authenticated;
grant execute on function public.find_by_code(text)                to authenticated;
grant execute on function public.create_group(text, text[])        to authenticated;
grant execute on function public.add_to_group(bigint, text)        to authenticated;
grant execute on function public.leave_thread(bigint, uuid)        to authenticated;
grant execute on function public.rename_group(bigint, text)        to authenticated;
grant execute on function public.send_message(bigint, text, jsonb) to authenticated;

-- New accounts get a code at creation time.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  wanted text;
  is_first boolean;
begin
  wanted := coalesce(new.raw_user_meta_data->>'username', 'user' || left(new.id::text, 8));
  select count(*) = 0 into is_first from public.profiles;

  insert into public.profiles (id, username, display_name, role, friend_code)
  values (
    new.id,
    wanted,
    coalesce(nullif(new.raw_user_meta_data->>'display_name',''), wanted),
    case when is_first then 'admin' else 'user' end,
    public.make_friend_code()
  );
  return new;
end;
$$;

-- =====================================================================
-- Done. Next:
--   1. Authentication → Providers → Email: turn OFF "Confirm email"
--      (the hub signs up with username-derived addresses, so there is
--       no inbox to confirm from).
--   2. Create your account in the app — the FIRST one becomes admin.
-- =====================================================================

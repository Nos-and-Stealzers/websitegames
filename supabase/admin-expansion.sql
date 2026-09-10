-- Admin/mod/owner expansion: staff notes on users, site-wide announcements,
-- chat mute. Same security model as the rest of the admin surface: RPCs
-- check rank server-side, RLS backs every table, every write lands in the
-- existing audit log via log_audit().
--
-- Run once against the project. Idempotent (safe to re-run).

-- ---------------------------------------------------------------- notes
-- Staff-only notes attached to a user account — NOT visible to the user
-- themselves. This is what lets a report or a support ticket carry context
-- ("this account already got a warning on 3/1") without that context
-- leaking to the person it's about.
create table if not exists public.staff_notes (
  id          bigint generated always as identity primary key,
  target_id   uuid not null references public.profiles(id) on delete cascade,
  author_id   uuid references public.profiles(id) on delete set null,
  body        text not null check (char_length(body) between 1 and 2000),
  created_at  timestamptz not null default now()
);
create index if not exists staff_notes_target_idx on public.staff_notes(target_id, created_at desc);

alter table public.staff_notes enable row level security;
drop policy if exists staff_notes_staff_only on public.staff_notes;
create policy staff_notes_staff_only on public.staff_notes
  for all to authenticated
  using (public.is_staff())
  with check (public.is_staff());

create or replace function public.admin_add_note(target uuid, note_body text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.profiles%rowtype;
  who public.profiles%rowtype;
  row_out public.staff_notes%rowtype;
begin
  select * into me from public.profiles where id = auth.uid();
  if me.id is null or public.rank_of(me.role) < 1 then
    raise exception 'You do not have access to that.';
  end if;

  select * into who from public.profiles where id = target;
  if who.id is null then raise exception 'No such user.'; end if;

  note_body := trim(coalesce(note_body, ''));
  if note_body = '' then raise exception 'Note cannot be empty.'; end if;
  if char_length(note_body) > 2000 then raise exception 'Note is too long.'; end if;

  insert into public.staff_notes (target_id, author_id, body)
  values (target, me.id, note_body)
  returning * into row_out;

  perform public.log_audit('note-add', who.username || ': ' || left(note_body, 80));

  return jsonb_build_object(
    'id', row_out.id, 'body', row_out.body,
    'authorId', row_out.author_id, 'authorUsername', me.username,
    'createdAt', row_out.created_at
  );
end;
$$;

create or replace function public.admin_list_notes(target uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.profiles%rowtype;
begin
  select * into me from public.profiles where id = auth.uid();
  if me.id is null or public.rank_of(me.role) < 1 then
    raise exception 'You do not have access to that.';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', n.id, 'body', n.body, 'authorId', n.author_id,
      'authorUsername', p.username, 'createdAt', n.created_at
    ) order by n.created_at desc)
    from public.staff_notes n
    left join public.profiles p on p.id = n.author_id
    where n.target_id = target
  ), '[]'::jsonb);
end;
$$;

create or replace function public.admin_delete_note(note_id bigint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.profiles%rowtype;
  row_target uuid;
begin
  select * into me from public.profiles where id = auth.uid();
  if me.id is null or public.rank_of(me.role) < 1 then
    raise exception 'You do not have access to that.';
  end if;

  select target_id into row_target from public.staff_notes where id = note_id;
  if row_target is null then raise exception 'No such note.'; end if;

  delete from public.staff_notes where id = note_id;
  perform public.log_audit('note-delete', 'note #' || note_id);
  return true;
end;
$$;

-- ---------------------------------------------------------- announcements
-- Site-wide banner. One row is "live" at a time (is_active). Admin+ only —
-- a banner going out to every signed-in user is louder than a rank change.
create table if not exists public.announcements (
  id          bigint generated always as identity primary key,
  body        text not null check (char_length(body) between 1 and 500),
  severity    text not null default 'info' check (severity in ('info','warning','critical')),
  is_active   boolean not null default true,
  author_id   uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz
);
create index if not exists announcements_active_idx on public.announcements(is_active, created_at desc);

alter table public.announcements enable row level security;
drop policy if exists announcements_read_all on public.announcements;
create policy announcements_read_all on public.announcements
  for select to authenticated
  using (is_active and (expires_at is null or expires_at > now()));
drop policy if exists announcements_write_admin on public.announcements;
create policy announcements_write_admin on public.announcements
  for all to authenticated
  using (public.rank_of((select role from public.profiles where id = auth.uid())) >= 2)
  with check (public.rank_of((select role from public.profiles where id = auth.uid())) >= 2);

create or replace function public.admin_set_announcement(
  body_text text, severity_level text default 'info', ttl_hours numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.profiles%rowtype;
  row_out public.announcements%rowtype;
begin
  select * into me from public.profiles where id = auth.uid();
  if me.id is null or public.rank_of(me.role) < 2 then
    raise exception 'Only administrators can post announcements.';
  end if;

  body_text := trim(coalesce(body_text, ''));
  if body_text = '' then raise exception 'Announcement cannot be empty.'; end if;
  if severity_level not in ('info','warning','critical') then
    raise exception 'Unknown severity.';
  end if;

  update public.announcements set is_active = false where is_active;

  insert into public.announcements (body, severity, author_id, expires_at)
  values (
    body_text, severity_level, me.id,
    case when ttl_hours is null then null else now() + (ttl_hours || ' hours')::interval end
  )
  returning * into row_out;

  perform public.log_audit('announcement-set', left(body_text, 80));

  return jsonb_build_object(
    'id', row_out.id, 'body', row_out.body, 'severity', row_out.severity,
    'createdAt', row_out.created_at, 'expiresAt', row_out.expires_at
  );
end;
$$;

create or replace function public.admin_clear_announcement()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.profiles%rowtype;
begin
  select * into me from public.profiles where id = auth.uid();
  if me.id is null or public.rank_of(me.role) < 2 then
    raise exception 'Only administrators can clear announcements.';
  end if;

  update public.announcements set is_active = false where is_active;
  perform public.log_audit('announcement-clear', '');
  return true;
end;
$$;

-- Public read of the live banner. Runs for any signed-in user, RLS already
-- scopes it to active + unexpired, so this is just a convenience wrapper
-- that returns null cleanly instead of an empty array.
create or replace function public.current_announcement()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('id', id, 'body', body, 'severity', severity, 'createdAt', created_at)
  from public.announcements
  where is_active and (expires_at is null or expires_at > now())
  order by created_at desc
  limit 1;
$$;

-- ---------------------------------------------------------------- mute
-- Chat mute: a muted_until timestamp on profiles. Messages/DMs are refused
-- by the database (not just hidden client-side) while it's in the future —
-- mirrors how `suspended` already works for the whole account.
alter table public.profiles add column if not exists muted_until timestamptz;

create or replace function public.is_muted(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select muted_until > now() from public.profiles where id = uid), false);
$$;

create or replace function public.admin_set_mute(target uuid, minutes numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.profiles%rowtype;
  who public.profiles%rowtype;
  until timestamptz;
begin
  select * into me from public.profiles where id = auth.uid();
  if me.id is null or public.rank_of(me.role) < 1 then
    raise exception 'You do not have access to that.';
  end if;

  select * into who from public.profiles where id = target;
  if who.id is null then raise exception 'No such user.'; end if;
  if who.role = 'owner' then raise exception 'The owner cannot be muted.'; end if;
  if who.id = me.id then raise exception 'You cannot mute yourself.'; end if;
  if public.rank_of(me.role) <= public.rank_of(who.role) then
    raise exception 'You can only manage accounts below your own rank.';
  end if;

  if minutes is null or minutes <= 0 then
    until := null;
  else
    until := now() + (minutes || ' minutes')::interval;
  end if;

  update public.profiles set muted_until = until where id = target;

  perform public.log_audit('mute-set',
    who.username || ': ' || case when until is null then 'cleared' else 'until ' || until::text end);

  return jsonb_build_object('id', who.id, 'username', who.username, 'mutedUntil', until);
end;
$$;

-- Enforce the mute at the write layer so it can't be bypassed by any client
-- that skips the UI check. Messages table already exists; add the guard.
create or replace function public.guard_message_mute()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_muted(new.sender) then
    raise exception 'You are muted and cannot send messages right now.';
  end if;
  return new;
end;
$$;

drop trigger if exists messages_mute_guard on public.messages;
create trigger messages_mute_guard
  before insert on public.messages
  for each row execute function public.guard_message_mute();

grant execute on function public.admin_add_note(uuid, text) to authenticated;
grant execute on function public.admin_list_notes(uuid) to authenticated;
grant execute on function public.admin_delete_note(bigint) to authenticated;
grant execute on function public.admin_set_announcement(text, text, numeric) to authenticated;
grant execute on function public.admin_clear_announcement() to authenticated;
grant execute on function public.current_announcement() to authenticated;
grant execute on function public.admin_set_mute(uuid, numeric) to authenticated;

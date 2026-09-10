-- Campus+ : a real YouTube-link-embed player with personal/shared playlists.
-- Free feature, "+" is just branding (a nicer tier of the arcade, not a paywall).
--
-- Design:
--   playlists       — one row per playlist, owned by a user, public or private
--   playlist_items  — video entries in a playlist, ordered by `position`
--
-- A public playlist is readable by anyone signed in; only the owner can edit it.
-- Staff can moderate (delete) any playlist/item via the existing is_staff() check,
-- same pattern as every other moderation surface on this site.

create table if not exists public.playlists (
  id          bigint generated always as identity primary key,
  owner_id    uuid not null references public.profiles(id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 80),
  description text not null default '' check (char_length(description) <= 300),
  is_public   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists playlists_owner_idx on public.playlists(owner_id, created_at desc);
create index if not exists playlists_public_idx on public.playlists(is_public, updated_at desc) where is_public;

create table if not exists public.playlist_items (
  id          bigint generated always as identity primary key,
  playlist_id bigint not null references public.playlists(id) on delete cascade,
  video_id    text not null check (video_id ~ '^[A-Za-z0-9_-]{11}$'),  -- YouTube's fixed-length id
  title       text not null default '' check (char_length(title) <= 200),
  added_by    uuid references public.profiles(id) on delete set null,
  position    integer not null default 0,
  added_at    timestamptz not null default now()
);
create index if not exists playlist_items_playlist_idx on public.playlist_items(playlist_id, position);
create unique index if not exists playlist_items_no_dupe on public.playlist_items(playlist_id, video_id);

alter table public.playlists enable row level security;
alter table public.playlist_items enable row level security;

drop policy if exists playlists_read on public.playlists;
create policy playlists_read on public.playlists
  for select to authenticated
  using (owner_id = auth.uid() or is_public or public.is_staff());

drop policy if exists playlists_write_own on public.playlists;
create policy playlists_write_own on public.playlists
  for all to authenticated
  using (owner_id = auth.uid() or public.is_staff())
  with check (owner_id = auth.uid());

drop policy if exists playlist_items_read on public.playlist_items;
create policy playlist_items_read on public.playlist_items
  for select to authenticated
  using (exists (
    select 1 from public.playlists p
    where p.id = playlist_items.playlist_id
      and (p.owner_id = auth.uid() or p.is_public or public.is_staff())
  ));

drop policy if exists playlist_items_write on public.playlist_items;
create policy playlist_items_write on public.playlist_items
  for all to authenticated
  using (exists (
    select 1 from public.playlists p
    where p.id = playlist_items.playlist_id and (p.owner_id = auth.uid() or public.is_staff())
  ))
  with check (exists (
    select 1 from public.playlists p
    where p.id = playlist_items.playlist_id and p.owner_id = auth.uid()
  ));

-- ---------------------------------------------------------------- RPCs

create or replace function public.create_playlist(p_title text, p_description text default '', p_is_public boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  row_out public.playlists%rowtype;
begin
  if auth.uid() is null then raise exception 'Sign in required.'; end if;
  p_title := trim(coalesce(p_title, ''));
  if p_title = '' then raise exception 'Give the playlist a title.'; end if;

  insert into public.playlists (owner_id, title, description, is_public)
  values (auth.uid(), p_title, coalesce(trim(p_description), ''), coalesce(p_is_public, false))
  returning * into row_out;

  return jsonb_build_object(
    'id', row_out.id, 'title', row_out.title, 'description', row_out.description,
    'isPublic', row_out.is_public, 'createdAt', row_out.created_at
  );
end;
$$;

create or replace function public.update_playlist(p_id bigint, p_title text default null, p_description text default null, p_is_public boolean default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  owner uuid;
begin
  select owner_id into owner from public.playlists where id = p_id;
  if owner is null then raise exception 'No such playlist.'; end if;
  if owner <> auth.uid() and not public.is_staff() then raise exception 'Not your playlist.'; end if;

  update public.playlists set
    title = coalesce(nullif(trim(p_title), ''), title),
    description = coalesce(trim(p_description), description),
    is_public = coalesce(p_is_public, is_public),
    updated_at = now()
  where id = p_id;

  return true;
end;
$$;

create or replace function public.delete_playlist(p_id bigint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  owner uuid;
begin
  select owner_id into owner from public.playlists where id = p_id;
  if owner is null then raise exception 'No such playlist.'; end if;
  if owner <> auth.uid() and not public.is_staff() then raise exception 'Not your playlist.'; end if;

  delete from public.playlists where id = p_id;
  return true;
end;
$$;

-- Adds a video by YouTube ID (the client extracts the ID from whatever link
-- shape was pasted — youtu.be/, watch?v=, embed/, shorts/ — before calling this).
create or replace function public.add_playlist_item(p_playlist_id bigint, p_video_id text, p_title text default '')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  owner uuid;
  next_pos integer;
  row_out public.playlist_items%rowtype;
begin
  select owner_id into owner from public.playlists where id = p_playlist_id;
  if owner is null then raise exception 'No such playlist.'; end if;
  if owner <> auth.uid() then raise exception 'Not your playlist.'; end if;

  if p_video_id !~ '^[A-Za-z0-9_-]{11}$' then
    raise exception 'That does not look like a valid YouTube link.';
  end if;

  select coalesce(max(position), -1) + 1 into next_pos
    from public.playlist_items where playlist_id = p_playlist_id;

  insert into public.playlist_items (playlist_id, video_id, title, added_by, position)
  values (p_playlist_id, p_video_id, coalesce(trim(p_title), ''), auth.uid(), next_pos)
  on conflict (playlist_id, video_id) do nothing
  returning * into row_out;

  if row_out.id is null then
    raise exception 'That video is already in the playlist.';
  end if;

  update public.playlists set updated_at = now() where id = p_playlist_id;

  return jsonb_build_object(
    'id', row_out.id, 'videoId', row_out.video_id, 'title', row_out.title,
    'position', row_out.position, 'addedAt', row_out.added_at
  );
end;
$$;

create or replace function public.remove_playlist_item(p_item_id bigint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  owner uuid;
begin
  select p.owner_id into owner
    from public.playlist_items i join public.playlists p on p.id = i.playlist_id
    where i.id = p_item_id;
  if owner is null then raise exception 'No such item.'; end if;
  if owner <> auth.uid() and not public.is_staff() then raise exception 'Not your playlist.'; end if;

  delete from public.playlist_items where id = p_item_id;
  return true;
end;
$$;

create or replace function public.reorder_playlist_item(p_item_id bigint, p_position integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  owner uuid;
begin
  select p.owner_id into owner
    from public.playlist_items i join public.playlists p on p.id = i.playlist_id
    where i.id = p_item_id;
  if owner is null then raise exception 'No such item.'; end if;
  if owner <> auth.uid() then raise exception 'Not your playlist.'; end if;

  update public.playlist_items set position = p_position where id = p_item_id;
  return true;
end;
$$;

create or replace function public.my_playlists()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'title', p.title, 'description', p.description,
    'isPublic', p.is_public, 'createdAt', p.created_at, 'updatedAt', p.updated_at,
    'itemCount', (select count(*) from public.playlist_items i where i.playlist_id = p.id)
  ) order by p.updated_at desc), '[]'::jsonb)
  from public.playlists p
  where p.owner_id = auth.uid();
$$;

create or replace function public.public_playlists(q text default null)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'title', p.title, 'description', p.description,
    'ownerId', p.owner_id, 'ownerUsername', pr.username,
    'createdAt', p.created_at, 'updatedAt', p.updated_at,
    'itemCount', (select count(*) from public.playlist_items i where i.playlist_id = p.id)
  ) order by p.updated_at desc), '[]'::jsonb)
  from public.playlists p
  join public.profiles pr on pr.id = p.owner_id
  where p.is_public
    and (q is null or q = '' or p.title ilike '%' || q || '%')
  limit 60;
$$;

create or replace function public.playlist_detail(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  row_p public.playlists%rowtype;
  owner_name text;
begin
  select * into row_p from public.playlists where id = p_id;
  if row_p.id is null then raise exception 'No such playlist.'; end if;
  if row_p.owner_id <> auth.uid() and not row_p.is_public and not public.is_staff() then
    raise exception 'That playlist is private.';
  end if;

  select username into owner_name from public.profiles where id = row_p.owner_id;

  return jsonb_build_object(
    'id', row_p.id, 'title', row_p.title, 'description', row_p.description,
    'isPublic', row_p.is_public, 'ownerId', row_p.owner_id, 'ownerUsername', owner_name,
    'mine', row_p.owner_id = auth.uid(),
    'createdAt', row_p.created_at, 'updatedAt', row_p.updated_at,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'videoId', i.video_id, 'title', i.title,
        'position', i.position, 'addedAt', i.added_at
      ) order by i.position)
      from public.playlist_items i where i.playlist_id = row_p.id
    ), '[]'::jsonb)
  );
end;
$$;

grant execute on function public.create_playlist(text, text, boolean) to authenticated;
grant execute on function public.update_playlist(bigint, text, text, boolean) to authenticated;
grant execute on function public.delete_playlist(bigint) to authenticated;
grant execute on function public.add_playlist_item(bigint, text, text) to authenticated;
grant execute on function public.remove_playlist_item(bigint) to authenticated;
grant execute on function public.reorder_playlist_item(bigint, integer) to authenticated;
grant execute on function public.my_playlists() to authenticated;
grant execute on function public.public_playlists(text) to authenticated;
grant execute on function public.playlist_detail(bigint) to authenticated;

-- Staff moderation view: every publicly shared playlist, plus whatever staff
-- themselves own (never another user's private one — that stays private
-- even from staff, same principle as messages/DMs on this site).
create or replace function public.admin_list_playlists(q text default null)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'title', p.title, 'description', p.description,
    'isPublic', p.is_public, 'ownerId', p.owner_id, 'ownerUsername', pr.username,
    'itemCount', (select count(*) from public.playlist_items i where i.playlist_id = p.id),
    'createdAt', p.created_at, 'updatedAt', p.updated_at
  ) order by p.updated_at desc), '[]'::jsonb)
  from public.playlists p
  join public.profiles pr on pr.id = p.owner_id
  where public.is_staff()
    and (p.is_public or p.owner_id = auth.uid())
    and (q is null or q = '' or p.title ilike '%' || q || '%' or pr.username ilike '%' || q || '%')
  limit 200;
$$;

grant execute on function public.admin_list_playlists(text) to authenticated;

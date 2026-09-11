-- Campus+ is now a members-only feature (staff-granted). Enforce it at the
-- database so it can't be bypassed from the client: only members (is_plus) or
-- staff can create playlists or add videos. Reading public playlists stays
-- open (harmless), but creating requires membership.

create or replace function public.is_plus_member(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_plus from public.profiles where id = uid), false)
         or public.is_staff();
$$;

grant execute on function public.is_plus_member(uuid) to authenticated;

-- create_playlist: require membership.
create or replace function public.create_playlist(p_title text, p_description text default '', p_is_public boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  row_out public.playlists%rowtype;
  cur_count int;
  lim int;
begin
  if auth.uid() is null then raise exception 'Sign in required.'; end if;
  if not public.is_plus_member(auth.uid()) then
    raise exception 'Campus+ is a members-only feature. Ask staff to enable it for your account.';
  end if;
  p_title := trim(coalesce(p_title, ''));
  if p_title = '' then raise exception 'Give the playlist a title.'; end if;

  select count(*) into cur_count from public.playlists where owner_id = auth.uid();
  select max_playlists into lim from public.plus_limits(auth.uid());
  if cur_count >= lim then
    raise exception 'You''ve reached your playlist limit (%).', lim;
  end if;

  insert into public.playlists (owner_id, title, description, is_public)
  values (auth.uid(), p_title, coalesce(trim(p_description), ''), coalesce(p_is_public, false))
  returning * into row_out;

  return jsonb_build_object(
    'id', row_out.id, 'title', row_out.title, 'description', row_out.description,
    'isPublic', row_out.is_public, 'createdAt', row_out.created_at
  );
end;
$$;

grant execute on function public.create_playlist(text, text, boolean) to authenticated;

-- add_playlist_item: require membership too (owner is the member by definition,
-- but guard anyway in case a grant was revoked mid-session).
create or replace function public.add_playlist_item(p_playlist_id bigint, p_video_id text, p_title text default '')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  owner uuid;
  next_pos integer;
  cur_items int;
  lim int;
  row_out public.playlist_items%rowtype;
begin
  select owner_id into owner from public.playlists where id = p_playlist_id;
  if owner is null then raise exception 'No such playlist.'; end if;
  if owner <> auth.uid() then raise exception 'Not your playlist.'; end if;
  if not public.is_plus_member(auth.uid()) then
    raise exception 'Campus+ is a members-only feature. Ask staff to enable it for your account.';
  end if;

  if p_video_id !~ '^[A-Za-z0-9_-]{11}$' then
    raise exception 'That does not look like a valid YouTube link.';
  end if;

  select count(*) into cur_items from public.playlist_items where playlist_id = p_playlist_id;
  select max_items into lim from public.plus_limits(owner);
  if cur_items >= lim then
    raise exception 'This playlist is full (% videos).', lim;
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

grant execute on function public.add_playlist_item(bigint, text, text) to authenticated;

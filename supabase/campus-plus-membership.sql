-- Campus+ membership.
--
-- Campus+ itself (the video/playlist page) is free for everyone. "Campus+
-- membership" is a perk tier on top of it that staff can grant to people —
-- it lifts the free limits and shows a badge. This is the "paid or give it
-- away with better things" tier, implemented as a grant, not a payment.
--
--   free member      : up to  5 playlists, 100 videos each
--   Campus+ member   : up to 50 playlists, 500 videos each, + a badge
--
-- Staff (mod+) can grant or revoke it. The limits are enforced server-side in
-- create_playlist / add_playlist_item so they cannot be bypassed from the
-- client.

alter table public.profiles
  add column if not exists is_plus       boolean not null default false,
  add column if not exists plus_since     timestamptz,
  add column if not exists plus_grantedby uuid;

-- Limits, chosen by membership.
create or replace function public.plus_limits(uid uuid)
returns table (max_playlists int, max_items int)
language sql
stable
security definer
set search_path = public
as $$
  select
    case when p.is_plus then 50 else 5 end,
    case when p.is_plus then 500 else 100 end
  from public.profiles p where p.id = uid;
$$;

-- Staff grant / revoke.
create or replace function public.admin_set_plus(target uuid, grant_it boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_staff() then raise exception 'Staff only.'; end if;
  update public.profiles
     set is_plus = coalesce(grant_it, false),
         plus_since = case when grant_it then now() else null end,
         plus_grantedby = case when grant_it then auth.uid() else null end
   where id = target;
  return true;
end;
$$;

grant execute on function public.admin_set_plus(uuid, boolean) to authenticated;

-- Re-create create_playlist with the per-member playlist-count limit.
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
  p_title := trim(coalesce(p_title, ''));
  if p_title = '' then raise exception 'Give the playlist a title.'; end if;

  select count(*) into cur_count from public.playlists where owner_id = auth.uid();
  select max_playlists into lim from public.plus_limits(auth.uid());
  if cur_count >= lim then
    raise exception 'You''ve reached your playlist limit (%). Ask staff about Campus+ for more.', lim;
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
grant execute on function public.plus_limits(uuid) to authenticated;

-- Re-create add_playlist_item with the per-member item-count limit.
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

  if p_video_id !~ '^[A-Za-z0-9_-]{11}$' then
    raise exception 'That does not look like a valid YouTube link.';
  end if;

  select count(*) into cur_items from public.playlist_items where playlist_id = p_playlist_id;
  -- Limit is scoped to the playlist OWNER's membership, not whoever is adding.
  select max_items into lim from public.plus_limits(owner);
  if cur_items >= lim then
    raise exception 'This playlist is full (% videos). Campus+ raises the limit.', lim;
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

-- Re-create admin_users to include is_plus so the admin users tab and the
-- per-user detail panel know whether to show "Grant" or "Revoke" Campus+.
create or replace function public.admin_users(q text default null)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public', 'auth'
as $function$
begin
  if not public.is_staff() then raise exception 'You do not have access to that.'; end if;

  return coalesce((
    select jsonb_agg(row_to_json(u)) from (
      select p.id, p.username, p.display_name, p.bio, p.role, p.state,
             p.accepts_dms, p.show_activity, p.created_at, p.last_seen,
             p.current_game, p.muted_until, p.is_plus,
             lower(coalesce(au.email, '')) as email,
             (select count(*) from public.friendships f
               where f.state = 'accepted'
                 and (f.requester = p.id or f.addressee = p.id)) as friends,
             (select count(*) from public.messages m
               where m.sender = p.id and not m.deleted)          as messages,
             (select count(*) from public.reports r
               where r.kind = 'user' and lower(r.target) = lower(p.username::text)) as reports,
             (select max(l.at) from public.logins l where l.user_id = p.id) as last_login
        from public.profiles p
        left join auth.users au on au.id = p.id
       where q is null or q = ''
          or p.username ilike '%' || q || '%'
          or p.display_name ilike '%' || q || '%'
          or au.email ilike '%' || q || '%'
       order by p.created_at desc limit 200
    ) u
  ), '[]'::jsonb);
end;
$function$;

grant execute on function public.admin_users(text) to authenticated;

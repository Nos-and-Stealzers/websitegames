-- Real bans (harder than "suspended").
--
-- suspended  = can still sign in and play; social features (friends, chat,
--              calls) are refused. Reversible slap on the wrist.
-- banned     = cannot sign in AT ALL. The login lookup refuses them, so they
--              never get a session. Staff-set, with a reason, logged.
--
-- We keep this on the main profiles table (not the legacy user_profiles one)
-- so it lives with the account the rest of the app actually uses.

alter table public.profiles
  add column if not exists banned      boolean not null default false,
  add column if not exists ban_reason  text,
  add column if not exists banned_at   timestamptz,
  add column if not exists banned_by   uuid;

-- Block sign-in for banned accounts. email_for_login is the first thing the
-- client calls when logging in (username OR email -> the real email for the
-- password grant). If the resolved account is banned, hand back a sentinel
-- that can't match any real credentials, so the grant fails exactly like a
-- wrong password — and surface a clear message via a dedicated check too.
create or replace function public.email_for_login(identifier text)
returns text
language plpgsql
stable security definer
set search_path to 'public', 'auth'
as $$
declare
  found text;
  is_banned boolean := false;
begin
  if identifier is null or length(trim(identifier)) = 0 then
    return null;
  end if;

  if identifier like '%@%' then
    select p.banned into is_banned
    from public.profiles p
    join auth.users u on u.id = p.id
    where lower(u.email) = lower(trim(identifier))
    limit 1;
    if coalesce(is_banned, false) then return '__banned__'; end if;
    return lower(trim(identifier));
  end if;

  select u.email, p.banned into found, is_banned
  from public.profiles p
  join auth.users u on u.id = p.id
  where p.username = trim(identifier)::citext
  limit 1;

  if coalesce(is_banned, false) then return '__banned__'; end if;
  return coalesce(found, trim(identifier));
end;
$$;

grant execute on function public.email_for_login(text) to anon, authenticated;

-- Lets the login page tell "banned" apart from "wrong password" so it can show
-- the ban reason instead of a generic error. Safe to expose: it only reveals
-- ban status for a correct identifier, and a banned user already knows.
create or replace function public.login_ban_reason(identifier text)
returns text
language plpgsql
stable security definer
set search_path to 'public', 'auth'
as $$
declare
  r text;
  b boolean;
begin
  if identifier is null or length(trim(identifier)) = 0 then return null; end if;
  if identifier like '%@%' then
    select p.banned, p.ban_reason into b, r
    from public.profiles p join auth.users u on u.id = p.id
    where lower(u.email) = lower(trim(identifier)) limit 1;
  else
    select p.banned, p.ban_reason into b, r
    from public.profiles p
    where p.username = trim(identifier)::citext limit 1;
  end if;
  if coalesce(b, false) then
    return coalesce(nullif(trim(r), ''), 'This account has been banned.');
  end if;
  return null;
end;
$$;

grant execute on function public.login_ban_reason(text) to anon, authenticated;

-- Staff ban / unban. Same rank rules as admin_set_user: you can only act on
-- someone below your rank, never the owner, never yourself. Banning also
-- suspends (so any live session loses social features immediately) and records
-- who/why/when. Uses the audit log.
create or replace function public.admin_set_banned(target uuid, ban boolean, reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.profiles%rowtype;
  who public.profiles%rowtype;
begin
  select * into me from public.profiles where id = auth.uid();
  if me.id is null or public.rank_of(me.role) < 1 then
    raise exception 'You do not have access to that.';
  end if;
  select * into who from public.profiles where id = target;
  if who.id is null then raise exception 'No such user.'; end if;
  if who.role = 'owner' then raise exception 'The owner cannot be banned.'; end if;
  if who.id = me.id then raise exception 'You cannot ban your own account.'; end if;
  if public.rank_of(me.role) <= public.rank_of(who.role) then
    raise exception 'You can only manage accounts below your own rank.';
  end if;

  if ban then
    update public.profiles
       set banned = true,
           ban_reason = nullif(trim(coalesce(reason, '')), ''),
           banned_at = now(),
           banned_by = me.id,
           state = 'suspended'
     where id = target;
    -- Block sign-in at the Auth layer too, so a banned user can't get a token
    -- even by typing their email directly (which bypasses email_for_login).
    -- GoTrue enforces banned_until on the password grant itself. A far-future
    -- finite timestamp is used rather than 'infinity', which GoTrue mishandles.
    update auth.users
       set banned_until = (now() + interval '100 years')
     where id = target;
    perform public.log_audit('user-ban',
      who.username || coalesce(': ' || nullif(trim(coalesce(reason,'')),''), ''));
  else
    update public.profiles
       set banned = false, ban_reason = null, banned_at = null, banned_by = null,
           state = 'active'
     where id = target;
    update auth.users set banned_until = null where id = target;
    perform public.log_audit('user-unban', who.username::text);
  end if;

  select * into who from public.profiles where id = target;
  return jsonb_build_object(
    'id', who.id, 'username', who.username, 'banned', who.banned,
    'banReason', who.ban_reason, 'state', who.state
  );
end;
$$;

grant execute on function public.admin_set_banned(uuid, boolean, text) to authenticated;

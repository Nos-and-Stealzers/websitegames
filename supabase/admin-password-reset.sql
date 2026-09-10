-- =====================================================================
-- Admin user list: add email + a real "reset their password" action.
--
-- Real passwords can never be shown to staff, on this or any platform —
-- Supabase Auth stores only a one-way bcrypt hash (encrypted_password in
-- auth.users), and that is not reversible by design, not a limitation of
-- this admin panel. The actual thing account-recovery support needs is
-- the ability to SET a new password on someone's account so they can log
-- in again after losing access — this migration adds that, plus their
-- email address so staff can identify/contact the right account.
--
-- Idempotent: re-running is safe (create or replace, drop-if-exists).
-- =====================================================================

-- ---- 1. admin_users: add real email to the list staff already sees ----
create or replace function public.admin_users(q text default null)
returns jsonb
language plpgsql
stable security definer
set search_path = public, auth
as $$
begin
  if not public.is_staff() then raise exception 'You do not have access to that.'; end if;

  return coalesce((
    select jsonb_agg(row_to_json(u)) from (
      select p.id, p.username, p.display_name, p.bio, p.role, p.state,
             p.accepts_dms, p.show_activity, p.created_at, p.last_seen,
             p.current_game,
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
$$;

-- ---- 2. admin_set_password: staff sets a NEW password on an account ----
-- Same guard ladder as admin_set_user (see that function's comments):
-- the owner can never be targeted, nobody can act on themselves through
-- this path, and you may only act on an account that outranks below you.
-- Requires admin rank or higher — mods cannot reset passwords, matching
-- the existing "only administrators suspend accounts" line for state
-- changes. Every use is written to the audit log with the actor and
-- target, but never the password itself.
create or replace function public.admin_set_password(target uuid, new_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  me public.profiles%rowtype;
  who public.profiles%rowtype;
  target_email text;
begin
  select * into me from public.profiles where id = auth.uid();
  if me.id is null or public.rank_of(me.role) < 2 then
    raise exception 'Only administrators reset passwords.';
  end if;

  select * into who from public.profiles where id = target;
  if who.id is null then raise exception 'No such user.'; end if;

  if who.role = 'owner' then
    raise exception 'The owner cannot be changed by anyone.';
  end if;
  if who.id = me.id then
    raise exception 'You cannot reset your own password here — use Settings.';
  end if;
  if public.rank_of(me.role) <= public.rank_of(who.role) then
    raise exception 'You can only manage accounts below your own rank.';
  end if;

  if new_password is null or length(new_password) < 8 then
    raise exception 'Password must be at least 8 characters.';
  end if;

  update auth.users
     set encrypted_password = extensions.crypt(new_password, extensions.gen_salt('bf')),
         updated_at = now()
   where id = target
  returning email into target_email;

  -- Kill any sessions/refresh tokens the old password issued, so a
  -- lost/compromised account is actually locked out immediately rather
  -- than staying logged in somewhere on the old credentials.
  delete from auth.refresh_tokens where user_id = target::text;
  delete from auth.sessions where user_id = target;

  perform public.log_audit('password-reset', who.username || ' (' || coalesce(target_email, '') || ')');

  return jsonb_build_object('id', who.id, 'username', who.username, 'email', target_email);
end;
$$;

revoke all on function public.admin_set_password(uuid, text) from public;
grant execute on function public.admin_set_password(uuid, text) to authenticated;

notify pgrst, 'reload schema';

select 'admin_users now includes email; admin_set_password is live' as result;

-- Require a verified email before "talking" (DMs, friend requests, calls).
-- Browsing and playing games never require verification.
--
-- Grandfather everyone who already exists as verified, so turning this on
-- doesn't lock out current accounts — only new signups from here on must verify.

update public.profiles set email_verified = true where email_verified = false;

create or replace function public.require_verified()
returns void
language plpgsql
stable security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Sign in to do that.'; end if;
  if not coalesce((select email_verified from public.profiles where id = auth.uid()), false) then
    raise exception 'Verify your email first (Settings -> Verify email) to use chat, friends and calls.';
  end if;
end;
$$;

grant execute on function public.require_verified() to authenticated;

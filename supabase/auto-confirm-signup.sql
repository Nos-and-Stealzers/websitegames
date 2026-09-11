-- Fix: signup was unusable because email confirmation was required but email
-- delivery is unreliable ("email rate limit exceeded"), so brand-new accounts
-- got "Email not confirmed" on their first login and users resorted to a
-- password reset every time. Auto-confirm accounts at creation so the password
-- they chose works immediately. Email is still collected (for password reset).
--
-- Implemented as a BEFORE INSERT trigger on auth.users so it applies to every
-- new signup regardless of the GoTrue mailer_autoconfirm dashboard setting.

create or replace function public.auto_confirm_user()
returns trigger
language plpgsql
security definer
set search_path = auth, public
as $$
begin
  if new.email_confirmed_at is null then
    new.email_confirmed_at := now();
  end if;
  -- Some GoTrue versions also gate on confirmed_at (a generated/legacy column);
  -- only touch it if it exists and is writable. email_confirmed_at is the one
  -- that matters for the password grant.
  return new;
end;
$$;

drop trigger if exists on_auth_user_autoconfirm on auth.users;
create trigger on_auth_user_autoconfirm
  before insert on auth.users
  for each row execute function public.auto_confirm_user();

-- Confirm everyone currently stuck unconfirmed so they can sign in now.
update auth.users
   set email_confirmed_at = coalesce(email_confirmed_at, now())
 where email_confirmed_at is null;

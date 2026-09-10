-- Consent tracking: record which policy version each account accepted, when.
-- Local acceptance (localStorage) is the enforcement mechanism for the gate;
-- this is the durable, per-account record that backs it up and lets staff
-- confirm an account agreed to the current terms.

alter table public.profiles
  add column if not exists terms_version     text,
  add column if not exists terms_accepted_at timestamptz;

-- Called by the consent gate after the user ticks the box (best-effort).
create or replace function public.accept_policy(version text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.profiles
     set terms_version = version,
         terms_accepted_at = now()
   where id = auth.uid();
$$;

grant execute on function public.accept_policy(text) to authenticated;

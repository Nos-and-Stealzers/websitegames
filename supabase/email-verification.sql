-- Custom email verification with a 6-digit code (no reliance on Supabase's
-- rate-limited built-in mailer). Flow:
--   1. signup succeeds and auto-signs-in (unchanged), but the account starts
--      email_verified = false.
--   2. the client calls request_email_code(); we store a hashed code + expiry
--      and an Edge Function emails it via Resend.
--   3. the client calls verify_email_code(code); on match we set
--      email_verified = true.
--   4. social features (chat, friends, calls) require email_verified — you can
--      browse and play unverified, but not talk. (Enforced separately.)

alter table public.profiles
  add column if not exists email_verified boolean not null default false;

create table if not exists public.email_verifications (
  user_id     uuid primary key references public.profiles(id) on delete cascade,
  code_hash   text not null,
  expires_at  timestamptz not null,
  attempts    int not null default 0,
  last_sent   timestamptz not null default now()
);

alter table public.email_verifications enable row level security;
-- No direct client access; everything goes through security-definer RPCs.
-- (No policies = deny all for anon/authenticated, which is what we want.)

-- Mint a fresh code for the signed-in user. Rate-limited to one per 30s.
-- Returns the plaintext code ONLY to the caller (the Edge Function invokes
-- this with the user's JWT, mails it, and never stores the plaintext).
create or replace function public.request_email_code()
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  uid uuid := auth.uid();
  code text;
  existing timestamptz;
begin
  if uid is null then raise exception 'Sign in required.'; end if;

  if (select email_verified from public.profiles where id = uid) then
    raise exception 'Your email is already verified.';
  end if;

  select last_sent into existing from public.email_verifications where user_id = uid;
  if existing is not null and existing > now() - interval '30 seconds' then
    raise exception 'Please wait a moment before requesting another code.';
  end if;

  -- 6 digits, zero-padded.
  code := lpad((floor(random() * 1000000))::int::text, 6, '0');

  insert into public.email_verifications (user_id, code_hash, expires_at, attempts, last_sent)
  values (uid, extensions.crypt(code, extensions.gen_salt('bf')),
          now() + interval '15 minutes', 0, now())
  on conflict (user_id) do update
    set code_hash = excluded.code_hash,
        expires_at = excluded.expires_at,
        attempts = 0,
        last_sent = now();

  return code;
end;
$$;

grant execute on function public.request_email_code() to authenticated;

-- Check a code. Max 6 attempts per issued code, 15-minute expiry.
create or replace function public.verify_email_code(code text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  uid uuid := auth.uid();
  rec public.email_verifications%rowtype;
begin
  if uid is null then raise exception 'Sign in required.'; end if;

  if (select email_verified from public.profiles where id = uid) then
    return true;
  end if;

  select * into rec from public.email_verifications where user_id = uid;
  if rec.user_id is null then raise exception 'Request a code first.'; end if;
  if now() > rec.expires_at then raise exception 'That code has expired. Request a new one.'; end if;
  if rec.attempts >= 6 then raise exception 'Too many attempts. Request a new code.'; end if;

  update public.email_verifications set attempts = attempts + 1 where user_id = uid;

  if extensions.crypt(trim(coalesce(code, '')), rec.code_hash) = rec.code_hash then
    update public.profiles set email_verified = true where id = uid;
    delete from public.email_verifications where user_id = uid;
    return true;
  end if;

  raise exception 'That code is not right.';
end;
$$;

grant execute on function public.verify_email_code(text) to authenticated;

-- Convenience: is the current user verified?
create or replace function public.my_email_verified()
returns boolean
language sql stable security definer set search_path = public
as $$ select coalesce((select email_verified from public.profiles where id = auth.uid()), false); $$;

grant execute on function public.my_email_verified() to authenticated;

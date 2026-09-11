-- Send the verification code by email straight from Postgres via pg_net,
-- calling Resend's HTTP API. No Edge Function, no CLI, no extra token — and
-- the Resend key stays server-side inside this SECURITY DEFINER function,
-- never reaching the browser.

create extension if not exists pg_net with schema extensions;

-- Store config out of the function body so rotating the key or sender is a
-- one-line update, and the key isn't baked into every function's source.
create table if not exists public.app_secrets (
  key   text primary key,
  value text not null
);
alter table public.app_secrets enable row level security;
-- no policies => no client access at all; only SECURITY DEFINER functions read it.
revoke all on public.app_secrets from anon, authenticated;

-- The real key is set directly in the database, NOT stored in git (GitHub
-- secret scanning blocks it, rightly). This file uses a placeholder; run the
-- one-liner below manually with the real key, or it's already live in the DB.
insert into public.app_secrets (key, value) values
  ('resend_api_key', 'REPLACE_WITH_RESEND_KEY'),
  ('resend_from',    'Arcade Campus Hub <onboarding@resend.dev>')
on conflict (key) do update set value = excluded.value;

-- Rewrite request_email_code to also send the email. Still returns nothing
-- sensitive to the client (just ok/true); the code only travels by email.
drop function if exists public.request_email_code();
create or replace function public.request_email_code()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  uid uuid := auth.uid();
  code text;
  existing timestamptz;
  target_email text;
  api_key text;
  from_addr text;
  body_html text;
begin
  if uid is null then raise exception 'Sign in required.'; end if;

  if (select email_verified from public.profiles where id = uid) then
    raise exception 'Your email is already verified.';
  end if;

  select last_sent into existing from public.email_verifications where user_id = uid;
  if existing is not null and existing > now() - interval '30 seconds' then
    raise exception 'Please wait a moment before requesting another code.';
  end if;

  select lower(email) into target_email from auth.users where id = uid;
  if target_email is null then raise exception 'No email on file.'; end if;

  code := lpad((floor(random() * 1000000))::int::text, 6, '0');

  insert into public.email_verifications (user_id, code_hash, expires_at, attempts, last_sent)
  values (uid, extensions.crypt(code, extensions.gen_salt('bf')),
          now() + interval '15 minutes', 0, now())
  on conflict (user_id) do update
    set code_hash = excluded.code_hash,
        expires_at = excluded.expires_at,
        attempts = 0,
        last_sent = now();

  select value into api_key   from public.app_secrets where key = 'resend_api_key';
  select value into from_addr from public.app_secrets where key = 'resend_from';

  body_html :=
    '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:420px;margin:auto">' ||
    '<h2 style="margin:0 0 8px">Your Arcade Campus Hub code</h2>' ||
    '<p style="color:#555;margin:0 0 16px">Enter this code to verify your email:</p>' ||
    '<div style="font-size:34px;font-weight:800;letter-spacing:8px;background:#f2f3f5;' ||
    'border-radius:10px;padding:16px;text-align:center">' || code || '</div>' ||
    '<p style="color:#888;font-size:13px;margin:16px 0 0">This code expires in 15 minutes. ' ||
    'If you didn''t sign up, you can ignore this email.</p></div>';

  perform net.http_post(
    url     := 'https://api.resend.com/emails',
    headers := jsonb_build_object(
                 'Authorization', 'Bearer ' || api_key,
                 'Content-Type', 'application/json'),
    body    := jsonb_build_object(
                 'from', from_addr,
                 'to', target_email,
                 'subject', 'Your verification code: ' || code,
                 'html', body_html)
  );

  return jsonb_build_object('ok', true, 'sentTo', target_email);
end;
$$;

grant execute on function public.request_email_code() to authenticated;

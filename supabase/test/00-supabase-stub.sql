-- Minimal stand-ins for the Supabase-managed pieces schema.sql depends on,
-- so the real file can be run against a plain Postgres and its behaviour
-- observed. Only what schema.sql actually touches.

create schema if not exists auth;

create table if not exists auth.users (
  id                  uuid primary key default gen_random_uuid(),
  email               text,
  raw_user_meta_data  jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);

-- Supabase derives this from the request JWT. Here it reads a session GUC so
-- a test can say "now act as this person", and returns NULL when unset —
-- which is exactly what the SQL editor sees.
create or replace function auth.uid()
returns uuid language plpgsql stable as $$
declare v text;
begin
  v := current_setting('test.uid', true);
  if v is null or v = '' then return null; end if;
  return v::uuid;
end;
$$;

-- PostgREST's roles. RLS policies name them, so they have to exist.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end
$$;

grant usage on schema public to anon, authenticated;

-- Supabase ships these default privileges on a new project, so every table
-- the SQL editor creates is reachable by PostgREST and RLS is what decides
-- who sees which row. Without them a local run would "pass" every policy
-- test by failing at the grant instead, which proves nothing.
alter default privileges for role postgres in schema public
  grant all on tables to anon, authenticated;
alter default privileges for role postgres in schema public
  grant all on sequences to anon, authenticated;
grant all on all tables in schema public to anon, authenticated;
grant all on all sequences in schema public to anon, authenticated;

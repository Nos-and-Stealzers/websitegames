-- The state a project is in before this fix: the old role constraint that
-- stops at 'admin', and Stealzers holding admin as the first account.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username citext not null unique,
  display_name text not null default '',
  bio text not null default '',
  role text not null default 'user' check (role in ('user','mod','admin')),
  state text not null default 'active' check (state in ('active','suspended')),
  accepts_dms boolean not null default true,
  show_activity boolean not null default true,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  constraint username_shape check (username ~ '^[A-Za-z][A-Za-z0-9_]{2,19}$')
);
insert into auth.users (id, raw_user_meta_data)
values ('11111111-1111-1111-1111-111111111111','{"username":"Stealzers"}'::jsonb);
insert into public.profiles (id, username, role)
values ('11111111-1111-1111-1111-111111111111','Stealzers','admin');

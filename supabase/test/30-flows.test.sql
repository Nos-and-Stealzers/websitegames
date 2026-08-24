-- =====================================================================
-- End-to-end behaviour of the features the site actually ships:
-- sign-in, cloud saves, direct messages, group chats, calls, admin.
--
-- Runs against the real schema.sql on a real Postgres, as the
-- `authenticated` role, so row-level security is enforced exactly as
-- PostgREST enforces it. A function that only works because the SQL
-- editor runs as the table owner fails here, which is the point.
--
--   bash supabase/test/run.sh
-- =====================================================================

\set ON_ERROR_STOP off
\pset pager off
set client_min_messages = notice;

create or replace function test_ok(label text, cond boolean, detail text default '')
returns void language plpgsql as $$
begin
  raise notice '%  %  %', case when cond then 'ok  ' else 'FAIL' end, rpad(label, 56), detail;
end;
$$;

-- Runs a statement the way PostgREST would and reports whether it blew up.
-- `expect_error` is a substring of the message we require; NULL means the
-- call is expected to succeed.
create or replace function test_call(label text, stmt text, expect_error text default null)
returns void language plpgsql as $$
declare msg text;
begin
  begin
    execute stmt;
    msg := null;
  exception when others then
    msg := sqlerrm;
  end;

  if expect_error is null then
    perform test_ok(label, msg is null, coalesce(msg, ''));
  else
    perform test_ok(label, msg is not null and position(lower(expect_error) in lower(msg)) > 0,
                    coalesce(msg, 'no error raised'));
  end if;
end;
$$;

create or replace function uid_of(name text) returns uuid
language sql stable as $$ select id from public.profiles where username = name $$;

-- Become somebody. Mirrors a request arriving with that person's JWT.
create or replace function act_as(name text) returns void language plpgsql as $$
begin
  perform set_config('test.uid', coalesce(uid_of(name)::text, ''), false);
end;
$$;

create or replace function signup(name text) returns uuid
language plpgsql as $$
declare u uuid;
begin
  insert into auth.users (raw_user_meta_data)
  values (jsonb_build_object('username', name, 'display_name', name))
  returning id into u;
  return u;
end;
$$;

-- =====================================================================
-- 1 · ACCOUNTS AND SIGN-IN
-- =====================================================================
\echo ''
\echo '-- accounts'

select signup('Stealzers');
select signup('alice');
select signup('bob');
select signup('carol');
select signup('dave');

select test_ok('owner name claims the owner rank',
  (select role from public.profiles where username='Stealzers') = 'owner',
  coalesce((select role from public.profiles where username='Stealzers'),'no row'));
select test_ok('a later signup is a plain user',
  (select role from public.profiles where username='alice') = 'user',
  coalesce((select role from public.profiles where username='alice'),'no row'));
select test_ok('every account gets a friend code',
  (select count(*) from public.profiles where coalesce(friend_code,'') = '') = 0,
  (select count(*)::text from public.profiles where coalesce(friend_code,'') = ''));

set role authenticated;
select act_as('alice');

select test_ok('signed in, RLS lets me read my own profile',
  (select count(*) from public.profiles where id = uid_of('alice')) = 1);
select test_ok('RLS lets me read other profiles',
  (select count(*) from public.profiles where username = 'bob') = 1);
select test_call('touch_last_seen works', 'select public.touch_last_seen()');
select test_call('record_login works', 'select public.record_login(''test-agent'')');
select test_call('updating my own profile works',
  'update public.profiles set display_name = ''Alice A'' where id = uid_of(''alice'')');
select test_ok('the display name actually changed',
  (select display_name from public.profiles where username='alice') = 'Alice A',
  (select display_name from public.profiles where username='alice'));

update public.profiles set display_name = 'hacked' where id = uid_of('bob');
select test_ok('I cannot rewrite someone else''s profile',
  (select display_name from public.profiles where username='bob') <> 'hacked',
  (select display_name from public.profiles where username='bob'));

select test_call('I cannot promote myself',
  'update public.profiles set role = ''admin'' where id = uid_of(''alice'')');
select test_ok('...and the rank did not move',
  (select role from public.profiles where username='alice') = 'user',
  (select role from public.profiles where username='alice'));

select test_call('rotate_friend_code works', 'select public.rotate_friend_code()');
select test_call('badge_counts works', 'select public.badge_counts()');

-- =====================================================================
-- 2 · FRIENDS
-- =====================================================================
\echo ''
\echo '-- friends'

select act_as('alice');
insert into public.friendships (requester, addressee, state) values (uid_of('alice'), uid_of('bob'), 'pending');
select test_ok('a friend request lands',
  (select state from public.friendships
    where requester = uid_of('alice') and addressee = uid_of('bob')) = 'pending');

select act_as('bob');
select test_ok('the recipient sees the request',
  (select count(*) from public.friendships where addressee = uid_of('bob') and state='pending') = 1);
select test_call('accepting works',
  'select public.accept_request((select id from public.friendships
     where requester = uid_of(''alice'') and addressee = uid_of(''bob'')))');
select test_ok('...and we are friends',
  public.are_friends(uid_of('alice'), uid_of('bob')));
select act_as('alice');
select test_ok('accepting notified the requester',
  (select count(*) from public.notifications
    where user_id = uid_of('alice') and kind = 'friend-accept') = 1);
select test_ok('nobody can read another person''s notifications',
  (select count(*) from public.notifications where user_id <> uid_of('alice')) = 0);
select act_as('bob');

-- alice + carol too, so groups have three people
select act_as('alice');
insert into public.friendships (requester, addressee, state) values (uid_of('alice'), uid_of('carol'), 'pending');
select act_as('carol');
select public.accept_request((select id from public.friendships
  where requester = uid_of('alice') and addressee = uid_of('carol')));
select act_as('bob');
insert into public.friendships (requester, addressee, state) values (uid_of('bob'), uid_of('carol'), 'pending');
select act_as('carol');
select public.accept_request((select id from public.friendships
  where requester = uid_of('bob') and addressee = uid_of('carol')));

select act_as('alice');
select test_ok('find_by_code finds a person',
  (select public.find_by_code((select friend_code from public.profiles where username='bob')))
    ->>'username' = 'bob',
  coalesce((select public.find_by_code((select friend_code from public.profiles where username='bob')))::text,'null'));

-- =====================================================================
-- 3 · DIRECT MESSAGES
-- =====================================================================
\echo ''
\echo '-- direct messages'

select act_as('alice');
select set_config('test.dm', public.open_thread('bob')::text, false);
select test_ok('open_thread returns a thread', current_setting('test.dm') <> '',
  current_setting('test.dm'));
select test_ok('opening it twice reuses the same row',
  public.open_thread('bob')::text = current_setting('test.dm'));
select test_call('sending works',
  'select public.send_message(current_setting(''test.dm'')::bigint, ''hello bob'')');
select test_ok('the message is readable by the sender',
  (select count(*) from public.messages where thread_id = current_setting('test.dm')::bigint) = 1);
select test_ok('thread_list shows the conversation',
  jsonb_array_length(public.thread_list()) = 1,
  public.thread_list()::text);
select test_ok('thread_list carries a preview',
  public.thread_list()->0->'preview'->>'body' = 'hello bob',
  coalesce(public.thread_list()->0->'preview'->>'body','null'));
select test_ok('thread_list names the other member',
  public.thread_list()->0->'members'->0->>'username' = 'bob',
  coalesce(public.thread_list()->0->'members'->0->>'username','null'));

select act_as('bob');
select test_ok('the recipient can read it',
  (select count(*) from public.messages where thread_id = current_setting('test.dm')::bigint) = 1);
select test_ok('the recipient has an unread badge',
  (public.badge_counts()->>'messages')::int = 1,
  public.badge_counts()::text);
select test_ok('...and thread_list agrees',
  (public.thread_list()->0->>'unread')::int = 1);
select test_call('marking read works',
  'select public.mark_thread_read(current_setting(''test.dm'')::bigint)');
select test_ok('the badge cleared',
  (public.badge_counts()->>'messages')::int = 0,
  public.badge_counts()::text);
select test_call('I cannot retract someone else''s message',
  'select public.retract_message((select id from public.messages
     where thread_id = current_setting(''test.dm'')::bigint limit 1))',
  'not yours');

select act_as('dave');
select test_ok('an outsider sees none of the messages',
  (select count(*) from public.messages where thread_id = current_setting('test.dm')::bigint) = 0);
select test_ok('an outsider sees no thread',
  jsonb_array_length(public.thread_list()) = 0);
select test_call('an outsider cannot post into it',
  'select public.send_message(current_setting(''test.dm'')::bigint, ''intruding'')',
  'not in this conversation');

select act_as('alice');
select test_call('I can retract my own message',
  'select public.retract_message((select id from public.messages
     where thread_id = current_setting(''test.dm'')::bigint order by id limit 1))');
select test_ok('a retracted message reads as removed',
  public.thread_list()->0->'preview'->>'body' = 'message removed',
  coalesce(public.thread_list()->0->'preview'->>'body','null'));

-- =====================================================================
-- 4 · GROUP CHATS
-- =====================================================================
\echo ''
\echo '-- group chats'

select act_as('alice');
select set_config('test.grp', public.create_group('Study', array['bob'])::text, false);
select test_ok('create_group returns a thread', current_setting('test.grp') <> '',
  current_setting('test.grp'));
select test_ok('the group has both people',
  (select count(*) from public.thread_members where thread_id = current_setting('test.grp')::bigint) = 2,
  (select count(*)::text from public.thread_members where thread_id = current_setting('test.grp')::bigint));
select test_ok('the creator owns it',
  (select owner_id from public.threads where id = current_setting('test.grp')::bigint) = uid_of('alice'));
select test_call('a stranger cannot be added',
  'select public.add_to_group(current_setting(''test.grp'')::bigint, ''dave'')',
  'only add your own friends');
select test_call('a friend can be added',
  'select public.add_to_group(current_setting(''test.grp'')::bigint, ''carol'')');
select test_ok('the group now has three',
  (select count(*) from public.thread_members where thread_id = current_setting('test.grp')::bigint) = 3);
select test_call('the owner can rename it',
  'select public.rename_group(current_setting(''test.grp'')::bigint, ''Study Hall'')');
select test_ok('...and the title stuck',
  (select title from public.threads where id = current_setting('test.grp')::bigint) = 'Study Hall',
  (select title from public.threads where id = current_setting('test.grp')::bigint));
select test_call('posting to the group works',
  'select public.send_message(current_setting(''test.grp'')::bigint, ''meet at six'')');

select act_as('carol');
select test_call('a member cannot rename it',
  'select public.rename_group(current_setting(''test.grp'')::bigint, ''Mine now'')',
  'only the owner');
select test_ok('a member reads the group message',
  (select count(*) from public.messages where thread_id = current_setting('test.grp')::bigint) = 1);
select test_ok('the group counts toward the badge',
  (public.badge_counts()->>'messages')::int = 1,
  public.badge_counts()::text);
select test_ok('thread_list shows the group with its title',
  (select count(*) from jsonb_array_elements(public.thread_list()) e
    where (e->>'isGroup')::boolean and e->>'rawTitle' = 'Study Hall') = 1,
  public.thread_list()::text);
select test_ok('a group lists its other members',
  (select jsonb_array_length(e->'members') from jsonb_array_elements(public.thread_list()) e
    where (e->>'isGroup')::boolean) = 2);
select test_call('a member can leave',
  'select public.leave_thread(current_setting(''test.grp'')::bigint)');
select test_ok('...and stops seeing it',
  (select count(*) from jsonb_array_elements(public.thread_list()) e
    where (e->>'isGroup')::boolean) = 0);
select test_ok('...and stops reading its messages',
  (select count(*) from public.messages where thread_id = current_setting('test.grp')::bigint) = 0);

select act_as('dave');
select test_ok('an outsider sees nothing of the group',
  (select count(*) from public.messages where thread_id = current_setting('test.grp')::bigint) = 0);
select test_call('an outsider cannot rename it',
  'select public.rename_group(current_setting(''test.grp'')::bigint, ''hi'')', 'only the owner');
select test_call('an outsider cannot add themselves',
  'select public.add_to_group(current_setting(''test.grp'')::bigint, ''dave'')', 'no such thread');

select act_as('alice');
select test_call('the owner can remove someone',
  'select public.leave_thread(current_setting(''test.grp'')::bigint, uid_of(''bob''))');
select test_ok('...and they are gone',
  (select count(*) from public.thread_members where thread_id = current_setting('test.grp')::bigint) = 1);
select test_call('the last person leaving deletes the group',
  'select public.leave_thread(current_setting(''test.grp'')::bigint)');
select test_ok('...and the thread is gone',
  (select count(*) from public.threads where id = current_setting('test.grp')::bigint) = 0);

-- =====================================================================
-- 5 · CALLS
-- =====================================================================
\echo ''
\echo '-- calls'

select act_as('dave');
select test_call('you cannot call a stranger',
  'select public.start_call(uid_of(''alice''))', 'only call friends');

select act_as('alice');
select set_config('test.call', public.start_call(uid_of('bob'), null, 'video')::text, false);
select test_ok('start_call returns a call', current_setting('test.call') <> '',
  current_setting('test.call'));
select test_ok('the caller is joined',
  (select state from public.call_peers
    where call_id = current_setting('test.call')::bigint and user_id = uid_of('alice')) = 'joined');
select test_ok('the callee is invited',
  (select state from public.call_peers
    where call_id = current_setting('test.call')::bigint and user_id = uid_of('bob')) = 'invited');
select act_as('bob');
select test_ok('the callee was notified',
  (select count(*) from public.notifications
    where user_id = uid_of('bob') and kind = 'call') = 1,
  (select count(*)::text from public.notifications where kind='call'));
select test_ok('the callee sees it ringing',
  jsonb_array_length(public.pending_calls()) = 1, public.pending_calls()::text);
select test_ok('...and the call kind survives',
  public.pending_calls()->0->>'kind' = 'video');
select test_call('answering works', 'select public.join_call(current_setting(''test.call'')::bigint)');
select test_ok('the call goes live',
  (select state from public.calls where id = current_setting('test.call')::bigint) = 'live',
  (select state from public.calls where id = current_setting('test.call')::bigint));
select test_call('signalling works',
  'select public.send_signal(current_setting(''test.call'')::bigint, uid_of(''alice''),
     ''offer'', ''{"sdp":"x"}''::jsonb)');
select test_call('an unknown signal kind is refused',
  'select public.send_signal(current_setting(''test.call'')::bigint, uid_of(''alice''),
     ''nonsense'', ''{}''::jsonb)', 'unknown signal');

select act_as('dave');
select test_call('an outsider cannot signal into a call',
  'select public.send_signal(current_setting(''test.call'')::bigint, uid_of(''alice''),
     ''ice'', ''{}''::jsonb)', 'not in that call');
select test_call('an outsider cannot read the call',
  'select public.take_signals(current_setting(''test.call'')::bigint)', 'not in that call');
select test_ok('an outsider has no pending calls',
  jsonb_array_length(public.pending_calls()) = 0);

select act_as('alice');
select set_config('test.sig', public.take_signals(current_setting('test.call')::bigint)::text, false);
select test_ok('the offer arrived',
  jsonb_array_length((current_setting('test.sig')::jsonb)->'signals') = 1,
  current_setting('test.sig'));
select test_ok('...with its payload intact',
  (current_setting('test.sig')::jsonb)->'signals'->0->'payload'->>'sdp' = 'x');
select test_ok('...and it names the caller',
  (current_setting('test.sig')::jsonb)->'signals'->0->>'from' = uid_of('bob')::text);
select test_ok('take_signals reports the peers',
  jsonb_array_length((current_setting('test.sig')::jsonb)->'call'->'peers') = 2);
select test_ok('a signal is consumed once',
  jsonb_array_length(public.take_signals(current_setting('test.call')::bigint)->'signals') = 0);

select test_call('hanging up works', 'select public.leave_call(current_setting(''test.call'')::bigint)');
select test_ok('the call ended',
  (select state from public.calls where id = current_setting('test.call')::bigint) = 'ended',
  (select state from public.calls where id = current_setting('test.call')::bigint));
select act_as('bob');
select test_ok('the other side gets a bye',
  (select count(*) from jsonb_array_elements(
     public.take_signals(current_setting('test.call')::bigint)->'signals') e
   where e->>'kind' = 'bye') = 1);
select test_ok('an ended call is no longer pending',
  jsonb_array_length(public.pending_calls()) = 0);

-- a group call: membership is the permission, not friendship
select act_as('alice');
select set_config('test.grp2', public.create_group('Callers', array['bob','carol'])::text, false);
select set_config('test.call2',
  public.start_call(null, current_setting('test.grp2')::bigint, 'audio')::text, false);
select test_ok('a group call invites every other member',
  (select count(*) from public.call_peers
    where call_id = current_setting('test.call2')::bigint) = 3,
  (select count(*)::text from public.call_peers where call_id = current_setting('test.call2')::bigint));
select act_as('dave');
select test_call('an outsider cannot start a call in a group they are not in',
  'select public.start_call(null, current_setting(''test.grp2'')::bigint, ''audio'')',
  'not in that conversation');

-- =====================================================================
-- 6 · CLOUD SAVES
-- =====================================================================
\echo ''
\echo '-- cloud saves'

select act_as('alice');
select test_call('the first sync stores a save',
  'select public.sync_save(''{"favorites":["pac"],"stats":{"pac":{"plays":2,"seconds":60,"last":1}}}''::jsonb)');
select test_ok('the save came back',
  (select payload->'stats'->'pac'->>'plays' from public.saves where user_id = uid_of('alice')) = '2',
  coalesce((select payload::text from public.saves where user_id = uid_of('alice')),'no row'));
select test_ok('a second sync merges rather than replaces',
  public.sync_save('{"favorites":["dig"],"stats":{"pac":{"plays":5,"seconds":90,"last":2}}}'::jsonb)
    ->'stats'->'pac'->>'plays' = '5');
select test_ok('...and keeps the older favourite',
  (select count(*) from jsonb_array_elements_text(
     (select payload->'favorites' from public.saves where user_id = uid_of('alice'))) v
   where v = 'pac') = 1,
  (select payload->>'favorites' from public.saves where user_id = uid_of('alice')));
select test_ok('a lower play count never rolls the total back',
  public.sync_save('{"stats":{"pac":{"plays":1,"seconds":10,"last":1}}}'::jsonb)
    ->'stats'->'pac'->>'plays' = '5');
select test_ok('the leaderboard counted the plays once',
  (select plays from public.game_stats where game_id = 'pac') = 5,
  (select plays::text from public.game_stats where game_id = 'pac'));
select test_ok('game_stats is world-readable',
  (select count(*) from public.game_stats) >= 1);

select test_call('per-game progress saves',
  'select public.put_game_save(''hd_fnaf'', ''{"keys":{"fnaf1":"{\"stars\":1}"}}''::jsonb)');
select test_ok('...and reads back',
  (select payload->'keys'->>'fnaf1' from public.game_saves
    where user_id = uid_of('alice') and host = 'hd_fnaf') is not null,
  coalesce((select payload::text from public.game_saves where user_id = uid_of('alice')),'no row'));

select act_as('bob');
select test_ok('nobody else can read my save',
  (select count(*) from public.saves where user_id = uid_of('alice')) = 0);
select test_ok('nobody else can read my game progress',
  (select count(*) from public.game_saves where user_id = uid_of('alice')) = 0);

-- =====================================================================
-- 7 · SUPPORT, FEEDBACK AND REPORTS
-- =====================================================================
\echo ''
\echo '-- support and reports'

select act_as('alice');
select test_call('opening a ticket works',
  'select set_config(''test.ticket'',
     public.open_ticket(''Cannot save'', ''My progress vanishes.'', ''bug'')::text, false)');
select test_ok('the ticket is mine to read',
  (select count(*) from public.support_tickets where id = current_setting('test.ticket')::bigint) = 1);
select test_call('replying to my own ticket works',
  'select public.reply_ticket(current_setting(''test.ticket'')::bigint, ''Still happening.'')');
select test_call('filing a report works',
  'insert into public.reports (reporter, kind, target, reason)
     values (uid_of(''alice''), ''user'', ''dave'', ''spam'')');
select test_call('leaving feedback works',
  'insert into public.feedback (user_id, kind, subject, body)
     values (uid_of(''alice''), ''bug'', ''Sound'', ''No audio in Pac.'')');

select act_as('dave');
select test_ok('someone else''s ticket is invisible',
  (select count(*) from public.support_tickets where id = current_setting('test.ticket')::bigint) = 0);
select test_call('...and cannot be replied to',
  'select public.reply_ticket(current_setting(''test.ticket'')::bigint, ''nosy'')', 'not your ticket');
select test_call('a non-staff account cannot close a ticket',
  'select public.set_ticket_state(current_setting(''test.ticket'')::bigint, ''closed'')', 'not your ticket');
select test_ok('reports are not readable by the reported',
  (select count(*) from public.reports) = 0);

-- =====================================================================
-- 8 · THE ADMIN CONSOLE
-- =====================================================================
\echo ''
\echo '-- admin console'

select act_as('alice');
select test_call('a plain user gets nothing from admin_overview',
  'select public.admin_overview()', 'access');
select test_call('a plain user gets nothing from admin_users',
  'select public.admin_users()', 'access');
select test_call('a plain user cannot read the audit trail',
  'select public.admin_audit()', 'staff');
select test_call('a plain user cannot see live sessions',
  'select public.admin_live()', 'staff');
select test_call('a plain user cannot read the sign-in log',
  'select public.admin_logins()', 'staff');
select test_call('a plain user cannot read reports',
  'select public.admin_reports()', 'staff');
select test_call('a plain user cannot read the ticket queue',
  'select public.admin_tickets()', 'staff');
select test_call('a plain user cannot promote anybody',
  'select public.admin_set_user(uid_of(''bob''), ''admin'')', 'access');
select test_call('a plain user cannot delete anybody',
  'select public.admin_delete_user(uid_of(''bob''))', 'administrators');
select test_call('a plain user cannot add a game to the catalogue',
  'select public.save_custom_game(''{"id":"x","title":"X"}''::jsonb)', 'owner');

select act_as('Stealzers');
select test_call('the owner reads the overview', 'select public.admin_overview()');
select test_ok('the overview counts the accounts',
  (public.admin_overview()->'users'->>'total')::int = 5,
  public.admin_overview()::text);
select test_call('the owner lists users', 'select public.admin_users()');
select test_ok('the user list has everyone',
  jsonb_array_length(public.admin_users()) = 5,
  jsonb_array_length(public.admin_users())::text);
select test_ok('searching the user list narrows it',
  jsonb_array_length(public.admin_users('ali')) = 1,
  public.admin_users('ali')::text);
select test_call('the owner reads the audit trail', 'select public.admin_audit()');
select test_call('the owner reads the live view', 'select public.admin_live()');
select test_call('the owner reads the sign-in log', 'select public.admin_logins()');
select test_ok('the sign-in log has the login we recorded',
  jsonb_array_length(public.admin_logins()) >= 1,
  public.admin_logins()::text);
select test_call('the owner reads the report queue', 'select public.admin_reports()');
select test_ok('the open report is in the queue',
  jsonb_array_length(public.admin_reports('open')) = 1,
  public.admin_reports('open')::text);
select test_call('the owner reads the ticket queue', 'select public.admin_tickets()');
select test_ok('the open ticket is in the queue',
  jsonb_array_length(public.admin_tickets('open')->'tickets') = 1,
  public.admin_tickets('open')::text);
select test_ok('the ticket queue carries its state counts',
  (public.admin_tickets('open')->'counts'->>'open')::int = 1,
  public.admin_tickets('open')::text);

select test_call('promoting works', 'select public.admin_set_user(uid_of(''bob''), ''mod'')');
select test_ok('...and the rank moved',
  (select role from public.profiles where username = 'bob') = 'mod',
  (select role from public.profiles where username = 'bob'));
select test_ok('...and it was written to the audit trail',
  (select count(*) from jsonb_array_elements(public.admin_audit()) e
    where e->>'action' = 'user-update') = 1,
  public.admin_audit()::text);
select test_call('promoting to my own rank is refused',
  'select public.admin_set_user(uid_of(''bob''), ''owner'')', 'owner is set by the server');
select test_call('changing my own rank is refused',
  'select public.admin_set_user(uid_of(''Stealzers''), ''user'')', 'owner cannot be changed');
select test_call('suspending works', 'select public.admin_set_user(uid_of(''dave''), null, ''suspended'')');
select test_ok('...and the state moved',
  (select state from public.profiles where username = 'dave') = 'suspended');

select act_as('dave');
select test_call('a suspended account cannot open a thread',
  'select public.open_thread(''alice'')', 'suspended');
select test_call('a suspended account cannot start a call',
  'select public.start_call(uid_of(''alice''))', 'suspended');

select act_as('bob');
select test_call('a mod reads the report queue', 'select public.admin_reports()');
select test_call('a mod reads the ticket queue', 'select public.admin_tickets()');
select test_call('a mod can close a report',
  'select public.admin_set_report(
     (select id from public.reports order by id limit 1), ''closed'')');
select test_call('a mod cannot promote anybody',
  'select public.admin_set_user(uid_of(''carol''), ''mod'')', 'only administrators');
select test_call('a mod cannot delete anybody',
  'select public.admin_delete_user(uid_of(''carol''))', 'only administrators');
select test_call('a mod can close a ticket',
  'select public.set_ticket_state(current_setting(''test.ticket'')::bigint, ''closed'')');

select act_as('Stealzers');
select test_call('the owner adds a game to the catalogue',
  'select public.save_custom_game(''{"id":"tetra","title":"Tetra","category":"puzzle","host":"games-huge","path":"tetra/index.html"}''::jsonb)');
select test_ok('...and everyone can see it',
  (select count(*) from public.custom_games_public where game_id = 'tetra') = 1);
select test_call('the owner removes it', 'select public.remove_custom_game(''tetra'')');
select test_ok('...and it reads as removed',
  (select removed from public.custom_games_public where game_id = 'tetra') = true);
select test_call('the owner restores it', 'select public.restore_custom_game(''tetra'')');
select test_ok('...and it is back',
  (select removed from public.custom_games_public where game_id = 'tetra') = false);
select test_call('deleting an account works', 'select public.admin_delete_user(uid_of(''dave''))');
select test_ok('...and the account is gone',
  (select count(*) from public.profiles where username = 'dave') = 0);

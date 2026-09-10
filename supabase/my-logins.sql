-- User-facing security: let people see their OWN recent sign-in activity so
-- they can spot an account compromise (a login they don't recognise). Staff
-- already have admin_logins; this is the self-serve version, scoped hard to
-- auth.uid() so it can only ever return your own rows.

create or replace function public.my_logins()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'at', at, 'agent', agent, 'outcome', outcome
         ) order by at desc), '[]'::jsonb)
  from (
    select at, agent, outcome
    from public.logins
    where user_id = auth.uid()
    order by id desc
    limit 20
  ) recent;
$$;

grant execute on function public.my_logins() to authenticated;

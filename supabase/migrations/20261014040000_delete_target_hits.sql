-- Deletes up to `batch_size` hits of one target and returns how many were
-- removed. The server calls it in a loop before deleting the target, so a
-- busy target's hits never go in one cascade long enough to hit the
-- statement timeout. Only the service role may run it.
create function public.delete_target_hits(target uuid, batch_size integer)
returns integer
language sql
volatile
security invoker
set search_path = ''
as $$
  with doomed as (
    select id from public.hits where target_id = target limit batch_size
  ),
  gone as (
    delete from public.hits h using doomed where h.id = doomed.id returning 1
  )
  select count(*)::integer from gone;
$$;

revoke execute on function public.delete_target_hits(uuid, integer) from public, anon, authenticated;

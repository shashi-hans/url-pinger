-- Deletes up to `batch_size` hits older than `cutoff`, oldest first, and
-- returns how many were removed. The server calls it in a loop, so a large
-- backlog is cleared in short statements that stay under the statement
-- timeout. Only the service role may run it.
create function public.prune_hits(cutoff timestamptz, batch_size integer)
returns integer
language sql
volatile
security invoker
set search_path = ''
as $$
  with doomed as (
    select id from public.hits where at < cutoff order by at limit batch_size
  ),
  gone as (
    delete from public.hits h using doomed where h.id = doomed.id returning 1
  )
  select count(*)::integer from gone;
$$;

revoke execute on function public.prune_hits(timestamptz, integer) from public, anon, authenticated;

-- recent_hits reads the newest `per_target` hits of each target through the
-- (target_id, at desc) index, one short index scan per target, instead of
-- ranking every stored hit. The server pages this function 1000 rows at a
-- time, so each page would otherwise rank the whole hits table again.
-- Ordering ends on id so paging is stable when two hits share a timestamp.
create or replace function public.recent_hits(per_target integer)
returns setof public.hits
language sql
stable
security invoker
set search_path = ''
as $$
  select h.id, h.target_id, h.user_id, h.at, h.ok, h.status, h.duration_ms,
         h.bytes, h.error, h.error_kind
  from public.targets t
  cross join lateral (
    select hits.*
    from public.hits
    where hits.target_id = t.id
    order by hits.at desc
    limit per_target
  ) h
  order by h.target_id, h.at desc, h.id desc;
$$;

revoke execute on function public.recent_hits(integer) from public, anon;

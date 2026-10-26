-- URL Pinger schema: targets owned by a Supabase Auth user, and their hits.
-- Run once in the Supabase SQL editor (or with `supabase db push`).

create table public.targets (
  id               uuid primary key,
  user_id          uuid not null references auth.users (id) on delete cascade,
  name             text not null check (char_length(name) between 1 and 200),
  url              text not null check (char_length(url) between 1 and 2048),
  method           text not null default 'GET',
  -- Header values can carry API tokens. They are masked in the UI and API.
  headers          jsonb not null default '{}'::jsonb,
  body             text,
  interval_seconds integer not null check (interval_seconds > 0),
  expect_status    integer check (expect_status between 100 and 599),
  enabled          boolean not null default true,
  capture_preview  boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index targets_user_id_idx on public.targets (user_id);

-- One row per call. Response previews are never stored here.
create table public.hits (
  id          bigint generated always as identity primary key,
  target_id   uuid not null references public.targets (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  at          timestamptz not null,
  ok          boolean not null,
  status      integer,
  duration_ms integer not null,
  bytes       bigint,
  error       text,
  error_kind  text
);

create index hits_target_at_idx on public.hits (target_id, at desc);
create index hits_at_idx on public.hits (at);
create index hits_user_id_idx on public.hits (user_id);

-- Row Level Security: a signed-in user reaches only their own rows. The
-- server's service-role key bypasses these policies for the scheduler.
alter table public.targets enable row level security;
alter table public.hits enable row level security;

create policy targets_select_own on public.targets
  for select to authenticated using ((select auth.uid()) = user_id);
create policy targets_insert_own on public.targets
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy targets_update_own on public.targets
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy targets_delete_own on public.targets
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Hits are written only by the server (service role). Users may read theirs.
create policy hits_select_own on public.hits
  for select to authenticated using ((select auth.uid()) = user_id);

-- Newest `per_target` hits for every target the caller can see. Runs with the
-- caller's rights, so Row Level Security still applies.
create function public.recent_hits(per_target integer)
returns setof public.hits
language sql
stable
security invoker
set search_path = ''
as $$
  select h.id, h.target_id, h.user_id, h.at, h.ok, h.status, h.duration_ms,
         h.bytes, h.error, h.error_kind
  from (
    select hits.*,
           row_number() over (partition by hits.target_id order by hits.at desc) as rn
    from public.hits
  ) h
  where h.rn <= per_target
  order by h.target_id, h.at desc;
$$;

revoke execute on function public.recent_hits(integer) from public, anon;

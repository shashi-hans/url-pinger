-- Replaces the daily offline window with an online window and adds offline
-- weekdays. An offline window [offline_from, offline_to) is the same schedule
-- as the online window [offline_to, offline_from), so existing rows convert
-- exactly.
alter table public.targets
  add column online_from text check (online_from ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  add column online_to   text check (online_to   ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  -- Weekdays with no timed hits, 0 = Sunday .. 6 = Saturday, in IST.
  add column offline_days smallint[] not null default '{}';

update public.targets
set online_from = offline_to, online_to = offline_from
where offline_from is not null and offline_to is not null;

alter table public.targets
  drop constraint targets_offline_window_pair,
  drop column offline_from,
  drop column offline_to,
  add constraint targets_online_window_pair check (
    (online_from is null and online_to is null)
    or (online_from is not null and online_to is not null and online_from <> online_to)
  ),
  add constraint targets_offline_days_valid check (
    offline_days <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[]
    and cardinality(offline_days) < 7
  );

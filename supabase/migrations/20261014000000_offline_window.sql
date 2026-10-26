-- Daily offline window per target, as HH:MM in IST. Both set or both null.
alter table public.targets
  add column offline_from text check (offline_from ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  add column offline_to   text check (offline_to   ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  add constraint targets_offline_window_pair check (
    (offline_from is null and offline_to is null)
    or (offline_from is not null and offline_to is not null and offline_from <> offline_to)
  );

-- Rows can be written straight through the Supabase API with a user's token,
-- skipping the app's validation. These checks hold the hard limits in the
-- database too. The app re-validates loaded rows against its own (possibly
-- tighter) MIN/MAX_INTERVAL_SECONDS and SSRF policy and skips invalid ones.
alter table public.targets
  add constraint targets_name_length check (char_length(name) between 1 and 120),
  add constraint targets_interval_range check (interval_seconds between 1 and 2073600),
  add constraint targets_method_known check (method in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')),
  add constraint targets_headers_object check (jsonb_typeof(headers) = 'object'),
  add constraint targets_body_length check (body is null or char_length(body) <= 10000);

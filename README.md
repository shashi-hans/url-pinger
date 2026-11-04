# URL Pinger

Calls a list of URLs on a fixed interval and records what came back: HTTP
status, response time, size, and the error when a call fails. Targets are
defined through a web UI or a REST API and saved to a local JSON file, so they
survive a restart.

Stack: Node + Express on the server, HTMX plus a self-built daisyUI/Tailwind
bundle in the browser. No Docker, no CDN.

Two storage modes:

- **File mode** (default): targets in `data/targets.json`, history in memory,
  no login. For one person on one machine.
- **Supabase mode**: targets and hits in a Supabase Postgres database, with
  Supabase Auth login. Each account sees only its own targets. Turns on when
  the three `SUPABASE_*` variables are set.

## Prerequisites

- Node >= 18 (tested on 18.20.8; uses the built-in global `fetch`)
- npm (tested on 10.8.2)

## Install

```
npm install
npm run vendor:htmx     # copies htmx into public/vendor
npm run build:css       # builds public/css/app.css
cp .env.example .env    # optional, sane defaults apply without it
```

## Run

Development (auto-reload via nodemon):

```
npm run dev
```

Production:

```
npm start
```

Then open `http://127.0.0.1:3200`.

## Supabase setup

1. Create a Supabase project in the **Mumbai (ap-south-1)** region.
2. Run each file in [supabase/migrations/](supabase/migrations/) in the SQL
   editor, oldest first. They create the `targets` and `hits` tables, Row Level
   Security policies, the `recent_hits` function, the schedule window columns,
   database checks on target fields (interval, method, headers, sizes), the
   `prune_hits` and `delete_target_hits` functions, and the online window and
   offline days columns.
3. Under Authentication > Providers, keep Email on and turn **off** "Allow new
   users to sign up". Create accounts under Authentication > Users. There is
   no sign-up page in the app.
4. Copy the project URL, anon key and service role key from Project Settings >
   API into `.env` (see `.env.example`). Restart the server.

How the pieces fit:

- The browser never talks to Supabase. The server signs users in and keeps the
  Supabase access and refresh tokens in httpOnly cookies, refreshing the access
  token when it expires.
- Target writes go through a client carrying the user's token, so Row Level
  Security checks ownership in Postgres as well as in the app.
- The scheduler runs every user's targets without a session, so loading targets
  and writing hits use the service role key, which bypasses Row Level Security.
  Keep that key server-side only.
- The History panel reads the last `HISTORY_WINDOW_HOURS` of hits from the
  database, as the signed-in user, 100 per page. Memory keeps only the newest
  `HISTORY_LIMIT` hits for the card stats and previews; on boot those are
  reloaded, so the dashboard keeps its numbers across restarts. Hits older than
  `HIT_RETENTION_DAYS` (default 30) are deleted on boot and then daily.
- API clients can skip cookies and send `Authorization: Bearer <access token>`.
- The target list is reloaded from the database every `TARGET_SYNC_SECONDS`
  (60), so a user deleted in Supabase, or a row edited in the dashboard, takes
  effect without a restart. Loaded rows get the same checks as API input
  (interval bounds, SSRF policy, headers). A row that fails them stays listed
  with an `invalid` badge and the reason, is never scheduled, and cannot be
  run until its owner fixes it; it can still be paused, edited or deleted.
  Pausing also works on a file-mode target that fails the current rules.
  Rows over
  `MAX_TARGETS` or `MAX_TOTAL_TARGETS` are dropped with one warning in the log.
- Hits older than `HIT_RETENTION_DAYS` are deleted through the `prune_hits`
  SQL function, 10,000 rows per call, so a large backlog never turns into one
  long statement.
- Deleting a target first removes its hits the same way (`delete_target_hits`),
  so a busy target with months of hits can still be deleted.
- Every Supabase request times out after 15 s, so a stuck database call cannot
  hold a scheduler tick or other users' edits.
- Run one instance only. Each instance schedules every target, so two
  instances would hit every URL twice.
- `MAX_TARGETS` is per account; `MAX_TOTAL_TARGETS` (500) caps all accounts
  together, because one process runs every timer.

`@supabase/supabase-js` is pinned to 2.78.0, the last release that supports
Node 18. Node 18 is past end of life; moving to Node 22 allows the current
release.

## What a target holds

| Field | Meaning |
| --- | --- |
| `name` | Label shown in the UI |
| `url` | http or https URL to call |
| `method` | GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS |
| `headers` | Request headers as an object of strings |
| `body` | Request body string, dropped for GET and HEAD |
| `intervalSeconds` | How often to call, between `MIN_INTERVAL_SECONDS` and `MAX_INTERVAL_SECONDS` |
| `expectStatus` | Exact status that counts as success. Empty means any 2xx or 3xx |
| `enabled` | Pauses the timer when false |
| `capturePreview` | Stores the first `PREVIEW_LIMIT` characters of each response |
| `onlineFrom`, `onlineTo` | Daily online window in IST, as `HH:MM` or `h:mm AM/PM` (stored as `HH:MM`), e.g. `9:00 AM` to `7:00 PM`. Send both, or both `null` for always online |
| `offlineDays` | Weekdays with no timed hits, `0` (Sunday) to `6` (Saturday), e.g. `[0]` to skip Sundays. Up to 6 days |

## Scheduling behaviour

- One timer per enabled target, started on create and on server boot.
- Creating an enabled target fires one hit immediately, so the first result
  appears without waiting out the interval. The create response does not wait
  for it; the result lands in the history a moment later.
- Server boot does the same for every enabled target with no recorded hit,
  spaced 250 ms apart, so a daily target does not read "never" for a day. In
  file mode that is every enabled target, because history does not survive a
  restart.
- A tick is skipped when the previous call for that target is still running, so
  a slow endpoint cannot stack up overlapping requests.
- Editing, pausing, or deleting a target destroys its timer and rebuilds it, so
  no stale timer keeps firing an old configuration.
- Redirects are recorded, not followed. A 302 shows up as a 302.
- "Run now" fires one call immediately and leaves the interval timer alone.
- Outside a target's online window, and all day on its offline days, the
  timer keeps running but skips its hits, including the automatic hits on
  create and boot. "Run now" still works. Times are IST (fixed UTC+05:30). The
  window starts at `onlineFrom`, ends just before `onlineTo`, and may cross
  midnight. Offline days follow the current IST calendar day, so with a
  9 PM to 6 AM window and Sunday offline, Saturday's window stops at midnight.
  A tick that lands outside the window is skipped, not delayed, so a daily
  target whose tick falls outside it misses that day. The form uses a 12-hour
  clock, and the card shows an `offline` badge while hits are being skipped.
- Older targets with an offline window are converted on load: offline
  6 PM to 10 AM becomes online 10 AM to 6 PM, the same schedule.

## REST API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Liveness and storage mode. Public in both modes |
| GET | `/api/targets` | List targets with rolling stats |
| POST | `/api/targets` | Create a target |
| GET | `/api/targets/:id` | Read one target |
| PATCH | `/api/targets/:id` | Update any subset of fields |
| DELETE | `/api/targets/:id` | Delete a target and its history |
| POST | `/api/targets/:id/run` | Run one call now, return the result |
| GET | `/api/targets/:id/history?page=n&pageSize=n` | Calls from the last `HISTORY_WINDOW_HOURS` (24), newest first, one page at a time. Returns `history`, `total`, `page`, `pageSize`, `pages`. `limit` still works as `pageSize` |

Create example:

```
curl -X POST http://127.0.0.1:3200/api/targets \
  -H 'content-type: application/json' \
  -d '{"name":"staging health","url":"https://example.com/health","intervalSeconds":60}'
```

Validation errors come back as `400` with an `errors` array listing every
problem at once.

In Supabase mode every route except `/api/health` needs a session cookie or a
bearer token, and answers `401` without one. Another account's target id
answers `404`, the same as a missing one.

## Storage

File mode:

- `data/targets.json` holds the target list. Writes are atomic (temp file plus
  rename) and serialized, and the file is written with owner-only permissions
  because stored headers can contain API tokens.
- Call history is in memory only and is lost on restart. Every call from the
  last `HISTORY_WINDOW_HOURS` (default 24) is kept, so a target on a 5 s
  interval holds 17,280 entries. Previews are kept only on the newest
  `HISTORY_LIMIT` entries. Response previews can contain personal data, so they
  are deliberately not written to disk.

Supabase mode:

- `targets` holds each target with its owner's `user_id`. `hits` holds one row
  per call: time, result, status, duration, size, error. Response previews are
  never written to the database and stay in memory only.
- Deleting a target deletes its hits. Deleting a Supabase user deletes their
  targets and hits.

## Security notes

Read these before exposing the app to anyone else.

- **This is a server-side request engine.** Anyone who can reach the UI can make
  the server issue HTTP requests. File mode has no authentication, so `HOST`
  defaults to `127.0.0.1`. Use Supabase mode, or an authenticating proxy, before
  binding it to anything wider. In Supabase mode every signed-in account can
  still make the server send requests, so only create accounts for people you
  trust.
- **Sessions.** Cookies are httpOnly, `SameSite=Lax`, and `Secure` unless the
  server listens on loopback. State-changing requests made with a cookie
  session must carry the `HX-Request` header, which a cross-site form cannot
  send. In file mode, which has no login, the same check applies to every
  state-changing `/ui` request, so a web page open in the same browser cannot
  create or change targets through a plain form post.
- **Login throttling.** `/login` allows 20 attempts per IP, and 5 failed
  attempts per email from the same IP, in 15 minutes, then answers `429`.
  Keying failures by email and IP means a stranger cannot lock someone else
  out. When Supabase Auth is unreachable, sign-in answers `503` and the attempt
  does not count as a failure. An IP that sends 30 rejected tokens (bearer,
  access cookie or refresh cookie) in 15 minutes
  gets `401` without a Supabase Auth call, so junk tokens cannot use up the
  Auth rate limit every user shares. Behind a reverse proxy
  set `TRUST_PROXY` so the limit sees client IPs, not the proxy's. Counters are
  in memory and reset on restart.
- **Service role key.** It bypasses Row Level Security. Keep it in `.env` or a
  secrets manager, never in the repo or the browser.
- **SSRF guard.** Target URLs pointing at loopback, private ranges, link-local
  and cloud metadata addresses are rejected, and the check runs again at call
  time, not only at save time. The check reads the literal hostname and does not
  resolve DNS, so a public hostname that resolves to a private address (DNS
  rebinding) is not caught. Set `ALLOW_PRIVATE_TARGETS=true` only inside a
  trusted network.
- **Credentials in headers.** Header values are stored in plain text in
  `data/targets.json`, or in the `targets.headers` column in Supabase (encrypted
  at rest by Supabase, readable by anyone holding the service role key). They are masked in the UI and API responses unless
  `REVEAL_HEADER_VALUES=true`. Keep the data directory out of version control
  (it is gitignored) and off shared disks. For anything long lived, point
  targets at endpoints that do not need a static secret.
- **Response previews and personal data.** A preview stores part of a real
  response body. Turn it on only for endpoints whose responses carry no
  customer, policyholder, or health data. Set `PREVIEW_LIMIT=0` to disable
  previews across the board.
- **Regulated data.** If any target returns regulated data, this app, its data
  directory and its Supabase project must run inside `ap-south-1`, and previews
  should stay off. Supabase is a third-party processor under DPDP Act 2023;
  account emails are personal data held there.
- Header names and values are validated, and values containing CR or LF are
  rejected, so a stored header cannot inject another one.
- All rendered values are HTML-escaped. The Content-Security-Policy restricts
  scripts, styles, and fonts to the same origin.

## Tests

```
npm test
```

117 tests over validation and the SSRF guard, the JSON API, the HTMX fragments,
the scheduler (fake timers cover the overlap skip and the timer replacement),
and Supabase mode against an in-process fake Supabase (login, refresh, per-user
isolation, the CSRF guard, hit rows without previews, and history read from
the database), plus the 24-hour history window and paging, the online window
and offline days (IST conversion, 12-hour input, midnight crossing, weekday
rule, validation, the file upgrade, skipped timer hits),
concurrent writes, the login throttle, and the Supabase re-sync.

`npm audit` reports two moderate advisories in the `@vitest/mocker` dev
dependency. No fixed version is published for any vitest release, the code path
is test-only (mock redirects), and it is not used here. Runtime dependencies are
clean.

## Layout

```
src/
  config.js          environment and defaults
  validation.js      input rules and the SSRF guard
  store.js           picks the storage backend
  fileStore.js       atomic JSON persistence (file mode)
  supabaseStore.js   Supabase tables (Supabase mode)
  supabaseClient.js  service-role, anon and per-user Supabase clients
  auth.js            login, logout, session cookies, CSRF guard
  rateLimit.js       in-memory fixed-window counter for login throttling
  history.js         in-memory hit history (24 h window) and rolling stats
  availability.js    online window and offline days check (IST)
  runner.js          performs one HTTP call
  scheduler.js       one interval timer per target
  targetsService.js  CRUD, scheduling, masking
  views.js           server-rendered HTML fragments
  routes/api.js      JSON API
  routes/ui.js       HTMX fragment endpoints
public/              page shell, built CSS, vendored htmx
supabase/migrations/ database schema and Row Level Security policies
```

# URL Pinger

Calls a list of URLs on a fixed interval and records what came back: HTTP
status, response time, size, and the error when a call fails. Targets are
defined through a web UI or a REST API and saved to a local JSON file, so they
survive a restart.

Stack: Node + Express on the server, HTMX plus a self-built daisyUI/Tailwind
bundle in the browser. No database, no Docker, no CDN.

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

## Scheduling behaviour

- One timer per enabled target, started on create and on server boot.
- Creating an enabled target fires one hit immediately, so the first result
  appears without waiting out the interval. The create response does not wait
  for it; the result lands in the history a moment later.
- Server boot does the same for every enabled target, spaced 250 ms apart,
  because history does not survive a restart and a daily target would otherwise
  read "never" for a day.
- A tick is skipped when the previous call for that target is still running, so
  a slow endpoint cannot stack up overlapping requests.
- Editing, pausing, or deleting a target destroys its timer and rebuilds it, so
  no stale timer keeps firing an old configuration.
- Redirects are recorded, not followed. A 302 shows up as a 302.
- "Run now" fires one call immediately and leaves the interval timer alone.

## REST API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Liveness and target count |
| GET | `/api/targets` | List targets with rolling stats |
| POST | `/api/targets` | Create a target |
| GET | `/api/targets/:id` | Read one target |
| PATCH | `/api/targets/:id` | Update any subset of fields |
| DELETE | `/api/targets/:id` | Delete a target and its history |
| POST | `/api/targets/:id/run` | Run one call now, return the result |
| GET | `/api/targets/:id/history?limit=n` | Recorded calls, newest first |

Create example:

```
curl -X POST http://127.0.0.1:3200/api/targets \
  -H 'content-type: application/json' \
  -d '{"name":"staging health","url":"https://example.com/health","intervalSeconds":60}'
```

Validation errors come back as `400` with an `errors` array listing every
problem at once.

## Storage

- `data/targets.json` holds the target list. Writes are atomic (temp file plus
  rename) and serialized, and the file is written with owner-only permissions
  because stored headers can contain API tokens.
- Call history is in memory only, capped at `HISTORY_LIMIT` entries per target,
  and is lost on restart. Response previews can contain personal data, so they
  are deliberately not written to disk.

## Security notes

Read these before exposing the app to anyone else.

- **This is a server-side request engine.** Anyone who can reach the UI can make
  the server issue HTTP requests. There is no authentication, so `HOST` defaults
  to `127.0.0.1`. Put an authenticating proxy in front of it before binding it
  to anything wider.
- **SSRF guard.** Target URLs pointing at loopback, private ranges, link-local
  and cloud metadata addresses are rejected, and the check runs again at call
  time, not only at save time. The check reads the literal hostname and does not
  resolve DNS, so a public hostname that resolves to a private address (DNS
  rebinding) is not caught. Set `ALLOW_PRIVATE_TARGETS=true` only inside a
  trusted network.
- **Credentials in headers.** Header values are stored in plain text in
  `data/targets.json`. They are masked in the UI and API responses unless
  `REVEAL_HEADER_VALUES=true`. Keep the data directory out of version control
  (it is gitignored) and off shared disks. For anything long lived, point
  targets at endpoints that do not need a static secret.
- **Response previews and personal data.** A preview stores part of a real
  response body. Turn it on only for endpoints whose responses carry no
  customer, policyholder, or health data. Set `PREVIEW_LIMIT=0` to disable
  previews across the board.
- **Regulated data.** If any target returns regulated data, this app and its
  data directory must run inside `ap-south-1`, and previews should stay off.
- Header names and values are validated, and values containing CR or LF are
  rejected, so a stored header cannot inject another one.
- All rendered values are HTML-escaped. The Content-Security-Policy restricts
  scripts, styles, and fonts to the same origin.

## Tests

```
npm test
```

65 tests over validation and the SSRF guard, the JSON API, the HTMX fragments,
and the scheduler (fake timers cover the overlap skip and the timer replacement).

`npm audit` reports two moderate advisories in the `@vitest/mocker` dev
dependency. No fixed version is published for any vitest release, the code path
is test-only (mock redirects), and it is not used here. Runtime dependencies are
clean.

## Layout

```
src/
  config.js          environment and defaults
  validation.js      input rules and the SSRF guard
  store.js           atomic JSON persistence
  history.js         in-memory capped hit history and rolling stats
  runner.js          performs one HTTP call
  scheduler.js       one interval timer per target
  targetsService.js  CRUD, scheduling, masking
  views.js           server-rendered HTML fragments
  routes/api.js      JSON API
  routes/ui.js       HTMX fragment endpoints
public/              page shell, built CSS, vendored htmx
```

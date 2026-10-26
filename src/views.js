'use strict';

const config = require('./config');
const { HTTP_METHODS, BODYLESS_METHODS } = require('./validation');
const { DAY_NAMES, WEEK_ORDER, toParts12, format12 } = require('./availability');

function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function ago(iso) {
  if (!iso) return 'never';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 0) return `in ${Math.abs(seconds)}s`;
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function humanInterval(seconds) {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function statusBadge(target) {
  const last = target.stats.last;
  if (target.invalidReason) {
    return `<span class="badge badge-error" title="${esc(target.invalidReason)}">invalid</span>`;
  }
  if (!target.enabled) return '<span class="badge badge-ghost">paused</span>';
  if (target.offlineNow) return '<span class="badge badge-warning">offline</span>';
  if (!last) return '<span class="badge badge-outline">waiting</span>';
  if (last.ok) return `<span class="badge badge-success">${esc(last.status ?? 'ok')}</span>`;
  const label = last.status != null ? `HTTP ${last.status}` : esc(last.errorKind || 'error');
  return `<span class="badge badge-error" title="${esc(last.error)}">${esc(label)}</span>`;
}

function errorsFragment(errors) {
  if (!errors || errors.length === 0) {
    return '<div id="form-errors" hx-swap-oob="true"></div>';
  }
  const items = errors.map((e) => `<li>${esc(e)}</li>`).join('');
  return `<div id="form-errors" hx-swap-oob="true">
    <div class="alert alert-error text-sm" role="alert">
      <ul class="list-disc pl-4">${items}</ul>
    </div>
  </div>`;
}

function headersToText(headers) {
  return Object.entries(headers || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

// Hour, minute and AM/PM selects for one online-window time. A native time
// input follows the browser's locale and may show a 24-hour clock, so the
// 12-hour clock is built from selects. An empty hour means "no window".
function timePicker12(prefix, value) {
  const p = toParts12(value);
  const option = (v, label, selected) => `<option value="${v}"${selected ? ' selected' : ''}>${label}</option>`;
  const hours = [option('', '--', !p)]
    .concat(Array.from({ length: 12 }, (_, i) => option(i + 1, i + 1, p && p.hour === i + 1)))
    .join('');
  const minutes = Array.from({ length: 60 }, (_, i) => {
    const mm = String(i).padStart(2, '0');
    return option(mm, mm, p && p.minute === mm);
  }).join('');
  const periods = ['AM', 'PM'].map((v) => option(v, v, p && p.period === v)).join('');
  return `<div class="join">
    <select class="select select-bordered select-sm join-item" name="${prefix}Hour" aria-label="hour">${hours}</select>
    <select class="select select-bordered select-sm join-item" name="${prefix}Minute" aria-label="minute">${minutes}</select>
    <select class="select select-bordered select-sm join-item" name="${prefix}Period" aria-label="AM or PM">${periods}</select>
  </div>`;
}

function offlineDaysText(days) {
  const set = new Set(days || []);
  return WEEK_ORDER.filter((d) => set.has(d)).map((d) => DAY_NAMES[d]).join(', ');
}

// The create/edit form. Rendering it server-side keeps the edit flow a plain
// HTMX swap with no client-side state.
function formFragment(target, { oob = false } = {}) {
  const editing = Boolean(target);
  const t = target || {};
  const method = t.method || 'GET';
  const methodOptions = HTTP_METHODS.map(
    (m) => `<option value="${m}"${m === method ? ' selected' : ''}>${m}</option>`
  ).join('');
  const action = editing ? `/ui/targets/${esc(t.id)}` : '/ui/targets';
  const verb = editing ? 'hx-put' : 'hx-post';
  // Stored header values are masked by default, so the edit form starts empty
  // rather than round-tripping the mask back into storage. Leaving it empty
  // keeps the saved headers; the clear checkbox is the way to drop them.
  const showStoredHeaders = editing && config.revealHeaderValues;
  const headerText = showStoredHeaders ? headersToText(t.headers) : '';
  const savedCount = editing ? t.headerCount || 0 : 0;
  const headerHint = savedCount && !showStoredHeaders
    ? `<span class="label-text-alt">${savedCount} saved header(s) hidden. Leave empty to keep them.</span>`
    : '<span class="label-text-alt">One per line, as <code>Name: value</code></span>';
  const clearHeadersBox = savedCount
    ? `<label class="label cursor-pointer justify-start gap-2">
        <input class="checkbox checkbox-xs" type="checkbox" name="clearHeaders" value="true" />
        <span class="label-text-alt">Remove all saved headers</span>
      </label>`
    : '';

  return `<form id="target-form" class="card bg-base-100 shadow p-4 gap-3 flex flex-col"
    ${oob ? 'hx-swap-oob="true" ' : ''}${verb}="${action}" hx-target="#target-list" hx-swap="innerHTML">
    <h2 class="font-semibold text-lg">${editing ? 'Edit target' : 'Add target'}</h2>

    <div class="grid gap-3 lg:grid-cols-2">
      <label class="form-control">
        <div class="label flex-wrap gap-x-2"><span class="label-text">Name</span></div>
        <input class="input input-bordered" name="name" maxlength="120" required
          value="${esc(t.name)}" placeholder="Staging health check" />
      </label>

      <label class="form-control">
        <div class="label flex-wrap gap-x-2"><span class="label-text">Interval (seconds)</span></div>
        <input class="input input-bordered" name="intervalSeconds" type="number" required
          min="${config.minIntervalSeconds}" max="${config.maxIntervalSeconds}"
          value="${esc(t.intervalSeconds || 60)}" />
      </label>
    </div>

    <label class="form-control">
      <div class="label flex-wrap gap-x-2"><span class="label-text">URL</span></div>
      <input class="input input-bordered" name="url" type="url" required
        value="${esc(t.url)}" placeholder="https://example.com/health" />
    </label>

    <div class="grid gap-3 lg:grid-cols-3">
      <label class="form-control">
        <div class="label flex-wrap gap-x-2"><span class="label-text">Method</span></div>
        <select class="select select-bordered" name="method">${methodOptions}</select>
      </label>

      <label class="form-control">
        <div class="label flex-wrap gap-x-2"><span class="label-text">Expected status</span></div>
        <input class="input input-bordered" name="expectStatus" type="number" min="100" max="599"
          value="${esc(t.expectStatus)}" placeholder="any 2xx/3xx" />
      </label>

      <div class="form-control justify-end gap-2 pb-1">
        <label class="label cursor-pointer justify-start gap-2">
          <input class="checkbox checkbox-sm" type="checkbox" name="enabled" value="true"
            ${t.enabled === false ? '' : 'checked'} />
          <span class="label-text">Enabled</span>
        </label>
        <label class="label cursor-pointer justify-start gap-2">
          <input class="checkbox checkbox-sm" type="checkbox" name="capturePreview" value="true"
            ${t.capturePreview ? 'checked' : ''} />
          <span class="label-text">Store response preview</span>
        </label>
      </div>
    </div>

    <div class="grid gap-3 lg:grid-cols-3">
      <div class="form-control">
        <div class="label flex-wrap gap-x-2">
          <span class="label-text">Online from (IST)</span>
          <span class="label-text-alt">hour -- = always online</span>
        </div>
        ${timePicker12('onlineFrom', t.onlineFrom)}
      </div>
      <div class="form-control">
        <div class="label flex-wrap gap-x-2"><span class="label-text">Online until (IST)</span></div>
        ${timePicker12('onlineTo', t.onlineTo)}
      </div>
      <fieldset class="form-control">
        <div class="label flex-wrap gap-x-2">
          <span class="label-text">Offline days</span>
          <span class="label-text-alt">no timed hits</span>
        </div>
        <div class="flex flex-wrap gap-x-3 gap-y-1">
          ${WEEK_ORDER.map((d) => [DAY_NAMES[d], d]).map(([name, d]) => `<label class="label cursor-pointer gap-1 p-0">
            <input class="checkbox checkbox-xs" type="checkbox" name="offlineDays" value="${d}"
              ${(t.offlineDays || []).includes(d) ? 'checked' : ''} />
            <span class="label-text-alt">${name}</span>
          </label>`).join('')}
        </div>
      </fieldset>
    </div>

    <div class="grid gap-3 lg:grid-cols-2">
    <label class="form-control">
      <div class="label flex-wrap gap-x-2"><span class="label-text">Headers</span>${headerHint}</div>
      <textarea class="textarea textarea-bordered font-mono text-xs" name="headers" rows="3"
        placeholder="Accept: application/json">${esc(headerText)}</textarea>
      ${clearHeadersBox}
    </label>

    <label class="form-control">
      <div class="label flex-wrap gap-x-2">
        <span class="label-text">Request body</span>
        <span class="label-text-alt">ignored for ${BODYLESS_METHODS.join(' and ')}</span>
      </div>
      <textarea class="textarea textarea-bordered font-mono text-xs" name="body" rows="3"
        placeholder='{"ping":true}'>${esc(t.body)}</textarea>
    </label>
    </div>

    <div class="flex gap-2">
      <button class="btn btn-primary" type="submit">${editing ? 'Save changes' : 'Add target'}</button>
      ${editing ? '<button class="btn btn-ghost" type="button" hx-get="/ui/form" hx-target="#target-form" hx-swap="outerHTML">Cancel</button>' : ''}
    </div>
  </form>`;
}

function targetRow(target) {
  const s = target.stats;
  const rate = s.successRate === null ? '-' : `${s.successRate}%`;
  const avg = s.avgDurationMs === null ? '-' : `${s.avgDurationMs} ms`;
  const lastAt = s.last ? ago(s.last.at) : 'never';

  return `<div class="card bg-base-100 shadow-sm border border-base-300">
    <div class="card-body p-4 gap-2">
      <div class="flex flex-wrap items-center gap-2">
        ${statusBadge(target)}
        <span class="font-semibold">${esc(target.name)}</span>
        <span class="badge badge-neutral badge-sm">${esc(target.method)}</span>
        <span class="badge badge-sm">every ${esc(humanInterval(target.intervalSeconds))}</span>
      </div>

      <a class="link link-hover text-xs break-all opacity-70" href="${esc(target.url)}"
        target="_blank" rel="noopener noreferrer">${esc(target.url)}</a>

      <div class="flex flex-wrap gap-x-6 gap-y-1 text-xs opacity-80">
        <span>last: ${esc(lastAt)}</span>
        <span>success: ${esc(rate)} of ${esc(s.hits)}</span>
        <span>avg: ${esc(avg)}</span>
        <span>next: ${target.nextRunAt ? esc(ago(target.nextRunAt)) : 'not scheduled'}</span>
        ${target.onlineFrom && target.onlineTo
          ? `<span>online: ${esc(format12(target.onlineFrom))}&ndash;${esc(format12(target.onlineTo))} IST</span>`
          : ''}
        ${target.offlineDays && target.offlineDays.length
          ? `<span>off: ${esc(offlineDaysText(target.offlineDays))}</span>`
          : ''}
      </div>

      ${target.invalidReason
        ? `<p class="text-xs text-error break-all">Not scheduled: ${esc(target.invalidReason)}. Edit or delete it.</p>`
        : ''}
      ${s.last && !s.last.ok && s.last.error
        ? `<p class="text-xs text-error break-all">${esc(s.last.error)}</p>`
        : ''}

      <div class="flex flex-wrap gap-2 pt-1">
        <button class="btn btn-sm sm:btn-xs" hx-post="/ui/targets/${esc(target.id)}/run"
          hx-target="#target-list" hx-swap="innerHTML">Run now</button>
        <button class="btn btn-sm sm:btn-xs" hx-post="/ui/targets/${esc(target.id)}/toggle"
          hx-target="#target-list" hx-swap="innerHTML">${target.enabled ? 'Pause' : 'Resume'}</button>
        <button class="btn btn-sm sm:btn-xs" hx-get="/ui/targets/${esc(target.id)}/history"
          hx-target="#detail" hx-swap="innerHTML">History</button>
        <button class="btn btn-sm sm:btn-xs" hx-get="/ui/form/${esc(target.id)}"
          hx-target="#target-form" hx-swap="outerHTML">Edit</button>
        <button class="btn btn-sm sm:btn-xs btn-error btn-outline" hx-delete="/ui/targets/${esc(target.id)}"
          hx-target="#target-list" hx-swap="innerHTML"
          hx-confirm="Delete ${esc(target.name)}?">Delete</button>
      </div>
    </div>
  </div>`;
}

function targetListFragment(targets) {
  if (targets.length === 0) {
    return '<p class="opacity-60 text-sm">No targets yet. Add one above.</p>';
  }
  return targets.map(targetRow).join('\n');
}

function historyPager(target, { page, pages }) {
  if (pages <= 1) return '';
  const link = (label, to, enabled) => (enabled
    ? `<button class="btn btn-xs" hx-get="/ui/targets/${esc(target.id)}/history?page=${to}"
        hx-target="#detail" hx-swap="innerHTML">${label}</button>`
    : `<button class="btn btn-xs" disabled>${label}</button>`);
  return `<div class="flex items-center gap-2 text-xs">
    ${link('Newer', page - 1, page > 1)}
    <span class="opacity-70">Page ${esc(page)} of ${esc(pages)}</span>
    ${link('Older', page + 1, page < pages)}
  </div>`;
}

// One page of the History panel: hits from the last `windowHours`, newest
// first. Dates are shown because the window spans midnight.
function historyFragment(target, { entries, total, page, pages, windowHours }) {
  const heading = `${esc(target.name)} &mdash; last ${esc(windowHours)}h`;
  if (!entries || entries.length === 0) {
    return `<div class="card bg-base-100 shadow p-4 gap-2">
      <div class="flex items-center justify-between">
        <h2 class="font-semibold">${heading}</h2>
        <button class="btn btn-xs btn-ghost" hx-get="/ui/blank" hx-target="#detail"
          hx-swap="innerHTML">Close</button>
      </div>
      ${total > 0 && page > 1
        ? `<p class="text-sm opacity-60">Page ${esc(page)} is past the last of ${esc(pages)} page(s).
            <button class="btn btn-xs" hx-get="/ui/targets/${esc(target.id)}/history"
              hx-target="#detail" hx-swap="innerHTML">Newest</button></p>`
        : `<p class="text-sm opacity-60">No hits in the last ${esc(windowHours)} hours.</p>`}
    </div>`;
  }

  const rows = entries
    .map((e) => `<tr>
      <td class="whitespace-nowrap">${esc(new Date(e.at).toLocaleString())}</td>
      <td>${e.ok ? '<span class="badge badge-success badge-sm">ok</span>' : '<span class="badge badge-error badge-sm">fail</span>'}</td>
      <td>${esc(e.status ?? '-')}</td>
      <td class="whitespace-nowrap">${esc(e.durationMs)} ms</td>
      <td class="hidden sm:table-cell">${esc(e.bytes ?? '-')}</td>
      <td class="text-xs break-all max-w-md">${esc(e.error || e.preview || '')}</td>
    </tr>`)
    .join('');

  return `<div class="card bg-base-100 shadow p-4 gap-2">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="font-semibold">${heading} <span class="text-sm font-normal opacity-70">(${esc(total)} hit(s))</span></h2>
      <div class="flex items-center gap-2">
        ${historyPager(target, { page, pages })}
        <button class="btn btn-xs btn-ghost" hx-get="/ui/blank" hx-target="#detail"
          hx-swap="innerHTML">Close</button>
      </div>
    </div>
    <div class="overflow-x-auto">
      <table class="table table-xs">
        <thead><tr><th>Time</th><th>Result</th><th>Status</th><th>Duration</th>
          <th class="hidden sm:table-cell">Bytes</th><th>Error / preview</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${historyPager(target, { page, pages })}
    ${target.capturePreview ? '<p class="text-xs opacity-60">Previews are shown for the newest hits only.</p>' : '<p class="text-xs opacity-60">Response previews are off for this target.</p>'}
  </div>`;
}

// Signed-in email plus a sign-out button for the header. Sign-out goes
// through hx-post so it carries the HX-Request header the CSRF guard needs.
function userFragment(actor) {
  if (!actor || !actor.userId) return '';
  return `<div class="flex items-center gap-2">
    <span class="hidden md:inline text-sm opacity-70 truncate max-w-xs">${esc(actor.email)}</span>
    <button class="btn btn-sm btn-ghost" hx-post="/logout" hx-swap="none">Sign out</button>
  </div>`;
}

// Full login page. Accounts are created in the Supabase dashboard; there is
// no public sign-up.
function loginPage({ error = null, email = '' } = {}) {
  const alert = error
    ? `<div class="alert alert-error text-sm" role="alert">${esc(error)}</div>`
    : '';
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sign in · URL Pinger</title>
    <link rel="stylesheet" href="/css/app.css" />
    <script src="/js/theme.js" defer></script>
  </head>
  <body class="bg-base-200 min-h-screen flex items-center justify-center p-4">
    <form method="post" action="/login"
      class="card bg-base-100 shadow-sm border border-base-300 w-full max-w-sm">
      <div class="card-body gap-3">
        <h1 class="text-lg font-bold">URL Pinger</h1>
        <p class="text-sm opacity-70">Sign in to see your targets.</p>
        ${alert}
        <label class="form-control w-full">
          <span class="label-text">Email</span>
          <input class="input input-bordered w-full" type="email" name="email"
            autocomplete="username" required maxlength="254" value="${esc(email)}" />
        </label>
        <label class="form-control w-full">
          <span class="label-text">Password</span>
          <input class="input input-bordered w-full" type="password" name="password"
            autocomplete="current-password" required maxlength="256" />
        </label>
        <button class="btn btn-primary w-full" type="submit">Sign in</button>
      </div>
    </form>
  </body>
</html>`;
}

module.exports = {
  esc,
  userFragment,
  loginPage,
  errorsFragment,
  formFragment,
  targetListFragment,
  historyFragment,
};

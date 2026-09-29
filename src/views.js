'use strict';

const config = require('./config');
const { HTTP_METHODS, BODYLESS_METHODS } = require('./validation');

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
  if (!target.enabled) return '<span class="badge badge-ghost">paused</span>';
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
      </div>

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

function historyFragment(target, entries) {
  if (!entries || entries.length === 0) {
    return `<div class="card bg-base-100 shadow p-4">
      <h2 class="font-semibold">${esc(target.name)}</h2>
      <p class="text-sm opacity-60">No hits recorded yet.</p>
    </div>`;
  }

  const rows = entries
    .map((e) => `<tr>
      <td class="whitespace-nowrap">${esc(new Date(e.at).toLocaleTimeString())}</td>
      <td>${e.ok ? '<span class="badge badge-success badge-sm">ok</span>' : '<span class="badge badge-error badge-sm">fail</span>'}</td>
      <td>${esc(e.status ?? '-')}</td>
      <td class="whitespace-nowrap">${esc(e.durationMs)} ms</td>
      <td class="hidden sm:table-cell">${esc(e.bytes ?? '-')}</td>
      <td class="text-xs break-all max-w-md">${esc(e.error || e.preview || '')}</td>
    </tr>`)
    .join('');

  return `<div class="card bg-base-100 shadow p-4 gap-2">
    <div class="flex items-center justify-between">
      <h2 class="font-semibold">${esc(target.name)} &mdash; last ${entries.length} hit(s)</h2>
      <button class="btn btn-xs btn-ghost" hx-get="/ui/blank" hx-target="#detail"
        hx-swap="innerHTML">Close</button>
    </div>
    <div class="overflow-x-auto">
      <table class="table table-xs">
        <thead><tr><th>Time</th><th>Result</th><th>Status</th><th>Duration</th>
          <th class="hidden sm:table-cell">Bytes</th><th>Error / preview</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${target.capturePreview ? '' : '<p class="text-xs opacity-60">Response previews are off for this target.</p>'}
  </div>`;
}

module.exports = {
  esc,
  errorsFragment,
  formFragment,
  targetListFragment,
  historyFragment,
};

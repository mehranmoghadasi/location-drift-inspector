/**
 * report.js — exports shared by the dashboard (download buttons) and the Node CLI.
 *
 *   toJsonReport      machine-readable, stable key order, raw UTF-8 (no escaped non-ASCII); objects
 *                     four levels deep (one check, one calendar day, one fix) are written
 *                     on a single line, which keeps the file small and diffs readable
 *   toFindingsCsv     one row per non-pass check — for a ticket queue or a spreadsheet
 *   toSpecialHoursCsv "Store code,Special hours" — only rows with missing dates; the
 *                     two-column shape is the one Google's help page allows for
 *                     special-hours-only uploads
 *   toGoogleUpdatesCsv one row per pending Google update with the page's verdict and the
 *                     action to take — a review queue for the 4-day window
 *   toHtmlReport      standalone page (inline CSS, no scripts) to send to a client
 *
 * Outputs depend only on their inputs (no clock reads), so the demo is reproducible.
 */

import { toCsv } from './csv.js';
import { describeIntervals } from './hours.js';

export const TOOL_VERSION = '1.1.0';

/** JSON.stringify with two-space indentation down to `maxDepth`, single-line below it. */
export function stringifyCompact(value, maxDepth = 4, indent = 0, depth = 0) {
  if (value === null || typeof value !== 'object' || depth >= maxDepth) return JSON.stringify(value);
  const pad = '  '.repeat(indent + 1);
  const end = '  '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map((v) => pad + stringifyCompact(v, maxDepth, indent + 1, depth + 1)).join(',\n')}\n${end}]`;
  }
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '{}';
  return `{\n${entries.map(([k, v]) => `${pad}${JSON.stringify(k)}: ${stringifyCompact(v, maxDepth, indent + 1, depth + 1)}`).join(',\n')}\n${end}}`;
}

export function toJsonReport(results, meta) {
  const body = {
    tool: 'location-drift-inspector',
    version: TOOL_VERSION,
    asOf: meta.asOf,
    horizonDays: meta.horizonDays,
    sheet: meta.sheet ?? null,
    summary: summarizeAll(results),
    locations: results,
  };
  return `${stringifyCompact(body)}\n`;
}

export function summarizeAll(results) {
  return {
    locations: results.length,
    fail: results.filter((r) => r.status === 'fail').length,
    warn: results.filter((r) => r.status === 'warn').length,
    pass: results.filter((r) => r.status === 'pass').length,
    driftDays: results.reduce((s, r) => s + r.metrics.driftDays, 0),
    comparedDays: results.reduce((s, r) => s + r.metrics.comparedDays, 0),
    googleUpdates: results.reduce((s, r) => s + (r.googleUpdates?.length ?? 0), 0),
    googleUpdatesBackedByPage: results.reduce((s, r) => s + (r.googleUpdates ?? []).filter((u) => u.verdict === 'page-backs-google').length, 0),
  };
}

export const VERDICT_ACTION = {
  'page-backs-google': 'Accept the update in the profile, or fix the page first',
  'page-backs-profile': 'Reject the update; the page supports your value',
  'page-silent': 'Check by hand; the page does not say',
  'page-differs': 'Check by hand; the page shows a third value',
};

export function toGoogleUpdatesCsv(results) {
  const rows = [['store_code', 'page_url', 'field', 'profile', 'google', 'page', 'verdict', 'action']];
  for (const r of results) {
    for (const u of r.googleUpdates ?? []) {
      rows.push([r.storeCode, r.pageUrl, u.field, u.profile, u.google, u.page, u.verdict, VERDICT_ACTION[u.verdict]]);
    }
  }
  return toCsv(rows);
}

export function toFindingsCsv(results) {
  const rows = [['store_code', 'page_url', 'check', 'field', 'severity', 'message', 'detail']];
  for (const r of results) {
    for (const c of r.checks) {
      if (c.severity === 'pass') continue;
      rows.push([r.storeCode, r.pageUrl, c.id, c.field, c.severity, c.message, (c.detail ?? []).join(' | ')]);
    }
  }
  return toCsv(rows);
}

export function toSpecialHoursCsv(results) {
  const rows = [['Store code', 'Special hours']];
  results.filter((r) => r.fixes.specialHours.cell !== '').forEach((r) => rows.push([r.storeCode, r.fixes.specialHours.cell]));
  return toCsv(rows);
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

const CELL_CLASS = { match: 'ok', drift: 'bad', unknown: 'na' };

function calendarStrip(r) {
  return r.calendar.map((c) => {
    const title = `${c.date} ${c.weekday} — profile: ${describeIntervals(c.gbp)} · JSON-LD: ${describeIntervals(c.schema)} · text: ${describeIntervals(c.visible)}`;
    return `<span class="d ${CELL_CLASS[c.schemaStatus]}${c.special ? ' sp' : ''}" title="${escapeHtml(title)}"></span>`;
  }).join('');
}

export function toHtmlReport(results, meta) {
  const s = summarizeAll(results);
  const rows = results.map((r) => {
    const issues = r.checks.filter((c) => c.severity === 'fail' || c.severity === 'warn');
    return `
  <section class="loc">
    <h2><span class="chip ${r.status}">${r.status.toUpperCase()}</span> ${escapeHtml(r.storeCode)} · ${escapeHtml(r.name)}</h2>
    <p class="url">${escapeHtml(r.pageUrl)}</p>
    <p class="m">Fails ${r.counts.fail} · Warnings ${r.counts.warn} · JSON-LD drift ${r.metrics.driftDays} of ${r.metrics.comparedDays} compared days · Visible-text drift ${r.metrics.visibleDriftDays} of ${r.metrics.visibleCompared}</p>
    <div class="cal" aria-label="Next ${meta.horizonDays} days, profile vs JSON-LD">${calendarStrip(r)}</div>
    ${issues.length === 0 ? '<p class="none">No issues.</p>' : `<ul>${issues.map((c) => `
      <li class="${c.severity}"><b>${escapeHtml(c.id)}</b> ${escapeHtml(c.message)}${c.detail ? `<ul>${c.detail.map((d) => `<li>${escapeHtml(d)}</li>`).join('')}</ul>` : ''}</li>`).join('')}
    </ul>`}${(r.googleUpdates ?? []).length === 0 ? '' : `
    <table><thead><tr><th>Pending Google update</th><th>Profile</th><th>Google</th><th>Page</th><th>Action</th></tr></thead><tbody>${r.googleUpdates.map((u) => `
      <tr class="${u.verdict}"><td>${escapeHtml(u.field)}</td><td>${escapeHtml(u.profile)}</td><td>${escapeHtml(u.google)}</td><td>${escapeHtml(u.page)}</td><td>${escapeHtml(VERDICT_ACTION[u.verdict])}</td></tr>`).join('')}
    </tbody></table>`}
    <p class="fix">${r.fixes.jsonLd.mode === 'patch'
    ? `JSON-LD fix: patch keeps ${r.fixes.jsonLd.kept.length} existing properties; changes ${escapeHtml(r.fixes.jsonLd.changes.join('; '))}.`
    : 'JSON-LD fix: the page has no LocalBusiness block; a new one is provided.'}</p>
  </section>`;
  }).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Location drift report — ${escapeHtml(meta.asOf)}</title>
<style>
  :root { --bg:#f7f8fa; --card:#fff; --ink:#1d2433; --muted:#5b6475; --ok:#1f9d55; --bad:#d64545; --warn:#c77d00; --na:#d5d9e0; --line:#e3e6eb; }
  * { box-sizing:border-box; }
  body { margin:0; padding:24px 16px; background:var(--bg); color:var(--ink); font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width:960px; margin:0 auto; }
  h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:16px; margin:0 0 4px; }
  .sub, .url, .m { color:var(--muted); margin:0 0 8px; } .url { word-break:break-all; }
  .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:8px; margin:16px 0 24px; }
  .kpi { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px; } .kpi b { display:block; font-size:22px; }
  .loc { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:16px; margin-bottom:16px; }
  .chip { display:inline-block; font-size:11px; font-weight:700; padding:2px 8px; border-radius:999px; color:#fff; vertical-align:middle; }
  .chip.fail { background:var(--bad); } .chip.warn { background:var(--warn); } .chip.pass { background:var(--ok); }
  .cal { display:flex; flex-wrap:wrap; gap:2px; margin:8px 0; } .d { width:12px; height:20px; border-radius:2px; background:var(--na); }
  .d.ok { background:var(--ok); } .d.bad { background:var(--bad); } .d.sp { outline:2px solid var(--ink); outline-offset:-2px; }
  li.fail b { color:var(--bad); } li.warn b { color:var(--warn); } .none { color:var(--ok); }
  .legend { color:var(--muted); font-size:12px; }
  table { width:100%; border-collapse:collapse; margin:8px 0; font-size:13px; } th, td { text-align:left; padding:4px 6px; border-bottom:1px solid var(--line); }
  tr.page-backs-google td:last-child { color:var(--bad); font-weight:600; } tr.page-backs-profile td:last-child { color:var(--warn); }
  .fix { color:var(--muted); font-size:12px; margin:8px 0 0; }
</style>
</head>
<body>
<main>
  <h1>Location drift report</h1>
  <p class="sub">Business Profile spreadsheet vs location pages · window ${escapeHtml(meta.asOf)} + ${meta.horizonDays} days${meta.sheet ? ` · sheet ${escapeHtml(meta.sheet)}` : ''}</p>
  <div class="kpis">
    <div class="kpi"><b>${s.locations}</b>locations</div>
    <div class="kpi"><b>${s.fail}</b>with a fail</div>
    <div class="kpi"><b>${s.warn}</b>warnings only</div>
    <div class="kpi"><b>${s.driftDays}</b>drift days (JSON-LD) of ${s.comparedDays}</div>
    <div class="kpi"><b>${s.googleUpdatesBackedByPage}</b>Google updates backed by your page (of ${s.googleUpdates})</div>
  </div>
  <p class="legend">Calendar: one cell per day. Green = profile and JSON-LD agree, red = they differ, grey = one side unknown, outlined = a special/holiday date.</p>${rows}
</main>
</body>
</html>
`;
}

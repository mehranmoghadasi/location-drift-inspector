/**
 * dashboard.js — multi-location view: import the spreadsheet, map pages, scan every
 * location page, browse results, export reports.
 *
 * Runs in two modes:
 *   extension — chrome.storage.local + fetch() with host permissions the user grants
 *               per origin when clicking "Scan all pages";
 *   demo      — opened outside the extension (npm run preview): an in-memory store and
 *               the sample spreadsheet/pages from examples/, clearly bannered.
 */

import { createStore, memoryAdapter } from '../lib/store.js';
import { parseGbpSheet } from '../lib/gbp-sheet.js';
import { auditLocation } from '../lib/audit.js';
import { pageUrlFor } from '../lib/matcher.js';
import { buildRows, filterRows, sortRows, originsFor } from '../lib/view-model.js';
import { driftChartSvg } from '../lib/chart.js';
import { toJsonReport, toFindingsCsv, toSpecialHoursCsv, toGoogleUpdatesCsv, toHtmlReport, summarizeAll } from '../lib/report.js';
import { el, chip, calendarStrip, checkList, copyWithFeedback, jsonLdScript, todayIso, download } from '../ui/common.js';

const IS_EXTENSION = typeof chrome !== 'undefined' && Boolean(chrome.storage?.local);
const EXAMPLES = new URL('../../examples/', import.meta.url);
const store = createStore(IS_EXTENSION ? chrome.storage.local : memoryAdapter());

const state = {
  view: 'locations',
  sheet: null,
  locations: [],
  sheetWarnings: [],
  mapping: {},
  settings: { horizonDays: 45 },
  latest: [],
  errors: {},
  sort: { key: 'status', dir: 'asc' },
  filter: '',
  scanning: false,
  demoPages: null,
};

const $ = (id) => document.getElementById(id);
const view = $('view');
const asOfInput = $('as-of');
asOfInput.value = todayIso();

// ---------------------------------------------------------------------------- helpers
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3200);
}

function setProgress(done, total) {
  const bar = $('progress');
  bar.hidden = total === 0 || done >= total;
  bar.firstElementChild.style.width = total === 0 ? '0' : `${Math.round((done / total) * 100)}%`;
}

function loadSheet(sheet) {
  state.sheet = sheet;
  if (!sheet) {
    state.locations = [];
    state.sheetWarnings = [];
    return;
  }
  const parsed = parseGbpSheet(sheet.csvText, { columns: sheet.columns });
  state.locations = parsed.locations;
  state.sheetWarnings = parsed.warnings;
}

async function refreshLatest() {
  state.latest = await store.getAllLatest(state.locations.map((l) => l.storeCode));
}

function currentResults() {
  return state.latest.filter(Boolean);
}

// ---------------------------------------------------------------------------- views
function renderLocations() {
  if (!state.sheet) {
    return el('div', { class: 'panel empty' },
      el('h2', {}, 'No spreadsheet yet'),
      el('p', { class: 'muted' }, 'Download your locations from Business Profile Manager and import the CSV here. It never leaves this browser.'),
      el('button', { class: 'primary', onclick: () => go('import') }, 'Import spreadsheet'));
  }
  const results = currentResults();
  const s = summarizeAll(results);
  const cards = el('div', { class: 'cards' },
    el('div', { class: 'card' }, el('b', {}, state.locations.length), 'locations in sheet'),
    el('div', { class: 'card' }, el('b', {}, results.length), 'scanned'),
    el('div', { class: 'card' }, el('b', {}, s.fail), 'with a fail'),
    el('div', { class: 'card', title: 'Days in the window where profile and JSON-LD hours differ, summed over locations' },
      el('b', {}, `${s.driftDays}/${s.comparedDays}`), 'drift days'));

  const chart = el('div', { class: 'panel' }, el('h2', {}, `Drift days in the next ${state.settings.horizonDays} days`));
  if (results.length === 0) {
    chart.append(el('p', { class: 'muted' }, 'Scan the pages to see the chart.'));
  } else {
    const holder = el('div', { class: 'chart' });
    // Size the viewBox to the available width so labels keep a readable size on phones.
    const width = Math.round(Math.min(720, Math.max(300, view.clientWidth - 40)));
    holder.innerHTML = driftChartSvg(results, { horizonDays: state.settings.horizonDays, width }); // string built with escapeHtml
    chart.append(holder, el('p', { class: 'muted' }, 'Thick bar: profile vs JSON-LD. Thin bar: profile vs visible text (heuristic). n/a: no JSON-LD hours to compare.'));
  }

  const rows = sortRows(filterRows(buildRows(state.locations, state.latest, state.mapping, state.errors), state.filter), state.sort.key, state.sort.dir);
  const head = [['storeCode', 'Store code'], ['name', 'Name'], ['status', 'Status'], ['fails', 'Fails'], ['warns', 'Warnings'], ['driftDays', 'Drift days'], [null, 'Page']];
  const th = head.map(([key, label]) => el('th', {
    scope: 'col',
    'aria-sort': key && state.sort.key === key ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : null,
    onclick: key ? () => {
      state.sort = { key, dir: state.sort.key === key && state.sort.dir === 'asc' ? 'desc' : 'asc' };
      render();
    } : null,
  }, label));
  const body = state.scanning && results.length === 0
    ? [1, 2, 3].map(() => el('tr', { class: 'skeleton-row' }, head.map(() => el('td', {}, el('span')))))
    : rows.map((r) => el('tr', { onclick: () => openDrawer(r.storeCode), tabindex: '0', onkeydown: (e) => { if (e.key === 'Enter') openDrawer(r.storeCode); } },
      el('td', {}, el('b', {}, r.storeCode)),
      el('td', {}, r.name),
      el('td', {}, r.status === 'none' ? chip('none', 'not scanned') : r.status === 'error' ? chip('fail', 'load error') : chip(r.status)),
      el('td', {}, r.fails ?? '—'),
      el('td', {}, r.warns ?? '—'),
      el('td', {}, r.driftDays === null ? '—' : `${r.driftDays}/${r.comparedDays}`),
      el('td', { class: 'url', title: r.error ?? r.pageUrl ?? '' }, r.error ?? r.pageUrl ?? 'no page URL')));
  const filter = el('input', { class: 'filter', type: 'search', placeholder: 'Filter by code, name or URL', value: state.filter, 'aria-label': 'Filter locations' });
  filter.addEventListener('input', () => {
    state.filter = filter.value;
    const tbody = view.querySelector('tbody');
    const fresh = renderLocations().querySelector('tbody');
    tbody.replaceWith(fresh);
  });
  const table = el('div', { class: 'panel' }, el('h2', {}, 'Locations'), filter,
    el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, th)), el('tbody', {}, body))));
  return el('div', {}, cards, chart, table);
}

function renderImport() {
  const input = el('input', { type: 'file', accept: '.csv,text/csv', id: 'file' });
  const drop = el('label', { class: 'drop', for: 'file' },
    el('p', {}, el('b', {}, 'Drop the Business Profile CSV here'), ' or click to choose a file.'),
    el('p', { class: 'muted' }, 'Business Profile Manager → Download profiles / Import profiles → template. Excel/Sheets: save as CSV (UTF-8).'),
    input);
  const preview = el('div');
  const handle = async (file) => {
    if (!file) return;
    try {
      const csvText = await file.text();
      const parsed = parseGbpSheet(csvText);
      const save = el('button', { class: 'primary' }, `Use these ${parsed.locations.length} locations`);
      save.addEventListener('click', async () => {
        const sheet = { fileName: file.name, importedAt: new Date().toISOString(), csvText, columns: {} };
        await store.saveSheet(sheet);
        loadSheet(sheet);
        await refreshLatest();
        toast(`Imported ${parsed.locations.length} locations`);
        go('locations');
      });
      preview.replaceChildren(el('div', { class: 'panel' },
        el('h2', {}, `${file.name}: ${parsed.locations.length} locations`),
        parsed.warnings.length ? el('ul', {}, parsed.warnings.map((w) => el('li', { class: 'muted' }, w))) : el('p', { class: 'muted' }, 'No warnings.'),
        el('div', { class: 'kv' }, parsed.locations.slice(0, 8).flatMap((l) => [el('b', {}, l.storeCode), el('span', {}, `${l.name} · ${l.website || 'no website'}${l.cellErrors.length ? ` · ${l.cellErrors.length} cell error(s)` : ''}`)])),
        el('div', { class: 'row-actions' }, save)));
    } catch (err) {
      preview.replaceChildren(el('div', { class: 'panel', role: 'alert' }, chip('fail', 'error'), ' ', err.message));
    }
  };
  input.addEventListener('change', () => handle(input.files[0]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); handle(e.dataTransfer.files[0]); });
  return el('div', {}, el('div', { class: 'panel' }, drop), preview);
}

function renderSettings() {
  const horizon = el('input', { type: 'number', min: '7', max: '120', value: state.settings.horizonDays, 'aria-label': 'Window in days' });
  horizon.addEventListener('change', async () => {
    const n = Math.min(120, Math.max(7, Number(horizon.value) || 45));
    state.settings = { ...state.settings, horizonDays: n };
    await store.saveSettings(state.settings);
    toast(`Window set to ${n} days — rescan to apply`);
  });
  const rows = state.locations.map((l) => {
    const input = el('input', { type: 'url', value: state.mapping[l.storeCode] ?? '', placeholder: l.website || 'https://…', 'aria-label': `Page URL for ${l.storeCode}` });
    input.addEventListener('change', async () => {
      state.mapping = await store.setMapping(l.storeCode, input.value.trim());
      toast(`Saved page for ${l.storeCode}`);
    });
    return el('tr', {}, el('td', {}, el('b', {}, l.storeCode)), el('td', {}, l.website || '—'), el('td', { class: 'mapping' }, input));
  });
  const clear = el('button', {}, 'Delete all scan results');
  clear.addEventListener('click', async () => {
    await store.clearScans(state.locations.map((l) => l.storeCode));
    await refreshLatest();
    toast('Scan results deleted');
  });
  return el('div', {},
    el('div', { class: 'panel' }, el('h2', {}, 'Audit window'), el('label', {}, 'Compare the next ', horizon, ' days (7–120).')),
    el('div', { class: 'panel' }, el('h2', {}, 'Location pages'),
      el('p', { class: 'muted' }, 'By default each profile is checked against its Website field. When that is your homepage, enter the location page here.'),
      el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Store code'), el('th', {}, 'Profile website'), el('th', {}, 'Page to check'))), el('tbody', {}, rows)))),
    el('div', { class: 'panel' }, el('h2', {}, 'Data'), el('p', { class: 'muted' }, `Spreadsheet: ${state.sheet?.fileName ?? 'none'}. Everything is stored in this browser only.`), clear));
}

// ---------------------------------------------------------------------------- drawer
async function openDrawer(storeCode) {
  const idx = state.locations.findIndex((l) => l.storeCode === storeCode);
  const result = state.latest[idx];
  const history = await store.getHistory(storeCode);
  $('drawer-title').textContent = `${storeCode} · ${state.locations[idx].name}`;
  const body = $('drawer-body');
  if (!result) {
    body.replaceChildren(el('p', { class: 'muted' }, state.errors[storeCode] ?? 'Not scanned yet. Use "Scan all pages" or open the page and click the toolbar button.'));
  } else {
    const patch = result.fixes.jsonLd;
    const jsonBtn = el('button', { class: 'primary' }, patch.mode === 'patch' ? 'Copy patched JSON-LD block' : 'Copy new JSON-LD block');
    jsonBtn.addEventListener('click', () => copyWithFeedback(jsonBtn, jsonLdScript(patch.block)));
    const updates = result.googleUpdates ?? [];
    const VERDICT = {
      'page-backs-google': ['fail', 'Page backs Google: accept the update or fix the page'],
      'page-backs-profile': ['warn', 'Page backs you: reject the update'],
      'page-silent': ['warn', 'Page is silent: check by hand'],
      'page-differs': ['warn', 'Page shows a third value: check by hand'],
    };
    const cell = result.fixes.specialHours.cell;
    const cellBtn = el('button', { disabled: !cell }, 'Copy Special hours cell');
    cellBtn.addEventListener('click', () => copyWithFeedback(cellBtn, cell));
    body.replaceChildren(
      el('p', { class: 'muted' }, result.pageUrl, ' · ', result.mode === 'rendered' ? 'rendered page (popup)' : 'raw HTML (batch scan)'),
      el('section', {}, el('h3', {}, `Calendar · next ${result.calendar.length} days`), calendarStrip(result.calendar),
        el('p', { class: 'muted' }, 'Green agree · red differ · grey unknown · outlined = special/holiday date. Hover a day for all three sources.')),
      el('section', {}, el('h3', {}, 'Findings'), checkList(result.checks, { showPass: true })),
      updates.length === 0 ? null : el('section', {}, el('h3', {}, `Google's pending updates · ${updates.length}`),
        el('div', { class: 'table-wrap' }, el('table', {},
          el('thead', {}, el('tr', {}, el('th', {}, 'Field'), el('th', {}, 'Your profile'), el('th', {}, 'Google'), el('th', {}, 'This page'), el('th', {}, 'Verdict'))),
          el('tbody', {}, updates.map((u) => el('tr', {},
            el('td', {}, u.field), el('td', {}, u.profile), el('td', {}, u.google), el('td', {}, u.page),
            el('td', {}, chip(VERDICT[u.verdict][0]), ' ', VERDICT[u.verdict][1])))))),
        el('p', { class: 'muted' }, 'Read from the "[UPDATED]" columns of a Business Profile download made with "Include Google updates".')),
      el('section', {}, el('h3', {}, patch.mode === 'patch' ? 'Fix: the page\'s own JSON-LD, patched' : 'Fix: new JSON-LD block'),
        el('p', { class: 'muted' }, patch.mode === 'patch'
          ? `Replace JSON-LD block #${(patch.blockIndex ?? 0) + 1} on the page with this. Kept as they were: ${patch.kept.join(', ') || 'nothing else'}.`
          : 'The page has no LocalBusiness JSON-LD; add this block.'),
        el('ul', { class: 'checks' }, patch.changes.map((c) => el('li', {}, c))),
        el('pre', {}, jsonLdScript(patch.block)), el('div', { class: 'row-actions' }, jsonBtn)),
      el('section', {}, el('h3', {}, 'Fix: profile Special hours cell'),
        cell ? el('pre', {}, cell) : el('p', { class: 'muted' }, 'The website announces no dates that the profile is missing.'),
        cell ? el('p', { class: 'muted' }, `Adds ${result.fixes.specialHours.addedDates.join(', ')} and keeps the profile's existing special hours.`) : null,
        el('div', { class: 'row-actions' }, cellBtn)),
      el('section', {}, el('h3', {}, 'History'), history.length === 0 ? el('p', { class: 'muted' }, 'No history.') : el('ul', { class: 'checks' },
        history.map((h) => el('li', {}, chip(h.status), ` ${h.scannedAt.slice(0, 16).replace('T', ' ')} · fails ${h.counts.fail} · drift ${h.driftDays}/${h.comparedDays}`)))),
    );
  }
  const drawer = $('drawer');
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  $('drawer-close').focus();
}

function closeDrawer() {
  const drawer = $('drawer');
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
}

// ---------------------------------------------------------------------------- scanning
async function loadPage(url) {
  if (!IS_EXTENSION) {
    const file = state.demoPages?.[url];
    if (!file) throw new Error('no sample page for this URL');
    const res = await fetch(new URL(`pages/${file}`, EXAMPLES));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { url, html: await res.text() };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { signal: controller.signal, credentials: 'omit', redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { url: res.url || url, html: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

async function scanAll(granted) {
  if (!granted) {
    toast('Permission to read those sites was not granted');
    return;
  }
  state.scanning = true;
  render();
  const asOf = asOfInput.value || todayIso();
  const targets = state.locations.map((l) => ({ l, url: pageUrlFor(l, state.mapping) }));
  let done = 0;
  setProgress(0, targets.length);
  const queue = targets.slice();
  const worker = async () => {
    while (queue.length > 0) {
      const { l, url } = queue.shift();
      try {
        if (!url) throw new Error('no page URL — add one under Pages & settings');
        const page = await loadPage(url);
        const result = auditLocation(l, { ...page, mode: 'raw' }, { asOf, horizonDays: state.settings.horizonDays });
        await store.saveScan(result, new Date().toISOString());
        delete state.errors[l.storeCode];
      } catch (err) {
        state.errors[l.storeCode] = `Could not scan: ${err.message}`;
      }
      done += 1;
      setProgress(done, targets.length);
    }
  };
  await Promise.all([worker(), worker()]); // two pages at a time — polite to small sites
  await refreshLatest();
  state.scanning = false;
  const failed = Object.keys(state.errors).length;
  toast(failed ? `Scanned ${targets.length - failed} of ${targets.length} pages — ${failed} could not be loaded` : `Scanned ${targets.length} pages`);
  render();
}

$('scan-all').addEventListener('click', () => {
  if (state.locations.length === 0 || state.scanning) return;
  // permissions.request must run inside the click, before any await.
  if (IS_EXTENSION) {
    const origins = originsFor(state.locations.map((l) => pageUrlFor(l, state.mapping)).filter(Boolean));
    chrome.permissions.request({ origins }).then(scanAll).catch((err) => toast(err.message));
  } else {
    scanAll(true);
  }
});

// ---------------------------------------------------------------------------- export
$('export-toggle').addEventListener('click', () => {
  const menu = $('export-menu');
  menu.hidden = !menu.hidden;
  $('export-toggle').setAttribute('aria-expanded', String(!menu.hidden));
});
$('export-menu').addEventListener('click', (e) => {
  const kind = e.target.dataset?.export;
  if (!kind) return;
  const results = currentResults();
  if (results.length === 0) {
    toast('Nothing to export yet — scan first');
    return;
  }
  const meta = { asOf: results[0].calendar[0]?.date ?? asOfInput.value, horizonDays: state.settings.horizonDays, sheet: state.sheet?.fileName };
  if (kind === 'json') download('report.json', toJsonReport(results, meta), 'application/json');
  if (kind === 'csv') download('findings.csv', toFindingsCsv(results), 'text/csv');
  if (kind === 'special') download('special-hours.csv', toSpecialHoursCsv(results), 'text/csv');
  if (kind === 'google') download('google-updates.csv', toGoogleUpdatesCsv(results), 'text/csv');
  if (kind === 'html') download('report.html', toHtmlReport(results, meta), 'text/html');
  $('export-menu').hidden = true;
});

// ---------------------------------------------------------------------------- shell
const TITLES = { locations: 'Locations', import: 'Import spreadsheet', settings: 'Pages & settings' };

function render() {
  $('title').textContent = TITLES[state.view];
  $('subtitle').textContent = state.sheet ? `${state.sheet.fileName} · ${state.locations.length} locations` : 'No spreadsheet imported';
  document.querySelectorAll('.nav').forEach((b) => (b.dataset.view === state.view ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  $('scan-all').disabled = state.locations.length === 0 || state.scanning;
  const content = state.view === 'import' ? renderImport() : state.view === 'settings' ? renderSettings() : renderLocations();
  view.replaceChildren(content);
}

function go(v) {
  state.view = v;
  closeDrawer();
  render();
}

document.querySelectorAll('.nav').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));
$('drawer-close').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

async function init() {
  if (!IS_EXTENSION) {
    $('demo-banner').hidden = false;
    const [csvText, map, pages] = await Promise.all([
      fetch(new URL('gbp-locations.csv', EXAMPLES)).then((r) => r.text()),
      fetch(new URL('map.json', EXAMPLES)).then((r) => r.json()),
      fetch(new URL('pages/pages.json', EXAMPLES)).then((r) => r.json()),
    ]);
    state.demoPages = pages;
    await store.saveSheet({ fileName: 'gbp-locations.csv (sample)', importedAt: 'demo', csvText, columns: {} });
    for (const [code, url] of Object.entries(map)) await store.setMapping(code, url);
    asOfInput.value = '2026-11-20';
  }
  state.settings = await store.getSettings();
  state.mapping = await store.getMapping();
  loadSheet(await store.getSheet());
  await refreshLatest();
  render();
}

init().catch((err) => {
  view.replaceChildren(el('div', { class: 'panel', role: 'alert' }, chip('fail', 'error'), ' Could not load the dashboard: ', err.message));
  console.error(err);
});

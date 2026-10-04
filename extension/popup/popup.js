/**
 * popup.js — "check the page I am looking at".
 * Reads the rendered DOM of the active tab (activeTab + scripting, granted by the click),
 * matches it to a spreadsheet row, runs the same audit as the dashboard and saves it.
 */

import { createStore } from '../lib/store.js';
import { parseGbpSheet } from '../lib/gbp-sheet.js';
import { matchLocation } from '../lib/matcher.js';
import { auditLocation } from '../lib/audit.js';
import { el, chip, calendarStrip, checkList, copyWithFeedback, jsonLdScript, todayIso } from '../ui/common.js';

const app = document.getElementById('app');
const store = createStore(chrome.storage.local);

document.getElementById('open-dashboard').addEventListener('click', () => chrome.runtime.openOptionsPage());

function show(...nodes) {
  app.replaceChildren(...nodes);
}

function emptyState(text, actionLabel, action) {
  show(el('div', { class: 'empty' }, el('p', {}, text), actionLabel ? el('button', { class: 'primary', onclick: action }, actionLabel) : null));
}

function errorState(err) {
  console.error(err);
  show(el('div', { class: 'error', role: 'alert' }, el('b', {}, 'Could not check this page. '), String(err.message ?? err)));
}

async function readActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:/i.test(tab.url ?? '')) return { tab, html: null };
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => document.documentElement.outerHTML,
  });
  return { tab, html: injection?.result ?? '' };
}

function renderResult(result, tab) {
  const fixes = result.fixes;
  const patch = fixes.jsonLd;
  const jsonBtn = el('button', { class: 'primary', title: patch.changes.join('\n') },
    patch.mode === 'patch' ? 'Copy patched JSON-LD' : 'Copy new JSON-LD');
  jsonBtn.addEventListener('click', () => copyWithFeedback(jsonBtn, jsonLdScript(patch.block)));
  const cellBtn = fixes.specialHours.cell
    ? el('button', {}, `Copy Special hours cell (+${fixes.specialHours.addedDates.length})`)
    : null;
  cellBtn?.addEventListener('click', () => copyWithFeedback(cellBtn, fixes.specialHours.cell));
  show(
    el('div', { class: 'head' }, chip(result.status), el('h1', {}, `${result.storeCode} · ${result.name}`)),
    el('p', { class: 'url muted' }, tab.url),
    el('div', { class: 'kpis' },
      el('div', { class: 'kpi' }, el('b', {}, result.counts.fail), 'fails'),
      el('div', { class: 'kpi' }, el('b', {}, result.counts.warn), 'warnings'),
      el('div', { class: 'kpi', title: 'Days in the window where profile and JSON-LD hours differ' },
        el('b', {}, `${result.metrics.driftDays}/${result.metrics.comparedDays}`), 'drift days')),
    el('div', { class: 'section' }, el('h2', {}, 'Next 14 days · profile vs JSON-LD'), calendarStrip(result.calendar, 14)),
    el('div', { class: 'section' }, el('h2', {}, 'Findings'), checkList(result.checks)),
    el('p', { class: 'muted small' }, patch.mode === 'patch'
      ? `The patch keeps ${patch.kept.length} existing propert${patch.kept.length === 1 ? 'y' : 'ies'} and changes only: ${patch.changes.join('; ')}.`
      : 'This page has no LocalBusiness JSON-LD, so a new minimal block is offered.'),
    el('div', { class: 'actions' }, jsonBtn, cellBtn),
  );
}

function renderPicker(locations, tab, onPick, ambiguous) {
  const select = el('select', { 'aria-label': 'Store code' },
    locations.map((l) => el('option', { value: l.storeCode }, `${l.storeCode} · ${l.name}`)));
  show(
    el('div', { class: 'empty' },
      el('p', {}, ambiguous.length > 1
        ? `Several profiles (${ambiguous.join(', ')}) link to this URL. Which location is this page?`
        : 'This page is not linked from any profile in your spreadsheet. Which location is it?'),
      el('div', { class: 'pick' }, select, el('button', { class: 'primary', onclick: () => onPick(select.value) }, 'Check as this location'))),
  );
}

async function main() {
  const sheet = await store.getSheet();
  if (!sheet) {
    emptyState('Import your Business Profile spreadsheet first.', 'Open dashboard', () => chrome.runtime.openOptionsPage());
    return;
  }
  const { tab, html } = await readActiveTab();
  if (html === null) {
    emptyState('Open a location page (http or https) and click the toolbar button again.');
    return;
  }
  const { locations } = parseGbpSheet(sheet.csvText, { columns: sheet.columns });
  const settings = await store.getSettings();
  const scan = async (location) => {
    const result = auditLocation(location, { url: tab.url, html, mode: 'rendered' }, { asOf: todayIso(), horizonDays: settings.horizonDays });
    await store.saveScan(result, new Date().toISOString());
    chrome.runtime.sendMessage({ type: 'badge', tabId: tab.id, fails: result.counts.fail, warns: result.counts.warn })
      .catch((err) => console.warn('badge update failed', err));
    renderResult(result, tab);
  };
  const match = matchLocation(locations, tab.url, await store.getMapping());
  if (match.location) {
    await scan(match.location);
    return;
  }
  renderPicker(locations, tab, async (code) => {
    try {
      await store.setMapping(code, tab.url);
      await scan(locations.find((l) => l.storeCode === code));
    } catch (err) {
      errorState(err);
    }
  }, match.candidates);
}

main().catch(errorState);

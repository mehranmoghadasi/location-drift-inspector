/**
 * view-model.js — table rows for the dashboard, kept out of the DOM code so the
 * sorting/filtering rules are testable.
 *
 * Status order used for sorting: fail < warn < pass < error < not scanned.
 * "error" = the last scan attempt could not load the page; "none" = never scanned.
 */

import { pageUrlFor } from './matcher.js';

const STATUS_RANK = { fail: 0, warn: 1, pass: 2, error: 3, none: 4 };

/**
 * @param {Array<object>} locations   parsed spreadsheet rows
 * @param {Array<object|null>} latest same order as locations: last audit result or null
 * @param {Record<string,string>} mapping
 * @param {Record<string,string>} [errors] storeCode → last load error
 */
export function buildRows(locations, latest, mapping, errors = {}) {
  return locations.map((loc, i) => {
    const r = latest[i];
    const error = errors[loc.storeCode] ?? null;
    return {
      storeCode: loc.storeCode,
      name: loc.name,
      pageUrl: pageUrlFor(loc, mapping),
      status: error ? 'error' : r ? r.status : 'none',
      fails: r ? r.counts.fail : null,
      warns: r ? r.counts.warn : null,
      driftDays: r ? r.metrics.driftDays : null,
      comparedDays: r ? r.metrics.comparedDays : null,
      error,
    };
  });
}

/** Case-insensitive match on store code, name or page URL. */
export function filterRows(rows, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (q === '') return rows;
  return rows.filter((r) => [r.storeCode, r.name, r.pageUrl ?? ''].some((v) => v.toLowerCase().includes(q)));
}

/**
 * Stable sort; nulls (not scanned) always sort last regardless of direction.
 * @param {'storeCode'|'name'|'status'|'fails'|'warns'|'driftDays'} key
 * @param {'asc'|'desc'} dir
 */
export function sortRows(rows, key, dir = 'asc') {
  const sign = dir === 'desc' ? -1 : 1;
  const value = (r) => (key === 'status' ? STATUS_RANK[r.status] : r[key]);
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const va = value(a.r);
      const vb = value(b.r);
      if (va === null && vb === null) return a.i - b.i;
      if (va === null) return 1;
      if (vb === null) return -1;
      const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
      return cmp !== 0 ? sign * cmp : a.i - b.i;
    })
    .map((x) => x.r);
}

/** Origins to request host permission for before a batch scan. */
export function originsFor(urls) {
  const out = new Set();
  for (const u of urls) {
    try {
      const { protocol, host } = new URL(u);
      if (protocol === 'http:' || protocol === 'https:') out.add(`${protocol}//${host}/*`);
    } catch (err) {
      if (!(err instanceof TypeError)) throw err; // not a URL — the scan reports it per row
    }
  }
  return [...out].sort();
}

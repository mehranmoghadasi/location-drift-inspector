/**
 * matcher.js — decide which spreadsheet row a page belongs to.
 *
 * Order: (1) an explicit mapping saved by the user (store code → page URL), then
 * (2) the row whose "Website" field normalises to the same URL as the page
 * (see normalizeUrl in normalize.js). Several rows sharing one website — common when
 * every profile links to the homepage — are reported as ambiguous instead of guessed.
 */

import { normalizeUrl } from './normalize.js';

/**
 * @param {Array<object>} locations
 * @param {string} pageUrl
 * @param {Record<string,string>} [mapping] storeCode → page URL
 * @returns {{location: object|null, reason: 'mapping'|'website'|'ambiguous'|'none', candidates: string[]}}
 */
export function matchLocation(locations, pageUrl, mapping = {}) {
  const key = normalizeUrl(pageUrl);
  if (key === null) return { location: null, reason: 'none', candidates: [] };
  const mapped = Object.entries(mapping).filter(([, url]) => normalizeUrl(url) === key).map(([code]) => code);
  if (mapped.length >= 1) {
    const loc = locations.find((l) => l.storeCode === mapped[0]) ?? null;
    if (loc) return { location: loc, reason: 'mapping', candidates: mapped };
  }
  const hits = locations.filter((l) => l.website && normalizeUrl(l.website) === key);
  if (hits.length === 1) return { location: hits[0], reason: 'website', candidates: [hits[0].storeCode] };
  if (hits.length > 1) return { location: null, reason: 'ambiguous', candidates: hits.map((h) => h.storeCode) };
  return { location: null, reason: 'none', candidates: [] };
}

/** Page URL to scan for a row: explicit mapping first, then the Website field. */
export function pageUrlFor(location, mapping = {}) {
  return mapping[location.storeCode] || location.website || null;
}

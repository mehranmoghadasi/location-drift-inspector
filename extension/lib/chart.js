/**
 * chart.js — horizontal bar chart of drift days per location, as an SVG string.
 *
 * Each row shows two bars on the same 0…horizonDays scale:
 *   thick bar = driftDays (profile vs JSON-LD), thin bar = visibleDriftDays (profile vs text).
 * A location with nothing compared (no JSON-LD hours) shows "n/a" instead of a zero bar,
 * so "no data" is never drawn as "no drift".
 * Pure string output: no DOM, deterministic, unit-tested.
 */

import { escapeHtml } from './report.js';

/**
 * @param {Array<{storeCode:string, metrics:{driftDays:number, comparedDays:number, visibleDriftDays:number, visibleCompared:number}}>} results
 * @param {{horizonDays:number, width?:number}} opts
 * @returns {string} SVG markup
 */
export function driftChartSvg(results, { horizonDays, width = 640 }) {
  const rowH = 28;
  const labelW = 96;
  const valueW = 64;
  const plotW = Math.max(40, width - labelW - valueW);
  const height = Math.max(1, results.length) * rowH + 24;
  const x = (days) => labelW + Math.round((Math.min(days, horizonDays) / horizonDays) * plotW);
  const rows = results.map((r, i) => {
    const y = i * rowH + 4;
    const m = r.metrics;
    const label = `<text x="0" y="${y + 15}" class="lbl">${escapeHtml(r.storeCode)}</text>`;
    const track = `<rect x="${labelW}" y="${y + 4}" width="${plotW}" height="12" rx="2" class="track"/>`;
    if (m.comparedDays === 0) {
      return `${label}${track}<text x="${labelW + plotW + 8}" y="${y + 15}" class="val">n/a</text>`;
    }
    const main = `<rect x="${labelW}" y="${y + 4}" width="${x(m.driftDays) - labelW}" height="12" rx="2" class="bar"><title>${escapeHtml(r.storeCode)}: ${m.driftDays} of ${m.comparedDays} days differ (JSON-LD)</title></rect>`;
    const thin = m.visibleCompared > 0
      ? `<rect x="${labelW}" y="${y + 18}" width="${x(m.visibleDriftDays) - labelW}" height="4" rx="1" class="bar2"><title>${escapeHtml(r.storeCode)}: ${m.visibleDriftDays} of ${m.visibleCompared} days differ (visible text)</title></rect>`
      : '';
    return `${label}${track}${main}${thin}<text x="${labelW + plotW + 8}" y="${y + 15}" class="val">${m.driftDays}/${m.comparedDays}</text>`;
  }).join('');
  const axisY = results.length * rowH + 16;
  const axis = `<text x="${labelW}" y="${axisY}" class="ax">0</text><text x="${labelW + plotW}" y="${axisY}" class="ax" text-anchor="end">${horizonDays} days</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Drift days per location">${rows}${axis}</svg>`;
}

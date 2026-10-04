/**
 * common.js — small DOM helpers shared by the popup and the dashboard.
 * Everything that decides WHAT to show lives in lib/ (tested in Node); this file only
 * builds elements, so it stays thin.
 */

import { describeIntervals } from '../lib/hours.js';

/** Create an element: el('div', {class: 'x', onclick: fn}, child, 'text', …). */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** The user's local calendar date as YYYY-MM-DD (the audit itself never reads a clock). */
export function todayIso(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function chip(severity, label = severity) {
  return el('span', { class: `chip ${severity}` }, label);
}

/** One coloured cell per day; tooltip shows all three sources. */
export function calendarStrip(calendar, days = calendar.length) {
  return el('div', { class: 'cal', role: 'img', 'aria-label': `Next ${days} days: profile vs JSON-LD` },
    calendar.slice(0, days).map((c) => el('span', {
      class: `d ${c.schemaStatus}${c.special ? ' sp' : ''}`,
      title: `${c.date} ${c.weekday}\nProfile: ${describeIntervals(c.gbp)}\nJSON-LD: ${describeIntervals(c.schema)}\nText: ${describeIntervals(c.visible)}`,
    })));
}

const ORDER = { fail: 0, warn: 1, info: 2, pass: 3 };

/** Checks list, worst first; pass rows are hidden unless showPass. */
export function checkList(checks, { showPass = false } = {}) {
  const rows = checks
    .filter((c) => showPass || c.severity !== 'pass')
    .slice()
    .sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  if (rows.length === 0) return el('p', { class: 'muted' }, 'No issues found.');
  return el('ul', { class: 'checks' }, rows.map((c) => el('li', {},
    chip(c.severity), ' ', el('b', {}, c.field), ' — ', c.message,
    c.detail ? el('ul', {}, c.detail.map((d) => el('li', {}, d))) : null)));
}

/** Copy text and play the "copied" micro-interaction on the button. */
export async function copyWithFeedback(button, text) {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied ✓';
  } catch (err) {
    button.textContent = 'Copy failed';
    console.warn('clipboard write failed', err);
  }
  button.classList.remove('copied');
  void button.offsetWidth; // restart the animation
  button.classList.add('copied');
  setTimeout(() => { button.textContent = original; }, 1400);
}

/** Wrap a JSON-LD object in the script tag a CMS field expects. */
export function jsonLdScript(obj) {
  return `<script type="application/ld+json">\n${JSON.stringify(obj, null, 2)}\n</script>`;
}

/** Trigger a file download from a string. */
export function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * csv.js — RFC 4180 CSV reader/writer with no dependencies.
 *
 * Handles: UTF-8 BOM, CRLF / LF / CR line endings, quoted fields containing commas,
 * quotes ("" escape) and line breaks, and a trailing newline — a spreadsheet that has
 * been re-saved from Excel or Google Sheets can arrive in any of these shapes.
 */

/**
 * @param {string} text
 * @returns {string[][]} rows of cells; blank lines are dropped
 */
export function parseCsv(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && cell === '') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(cell);
      cell = '';
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += ch === '\r' && src[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    cell += ch;
    i += 1;
  }
  if (inQuotes) {
    throw new Error('CSV ends inside a quoted field (unbalanced quotes)');
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

/** Quote a cell only when it needs it. */
function quoteCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * @param {Array<Array<string|number|null>>} rows
 * @returns {string} CSV text with LF line endings and a trailing newline
 */
export function toCsv(rows) {
  return rows.map((r) => r.map(quoteCell).join(',')).join('\n') + '\n';
}

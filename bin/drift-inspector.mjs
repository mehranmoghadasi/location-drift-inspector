#!/usr/bin/env node
/**
 * drift-inspector — the same audit the extension runs, from a terminal or a CI job.
 *
 *   node bin/drift-inspector.mjs --sheet locations.csv --as-of 2026-11-20 \
 *        (--pages ./saved-pages | --fetch) [--horizon 45] [--out ./report] [--fail-on fail|warn|never]
 *
 * --pages DIR  read pages from DIR/pages.json ({ "<page url>": "<file in DIR>" }) — offline
 * --fetch      download each row's page (Website column, or --map file) with Node's fetch
 * --map FILE   JSON { "<store code>": "<page url>" } overriding the Website column
 * --out DIR    write report.json, findings.csv, special-hours.csv, google-updates.csv, report.html
 * Exit code: 0 ok, 1 when a location reaches the --fail-on level (default "fail"), 2 usage error.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseGbpSheet } from '../extension/lib/gbp-sheet.js';
import { auditLocation, DEFAULT_HORIZON_DAYS } from '../extension/lib/audit.js';
import { pageUrlFor } from '../extension/lib/matcher.js';
import { toJsonReport, toFindingsCsv, toSpecialHoursCsv, toGoogleUpdatesCsv, toHtmlReport, summarizeAll, TOOL_VERSION } from '../extension/lib/report.js';

const USAGE = 'usage: drift-inspector --sheet FILE --as-of YYYY-MM-DD (--pages DIR | --fetch) [--map FILE] [--horizon N] [--out DIR] [--fail-on fail|warn|never]';

export function parseArgs(argv) {
  const args = { horizon: DEFAULT_HORIZON_DAYS, failOn: 'fail', fetch: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === '--sheet') args.sheet = next();
    else if (a === '--pages') args.pages = next();
    else if (a === '--fetch') args.fetch = true;
    else if (a === '--map') args.map = next();
    else if (a === '--as-of') args.asOf = next();
    else if (a === '--horizon') args.horizon = Number(next());
    else if (a === '--out') args.out = next();
    else if (a === '--fail-on') args.failOn = next();
    else if (a === '--version') args.version = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  if (args.help || args.version) return args;
  if (!args.sheet) throw new Error('--sheet is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.asOf ?? '')) throw new Error('--as-of YYYY-MM-DD is required (it keeps runs reproducible)');
  if (Boolean(args.pages) === args.fetch) throw new Error('use exactly one of --pages DIR or --fetch');
  if (!['fail', 'warn', 'never'].includes(args.failOn)) throw new Error('--fail-on must be fail, warn or never');
  if (!Number.isInteger(args.horizon) || args.horizon < 1 || args.horizon > 366) throw new Error('--horizon must be an integer 1–366');
  return args;
}

async function fetchPage(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': `location-drift-inspector/${TOOL_VERSION} (+https://github.com/mehranmoghadasi/location-drift-inspector)` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { url: res.url || url, html: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the audit and return { results, skipped, summary, outputs }.
 * Exported so tests and examples/demo.mjs can call it without spawning a process.
 */
export async function run(args, log = () => {}) {
  const sheetText = await readFile(args.sheet, 'utf8');
  const sheet = parseGbpSheet(sheetText);
  sheet.warnings.forEach((w) => log(`sheet: ${w}`));
  const mapping = args.map ? JSON.parse(await readFile(args.map, 'utf8')) : {};
  let offline = null;
  if (args.pages) offline = JSON.parse(await readFile(path.join(args.pages, 'pages.json'), 'utf8'));

  const results = [];
  const skipped = [];
  for (const location of sheet.locations) {
    const url = pageUrlFor(location, mapping);
    if (!url) {
      skipped.push({ storeCode: location.storeCode, reason: 'no page URL (empty Website and no --map entry)' });
      continue;
    }
    let page;
    try {
      if (offline) {
        const file = offline[url];
        if (!file) throw new Error(`no saved page for ${url} in pages.json`);
        page = { url, html: await readFile(path.join(args.pages, file), 'utf8'), mode: 'raw' };
      } else {
        const got = await fetchPage(url);
        page = { url: got.url, html: got.html, mode: 'raw' };
      }
    } catch (err) {
      skipped.push({ storeCode: location.storeCode, reason: `could not load ${url}: ${err.message}` });
      continue;
    }
    results.push(auditLocation(location, page, { asOf: args.asOf, horizonDays: args.horizon }));
  }
  const meta = { asOf: args.asOf, horizonDays: args.horizon, sheet: path.basename(args.sheet) };
  const outputs = {
    'report.json': toJsonReport(results, meta),
    'findings.csv': toFindingsCsv(results),
    'special-hours.csv': toSpecialHoursCsv(results),
    'google-updates.csv': toGoogleUpdatesCsv(results),
    'report.html': toHtmlReport(results, meta),
  };
  if (args.out) {
    await mkdir(args.out, { recursive: true });
    for (const [name, body] of Object.entries(outputs)) {
      await writeFile(path.join(args.out, name), body, 'utf8');
    }
  }
  return { results, skipped, summary: summarizeAll(results), outputs };
}

export function formatSummary({ results, skipped, summary }, asOf, horizon) {
  const lines = [`location-drift-inspector ${TOOL_VERSION} · window ${asOf} + ${horizon} days`];
  for (const r of results) {
    lines.push(`${r.status.toUpperCase().padEnd(4)}  ${r.storeCode.padEnd(8)} fails ${r.counts.fail}  warns ${r.counts.warn}  drift ${r.metrics.driftDays}/${r.metrics.comparedDays} days  ${r.pageUrl}`);
    for (const c of r.checks.filter((x) => x.severity === 'fail')) lines.push(`      ✗ ${c.id}: ${c.message}`);
  }
  for (const s of skipped) lines.push(`SKIP  ${s.storeCode.padEnd(8)} ${s.reason}`);
  lines.push(`${summary.locations} location(s): ${summary.fail} fail · ${summary.warn} warn · ${summary.pass} pass · ${summary.driftDays} drift day(s) of ${summary.comparedDays} compared`);
  if (summary.googleUpdates > 0) {
    lines.push(`${summary.googleUpdates} pending Google update(s); ${summary.googleUpdatesBackedByPage} backed by your own page`);
  }
  return lines.join('\n');
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n${USAGE}\n`);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (args.version) {
    process.stdout.write(`${TOOL_VERSION}\n`);
    return;
  }
  const out = await run(args, (m) => process.stderr.write(`${m}\n`));
  process.stdout.write(`${formatSummary(out, args.asOf, args.horizon)}\n`);
  const worst = out.results.some((r) => r.status === 'fail') ? 'fail' : out.results.some((r) => r.status === 'warn') ? 'warn' : 'pass';
  if ((args.failOn === 'fail' && worst === 'fail') || (args.failOn === 'warn' && worst !== 'pass')) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(2);
  });
}

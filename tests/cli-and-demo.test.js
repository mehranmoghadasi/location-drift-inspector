import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, run } from '../bin/drift-inspector.mjs';
import { DEMO_ARGS } from '../examples/demo.mjs';
import { createServer } from '../scripts/serve.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_FILES = ['report.json', 'findings.csv', 'special-hours.csv', 'google-updates.csv', 'report.html'];

test('demo reproduces the committed examples/output byte for byte, as raw UTF-8', async () => {
  const { outputs } = await run(DEMO_ARGS);
  for (const name of OUTPUT_FILES) {
    const committed = readFileSync(path.join(root, 'examples', 'output', name), 'utf8');
    assert.equal(outputs[name], committed, `${name} differs — run "npm run demo" and review the diff`);
    assert.doesNotMatch(committed, /\\u[0-9a-f]{4}/i, `${name} contains \\u escapes`);
    assert.doesNotMatch(committed, /\r/, `${name} contains CR characters`);
  }
});

test('argument validation: required options, exclusive page sources, ranges', () => {
  assert.throws(() => parseArgs(['--sheet', 'a.csv', '--pages', 'p']), /as-of/);
  assert.throws(() => parseArgs(['--sheet', 'a.csv', '--as-of', '2026-11-20']), /exactly one/);
  assert.throws(() => parseArgs(['--sheet', 'a.csv', '--as-of', '2026-11-20', '--pages', 'p', '--fetch']), /exactly one/);
  assert.throws(() => parseArgs(['--sheet', 'a.csv', '--as-of', '2026-11-20', '--fetch', '--horizon', '0']), /horizon/);
  assert.throws(() => parseArgs(['--sheet', 'a.csv', '--as-of', '2026-11-20', '--fetch', '--fail-on', 'sometimes']), /fail-on/);
  assert.throws(() => parseArgs(['--sheet']), /needs a value/);
  assert.throws(() => parseArgs(['--bogus']), /unknown option/);
  const ok = parseArgs(['--sheet', 'a.csv', '--as-of', '2026-11-20', '--fetch', '--horizon', '30', '--fail-on', 'warn']);
  assert.deepEqual([ok.horizon, ok.failOn, ok.fetch], [30, 'warn', true]);
});

test('--fetch reads live pages over HTTP; non-200 pages and missing URLs are skipped with a reason', async () => {
  const pages = {
    '/locations/beltline': readFileSync(path.join(root, 'examples/pages/beltline.html'), 'utf8'),
  };
  const server = http.createServer((req, res) => {
    const body = pages[req.url];
    if (body) res.writeHead(200, { 'content-type': 'text/html' }).end(body);
    else res.writeHead(404).end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(path.join(tmpdir(), 'ldi-'));
  try {
    const csv = [
      'Store code,Business name,Address line 1,Locality,Administrative area,Postal code,Primary phone,Website,Sunday hours,Monday hours,Tuesday hours,Wednesday hours,Thursday hours,Friday hours,Saturday hours,Special hours',
      `NG-BELT,Northgate Rentals Beltline,1010 Sample Ave SW Suite 200,Calgary,AB,T2R 0A1,(403) 555-0110,${base}/locations/beltline,x,08:30-17:00,08:30-17:00,08:30-17:00,08:30-17:00,08:30-17:00,10:00-14:00,"2026-12-24: 09:00-13:00, 2026-12-25: x, 2026-12-26: x, 2027-01-01: x"`,
      `GONE,Closed branch,1 Nowhere St,Calgary,AB,T2R 0A1,403-555-0111,${base}/locations/gone,x,x,x,x,x,x,x,`,
      'NOURL,No website,2 Nowhere St,Calgary,AB,T2R 0A1,403-555-0112,,x,x,x,x,x,x,x,',
    ].join('\n');
    const sheetPath = path.join(dir, 'sheet.csv');
    writeFileSync(sheetPath, csv);
    const out = await run({ sheet: sheetPath, fetch: true, asOf: '2026-11-20', horizon: 45, failOn: 'fail' });
    assert.equal(out.results.length, 1);
    // Hours agree; the only finding is that the page's JSON-LD url names the production
    // domain while the page was served from the test server.
    assert.equal(out.results[0].status, 'warn');
    assert.deepEqual(out.results[0].checks.filter((c) => c.severity !== 'pass').map((c) => c.id), ['URL_SCHEMA']);
    assert.equal(out.results[0].metrics.driftDays, 0);
    assert.deepEqual(out.skipped.map((s) => s.storeCode), ['GONE', 'NOURL']);
    assert.match(out.skipped[0].reason, /HTTP 404/);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exit codes: 1 when a location fails (default), 0 with --fail-on never, 2 on usage errors', () => {
  const cli = path.join(root, 'bin', 'drift-inspector.mjs');
  const base = ['--sheet', 'examples/gbp-locations.csv', '--pages', 'examples/pages', '--map', 'examples/map.json', '--as-of', '2026-11-20'];
  const failing = spawnSync(process.execPath, [cli, ...base], { cwd: root, encoding: 'utf8' });
  assert.equal(failing.status, 1, failing.stderr);
  assert.match(failing.stdout, /FAIL {2}NG-AIRP/);
  assert.equal(spawnSync(process.execPath, [cli, ...base, '--fail-on', 'never'], { cwd: root }).status, 0);
  const usage = spawnSync(process.execPath, [cli, '--sheet'], { cwd: root, encoding: 'utf8' });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage:/);
});

test('preview server serves the repo and cannot be walked out of its root', async () => {
  const server = createServer(root);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await fetch(`${base}/extension/dashboard/dashboard.html`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type'), /text\/html/);
    const missing = await fetch(`${base}/nope.txt`);
    assert.equal(missing.status, 404);
    const traversal = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path: '/%2e%2e/%2e%2e/etc/passwd' }, (res) => resolve(res.statusCode));
    });
    // URL parsing collapses ../ segments, so the request resolves inside the root and is
    // simply not found; a 200 here would mean a file outside the repo was served.
    assert.equal(traversal, 404);
  } finally {
    server.close();
  }
});

#!/usr/bin/env node
/**
 * demo.mjs — audit the five sample locations and write examples/output/.
 * Fixed inputs and a fixed as-of date, so a fresh clone reproduces the committed
 * output byte for byte (tests/demo.test.js checks this).
 *
 *   npm run demo
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, formatSummary } from '../bin/drift-inspector.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export const DEMO_ARGS = {
  sheet: path.join(here, 'gbp-locations.csv'),
  pages: path.join(here, 'pages'),
  map: path.join(here, 'map.json'),
  asOf: '2026-11-20',
  horizon: 45,
  fetch: false,
  failOn: 'never',
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = await run({ ...DEMO_ARGS, out: path.join(here, 'output') });
  process.stdout.write(`${formatSummary(out, DEMO_ARGS.asOf, DEMO_ARGS.horizon)}\n`);
}

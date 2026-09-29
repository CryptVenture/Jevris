#!/usr/bin/env node
/**
 * Price refresh (EVL-10, §19.1).
 *
 *   node packages/evals/scripts/refresh-prices.mjs --updates <reviewed-prices.json> [--date YYYY-MM-DD] [--write]
 *
 * Prices are read by a person from each vendor's pricing page and recorded in a reviewed updates
 * file (an array of rows: vendor, modelId, sourceUrl, fetchedOn, input, output, unit). This script
 * validates every row (an https source URL and a date are required), applies the updates to
 * fixtures/evaluation/cost-registry.json and prints the changed rows and the recomputed §19.1
 * arithmetic. It never fetches the network and writes only with --write; run `npm run assets:sync`
 * afterwards to copy the registry into assets/.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { refreshPrices, section191, validatePriceRow } from '../dist/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const registryPath = join(root, 'fixtures', 'evaluation', 'cost-registry.json');

function arg(name) {
  const at = process.argv.indexOf(name);
  return at < 0 ? null : (process.argv[at + 1] ?? null);
}

const updatesPath = arg('--updates');
if (updatesPath === null) {
  process.stderr.write('usage: refresh-prices.mjs --updates <reviewed-prices.json> [--date YYYY-MM-DD] [--write]\n');
  process.exit(2);
}
const date = arg('--date') ?? new Date().toISOString().slice(0, 10);
const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
const updates = JSON.parse(readFileSync(updatesPath, 'utf8'));
if (!Array.isArray(updates)) {
  process.stderr.write('refresh-prices: the updates file must be a JSON array of price rows\n');
  process.exit(1);
}
const invalid = updates.filter((row) => !validatePriceRow(row));
if (invalid.length > 0) {
  process.stderr.write(`refresh-prices: ${invalid.length} invalid row(s); each needs vendor, modelId, an https sourceUrl, fetchedOn, input, output and unit\n`);
  process.exit(1);
}
const next = refreshPrices(registry, updates, date);
for (const row of updates) {
  const before = registry.prices.find((p) => p.vendor === row.vendor && p.modelId === row.modelId);
  process.stdout.write(`${row.vendor} ${row.modelId}: ${before === undefined ? 'new' : `${before.input}/${before.output}`} -> ${row.input}/${row.output} (${row.sourceUrl}, ${row.fetchedOn})\n`);
}
const arithmetic = section191(next);
if (arithmetic !== null) {
  process.stdout.write(`§19.1: 100 evaluations x 5000 tokens = $${arithmetic.hundredEvaluationsUsd}; 1000 = $${arithmetic.thousandEvaluationsUsd}\n`);
  for (const [name, ratio] of Object.entries(arithmetic.ratios)) process.stdout.write(`  input price ${name} / Jev = ${ratio}x\n`);
}
if (process.argv.includes('--write')) {
  writeFileSync(registryPath, `${JSON.stringify(next, null, 2)}\n`);
  process.stdout.write(`wrote ${registryPath}; run npm run assets:sync\n`);
} else {
  process.stdout.write('dry run: pass --write to update the registry\n');
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The engine-overhead benchmark (`npm run bench:engine`): only its pure parts run here. The run builds an engine on a
 * real disk, counts fsyncs and takes seconds, so npm test never collects it. A short run against the stub Jev is
 * covered once, with a tiny count, to prove the script and the engine agree on what a cold decision, a cache hit and
 * a rules answer cost in durable writes.
 */
const root = fileURLToPath(new URL('../../..', import.meta.url));
const script = await import('../scripts/engine-overhead.mjs');

test('bench:engine runs apps/sidecar/scripts/engine-overhead.mjs, and npm test never collects it', async () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['bench:engine'], 'node apps/sidecar/scripts/engine-overhead.mjs');
  const { collectTestFiles } = await import('../../../scripts/test.mjs');
  assert.equal(collectTestFiles().some((file) => file.endsWith(join('scripts', 'engine-overhead.mjs'))), false);
});

test('arguments are checked: a count, seeded budget entries, json and a file; anything else is an error', () => {
  assert.deepEqual(script.parseArgs([]), { n: 60, seedReservations: 0, json: false, out: null });
  assert.deepEqual(script.parseArgs(['--n', '5', '--seed-reservations', '300', '--json', '--out', 'x.json']), { n: 5, seedReservations: 300, json: true, out: 'x.json' });
  for (const bad of [['--n', '0'], ['--n', '5000'], ['--n', 'x'], ['--seed-reservations', '-1'], ['--seed-reservations', '999999'], ['--what'], ['--n']]) assert.throws(() => script.parseArgs(bad), Error, bad.join(' '));
});

test('summarize gives the minimum, the median, the 95th percentile and the maximum, or null for nothing', () => {
  assert.equal(script.summarize([]), null);
  assert.deepEqual(script.summarize([5, 1, 3, 2, 4]), { n: 5, min: 1, p50: 3, p95: 5, max: 5 });
  assert.deepEqual(script.summarize([2.04]), { n: 1, min: 2, p50: 2, p95: 2, max: 2 });
});

test('a short run reports the durable writes of each path: a cold decision, a cache hit and a rules answer', async () => {
  const report = await script.measure({ n: 3 });
  assert.equal(report.schemaVersion, 'jevris-engine-overhead-1');
  // A cold route classification: reservation, entry before the send, commit, record, then the classification's advice record.
  assert.equal(report.cold.fsyncsPerOp, 5);
  // The same features again: the cache answers (one record), and the classification records its advice (one).
  assert.equal(report.hit.fsyncsPerOp, 2);
  assert.equal(report.rules.fsyncsPerOp, 1);
  assert.equal(report.decide.fsyncsPerOp, 4);
  for (const key of ['cold', 'hit', 'rules', 'decide', 'burst4']) assert.ok(report[key].ms.p50 >= 0, key);
});

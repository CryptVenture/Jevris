#!/usr/bin/env node
/**
 * The decision engine's own overhead, with the network taken out (opt-in, `npm run bench:engine`;
 * npm test never collects it).
 *
 * It builds the sidecar's engine (`createSidecarEngine`: journal, budget file and circuit file under
 * a temporary home on the real disk, the production SDK transport) over a conformance-mock `fetch`
 * that answers at once, so what is measured is Jevris's own work around a Jev call: building and
 * validating the request, the budget reservation and settlement, the decision journal and the record.
 * Every durable write is an fsync, so the number of fsyncs is reported beside the time: it is the
 * cost that does not shrink with a faster CPU.
 *
 *   cold      a slice classification of features the engine has not seen: a reservation, the call,
 *             a commit, the decision record, then the advisory record of the classification
 *   hit       the same features again: the decision cache answers, the records are still written
 *   rules     a classification the rules settle (no call): the advisory record only
 *   decide    one bounded decision straight through `engine.decide`, cold
 *   burst     four classifications at once, cold (the fsyncs of one decision queue behind the others)
 *
 *   node apps/sidecar/scripts/engine-overhead.mjs [--n 60] [--seed-reservations 0] [--json] [--out <file>]
 *
 * The temporary home is removed afterwards. No credential is read, nothing leaves the machine.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const repoModule = (...parts) => import(pathToFileURL(join(repoRoot, ...parts)).href);

export function summarize(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
  const round = (x) => Math.round(x * 10) / 10;
  return { n: sorted.length, min: round(sorted[0]), p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted[sorted.length - 1]) };
}

export function parseArgs(argv) {
  const out = { n: 60, seedReservations: 0, json: false, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[(i += 1)];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === '--n') out.n = Number(next());
    else if (arg === '--seed-reservations') out.seedReservations = Number(next());
    else if (arg === '--json') out.json = true;
    else if (arg === '--out') out.out = next();
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!Number.isInteger(out.n) || out.n < 1 || out.n > 1000) throw new Error('--n must be 1 to 1000');
  if (!Number.isInteger(out.seedReservations) || out.seedReservations < 0 || out.seedReservations > 200_000) throw new Error('--seed-reservations must be 0 to 200000');
  return out;
}

/** Counts and times every fsync the process makes through `fs/promises` file handles. */
async function countFsyncs() {
  const probe = await open(join(tmpdir(), `.fsync-probe-${process.pid}`), 'w');
  const proto = Object.getPrototypeOf(probe);
  await probe.close();
  rmSync(join(tmpdir(), `.fsync-probe-${process.pid}`), { force: true });
  const original = proto.sync;
  const stats = { count: 0, totalMs: 0 };
  proto.sync = async function patched(...args) {
    const started = performance.now();
    try {
      return await original.apply(this, args);
    } finally {
      stats.count += 1;
      stats.totalMs += performance.now() - started;
    }
  };
  return { stats, restore: () => { proto.sync = original; } };
}

/** Distinct content-free features for each i: the packet the engine hashes carries counts, not names, so the counts must differ. */
function features(i) {
  const source = 1 + (i % 7);
  const tests = Math.floor(i / 7) % 6;
  const config = Math.floor(i / 42) % 5;
  const other = Math.floor(i / 210) % 4;
  const paths = [
    ...Array.from({ length: source }, (_, k) => `src/m${k}.ts`),
    ...Array.from({ length: tests }, (_, k) => `test/t${k}.test.ts`),
    ...Array.from({ length: config }, (_, k) => `conf/c${k}.json`),
    ...Array.from({ length: other }, (_, k) => `assets/a${k}.png`),
  ];
  return { title: `Fix the intermittent failure in the parser`, paths, checkIds: Math.floor(i / 840) % 2 === 0 ? ['unit-tests'] : [] };
}

async function series(count, fn, fsyncs) {
  const times = [];
  const before = { ...fsyncs.stats };
  for (let i = 0; i < count; i += 1) {
    const started = performance.now();
    await fn(i);
    times.push(performance.now() - started);
  }
  return { ms: summarize(times), fsyncsPerOp: Math.round(((fsyncs.stats.count - before.count) / count) * 10) / 10, fsyncMsPerOp: Math.round(((fsyncs.stats.totalMs - before.totalMs) / count) * 10) / 10 };
}

export async function measure({ n = 60, seedReservations = 0 } = {}) {
  const core = await repoModule('packages', 'core', 'dist', 'index.js');
  const provider = await repoModule('packages', 'provider-typesafe', 'dist', 'index.js');
  const { jevrisPaths } = await repoModule('packages', 'platform', 'dist', 'index.js');
  const home = mkdtempSync(join(tmpdir(), 'jevris-engine-overhead-'));
  const fsyncs = await countFsyncs();
  try {
    const paths = jevrisPaths({ home });
    for (const dir of [paths.data, paths.state, paths.config]) mkdirSync(dir, { recursive: true });
    if (seedReservations > 0) {
      const now = Date.now();
      const period = new Date(now).toISOString().slice(0, 7);
      const reservations = Array.from({ length: seedReservations }, (_, i) => ({ id: `r-seed-${i}`, decisionId: `d-seed-${i}`, workspaceId: 'w-seed', period, reservedMicroUsd: 40, state: 'committed', actualMicroUsd: 21, usage: { inputTokens: 500, outputTokens: 20 }, source: 'provider-usage', createdAtMs: now, updatedAtMs: now }));
      writeFileSync(join(paths.data, 'decision-budget.json'), `${JSON.stringify({ schemaVersion: 'jevris-decision-budget-1', reservations })}\n`);
    }
    const fetch = provider.createMockFetch({ scenario: 'valid' });
    // A long lock wait: four decisions at once reserve under the budget file's lock, and a slow disk must not turn that into a fall back to the rules.
    const engine = await provider.createSidecarEngine({ home, credential: 'stub-credential-not-a-secret', fetch, budgetLimitMicroUsd: 50_000_000, budgetLockTimeoutMs: 120_000, sourceEgress: () => ({ provenance: 'administrator', sourceEgress: 'deny-until-approved' }) });
    const ctx = { workspaceId: 'w-bench', evidenceRevision: 'r1', deadlineMs: 30_000 };
    const classify = (hints) => core.classifyTaskSlice(engine, hints, ctx, { assist: 'classify', record: true });
    // Warm the code paths (the first call compiles them and builds the first client).
    for (let i = 0; i < 5; i += 1) await classify(features(10_000 + i));
    const result = {};
    result.cold = await series(n, (i) => classify(features(i)), fsyncs);
    result.hit = await series(n, (i) => classify(features(i)), fsyncs);
    result.rules = await series(n, (i) => classify({ title: 'Update the guide', paths: [`docs/guide${i}.md`], checkIds: [] }), fsyncs);
    const spec = core.SLICE_CLASSIFY_SPEC_ID;
    void spec;
    // A bounded decision straight through the engine (no advisory record of a classification).
    const questions = core.sliceQuestions();
    const compiled = core.compileDecisionSpec({ id: 'engine-overhead-probe', version: 'v1', questions, evidenceRequirements: [], deadlineMs: 30_000, fallback: 'rules-only' });
    if (!compiled.ok) throw new Error('the probe spec did not compile');
    const decideOnce = (i) =>
      engine.decide({ spec: compiled.spec, questions, workspaceId: 'w-bench', evidenceRevision: 'r1', packet: { objective: 'Classify the kind and the risk of a coding task from its structured features (advice only).', trustedPolicy: {}, facts: { files: i, kind: 'probe' }, evidence: [], missingEvidence: [] } });
    result.decide = await series(n, decideOnce, fsyncs);
    const bursts = [];
    const burstStart = { ...fsyncs.stats };
    const rounds = Math.max(3, Math.floor(n / 6));
    for (let round = 0; round < rounds; round += 1) {
      const started = performance.now();
      await Promise.all([0, 1, 2, 3].map((k) => classify(features(5000 + round * 4 + k))));
      bursts.push(performance.now() - started);
    }
    result.burst4 = { ms: summarize(bursts), fsyncsPerOp: Math.round(((fsyncs.stats.count - burstStart.count) / (rounds * 4)) * 10) / 10 };
    result.budgetFileBytes = statSync(join(paths.data, 'decision-budget.json')).size;
    result.providerCalls = fetch.calls;
    return { schemaVersion: 'jevris-engine-overhead-1', node: process.version, platform: process.platform, n, seedReservations, ...result };
  } finally {
    fsyncs.restore();
    rmSync(home, { recursive: true, force: true });
  }
}

function render(report) {
  const lines = [`engine overhead (no network), n=${report.n}, ${report.seedReservations} seeded budget entries, node ${report.node} ${report.platform}`];
  for (const key of ['cold', 'hit', 'rules', 'decide', 'burst4']) {
    const row = report[key];
    const ms = row.ms;
    lines.push(`${key.padEnd(7)} p50 ${String(ms.p50).padStart(7)} ms  p95 ${String(ms.p95).padStart(7)} ms  min ${String(ms.min).padStart(7)} ms  fsyncs/op ${row.fsyncsPerOp}${row.fsyncMsPerOp === undefined ? '' : `  (${row.fsyncMsPerOp} ms of them in fsync)`}`);
  }
  lines.push(`budget file ${report.budgetFileBytes} bytes after the run; ${report.providerCalls} stub provider calls`);
  return lines.join('\n');
}

async function main(argv) {
  const args = parseArgs(argv);
  const report = await measure({ n: args.n, seedReservations: args.seedReservations });
  if (args.out !== null) writeFileSync(args.out, `${JSON.stringify(report, null, 1)}\n`);
  process.stdout.write(`${args.json ? JSON.stringify(report, null, 1) : render(report)}\n`);
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`engine-overhead: ${error instanceof Error ? error.message : 'failed'}\n`);
    process.exit(1);
  });
}

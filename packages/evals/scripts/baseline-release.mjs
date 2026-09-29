#!/usr/bin/env node
/**
 * The signed baseline release (C16; SSOT §18.3 and §18.5 as amended at 6d7222a).
 *
 *   node packages/evals/scripts/baseline-release.mjs build --seed-dir <dir> --out <dir> --id <id> --expires <ISO date>
 *       [--slice <local-slice>=<prior-slice> ...]
 *   node packages/evals/scripts/baseline-release.mjs sign --proposal <out>/baseline-proposal.json \
 *       --key <private-key.pem> --key-id <id> --reviewer <id> --out <dir>
 *
 * - `build` reads the seed's `seed-priors.json` (from `seed-run.mjs priors`). When the seed
 *   directory also has runs.jsonl and selection.json, it checks the priors' hashes against them.
 *   It adds the bundled published rows (`BUNDLED_PUBLIC_PRIORS`), binds the release to the
 *   worker-readiness decision (`workerCalibrationContext`) and writes baseline-proposal.json, a
 *   draft. It prints which rows went in and which were left out, and why.
 * - `sign` is the only step that releases it: a named reviewer and the calibration signing key,
 *   through `releaseProposal`. It writes calibration-release.json, to install in the Jevris
 *   config folder (`jevris doctor` shows it), and the release-evidence check reads.
 * No harness, no network and no billing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function args() {
  const out = { _: [], slice: [] };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--slice') out.slice.push(argv[++i] ?? '');
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i] ?? '';
    else out._.push(a);
  }
  return out;
}

function fail(message, code = 1) {
  process.stderr.write(`baseline-release: ${message}\n`);
  process.exit(code);
}

function readJsonLines(file) {
  const text = readFileSync(file, 'utf8').trim();
  return text === '' ? [] : text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

const USAGE = 'usage: baseline-release.mjs build --seed-dir <dir> --out <dir> --id <id> --expires <ISO> | sign --proposal <file> --key <pem> --key-id <id> --reviewer <id> --out <dir>';
const opts = args();
const command = opts._[0];
if (typeof opts.out !== 'string' || opts.out === '') fail(USAGE, 2);
const out = resolve(opts.out);
const evals = await import('../dist/index.js');

if (command === 'build') {
  for (const k of ['seed-dir', 'id', 'expires']) if (typeof opts[k] !== 'string' || opts[k] === '') fail(`build needs --${k}`, 2);
  const core = await import('@jevris/core').catch(() => null);
  if (core === null) fail('@jevris/core is not built in this checkout; run npm run build first', 3);
  const seedDir = resolve(opts['seed-dir']);
  const seed = JSON.parse(readFileSync(join(seedDir, 'seed-priors.json'), 'utf8'));
  if (!Array.isArray(seed)) fail('seed-priors.json is not a list', 2);
  if (existsSync(join(seedDir, 'runs.jsonl'))) {
    const runsHash = evals.seedRunsHash(readJsonLines(join(seedDir, 'runs.jsonl')));
    if (seed.some((p) => p.runsHash !== runsHash)) fail('seed-priors.json does not match runs.jsonl (runsHash); run seed-run.mjs priors again', 3);
  }
  if (existsSync(join(seedDir, 'selection.json'))) {
    const selection = JSON.parse(readFileSync(join(seedDir, 'selection.json'), 'utf8'));
    if (!evals.selectionValid(selection)) fail('selection.json does not match its hash', 3);
    if (seed.some((p) => p.selectionHash !== selection.selectionHash)) fail('seed-priors.json does not name this selection (selectionHash); run seed-run.mjs priors again', 3);
  }
  const sliceMap = {};
  for (const pair of opts.slice) {
    const at = pair.indexOf('=');
    if (at < 1) fail('--slice takes <local-slice>=<prior-slice>', 2);
    sliceMap[pair.slice(at + 1)] = pair.slice(0, at);
  }
  const issuedAt = new Date().toISOString();
  const expires = Date.parse(opts.expires);
  if (!Number.isFinite(expires)) fail('--expires is not a date', 2);
  const context = core.workerCalibrationContext({ sliceId: '-', nowMs: Date.now() });
  const result = evals.proposeBaselineRelease({
    id: opts.id,
    issuedAt,
    expiresAt: new Date(expires).toISOString(),
    context: {
      decisionSpecId: context.decisionSpecId,
      decisionSpecVersion: context.decisionSpecVersion,
      questionHash: context.questionHash,
      model: { modelId: context.modelId, revisionHash: context.modelRevisionHash },
      encoderHash: context.encoderHash,
    },
    published: core.BUNDLED_PUBLIC_PRIORS,
    seed,
    defaultEffort: (modelId) => core.registryModel(core.BUNDLED_MODEL_REGISTRY, modelId)?.defaultEffort ?? null,
    sliceMap,
  });
  if (!result.ok) fail(`no baseline proposal: ${result.reasonCode}`);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  writeFileSync(join(out, 'baseline-proposal.json'), `${JSON.stringify(result.proposal, null, 2)}\n`);
  const lines = [`draft ${result.proposal.id} written to ${join(out, 'baseline-proposal.json')}`, 'in:'];
  for (const q of result.proposal.modelQualities) lines.push(`  ${q.sliceId} ${q.modelId} at ${q.effort}: ${q.point} [${q.lower}, ${q.upper}] over ${q.sampleSize}`);
  lines.push('sources:');
  for (const s of result.report.included) lines.push(`  ${s.kind} ${s.sourceId} ${s.modelId} at ${s.effort}: ${s.successes}/${s.trials} (${s.benchmark}, ${s.publishedOn})`);
  lines.push('left out:');
  for (const x of result.report.excluded) lines.push(`  ${x.sourceId} ${x.priorSliceId} ${x.modelId} at ${x.effort}: ${x.reasonCode}`);
  lines.push('review it, then sign it with the calibration key: baseline-release.mjs sign');
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(0);
}

if (command === 'sign') {
  for (const k of ['proposal', 'key', 'key-id', 'reviewer']) if (typeof opts[k] !== 'string' || opts[k] === '') fail(`sign needs --${k}`, 2);
  const proposal = JSON.parse(readFileSync(resolve(opts.proposal), 'utf8'));
  if (proposal?.uncertaintyInterval?.method !== 'beta-posterior') fail('the proposal is not a beta-posterior baseline', 2);
  const released = evals.releaseProposal(
    proposal,
    { reviewerId: opts.reviewer, reviewedAt: new Date().toISOString(), approved: true },
    { privateKeyPem: readFileSync(resolve(opts.key), 'utf8'), keyId: opts['key-id'] },
  );
  if (!released.ok) fail(`not released: ${released.reasonCode}`);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const file = join(out, 'calibration-release.json');
  writeFileSync(file, `${JSON.stringify(released.artifact, null, 2)}\n`);
  process.stdout.write(`${file}\nsigned by ${opts['key-id']}; the key must be listed with role calibration in the trusted release keys\n`);
  process.exit(0);
}

fail(USAGE, 2);

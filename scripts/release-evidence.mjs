#!/usr/bin/env node
/**
 * Signed release evidence that people, not CI, produce (RLS-05, RLS-07, RLS-08, §22.2).
 * One command per record. Each writes one validated `jevris.evidence/1` record into --out
 * (default release-evidence/) and checks its signature against the key it was signed with.
 *
 *   node scripts/release-evidence.mjs keygen --role owner --key-id owner-2026 --out keys/
 *       Ed25519 key pair: <key-id>.pem (private, owner-only) and the trust entry to add to
 *       assets/trust/release-keys.json in a reviewed commit. Roles: owner, security-reviewer,
 *       certification, calibration. `--add-trust` appends the entry to that file for you to review.
 *
 *   node scripts/release-evidence.mjs p0-register --answers p0.json --key owner.pem --key-id owner-2026
 *       The owner's answers to the seven chapter 21 questions and the procurement status
 *       (RLS-05). p0.json is the payload: { questions: [{ id, answer, decidedBy, decidedAt }],
 *       procurement: { status, retention, trainingUse, region, subprocessors } }.
 *
 *   node scripts/release-evidence.mjs security-review --review review.json --report report.pdf \
 *       --key reviewer.pem --key-id reviewer-2026
 *       The independent reviewer's record (RLS-07). review.json holds { reviewer: { name,
 *       organization, independent }, reportLocation, scope: [...], findings: [{ id, severity,
 *       status }] }; the report's sha256 and the reviewed version are filled in.
 *
 *   node scripts/release-evidence.mjs pre-registration --input prereg.json --key owner.pem --key-id owner-2026
 *       The owner-signed trial pre-registration (EVL-12, RLS-08) through @jevris/evals.
 *
 *   node scripts/release-evidence.mjs quality-trial --trial trial.json --pre-registration pre-registration.json \
 *       --protocol protocol.json --holdout holdout.json --corpus corpus.json [--seed <n>]
 *       The quality-trial record (RLS-08) from a saved EVL-05 TrialResult (runTrial output): the
 *       jev-routed arm against rules-only, bound to the signed pre-registration, which must be
 *       locked before the trial started. protocol.json is the EvaluationProtocol without its
 *       preRegistrationHash, holdout.json the HoldoutManifest, corpus.json the CorpusRow list.
 *
 *   node scripts/release-evidence.mjs quality-trial --run-config trial-config.json --tasks tasks.json \
 *       --sandbox-dir <dir> [--fixture <repo dir>] --pre-registration ... --protocol ... --holdout ... --corpus ...
 *       Runs the EVL-05 trial first with the product harness driver (F's productTrialDriver over a
 *       jevris.trial-config/1 file; tasks.json is the TrialTask list), writes trial.json and
 *       trial-runs.jsonl (one note per run) to --out, then makes the record as above. It runs real
 *       harness sessions, so it needs JEVRIS_LIVE_HARNESS=1 (and JEVRIS_LIVE_JEV=1 for the Jev
 *       arms); without them the driver refuses and nothing starts.
 *
 *   node scripts/release-evidence.mjs economics --seed-dir <dir> --drills drills.json --key owner.pem --key-id owner-2026
 *       The owner-signed economics-report record (RLS-09) from the 24-run seed (owner decision,
 *       DOMAINS 2d1c6a0): seed-run.mjs economics writes <dir>/seed-economics.json, the baseline and
 *       the candidate on the same tasks. The record carries full cost and wall time per verified
 *       task with paired-bootstrap ratio intervals, the sample (plan, selection and run-record
 *       hashes, tasks, runs, cost bases) and the pack disable drills ([{ packId, disabled,
 *       independent, passed }]). The run records in <dir>/runs.jsonl must match the file's hash.
 *
 *   node scripts/release-evidence.mjs baseline --release calibration-release.json [--seed-dir <dir>]
 *       The baseline-release record (§18.3, §22.2 as amended at 6d7222a) around the signed
 *       beta-posterior baseline that packages/evals/scripts/baseline-release.mjs sign wrote. With
 *       --seed-dir, the release's seed sources must name that seed's selection and run records.
 *
 *   node scripts/release-evidence.mjs calibration --proposal proposal.json --calibration cases.jsonl \
 *       --holdout-cases holdout.jsonl --reviewer <id> --key reviewer.pem --key-id reviewer-2026
 *       The reviewer-signed calibration release (RLS-11). proposal.json holds id, decisionSpecId,
 *       decisionSpecVersion, dataset, questionHash, model, encoderHash, errorBudget,
 *       minimumSliceSamples and expiresAt; each JSONL line is { sliceId, probability, outcome }.
 *       Writes calibration-release.json for the host's Jevris config folder.
 *
 *   node scripts/release-evidence.mjs check <record.json>
 *       Validates a record and verifies its signature against assets/trust/release-keys.json.
 *
 * Nothing here publishes, uploads or reads a secret from the environment. A private key is
 * read only from the file named with --key.
 */
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
export const ROLES = ['owner', 'security-reviewer', 'certification', 'calibration'];
const TRUST_FILE = join(repoRoot, 'assets', 'trust', 'release-keys.json');

async function load(pkg) {
  const entry = join(repoRoot, 'packages', pkg, 'dist', 'index.js');
  if (!existsSync(entry)) throw new UsageError('run npm run build first');
  return import(pathToFileURL(entry).href);
}

export class UsageError extends Error {}

export const COMMANDS = ['keygen', 'p0-register', 'security-review', 'pre-registration', 'quality-trial', 'economics', 'baseline', 'calibration', 'check'];

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, positional: [], out: join(repoRoot, 'release-evidence'), addTrust: false };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const value = () => {
      const next = rest[++i];
      if (next === undefined) throw new UsageError(`${arg} needs a value`);
      return next;
    };
    if (arg === '--out') options.out = resolve(value());
    else if (arg === '--role') options.role = value();
    else if (arg === '--key-id') options.keyId = value();
    else if (arg === '--key') options.key = resolve(value());
    else if (arg === '--answers') options.answers = resolve(value());
    else if (arg === '--review') options.review = resolve(value());
    else if (arg === '--report') options.report = resolve(value());
    else if (arg === '--input') options.input = resolve(value());
    else if (arg === '--version') options.version = value();
    else if (arg === '--commit') options.commit = value();
    else if (arg === '--trial') options.trial = resolve(value());
    else if (arg === '--run-config') options.runConfig = resolve(value());
    else if (arg === '--tasks') options.tasks = resolve(value());
    else if (arg === '--sandbox-dir') options.sandboxDir = resolve(value());
    else if (arg === '--fixture') options.fixture = resolve(value());
    else if (arg === '--pre-registration') options.preRegistration = resolve(value());
    else if (arg === '--protocol') options.protocol = resolve(value());
    else if (arg === '--holdout') options.holdout = resolve(value());
    else if (arg === '--corpus') options.corpus = resolve(value());
    else if (arg === '--drills') options.drills = resolve(value());
    else if (arg === '--proposal') options.proposal = resolve(value());
    else if (arg === '--calibration') options.calibration = resolve(value());
    else if (arg === '--holdout-cases') options.holdoutCases = resolve(value());
    else if (arg === '--reviewer') options.reviewer = value();
    else if (arg === '--seed-dir') options.seedDir = resolve(value());
    else if (arg === '--release') options.release = resolve(value());
    else if (arg === '--seed') {
      options.seed = Number(value());
      if (!Number.isSafeInteger(options.seed)) throw new UsageError('--seed must be an integer');
    } else if (arg === '--add-trust') options.addTrust = true;
    else if (arg.startsWith('--')) throw new UsageError(`unknown option ${arg}`);
    else options.positional.push(arg);
  }
  if (!COMMANDS.includes(command)) throw new UsageError(`commands: ${COMMANDS.join(', ')}`);
  if (command === 'keygen' && !ROLES.includes(options.role)) throw new UsageError(`--role must be one of ${ROLES.join(', ')}`);
  if (['keygen', 'p0-register', 'security-review', 'pre-registration', 'calibration', 'economics'].includes(command) && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.keyId ?? '')) throw new UsageError('--key-id is required: letters, digits, ".", "_" and "-"');
  if (['p0-register', 'security-review', 'pre-registration', 'calibration', 'economics'].includes(command) && options.key === undefined) throw new UsageError('--key <private key PEM> is required');
  if (command === 'quality-trial' && [options.preRegistration, options.protocol, options.holdout, options.corpus].includes(undefined)) throw new UsageError('--pre-registration, --protocol, --holdout and --corpus are required');
  if (command === 'quality-trial' && (options.trial === undefined) === (options.runConfig === undefined)) throw new UsageError('give either --trial <saved trial.json> or --run-config <trial-config.json> to run it');
  if (options.runConfig !== undefined && (options.tasks === undefined || options.sandboxDir === undefined)) throw new UsageError('--run-config needs --tasks and --sandbox-dir');
  if (command === 'economics' && (options.seedDir === undefined || options.drills === undefined)) throw new UsageError('--seed-dir and --drills are required (the economics come from the seed run)');
  if (command === 'baseline' && options.release === undefined) throw new UsageError('--release <calibration-release.json> is required');
  if (command === 'calibration' && [options.proposal, options.calibration, options.holdoutCases, options.reviewer].includes(undefined)) throw new UsageError('--proposal, --calibration, --holdout-cases and --reviewer are required');
  if (command === 'p0-register' && options.answers === undefined) throw new UsageError('--answers <file> is required');
  if (command === 'security-review' && (options.review === undefined || options.report === undefined)) throw new UsageError('--review <file> and --report <file> are required');
  if (command === 'pre-registration' && options.input === undefined) throw new UsageError('--input <file> is required');
  if (command === 'check' && options.positional.length !== 1) throw new UsageError('check takes one record file');
  return options;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new UsageError(`${file}: ${error.message}`);
  }
}

/** One JSON object per non-blank line. */
export function readJsonLines(file) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new UsageError(`${file}:${index + 1}: ${error.message}`);
    }
  });
}

function headCommit() {
  const run = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : null;
}

/** The subject, producer and environment every record here carries. */
export function meta(options, kind, nowIso = new Date().toISOString()) {
  const version = options.version ?? JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
  const commit = options.commit ?? headCommit();
  return {
    id: `${kind}-${version}-${nowIso.replace(/[^0-9]/g, '').slice(0, 14)}`,
    producedAt: nowIso,
    version,
    commit,
    tool: 'release-evidence',
    run: null,
    os: ['darwin', 'linux', 'win32'].includes(process.platform) ? process.platform : null,
    arch: arch(),
    node: process.version,
  };
}

function trustedMap(role, extra) {
  const map = new Map();
  try {
    for (const key of JSON.parse(readFileSync(TRUST_FILE, 'utf8')).keys ?? []) if (key.role === role) map.set(key.keyId, key.publicKeyPem);
  } catch {
    // an unreadable trust file trusts nothing
  }
  if (extra !== undefined) map.set(extra.keyId, extra.publicKeyPem);
  return map;
}

async function finish(record, options, role, contracts) {
  const checked = contracts.ReleaseEvidenceContract.validate(record);
  if (!checked.ok) throw new UsageError(`the record does not pass its contract: ${JSON.stringify(checked.issues?.slice(0, 3) ?? checked)}`);
  const { createPublicKey } = await import('node:crypto');
  const publicKeyPem = createPublicKey(readFileSync(options.key, 'utf8')).export({ type: 'spki', format: 'pem' }).toString();
  const self = contracts.verifyRecordSignature(record, new Map([[options.keyId, publicKeyPem]]));
  if (!self.ok) throw new UsageError(`the signature does not verify: ${self.reasonCode}`);
  const trusted = contracts.verifyRecordSignature(record, trustedMap(role));
  mkdirSync(options.out, { recursive: true });
  const file = join(options.out, `${record.kind}.json`);
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`wrote ${file}`);
  const article = role === 'owner' ? 'an' : 'a';
  console.log(trusted.ok ? `signed by ${options.keyId}, a trusted ${role} key` : `signed by ${options.keyId}; this key is not in assets/trust/release-keys.json as ${article} ${role} key, so the gates exclude the record until it is added`);
  return file;
}

/** An unsigned record: validated against its contract, then written. The gates bind it by version and hash. */
function finishUnsigned(record, options, contracts) {
  const checked = contracts.ReleaseEvidenceContract.validate(record);
  if (!checked.ok) throw new UsageError(`the record does not pass its contract: ${JSON.stringify(checked.issues?.slice(0, 3) ?? checked)}`);
  mkdirSync(options.out, { recursive: true });
  const file = join(options.out, `${record.kind}.json`);
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`wrote ${file}`);
  return file;
}

/** The saved TrialResult (runTrial output) and the arm comparison the gates read. */
/**
 * Runs the trial with the product harness driver and saves it, so the record is made from the
 * same trial.json a later economics run reads. Refuses, starting nothing, when the driver cannot
 * run every required arm (live gates unset, unsupported arm, a task without a spec).
 */
async function runProductTrial(options, evals, preRegistration) {
  const { parseTrialConfig } = await import(pathToFileURL(join(repoRoot, 'apps', 'cli', 'dist', 'trial-driver.js')).href);
  const { productTrialDriver } = await import(pathToFileURL(join(repoRoot, 'apps', 'cli', 'dist', 'trial-jevris.js')).href);
  const parsed = parseTrialConfig(readJson(options.runConfig));
  if (!parsed.ok) throw new UsageError(`the trial config is not valid:\n  ${parsed.problems.join('\n  ')}`);
  const tasks = readJson(options.tasks);
  if (!Array.isArray(tasks) || tasks.length === 0) throw new UsageError(`${options.tasks} must be a non-empty list of { taskId, repository, sliceId, difficulty }`);
  const arms = [...evals.REQUIRED_ARMS];
  const notes = [];
  const made = productTrialDriver({ config: parsed.config, tasks, arms, root: repoRoot, onRun: (note) => notes.push(note) });
  if (!made.ok) throw new UsageError(`the product harness driver cannot run this trial:\n  ${made.problems.join('\n  ')}`);
  mkdirSync(options.sandboxDir, { recursive: true });
  const trial = await evals.runTrial({
    tasks,
    arms,
    driver: made.driver,
    sandboxes: evals.directorySandboxes(options.sandboxDir, options.fixture ?? null),
    preRegistrationLockedAt: String(preRegistration.payload.lockedAt),
    seed: options.seed ?? 5,
    now: Date.now,
  });
  if (trial.ok !== true) throw new UsageError(`the trial did not run: ${trial.reasonCode}${trial.detail === undefined ? '' : ` (${trial.detail})`}`);
  mkdirSync(options.out, { recursive: true });
  options.trial = join(options.out, 'trial.json');
  writeFileSync(options.trial, `${JSON.stringify(trial)}\n`);
  writeFileSync(join(options.out, 'trial-runs.jsonl'), notes.map((note) => JSON.stringify(note)).join('\n') + (notes.length > 0 ? '\n' : ''));
  console.log(`ran ${trial.rows.length} runs; wrote ${options.trial} and trial-runs.jsonl`);
}

function trialComparison(options, evals) {
  const trial = readJson(options.trial);
  if (trial?.ok !== true || !Array.isArray(trial.rows)) throw new UsageError(`${options.trial} is not a completed TrialResult (ok: true with rows)`);
  const comparison = evals.compareArms(trial.rows, 'jev-routed', 'rules-only', { resamples: 1000, seed: options.seed ?? 5 });
  return { trial, comparison };
}

/** The seed's run records, and the checks that tie seed-economics.json and selection.json to them. */
function seedRecords(dir, evals) {
  const runsFile = join(dir, 'runs.jsonl');
  if (!existsSync(runsFile)) throw new UsageError(`${runsFile} is missing: the seed's run records`);
  const records = readJsonLines(runsFile);
  const runsHash = evals.seedRunsHash(records);
  const selectionFile = join(dir, 'selection.json');
  const selection = existsSync(selectionFile) ? readJson(selectionFile) : null;
  if (selection !== null && !evals.selectionValid(selection)) throw new UsageError(`${selectionFile} does not match its own selectionHash`);
  return { records, runsHash, selectionHash: selection === null ? null : selection.selectionHash };
}

const SEED_BOOTSTRAP = { confidence: 0.95, resamples: 2000, seed: 20260926 };

/**
 * The economics-report from the seed (owner decision, DOMAINS 2d1c6a0): the candidate arm against
 * the baseline arm on the same tasks, full cost and wall time per verified task. Components:
 * every recorded run counts, capped ones included (retries); cache reads and writes are priced
 * in each run's cost (cache); the runs are unattended (human minutes are zero); verification is
 * the benchmark's own harness, which uses no model and is the same for both arms (verification).
 */
export function seedEconomicsRecord(options, evals, contracts) {
  const file = join(options.seedDir, 'seed-economics.json');
  if (!existsSync(file)) throw new UsageError(`${file} is missing: run node packages/evals/scripts/seed-run.mjs economics --out ${options.seedDir} --report <model>=<report.json> ... first`);
  const economics = readJson(file);
  const seed = seedRecords(options.seedDir, evals);
  if (economics.runsHash !== seed.runsHash) throw new UsageError(`${file} was computed from other run records than ${join(options.seedDir, 'runs.jsonl')} (runsHash differs)`);
  if (seed.selectionHash !== null && economics.selectionHash !== seed.selectionHash) throw new UsageError(`${file} names another task selection than selection.json`);
  if (typeof economics.selectionHash !== 'string') throw new UsageError(`${file} has no selectionHash: keep selection.json in the seed folder`);
  const pairs = Array.isArray(economics.pairs) ? economics.pairs : [];
  const rows = [];
  for (const pair of pairs) {
    for (const [arm, run] of [['candidate', pair.candidate], ['baseline', pair.baseline]]) {
      if (run?.verified === null || run?.verified === undefined) throw new UsageError(`${file}: ${pair.instanceId} has no evaluation result; pass each model's --report to seed-run.mjs economics`);
      if (typeof run.usd !== 'number') throw new UsageError(`${file}: ${pair.instanceId} (${arm}) has no cost; the run recorded neither a charge nor an estimate`);
      rows.push({ taskId: pair.instanceId, arm, verified: run.verified === true, costMicroUsd: Math.round(run.usd * 1e6), wallMs: run.durationMs });
    }
  }
  if (pairs.length === 0) throw new UsageError(`${file} has no paired tasks`);
  const comparison = evals.compareArms(rows, 'candidate', 'baseline', SEED_BOOTSTRAP);
  if (comparison.costPerVerifiedRatio === null) throw new UsageError('no cost interval: an arm verified no task in the seed');
  if (comparison.timePerVerifiedRatio === null) throw new UsageError('no time interval: an arm verified no task in the seed');
  const perVerified = (arm) => {
    const own = rows.filter((row) => row.arm === arm);
    const statistic = (sample) => {
      const ok = sample.filter((row) => row.verified).length;
      return ok === 0 ? Number.POSITIVE_INFINITY : sample.reduce((sum, row) => sum + row.costMicroUsd, 0) / ok;
    };
    const value = evals.bootstrapInterval(own, statistic, SEED_BOOTSTRAP);
    const round = (x) => (Number.isFinite(x) ? Math.round(x) : -1);
    return { point: round(value.point), lower: round(value.lower), upper: round(value.upper) };
  };
  const drills = readJson(options.drills);
  if (!Array.isArray(drills)) throw new UsageError(`${options.drills} must be a list of { packId, disabled, independent, passed }`);
  const bases = [...new Set(pairs.flatMap((pair) => [pair.baseline.costBasis, pair.candidate.costBasis]).filter((basis) => basis === 'reported' || basis === 'list-price-estimate'))].sort();
  const payload = {
    tasks: comparison.tasks,
    costPerVerifiedTask: { treatment: perVerified('candidate'), baseline: perVerified('baseline'), ratio: comparison.costPerVerifiedRatio },
    timePerVerifiedTask: { ratio: comparison.timePerVerifiedRatio },
    includes: ['retries', 'cache', 'verification', 'human-minutes'],
    packDisableDrills: drills.map((d) => ({ packId: d.packId, disabled: d.disabled, independent: d.independent, passed: d.passed })),
    sample: {
      source: 'seed-run',
      planId: economics.planId,
      selectionHash: economics.selectionHash,
      runsHash: economics.runsHash,
      tasks: comparison.tasks,
      runs: seed.records.length,
      baseline: { modelId: economics.baseline.modelId, effort: economics.baseline.effort },
      candidate: { modelId: economics.candidate.modelId, effort: economics.candidate.effort },
      costBases: bases,
      confidence: SEED_BOOTSTRAP.confidence,
    },
  };
  return contracts.releaseEvidence({ kind: 'economics-report', ...meta(options, 'economics-report'), payload });
}

/** The baseline-release record: the signed beta-posterior baseline, optionally tied to its seed folder. */
export function baselineRecord(options, evals, contracts) {
  const artifact = readJson(options.release);
  const checked = contracts.CalibrationArtifactContract.validate(artifact);
  if (!checked.ok) throw new UsageError(`${options.release} is not a valid calibration release: ${JSON.stringify(checked.issues?.slice(0, 3) ?? checked)}`);
  if (artifact.uncertaintyInterval.method !== 'beta-posterior') throw new UsageError(`${options.release} is a ${artifact.uncertaintyInterval.method} calibration release, not the beta-posterior baseline`);
  if (artifact.releaseState !== 'released') throw new UsageError(`${options.release} is a draft: sign it with packages/evals/scripts/baseline-release.mjs sign`);
  if (options.seedDir !== undefined) {
    const seed = seedRecords(options.seedDir, evals);
    const seeds = artifact.baselineSources.filter((source) => source.kind === 'seed');
    if (seeds.length === 0) throw new UsageError(`${options.release} has no seed source`);
    for (const source of seeds) {
      if (source.runsHash !== seed.runsHash) throw new UsageError(`the seed source ${source.sourceId} (${source.modelId}) names other run records than ${join(options.seedDir, 'runs.jsonl')}`);
      if (seed.selectionHash !== null && source.selectionHash !== seed.selectionHash) throw new UsageError(`the seed source ${source.sourceId} (${source.modelId}) names another task selection than selection.json`);
    }
  }
  return contracts.releaseEvidence({ kind: 'baseline-release', ...meta(options, 'baseline-release'), payload: artifact });
}

async function run(options) {
  const contracts = await load('contracts');
  if (options.command === 'keygen') {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    mkdirSync(options.out, { recursive: true });
    const file = join(options.out, `${options.keyId}.pem`);
    if (existsSync(file)) throw new UsageError(`${file} exists; choose another --key-id`);
    writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), { mode: 0o600 });
    if (process.platform !== 'win32') chmodSync(file, 0o600);
    const entry = { keyId: options.keyId, role: options.role, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
    console.log(`private key: ${file} (keep it offline; never commit it)`);
    if (options.addTrust) {
      const trust = JSON.parse(readFileSync(TRUST_FILE, 'utf8'));
      if (trust.keys.some((key) => key.keyId === entry.keyId)) throw new UsageError(`${entry.keyId} is already in the trust file`);
      trust.keys.push(entry);
      writeFileSync(TRUST_FILE, `${JSON.stringify(trust, null, 2)}\n`);
      console.log(`added ${entry.keyId} (${entry.role}) to assets/trust/release-keys.json; commit it in a reviewed change`);
    } else console.log(`trust entry for assets/trust/release-keys.json:\n${JSON.stringify(entry, null, 2)}`);
    return 0;
  }
  if (options.command === 'check') {
    const record = readJson(resolve(options.positional[0]));
    const checked = contracts.ReleaseEvidenceContract.validate(record);
    if (!checked.ok) {
      console.log(`invalid: ${JSON.stringify(checked.issues?.slice(0, 3) ?? checked)}`);
      return 1;
    }
    if (record.kind === 'baseline-release') {
      const verdict = contracts.verifyRecordSignature(record.payload, trustedMap('calibration'));
      console.log(verdict.ok ? 'valid baseline-release record, signed by a trusted calibration key' : `valid baseline-release record, but ${verdict.reasonCode}: no trusted calibration key verifies it`);
      return verdict.ok ? 0 : 1;
    }
    const role = { 'p0-register': 'owner', 'pre-registration': 'owner', 'security-review': 'security-reviewer', 'economics-report': 'owner' }[record.kind];
    if (role === undefined) {
      console.log(`valid ${record.kind} record (unsigned kind)`);
      return 0;
    }
    const verdict = contracts.verifyRecordSignature(record, trustedMap(role));
    console.log(verdict.ok ? `valid ${record.kind} record, signed by a trusted ${role} key` : `valid ${record.kind} record, but ${verdict.reasonCode}: no trusted ${role} key verifies it`);
    return verdict.ok ? 0 : 1;
  }
  // Only the signing commands take a key; the trial records are unsigned (the gates bind them by hash).
  const privateKeyPem = options.key === undefined ? undefined : readFileSync(options.key, 'utf8');
  if (options.command === 'p0-register') {
    const record = contracts.signRecord(contracts.releaseEvidence({ kind: 'p0-register', ...meta(options, 'p0-register'), payload: readJson(options.answers) }), privateKeyPem, options.keyId);
    await finish(record, options, 'owner', contracts);
    return 0;
  }
  if (options.command === 'security-review') {
    const review = readJson(options.review);
    const reportSha256 = `sha256:${(await import('node:crypto')).createHash('sha256').update(readFileSync(options.report)).digest('hex')}`;
    const m = meta(options, 'security-review');
    const payload = { ...review, reportSha256, reviewedVersion: review.reviewedVersion ?? m.version };
    const record = contracts.signRecord(contracts.releaseEvidence({ kind: 'security-review', ...m, payload }), privateKeyPem, options.keyId);
    await finish(record, options, 'security-reviewer', contracts);
    return 0;
  }
  if (options.command === 'quality-trial') {
    const evals = await load('evals');
    const preRegistration = readJson(options.preRegistration);
    if (preRegistration?.kind !== 'pre-registration' || !contracts.ReleaseEvidenceContract.validate(preRegistration).ok) throw new UsageError(`${options.preRegistration} is not a valid pre-registration record`);
    if (options.runConfig !== undefined) await runProductTrial(options, evals, preRegistration);
    const { trial, comparison } = trialComparison(options, evals);
    if (!evals.lockedBeforeTrial(preRegistration, trial.startedAt)) throw new UsageError('the pre-registration was not locked before the trial started; the trial cannot count');
    const record = evals.qualityTrialRecord({
      trial,
      comparison,
      preRegistration,
      protocol: readJson(options.protocol),
      holdout: readJson(options.holdout),
      corpus: evals.summarizeCorpus(readJson(options.corpus)),
      mandatoryChecksChanged: false,
      meta: meta(options, 'quality-trial'),
    });
    console.log(`jev-routed against rules-only on ${comparison.tasks} tasks: success difference ${comparison.successDifference.point} [${comparison.successDifference.lower}, ${comparison.successDifference.upper}]`);
    finishUnsigned(record, options, contracts);
    return 0;
  }
  if (options.command === 'economics') {
    const evals = await load('evals');
    const record = contracts.signRecord(seedEconomicsRecord(options, evals, contracts), privateKeyPem, options.keyId);
    console.log(`seed ${record.payload.sample.planId}: ${record.payload.sample.tasks} paired tasks, ${record.payload.sample.runs} runs; cost per verified task ratio ${record.payload.costPerVerifiedTask.ratio.point} [${record.payload.costPerVerifiedTask.ratio.lower}, ${record.payload.costPerVerifiedTask.ratio.upper}]`);
    await finish(record, options, 'owner', contracts);
    return 0;
  }
  if (options.command === 'baseline') {
    const evals = await load('evals');
    const record = baselineRecord(options, evals, contracts);
    const trusted = contracts.verifyRecordSignature(record.payload, trustedMap('calibration'));
    finishUnsigned(record, options, contracts);
    console.log(trusted.ok ? `the baseline is signed by ${record.payload.signature.keyId}, a trusted calibration key` : `the baseline is signed by ${record.payload.signature.keyId}; this key is not in assets/trust/release-keys.json as a calibration key, so the gates exclude it until it is added`);
    return 0;
  }
  if (options.command === 'calibration') {
    const evals = await load('evals');
    const input = readJson(options.proposal);
    const issuedAt = new Date().toISOString();
    const proposed = evals.proposeCalibration({ ...input, calibration: readJsonLines(options.calibration), holdout: readJsonLines(options.holdoutCases), issuedAt: input.issuedAt ?? issuedAt });
    if (!proposed.ok) throw new UsageError(`no calibration proposal: ${proposed.reasonCode}`);
    if (proposed.advisorySlices.length > 0) console.log(`advisory only (too few samples): ${proposed.advisorySlices.join(', ')}`);
    const released = evals.releaseProposal(proposed.proposal, { reviewerId: options.reviewer, reviewedAt: issuedAt, approved: true }, { privateKeyPem, keyId: options.keyId });
    if (!released.ok) throw new UsageError(`the calibration was not released: ${released.reasonCode}`);
    const trusted = contracts.verifyRecordSignature(released.artifact, trustedMap('calibration'));
    mkdirSync(options.out, { recursive: true });
    const file = join(options.out, 'calibration-release.json');
    writeFileSync(file, `${JSON.stringify(released.artifact, null, 2)}\n`);
    console.log(`wrote ${file}: threshold ${released.artifact.threshold.value} for ${released.artifact.permittedSlices.map((slice) => slice.sliceId).join(', ')}`);
    console.log(trusted.ok ? `signed by ${options.keyId}, a trusted calibration key` : `signed by ${options.keyId}; this key is not in assets/trust/release-keys.json as a calibration key, so the sidecar will not load the release until it is added`);
    console.log('install it as calibration-release.json in the Jevris config folder (jevris doctor shows the folder)');
    return 0;
  }
  const evals = await load('evals');
  const { record, power } = evals.preRegistrationRecord(readJson(options.input), meta(options, 'pre-registration'), { privateKeyPem, keyId: options.keyId });
  console.log(`minimum tasks per arm from the power calculation: ${power.minTasks}`);
  await finish(record, options, 'owner', contracts);
  return 0;
}

export async function main(argv) {
  try {
    return await run(parseArgs(argv));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`release-evidence: ${error.message}`);
    return 2;
  }
}

const entry = process.argv[1];
if (typeof entry === 'string' && resolve(entry) === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));

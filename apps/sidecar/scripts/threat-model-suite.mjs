#!/usr/bin/env node
/**
 * The GOV-14 threat-model suite as release evidence. Runs, under the same guarded test
 * environment as `npm test` (temp HOME, keyring blocked, harness stubs), the tests that exercise
 * each THREAT_CASES case against the real sidecar, and writes one `threat-model-suite` record:
 * { os, cases: [{ id, passed, notApplicable }] }.
 *
 *   node apps/sidecar/scripts/threat-model-suite.mjs --out release-evidence/threat-model-<os>.json
 *
 * Run after `npm run build`. A case passes only when every test it names ran (not skipped) and
 * passed. `pipe-squat` is the Windows named-pipe case and is not applicable elsewhere; every
 * other case must run on every OS. `cross-user-ipc` runs the opt-in
 * apps/sidecar/test/opt-in/cross-user.test.mjs, which needs a second local user named in
 * JEVRIS_TEST_OTHER_USER (CI's Linux and macOS cells create one); where none is available the
 * case fails, it is never reported as passed. Nothing here signs, uploads or reads a secret.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { arch, homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');

const THREAT_MODEL = join('apps', 'sidecar', 'test', 'threat-model.test.mjs');
const CROSS_USER = join('apps', 'sidecar', 'test', 'opt-in', 'cross-user.test.mjs');
const DAEMON = join('apps', 'sidecar', 'test', 'daemon.test.mjs');
const EGRESS_GUARD = join('apps', 'sidecar', 'test', 'egress-guard.test.mjs');
const STORE_PRIVATE = join('packages', 'store', 'test', 'private-files.test.mjs');
const CORE_EGRESS = join('packages', 'core', 'test', 'egress.test.mjs');

/**
 * Each case and the tests (file, exact name prefix) that exercise it through the product.
 * `on` limits a case to the OSes where it applies.
 */
export const CASE_TESTS = {
  'cross-user-ipc': { tests: [[CROSS_USER, 'a caller running as another OS user can neither connect to the sidecar nor read its keys or endpoint']] },
  replay: { tests: [[DAEMON, 'a replayed nonce is rejected before dispatch'], [DAEMON, 'an expired, future, tampered or wrong-key frame is refused']] },
  oversize: { tests: [[DAEMON, 'an oversize body or frame line is refused OVERSIZE before any handler runs']] },
  'slow-read': { tests: [[DAEMON, 'a slow-read client times out and the connection cap holds'], [DAEMON, 'the nonce cache is TTL-bounded and refuses rather than grows']] },
  'pipe-squat': {
    on: ['win32'],
    tests: [
      [DAEMON, 'the Windows pipe name is random and per user'],
      [DAEMON, 'the client refuses a server that cannot prove the key and sends it nothing'],
      [THREAT_MODEL, 'an endpoint file rewritten to point at a squatter makes the client fail closed'],
    ],
  },
  'symlink-race': {
    tests: [
      [THREAT_MODEL, 'a key file swapped for a symlink to a planted key makes the client fail closed'],
      [THREAT_MODEL, 'an endpoint file rewritten to point at a squatter makes the client fail closed'],
      [STORE_PRIVATE, 'a symlinked store db or -wal is refused and not followed'],
    ],
  },
  'forged-provenance': {
    tests: [
      [THREAT_MODEL, 'a frame claiming administrator egress approves nothing'],
      [CORE_EGRESS, 'non-administrator approved-scoped denies'],
      [CORE_EGRESS, 'repository JSON cannot approve egress'],
      [CORE_EGRESS, 'a model summary cannot approve egress'],
    ],
  },
  'egress-canary': {
    tests: [
      [EGRESS_GUARD, 'without approval a request carrying evidence text is answered locally with 451 EGRESS_NOT_APPROVED'],
      [EGRESS_GUARD, 'with approval, evidence text goes unless it holds a secret or a sensitive path'],
      [THREAT_MODEL, 'content at a path a frame names is never read into the store, the log or a Jev request'],
    ],
  },
};

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Test name to outcome ('pass', 'fail' or 'skip') from node's TAP output. */
export function tapOutcomes(tap) {
  const outcomes = new Map();
  for (const line of tap.split(/\r?\n/)) {
    const match = /^\s*(not ok|ok) \d+ - (.*?)(?: # (SKIP|TODO)\b.*)?$/.exec(line);
    if (match === null) continue;
    const name = match[2].replace(/\\#/g, '#');
    const outcome = match[1] === 'not ok' ? 'fail' : match[3] !== undefined ? 'skip' : 'pass';
    // A name reported twice (a file run twice) keeps its worst outcome.
    const prior = outcomes.get(name);
    if (prior === 'fail' || (prior === 'skip' && outcome === 'pass')) continue;
    outcomes.set(name, outcome);
  }
  return outcomes;
}

/** The payload cases for `os` from the per-test outcomes. */
export function caseResults(outcomes, os) {
  return Object.entries(CASE_TESTS).map(([id, spec]) => {
    if (spec.on !== undefined && !spec.on.includes(os)) return { id, passed: false, notApplicable: true };
    const passed = spec.tests.every(([, prefix]) => {
      for (const [name, outcome] of outcomes) if (name.startsWith(prefix)) return outcome === 'pass';
      return false;
    });
    return { id, passed, notApplicable: false };
  });
}

function parseArgs(argv) {
  const options = { out: null, version: null, commit: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--out' && value !== undefined) options.out = resolve(value);
    else if (flag === '--version' && value !== undefined) options.version = value;
    else if (flag === '--commit' && value !== undefined) options.commit = value;
    else throw new Error(`usage: threat-model-suite.mjs --out <file> [--version <semver>] [--commit <sha>]; unknown ${flag}`);
    index += 1;
  }
  if (options.out === null) throw new Error('usage: threat-model-suite.mjs --out <file>');
  return options;
}

/** Runs the named tests in the guarded test environment and returns node's TAP output. */
function runTests() {
  const { testEnvironment, writeHarnessStubs } = awaitTestHelpers;
  const files = [...new Set(Object.values(CASE_TESTS).flatMap((spec) => spec.tests.map(([file]) => join(repoRoot, file))))];
  const patterns = [...new Set(Object.values(CASE_TESTS).flatMap((spec) => spec.tests.map(([, prefix]) => `^${escapeRegExp(prefix)}`)))];
  const tempHome = mkdtempSync(join(tmpdir(), 'jtm-'));
  const stubDir = writeHarnessStubs(mkdtempSync(join(tmpdir(), 'jtm-bin-')));
  try {
    const run = spawnSync(
      process.execPath,
      ['--test', '--test-timeout=120000', '--test-concurrency=1', '--test-reporter=tap', ...patterns.map((pattern) => `--test-name-pattern=${pattern}`), ...files],
      { cwd: repoRoot, env: testEnvironment(tempHome, homedir(), stubDir), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    return `${run.stdout ?? ''}`;
  } finally {
    rmSync(tempHome, { recursive: true, force: true, maxRetries: 3 });
    rmSync(stubDir, { recursive: true, force: true, maxRetries: 3 });
  }
}

let awaitTestHelpers;

export async function main(argv) {
  const options = parseArgs(argv);
  awaitTestHelpers = await import(pathToFileURL(join(repoRoot, 'scripts', 'test.mjs')).href);
  const evidence = await import(pathToFileURL(join(repoRoot, 'scripts', 'release-evidence.mjs')).href);
  const contracts = await import(pathToFileURL(join(repoRoot, 'packages', 'contracts', 'dist', 'index.js')).href);
  const os = process.platform;
  if (!['darwin', 'linux', 'win32'].includes(os)) throw new Error(`unsupported OS ${os}`);
  const cases = caseResults(tapOutcomes(runTests()), os);
  const meta = evidence.meta({ version: options.version ?? undefined, commit: options.commit ?? undefined }, 'threat-model-suite');
  const record = contracts.releaseEvidence({
    kind: 'threat-model-suite',
    ...meta,
    tool: 'threat-model-suite',
    run: process.env.GITHUB_RUN_ID ?? null,
    arch: arch(),
    payload: { os, cases },
  });
  const checked = contracts.ReleaseEvidenceContract.validate(record);
  if (!checked.ok) throw new Error(`the record does not match its contract: ${JSON.stringify(checked).slice(0, 400)}`);
  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, `${JSON.stringify(record, null, 2)}\n`);
  for (const item of cases) console.log(`${item.id}: ${item.notApplicable ? 'not applicable' : item.passed ? 'pass' : 'FAIL'}`);
  console.log(`wrote ${options.out}`);
  return cases.every((item) => item.notApplicable || item.passed) ? 0 : 1;
}

const entry = process.argv[1];
if (typeof entry === 'string' && resolve(entry) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    console.error(`threat-model-suite: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

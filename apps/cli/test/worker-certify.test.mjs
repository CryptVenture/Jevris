// worker.route (owner approval 2026-09-26, DOMAINS 72ff950): certified pending first use. Paired
// tests: certify proves every worker port with no model call (the help lists each flag the port
// passes, and the port passes the nine §15.4 cases against a stand-in); the first real run's
// init check is recorded as live evidence (verified in use), and a failed check demotes
// worker.route and starts one background re-check. Stub harness CLIs and temp homes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKER_HELP } from './harness-cli-stubs.mjs';

const wc = await import('../dist/worker-certify.js');
const { recordWorkerRun } = await import('../dist/worker-evidence.js');
const { claudeWorkerPort } = await import('../dist/claude-worker.js');
const { certifyHarness, formatCertify } = await import('../dist/certification.js');
const { loadCertifications, coveringCertification } = await import('../dist/certification-store.js');
const { readLiveEvidence } = await import('../dist/live-evidence.js');
const { maybeReverify } = await import('../dist/reverify.js');
const { runDoctorCommand, workerLine } = await import('../dist/doctor-cli.js');
const { doctorLineSeverity } = await import('../dist/doctor-severity.js');
const { main } = await import('../dist/cli.js');

const root = fileURLToPath(new URL('../../..', import.meta.url));
const OS = process.platform;

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'jevris-worker-cert-'));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3 }));
  return home;
}

function claudeStub(version, help = WORKER_HELP.claude) {
  return {
    available: (file) => file === 'claude',
    run: async (_file, args) => {
      const line = args.join(' ');
      if (line === '--version') return { spawned: true, code: 0, stdout: `${version} (Claude Code)\n` };
      if (line === '--help') return { spawned: true, code: 0, stdout: help };
      if (line.startsWith('plugin validate')) return { spawned: true, code: 0, stdout: '✔ Validation passed\n' };
      if (line === 'plugin list --json') return { spawned: true, code: 0, stdout: '[{"id":"jevris@jevris-local","enabled":true}]' };
      if (line.startsWith('plugin details')) return { spawned: true, code: 0, stdout: 'Skills: status, plan, route, checkpoint, recover, verify, explain, configure, guide\n' };
      return { spawned: true, code: 0, stdout: '' };
    },
  };
}

async function installed(home) {
  let out = '';
  assert.equal(await main(['install', '--yes', '--home', home, '--harness', 'claude'], (chunk) => (out += chunk)), 0, out);
}

async function workerDoctorLine(home, version) {
  let out = '';
  await runDoctorCommand({ home, json: false, values: {}, root, cli: claudeStub(version), policies: [], reverifyStart: async () => true, reverifyGuard: () => 'not re-checked: test run' }, (chunk) => (out += chunk));
  return out.split('\n').find((line) => line.startsWith('harness claude worker:'));
}

test('every worker port passes the nine §15.4 cases against a stand-in, with no real binary and no model call', async (t) => {
  const dir = tempHome(t);
  for (const harness of ['claude', 'codex', 'opencode', 'kilocode', 'antigravity']) {
    const cases = await wc.workerConformance(harness, dir);
    assert.deepEqual([...cases.keys()].sort(), ['cancellation', 'duplicate-delivery', 'event-validation', 'offline-fallback', 'output-shape', 'permission-preservation', 'stale-revision', 'unsupported-capability', 'user-pin']);
    for (const [id, reason] of cases) assert.equal(reason, null, `${harness} ${id}: ${reason}`);
  }
});

test('the flag probe reads each harness help: every flag the worker passes, and a missing one fails with its name', async () => {
  for (const [harness, bin] of [['claude', 'claude'], ['codex', 'codex'], ['opencode', 'opencode'], ['kilocode', 'kilo'], ['antigravity', 'agy']]) {
    const cli = { available: () => true, run: async (_file, args) => ({ spawned: true, code: 0, stdout: args.at(-1) === '--help' ? WORKER_HELP[bin] : '' }) };
    const ok = await wc.workerFlagCheck(harness, cli, {});
    assert.equal(ok.ok, true, `${harness}: ${ok.detail}`);
  }
  const cli = { available: () => true, run: async () => ({ spawned: true, code: 0, stdout: WORKER_HELP.claude.replace('--effort <level>', '') }) };
  const missing = await wc.workerFlagCheck('claude', cli, {});
  assert.deepEqual([missing.ok, missing.detail], [false, 'claude --help does not list --effort']);
  assert.deepEqual(wc.missingFlags('  --json\n  -m, --model <MODEL>\n  --modelx', ['--json', '--model', '--sandbox']), ['--sandbox']);
  assert.match(wc.workerLimitations('claude').join('\n'), /--max-turns, which claude --help does not list/);
  assert.match(wc.workerLimitations('antigravity').join('\n'), /read-only grant is enforced after the fact/);
});

test('certify: worker.route is certified pending first use; a help without a worker flag leaves it uncertified with the flag named', async (t) => {
  const home = tempHome(t);
  await installed(home);
  const good = await certifyHarness({ home, harness: 'claude', json: false, root, cli: claudeStub('2.1.283'), policies: [] });
  assert.equal(good.ok, true, formatCertify(good));
  const worker = good.features.find((item) => item.featureId === 'worker.route');
  assert.equal(worker.passed, true);
  assert.match(worker.detail, /all 9 §15\.4 cases; pending first use/);
  assert.equal(good.workerCases.length, 9);
  assert.match(formatCertify(good), /worker case user-pin: pass/);

  const home2 = tempHome(t);
  await installed(home2);
  const bad = await certifyHarness({ home: home2, harness: 'claude', json: false, root, cli: claudeStub('2.1.283', WORKER_HELP.claude.replace('--strict-mcp-config', '')), listModels: async () => ({ ok: true, models: ['claude-opus-5-5'] }), policies: [] });
  const failed = bad.features.find((item) => item.featureId === 'worker.route');
  assert.deepEqual([failed.passed, failed.reasonCode], [false, 'WORKER_FLAG_MISSING']);
  assert.match(failed.detail, /does not list --strict-mcp-config/);
  // The stand-in never reaches the stub, so the optional access features (R69) are not certified either.
  assert.equal(bad.features.filter((item) => item.featureId !== 'worker.route' && !item.featureId.startsWith('access.')).every((item) => item.passed), true, 'only worker.route fails');
});

test('first use: pending, then verified in use after a conforming run; a failed init check demotes worker.route and starts one re-check', async (t) => {
  const home = tempHome(t);
  await installed(home);
  await certifyHarness({ home, harness: 'claude', json: false, root, cli: claudeStub('2.1.283'), policies: [], nowMs: Date.now() - 60_000 });
  let line = await workerDoctorLine(home, '2.1.283');
  assert.equal(line, 'harness claude worker: certified, pending first use (the first owned run checks its init before any tool runs)');
  assert.equal(doctorLineSeverity(line), 'ok');

  const jobs = [];
  const evidence = { home, root, version: async () => '2.1.283', reverify: async (options) => maybeReverify({ ...options, start: async (job) => (jobs.push(job), true), guard: () => null }) };
  assert.equal(await recordWorkerRun('claude', { ok: true, reasonCode: null }, evidence), 'conforming');
  assert.equal(await recordWorkerRun('claude', { ok: true, reasonCode: null }, evidence), 'conforming');
  assert.equal(await recordWorkerRun('claude', null, evidence), 'none', 'no init event: nothing recorded');
  line = await workerDoctorLine(home, '2.1.283');
  assert.equal(line, 'harness claude worker: verified in use (2 runs at 2.1.283)');
  assert.equal(jobs.length, 0);

  assert.equal(await recordWorkerRun('claude', { ok: false, reasonCode: 'WORKER_INIT_CWD' }, evidence), 'malformed');
  assert.equal(jobs.length, 1, 'one background re-check');
  assert.equal(jobs[0].reason, 'demoted');
  const load = await loadCertifications(home, { root });
  const covered = (featureId) => coveringCertification(load, { harness: 'claude', harnessVersion: '2.1.283', operatingSystem: OS, nowMs: Date.now(), featureId }).covered !== null;
  assert.equal(covered('worker.route'), false, 'worker.route is demoted');
  assert.equal(covered('hooks.observe'), true, 'only worker.route');
  const events = await readLiveEvidence(home);
  assert.deepEqual(events.demotions.map((item) => [item.featureId, item.reasonCode]), [['worker.route', 'WORKER_INIT_CWD']]);
  line = await workerDoctorLine(home, '2.1.283');
  // The failed run started the re-check (its marker is on disk), so doctor says so instead of the fix.
  assert.equal(line, "harness claude worker: demoted: an owned run's first-use check failed; re-checking in the background, no model call");
  assert.equal(doctorLineSeverity(line), 'info');
});

test('a port records evidence only for the harness binary: an injected stub records nothing unless evidence is passed', async (t) => {
  const home = tempHome(t);
  const dir = tempHome(t);
  const stub = join(dir, 'stub.cjs');
  const work = join(dir, 'work');
  mkdirSync(work);
  writeFileSync(
    stub,
    `process.stdin.resume(); process.stdin.on('end', () => { for (const l of [{ type: 'system', subtype: 'init', session_id: 's', cwd: process.cwd(), model: 'claude-x', permissionMode: 'default', apiKeySource: 'none', tools: ['Read'] }, { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's', num_turns: 1 }]) process.stdout.write(JSON.stringify(l) + '\\n'); });`,
  );
  const input = { prompt: 'p', model: 'claude-x', cwd: work, allowedTools: ['Read'], maxTurns: 2, maxBudgetUsd: 1, timeoutMs: 20_000 };
  const plain = await claudeWorkerPort({ command: { file: process.execPath, args: [stub] } }).run(input);
  assert.equal(plain.status, 'completed', plain.reason);
  assert.deepEqual((await readLiveEvidence(home)).counts, {});
  const counted = await claudeWorkerPort({ command: { file: process.execPath, args: [stub] }, evidence: { home, root, version: async () => '2.1.283' } }).run(input);
  assert.deepEqual(counted.initCheck, { ok: true, reasonCode: null });
  assert.equal((await readLiveEvidence(home)).counts.claude['2.1.283']['worker.route'].conforming, 1);
});

test('an upgrade re-checks a record that predates worker.route once, in the background; doctor names it until then', async (t) => {
  const home = tempHome(t);
  await installed(home);
  // A record from before worker.route: certify with a help that lists no worker flag, then drop the feature.
  await certifyHarness({ home, harness: 'claude', json: false, root, cli: claudeStub('2.1.283'), policies: [] });
  const load = await loadCertifications(home, { root });
  const record = load.records[0].record;
  const jobs = [];
  const older = { ...load, records: [{ ...load.records[0], record: { ...record, features: record.features.filter((item) => item.featureId !== 'worker.route') } }] };
  const states = await maybeReverify({ home, root, installed: ['claude'], versions: { claude: '2.1.283' }, load: older, start: async (job) => (jobs.push(job), true), guard: () => null });
  assert.deepEqual(states.map((item) => [item.state, item.reason]), [['started', 'new-feature']]);
  const again = await maybeReverify({ home, root, installed: ['claude'], versions: { claude: '2.1.283' }, load: older, start: async (job) => (jobs.push(job), true), guard: () => null });
  assert.deepEqual(again.map((item) => item.state), ['running']);
  assert.equal(jobs.length, 1, 'exactly once');
  const row = { harness: 'claude', installed: true, version: '2.1.283', certificationRecords: 1, certifiedFeatures: ['hooks.observe'], certifyCommand: 'jevris certify --harness claude', smoke: [], unsupported: [], upgrade: false, coverage: { range: '>=2.1.283 <2.2.0', lastVerified: '2.1.283', verifiedAt: '2026-09-26' }, uncertified: [], previous: null, reverify: null };
  assert.equal(workerLine(row), 'harness claude worker: not certified yet: the record for 2.1.283 predates owned-worker certification; fix: jevris certify --harness claude');
  assert.match(workerLine({ ...row, reverify: { ...states[0], state: 'running' } }), /re-checking in the background, no model call$/);
  assert.equal(workerLine({ ...row, harness: 'antigravity', certifiedFeatures: ['worker.route'], workerRuns: 0 }).endsWith('a read-only grant is enforced after the fact (the run is killed), not before'), true);
  assert.equal(workerLine({ ...row, coverage: null }), null);
});

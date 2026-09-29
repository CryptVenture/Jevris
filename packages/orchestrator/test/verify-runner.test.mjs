import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  approveManifests,
  approvedManifests,
  decideStop,
  evaluateCompletion,
  manifestHash,
  openWorkspace,
  parseJUnit,
  parseManifest,
  parseNodeSpec,
  parseTap,
  readProposedManifests,
  reminderSummary,
  revokeApproval,
  runCheck,
  runVerification,
  runnerEnvironment,
  snapshotRevision,
  verificationStatus,
  verificationSupport,
} from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

const NODE = process.execPath;

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

function fixture() {
  const dir = tempDir('jv-verify-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo with spaces (x86)');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(repo, 'lib'), { recursive: true });
  mkdirSync(join(repo, 'docs'), { recursive: true });
  writeFileSync(join(repo, 'lib', 'a.js'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'docs', 'readme.md'), '# doc\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  const store = testStore(dir);
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
  return { dir, home, repo, ws, done: () => {
      closeTestStore(store);
      rmSync(dir, { recursive: true, force: true });
    } };
}

function manifest(id, script, extra = {}) {
  const parsed = parseManifest({ id, argv: [NODE, '-e', script], resultFormat: 'exit-code', timeoutMs: 60_000, ...extra });
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  return parsed.manifest;
}

async function approve(ws, manifests) {
  const hashes = {};
  for (const m of manifests) hashes[m.id] = manifestHash(m);
  await approveManifests(ws, manifests, hashes, 'test');
}

test('a passing check writes a full receipt with revision, exit code, env fingerprint and raw-output handle (VER-01)', async () => {
  const f = fixture();
  try {
    const m = manifest('unit', "console.log('TAP version 13');console.log('ok 1 - adds');console.log('1..1');", { resultFormat: 'tap' });
    const run = await runCheck(m, { workspaceRoot: f.repo, workspaceId: f.ws.workspaceId, evidence: f.ws.evidence, receipts: f.ws.receipts });
    const r = run.receipt;
    assert.equal(r.outcome, 'passed');
    assert.equal(r.exitCode, 0);
    assert.equal(r.signal, null);
    assert.deepEqual(r.argv.slice(1), ['-e', m.argv[2]]);
    assert.equal(r.cwd, '.');
    assert.match(r.inputRevision.revision, /^g-[a-f0-9]{16}$/);
    assert.equal(r.results.format, 'tap');
    assert.equal(r.results.passed, 1);
    assert.match(r.rawOutputHash, /^[a-f0-9]{64}$/);
    assert.match(r.environmentHash, /^[a-f0-9]{64}$/);
    assert.ok(Date.parse(r.endedAt) >= Date.parse(r.startedAt));
    const raw = f.ws.evidence.get(r.rawOutputHandle, f.ws.workspaceId);
    assert.ok(new TextDecoder().decode(raw).includes('ok 1 - adds'));
    const stored = f.ws.receipts.get(f.ws.workspaceId, r.id);
    assert.equal(stored.validity, 'current');
  } finally {
    f.done();
  }
});

test('a failing run writes a failed receipt with failing test ids; a timeout is failed, not refused (VER-01)', async () => {
  const f = fixture();
  try {
    const failing = manifest('suite', "console.log('TAP version 13');console.log('ok 1 - a');console.log('not ok 2 - b breaks');console.log('1..2');process.exit(1);", { resultFormat: 'tap' });
    const run = await runCheck(failing, { workspaceRoot: f.repo, workspaceId: f.ws.workspaceId, evidence: f.ws.evidence, receipts: f.ws.receipts });
    assert.equal(run.receipt.outcome, 'failed');
    assert.equal(run.receipt.exitCode, 1);
    assert.equal(run.receipt.results.failed, 1);
    assert.equal(run.receipt.results.failures[0].name, 'b breaks');
    const slow = manifest('slow', 'setTimeout(()=>{}, 60000)', { timeoutMs: 1000 });
    const timed = await runCheck(slow, { workspaceRoot: f.repo, workspaceId: f.ws.workspaceId, evidence: f.ws.evidence, receipts: f.ws.receipts });
    assert.equal(timed.receipt.outcome, 'failed');
    assert.equal(timed.receipt.timedOut, true);
    assert.equal(f.ws.receipts.list(f.ws.workspaceId).length, 2);
  } finally {
    f.done();
  }
});

test('a multi-second suite completes (no 2 s cap) and inherits PATH and HOME but no credential (VER-01, BUG-25)', async () => {
  const f = fixture();
  try {
    const m = manifest('long', "setTimeout(()=>{console.log(JSON.stringify(Object.keys(process.env).sort()))}, 2500)");
    const env = { PATH: process.env.PATH, HOME: f.home, ANTHROPIC_API_KEY: 'sk-ant-should-never-pass', GITHUB_TOKEN: 'x' };
    const run = await runCheck(m, { workspaceRoot: f.repo, workspaceId: f.ws.workspaceId, evidence: f.ws.evidence, receipts: f.ws.receipts, env });
    assert.equal(run.receipt.outcome, 'passed');
    assert.ok(run.receipt.durationMs >= 2400);
    const keys = JSON.parse(new TextDecoder().decode(run.exec.stdout));
    assert.ok(keys.includes('PATH'));
    assert.ok(keys.includes('HOME'));
    assert.equal(keys.includes('ANTHROPIC_API_KEY'), false);
    assert.equal(keys.includes('GITHUB_TOKEN'), false);
    assert.equal(parseManifest({ id: 'x', argv: [NODE], env: ['OPENAI_API_KEY'] }).ok, false);
  } finally {
    f.done();
  }
});

test('manifests: relative commands, shell text and pass claims are refused; bare names and Windows paths are accepted (VER-02)', () => {
  assert.equal(parseManifest({ id: 'a', argv: ['./node'] }).ok, false);
  assert.equal(parseManifest({ id: 'a', argv: ['npm;rm'] }).ok, false);
  assert.equal(parseManifest({ id: 'a', argv: ['npm'], passed: true }).ok, false);
  assert.equal(parseManifest({ id: 'a', argv: ['npm'], shellCommand: 'x' }).ok, false);
  assert.equal(parseManifest({ id: 'a', argv: ['npm', 'test'], cwd: '../outside' }).ok, false);
  assert.equal(parseManifest({ id: 'a', argv: ['npm', 'test'] }).ok, true);
  assert.equal(parseManifest({ id: 'a', argv: ['C:\\Program Files (x86)\\nodejs\\node.exe', '--test'] }, 'win32').ok, true);
  assert.equal(parseManifest({ id: 'a', argv: ['\\\\server\\share\\tool.cmd'] }, 'win32').ok, true);
  assert.equal(parseManifest({ id: 'a', argv: ['tools\\x.exe'] }, 'win32').ok, false);
  assert.equal(parseManifest({ id: 'a', argv: ['C:\\x.exe'] }, 'linux').ok, false);
});

test('the runner environment on win32 keeps SystemRoot, PATHEXT and case-insensitive Path (VER-02)', () => {
  const env = runnerEnvironment({ Path: 'C:\\Windows', SYSTEMROOT: 'C:\\Windows', PATHEXT: '.EXE;.CMD', USERPROFILE: 'C:\\Users\\u', AWS_SECRET_ACCESS_KEY: 'x' }, ['FOO_TOKEN', 'MY_FLAG'], 'win32');
  assert.equal(env.env.PATH, 'C:\\Windows');
  assert.equal(env.env.SystemRoot, 'C:\\Windows');
  assert.equal(env.env.PATHEXT, '.EXE;.CMD');
  assert.equal(env.env.USERPROFILE, 'C:\\Users\\u');
  assert.equal(Object.keys(env.env).some((k) => k.includes('SECRET')), false);
  assert.deepEqual(env.refused, ['FOO_TOKEN']);
});

test('a PATH-resolved program with a space in its directory runs through the platform spawn plan (VER-02, VER-08)', async () => {
  const f = fixture();
  try {
    const bin = join(f.dir, 'bin dir');
    mkdirSync(bin);
    const script = join(bin, 'mytool.mjs');
    writeFileSync(script, "console.log('ℹ tests 2\\nℹ pass 2\\nℹ fail 0')\n");
    let name = 'mytool';
    if (process.platform === 'win32') {
      writeFileSync(join(bin, 'mytool.cmd'), `@"${NODE}" "%~dp0mytool.mjs" %*\r\n`);
    } else {
      writeFileSync(join(bin, name), `#!/bin/sh\nexec "${NODE}" "${script}" "$@"\n`, { mode: 0o755 });
    }
    const parsed = parseManifest({ id: 'tool', argv: [name, 'arg with space'], resultFormat: 'node-spec' });
    assert.equal(parsed.ok, true);
    const env = { PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`, ...(process.platform === 'win32' ? { PATHEXT: '.COM;.EXE;.BAT;.CMD', SystemRoot: process.env.SystemRoot } : {}) };
    const run = await runCheck(parsed.manifest, { workspaceRoot: f.repo, workspaceId: f.ws.workspaceId, evidence: f.ws.evidence, receipts: f.ws.receipts, env });
    assert.equal(run.receipt.outcome, 'passed', run.receipt.outcomeReason);
    assert.equal(run.receipt.results.format, 'node-spec');
    assert.equal(run.receipt.results.total, 2);
  } finally {
    f.done();
  }
});

test('structured result parsers: TAP summary, node:test spec, JUnit', () => {
  const tap = parseTap('TAP version 13\n# Subtest: x\n    ok 1 - inner\nok 1 - x\nnot ok 2 - y\n1..2\n# tests 3\n# pass 2\n# fail 1\n');
  assert.equal(tap.total, 3);
  assert.equal(tap.failed, 1);
  assert.equal(tap.failures[0].name, 'y');
  const spec = parseNodeSpec('✔ a (1ms)\n✖ b fails (2ms)\nℹ tests 2\nℹ pass 1\nℹ fail 1\nℹ skipped 0\n✖ failing tests:\n\n✖ b fails (2ms)\n');
  assert.equal(spec.failed, 1);
  assert.deepEqual(spec.failures.map((f) => f.name), ['b fails']);
  const junit = parseJUnit('<testsuite tests="3"><testcase classname="m" name="a"/><testcase name="b"><failure message="boom &amp; bust"/></testcase><testcase name="c"><skipped/></testcase></testsuite>');
  assert.equal(junit.total, 3);
  assert.equal(junit.failed, 1);
  assert.equal(junit.skipped, 1);
  assert.equal(junit.failures[0].message, 'boom & bust');
  assert.equal(parseTap('hello'), null);
  assert.equal(parseJUnit('nothing'), null);
});

test('an edit after a passing run invalidates the affected receipt, not an unrelated one (VER-03, C39)', async () => {
  const f = fixture();
  try {
    const src = manifest('src-check', 'process.exit(0)', { inputScopes: ['lib'] });
    const docs = manifest('docs-check', 'process.exit(0)', { inputScopes: ['docs'] });
    await approve(f.ws, [src, docs]);
    const first = await runVerification(f.ws, { taskId: null, checkIds: [] });
    assert.equal(first.completion.verified, true, JSON.stringify(first.completion.checks));
    writeFileSync(join(f.repo, 'lib', 'a.js'), 'export const a = 2;\n');
    const after = await verificationStatus(f.ws, { taskId: null, checkIds: [] });
    assert.equal(after.verified, false);
    const bySrc = after.checks.find((c) => c.checkId === 'src-check');
    const byDocs = after.checks.find((c) => c.checkId === 'docs-check');
    assert.equal(bySrc.status, 'stale');
    assert.equal(byDocs.status, 'passed');
    assert.equal(after.invalidated.length, 1);
    const stored = f.ws.receipts.list(f.ws.workspaceId, { checkId: 'src-check' })[0];
    assert.equal(stored.validity, 'invalidated');
    assert.equal(stored.invalidatedReason, 'inputs-changed');
    // A branch switch invalidates everything that is still current.
    git(f.repo, 'checkout', '-q', '-b', 'other');
    const branch = await verificationStatus(f.ws, { taskId: null, checkIds: [] });
    assert.equal(branch.checks.find((c) => c.checkId === 'docs-check').status, 'stale');
  } finally {
    f.done();
  }
});

test('completion reads the ledger: a missing mandatory receipt or an uncovered requirement is not verified (VER-04)', async () => {
  const f = fixture();
  try {
    const unit = manifest('unit', 'process.exit(0)', { requirementIds: ['REQ-1'] });
    const lint = manifest('lint', 'process.exit(0)');
    await approve(f.ws, [unit, lint]);
    await runVerification(f.ws, { taskId: 'T1', checkIds: ['unit'] });
    const partial = await verificationStatus(f.ws, { taskId: 'T1', checkIds: [] });
    assert.equal(partial.verified, false);
    assert.deepEqual(partial.missingEvidence, ['lint:missing']);
    await runVerification(f.ws, { taskId: 'T1', checkIds: ['lint'] });
    const full = await verificationStatus(f.ws, { taskId: 'T1', checkIds: [], requirementIds: ['REQ-1'] });
    assert.equal(full.verified, true);
    const uncovered = await verificationStatus(f.ws, { taskId: 'T1', checkIds: [], requirementIds: ['REQ-1', 'REQ-2'] });
    assert.equal(uncovered.verified, false);
    assert.deepEqual(uncovered.uncoveredRequirements, ['REQ-2']);
  } finally {
    f.done();
  }
});

test('stop reminds at most once per unchanged condition, respects stop_hook_active, then reports unverified (VER-05)', async () => {
  const f = fixture();
  try {
    await approve(f.ws, [manifest('unit', 'process.exit(1)')]);
    await runVerification(f.ws, { taskId: 'T1', checkIds: [] });
    const completion = await verificationStatus(f.ws, { taskId: 'T1', checkIds: [] });
    const active = await decideStop({ workspaceId: f.ws.workspaceId, taskId: 'T1', completion, stopHookActive: true, state: f.ws.state });
    assert.equal(active.continuationScheduled, false);
    assert.equal(active.outcome, 'unverified');
    const first = await decideStop({ workspaceId: f.ws.workspaceId, taskId: 'T1', completion, stopHookActive: false, state: f.ws.state });
    assert.equal(first.outcome, 'remind');
    const second = await decideStop({ workspaceId: f.ws.workspaceId, taskId: 'T1', completion, stopHookActive: false, state: f.ws.state });
    assert.equal(second.outcome, 'unverified');
    assert.match(second.text, /labelled unverified/);
    // A changed condition may remind once more.
    writeFileSync(join(f.repo, 'lib', 'a.js'), 'x');
    const changed = await verificationStatus(f.ws, { taskId: 'T1', checkIds: [] });
    const third = await decideStop({ workspaceId: f.ws.workspaceId, taskId: 'T1', completion: changed, stopHookActive: false, state: f.ws.state });
    assert.equal(third.outcome, 'remind');
  } finally {
    f.done();
  }
});

test('P6: a Stop reminder keeps what followed it (a check started, verified, or ended unverified) with times, and a verified stop still lets the same condition remind again', async () => {
  const f = fixture();
  try {
    const flag = join(f.dir, 'pass');
    await approve(f.ws, [manifest('unit', `process.exit(require('fs').existsSync(${JSON.stringify(flag)}) ? 0 : 1)`)]);
    await runVerification(f.ws, { taskId: 'T1', checkIds: [] });
    const stop = async (nowMs, stopHookActive = false) => decideStop({ workspaceId: f.ws.workspaceId, taskId: 'T1', completion: await verificationStatus(f.ws, { taskId: 'T1', checkIds: [] }), stopHookActive, state: f.ws.state, nowMs });
    const t0 = Date.now();
    assert.equal((await stop(t0)).outcome, 'remind');
    assert.deepEqual(reminderSummary(f.ws.state, f.ws.workspaceId), { fired: 1, ledToCheck: 0, ledToVerification: 0, endedUnverified: 0 });
    // The check the reminder asked for runs (still failing): the reminder led to a check.
    await runVerification(f.ws, { taskId: 'T1', checkIds: [] });
    assert.deepEqual(reminderSummary(f.ws.state, f.ws.workspaceId), { fired: 1, ledToCheck: 1, ledToVerification: 0, endedUnverified: 0 });
    writeFileSync(flag, 'x');
    await runVerification(f.ws, { taskId: 'T1', checkIds: [] });
    assert.equal((await stop(t0 + 5_000)).outcome, 'verified');
    const [row] = f.ws.state.list('stop-reminders');
    assert.deepEqual([row.outcome, row.timeToOutcomeMs, row.cleared, row.timeToCheckMs >= 0], ['verified', 5_000, true, true], 'kept, not deleted');
    assert.deepEqual(reminderSummary(f.ws.state, f.ws.workspaceId), { fired: 1, ledToCheck: 1, ledToVerification: 1, endedUnverified: 0 });
    // Later work breaks it again: the same condition reminds once more, then the work ends unverified.
    rmSync(flag);
    await runVerification(f.ws, { taskId: 'T1', checkIds: [] });
    assert.equal((await stop(t0 + 9_000)).outcome, 'remind');
    assert.equal((await stop(t0 + 10_000, true)).outcome, 'unverified');
    const [again] = f.ws.state.list('stop-reminders');
    assert.deepEqual([again.outcome, again.timeToOutcomeMs, again.timeToCheckMs, again.history.length], ['ended-unverified', 1_000, null, 1]);
    assert.deepEqual(reminderSummary(f.ws.state, f.ws.workspaceId), { fired: 2, ledToCheck: 1, ledToVerification: 1, endedUnverified: 1 });
    // Times and outcomes only: no reminder text is kept.
    assert.doesNotMatch(JSON.stringify(f.ws.state.list('stop-reminders')), /Missing|jevris verify|unit:/);
  } finally {
    f.done();
  }
});

test('verification support flips to supported after approval and back on revoke; an edited check needs approval again (VER-07)', async () => {
  const f = fixture();
  try {
    assert.equal(verificationSupport(f.ws).state, 'unsupported');
    writeFileSync(join(f.repo, 'jevris.checks.json'), JSON.stringify({ schemaVersion: 'jevris-checks-1', checks: [{ id: 'unit', argv: [NODE, '-e', 'process.exit(0)'] }] }));
    const proposed = readProposedManifests(f.repo);
    assert.equal(proposed.ok, true);
    assert.equal(verificationSupport(f.ws).state, 'unsupported');
    await approveManifests(f.ws, proposed.manifests, proposed.hashes, proposed.file);
    assert.equal(verificationSupport(f.ws).state, 'supported');
    writeFileSync(join(f.repo, 'jevris.checks.json'), JSON.stringify({ schemaVersion: 'jevris-checks-1', checks: [{ id: 'unit', argv: [NODE, '-e', 'process.exit(3)'] }] }));
    assert.deepEqual(verificationSupport(f.ws).pendingApproval, ['unit']);
    await revokeApproval(f.ws);
    assert.equal(verificationSupport(f.ws).state, 'unsupported');
  } finally {
    f.done();
  }
});

test('approving again replaces the approved set: a check left out of the new approval loses its approval (JEV-0001)', async () => {
  const f = fixture();
  try {
    const a = manifest('a', 'process.exit(0)');
    const b = manifest('b', 'process.exit(0)');
    await approve(f.ws, [a, b]);
    assert.deepEqual(approvedManifests(f.ws).map((m) => m.id), ['a', 'b']);
    // The same id with a different command replaces the old approval, and `b` is dropped.
    const a2 = manifest('a', 'process.exit(0)', { timeoutMs: 30_000 });
    await approve(f.ws, [a2]);
    assert.deepEqual(approvedManifests(f.ws).map((m) => m.id), ['a']);
    assert.equal(approvedManifests(f.ws)[0].timeoutMs, 30_000);
    const gone = await runVerification(f.ws, { taskId: 'T1', checkIds: ['b'] });
    assert.deepEqual(gone.ran, [], 'a dropped check is not runnable');
    assert.deepEqual(verificationSupport(f.ws).pendingApproval ?? [], []);
    const kept = await runVerification(f.ws, { taskId: 'T1', checkIds: ['a'] });
    assert.equal(kept.ran.length, 1);
  } finally {
    f.done();
  }
});

test('receipt currency is one-way: restoring an edited input does not revive a receipt Jevris saw go stale (JEV-0002)', async () => {
  const f = fixture();
  try {
    await approve(f.ws, [manifest('unit', 'process.exit(0)', { inputScopes: ['lib'] })]);
    const first = await runVerification(f.ws, { taskId: 'T1', checkIds: ['unit'] });
    assert.equal(first.completion.verified, true);
    const file = join(f.repo, 'lib', 'a.js');
    writeFileSync(file, 'export const a = 2;\n');
    const stale = await verificationStatus(f.ws, { taskId: 'T1', checkIds: [] });
    assert.equal(stale.checks.find((c) => c.checkId === 'unit')?.status, 'stale');
    writeFileSync(file, 'export const a = 1;\n');
    const still = await verificationStatus(f.ws, { taskId: 'T1', checkIds: [] });
    assert.equal(still.checks.find((c) => c.checkId === 'unit')?.status, 'stale', 'restoring the file does not make the old receipt current');
    assert.equal(still.verified, false);
    const again = await runVerification(f.ws, { taskId: 'T1', checkIds: ['unit'] });
    assert.equal(again.completion.verified, true, 'a new run gives a new current receipt');
    // An edit reverted before Jevris looks was never seen stale: the receipt is still current.
    writeFileSync(file, 'export const a = 3;\n');
    writeFileSync(file, 'export const a = 1;\n');
    assert.equal((await verificationStatus(f.ws, { taskId: 'T1', checkIds: [] })).verified, true);
  } finally {
    f.done();
  }
});

test('the first verify after a lockfile commit or a branch switch is judged by its own receipt, not stale (JEV-0003)', async () => {
  const f = fixture();
  try {
    await approve(f.ws, [manifest('unit', 'process.exit(0)', { inputScopes: ['lib'] })]);
    assert.equal((await runVerification(f.ws, { taskId: 'T1', checkIds: ['unit'] })).completion.verified, true);
    writeFileSync(join(f.repo, 'package-lock.json'), '{"lockfileVersion":3}\n');
    git(f.repo, 'add', 'package-lock.json');
    git(f.repo, 'commit', '-q', '-m', 'lockfile');
    const afterLock = await runVerification(f.ws, { taskId: 'T1', checkIds: ['unit'] });
    assert.equal(afterLock.ran[0].receipt.outcome, 'passed');
    assert.equal(afterLock.completion.checks.find((c) => c.checkId === 'unit')?.status, 'passed');
    assert.equal(afterLock.completion.verified, true, 'the receipt just written is not invalidated by the change it already reflects');
    git(f.repo, 'checkout', '-q', '-b', 'other');
    const afterBranch = await runVerification(f.ws, { taskId: 'T1', checkIds: ['unit'] });
    assert.equal(afterBranch.completion.checks.find((c) => c.checkId === 'unit')?.status, 'passed');
    assert.equal(afterBranch.completion.verified, true);
  } finally {
    f.done();
  }
});

test('a receipt made before a lockfile commit or a branch switch is still invalidated when nothing re-ran (JEV-0003)', async () => {
  const f = fixture();
  try {
    await approve(f.ws, [manifest('unit', 'process.exit(0)', { inputScopes: ['lib'] })]);
    assert.equal((await runVerification(f.ws, { taskId: 'T1', checkIds: ['unit'] })).completion.verified, true);
    writeFileSync(join(f.repo, 'package-lock.json'), '{"lockfileVersion":3}\n');
    git(f.repo, 'add', 'package-lock.json');
    git(f.repo, 'commit', '-q', '-m', 'lockfile');
    const lock = await verificationStatus(f.ws, { taskId: 'T1', checkIds: [] });
    assert.equal(lock.checks.find((c) => c.checkId === 'unit')?.status, 'stale');
    assert.equal(lock.verified, false);
    assert.equal((await runVerification(f.ws, { taskId: 'T1', checkIds: ['unit'] })).completion.verified, true);
    git(f.repo, 'checkout', '-q', '-b', 'other');
    const branch = await verificationStatus(f.ws, { taskId: 'T1', checkIds: [] });
    assert.equal(branch.checks.find((c) => c.checkId === 'unit')?.status, 'stale');
    assert.equal(branch.verified, false);
  } finally {
    f.done();
  }
});

test('a check whose inputs change during the run is unknown, never passed', async () => {
  const f = fixture();
  try {
    const target = join(f.repo, 'lib', 'a.js').replace(/\\/g, '\\\\');
    const m = manifest('mutate', `require('node:fs').writeFileSync('${target}', 'changed')`, { inputScopes: ['lib'] });
    const run = await runCheck(m, { workspaceRoot: f.repo, workspaceId: f.ws.workspaceId, evidence: f.ws.evidence, receipts: f.ws.receipts });
    assert.equal(run.receipt.outcome, 'unknown');
    assert.equal(run.receipt.outcomeReason, 'inputs-changed-during-run');
    assert.ok(readFileSync(join(f.repo, 'lib', 'a.js'), 'utf8').includes('changed'));
    assert.equal((await snapshotRevision(f.repo)).kind, 'git');
  } finally {
    f.done();
  }
});

test('one git status answers the snapshot, identical to asking git step by step; an unchanged snapshot is not written again (VER-03, VER-05 slice)', async () => {
  const { nodeGit, refreshFreshness } = await import('../dist/index.js');
  const dir = tempDir('jv-snap-');
  const repo = join(dir, 'repo with spaces');
  mkdirSync(repo, { recursive: true });
  const real = nodeGit();
  const calls = [];
  const counted = { run: (args, cwd) => (calls.push(args[0]), real.run(args, cwd)) };
  const stepwise = { run: (args, cwd) => (args.includes('--porcelain=v2') ? { ok: false, stdout: '' } : real.run(args, cwd)) };
  const same = async (label, root = repo) => {
    calls.length = 0;
    const one = await snapshotRevision(root, counted);
    assert.deepEqual(one, await snapshotRevision(root, stepwise), label);
    return one;
  };
  try {
    await same('outside git');
    git(repo, 'init', '-q');
    await same('empty repository');
    assert.equal(calls.length, 1, 'one git process for a work tree');
    writeFileSync(join(repo, 'a b.txt'), 'x');
    assert.equal((await same('untracked before the first commit')).head, 'no-commit');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'one');
    await same('clean');
    writeFileSync(join(repo, 'a b.txt'), 'y');
    mkdirSync(join(repo, 'sub', 'deep'), { recursive: true });
    writeFileSync(join(repo, 'sub', 'deep', 'n.txt'), 'n');
    await same('modified and untracked');
    await same('from a subdirectory', join(repo, 'sub'));
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'two');
    git(repo, 'mv', join('sub', 'deep', 'n.txt'), 'moved.txt');
    await same('a staged move');
    git(repo, 'commit', '-qm', 'three');
    git(repo, 'checkout', '-q', '--detach');
    assert.equal((await same('detached')).branch, null);
    git(repo, 'checkout', '-q', '-b', 'x');
    writeFileSync(join(repo, 'moved.txt'), 'x1');
    git(repo, 'commit', '-qam', 'x');
    git(repo, 'checkout', '-q', 'HEAD~1');
    git(repo, 'checkout', '-q', '-b', 'y');
    writeFileSync(join(repo, 'moved.txt'), 'y1');
    git(repo, 'commit', '-qam', 'y');
    spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'merge', '-q', 'x'], { cwd: repo });
    assert.deepEqual((await same('unmerged')).dirty.map((row) => row.status), ['UU']);

    // The freshness snapshot is written when it changes, and not again when it does not.
    let writes = 0;
    const store = new Map();
    const state = {
      get: (c, id) => store.get(`${c}/${id}`),
      list: () => [],
      transact: async (fn) => fn({ get: (c, id) => store.get(`${c}/${id}`), list: () => [], put: (c, id, v) => (writes += 1, store.set(`${c}/${id}`, v)), delete: () => {} }),
    };
    const receipts = { list: () => [], invalidate: async () => {} };
    const input = { workspaceRoot: repo, workspaceId: 'w1', receipts, state };
    await refreshFreshness(input);
    await refreshFreshness(input);
    assert.equal(writes, 1, 'an unchanged snapshot is not written again');
    writeFileSync(join(repo, 'moved.txt'), 'resolved');
    await refreshFreshness(input);
    assert.equal(writes, 2, 'a changed snapshot is written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

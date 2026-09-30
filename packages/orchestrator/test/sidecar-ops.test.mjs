import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { surfacePayloadContract } from '@jevris/contracts';
import { approveManifests, LOCAL_PAYLOAD_OPS, manifestHash, openWorkspace, outputRecordOf, parseManifest, runVerification, sidecarOps, SURFACE_OP_OF } from '../dist/index.js';
import { scheduleVerification, verificationRunKey } from '../dist/verify/runs.js';
import { closeTestStore, testStore } from './store-fixture.mjs';

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

async function fixture({ approve = true } = {}) {
  const dir = tempDir('jv-ops-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  const store = testStore(dir);
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
  if (approve) {
    // The check prints a credential-shaped token so evidence.get must redact it.
    const m = parseManifest({ id: 'unit', argv: [process.execPath, '-e', "console.log('ok sk-ant-api03-abcdef')"], resultFormat: 'exit-code' }).manifest;
    await approveManifests(ws, [m], { unit: manifestHash(m) }, 'test');
  }
  const traces = [];
  const ctx = (op, body) => ({
    op,
    client: 'cli',
    scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'],
    workspace: { id: ws.workspaceId, root: ws.workspaceRoot },
    body,
    home,
    signal: new AbortController().signal,
    // A long request deadline: these tests check what a finished run reports (the answer window is 40% of it).
    deadline: { budgetMs: 20_000, remainingMs: () => 20_000, expired: () => false },
    store,
    killSwitchStopped: false,
    engine: undefined,
    trace: (e) => traces.push(e),
  });
  return { ws, ctx, traces, done: () => {
      closeTestStore(store);
      rmSync(dir, { recursive: true, force: true });
    } };
}

const op = (name) => sidecarOps.find((o) => o.op === name);

function assertContract(name, outcome) {
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  const checked = surfacePayloadContract(SURFACE_OP_OF[name]).validate(outcome.body);
  assert.equal(checked.ok, true, JSON.stringify(checked));
}

test('registry: every op names a payload contract, a least-privilege scope and never a built-in name', () => {
  const builtins = ['ping', 'health', 'shutdown', 'status', 'event', 'plan', 'workspace.register', 'workspace.list', 'egress.check'];
  for (const o of sidecarOps) {
    assert.ok(SURFACE_OP_OF[o.op] !== undefined || LOCAL_PAYLOAD_OPS.includes(o.op), o.op);
    assert.ok(!builtins.includes(o.op), o.op);
  }
  assert.equal(op('verify').scope, 'submit');
  assert.equal(op('verify').stoppedByKillSwitch, true);
  assert.equal(op('verify.status').scope, 'status');
  assert.equal(op('evidence.get').scope, 'status');
  assert.equal(op('verification.record').scope, 'checkpoint');
  // ORC-07: preparing and approving an integration are CLI-only (submit scope); reading is status.
  assert.equal(op('integration.run').scope, 'submit');
  assert.equal(op('integration.run').stoppedByKillSwitch, true);
  assert.equal(op('integration.approve').scope, 'submit');
  assert.equal(op('integration.approve').stoppedByKillSwitch, true);
  assert.equal(op('integration.get').scope, 'status');
});

test('A\'s bug 2: a run that misses its answer window but ends during the status read counts as run; the answer never says running beside the run\'s own result', async () => {
  const f = await fixture();
  let release = () => undefined;
  try {
    const base = f.ctx('verify', { taskId: null, checkIds: [] });
    // A run already under way for the workspace: its check has run, and it ends only when released.
    const gate = new Promise((r) => (release = r));
    let checked = () => undefined;
    const ran = new Promise((r) => (checked = r));
    void scheduleVerification(verificationRunKey(f.ws.workspaceId, null), [], async () => {
      const outcome = await runVerification(f.ws, { taskId: null, checkIds: ['unit'], store: base.store });
      checked();
      await gate;
      return outcome;
    }, () => undefined);
    await ran;
    // The answer window is closed at once (900 ms is only the margins); the second look at the
    // deadline, taken once the status read has started, ends the run.
    let looks = 0;
    const deadline = { budgetMs: 20_000, remainingMs: () => ((looks += 1), looks === 2 && release(), looks === 1 ? 900 : 20_000), expired: () => false };
    const out = await op('verify').handle({ ...base, deadline });
    assertContract('verify', out);
    assert.deepEqual([out.body.ran, out.body.readiness, out.body.checks[0].reasonCode === 'RUNNING'], [true, 'verified', false], JSON.stringify(out.body));
  } finally {
    release();
    f.done();
  }
});

test('verify runs approved checks and its body validates against the verify payload contract', async () => {
  const f = await fixture();
  try {
    const out = await op('verify').handle(f.ctx('verify', { taskId: null, checkIds: [] }));
    assertContract('verify', out);
    assert.equal(out.body.ran, true);
    assert.equal(out.body.readiness, 'verified');
    assert.equal(out.body.checks[0].outcome, 'passed');
    // Log reduction on the product path (US15): the check's stored output has a view record.
    const handle = f.ws.receipts.list(f.ws.workspaceId)[0].receipt.rawOutputHandle;
    const rec = outputRecordOf(f.ws, handle);
    assert.deepEqual([rec.exitCode, rec.errorState, rec.mode], [0, 'succeeded', 'passthrough']);
    assert.equal(rec.viewText, '', 'credential-shaped output is never rewritten into a view');
    const status = await op('verify.status').handle(f.ctx('verify.status', { taskId: null, checkIds: [] }));
    assertContract('verify.status', status);
    assert.equal(status.body.ran, false);
    assert.equal(status.body.checks[0].fresh, true);
  } finally {
    f.done();
  }
});

test('verify.required refreshes freshness first: a receipt from revision A is stale, not passed, after the inputs move to B (US17)', async () => {
  const f = await fixture();
  try {
    assert.equal((await op('verify').handle(f.ctx('verify', { taskId: null, checkIds: ['unit'] }))).body.readiness, 'verified');
    const onA = await op('verify.required').handle(f.ctx('verify.required', { checkIds: ['unit'] }));
    assert.deepEqual(onA.body.checks.map((c) => [c.status, c.stale]), [['passed', false]]);
    writeFileSync(join(f.ws.workspaceRoot, 'a.txt'), 'b\n');
    git(f.ws.workspaceRoot, 'commit', '-q', '-am', 'B');
    // No verify.status call in between: verify.required alone must see the move.
    const onB = await op('verify.required').handle(f.ctx('verify.required', { checkIds: ['unit'] }));
    assert.deepEqual(onB.body.checks.map((c) => [c.checkId, c.status, c.stale]), [['unit', 'missing', true]]);
    assert.equal((await op('verify').handle(f.ctx('verify', { taskId: null, checkIds: ['unit'] }))).body.readiness, 'verified');
    const again = await op('verify.required').handle(f.ctx('verify.required', { checkIds: ['unit'] }));
    assert.deepEqual(again.body.checks.map((c) => [c.status, c.stale]), [['passed', false]], 'a new receipt on B passes');
  } finally {
    f.done();
  }
});

test('a check that needs another environment is not-run and counted as missing, never as passed (VER-02, W12)', async () => {
  const f = await fixture({ approve: false });
  try {
    const build = parseManifest({ id: 'build', argv: [process.execPath, '-e', '0'], resultFormat: 'exit-code' }).manifest;
    const device = parseManifest({ id: 'device', argv: [process.execPath, '-e', '0'], resultFormat: 'exit-code', hardware: 'bench-1' }).manifest;
    await approveManifests(f.ws, [build, device], { build: manifestHash(build), device: manifestHash(device) }, 'test');
    const out = await op('verify').handle(f.ctx('verify', { taskId: null, checkIds: [] }));
    assertContract('verify', out);
    assert.equal(out.body.readiness, 'needs-environment', 'software checks pass; only the device check waits for bench-1');
    assert.deepEqual(out.body.checks.map((c) => [c.checkId, c.outcome, c.reasonCode, c.environment]), [['build', 'passed', null, null], ['device', 'not-run', 'HARDWARE_UNAVAILABLE', 'bench-1']]);
    assert.deepEqual(out.body.missing, ['device'], 'the not-run device check is counted');
    assert.deepEqual(out.body.needsEnvironment, ['device']);
    // A failing software check keeps the answer not-verified even with a device check waiting.
    const broken = parseManifest({ id: 'build', argv: [process.execPath, '-e', 'process.exit(3)'], resultFormat: 'exit-code' }).manifest;
    await approveManifests(f.ws, [broken, device], { build: manifestHash(broken), device: manifestHash(device) }, 'test');
    const again = await op('verify').handle(f.ctx('verify', { taskId: null, checkIds: [] }));
    assertContract('verify', again);
    assert.equal(again.body.readiness, 'not-verified');
    assert.deepEqual(again.body.checks.map((c) => [c.checkId, c.reasonCode]), [['build', 'EXIT_NONZERO'], ['device', 'HARDWARE_UNAVAILABLE']]);
    assert.deepEqual(again.body.missing, ['build', 'device']);
  } finally {
    f.done();
  }
});

test('verify.status with no approved manifest answers no-checks; a bad body is refused', async () => {
  const f = await fixture({ approve: false });
  try {
    const out = await op('verify.status').handle(f.ctx('verify.status', { taskId: null, checkIds: [] }));
    assertContract('verify.status', out);
    assert.equal(out.body.readiness, 'no-checks');
    const bad = await op('verify.status').handle(f.ctx('verify.status', { taskId: 'x y', checkIds: [] }));
    assert.deepEqual(bad, { ok: false, reasonCode: 'INVALID_REQUEST' });
  } finally {
    f.done();
  }
});

test('evidence.get returns a redacted, contract-valid view and is scoped to the workspace', async () => {
  const f = await fixture();
  try {
    await op('verify').handle(f.ctx('verify', { taskId: null, checkIds: [] }));
    const receipt = f.ws.receipts.list(f.ws.workspaceId)[0].receipt;
    const out = await op('evidence.get').handle(f.ctx('evidence.get', { handle: receipt.rawOutputHandle }));
    assertContract('evidence.get', out);
    assert.equal(out.body.found, true);
    assert.ok(!out.body.text.includes('sk-ant-'));
    assert.ok(out.body.text.includes('[redacted]'));
    // US15: how the output was shown to the model rides along with the original.
    assert.deepEqual([out.body.output.exitCode, out.body.output.errorState, out.body.output.mode, out.body.output.passthroughReason], [0, 'succeeded', 'passthrough', 'sensitive']);
    assert.equal(out.body.output.view, '');
    const missing = await op('evidence.get').handle(f.ctx('evidence.get', { handle: `ev:${'0'.repeat(64)}` }));
    assertContract('evidence.get', missing);
    assert.equal(missing.body.found, false);
  } finally {
    f.done();
  }
});

async function longOutputFixture(script) {
  const f = await fixture({ approve: false });
  const m = parseManifest({ id: 'big', argv: [process.execPath, '-e', script], resultFormat: 'exit-code', timeoutMs: 60_000 }).manifest;
  await approveManifests(f.ws, [m], { big: manifestHash(m) }, 'test');
  await op('verify').handle(f.ctx('verify', { taskId: null, checkIds: [] }));
  const receipt = f.ws.receipts.list(f.ws.workspaceId)[0].receipt;
  const get = () => op('evidence.get').handle(f.ctx('evidence.get', { handle: receipt.rawOutputHandle }));
  return { f, get };
}

test('evidence.get on a long output keeps its start and its end, not only the start (JEV-0025)', async () => {
  const { f, get } = await longOutputFixture("for (let i = 0; i < 12000; i++) console.log('line ' + i + ' ' + 'p'.repeat(20)); console.log('FAILED at the very end');");
  try {
    const out = await get();
    assertContract('evidence.get', out);
    const text = out.body.text;
    assert.equal(out.body.truncated, true);
    assert.ok(out.body.byteLength > 300_000);
    assert.ok(text.length <= 65_000, String(text.length));
    assert.match(text, /^line 0 p{20}\n/);
    assert.match(text, /\nFAILED at the very end\n\n--- stderr ---\n$/, 'the tail of the output is what a failure ends with');
    assert.match(text, /line 11999 p{20}\n/);
    assert.match(text, /^\.\.\. \[\d+ characters omitted from the middle; the full output stays in the local evidence store\] \.\.\.$/m);
    assert.equal(text.includes('line 6000 '), false, 'the middle is what is left out');
    // Cuts fall on line boundaries: every line of the kept text is a whole line.
    for (const line of text.split('\n')) assert.match(line, /^(line \d+ p{20}|FAILED at the very end|--- stderr ---|\.\.\. \[.*\] \.\.\.|)$/);
  } finally {
    f.done();
  }
});

test('a credential the tail cut would split is never returned, whole or in part (JEV-0025)', async () => {
  // The stored text ends with a 16-character stderr separator, so the last 28,000 characters start 24 characters into the key; the cut moves past the key.
  const { f, get } = await longOutputFixture("process.stdout.write('a'.repeat(40_000) + ' sk-ant-api03-abcdefghij1234567890 ' + 'b'.repeat(27_974));");
  try {
    const out = await get();
    assertContract('evidence.get', out);
    assert.equal(out.body.truncated, true);
    assert.doesNotMatch(out.body.text, /sk-ant|api03|abcdefghij|1234567890/);
    assert.match(out.body.text, /omitted from the middle/);
    assert.match(out.body.text, /b{100}\n--- stderr ---\n$/, 'the end of the output is kept');
  } finally {
    f.done();
  }
});

test('evidence.get masks password assignments, Authorization headers and JWTs in the text and the view (JEV-0026)', async () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const script = `console.log('connecting with password=hunter2hunter2-password-value'); console.log('Authorization: Bearer ${jwt}'); console.error('the password field is required'); process.exit(1);`;
  const { f, get } = await longOutputFixture(script);
  try {
    const out = await get();
    assertContract('evidence.get', out);
    for (const shown of [out.body.text, out.body.output.view]) {
      assert.doesNotMatch(shown, /hunter2|eyJhbGci|dozjgNry/);
    }
    assert.match(out.body.text, /password=\[redacted\]/);
    assert.match(out.body.text, /Authorization: Bearer \[redacted\]/);
    assert.match(out.body.text, /the password field is required/, 'prose about a password is left alone');
  } finally {
    f.done();
  }
});

test('verification.record points at a current receipt, never creates one, and refuses asserted outcomes', async () => {
  const f = await fixture();
  try {
    await op('verify').handle(f.ctx('verify', { taskId: null, checkIds: [] }));
    const receipt = f.ws.receipts.list(f.ws.workspaceId)[0].receipt;
    const ok = await op('verification.record').handle(f.ctx('verification.record', { receiptId: receipt.id, checkId: 'unit', taskId: 'T1' }));
    assertContract('verification.record', ok);
    assert.equal(ok.body.accepted, true);
    assert.equal(ok.body.receiptCreated, false);
    const wrong = await op('verification.record').handle(f.ctx('verification.record', { receiptId: receipt.id, checkId: 'lint', taskId: null }));
    assertContract('verification.record', wrong);
    assert.equal(wrong.body.reasonCode, 'CHECK_MISMATCH');
    const none = await op('verification.record').handle(f.ctx('verification.record', { receiptId: 'rcpt-nope', checkId: 'unit', taskId: null }));
    assert.equal(none.body.reasonCode, 'RECEIPT_NOT_FOUND');
    const forged = await op('verification.record').handle(
      f.ctx('verification.record', { receiptId: receipt.id, checkId: 'unit', taskId: null, outcome: 'passed' }),
    );
    assert.deepEqual(forged, { ok: false, reasonCode: 'INVALID_REQUEST' });
    assert.equal(f.ws.receipts.list(f.ws.workspaceId).length, 1);
  } finally {
    f.done();
  }
});

import { drainBackgroundWorkers, setTaskOpDeps, submitPlan, DEFAULT_CONFIG as DEFAULTS } from '../dist/index.js';
import { jevrisPaths } from '@jevris/platform';
import { tempDir } from './temp-dirs.mjs';

test('task.submit queues without automatic workers, and task.get/cancel answer with contract-valid task views', async () => {
  const f = await fixture();
  try {
    // Orchestration is on from install; this test is about the queue, so it turns it off.
    const dir = jevrisPaths({ home: f.ws.home }).config;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'jevris.config.json'), JSON.stringify({ ...DEFAULTS, orchestration: { ...DEFAULTS.orchestration, enabled: false } }));
    await submitPlan(f.ws, {
      tasks: [{ id: 'T1', requirementIds: ['R1'], acceptanceCheckIds: ['unit'], expectedOutputs: ['patch'], writeScopes: ['a'] }],
      ownerId: 'alice',
      channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 1_000_000 },
    });
    const node = { id: 'T2', requirementIds: ['R1'], acceptanceCheckIds: ['unit'], expectedOutputs: ['patch'], writeScopes: ['b'], rootBudgetId: 'b1' };
    const submitted = await op('task.submit').handle(f.ctx('task.submit', { task: node }));
    assertContract('task.submit', submitted);
    assert.deepEqual(submitted.body, { accepted: true, taskId: 'T2', leaseIds: [], reasonCode: 'QUEUED' });
    const dup = await op('task.submit').handle(f.ctx('task.submit', { task: node }));
    assert.equal(dup.body.accepted, false);
    const noBudget = await op('task.submit').handle(f.ctx('task.submit', { task: { ...node, id: 'T3', rootBudgetId: 'zz' } }));
    assert.equal(noBudget.body.reasonCode, 'NO_ROOT_BUDGET');
    const got = await op('task.get').handle(f.ctx('task.get', { taskId: 'T2' }));
    assertContract('task.get', got);
    assert.equal(got.body.task.state, 'validated');
    const missing = await op('task.get').handle(f.ctx('task.get', { taskId: 'nope' }));
    assert.equal(missing.body.found, false);
    const cancelled = await op('task.cancel').handle(f.ctx('task.cancel', { taskId: 'T2' }));
    assertContract('task.cancel', cancelled);
    assert.equal(cancelled.body.task.state, 'cancelled');
    assert.equal(op('task.submit').scope, 'submit');
    assert.equal(op('task.get').scope, 'status');
  } finally {
    f.done();
  }
});

test('with bounded-auto workers, task.submit reports the real lease id and the worker runs in the background (ORC-05)', async () => {
  const f = await fixture();
  try {
    const dir = jevrisPaths({ home: f.ws.home }).config;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'jevris.config.json'),
      JSON.stringify({ ...DEFAULTS, routing: { ...DEFAULTS.routing, managedWorkers: 'bounded-auto' }, orchestration: { ...DEFAULTS.orchestration, enabled: true } }),
    );
    await submitPlan(f.ws, {
      tasks: [{ id: 'T1', requirementIds: ['R1'], acceptanceCheckIds: ['unit'], expectedOutputs: ['patch'], writeScopes: ['a'] }],
      ownerId: 'alice',
      channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 1_000_000 },
    });
    let ran = 0;
    setTaskOpDeps({
      workerPort: async () => ({
        async run(input) {
          ran += 1;
          writeFileSync(join(input.cwd, 'a.txt'), 'changed\n');
          return { status: 'completed', reason: 'success', sessionId: 's', requestedModel: input.model, actualModel: input.model, costUsd: 0.01, usage: null, turns: 1, durationMs: 1 };
        },
      }),
    });
    const node = { id: 'T2', requirementIds: ['R1'], acceptanceCheckIds: ['unit'], expectedOutputs: ['patch'], writeScopes: ['a.txt'], rootBudgetId: 'b1', models: ['claude-sonnet'] };
    const out = await op('task.submit').handle(f.ctx('task.submit', { task: node }));
    assertContract('task.submit', out);
    assert.equal(out.body.leaseIds.length, 1);
    assert.equal(out.body.reasonCode, 'LEASED');
    await drainBackgroundWorkers();
    assert.equal(ran, 1);
    const got = await op('task.get').handle(f.ctx('task.get', { taskId: 'T2' }));
    assert.equal(got.body.task.state, 'awaiting-evidence');
  } finally {
    setTaskOpDeps({});
    f.done();
  }
});

test('plan.submit is CLI-only and kill-switch stopped; it creates the budget and tasks, and task.submit then extends the plan (ORC-01)', async () => {
  const f = await fixture();
  try {
    const { SIDECAR_CLIENT_SCOPES } = await import('@jevris/contracts');
    const { OWNED_MODE_OP } = await import('../dist/index.js');
    const planOp = op('plan.submit');
    assert.equal(planOp.scope, 'submit');
    assert.equal(planOp.stoppedByKillSwitch, true);
    assert.ok(!SIDECAR_CLIENT_SCOPES.mcp.includes('submit') && !SIDECAR_CLIENT_SCOPES.hook.includes('submit'), 'mcp and hook never hold the submit scope');
    assert.equal(OWNED_MODE_OP, 'task.submit', 'owned mode grants mcp task.submit only, never plan.submit');
    const tasks = [
      { id: 'P1', requirementIds: ['R1'], acceptanceCheckIds: ['unit'], expectedOutputs: ['patch'], writeScopes: ['a'] },
      { id: 'P2', requirementIds: ['R1'], acceptanceCheckIds: ['unit'], expectedOutputs: ['patch'], writeScopes: ['b'], dependencyIds: ['P1'] },
    ];
    const body = { plan: { tasks }, ownerId: 'alice', channel: 'terminal', rootBudget: { id: 'pb1', limitMicroUsd: 2_000_000, shutdownReserveMicroUsd: 100_000 } };
    // No worker port here: nothing is leased, and no harness is started from this test.
    setTaskOpDeps({ workerPort: async () => null });
    const out = await planOp.handle(f.ctx('plan.submit', body)).finally(() => setTaskOpDeps({}));
    assert.equal(out.ok, true);
    assert.equal(out.body.accepted, true, JSON.stringify(out.body));
    assert.equal(out.body.reasonCode, 'SUBMITTED');
    assert.match(out.body.planId, /^plan-[a-f0-9]{20}$/);
    assert.equal(out.body.rootBudgetId, 'pb1');
    assert.deepEqual(out.body.taskIds, ['P1', 'P2']);
    assert.deepEqual(out.body.waves, [['P1'], ['P2']]);
    assert.deepEqual(out.body.leaseIds, [], 'no worker port, no lease');
    assert.equal(f.ws.host.get('budgets', 'pb1').limitMicroUsd, 2_000_000);
    // The budget now exists, so task.submit (the one op owned mode grants mcp) succeeds.
    const extra = { id: 'P3', requirementIds: ['R1'], acceptanceCheckIds: ['unit'], expectedOutputs: ['patch'], writeScopes: ['c'], dependencyIds: ['P2'], rootBudgetId: 'pb1' };
    const added = await op('task.submit').handle(f.ctx('task.submit', { task: extra }));
    assertContract('task.submit', added);
    assert.equal(added.body.accepted, true, JSON.stringify(added.body));
    // Refusals are truthful: the same ids again, a conflicting budget, an unapproved check.
    const again = await planOp.handle(f.ctx('plan.submit', body));
    assert.deepEqual([again.body.accepted, again.body.reasonCode, again.body.planId], [false, 'DUPLICATE_TASK', null]);
    const conflict = await planOp.handle(f.ctx('plan.submit', { ...body, plan: { tasks: [{ ...tasks[0], id: 'Q1' }] }, channel: 'terminal', rootBudget: { id: 'pb1', limitMicroUsd: 9_000_000 } }));
    assert.equal(conflict.body.reasonCode, 'BUDGET_CONFLICT');
    const unknownCheck = await planOp.handle(f.ctx('plan.submit', { ...body, plan: { tasks: [{ ...tasks[0], id: 'Q2', acceptanceCheckIds: ['nope'] }] }, channel: 'terminal', rootBudget: { id: 'pb2', limitMicroUsd: 1_000 } }));
    assert.equal(unknownCheck.body.reasonCode, 'PLAN_INVALID');
    assert.ok(unknownCheck.body.issues.some((i) => i.code === 'UNKNOWN_CHECK' && i.detail === 'nope'));
    assert.equal(f.ws.host.get('budgets', 'pb2'), undefined, 'a refused plan writes no budget');
    for (const bad of [
      undefined,
      { plan: { tasks: [] }, ownerId: 'alice', channel: 'terminal', rootBudget: { id: 'x1', limitMicroUsd: 1 } },
      { ...body, extra: 1 },
      { ...body, ownerId: '' },
      { ...body, channel: 'terminal', rootBudget: { id: 'x1', limitMicroUsd: -1 } },
      { ...body, channel: 'terminal', rootBudget: { id: 'x1', limitMicroUsd: 10, shutdownReserveMicroUsd: 10 } },
      { ...body, channel: 'terminal', rootBudget: { id: 'x1', limitMicroUsd: 10, policy: 'spend-it-all' } },
      { ...body, plan: { tasks, sneaky: true } },
      { ...body, plan: { tasks: [{ id: 5 }] } },
    ]) {
      assert.equal((await planOp.handle(f.ctx('plan.submit', bad))).reasonCode, 'INVALID_REQUEST', JSON.stringify(bad));
    }
    const noWorkspace = await planOp.handle({ ...f.ctx('plan.submit', body), workspace: { id: null, root: null } });
    assert.equal(noWorkspace.reasonCode, 'WORKSPACE_ROOT_UNKNOWN');
  } finally {
    f.done();
  }
});

test('plan.submit creates a root budget only for a person: a terminal authorization or the terminal channel; a plan under an existing budget needs neither (SR-1)', async () => {
  const f = await fixture();
  try {
    const { mintAuthorization } = await import('@jevris/store');
    const planOp = op('plan.submit');
    const task = (id, extra = {}) => ({ id, requirementIds: ['R1'], acceptanceCheckIds: ['unit'], expectedOutputs: ['patch'], writeScopes: [id.toLowerCase()], ...extra });
    const submit = (body) => {
      setTaskOpDeps({ workerPort: async () => null });
      return planOp.handle(f.ctx('plan.submit', body)).finally(() => setTaskOpDeps({}));
    };
    // A script or a model's shell: no authorization, no terminal. Nothing is written.
    const scripted = await submit({ plan: { tasks: [task('G1')] }, ownerId: 'alice', rootBudget: { id: 'gb1', limitMicroUsd: 5_000_000 } });
    assert.deepEqual([scripted.body.accepted, scripted.body.reasonCode, scripted.body.planId], [false, 'CHANNEL_REFUSED', null]);
    assert.equal(f.ws.host.get('budgets', 'gb1'), undefined, 'a refused plan writes no budget');
    assert.ok(f.traces.some((t) => t.event === 'orchestrator.plan-refused' && t.reasonCode === 'CHANNEL_REFUSED'));
    // An authorization that was never minted, one for another budget, or one used by someone else.
    const forOther = mintAuthorization(f.ws.store, { principal: 'alice', actionClass: 'budget.increase', scope: 'other', ttlMs: 60_000, channel: 'terminal', nowMs: Date.now() });
    const forGb1 = mintAuthorization(f.ws.store, { principal: 'alice', actionClass: 'budget.increase', scope: 'gb1', ttlMs: 60_000, channel: 'terminal', nowMs: Date.now() });
    assert.equal(forOther.ok && forGb1.ok, true);
    for (const [authorizationId, actor] of [['anone', 'alice'], [forOther.authorizationId, 'alice'], [forGb1.authorizationId, 'mallory']]) {
      const out = await submit({ plan: { tasks: [task('G1')] }, ownerId: 'alice', authorizationId, actor, rootBudget: { id: 'gb1', limitMicroUsd: 5_000_000 } });
      assert.equal(out.body.reasonCode, 'AUTHORIZATION_REFUSED', `${authorizationId} ${actor}`);
    }
    assert.equal(f.ws.host.get('budgets', 'gb1'), undefined);
    // The same authorization the right person minted at a terminal for gb1: accepted, once.
    const authorized = await submit({ plan: { tasks: [task('G1')] }, ownerId: 'alice', authorizationId: forGb1.authorizationId, actor: 'alice', rootBudget: { id: 'gb1', limitMicroUsd: 5_000_000 } });
    assert.deepEqual([authorized.body.accepted, authorized.body.reasonCode], [true, 'SUBMITTED'], JSON.stringify(authorized.body));
    assert.equal(f.ws.host.get('budgets', 'gb1').limitMicroUsd, 5_000_000);
    const reused = await submit({ plan: { tasks: [task('G9')] }, ownerId: 'alice', authorizationId: forGb1.authorizationId, actor: 'alice', rootBudget: { id: 'gb9', limitMicroUsd: 1 } });
    assert.equal(reused.body.reasonCode, 'AUTHORIZATION_REFUSED', 'single use, and scoped to one budget id');
    // A plan under the budget someone already created needs no terminal (it cannot raise it: BUDGET_CONFLICT).
    const within = await submit({ plan: { tasks: [task('G2')] }, ownerId: 'alice', rootBudget: { id: 'gb1', limitMicroUsd: 5_000_000 } });
    assert.deepEqual([within.body.accepted, within.body.reasonCode], [true, 'SUBMITTED'], JSON.stringify(within.body));
    const raise = await submit({ plan: { tasks: [task('G3')] }, ownerId: 'alice', rootBudget: { id: 'gb1', limitMicroUsd: 9_000_000 } });
    assert.equal(raise.body.reasonCode, 'BUDGET_CONFLICT');
    // A person at a terminal (the CLI sends channel only after an interactive answer).
    const atTerminal = await submit({ plan: { tasks: [task('G4')] }, ownerId: 'alice', channel: 'terminal', rootBudget: { id: 'gb2', limitMicroUsd: 1_000_000 } });
    assert.equal(atTerminal.body.accepted, true, JSON.stringify(atTerminal.body));
    // Malformed gate fields are refused before anything is read.
    for (const extra of [{ channel: 'mcp' }, { actor: 'alice' }, { authorizationId: 'anone' }, { authorizationId: 'anone', actor: 'bad actor' }, { authorizationId: 7, actor: 'alice' }]) {
      const bad = await planOp.handle(f.ctx('plan.submit', { plan: { tasks: [task('G5')] }, ownerId: 'alice', rootBudget: { id: 'gb3', limitMicroUsd: 1 }, ...extra }));
      assert.equal(bad.reasonCode, 'INVALID_REQUEST', JSON.stringify(extra));
    }
  } finally {
    f.done();
  }
});

test('task.reconcile is CLI-only and refused while the kill switch is stopped; with nothing held it reconciles nothing (GOV-03, US40)', async () => {
  const f = await fixture();
  try {
    const reconcile = op('task.reconcile');
    assert.equal(reconcile.scope, 'submit', 'mcp and hook never reach it');
    assert.equal(reconcile.stoppedByKillSwitch, true, 'reconcile only after clear');
    assert.deepEqual(await reconcile.handle(f.ctx('task.reconcile', { taskId: 'T1', resolution: 'maybe' })), { ok: false, reasonCode: 'INVALID_REQUEST' });
    assert.deepEqual(await reconcile.handle(f.ctx('task.reconcile', { taskId: 'T1', resolution: 'applied', actor: 'a b' })), { ok: false, reasonCode: 'INVALID_REQUEST' });
    const none = await reconcile.handle(f.ctx('task.reconcile', { taskId: 'T1', resolution: 'applied' }));
    assert.equal(none.ok, true);
    assert.equal(none.body.reconciled, false);
    assert.equal(none.body.reasonCode, 'UNKNOWN_TASK');
    assert.equal(none.body.held, 0);
  } finally {
    f.done();
  }
});

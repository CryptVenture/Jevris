// jevris task reconcile (GOV-03, US40): a person settles an owned effect the kill switch held,
// through D's CLI-only task.reconcile op; the answer is checked before it is shown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runTaskCommand, checkReconcileResult } = await import('../dist/task-command.js');
const { TOOLS } = await import('../../../packages/mcp/dist/tools.js');

const RECONCILED = { reconciled: true, reasonCode: 'RECONCILED', taskId: 'T1', operationId: 'op-lease-1', effectState: 'acknowledged', taskState: 'ready', auditSeq: 7, held: 0 };

function sandbox(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-task-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const work = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(join(work, '.git'), { recursive: true });
  return { home, work, env: { JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0' } };
}

function fakePorts(answer) {
  const calls = [];
  return {
    calls,
    ports: {
      sidecar: {
        async ensure() {
          return { ok: true, endpoint: 'fake', started: false };
        },
        async request(input) {
          calls.push(input);
          return typeof answer === 'function' ? answer(input) : answer;
        },
      },
      engine: {},
      config: {},
    },
  };
}

async function task(box, argv, { ports, confirm = null } = {}) {
  let text = '';
  const code = await runTaskCommand(argv, (chunk) => (text += chunk), { ports, env: box.env, cwd: box.work, confirm });
  return { code, text, json: argv.includes('--json') && text.startsWith('{') ? JSON.parse(text) : null };
}

test('task reconcile needs a person: unconfirmed sends nothing; a yes answer or --yes reconciles (pair)', async (t) => {
  const box = sandbox(t);
  const fake = fakePorts({ ok: true, result: RECONCILED });
  assert.equal((await task(box, ['reconcile', 'T1', '--applied'], { ports: fake.ports })).code, 2);
  assert.equal((await task(box, ['reconcile', 'T1', '--applied', '--json'], { ports: fake.ports, confirm: async () => true })).code, 2, '--json needs --yes');
  assert.equal((await task(box, ['reconcile', 'T1', '--applied'], { ports: fake.ports, confirm: async () => false })).code, 2);
  assert.equal(fake.calls.length, 0);

  let asked = '';
  const yes = await task(box, ['reconcile', 'T1', '--applied'], { ports: fake.ports, confirm: async (q) => ((asked = q), true) });
  assert.equal(yes.code, 0);
  assert.match(asked, /task T1 as applied\?/);
  assert.equal(yes.text, 'Reconciled owned effect op-lease-1 as applied; task T1 is ready.\n');
  const request = fake.calls.at(-1);
  assert.deepEqual([request.op, request.scope, request.budget, request.workspace], ['task.reconcile', 'cli', 'hot', box.work]);
  assert.equal(request.body.taskId, 'T1');
  assert.equal(request.body.resolution, 'applied');

  const abandoned = await task(box, ['reconcile', 'T1', '--abandoned', '--yes', '--json'], { ports: fakePorts({ ok: true, result: { ...RECONCILED, effectState: 'abandoned' } }).ports });
  assert.equal(abandoned.code, 0);
  assert.deepEqual(abandoned.json, { schemaVersion: '1.0', command: 'task reconcile', ...RECONCILED, effectState: 'abandoned' });
});

test('task reconcile refuses bad input before asking, and reports what was not reconciled with exit 1', async (t) => {
  const box = sandbox(t);
  const fake = fakePorts({ ok: true, result: RECONCILED });
  for (const argv of [['reconcile'], ['reconcile', 'T1'], ['reconcile', 'T1', '--applied', '--abandoned'], ['reconcile', '../x', '--applied'], ['reconcile', 'T1', 'T2', '--applied'], ['undo', 'T1']]) {
    assert.equal((await task(box, [...argv, '--yes'], { ports: fake.ports })).code, 2, argv.join(' '));
  }
  assert.equal((await task(box, [], { ports: fake.ports })).code, 2);
  assert.equal(fake.calls.length, 0);

  const notHeld = await task(box, ['reconcile', 'T1', '--applied', '--yes'], { ports: fakePorts({ ok: true, result: { ...RECONCILED, reconciled: false, reasonCode: 'NOT_HELD', operationId: null, effectState: null, auditSeq: null } }).ports });
  assert.equal(notHeld.code, 1);
  assert.equal(notHeld.text, 'Nothing to reconcile for T1.\n');
  const stopped = await task(box, ['reconcile', 'T1', '--applied', '--yes', '--json'], { ports: fakePorts({ ok: false, reason: 'refused', reasonCode: 'KILL_SWITCH', message: 'stopped' }).ports });
  assert.equal(stopped.code, 1);
  assert.equal(stopped.json.reasonCode, 'KILL_SWITCH');
  const forged = await task(box, ['reconcile', 'T1', '--applied', '--yes', '--json'], { ports: fakePorts({ ok: true, result: { ...RECONCILED, taskId: 'T2' } }).ports });
  assert.equal(forged.json.reasonCode, 'SIDECAR_INVALID_RESULT');
});

test('the reconcile answer is checked, and no MCP tool can reconcile', () => {
  assert.deepEqual(checkReconcileResult(RECONCILED, 'T1'), RECONCILED);
  assert.equal(checkReconcileResult({ ...RECONCILED, reasonCode: 'NOT_HELD' }, 'T1'), null, 'reconciled must match its reason');
  assert.equal(checkReconcileResult({ ...RECONCILED, effectState: 'applied' }, 'T1'), null);
  assert.equal(checkReconcileResult({ ...RECONCILED, held: -1 }, 'T1'), null);
  assert.equal(TOOLS.some((tool) => /reconcile/.test(`${tool.name} ${tool.op ?? ''}`)), false);
});

// A cancel whose abort was delivered but whose run has not published its end yet is "cancel
// requested" (exit 0, CANCEL_PENDING); it is never "nothing was cancelled" (the E2E bench saw
// NOT_CANCELLED for a cancel that then took effect).
const taskView = (state, extra = {}) => ({ taskId: 'T1', found: true, task: { id: 'T1', state, revision: 'rev-3', requirementIds: ['R1'], dependencyIds: [], acceptanceCheckIds: ['fixed'] }, receipts: [], ...extra });
const cancelPorts = (afterCancel) => fakePorts((input) => ({ ok: true, result: input.op === 'task.cancel' ? afterCancel : taskView('running') }));

test('task cancel: a delivered abort whose run has not ended is CANCEL_PENDING with exit 0, never NOT_CANCELLED', async (t) => {
  const box = sandbox(t);
  const pending = await task(box, ['cancel', 'T1', '--yes', '--json'], { ports: cancelPorts(taskView('running', { cancelRequested: true })).ports });
  assert.equal(pending.code, 0, pending.text);
  assert.deepEqual([pending.json.cancelled, pending.json.cancelRequested, pending.json.reasonCode, pending.json.task.state], [false, true, 'CANCEL_PENDING', 'running']);
  const human = await task(box, ['cancel', 'T1', '--yes'], { ports: cancelPorts(taskView('running', { cancelRequested: true })).ports });
  assert.equal(human.code, 0);
  assert.match(human.text, /Cancel requested for task T1/);
  assert.doesNotMatch(human.text, /nothing was cancelled|was not cancelled/i);
  // The same pending answer when asked again while pending, and the plain answer once it is done.
  const again = await task(box, ['cancel', 'T1', '--yes', '--json'], { ports: cancelPorts(taskView('running', { cancelRequested: true })).ports });
  assert.deepEqual([again.code, again.json.reasonCode], [0, 'CANCEL_PENDING']);
  const done = await task(box, ['cancel', 'T1', '--yes', '--json'], { ports: cancelPorts(taskView('cancelled')).ports });
  assert.deepEqual([done.code, done.json.cancelled, done.json.reasonCode], [0, true, 'CANCELLED']);
});

test('task cancel: a task the sidecar did not cancel and no abort was delivered to stays NOT_CANCELLED with exit 1', async (t) => {
  const box = sandbox(t);
  const refused = await task(box, ['cancel', 'T1', '--yes', '--json'], { ports: cancelPorts(taskView('failed')).ports });
  assert.deepEqual([refused.code, refused.json.cancelled, refused.json.reasonCode, refused.json.cancelRequested], [1, false, 'NOT_CANCELLED', undefined]);
  // A cancel flag on a task that already ended is not a pending cancel either.
  const ended = await task(box, ['cancel', 'T1', '--yes', '--json'], { ports: cancelPorts(taskView('verified', { cancelRequested: true })).ports });
  assert.deepEqual([ended.code, ended.json.reasonCode], [1, 'NOT_CANCELLED']);
});

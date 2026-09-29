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

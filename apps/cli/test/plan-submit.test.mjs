// jevris plan --submit (ORC-01, ORC-05): the plan and its root budget go to D's CLI-only
// plan.submit op, only after a person confirms; the answer is checked before it is shown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runPublicCommand } = await import('../dist/public-commands.js');
const { checkPlanSubmitResult } = await import('../dist/plan-submit.js');
const { TOOLS } = await import('../../../packages/mcp/dist/tools.js');

const SUBMITTED = {
  accepted: true,
  reasonCode: 'SUBMITTED',
  planId: 'plan-0123456789abcdef0123',
  rootBudgetId: 'sprint-1',
  taskIds: ['a', 'b'],
  waves: [['a'], ['b']],
  leaseIds: [],
  issues: [],
};

function sandbox(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-plan-submit-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const work = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(join(work, '.git'), { recursive: true });
  const tasks = join(work, 'tasks.json');
  writeFileSync(tasks, JSON.stringify([{ id: 'a', writeScopes: ['src/a'], acceptanceCheckIds: ['unit'], expectedOutputs: ['a'], requirementIds: ['R1'] }, { id: 'b', dependencyIds: ['a'], writeScopes: ['src/b'], acceptanceCheckIds: ['unit'], expectedOutputs: ['b'], requirementIds: ['R1'] }]));
  return { dir, home, work, tasks, env: { JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0' } };
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

async function plan(box, argv, { ports, confirm = null, interactive = () => false } = {}) {
  let text = '';
  const code = await runPublicCommand('plan', argv, (chunk) => (text += chunk), { ports, env: box.env, cwd: box.work, confirm, interactive });
  return { code, text, json: argv.includes('--json') && text.startsWith('{') ? JSON.parse(text) : null };
}

const base = (box) => ['--submit', '--graph', box.tasks, '--budget', 'sprint-1', '--limit-micro-usd', '5000000', '--owner', 'alice'];

test('plan --submit needs a person: unconfirmed or --json without --yes sends nothing; a yes answer or --yes submits (pair)', async (t) => {
  const box = sandbox(t);
  const fake = fakePorts({ ok: true, result: SUBMITTED });
  assert.equal((await plan(box, base(box), { ports: fake.ports })).code, 2);
  assert.equal((await plan(box, [...base(box), '--json'], { ports: fake.ports, confirm: async () => true })).code, 2, '--json needs --yes');
  assert.equal((await plan(box, base(box), { ports: fake.ports, confirm: async () => false })).code, 2);
  assert.equal(fake.calls.length, 0, 'nothing reached the sidecar');

  let asked = '';
  const yes = await plan(box, base(box), { ports: fake.ports, confirm: async (question) => ((asked = question), true) });
  assert.equal(yes.code, 0);
  assert.match(asked, /Submit 2 task\(s\) under budget sprint-1 with a limit of 5 USD\?/);
  assert.match(yes.text, /^Submitted plan plan-0123456789abcdef0123 with 2 task\(s\) under budget sprint-1\./);
  assert.match(yes.text, /^tasks: a, b$/m);
  assert.match(yes.text, /^workers: none started/m);

  const flagged = await plan(box, [...base(box), '--reserve-micro-usd', '100000', '--budget-policy', 'pause-all', '--yes', '--json'], { ports: fake.ports });
  assert.equal(flagged.code, 0);
  assert.deepEqual(flagged.json, { schemaVersion: '1.0', command: 'plan submit', ...SUBMITTED });
  const request = fake.calls.at(-1);
  assert.deepEqual([request.op, request.scope, request.budget, request.workspace], ['plan.submit', 'cli', 'background', box.work]);
  assert.deepEqual(Object.keys(request.body).sort(), ['ownerId', 'plan', 'rootBudget']);
  assert.equal(request.body.ownerId, 'alice');
  assert.deepEqual(request.body.rootBudget, { id: 'sprint-1', limitMicroUsd: 5000000, shutdownReserveMicroUsd: 100000, policy: 'pause-all' });
  assert.deepEqual(request.body.plan.tasks.map((task) => task.id), ['a', 'b']);
});

test('plan --submit refuses bad flags before asking, and shows refusals with exit 1', async (t) => {
  const box = sandbox(t);
  const fake = fakePorts({ ok: true, result: SUBMITTED });
  for (const argv of [
    ['--submit', '--budget', 'sprint-1', '--limit-micro-usd', '1'],
    ['--submit', '--graph', box.tasks, '--limit-micro-usd', '1'],
    [...base(box).slice(0, 5), '--limit-micro-usd', '1.5'],
    [...base(box).slice(0, 5), '--limit-micro-usd', '0'],
    [...base(box), '--reserve-micro-usd', '5000000'],
    [...base(box), '--budget-policy', 'spend-more'],
    ['--submit', '--graph', box.tasks, '--budget', '1bad', '--limit-micro-usd', '1'],
    [...base(box).slice(0, 7), '--owner', 'has space'],
  ]) {
    assert.equal((await plan(box, [...argv, '--yes'], { ports: fake.ports })).code, 2, argv.join(' '));
  }
  assert.equal(fake.calls.length, 0);

  const conflict = await plan(box, [...base(box), '--yes'], { ports: fakePorts({ ok: true, result: { ...SUBMITTED, accepted: false, reasonCode: 'BUDGET_CONFLICT', planId: null, rootBudgetId: null, taskIds: [], waves: [], issues: [{ taskId: 'sprint-1', code: 'BUDGET_CONFLICT', detail: null }] } }).ports });
  assert.equal(conflict.code, 1);
  assert.match(conflict.text, /not submitted \(BUDGET_CONFLICT\)/);
  assert.match(conflict.text, /Use a new --budget id/);
  assert.match(conflict.text, /current limit/, 'JEV-0034: the hint says the limit is the current one');

  const stopped = await plan(box, [...base(box), '--yes', '--json'], { ports: fakePorts({ ok: false, reason: 'refused', reasonCode: 'KILL_SWITCH', message: 'stopped' }).ports });
  assert.equal(stopped.code, 1);
  assert.equal(stopped.json.reasonCode, 'KILL_SWITCH');
  const down = await plan(box, [...base(box), '--yes', '--json'], { ports: fakePorts({ ok: false, reason: 'unavailable', reasonCode: 'NOT_RUNNING', message: 'down' }).ports });
  assert.equal(down.code, 1, 'no local path: only the sidecar creates owned work');
  const forged = await plan(box, [...base(box), '--yes', '--json'], { ports: fakePorts({ ok: true, result: { ...SUBMITTED, planId: '../x' } }).ports });
  assert.equal(forged.json.reasonCode, 'SIDECAR_INVALID_RESULT');
});

test('SR-1: a new root budget needs a person; the CLI says so only after a y at a real terminal or with a terminal authorization (pair)', async (t) => {
  const box = sandbox(t);
  box.env.USER = 'alice';
  const fake = fakePorts({ ok: true, result: SUBMITTED });
  // A y answered at an interactive terminal: the request says so.
  assert.equal((await plan(box, base(box), { ports: fake.ports, confirm: async () => true, interactive: () => true })).code, 0);
  assert.equal(fake.calls.at(-1).body.channel, 'terminal');
  // The same y from a pipe or a script, --yes, or a test run: the request does not.
  assert.equal((await plan(box, base(box), { ports: fake.ports, confirm: async () => true })).code, 0);
  assert.equal('channel' in fake.calls.at(-1).body, false, 'no terminal');
  assert.equal((await plan(box, [...base(box), '--yes'], { ports: fake.ports, interactive: () => true })).code, 0);
  assert.equal('channel' in fake.calls.at(-1).body, false, '--yes is never a person');
  box.env.JEVRIS_TEST = '1';
  assert.equal((await plan(box, base(box), { ports: fake.ports, confirm: async () => true, interactive: () => true })).code, 0);
  assert.equal('channel' in fake.calls.at(-1).body, false, 'a test run is never a person');
  delete box.env.JEVRIS_TEST;
  // A terminal authorization travels with the person who minted it (the OS user, as budget update sends it).
  assert.equal((await plan(box, [...base(box), '--authorization', 'a0123456789abcdef01234567', '--yes'], { ports: fake.ports })).code, 0);
  assert.deepEqual([fake.calls.at(-1).body.authorizationId, fake.calls.at(-1).body.actor, 'channel' in fake.calls.at(-1).body], ['a0123456789abcdef01234567', 'alice', false]);
  assert.equal((await plan(box, [...base(box), '--authorization', '../x', '--yes'], { ports: fake.ports })).code, 2, 'a malformed id is a usage error');

  // The sidecar's refusals are shown with the way forward. A refusal because no person confirmed
  // the new budget is a refused request: exit 2 (JEV-0007). Other refusals stay exit 1.
  const refusal = (reasonCode) => fakePorts({ ok: true, result: { ...SUBMITTED, accepted: false, reasonCode, planId: null, rootBudgetId: null, taskIds: [], waves: [] } }).ports;
  const scripted = await plan(box, [...base(box), '--yes'], { ports: refusal('CHANNEL_REFUSED') });
  assert.equal(scripted.code, 2);
  assert.match(scripted.text, /not submitted \(CHANNEL_REFUSED\)/);
  assert.match(scripted.text, /jevris authorize budget\.increase --scope sprint-1/);
  const wrong = await plan(box, [...base(box), '--authorization', 'a0123456789abcdef01234567', '--yes', '--json'], { ports: refusal('AUTHORIZATION_REFUSED') });
  assert.deepEqual([wrong.code, wrong.json.accepted, wrong.json.reasonCode], [2, false, 'AUTHORIZATION_REFUSED']);
  for (const reasonCode of ['PLAN_INVALID', 'DUPLICATE_TASK', 'BUDGET_CONFLICT', 'STORE_UNAVAILABLE']) {
    const refused = await plan(box, [...base(box), '--yes', '--json'], { ports: refusal(reasonCode) });
    assert.deepEqual([refused.code, refused.json.reasonCode], [1, reasonCode], reasonCode);
  }
});

test('the plan.submit answer is checked against the contract', () => {
  assert.deepEqual(checkPlanSubmitResult(SUBMITTED), SUBMITTED);
  assert.equal(checkPlanSubmitResult({ ...SUBMITTED, reasonCode: 'SOMETHING' }), null);
  assert.equal(checkPlanSubmitResult({ ...SUBMITTED, planId: null }), null, 'accepted needs a plan id');
  assert.equal(checkPlanSubmitResult({ ...SUBMITTED, accepted: false }), null, 'refused has no plan id');
  assert.equal(checkPlanSubmitResult({ ...SUBMITTED, taskIds: ['a.b'] }), null);
  assert.equal(checkPlanSubmitResult({ ...SUBMITTED, issues: [{ taskId: 'a', code: 'lower', detail: null }] }), null);
});

test('plain plan never submits, and no MCP tool can submit a plan', async (t) => {
  const box = sandbox(t);
  const fake = fakePorts({ ok: true, result: SUBMITTED });
  await plan(box, ['--graph', box.tasks, '--json'], { ports: fake.ports });
  assert.equal(fake.calls.some((call) => call.op === 'plan.submit'), false);
  assert.equal(TOOLS.some((tool) => /plan[._-]?submit|submit[._-]?plan/.test(`${tool.name} ${tool.op ?? ''}`)), false);
});

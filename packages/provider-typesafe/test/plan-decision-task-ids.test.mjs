// Review of the plan slice hints (item 2): a plan check (`jevris plan`, `jevris_plan`) labels tasks
// that do not exist, under the plan's own local ids ("T1", "T2"). The outcome join selects decisions
// by task id, so when a real task "T1" was later verified it joined every earlier hypothetical "T1"
// decision from every other plan and corrupted the agreement-per-slice statistics. Only a submitted
// plan, whose tasks have just been created under those ids, records under a task id. A plan check
// records none. Stub engine for the recording, a real engine journal and a real store for the join;
// no live call.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');
const store = await import('@jevris/store');
const { createDeadline } = await import('@jevris/platform');

const ops = Object.fromEntries(provider.sidecarOps.map((def) => [def.op, def]));

const temps = [];
after(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-plan-task-ids-'));
  temps.push(dir);
  return dir;
}

function node(id, extra = {}) {
  return {
    id, schemaVersion: '1.0', workspaceId: 'ws1', revision: 'r1', state: 'proposed', requirementIds: ['R1'], dependencyIds: [],
    writeScopes: [], acceptanceCheckIds: [], rootBudgetId: 'b1', ...extra,
  };
}

/** Rules are sure of a docs task, so no question is asked and the test needs no provider. */
const DOC = (id) => node(id, { writeScopes: ['docs/guide.md'], acceptanceCheckIds: ['unit-test'] });

function recordingEngine() {
  const recorded = [];
  return {
    recorded,
    providerConfigured: true,
    sourceEgress: () => 'denied',
    async decide() {
      throw new Error('no question is asked in this file');
    },
    async lookup() {
      return { reasonCodes: [] };
    },
    async recordAdvice(input) {
      recorded.push(input);
      return { ok: true, decisionId: `d-advice-${recorded.length}` };
    },
  };
}

function planCtx(engine, body, extra = {}) {
  return {
    op: 'plan', client: 'cli', scopes: ['status', 'advice'], workspace: { id: 'w-plan-ids', root: null }, body, home: '/nonexistent-home-for-a-stub',
    signal: new AbortController().signal, deadline: createDeadline(20_000), store: undefined, killSwitchStopped: false, engine, trace() {}, mode: 'advise', jevAssist: 'off', ...extra,
  };
}

const stepOptions = { assist: 'off', mode: 'advise', deadlineMs: 0, totalMs: 60_000 };

test('a plan check records its decisions with no task id: its tasks do not exist', async () => {
  const engine = recordingEngine();
  const out = await ops.plan.handle(planCtx(engine, { tasks: [DOC('T1'), DOC('T2')] }));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.body.sliceSuggestions.length, 2);
  assert.equal(engine.recorded.length, 2, 'one decision per task, as before');
  for (const input of engine.recorded) {
    assert.equal(Object.hasOwn(input, 'taskId'), false, 'no task id on a plan check');
    assert.equal(input.specId, 'slice-classify');
    assert.ok(input.reasonCodes.includes('SLICE_PLAN_TASK'), 'it is still a plan task decision');
  }
});

test('a submitted plan records each decision under the id of the task it created', async () => {
  const engine = recordingEngine();
  const tasks = [DOC('T1'), DOC('T2')];
  const order = core.planTaskGraph(tasks).order;
  await core.suggestPlanSlices(engine, core.planSliceTasksOf(tasks, order), { workspaceId: 'w-plan-ids', evidenceRevision: 'r1' }, { ...stepOptions, tasksExist: true });
  assert.deepEqual(engine.recorded.map((r) => r.taskId).sort(), ['T1', 'T2']);
});

test('without the option the step records no task id; a session id, when the plan has one, still rides along', async () => {
  const engine = recordingEngine();
  const tasks = [DOC('T1')];
  const order = core.planTaskGraph(tasks).order;
  await core.suggestPlanSlices(engine, core.planSliceTasksOf(tasks, order), { workspaceId: 'w-plan-ids', evidenceRevision: 'r1', sessionId: 'sess-1' }, stepOptions);
  assert.equal(Object.hasOwn(engine.recorded[0], 'taskId'), false);
  assert.equal(engine.recorded[0].sessionId, 'sess-1');
});

// ---------------------------------------------------------------- the join

function engineOn(dir) {
  const port = provider.createSdkTransport({ apiKey: 'test-key-not-a-secret', fetch: provider.createMockFetch({ scenario: 'valid' }) });
  return core.createDecisionEngine({ transport: port, journalDir: join(dir, 'decisions'), budget: core.DecisionBudget.open(join(dir, 'budget.json'), { limitMicroUsd: 1_000_000 }) });
}

test('the outcome join: checking a plan, then submitting one and verifying its real T1, labels only the decision made for that task', async (t) => {
  const dir = temp();
  const engine = engineOn(dir);
  const host = store.openStore({ path: join(dir, 'jevris.db'), role: 'sidecar', workspaceId: 'host', hostScope: 'hostA', fsKind: () => ({ kind: 'local', label: 't' }) });
  assert.equal(host.ok, true, JSON.stringify(host));
  t.after(() => store.closeStore(host));
  const ws = store.workspaceView(host, 'w-plan-ids');
  const tasks = [DOC('T1'), DOC('T2')];

  // Two checks of other plans whose tasks are also called T1 and T2 (other plans, other days): hypothetical.
  const checks = [];
  const others = [[DOC('T1'), DOC('T2')], [node('T1', { writeScopes: ['docs/a.md', 'docs/b.md'], acceptanceCheckIds: ['unit-test'] }), DOC('T2')]];
  for (const other of others) {
    const out = await ops.plan.handle(planCtx(engine, { tasks: other }));
    assert.equal(out.ok, true, JSON.stringify(out));
    checks.push(...out.body.sliceSuggestions.map((s) => s.decisionId));
  }
  assert.equal(new Set(checks).size, 3, 'two plans, T2 identical in both: its decision is remembered, not recorded twice');
  assert.ok(checks.every((id) => typeof id === 'string'));

  // A plan is submitted: its tasks T1 and T2 now exist, and its decisions are recorded under them.
  const order = core.planTaskGraph(tasks).order;
  const submitted = await core.suggestPlanSlices(engine, core.planSliceTasksOf(tasks, order), { workspaceId: 'w-plan-ids', evidenceRevision: 'r1' }, { assist: 'off', mode: 'advise', deadlineMs: 0, totalMs: 60_000, tasksExist: true, memory: core.createPlanSliceMemory() });
  const own = Object.fromEntries(submitted.map((s) => [s.taskId, s.decisionId]));
  assert.ok(own.T1 !== null && own.T2 !== null);

  for (const id of [...checks, own.T1, own.T2]) {
    const archived = await store.archiveJournalEntry(ws, engine.journal, id, 'sidecar');
    assert.equal(archived.ok, true, JSON.stringify(archived));
  }

  // The real T1 is verified: the label joins the decision made for it, and none of the plan checks'.
  const joined = store.recordDecisionOutcomes(ws, { workspaceId: 'w-plan-ids', taskId: 'T1', label: 'verified-pass', labelSource: core.LABEL_SOURCE_OF['verified-pass'], receiptId: 'r-1', atMs: 5_000 });
  assert.deepEqual([joined.ok, joined.joined], [true, 1], JSON.stringify(joined));
  for (const id of checks) assert.deepEqual(store.decisionOutcomeFor(ws, id, 'w-plan-ids'), [], 'a plan check\'s hypothetical decision never joins a real task');
  assert.equal(store.decisionOutcomeFor(ws, own.T1, 'w-plan-ids').length, 1, 'the submitted T1\'s own decision joins');
  assert.equal(store.decisionOutcomeFor(ws, own.T2, 'w-plan-ids').length, 0, 'and T2\'s does not, it has no outcome yet');
});

test('a plan checked and then submitted on the same engine still records the submit under the task ids: the check\'s memory is not the submit\'s', async () => {
  const engine = recordingEngine();
  const tasks = [DOC('T1'), DOC('T2')];
  const order = core.planTaskGraph(tasks).order;
  const ctx = { workspaceId: 'w-plan-ids-memory', evidenceRevision: 'r1' };
  const checked = await core.suggestPlanSlices(engine, core.planSliceTasksOf(tasks, order), ctx, stepOptions);
  assert.equal(engine.recorded.length, 2);
  const submitted = await core.suggestPlanSlices(engine, core.planSliceTasksOf(tasks, order), ctx, { ...stepOptions, tasksExist: true });
  assert.equal(engine.recorded.length, 4, 'the submit records its own two decisions');
  assert.deepEqual(engine.recorded.slice(2).map((r) => r.taskId).sort(), ['T1', 'T2']);
  const checkedIds = new Set(checked.map((s) => s.decisionId));
  assert.ok(submitted.every((s) => s.decisionId !== null && !checkedIds.has(s.decisionId)), 'each submitted label carries the id of the decision made for its task, not the check\'s');
  // A second submit of the same plan inside this engine still records nothing twice.
  await core.suggestPlanSlices(engine, core.planSliceTasksOf(tasks, order), ctx, { ...stepOptions, tasksExist: true });
  assert.equal(engine.recorded.length, 4);
});

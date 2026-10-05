// JEV-0059. docs/routing.md ("Slice hints for the tasks of a plan"): a request still out when the plan's wait ends is
// dropped and its tasks keep the rules answer, with the reason `PLAN_JEV_DEADLINE` (or `PLAN_JEV_NO_TIME` when too little
// time was left to ask). The plan hands the engine its own wait as the deadline, so the engine's abstention at that
// deadline reaches the plan before the plan's timer does, and the label said `SLICE_JEV_DEADLINE`: the route's family,
// which the documented plan wait is not. The plan names its own reason for any task whose question ran out of time.
// A route keeps `SLICE_JEV_DEADLINE` and `SLICE_DEADLINE`. Nothing here is timed: a stub engine that abstains at its
// deadline, and a request that never answers and is ended by the plan's wait.
import test from 'node:test';
import assert from 'node:assert/strict';

const core = await import('@jevris/core');
const contracts = await import('@jevris/contracts');

const node = (id, extra = {}) => ({
  id, schemaVersion: '1.0', workspaceId: 'ws1', revision: 'r1', state: 'proposed', requirementIds: ['R1'], dependencyIds: [],
  writeScopes: [], acceptanceCheckIds: [], rootBudgetId: 'b1', ...extra,
});
/** Two ordinary source files and a test check: the rules call it a weak bounded-edit, so Jev is asked. */
const SOURCE = (id, extra = {}) => node(id, { writeScopes: ['src/parser/lexer.ts', 'src/parser/tokens.ts'], acceptanceCheckIds: ['unit-test'], ...extra });

/** An engine whose every request abstains at once with `reasonCode`, as the real engine does when its deadline passes. */
function abstainingEngine(reasonCode) {
  const decides = [];
  return {
    decides,
    providerConfigured: true,
    sourceEgress: () => 'denied',
    async decide(request) {
      decides.push(request);
      return { abstained: true, reasonCode, decisionId: `d-stub-abstain-${decides.length}`, fallback: null };
    },
    async lookup() {
      return { reasonCodes: [] };
    },
    async recordAdvice() {
      return { ok: true, decisionId: 'd-stub-advice' };
    },
  };
}

async function labels(engine, tasks) {
  const order = core.planTaskGraph(tasks).order;
  return core.suggestPlanSlices(engine, core.planSliceTasksOf(tasks, order), { workspaceId: 'w-plan-deadline-reason', evidenceRevision: 'r1' }, { assist: 'classify', mode: 'advise', deadlineMs: 30_000, totalMs: 60_000 });
}

test('a plan whose request ran out of time says PLAN_JEV_DEADLINE, for one shape and for several, and keeps the rules answer (JEV-0059)', async () => {
  for (const tasks of [[SOURCE('A'), SOURCE('B')], [SOURCE('A'), SOURCE('B', { writeScopes: ['src/x/a.ts'] }), SOURCE('C', { writeScopes: ['src/y/a.ts', 'src/y/b.ts', 'src/y/c.ts'] })]]) {
    const engine = abstainingEngine('DEADLINE');
    const list = await labels(engine, tasks);
    assert.ok(engine.decides.length >= 1, 'Jev was asked');
    assert.deepEqual(list.map((x) => [x.slice, x.source, x.reasonCode]), tasks.map(() => ['bounded-edit', 'rules', 'PLAN_JEV_DEADLINE']));
    assert.equal(contracts.PlanSliceSuggestionsContract.validate(list).ok, true);
  }
});

test('the plan\'s other Jev failures keep their own reason; only the deadline is the plan\'s own (JEV-0059)', async () => {
  for (const reasonCode of ['CIRCUIT_OPEN', 'BUDGET_EXHAUSTED', 'PROVIDER_ERROR']) {
    const list = await labels(abstainingEngine(reasonCode), [SOURCE('A'), SOURCE('B', { writeScopes: ['src/x/a.ts'] })]);
    assert.deepEqual(list.map((x) => x.reasonCode), [`SLICE_JEV_${reasonCode}`, `SLICE_JEV_${reasonCode}`], reasonCode);
  }
});

test('the route keeps its own family: a task asked alone that runs out of time is still SLICE_JEV_DEADLINE (JEV-0059)', async () => {
  const r = await core.classifyTaskSlice(abstainingEngine('DEADLINE'), { title: null, paths: ['src/parser/lexer.ts', 'src/parser/tokens.ts'], checkIds: ['unit-test'] }, { workspaceId: 'w-route-deadline', evidenceRevision: 'r1', deadlineMs: 30_000 }, { assist: 'classify', record: false });
  assert.deepEqual([r.source, r.reasonCode], ['rules', 'SLICE_JEV_DEADLINE']);
});

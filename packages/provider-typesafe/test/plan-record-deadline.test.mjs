// Review of the plan slice hints (item 1): the step that records one advisory decision per task is
// bounded by the request's own time, as the ask phase is. A recording that is still out at the limit
// does not hold the answer: the labels are returned without decision ids, the late recording
// finishes (or fails) on its own and is remembered, and the step says so with PLAN_JEV_RECORD_LATE.
// The disk is a gate the test opens, never a real sleep, so no assertion here is about elapsed time.
// Stub engines, no files, no live call.
import test from 'node:test';
import assert from 'node:assert/strict';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');
const contracts = await import('@jevris/contracts');
const { createDeadline } = await import('@jevris/platform');

const ops = Object.fromEntries(provider.sidecarOps.map((def) => [def.op, def]));

/** The longest a test waits for a step that should already have returned, in ms. Past it the gate opens by itself. */
const SAFETY_MS = 6000;

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * An engine whose Jev never answers and whose `recordAdvice` waits on `gate`. `entered` counts the
 * recordings that started, `finished` those that completed.
 */
function holdingEngine(gate) {
  const entered = [];
  const finished = [];
  return {
    entered,
    finished,
    providerConfigured: true,
    sourceEgress: () => 'denied',
    decide: () => new Promise(() => {}),
    async lookup() {
      return { reasonCodes: [] };
    },
    async recordAdvice(input) {
      entered.push(input);
      await gate.promise;
      finished.push(input);
      return { ok: true, decisionId: `d-held-${finished.length}` };
    },
  };
}

function node(id, extra = {}) {
  return {
    id, schemaVersion: '1.0', workspaceId: 'ws1', revision: 'r1', state: 'proposed', requirementIds: ['R1'], dependencyIds: [],
    writeScopes: [], acceptanceCheckIds: [], rootBudgetId: 'b1', ...extra,
  };
}

/** Two ordinary source files and a test check: a weak bounded-edit, so Jev is asked and (here) never answers. */
const SOURCE = (id, extra = {}) => node(id, { writeScopes: ['src/parser/lexer.ts', 'src/parser/tokens.ts'], acceptanceCheckIds: ['unit-test'], ...extra });

/** Runs `step` with a safety timer that opens the gate if the step is stuck behind it; returns what the step gave and whether the gate had to be forced. */
async function runWithSafety(gate, step) {
  let forced = false;
  const safety = setTimeout(() => {
    forced = true;
    gate.resolve();
  }, SAFETY_MS);
  try {
    const value = await step();
    return { value, forced };
  } finally {
    clearTimeout(safety);
  }
}

async function until(condition) {
  const stop = performance.now() + 30_000;
  while (!condition() && performance.now() < stop) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(condition(), true, 'the condition held before the generous bound');
}

test('a recording that is still out at the step\'s limit does not hold the labels; they come back without decision ids and the step says why', async () => {
  const gate = deferred();
  const engine = holdingEngine(gate);
  const tasks = [SOURCE('A'), SOURCE('B', { writeScopes: ['src/x/a.ts'] }), node('DOC', { writeScopes: ['docs/guide.md'], acceptanceCheckIds: ['unit-test'] })];
  const notes = [];
  const order = core.planTaskGraph(tasks).order;
  const { value: list, forced } = await runWithSafety(gate, () =>
    core.suggestPlanSlices(engine, core.planSliceTasksOf(tasks, order), { workspaceId: 'w-record-late-1', evidenceRevision: 'r1' }, { assist: 'classify', mode: 'advise', deadlineMs: 150, totalMs: 500, note: (code) => notes.push(code) }),
  );
  assert.equal(forced, false, 'the step returned while the recording was still held: it did not wait for the disk');
  assert.equal(list.length, 3, 'every task is labelled');
  assert.ok(list.every((x) => x.decisionId === null), 'no decision id: none had been recorded');
  const byId = Object.fromEntries(list.map((x) => [x.taskId, x]));
  assert.deepEqual([byId.A.slice, byId.A.source, byId.A.reasonCode], ['bounded-edit', 'rules', 'PLAN_JEV_DEADLINE'], 'the labels are the ones the step had: Jev never answered, so the rules answer stands');
  assert.deepEqual([byId.DOC.slice, byId.DOC.source], ['docs', 'rules']);
  assert.deepEqual(notes, ['PLAN_JEV_RECORD_LATE'], 'the step says the recording was late, once');
  assert.equal(contracts.PlanSliceSuggestionsContract.validate(list).ok, true, 'the labels are still a valid answer');
  gate.resolve();
  await until(() => engine.finished.length === engine.entered.length);
});

test('the late recording finishes on its own and is remembered; batches that had not started are dropped; the same plan checked again records only what is missing', async () => {
  const gate = deferred();
  const engine = holdingEngine(gate);
  // Ten tasks to record, in batches of eight: the first batch is out when the limit comes, the second has not started.
  const tasks = Array.from({ length: 10 }, (_, i) => node(`D${i}`, { writeScopes: ['docs/guide.md'], acceptanceCheckIds: ['unit-test'] }));
  const order = core.planTaskGraph(tasks).order;
  const options = { assist: 'classify', mode: 'advise', deadlineMs: 150, totalMs: 500 };
  const ctx = { workspaceId: 'w-record-late-2', evidenceRevision: 'r1' };
  const { value: first, forced } = await runWithSafety(gate, () => core.suggestPlanSlices(engine, core.planSliceTasksOf(tasks, order), ctx, options));
  assert.equal(forced, false);
  assert.equal(first.length, 10);
  const before = JSON.stringify(first);
  assert.equal(engine.entered.length, 8, 'the first batch had started when the limit came, the second never does');
  gate.resolve();
  await until(() => engine.finished.length === 8);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.stringify(first), before, 'an answer already returned is never changed by a recording that finishes afterwards');
  assert.equal(engine.entered.length, 8, 'nothing more was started once the answer had gone');
  // A second check of the same plan, on the same engine: the eight that finished are remembered and carry their ids; only the two missing are recorded.
  const again = await core.suggestPlanSlices(engine, core.planSliceTasksOf(tasks, order), ctx, { ...options, deadlineMs: 0, totalMs: 60_000 });
  assert.equal(again.filter((x) => x.decisionId !== null).length, 10, 'every label carries an id now');
  assert.equal(engine.entered.length, 10, 'eight records in all from the first check, two from the second, none twice');
});

test('a check of the same plan that arrives while a late recording is still out does not record that decision a second time', async () => {
  const gate = deferred();
  const engine = holdingEngine(gate);
  const tasks = Array.from({ length: 4 }, (_, i) => node(`D${i}`, { writeScopes: ['docs/guide.md'], acceptanceCheckIds: ['unit-test'] }));
  const order = core.planTaskGraph(tasks).order;
  const options = { assist: 'classify', mode: 'advise', deadlineMs: 150, totalMs: 400 };
  const ctx = { workspaceId: 'w-record-late-inflight', evidenceRevision: 'r1' };
  const first = await runWithSafety(gate, () => core.suggestPlanSlices(engine, core.planSliceTasksOf(tasks, order), ctx, options));
  assert.equal(first.forced, false);
  assert.equal(engine.entered.length, 4, 'all four recordings are out, held by the disk');
  const second = await runWithSafety(gate, () => core.suggestPlanSlices(engine, core.planSliceTasksOf(tasks, order), ctx, options));
  assert.equal(second.forced, false);
  assert.equal(engine.entered.length, 4, 'the same plan again, with those four still out: nothing is recorded twice');
  assert.ok(second.value.every((x) => x.decisionId === null), 'their ids are not known yet');
  gate.resolve();
  await until(() => engine.finished.length === 4);
  await new Promise((resolve) => setImmediate(resolve));
  const third = await core.suggestPlanSlices(engine, core.planSliceTasksOf(tasks, order), ctx, { ...options, deadlineMs: 0, totalMs: 60_000 });
  assert.ok(third.every((x) => x.decisionId !== null), 'once they have finished, the ids are on the labels');
  assert.equal(engine.entered.length, 4, 'and still nothing was recorded twice');
});

test('a recording that fails is tried again by the next check, not remembered as done', async () => {
  const gate = deferred();
  gate.resolve();
  const engine = holdingEngine(gate);
  let fail = true;
  const original = engine.recordAdvice.bind(engine);
  engine.recordAdvice = async (input) => (fail ? { ok: false, reasonCode: 'JOURNAL_UNAVAILABLE' } : original(input));
  const tasks = [node('DOC', { writeScopes: ['docs/guide.md'], acceptanceCheckIds: ['unit-test'] })];
  const order = core.planTaskGraph(tasks).order;
  const ctx = { workspaceId: 'w-record-failed', evidenceRevision: 'r1' };
  const options = { assist: 'classify', mode: 'advise', deadlineMs: 0, totalMs: 60_000 };
  const first = await core.suggestPlanSlices(engine, core.planSliceTasksOf(tasks, order), ctx, options);
  assert.equal(first[0].decisionId, null);
  fail = false;
  const second = await core.suggestPlanSlices(engine, core.planSliceTasksOf(tasks, order), ctx, options);
  assert.ok(second[0].decisionId !== null, 'the next check records it');
});

test('with no time left at all nothing is recorded, the labels are returned and the step says the recording was late', async () => {
  const gate = deferred();
  const engine = holdingEngine(gate);
  const tasks = [SOURCE('A'), node('DOC', { writeScopes: ['docs/guide.md'], acceptanceCheckIds: ['unit-test'] })];
  const order = core.planTaskGraph(tasks).order;
  const notes = [];
  const list = await core.suggestPlanSlices(engine, core.planSliceTasksOf(tasks, order), { workspaceId: 'w-record-late-3', evidenceRevision: 'r1' }, { assist: 'classify', mode: 'advise', deadlineMs: 0, totalMs: 0, note: (code) => notes.push(code) });
  assert.equal(list.length, 2);
  assert.equal(engine.entered.length, 0, 'a step with no time left starts no recording');
  assert.deepEqual(notes, ['PLAN_JEV_RECORD_LATE']);
  gate.resolve();
});

test('a recording that finishes in time is as before: ids on every label and no late note', async () => {
  const gate = deferred();
  gate.resolve();
  const engine = holdingEngine(gate);
  const tasks = [SOURCE('A'), node('DOC', { writeScopes: ['docs/guide.md'], acceptanceCheckIds: ['unit-test'] })];
  const order = core.planTaskGraph(tasks).order;
  const notes = [];
  const list = await core.suggestPlanSlices(engine, core.planSliceTasksOf(tasks, order), { workspaceId: 'w-record-late-4', evidenceRevision: 'r1' }, { assist: 'classify', mode: 'advise', deadlineMs: 150, totalMs: 60_000, note: (code) => notes.push(code) });
  assert.ok(list.every((x) => x.decisionId !== null));
  assert.deepEqual(notes, []);
});

test('a plan with nothing to record (rules only, record off) is never late', async () => {
  const engine = holdingEngine(deferred());
  const tasks = [node('DOC', { writeScopes: ['docs/guide.md'], acceptanceCheckIds: ['unit-test'] })];
  const order = core.planTaskGraph(tasks).order;
  const notes = [];
  await core.suggestPlanSlices(engine, core.planSliceTasksOf(tasks, order), { workspaceId: 'w-record-late-5', evidenceRevision: 'r1' }, { assist: 'classify', mode: 'advise', deadlineMs: 0, totalMs: 0, record: false, note: (code) => notes.push(code) });
  assert.deepEqual(notes, []);
  assert.equal(engine.entered.length, 0);
});

test('through the plan op: a held recording does not make the op miss its time, the labels ride along and the trace says PLAN_JEV_RECORD_LATE', async () => {
  const gate = deferred();
  const engine = holdingEngine(gate);
  const traces = [];
  // The hot budget of the sidecar: the labels must arrive inside it, with whatever the step had by then.
  const ctx = {
    op: 'plan', client: 'cli', scopes: ['status', 'advice'], workspace: { id: 'w-record-late-op', root: null },
    body: { tasks: [SOURCE('A'), SOURCE('B', { writeScopes: ['src/x/a.ts'] }), node('DOC', { writeScopes: ['docs/guide.md'], acceptanceCheckIds: ['unit-test'] })] },
    home: '/nonexistent-home-for-a-stub', signal: new AbortController().signal, deadline: createDeadline(900), store: undefined, killSwitchStopped: false, engine,
    trace: (event) => traces.push(event), mode: 'advise',
  };
  const { value: out, forced } = await runWithSafety(gate, () => ops.plan.handle(ctx));
  assert.equal(forced, false, 'the op answered while the recording was still held');
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(contracts.surfacePayloadContract('plan').validate(out.body).ok, true);
  assert.equal(out.body.sliceSuggestions.length, 3, 'every task carries its label');
  assert.ok(out.body.sliceSuggestions.every((x) => x.decisionId === null));
  assert.deepEqual(traces.filter((e) => e.event === 'plan-slices').map((e) => e.reasonCode), ['PLAN_JEV_RECORD_LATE']);
  assert.equal(out.body.valid, true);
  gate.resolve();
  await until(() => engine.finished.length === engine.entered.length);
});

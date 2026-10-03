// Owner decision 2026-10-01 (Jev as an active decision aid): `plan.submit` answers with the slice and
// risk hint the route classifier gives each submitted task, for a person to read. It is made from
// the tasks the plan already holds: it is never stored in the plan, never changes a task, and a
// failure of it is no labels, never a failed submit. A stub engine stands in for Jev; no live call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PlanSliceSuggestionsContract } from '@jevris/contracts';
import { jevrisPaths } from '@jevris/platform';
import { approveManifests, DEFAULT_CONFIG, listTasks, manifestHash, openWorkspace, parseManifest, sidecarOps } from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

const op = (name) => sidecarOps.find((o) => o.op === name);

async function fixture(extra = {}) {
  const dir = tempDir('jv-plan-slices-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const store = testStore(dir);
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
  const manifest = parseManifest({ id: 'unit', argv: [process.execPath, '-e', 'process.exit(0)'], resultFormat: 'exit-code' }).manifest;
  await approveManifests(ws, [manifest], { unit: manifestHash(manifest) }, 'test');
  // The submit is under test, not the workers: turn orchestration off.
  const config = jevrisPaths({ home }).config;
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, orchestration: { ...DEFAULT_CONFIG.orchestration, enabled: false } }));
  const ctx = (name, body, more = {}) => ({
    op: name,
    client: 'cli',
    scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'],
    workspace: { id: ws.workspaceId, root: ws.workspaceRoot },
    body,
    home,
    signal: new AbortController().signal,
    deadline: { budgetMs: 20_000, remainingMs: () => 20_000, expired: () => false },
    store,
    killSwitchStopped: false,
    engine: undefined,
    trace: () => {},
    ...extra,
    ...more,
  });
  return { ws, ctx, done: () => {
      closeTestStore(store);
      rmSync(dir, { recursive: true, force: true });
    } };
}

/** An engine that answers every slice question `choice` and records what it is asked and what is recorded. */
function stubEngine(choice = 'issue-fix') {
  const decides = [];
  const recorded = [];
  return {
    decides,
    recorded,
    providerConfigured: true,
    sourceEgress: () => 'denied',
    async decide(request) {
      decides.push(request);
      return {
        abstained: false,
        decisionId: `d-stub-call-${decides.length}`,
        automation: true,
        rulesOnly: false,
        result: {
          answers: {
            slice: { type: 'choice', choice, probabilities: { [choice]: 0.9, unknown: 0.1 }, confidence: 0.9 },
            risk: { type: 'score', score: 1, probabilities: { 1: 1 }, confidence: 1 },
          },
        },
      };
    },
    async lookup() {
      return { reasonCodes: [] };
    },
    async recordAdvice(input) {
      recorded.push(input);
      return { ok: true, decisionId: `d-stub-advice-${recorded.length}` };
    },
  };
}

const task = (id, extra = {}) => ({ id, requirementIds: ['R1'], acceptanceCheckIds: ['unit'], expectedOutputs: ['patch'], writeScopes: [`mod/${id}/a.ts`, `mod/${id}/b.ts`], ...extra });
const body = (tasks) => ({ plan: { tasks }, ownerId: 'alice', rootBudget: { id: 'b1', limitMicroUsd: 1_000_000 }, channel: 'terminal' });

/** What a task holds in the store, without what depends on the workspace's own id or the clock. */
function stored(ws) {
  return listTasks(ws).map((t) => ({ node: { ...t.node, workspaceId: 'ws' }, title: t.title, sliceId: t.sliceId, risk: t.risk, riskReasons: t.riskReasons, labels: t.labels, expectedOutputs: t.expectedOutputs, value: t.value }));
}

test('plan.submit labels each submitted task; the submitted plan is the same with and without the labels', async () => {
  const plain = await fixture();
  const labelled = await fixture();
  try {
    const tasks = [task('T1', { title: 'fix the parser' }), task('T2', { writeScopes: ['docs/guide.md'], dependencyIds: ['T1'] }), task('T3', { writeScopes: ['.github/workflows/ci.yml'], sliceId: 'bounded-edit' })];
    const engine = stubEngine('refactor');
    const off = await op('plan.submit').handle(plain.ctx('plan.submit', body(tasks), { jevAssist: 'off' }));
    const on = await op('plan.submit').handle(labelled.ctx('plan.submit', body(tasks), { engine, jevAssist: 'classify' }));
    assert.equal(off.ok && on.ok, true, JSON.stringify([off, on]));
    assert.equal(on.body.accepted, true, JSON.stringify(on.body));

    // The labels: Jev for the weak task, the rules for the docs task, the plan's own slice kept and a protected path flagged.
    const s = Object.fromEntries(on.body.sliceSuggestions.map((x) => [x.taskId, x]));
    assert.equal(PlanSliceSuggestionsContract.validate(on.body.sliceSuggestions).ok, true);
    assert.deepEqual([s.T1.slice, s.T1.source, s.T1.reasonCode], ['refactor', 'jev', 'SLICE_JEV_OVER_RULES']);
    assert.match(s.T1.decisionId, /^d-stub-advice-\d$/);
    assert.deepEqual([s.T2.slice, s.T2.source], ['docs', 'rules']);
    assert.deepEqual([s.T3.slice, s.T3.source, s.T3.risk, s.T3.suggestedSlice, s.T3.agrees], ['bounded-edit', 'given', 'high', null, null], 'a protected path: the plan\'s slice is shown, the classifier gives none');
    assert.deepEqual(on.body.sliceSuggestions.map((x) => x.taskId), ['T1', 'T2', 'T3']);
    // Off: the same labels from the rules, no model.
    const o = Object.fromEntries(off.body.sliceSuggestions.map((x) => [x.taskId, x]));
    assert.deepEqual([o.T1.slice, o.T1.source, o.T1.reasonCode], ['issue-fix', 'rules', 'SLICE_ASSIST_OFF']);

    // Nothing of the plan changed: the answer minus the labels and the plan id, and every stored task, are identical.
    const strip = ({ sliceSuggestions, planId, ...rest }) => rest;
    assert.deepEqual(strip(on.body), strip(off.body));
    assert.deepEqual(stored(labelled.ws), stored(plain.ws));
    // The slice a task is stored with is the plan's own, or the rules' default for a low-risk task: never Jev's suggestion.
    assert.equal(stored(labelled.ws).find((t) => t.node.id === 'T1').sliceId === 'refactor', false, 'a suggested slice is never stored as the task\'s slice');
    assert.equal(stored(labelled.ws).find((t) => t.node.id === 'T3').sliceId, 'bounded-edit', 'the plan\'s own slice is stored as given');

    // One question per distinct features (T1 and T3), one advisory decision per task, each with its task's id; no path or title went to the engine.
    assert.equal(engine.decides.length, 2);
    assert.equal(JSON.stringify(engine.decides).includes('mod/T1'), false);
    assert.equal(JSON.stringify(engine.decides).includes('fix the parser'), false, 'egress is denied');
    assert.deepEqual(engine.recorded.map((r) => r.taskId).sort(), ['T1', 'T2', 'T3']);
    assert.ok(engine.recorded.every((r) => r.specId === 'slice-classify' && r.reasonCodes.includes('SLICE_PLAN_TASK')));
  } finally {
    plain.done();
    labelled.done();
  }
});

test('plan.submit: a refused plan carries no labels; an engine that throws or answers nothing costs only the labels', async () => {
  const f = await fixture();
  try {
    const refused = await op('plan.submit').handle(f.ctx('plan.submit', body([task('T1', { acceptanceCheckIds: ['nope'] })]), { engine: stubEngine() }));
    assert.equal(refused.body.accepted, false);
    assert.equal('sliceSuggestions' in refused.body, false);
    const broken = { ...stubEngine(), decide: async () => { throw new Error('boom'); }, recordAdvice: async () => { throw new Error('boom'); } };
    const out = await op('plan.submit').handle(f.ctx('plan.submit', body([task('T1')]), { engine: broken }));
    assert.equal(out.body.accepted, true, JSON.stringify(out.body));
    assert.deepEqual([out.body.sliceSuggestions[0].slice, out.body.sliceSuggestions[0].source, out.body.sliceSuggestions[0].decisionId], ['bounded-edit', 'rules', null]);
  } finally {
    f.done();
  }
});

test('plan.submit: kill switch and mode off ask no model; the submit is refused or answered as before', async () => {
  const f = await fixture();
  try {
    const engine = stubEngine();
    const out = await op('plan.submit').handle(f.ctx('plan.submit', body([task('T1')]), { engine, mode: 'off' }));
    assert.equal(out.body.accepted, true);
    assert.deepEqual([out.body.sliceSuggestions[0].source, out.body.sliceSuggestions[0].reasonCode], ['rules', 'PLAN_JEV_MODE_OFF']);
    assert.equal(engine.decides.length + engine.recorded.length, 0);
    const stopped = await op('plan.submit').handle(f.ctx('plan.submit', body([task('T9')]), { engine, killSwitchStopped: true }));
    assert.equal(stopped.ok, true);
    assert.deepEqual([stopped.body.sliceSuggestions[0].source, stopped.body.sliceSuggestions[0].reasonCode], ['rules', 'PLAN_JEV_KILL_SWITCH']);
    assert.equal(engine.decides.length + engine.recorded.length, 0);
  } finally {
    f.done();
  }
});

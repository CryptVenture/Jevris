// `jevris explain` and the Provider line of an adviser's summary record (JEV-0046). Six advisers (the task slice,
// the check ranking, repeated-failure advice, new-task advice, the scope check and worker readiness) record ONE summary
// decision per run. That record makes no provider call of its own: the Jev question the run asked is a separate decision
// record (the engine's own, with the model and the usage), and a repeat is the engine's cache-hit record. The explain text
// of the summary said "(asked Jev, 53 ms)" beside "Provider: no model answered; no provider call was made.", and the
// engine's own record of a slice or ranking call was explained with the adviser's lines ("Jev not asked") beside its
// model and tokens. Real engines, real advisers, a scripted Jev, temporary homes, no live call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackEngine } from './engine-settle.mjs';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');
const contracts = await import('@jevris/contracts');
const { createDeadline } = await import('@jevris/platform');

const ops = Object.fromEntries(provider.sidecarOps.map((def) => [def.op, def]));
const APPROVED = () => ({ provenance: 'administrator', sourceEgress: 'approved-scoped' });

/** A scripted Jev: `answer(id, question, body)` gives `{ noul }`, `{ choice, confidence }` or `{ score }`, or null for no answer. */
function scriptedFetch(answer) {
  const requests = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      const want = answer(id, q, body);
      if (want === null) continue;
      if (q.type === 'noul') {
        answers[id] = { type: 'noul', noul: want.noul ?? 0.5 };
      } else if (q.type === 'score') {
        const sure = want.confidence ?? 1;
        const rest = Math.round(((1 - sure) / (q.criteria.length - 1)) * 10000) / 10000;
        const probabilities = Object.fromEntries(q.criteria.map((_, i) => [String(i), i === want.score ? sure : rest]));
        const expected = Math.round(Object.entries(probabilities).reduce((sum, [i, p]) => sum + Number(i) * p, 0) * 100) / 100;
        answers[id] = { type: 'score', score: expected, probabilities, legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])), confidence: Math.max(...Object.values(probabilities)) };
      } else {
        const keys = Object.keys(q.criteria);
        const given = { [want.choice ?? keys[0]]: want.confidence ?? 0.9 };
        const rest = keys.filter((k) => !(k in given));
        const left = 1 - Object.values(given).reduce((a, b) => a + b, 0);
        const probabilities = Object.fromEntries(keys.map((k) => [k, k in given ? given[k] : Math.round((left / rest.length) * 10000) / 10000]));
        const choice = want.choice ?? keys.reduce((a, b) => (probabilities[b] > probabilities[a] ? b : a));
        answers[id] = { type: 'choice', choice, probabilities, confidence: probabilities[choice] };
      }
    }
    return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 300, output_tokens: 10 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, requests };
}

async function setup(t, answer) {
  const home = mkdtempSync(join(tmpdir(), 'jevris-provider-line-'));
  let tracker = null;
  t.after(async () => {
    try {
      await tracker?.settled();
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });
  const script = scriptedFetch(answer);
  const engine = await provider.createSidecarEngine({ home, credential: 'test-key-not-a-secret', fetch: script.fetch, env: {}, sourceEgress: APPROVED });
  tracker = trackEngine(engine);
  return { home, engine, requests: script.requests };
}

// ------------------------------------------------------------------ one adviser per spec id

const FEATURES = (over = {}) => ({ toolClass: 'shell', exitClass: 'nonzero', family: 'shell:nonzero', signature: 'bbbbbbbbbbbbbbbb', commandDigest: 'cccccccccccccccc', environmental: false, elapsed: 'lt10s', present: [], ...over });
const OBSERVATION = (over = {}) => ({ attempts: 2, sameSignature: false, sameCommand: true, editsSince: 0, gapMs: 1000, unsure: true, previous: { exitClass: 'nonzero', environmental: false, elapsed: 'lt10s', present: [] }, ...over });
const failureContext = (over = {}) => provider.failureContextOf(provider.parseFailureFeatures(FEATURES()), OBSERVATION(over), 2);
const FAIL_IDS = { workspaceId: 'w-line', sessionId: 's-1', taskId: 'task-1' };
const FAIL_ASK = { assist: 'classify', deadlineMs: 30_000, ids: FAIL_IDS };
const SLICE_CTX = { workspaceId: 'w-line', evidenceRevision: 'rev-1', deadlineMs: 30_000 };
const SLICE_TASK = { paths: ['src/parser/lexer.ts', 'src/parser/tokens.ts'], checkIds: ['test'] };
const CHECKS = [
  { id: 'docs-check', state: 'missing' },
  { id: 'lint', state: 'stale' },
  { id: 'typecheck', state: 'missing' },
  { id: 'unit-test', state: 'missing' },
];
const READY_TASK = { title: 'Fix the date parser', paths: ['src/date/parse.ts', 'test/date/parse.test.ts'], checkIds: ['unit-tests', 'lint'] };
// The model tier's input: a plain task on Claude Code's Sonnet 5.5, with every bundled model eligible.
const TIER_INPUT = {
  signals: core.tierSignalsOf({ hints: { title: 'Adjust the cart pagination', paths: ['src/cart/page.ts', 'src/cart/list.ts'], checkIds: ['test'] }, risk: 'medium' }),
  eligible: core.BUNDLED_MODEL_REGISTRY.entries,
  baselineModelId: 'claude-sonnet-5-5',
  volume: core.DEFAULT_TASK_VOLUME,
};
const FAMILIES = [...core.TASK_FAMILIES].sort();
const OPENS = core.OPEN_POINTS.map((p) => p.id);

/** What the scripted Jev says to each adviser's question; the answers clear every floor, so the answer is used and cached. */
function jevAnswer(id, q) {
  if (id === 'same') return { noul: 0.92 };
  if (id === 'slice') return { choice: 'issue-fix', confidence: 0.85 };
  if (id === 'workerReady') return { noul: 0.77 };
  // The subagent-risk Choice (low, medium, high); the slice classifier's own `risk` is a Score.
  if (id === 'risk' && q.type === 'choice') return { choice: 'high', confidence: 0.85 };
  // The model-tier Choice over generic labels: the nearest dearer rung (C of three).
  if (id === 'model') return { choice: 'C', confidence: 0.85 };
  if (id === 'taskFamily') return { choice: `f${FAMILIES.indexOf('bugfix')}`, confidence: 0.9 };
  if (id.startsWith('material')) return { noul: OPENS[Number(id.slice('material'.length))] === 'edge-cases' ? 0.9 : 0.05 };
  return q.type === 'score' ? { score: 1 } : { noul: 0.5 };
}

/**
 * Each adviser: how to run it asking Jev (`live`), and, where it has one, how to run it with the rules sure (`rules`), each
 * giving `{ summary, call }`, the summary record's id and the id of the Jev call's own record. The three regexes are the
 * adviser's own lines for a live answer, a cache hit and a run that never asked.
 */
const ADVISERS = [
  {
    spec: 'repeated-failure',
    live: async (e) => {
      const a = await provider.adviseRepeatedFailure(e, failureContext(), FAIL_ASK);
      return { summary: a.decisionId, call: a.jevDecisionId };
    },
    rules: async (e) => (await provider.adviseRepeatedFailure(e, failureContext({ sameSignature: true, unsure: false, previous: null }), FAIL_ASK)).decisionId,
    asked: /\(asked Jev, \d+ ms\)/,
    cached: /\(cache hit, \d+ ms\)/,
    notAsked: /Jev was not asked/,
  },
  {
    spec: 'slice-classify',
    live: async (e) => {
      const r = await core.classifyTaskSlice(e, SLICE_TASK, SLICE_CTX, { assist: 'classify' });
      return { summary: r.decisionId, call: r.jevDecisionId };
    },
    rules: async (e) => (await core.classifyTaskSlice(e, { paths: ['docs/guide.md', 'README.md'] }, SLICE_CTX, { assist: 'classify' })).decisionId,
    asked: /\(asked Jev, \d+ ms\)/,
    cached: /\(cache hit, \d+ ms\)/,
    notAsked: /\(Jev not asked, \d+ ms\)/,
  },
  {
    spec: 'check-relevance',
    live: async (e) => {
      const r = await core.rankChecks(e, { checks: CHECKS, paths: ['src/billing/invoice.ts', 'docs/guide.md'] }, { workspaceId: 'w-line' }, { assist: 'classify', deadlineMs: 30_000 });
      return { summary: r.decisionId, call: r.jevDecisionId };
    },
    rules: async (e) => (await core.rankChecks(e, { checks: CHECKS, paths: ['docs/a.md'] }, { workspaceId: 'w-line' }, { assist: 'classify', deadlineMs: 30_000 })).decisionId,
    asked: /\(asked Jev, \d+ ms\)/,
    cached: /\(cache hit, \d+ ms\)/,
    notAsked: /Jev was not asked/,
  },
  {
    spec: 'worker-readiness',
    live: async (e) => {
      const r = await core.adviseWorkerReadiness(e, READY_TASK, { workspaceId: 'w-line', evidenceRevision: 'rev-1', taskId: 'task-1' }, { assist: 'classify', deadlineMs: 30_000 });
      return { summary: r.decisionId, call: r.jevDecisionId };
    },
    rules: async (e) => (await core.adviseWorkerReadiness(e, { title: 'improve the product', paths: [], checkIds: [] }, { workspaceId: 'w-line', evidenceRevision: 'rev-1', taskId: 'task-1' }, { assist: 'classify', deadlineMs: 30_000 })).decisionId,
    asked: /Asked Jev, \d+ ms\./,
    cached: /Answered from the cache/,
    notAsked: /Jev was not asked/,
  },
  {
    spec: 'subagent-risk',
    live: async (e) => {
      const r = await core.judgeSubagentRisk(e, core.subagentRiskFeatures({ subagentType: 'general-purpose', toolInputBytes: 500, toolInputKeys: 3 }), { workspaceId: 'w-line', evidenceRevision: 'rev-1' }, { assist: 'classify' });
      return { summary: r.decisionId, call: r.jevDecisionId };
    },
    rules: async (e) => (await core.judgeSubagentRisk(e, core.subagentRiskFeatures({ subagentType: 'Explore', toolInputBytes: 500, toolInputKeys: 3 }), { workspaceId: 'w-line', evidenceRevision: 'rev-1' }, { assist: 'classify' })).decisionId,
    asked: /\(asked Jev, \d+ ms\)/,
    cached: /\(cache hit, \d+ ms\)/,
    notAsked: /\(Jev not asked, \d+ ms\)/,
  },
  {
    spec: 'model-tier',
    live: async (e) => {
      const r = await core.judgeModelTier(e, TIER_INPUT, { workspaceId: 'w-line', evidenceRevision: 'rev-1' }, { assist: 'classify' });
      return { summary: r.decisionId, call: r.jevDecisionId };
    },
    rules: async (e) => (await core.judgeModelTier(e, { ...TIER_INPUT, signals: core.tierSignalsOf({ hints: { paths: ['docs/guide.md'], checkIds: [] } }) }, { workspaceId: 'w-line', evidenceRevision: 'rev-1' }, { assist: 'classify' })).decisionId,
    asked: /\(asked Jev, \d+ ms\)/,
    cached: /\(cache hit, \d+ ms\)/,
    notAsked: /\(Jev not asked, \d+ ms\)/,
  },
  {
    spec: 'new-task',
    live: async (e) => {
      const a = await provider.adviseNewTask(e, 'Fix the crash in the zebra cart when the cart is empty', { assist: 'classify', deadlineMs: 30_000, ids: FAIL_IDS, evidenceRevision: 'rev-1' });
      return { summary: a.decisionId, call: a.jevDecisionId };
    },
    rules: null,
    asked: /\(asked Jev, \d+ ms\)/,
    cached: /\(cache hit, \d+ ms\)/,
    notAsked: /Jev was not asked/,
  },
];

const SCOPE_RECORD = (cacheHit) => ({
  specId: 'scope-change',
  workspaceId: 'w-line',
  evidenceRevision: 'rev-1',
  action: { kind: 'advise', templateId: 'scope-change', evidenceIds: ['effect-classes', 'approved-scope-counts'] },
  reasonCodes: provider.scopeReasonCodes({ classes: ['PACKAGE_INSTALL'], effects: 1, paused: 1, assessed: 1, cacheHit, reasonCode: 'SCOPE_JEV' }),
  durationMs: 42,
});

const explained = async (engine, id) => {
  assert.equal(typeof id, 'string', 'the decision was recorded');
  const record = await engine.lookup(id);
  assert.notEqual(record, null);
  return { record, text: core.explainDecision(record), provider: core.explainDecision(record).split('\n').find((l) => l.startsWith('Provider:')) };
};

test('a summary record of a run that asked Jev says its question has a record of its own, and no longer says no provider call was made beside "asked Jev"', async (t) => {
  for (const adviser of ADVISERS) {
    const { engine } = await setup(t, jevAnswer);
    const run = await adviser.live(engine);
    const summary = await explained(engine, run.summary);
    assert.equal(summary.record.billingBasis, 'no-provider-call', `${adviser.spec}: the summary itself makes no call, so its usage and billing stay as they were`);
    assert.equal(summary.record.usage, null);
    assert.match(summary.text, adviser.asked, `${adviser.spec}: the adviser's own line says Jev was asked`);
    assert.equal(summary.provider, 'Provider: none on this record, which is the summary of a run. Jev was asked, and each question is its own decision record, which shows whether a call went out, the model and the usage.', adviser.spec);
    assert.doesNotMatch(summary.text, /no provider call was made|no model answered/, `${adviser.spec}: the text does not say both`);
    // The question's own record is the engine's: the model and the usage, and nothing of the adviser's lines.
    const call = await explained(engine, run.call);
    assert.equal(call.provider, 'Provider: model jev-1.13.0, 300 input and 10 output tokens; usage as reported by the provider.', adviser.spec);
    assert.doesNotMatch(call.text, /Jev not asked|Jev was not asked|Jev gave no usable answer|Check ranking:|Slice classification:|Worker readiness:|Repeated failure:|New task:/, `${adviser.spec}: the call's own record is explained as a provider call`);
  }
  const { engine } = await setup(t, jevAnswer);
  const recorded = await engine.recordAdvice(SCOPE_RECORD(false));
  const scope = await explained(engine, recorded.decisionId);
  assert.match(scope.text, /\(asked Jev, 42 ms\)/);
  assert.match(scope.provider, /^Provider: none on this record, which is the summary of a run\. Jev was asked, and each question is its own decision record/);
  assert.doesNotMatch(scope.text, /no provider call was made|no model answered/);
});

test('a run answered from the decision cache says the cache answered; the cache-hit record names the model and that no call was made', async (t) => {
  for (const adviser of ADVISERS) {
    const { engine } = await setup(t, jevAnswer);
    await adviser.live(engine);
    const again = await adviser.live(engine);
    const summary = await explained(engine, again.summary);
    assert.match(summary.text, adviser.cached, `${adviser.spec}: the adviser's own line says the cache answered`);
    assert.equal(summary.provider, 'Provider: no provider call was made; the decision cache answered. The call that filled the cache is its own decision record.', adviser.spec);
    assert.doesNotMatch(summary.text, /no model answered/);
    const hit = await explained(engine, again.call);
    assert.deepEqual(hit.record.reasonCodes.includes('CACHE_HIT'), true, `${adviser.spec}: ${again.call} is the cache-hit record`);
    assert.equal(hit.provider, 'Provider: model jev-1.13.0; no provider call was made.', adviser.spec);
    assert.doesNotMatch(hit.text, /Jev not asked|Jev was not asked|Jev gave no usable answer/);
  }
  const { engine } = await setup(t, jevAnswer);
  const recorded = await engine.recordAdvice(SCOPE_RECORD(true));
  const scope = await explained(engine, recorded.decisionId);
  assert.match(scope.text, /\(cache hit, 42 ms\)/);
  assert.match(scope.provider, /^Provider: no provider call was made; the decision cache answered\./);
});

test('a run that never asked Jev still says no provider call was made, and the adviser says Jev was not asked', async (t) => {
  for (const adviser of ADVISERS.filter((a) => a.rules !== null)) {
    const { engine, requests } = await setup(t, jevAnswer);
    const id = await adviser.rules(engine);
    const summary = await explained(engine, id);
    assert.equal(summary.provider, 'Provider: no model answered; no provider call was made.', adviser.spec);
    assert.match(summary.text, adviser.notAsked, `${adviser.spec}: the adviser's own line says Jev was not asked`);
    assert.equal(requests.length, 0, `${adviser.spec}: no request left`);
  }
});

/** A record of the contract's shape, for the shapes no adviser produces on a healthy run. */
function record(over = {}) {
  return {
    schemaVersion: '1.0',
    decisionId: 'd-00000000-0000-4000-8000-000000000001',
    specId: 'route',
    modelResolved: null,
    mode: 'advise',
    evidenceRevision: 'rev-1',
    outcome: 'abstained',
    reasonCodes: ['DEADLINE'],
    proposedAction: { kind: 'abstain', reasonCode: 'DEADLINE' },
    appliedAction: null,
    usage: null,
    billingBasis: 'no-provider-call',
    actualTaskOutcome: 'not-yet-observed',
    providerCalls: 0,
    ...over,
  };
}

test('a record that shows a provider call names the model and the usage, or says the usage is unknown; one that made none says so', () => {
  const line = (over) => core.explainDecision(record(over)).split('\n').find((l) => l.startsWith('Provider:'));
  assert.equal(line({ outcome: 'advisory', modelResolved: 'jev-1.13.0', usage: { inputTokens: 300, outputTokens: 10 }, billingBasis: 'provider-reported-usage', providerCalls: 1, reasonCodes: ['DECISION_ADVISORY'], proposedAction: { kind: 'advise', templateId: 'route', evidenceIds: [] } }), 'Provider: model jev-1.13.0, 300 input and 10 output tokens; usage as reported by the provider.');
  assert.equal(line({ outcome: 'abstained', modelResolved: 'jev-1.13.0', usage: null, billingBasis: 'estimate-pending-reconcile', providerCalls: 1 }), 'Provider: model jev-1.13.0; usage unknown; the reserved estimate is held until billing is reconciled.');
  assert.equal(line({ outcome: 'abstained' }), 'Provider: no model answered; no provider call was made.');
  // A summary-shaped record that does carry a call (a model, usage and a billing basis) is explained by what it carries, never as "none on this record".
  const carrying = line({ specId: 'repeated-failure', outcome: 'advisory', modelResolved: 'jev-1.13.0', usage: { inputTokens: 5, outputTokens: 1 }, billingBasis: 'provider-reported-usage', providerCalls: 1, reasonCodes: ['FAIL_FAMILY_SHELL_NONZERO', 'FAIL_ASKED_1', 'JEV_CACHE_MISS', 'DECISION_ADVISORY'], proposedAction: { kind: 'advise', templateId: 'repeated-failure', evidenceIds: [] } });
  assert.equal(carrying, 'Provider: model jev-1.13.0, 5 input and 1 output tokens; usage as reported by the provider.');
});

test('the explain op carries the same text, and the structured trace fields of the summary are unchanged', async (t) => {
  const { home, engine } = await setup(t, jevAnswer);
  const run = await ADVISERS[0].live(engine);
  const request = { op: 'explain', client: 'cli', scopes: ['status', 'advice'], workspace: { id: FAIL_IDS.workspaceId, root: null }, body: { decisionId: run.summary }, home, signal: new AbortController().signal, deadline: createDeadline(30_000), store: undefined, killSwitchStopped: false, engine, trace() {}, mode: 'advise' };
  const out = await ops.explain.handle(request);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(contracts.surfacePayloadContract('explain').validate(out.body).ok, true, JSON.stringify(out.body));
  assert.match(out.body.trace.rendered, /Provider: none on this record, which is the summary of a run\. Jev was asked/);
  assert.doesNotMatch(out.body.trace.rendered, /no provider call was made/);
  assert.deepEqual([out.body.trace.resolvedModel, out.body.trace.usage], [null, { known: false, inputTokens: null, outputTokens: null }], 'the record\'s own fields are what they were: the summary holds no model and no usage');
});

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { load, story } from './lib.mjs';

// US31: the repository moves while Jev evaluates a packet. The product's decision subscriber (the
// one the sidecar registers for hook events) asks the sidecar engine for a task-intent decision;
// the engine's Jev endpoint is scripted, and answers only after the agent has written a file (so
// the workspace revision moved). The late answer is kept, labelled stale, and never shown or
// applied. A fresh decision runs on the new revision only when it is still useful (no newer
// request superseded it) and affordable (the decision budget still covers it).

/** A scripted Jev endpoint that answers every question; `hold.during()` runs before the first answer. */
function lateJev() {
  const requests = [];
  const hold = { during: null };
  const fetch = async (_url, init) => {
    const run = hold.during;
    hold.during = null;
    if (run !== null) await run();
    const body = JSON.parse(init.body);
    requests.push(body);
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      if (q.type === 'noul') answers[id] = { type: 'noul', noul: 0.9 };
      else if (q.type === 'score') {
        const probabilities = Object.fromEntries(q.criteria.map((_, i) => [String(i), i === 0 ? 1 : 0]));
        answers[id] = { type: 'score', score: 0, probabilities, legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])), confidence: 1 };
      } else {
        const keys = Object.keys(q.criteria);
        const rest = keys.slice(1);
        const probabilities = Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.9 : Math.round((0.1 / rest.length) * 10000) / 10000]));
        answers[id] = { type: 'choice', choice: keys[0], probabilities, confidence: 0.9 };
      }
    }
    return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 300, output_tokens: 10 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, requests, hold };
}

let serial = 0;
function hookEvent(kind, extra = {}) {
  serial += 1;
  return {
    schemaVersion: '1.0', harness: 'claude', nativeEventName: 'Hook', kind, sessionId: 'us31', turnId: null, toolUseId: `tu-us31-${serial}`, toolName: null,
    agentId: null, model: null, permissionMode: null, cwd: null, trigger: null, blocking: true, responseRequired: false, payload: {}, dedupKey: `${'c'.repeat(56)}${String(serial).padStart(8, '0')}`, ...extra,
  };
}

const UNKNOWNS = [{ id: 'u1', topic: 'Should totals round per line or per order', options: ['per line', 'per order'], consequence: 'the stored invoice amounts' }];

story('US31', async ({ then, sandbox, evidence }) => {
  const provider = await load('provider-typesafe');
  const box = await sandbox();
  const scenario = async (name, during) => {
    const jev = lateJev();
    const home = join(box.dir, `home-${name}`);
    const engine = await provider.createSidecarEngine({ home, credential: 'test-key-not-a-secret', fetch: jev.fetch, env: {}, sourceEgress: () => ({ provenance: 'administrator', sourceEgress: 'approved-scoped' }) });
    const sub = provider.createDecisionSubscriber({ handlers: provider.DEFAULT_TRIGGER_HANDLERS });
    const ctx = (envelope, extra = {}) => ({
      op: 'event', client: 'hook', scopes: ['observe'], workspace: { id: `w-us31-${name}`, root: box.work }, body: { envelope, deliveryKey: `k-${envelope.toolUseId}`, revision: 'rev-7', harnessVersion: '2.1.0', ...extra },
      home, signal: new AbortController().signal, deadline: { remainingMs: () => 1500, expired: () => false }, store: null, killSwitchStopped: false, engine, trace() {},
    });
    jev.hold.during = () => during({ sub, ctx, engine });
    const result = await sub.handle(ctx(hookEvent('task.requested'), { task: { objective: `Add invoice totals (${name})`, unknowns: UNKNOWNS } }));
    const ids = await engine.journal.list();
    const records = (await Promise.all(ids.map((id) => engine.lookup(id)))).filter((r) => r !== null);
    return { result, records, requests: jev.requests };
  };
  const wrote = ({ sub, ctx }) => sub.handle(ctx(hookEvent('tool.finished', { toolName: 'Edit' })));

  // 1. Useful and affordable: the agent wrote a file while Jev was evaluating.
  const useful = await scenario('useful', wrote);
  // 2. Not useful: a newer task request on the new revision superseded the first one.
  const superseded = await scenario('superseded', ({ sub, ctx }) => sub.handle(ctx(hookEvent('task.requested'), { revision: 'rev-8', task: { objective: 'Add invoice totals (newer)', unknowns: UNKNOWNS } })));
  // 3. Not affordable: the agent wrote a file and other work took what was left of the decision budget.
  const unaffordable = await scenario('unaffordable', async (input) => {
    await wrote(input);
    const left = await input.engine.budget.snapshot();
    const taken = await input.engine.budget.reserve({ decisionId: 'other-job', workspaceId: 'w-other', microUsd: left.availableMicroUsd });
    assert.equal(taken.ok, true, JSON.stringify(taken));
  });
  const brief = (s) => ({ hook: s.result.hookOutcome, reasonCode: s.result.reasonCode, requests: s.requests.length, records: s.records.map((r) => [r.outcome, r.reasonCodes[0], r.evidenceRevision]) });
  evidence({ useful: brief(useful), superseded: brief(superseded), unaffordable: brief(unaffordable) });

  await then('It may be stored for analysis but cannot actuate', () => {
    for (const s of [useful, superseded, unaffordable]) {
      const stale = s.records.filter((r) => r.outcome === 'stale');
      assert.equal(stale.length, 1, JSON.stringify(brief(s)));
      assert.deepEqual([stale[0].reasonCodes[0], stale[0].evidenceRevision, stale[0].proposedAction.kind, stale[0].appliedAction ?? null], ['STALE_REVISION', 'rev-7', 'abstain', null]);
    }
    // Nothing from the stale answer reaches the developer.
    assert.deepEqual(superseded.result.hookOutcome, { kind: 'observe' });
    assert.deepEqual(unaffordable.result.hookOutcome, { kind: 'observe' });
  });

  await then('a fresh decision is scheduled only if still useful and affordable', () => {
    assert.equal(useful.requests.length, 2, 'one fresh decision on the new revision');
    assert.equal(useful.result.reasonCode, 'AMBIGUITY_MATERIAL');
    const fresh = useful.records.find((r) => r.decisionId === useful.result.decisionIds[0]);
    assert.deepEqual([fresh.outcome, fresh.evidenceRevision], ['advisory', 'rev-7.w1']);
    assert.deepEqual(superseded.requests.map((r) => r.state.objective).sort(), ['Add invoice totals (newer)', 'Add invoice totals (superseded)'], 'the superseded request was not asked again');
    assert.equal(unaffordable.requests.length, 1, 'no fresh decision without budget');
  });
});

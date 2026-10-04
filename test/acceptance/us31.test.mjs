import assert from 'node:assert/strict';
import { join } from 'node:path';
import { load, story } from './lib.mjs';

// US31: the repository moves while Jev evaluates a packet. The product's decision subscriber (the
// one the sidecar registers for hook events) runs the new-task advice (the task family, C01, and
// the open point, C02, over the request) through the sidecar engine; the engine's Jev endpoint is
// scripted, and answers only after the agent has written a file (so the workspace revision moved).
// The late answers are kept, labelled stale, and never shown or applied. A fresh decision runs on
// the new revision only when it is still useful (no newer request superseded it) and affordable
// (the decision budget still covers it). The advice is detached from the hook, so the story awaits
// the background work the handler hands out.

/** A scripted Jev endpoint that answers every question; `hold.during()` runs before the first answer. */
function lateJev(inputTokens = 300) {
  const requests = [];
  const hold = { during: null };
  let gate = null;
  let arrived = 0;
  let release = () => {};
  const both = new Promise((resolve) => {
    release = resolve;
    setTimeout(resolve, 10_000).unref();
  });
  const fetch = async (_url, init) => {
    // The new-task advice asks two decisions side by side (the family and the open point). Once both are on the wire
    // (each has reserved its budget), `during` runs; every request of the scenario waits for it, so the answers are all late together.
    arrived += 1;
    if (arrived === 2) {
      const run = hold.during;
      hold.during = null;
      gate = Promise.resolve().then(() => (run === null ? undefined : run()));
      release();
    }
    await both;
    if (gate !== null) await gate;
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
    return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: inputTokens, output_tokens: 10 } }), { status: 200, headers: { 'content-type': 'application/json' } });
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
  const scenario = async (name, during, inputTokens) => {
    const jev = lateJev(inputTokens);
    const home = join(box.dir, `home-${name}`);
    const engine = await provider.createSidecarEngine({ home, credential: 'test-key-not-a-secret', fetch: jev.fetch, env: {}, sourceEgress: () => ({ provenance: 'administrator', sourceEgress: 'approved-scoped' }) });
    // The product's handler for the new-task trigger, with its background work kept so the story can wait for it.
    const store = new provider.PendingAdviceStore();
    const tracked = [];
    const handlers = { ...provider.DEFAULT_TRIGGER_HANDLERS, 'new-task': [provider.createNewTaskHandler({ store, deadlineMs: 30_000, lateGraceMs: 30_000, background: (work) => { tracked.push(work.catch(() => undefined)); } })] };
    const sub = provider.createDecisionSubscriber({ handlers });
    const ctx = (envelope, extra = {}) => ({
      op: 'event', client: 'hook', scopes: ['observe'], workspace: { id: `w-us31-${name}`, root: box.work }, body: { envelope, deliveryKey: `k-${envelope.toolUseId}`, revision: 'rev-7', harnessVersion: '2.1.0', ...extra },
      home, signal: new AbortController().signal, deadline: { remainingMs: () => 1500, expired: () => false }, store: null, killSwitchStopped: false, engine, trace() {},
    });
    jev.hold.during = () => during({ sub, ctx, engine });
    const result = await sub.handle(ctx(hookEvent('task.requested'), { task: { objective: `Add invoice totals (${name})`, unknowns: UNKNOWNS } }));
    // Wait until the background work has settled (a nested request adds to it while the first one is held).
    for (let seen = -1; seen !== tracked.length; ) {
      seen = tracked.length;
      await Promise.all(tracked);
    }
    const ids = await engine.journal.list();
    const records = (await Promise.all(ids.map((id) => engine.lookup(id)))).filter((r) => r !== null);
    return { result, records, requests: jev.requests, line: store.peek(`w-us31-${name}`, 'us31') };
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
    // The late answers cost what they cost (a long answer, reported as 3000 input tokens each), so settling them frees nothing
    // that would pay for a fresh decision.
  }, 3000);
  const brief = (s) => ({ hook: s.result.hookOutcome, requests: s.requests.length, line: s.line === null || s.line === undefined ? null : s.line.kind, records: s.records.map((r) => [r.outcome, r.reasonCodes[0], r.evidenceRevision]) });
  /** How many requests carried the request text of a scenario (as the one screened evidence span). */
  const carrying = (s, text) => s.requests.filter((r) => JSON.stringify(r.state).includes(text)).length;
  evidence({ useful: brief(useful), superseded: brief(superseded), unaffordable: brief(unaffordable) });

  await then('It may be stored for analysis but cannot actuate', () => {
    for (const s of [useful, superseded, unaffordable]) {
      // The family decision (C01) and the open-point decision (C02) each came back late: two stale records, each kept as analysis.
      const stale = s.records.filter((r) => r.outcome === 'stale');
      assert.equal(stale.length, 2, JSON.stringify(brief(s)));
      for (const r of stale) assert.deepEqual([r.reasonCodes[0], r.evidenceRevision, r.proposedAction.kind, r.appliedAction ?? null], ['STALE_REVISION', 'rev-7', 'abstain', null]);
    }
    // Nothing from the stale answer reaches the developer: the hook is observe, and with no fresh decision no line waits.
    for (const s of [useful, superseded, unaffordable]) assert.deepEqual(s.result.hookOutcome, { kind: 'observe' });
    assert.equal(unaffordable.line, null, 'a late answer never becomes advice');
  });

  await then('a fresh decision is scheduled only if still useful and affordable', () => {
    // Two requests asked on the old revision, and one fresh request each for the two decisions on the new revision.
    assert.equal(useful.requests.length, 4, 'one fresh decision on the new revision for each of the two');
    const fresh = useful.records.filter((r) => r.evidenceRevision === 'rev-7.w1');
    assert.equal(fresh.length, 2);
    assert.deepEqual([...new Set(fresh.map((r) => r.outcome))], ['advisory']);
    assert.equal(useful.line.kind, 'new-task', 'the advice comes from the fresh decisions only');
    // The superseded request was not asked again; the newer one (on rev-8) was asked once, as two decisions.
    assert.equal(carrying(superseded, 'Add invoice totals (superseded)'), 2, 'the superseded request was asked once, as two decisions');
    assert.equal(carrying(superseded, 'Add invoice totals (newer)'), 2, 'the newer request was asked once, as two decisions');
    assert.equal(unaffordable.requests.length, 2, 'no fresh decision without budget');
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const core = await import('../dist/index.js');
const { TriggerFilter, toEventEnvelope, DecisionCache, cacheKey, cacheable, DecisionQueues, arbitrate, checkPackOwnership, DecisionRescheduler, staleFromLedger } = core;

const sha = (text) => createHash('sha256').update(text).digest('hex');
let n = 0;

function envelope(kind, { tool = null, summary = {}, revision = 'rev-1', taskId = 'task-1', session = 's1', model = null } = {}) {
  n += 1;
  const result = toEventEnvelope({
    event: {
      schemaVersion: '1.0', harness: 'claude', nativeEventName: 'Hook', kind, sessionId: session, turnId: null, toolUseId: `tu${n}`, toolName: tool,
      agentId: null, model, permissionMode: null, cwd: null, trigger: null, blocking: false, responseRequired: false, payload: summary, dedupKey: sha(`e${n}`),
    },
    workspaceId: 'w1', sequence: n, occurredAt: '2026-09-25T10:00:00Z', expectedRevision: revision, deadlineAt: '2026-09-25T10:00:01Z', taskId,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.envelope;
}

test('DEC-08: reads, keystrokes and status renders never trigger; each real trigger fires once per task and revision', () => {
  const filter = new TriggerFilter();
  assert.equal(filter.classify(envelope('tool.proposed', { tool: 'Read' })).reasonCode, 'READ_ONLY');
  assert.equal(filter.classify(envelope('tool.finished', { tool: 'Grep' })).reasonCode, 'READ_ONLY');
  assert.equal(filter.classify(envelope('ui.keystroke')).reasonCode, 'NO_TRIGGER');
  assert.equal(filter.classify(envelope('status.render')).reasonCode, 'NO_TRIGGER');
  assert.equal(filter.classify(envelope('session.ended')).reasonCode, 'NO_TRIGGER');
  assert.equal(filter.classify(envelope('task.requested')).trigger, 'new-task');
  assert.equal(filter.classify(envelope('task.requested')).reasonCode, 'COALESCED', 'same task and revision');
  assert.equal(filter.classify(envelope('task.requested', { revision: 'rev-2' })).trigger, 'new-task', 'a new revision is a new trigger');
  assert.equal(filter.classify(envelope('model.change.requested', { model: 'opus' })).trigger, 'model-change-request');
  assert.equal(filter.classify(envelope('context.compacting')).trigger, 'context-checkpoint');
  assert.equal(filter.classify(envelope('tool.proposed', { tool: 'Agent' })).trigger, 'worker-creation');
  assert.equal(filter.classify(envelope('tool.finished', { tool: 'Skill', summary: { candidates: 5 } })).trigger, 'candidate-retrieval');
});

test('DEC-08: a new failure family triggers; an unchanged repeat triggers at the threshold; a changed failure resets', () => {
  const filter = new TriggerFilter({ repeatThreshold: 3 });
  const fail = (fingerprint) => envelope('tool.failed', { tool: 'Bash', summary: { failureFamily: 'test-failure', fingerprint } });
  assert.equal(filter.classify(fail('f1')).trigger, 'new-failure-family');
  assert.equal(filter.classify(fail('f1')).reasonCode, 'BELOW_THRESHOLD');
  assert.equal(filter.classify(fail('f1')).trigger, 'repeated-failure');
  assert.equal(filter.classify(fail('f2')).reasonCode, 'BELOW_THRESHOLD', 'a changed failure is progress, not a repeat');
  assert.equal(filter.classify(envelope('tool.failed', { tool: 'Bash', summary: { failureFamily: 'type-error' } })).trigger, 'new-failure-family');
});

test('DEC-08: writes accumulate to a diff boundary', () => {
  const filter = new TriggerFilter({ writesPerBoundary: 3, diffLinesPerBoundary: 1000 });
  const write = () => filter.classify(envelope('tool.finished', { tool: 'Edit', summary: { changedLines: 2 } }));
  assert.equal(write().reasonCode, 'BELOW_THRESHOLD');
  assert.equal(write().reasonCode, 'BELOW_THRESHOLD');
  assert.equal(write().trigger, 'diff-boundary');
  const big = new TriggerFilter({ writesPerBoundary: 50, diffLinesPerBoundary: 100 });
  assert.equal(big.classify(envelope('tool.finished', { tool: 'Write', summary: { changedLines: 150 } })).trigger, 'diff-boundary');
});

test('DEC-08 replay: a realistic session log makes decisions only at triggers', () => {
  const filter = new TriggerFilter();
  const log = [
    ['task.requested'],
    ...Array.from({ length: 40 }, () => ['tool.proposed', { tool: 'Read' }]),
    ...Array.from({ length: 30 }, () => ['status.render']),
    ...Array.from({ length: 4 }, () => ['tool.finished', { tool: 'Edit', summary: { changedLines: 3 } }]),
    ['tool.failed', { tool: 'Bash', summary: { failureFamily: 'test-failure', fingerprint: 'x' } }],
    ['tool.failed', { tool: 'Bash', summary: { failureFamily: 'test-failure', fingerprint: 'x' } }],
    ...Array.from({ length: 20 }, () => ['tool.finished', { tool: 'Grep' }]),
    ['task.requested'],
  ];
  const triggers = log.map(([kind, opts]) => filter.classify(envelope(kind, opts ?? {}))).filter((r) => r.trigger !== null).map((r) => r.trigger);
  assert.deepEqual(triggers, ['new-task', 'new-failure-family', 'repeated-failure']);
});

const validity = {
  workspaceId: 'w1', packetHash: `sha256:${'1'.repeat(64)}`, questionHash: `sha256:${'2'.repeat(64)}`, questionOrderHash: `sha256:${'3'.repeat(64)}`,
  encoderId: 'jevris-conservative-v1', route: 'typesafe-sdk', model: 'jev-1.13.0', policyVersion: 'p1', calibrationVersion: null,
};

test('DEC-09: the cache hits on an identical key and misses on any single key change; security decisions are never cached', () => {
  const cache = new DecisionCache();
  const result = { id: 'd-1', specId: 's' };
  cache.set(validity, result, 'd-1');
  assert.equal(cache.get({ ...validity }).result, result);
  for (const key of Object.keys(validity)) {
    const changed = { ...validity, [key]: key === 'calibrationVersion' ? 'cal-2' : `${validity[key]}x` };
    assert.notEqual(cacheKey(changed), cacheKey(validity), key);
    assert.equal(cache.get(changed), null, `${key} change misses`);
  }
  assert.equal(cacheable({ specId: 'task-profile', risk: 'routine' }), true);
  assert.equal(cacheable({ specId: 'task-profile', risk: 'sensitive' }), false);
  assert.equal(cacheable({ specId: 'egress-check' }), false);
  assert.equal(cacheable({ specId: 'security.review' }), false);
  let now = 0;
  const expiring = new DecisionCache({ ttlMs: 100, now: () => now });
  expiring.set(validity, result, 'd-1');
  now = 101;
  assert.equal(expiring.get(validity), null, 'entries expire');
});

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

test('DEC-10: a background flood never occupies the interactive lane, and observations are shed first', async () => {
  const queues = new DecisionQueues({ interactiveConcurrency: 2, interactiveQueue: 8, backgroundConcurrency: 2, backgroundQueue: 4 });
  const gate = deferred();
  const background = [];
  for (let i = 0; i < 2; i += 1) background.push(queues.submit('background', 'decision', () => gate.promise));
  for (let i = 0; i < 4; i += 1) background.push(queues.submit('background', 'observation', () => gate.promise));
  // The background lane is full: a decision sheds the oldest queued observation.
  background.push(queues.submit('background', 'decision', () => gate.promise));
  assert.deepEqual(await background[2], { ok: false, reasonCode: 'SHED' });
  for (let i = 0; i < 3; i += 1) background.push(queues.submit('background', 'decision', () => gate.promise));
  const refused = queues.submit('background', 'decision', () => gate.promise);
  // Interactive work completes while every background worker is blocked.
  const interactive = await Promise.all(Array.from({ length: 6 }, (_, i) => queues.submit('interactive', 'decision', async () => i)));
  assert.deepEqual(interactive.map((r) => r.value), [0, 1, 2, 3, 4, 5]);
  const stats = queues.stats();
  assert.equal(stats.background.active, 2, 'background still blocked');
  assert.ok(stats.background.shed >= 1);
  gate.resolve('done');
  const settled = await Promise.all([...background, refused]);
  assert.ok(settled.some((r) => r.reasonCode === 'QUEUE_FULL'), 'with no observation left, a decision is refused');
  assert.equal(settled.filter((r) => r.reasonCode === 'SHED').length, 4, 'every queued observation was shed before any decision');
});

test('DEC-10 load: under a background flood the interactive p95 stays at its unloaded level (counted in scheduler turns)', async () => {
  const turns = () => new Promise((r) => setImmediate(r));
  async function run(flood) {
    const queues = new DecisionQueues({ interactiveConcurrency: 4, backgroundConcurrency: 2, backgroundQueue: 64 });
    const block = deferred();
    if (flood) for (let i = 0; i < 500; i += 1) queues.submit('background', i % 2 ? 'observation' : 'decision', () => block.promise);
    const waits = [];
    for (let i = 0; i < 40; i += 1) {
      let ticks = 0;
      let done = false;
      const job = queues.submit('interactive', 'decision', async () => {
        done = true;
      });
      while (!done) {
        await turns();
        ticks += 1;
      }
      await job;
      waits.push(ticks);
    }
    block.resolve();
    waits.sort((a, b) => a - b);
    return waits[Math.ceil(0.95 * waits.length) - 1];
  }
  const quiet = await run(false);
  const loaded = await run(true);
  assert.ok(loaded <= quiet, `interactive p95 ${loaded} turns under flood vs ${quiet} quiet`);
});

test('DEC-10: queued work whose deadline passed is dropped, not started', async () => {
  const queues = new DecisionQueues({ interactiveConcurrency: 1, interactiveQueue: 4 });
  const gate = deferred();
  const first = queues.submit('interactive', 'decision', () => gate.promise);
  let started = false;
  const late = queues.submit('interactive', 'decision', async () => (started = true), { expired: () => true });
  gate.resolve(1);
  assert.deepEqual(await first, { ok: true, value: 1 });
  assert.deepEqual(await late, { ok: false, reasonCode: 'DEADLINE' });
  assert.equal(started, false);
});

const advise = (templateId) => ({ kind: 'advise', templateId, evidenceIds: [] });
const veto = (reasonCode) => ({ kind: 'abstain', reasonCode });

test('DEC-13: two packs claiming one domain are rejected at install unless a priority is configured', () => {
  const packs = [
    { packId: 'router-a', owns: ['model-routing'] },
    { packId: 'router-b', owns: ['model-routing', 'effort'] },
    { packId: 'context', owns: ['context-checkpoint'] },
  ];
  const refused = checkPackOwnership(packs);
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.conflicts, [{ domain: 'model-routing', packs: ['router-a', 'router-b'] }]);
  const resolved = checkPackOwnership(packs, { 'model-routing': 'router-b' });
  assert.deepEqual(resolved.owners, { 'context-checkpoint': 'context', effort: 'router-b', 'model-routing': 'router-b' });
});

test('DEC-13: the fixed resolution order, one owner per domain, and compatible domains coexisting', () => {
  const owners = { 'model-routing': 'router', 'context-checkpoint': 'context' };
  const proposals = [
    { packId: 'router', domain: 'model-routing', tier: 'optimization', action: advise('route-worker') },
    { packId: 'rogue-router', domain: 'model-routing', tier: 'optimization', action: advise('route-other') },
    { packId: 'context', domain: 'context-checkpoint', tier: 'optimization', action: advise('checkpoint') },
    { packId: 'style', domain: 'model-routing', tier: 'advisory', action: advise('prefer-small') },
  ];
  const result = arbitrate(proposals, owners);
  assert.deepEqual(result.accepted.map((p) => p.packId).sort(), ['context', 'router']);
  const reasons = Object.fromEntries(result.rejected.map((r) => [r.proposal.packId, r.reasonCode]));
  assert.equal(reasons['rogue-router'], 'NOT_DOMAIN_OWNER');
  assert.equal(reasons.style, 'OVERRIDDEN_BY_HIGHER_TIER');
  const shuffled = arbitrate([...proposals].reverse(), owners);
  assert.deepEqual(shuffled.accepted.map((p) => p.packId).sort(), ['context', 'router'], 'order-independent');

  const vetoed = arbitrate(
    [
      { packId: 'org', domain: '*', tier: 'organization-security', action: veto('ORG_FREEZE') },
      { packId: 'router', domain: 'model-routing', tier: 'optimization', action: advise('route-worker') },
      { packId: 'verify', domain: 'verification', tier: 'mandatory-verification', action: advise('run-checks') },
    ],
    owners,
  );
  assert.deepEqual(vetoed.accepted.map((p) => p.packId), ['org']);
  assert.ok(vetoed.rejected.every((r) => r.reasonCode === 'VETOED_BY_ORGANIZATION_SECURITY'));
  const human = arbitrate(
    [
      { packId: 'user', domain: 'model-routing', tier: 'human-instruction', action: veto('USER_PINNED_MODEL') },
      { packId: 'router', domain: 'model-routing', tier: 'optimization', action: advise('route-worker') },
      { packId: 'context', domain: 'context-checkpoint', tier: 'optimization', action: advise('checkpoint') },
    ],
    owners,
  );
  assert.deepEqual(human.accepted.map((p) => p.packId).sort(), ['context', 'user'], 'a human pin blocks routing only');
});

test('DEC-12: the rescheduler issues a fresh decision only when the revision moved and it is useful and affordable', async () => {
  const calls = [];
  const engine = {
    budget: { snapshot: async () => ({ availableMicroUsd: 100 }) },
    decide: async (request) => {
      calls.push(request.evidenceRevision);
      return { abstained: true, reasonCode: 'PROVIDER_NOT_CONFIGURED', decisionId: 'd-x', fallback: 'abstain' };
    },
  };
  const stale = staleFromLedger([
    { decisionId: 'a', evidenceRevision: 'r1', freshDecision: 'scheduled' },
    { decisionId: 'b', evidenceRevision: 'r1', freshDecision: 'not-scheduled' },
    { decisionId: 'c', evidenceRevision: 'r1', freshDecision: 'scheduled' },
    { decisionId: 'd', evidenceRevision: 'r5', freshDecision: 'scheduled' },
  ]);
  assert.deepEqual(stale.map((s) => s.decisionId), ['a', 'c', 'd']);
  const rescheduler = new DecisionRescheduler();
  const input = {
    engine,
    stale,
    currentRevision: () => 'r5',
    stillUseful: (s) => s.decisionId !== 'c',
    rebuild: (s, revision) => ({ evidenceRevision: revision }),
    estimateMicroUsd: 50,
  };
  const results = await rescheduler.run(input);
  assert.deepEqual(results.map((r) => [r.decisionId, r.rescheduled, r.reasonCode ?? null]), [
    ['a', true, null],
    ['c', false, 'NOT_USEFUL'],
    ['d', false, 'SAME_REVISION'],
  ]);
  assert.deepEqual(calls, ['r5'], 'the fresh decision is on the new revision');
  const again = await rescheduler.run(input);
  assert.equal(again[0].reasonCode, 'ALREADY_RESCHEDULED');
  const poor = await new DecisionRescheduler().run({ ...input, engine: { ...engine, budget: { snapshot: async () => ({ availableMicroUsd: 10 }) } } });
  assert.equal(poor[0].reasonCode, 'NOT_AFFORDABLE');
  assert.deepEqual(calls, ['r5']);
});

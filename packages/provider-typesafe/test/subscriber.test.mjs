import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const { createDecisionSubscriber, sidecarEventSubscribers, recordsCertificationSource, cliCertificationSource, isCertified, modelChangeAdviceWith } = await import('../dist/index.js');
const { AdviceOnce } = await import('@jevris/core');

const NOW = Date.parse('2026-09-25T10:00:00Z');
const sha = (text) => createHash('sha256').update(text).digest('hex');
let n = 0;

function harnessEvent(kind, { toolName = null, payload = {}, dedup } = {}) {
  n += 1;
  return {
    schemaVersion: '1.0', harness: 'claude', nativeEventName: 'Hook', kind, sessionId: 'sess-1', turnId: null, toolUseId: `tu-${n}`, toolName,
    agentId: null, model: null, permissionMode: null, cwd: null, trigger: null, blocking: true, responseRequired: false, payload, dedupKey: dedup ?? sha(`event-${n}`),
  };
}

function ctx(envelope, { harnessVersion = '2.1.0', killSwitchStopped = false, revision = 'rev-1', taskId = 'task-1' } = {}) {
  const body = { envelope, deliveryKey: `k-${envelope.dedupKey.slice(0, 8)}`, revision, taskId };
  if (harnessVersion !== null) body.harnessVersion = harnessVersion;
  return {
    op: 'event', client: 'hook', scopes: ['observe'], workspace: { id: 'w1', root: '/nowhere' }, body, home: '/nonexistent-home', signal: new AbortController().signal,
    deadline: { remainingMs: () => 500, expired: () => false }, store: null, killSwitchStopped, engine: undefined, trace: () => {},
  };
}

function record(features) {
  return {
    id: 'cert-claude-1', schemaVersion: '1.0', harness: 'claude', actuatorId: 'claude-hooks', harnessVersionRange: { minimum: '2.0.0', maximumExclusive: '3.0.0' },
    operatingSystems: ['darwin', 'linux', 'win32'], models: [], tools: [], limitations: [], fixtureSuiteHash: `sha256:${'a'.repeat(64)}`,
    features: features.map((featureId) => ({ featureId, status: 'certified', reasonCode: 'FIXTURES_PASSED' })),
    certifiedAt: '2026-09-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z', signature: 'sig',
  };
}

const certified = (features) => recordsCertificationSource(async () => [record(features)]);
const none = recordsCertificationSource(async () => []);

const route = { hookOutcome: { kind: 'route', model: 'claude-sonnet-4-5' }, fallbackText: 'Jevris suggests a smaller model for this worker.', reasonCode: 'ROUTE_ADVICE', decisionId: 'd-route' };
const context = { hookOutcome: { kind: 'context', text: 'Checkpoint: tests failing in parser.' }, reasonCode: 'CONTEXT_ADVICE', decisionId: 'd-context' };
const explain = { hookOutcome: { kind: 'explain', text: 'Same failure twice.' }, reasonCode: 'EXPLAIN', decisionId: 'd-explain' };

function subscriber(handlers, certifications) {
  return createDecisionSubscriber({ handlers, certifications, now: () => NOW, operatingSystem: 'linux' });
}

test('a certified route renders as route', async () => {
  const sub = subscriber({ 'worker-creation': [() => route] }, certified(['hooks.route']));
  const result = await sub.handle(ctx(harnessEvent('tool.proposed', { toolName: 'Agent' })));
  assert.equal(result.trigger, 'worker-creation');
  assert.deepEqual(result.hookOutcome, route.hookOutcome);
  assert.equal(result.certified, true);
  assert.deepEqual(result.decisionIds, ['d-route']);
});

test('an uncertified route is downgraded to explain with its fallback text, never rendered', async () => {
  for (const [label, source, options] of [
    ['no record', none, {}],
    ['feature not listed', certified(['hooks.context']), {}],
    ['only hooks.observe', certified(['hooks.observe']), {}],
    ['version out of range', certified(['hooks.route']), { harnessVersion: '3.0.0' }],
    ['version unknown', certified(['hooks.route']), { harnessVersion: null }],
  ]) {
    const sub = subscriber({ 'worker-creation': [() => route] }, source);
    const result = await sub.handle(ctx(harnessEvent('tool.proposed', { toolName: 'Agent' }), options));
    assert.deepEqual(result.hookOutcome, { kind: 'explain', text: route.fallbackText }, label);
    assert.equal(result.certified, false, label);
  }
  // A route always needs hooks.route: a proposal naming another feature cannot certify it (B's review).
  const relabelled = { ...route, featureId: 'hooks.context' };
  const self = await subscriber({ 'worker-creation': [() => relabelled] }, certified(['hooks.context'])).handle(ctx(harnessEvent('tool.proposed', { toolName: 'Agent' })));
  assert.deepEqual([self.hookOutcome, self.certified], [{ kind: 'explain', text: route.fallbackText }, false]);
  const bare = { ...route, fallbackText: undefined };
  const sub = subscriber({ 'worker-creation': [() => bare] }, none);
  const result = await sub.handle(ctx(harnessEvent('tool.proposed', { toolName: 'Agent' })));
  assert.deepEqual(result.hookOutcome, { kind: 'observe' }, 'a route with no fallback text becomes observe');
});

test('context renders only when certified; otherwise its text is shown as explain', async () => {
  const on = await subscriber({ 'context-checkpoint': [() => context] }, certified(['hooks.context'])).handle(ctx(harnessEvent('context.compacting')));
  assert.deepEqual(on.hookOutcome, context.hookOutcome);
  assert.equal(on.certified, true);
  const off = await subscriber({ 'context-checkpoint': [() => context] }, none).handle(ctx(harnessEvent('context.compacting')));
  assert.deepEqual(off.hookOutcome, { kind: 'explain', text: context.hookOutcome.text });
  assert.equal(off.certified, false);
});

test('the strongest proposal wins and every decision id is kept', async () => {
  const handlers = { 'new-failure-family': [() => explain, () => context, () => null] };
  const result = await subscriber(handlers, certified(['hooks.context'])).handle(ctx(harnessEvent('tool.failed', { toolName: 'Bash', payload: { failureFamily: 'test-failure' } })));
  assert.equal(result.hookOutcome.kind, 'context');
  assert.deepEqual([...result.decisionIds].sort(), ['d-context', 'd-explain']);
  const withRoute = await subscriber({ 'worker-creation': [() => context, () => route, () => explain] }, certified(['hooks.context', 'hooks.route'])).handle(
    ctx(harnessEvent('tool.proposed', { toolName: 'Agent' })),
  );
  assert.equal(withRoute.hookOutcome.kind, 'route');
  const uncertified = await subscriber({ 'worker-creation': [() => route, () => explain] }, none).handle(ctx(harnessEvent('tool.proposed', { toolName: 'Agent' })));
  assert.equal(uncertified.hookOutcome.kind, 'explain', 'a downgraded route competes as explain');
});

test('a duplicate delivery, the kill switch, a non-trigger and a failing handler all observe', async () => {
  let calls = 0;
  const sub = subscriber(
    {
      'new-task': [
        () => {
          calls += 1;
          return explain;
        },
      ],
      'worker-creation': [
        () => {
          throw new Error('boom');
        },
      ],
    },
    none,
  );
  const event = harnessEvent('task.requested', { dedup: sha('same-delivery') });
  assert.equal((await sub.handle(ctx(event))).hookOutcome.kind, 'explain');
  const duplicate = await sub.handle(ctx({ ...event }));
  assert.deepEqual(duplicate.hookOutcome, { kind: 'observe' });
  assert.equal(duplicate.reasonCode, 'DUPLICATE_DELIVERY');
  assert.equal(calls, 1);
  const stopped = await sub.handle(ctx(harnessEvent('task.requested'), { killSwitchStopped: true, revision: 'rev-9' }));
  assert.deepEqual([stopped.hookOutcome, stopped.reasonCode], [{ kind: 'observe' }, 'KILL_SWITCH']);
  const read = await sub.handle(ctx(harnessEvent('tool.proposed', { toolName: 'Read' })));
  assert.equal(read.reasonCode, 'READ_ONLY');
  const failing = await sub.handle(ctx(harnessEvent('tool.proposed', { toolName: 'Agent' })));
  assert.deepEqual([failing.hookOutcome, failing.reasonCode], [{ kind: 'observe' }, 'NO_PROPOSAL']);
  const junk = await sub.handle({ ...ctx(harnessEvent('task.requested')), body: { envelope: { kind: 'x' } } });
  assert.equal(junk.reasonCode, 'NOT_A_HARNESS_EVENT');
  assert.equal(calls, 1);
});

test('the registered subscriber is named and observes when no handler applies', async () => {
  assert.equal(sidecarEventSubscribers.length, 1);
  const [registered] = sidecarEventSubscribers;
  assert.equal(registered.name, 'decision-engine');
  const result = await registered.handle(ctx(harnessEvent('task.requested', { dedup: sha('registered') })));
  assert.equal(result.hookOutcome.kind, 'observe');
  assert.equal(result.certified, false);
});

test('the default source is F\'s loader; with no records, an unknown version or an unknown OS nothing is certified', async () => {
  const context = { harness: 'claude', harnessVersion: '2.1.0', operatingSystem: 'linux', featureId: 'hooks.route', nowMs: NOW };
  const answer = await cliCertificationSource.covers('/nonexistent-home', context);
  assert.equal(answer.certified, false);
  assert.equal(typeof answer.reasonCode, 'string');
  const source = certified(['hooks.route']);
  assert.deepEqual(await isCertified(source, '/h', { ...context, harnessVersion: null }), { certified: false, reasonCode: 'HARNESS_VERSION_UNKNOWN' });
  assert.deepEqual(await isCertified(source, '/h', { ...context, operatingSystem: null }), { certified: false, reasonCode: 'OS_UNKNOWN' });
  assert.deepEqual(await isCertified(source, '/h', { ...context, nowMs: Date.parse('2027-01-01T00:00:00Z') }), { certified: false, reasonCode: 'EXPIRED' });
  const broken = recordsCertificationSource(async () => {
    throw new Error('disk');
  });
  assert.deepEqual(await isCertified(broken, '/h', context), { certified: false, reasonCode: 'CERTIFICATIONS_UNAVAILABLE' });
});

test('the installed version can come from a host source when the event body has none', async () => {
  const sub = createDecisionSubscriber({
    handlers: { 'worker-creation': [() => route] },
    certifications: certified(['hooks.route']),
    now: () => NOW,
    operatingSystem: 'linux',
    harnessVersionOf: (_home, harness) => (harness === 'claude' ? '2.4.1' : null),
  });
  const result = await sub.handle(ctx(harnessEvent('tool.proposed', { toolName: 'Agent' }), { harnessVersion: null }));
  assert.equal(result.hookOutcome.kind, 'route');
  assert.equal(result.certified, true);
});

test('RTE-06: a model-change request without an evaluated recommendation stays silent; the pin from the hook is read, never overridden', async () => {
  const [registered] = sidecarEventSubscribers;
  const change = (dedup, pins) => {
    const event = harnessEvent('model.change.requested', { dedup: sha(dedup) });
    const c = ctx({ ...event, model: 'claude-sonnet-5' }, { revision: `rev-${dedup}` });
    c.body.pins = pins;
    return c;
  };
  const pinned = await registered.handle(change('pin-1', { modelPin: 'claude-opus-5', effortPin: null }));
  assert.equal(pinned.trigger, 'model-change-request');
  assert.deepEqual([pinned.hookOutcome, pinned.reasonCode], [{ kind: 'observe' }, 'NO_PROPOSAL']);
  const open = await registered.handle(change('open-1', null));
  assert.deepEqual(open.hookOutcome, { kind: 'observe' }, 'no calibrated recommendation: nothing is shown');
});

test('RTE-06, US14: route advice is marked shown only when its answer is delivered; a missed subscriber slice leaves it for the next event (D 1608a3d)', async () => {
  // A stub advise stands in for an evaluated recommendation (the real one needs a signed release).
  const once = new AdviceOnce();
  const advise = (snapshot) => ({ outcome: 'recommend', adviceKey: 'key-1', reasonCode: 'ROUTE_RECOMMEND', text: `Jevris suggests another model for ${snapshot.sessionId}.` });
  const subscriber = createDecisionSubscriber({ certifications: none, handlers: { 'model-change-request': [(input) => modelChangeAdviceWith(input, { advise, once })] } });
  const change = (dedup, signal) => {
    const event = harnessEvent('model.change.requested', { dedup: sha(dedup) });
    const c = ctx({ ...event, model: 'claude-sonnet-5' }, { revision: `rev-${dedup}` });
    if (signal !== undefined) c.signal = signal;
    return c;
  };
  // The slice ended before the answer: nothing is shown and the advice stays unshown.
  const ended = new AbortController();
  ended.abort();
  const missed = await subscriber.handle(change('missed-1', ended.signal));
  assert.deepEqual([missed.hookOutcome, missed.reasonCode], [{ kind: 'observe' }, 'ANSWER_NOT_WANTED']);
  assert.equal(once.seen('key-1'), false, 'a missed slice does not spend the advice');
  // Paired: the next event with a live signal delivers it once and marks it shown.
  const delivered = await subscriber.handle(change('live-1'));
  assert.deepEqual(delivered.hookOutcome, { kind: 'explain', text: 'Jevris suggests another model for sess-1.' });
  assert.equal(once.seen('key-1'), true);
  // Shown once: a later event says nothing new.
  const again = await subscriber.handle(change('live-2'));
  assert.deepEqual(again.hookOutcome, { kind: 'observe' });
});

import assert from 'node:assert/strict';
import { load, workflow } from './lib.mjs';
import { ASSUMPTIONS, ACCOUNT, SLICE, VOLUME, policy, quality, registry } from './router-fixture.mjs';

// W05: the user asks for a different main model. The harness's switch event reaches the product
// hook, which observes it and never answers it (no block, no "ask", no rewritten model), with the
// sidecar up or not yet started, within the hook's bound. The route surface keeps the user's
// explicit choice. The router resolves account eligibility and managed restrictions: a hard
// restriction refuses the choice (PIN_CONFLICT, never a silent replacement); a cheaper model does
// not override it. In SDK-owned auto mode the switch guard allows a change only at a boundary,
// and the requested and actually used models are kept apart, so a provider substitution is
// observed, not fought. The router and guard run at library level: no product path owns a main
// session's model in auto mode yet.

const QUALITIES = [quality('claude-opus-5', 0.9, 0.94, 0.97), quality('claude-sonnet-5', 0.88, 0.92, 0.95), quality('claude-haiku-4-5-20251001', 0.85, 0.9, 0.94)];
const ANSWERING = /permissionDecision|"decision"\s*:|updatedInput|to_model|"model"\s*:|"continue"\s*:\s*false/;

workflow('W05', 'A requested main-model switch', async ({ then, sandbox, evidence }) => {
  const core = await load('core');
  const box = await sandbox();
  const requested = { hook_event_name: 'PreModelSwitch', session_id: 'w05', cwd: box.work, from_model: 'claude-opus-5', to_model: 'claude-sonnet-5' };
  const timed = (fn) => {
    const started = Date.now();
    const out = fn();
    return { ...out, ms: Date.now() - started };
  };
  // Before the sidecar is up: the hook takes its event-specific fallback at once.
  const cold = timed(() => box.hook('claude', requested));
  assert.equal(box.startSidecar().code, 0, 'sidecar did not start');
  const warm = timed(() => box.hook('claude', requested));
  const changed = box.hook('claude', { ...requested, hook_event_name: 'PostModelSwitch' });
  const route = box.jevris(['route', '--model', 'claude-sonnet-5', '--pin', 'claude-sonnet-5'], { json: true });
  box.stopSidecar();

  const reg = await registry({ 'claude-haiku-4-5-20251001': { accountEligibility: [{ accountId: ACCOUNT, eligible: false, checkedAt: '2026-09-22T00:00:00Z' }] } });
  const choose = (modelPin, overrides = {}) => core.routeTask({ registry: reg, policy: policy({ pins: { modelPin, effortPin: null }, ...overrides }), sliceId: SLICE, volume: VOLUME, assumptions: ASSUMPTIONS, qualityFloor: 0.8, qualities: QUALITIES });
  const kept = choose('claude-opus-5');
  const managed = choose('claude-opus-5', { managedAllowlist: ['claude-sonnet-5', 'claude-haiku-4-5-20251001'] });
  const ineligible = choose('claude-haiku-4-5-20251001');
  const unpinned = choose(null);

  const saving = { lower: 400_000, point: 600_000, upper: 800_000 };
  const midStep = core.switchGuard({ transitionCostMicroUsd: 20_000, saving, unitsSinceLastSwitch: 3, switchesThisTask: 0, atBoundary: false });
  const boundary = core.switchGuard({ transitionCostMicroUsd: 20_000, saving, unitsSinceLastSwitch: 3, switchesThisTask: 0, atBoundary: true });
  const substituted = core.observeModel({ requestedModelId: 'claude-sonnet-5', sdkModelId: 'claude-opus-5', harnessModelId: 'claude-sonnet-5', usageReported: true });
  const unobserved = core.observeModel({ requestedModelId: 'claude-sonnet-5', usageReported: false });
  evidence({ hooks: [cold, warm, changed].map((h) => ({ code: h.code, reason: h.reason, stdout: h.stdout, ms: h.ms })), route: route.json?.result?.main, kept, managed: [managed.outcome, managed.reasonCode], ineligible: [ineligible.outcome, ineligible.reasonCode], boundary, midStep, substituted, unobserved });

  await then('the adapter observes the supported switch event and never replaces the requested target', () => {
    for (const hook of [cold, warm, changed]) {
      assert.equal(hook.code, 0, hook.stderr);
      assert.equal(ANSWERING.test(hook.stdout), false, `the hook answered the switch: ${hook.stdout}`);
    }
    assert.equal(cold.reason, 'SIDECAR_STARTING');
    // "The sidecar answered and proposed nothing": under load a subscriber can miss its slice,
    // and the launcher then says SUBSCRIBER_QUEUED instead of NO_PROPOSAL (E 6312c85).
    for (const hook of [warm, changed]) assert.ok(['NO_PROPOSAL', 'SUBSCRIBER_QUEUED'].includes(hook.reason), hook.reason);
  });

  await then('the explicit preference is respected and no cost preference overrides it', () => {
    assert.equal(route.code, 0, route.stderr);
    const main = route.json.result.main;
    assert.deepEqual([main.outcome, main.pinState, main.modelPin, main.recommendedModel, main.reasonCode], ['keep', 'pinned', 'claude-sonnet-5', null, 'PIN_RESPECTED']);
    assert.equal(route.json.result.applied, false);
    // Without the pin the router would pick a cheaper model; with it, the pin stands.
    assert.equal(unpinned.outcome, 'select');
    assert.notEqual(unpinned.modelId, 'claude-opus-5');
    assert.deepEqual([kept.outcome, kept.modelId, kept.reasonCode], ['pinned', 'claude-opus-5', 'MODEL_PINNED']);
  });

  await then('account eligibility is resolved and a hard managed restriction refuses the switch without substituting another model', () => {
    assert.deepEqual([managed.outcome, managed.modelId, managed.reasonCode], ['pinned', 'claude-opus-5', 'PIN_CONFLICT']);
    assert.deepEqual(managed.eliminated.find((e) => e.modelId === 'claude-opus-5'), { modelId: 'claude-opus-5', gate: 'managed-allowlist' });
    assert.deepEqual([ineligible.outcome, ineligible.reasonCode], ['pinned', 'PIN_CONFLICT']);
    assert.deepEqual(ineligible.eliminated.find((e) => e.modelId === 'claude-haiku-4-5-20251001'), { modelId: 'claude-haiku-4-5-20251001', gate: 'account-eligibility' });
    assert.deepEqual([managed.scored, managed.saving], [[], null], 'no other model was scored in its place');
  });

  await then('in auto mode a change happens only at a safe boundary and the requested target and the model actually used are recorded', () => {
    assert.deepEqual([midStep.allowed, midStep.reasonCode], [false, 'NOT_AT_BOUNDARY']);
    assert.deepEqual([boundary.allowed, boundary.reasonCode], [true, 'SWITCH_ALLOWED']);
    assert.match(boundary.explanation, /Transition cost \$0\.0200/);
    assert.deepEqual([substituted.requestedModelId, substituted.observedModelId, substituted.observedFrom, substituted.substituted], ['claude-sonnet-5', 'claude-opus-5', 'sdk', true]);
    assert.deepEqual([unobserved.observedModelId, unobserved.substituted, unobserved.costPrecision], ['unknown', null, 'unknown']);
  });

  await then('a timeout uses the event-specific fallback and never leaves an unbounded pending control request', () => {
    // The hook bound is the harness's; the product answers well inside it with no pending request.
    for (const hook of [cold, warm]) assert.ok(hook.ms < 10_000, `the switch hook took ${hook.ms} ms`);
    assert.equal(cold.stdout.trim(), '', 'the fallback for a switch event is to say nothing');
  });
});

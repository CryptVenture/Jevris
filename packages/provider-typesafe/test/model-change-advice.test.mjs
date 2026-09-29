// Harness parity audit G14: model-switch advice on Claude Code was dead. The handler passed no
// selection, so advice never recommended, and it read `event.model` where PreModelSwitch names the
// requested model in `to_model` (the adapter's `toModel`). It now evaluates the requested model on
// the event's harness and sign-in and passes the selection. Deterministic: a temporary HOME, a
// stand-in evaluation, no network, no billing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { modelChangeAdviceWith } = await import('../dist/index.js');
const { AdviceOnce } = await import('@jevris/core');

// pinned-clock: the advice and adherence times come from this stand-in engine clock.
const T = Date.parse('2026-09-27T12:00:00Z');
const SLICE = 'bounded-edit';

function input(t, { body = { sliceId: SLICE, authMode: 'subscription' }, payload = { fromModel: 'claude-opus-5-5', toModel: 'claude-fable-5-1' }, harness = 'claude', opened = [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'jevris-model-change-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return {
    ctx: { home, body, killSwitchStopped: false, adviceAdherence: { open: (i) => (opened.push(i), true), overrides: () => 0 } },
    envelope: { sessionId: 'sess-1', workspaceId: 'w-1', expectedRevision: 'r1', occurredAt: new Date(T).toISOString() },
    event: { harness, model: 'claude-opus-5-5', payload },
    engine: { now: () => T },
  };
}

/** A stand-in evaluation that records its input and selects Sonnet 5 on the slice. */
function evaluating(calls) {
  return async (req) => {
    calls.push(req);
    return {
      selection: { outcome: 'select', modelId: 'claude-sonnet-5', baselineModelId: req.currentModel, reasonCode: 'LOWEST_UTILITY_WITHIN_FLOOR', sliceId: req.sliceId, scored: [], eliminated: [], shadow: [], saving: null, registrySnapshotId: req.registry.snapshotId },
      switchDecision: null, reasonCode: null, calibrationId: 'cal-1', calibrationVersion: 'v1', assumedVolume: true,
    };
  };
}

test('G14: a model-switch request is evaluated for the requested model (to_model) on its harness and sign-in, and the selection is advised', async (t) => {
  const calls = [];
  const opened = [];
  const proposal = await modelChangeAdviceWith(input(t, { opened }), { evaluate: evaluating(calls), once: new AdviceOnce() });
  assert.ok(proposal, 'an evaluated selection is advised');
  assert.equal(proposal.hookOutcome.kind, 'explain');
  assert.match(proposal.hookOutcome.text, /^Jevris suggests Sonnet 5 for this bounded-edit task/);
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].role, calls[0].currentModel, calls[0].sliceId, calls[0].harness, calls[0].authMode], ['main', 'claude-fable-5-1', SLICE, 'claude', 'subscription']);
  // Delivered: adherence records the model the session leaves (from_model).
  assert.equal(proposal.commit(), true);
  assert.deepEqual([opened[0].advisedModel, opened[0].currentModel, opened[0].slice], ['claude-sonnet-5', 'claude-opus-5-5', SLICE]);
});

test('G14: provider/model and [1m] ids resolve; no slice, a pin, or a requested model outside the registry evaluates nothing and stays silent', async (t) => {
  const calls = [];
  const resolved = await modelChangeAdviceWith(input(t, { payload: { fromModel: 'claude-opus-5-5[1m]', toModel: 'anthropic/claude-fable-5-1' } }), { evaluate: evaluating(calls), once: new AdviceOnce() });
  assert.ok(resolved);
  assert.equal(calls.at(-1).currentModel, 'claude-fable-5-1');
  const before = calls.length;
  assert.equal(await modelChangeAdviceWith(input(t, { body: {} }), { evaluate: evaluating(calls), once: new AdviceOnce() }), null, 'no slice');
  assert.equal(await modelChangeAdviceWith(input(t, { body: { sliceId: SLICE, pins: { modelPin: 'claude-opus-5-5' } } }), { evaluate: evaluating(calls), once: new AdviceOnce() }), null, 'a pin is kept');
  assert.equal(await modelChangeAdviceWith(input(t, { payload: { toModel: 'gpt-5.2' } }), { evaluate: evaluating(calls), once: new AdviceOnce() }), null, 'outside the registry');
  // 8c1f85d: a gateway or third-party id is not the maker's model, so it gets no advice under the maker's consent.
  for (const toModel of ['openrouter/anthropic/claude-fable-5-1', 'nvidia/claude-fable-5-1']) {
    assert.equal(await modelChangeAdviceWith(input(t, { harness: 'opencode', payload: { toModel } }), { evaluate: evaluating(calls), once: new AdviceOnce() }), null, toModel);
  }
  assert.equal(calls.length, before, 'none of these evaluated anything');
  // Without to_model the active model stands in (the older payload shape).
  await modelChangeAdviceWith(input(t, { payload: {} }), { evaluate: evaluating(calls), once: new AdviceOnce() });
  assert.equal(calls.at(-1).currentModel, 'claude-opus-5-5');
  // No evaluated selection (no release): nothing is shown.
  const none = async () => ({ selection: null, switchDecision: null, reasonCode: 'NO_CALIBRATION', calibrationId: null, calibrationVersion: null, assumedVolume: false });
  assert.equal(await modelChangeAdviceWith(input(t), { evaluate: none, once: new AdviceOnce() }), null);
});

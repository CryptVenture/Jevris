// JEV-0055: each learning key names its own baseline as the default arm. Round 3 made every
// baseline learn under its own key (the registry's own baseline, Opus 5.5, keeps the bare slice id;
// any other is `<slice>::<model>`), so the key says which baseline its outcomes were measured
// against. The status and explain views must compare every arm with THAT default, not with the
// registry's own baseline whatever the key. Deterministic: no network, no billing, no home.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUNDLED_MODEL_REGISTRY,
  MIN_LOCAL_PER_ARM,
  emptyLearningState,
  explainSliceLearning,
  learningSliceKey,
  pinSlice,
  recordRouteOutcome,
} from '../dist/index.js';
import * as core from '../dist/index.js';

const NOW = '2026-09-26T00:00:00Z';
const SLICE = 'bounded-edit';
const OPUS = 'claude-opus-5-5';
const OLD_SOL = 'gpt-6-sol';
const NEW_SOL = 'gpt-6.1-sol';
const LUNA = 'gpt-6-luna';
const OLD_KEY = `${SLICE}::${OLD_SOL}`;
const NEW_KEY = `${SLICE}::${NEW_SOL}`;

let seq = 0;
/** One verified route outcome under `key` for `modelId` (a fixed $1 and one minute unless overridden). */
function event(key, modelId, overrides = {}) {
  seq += 1;
  const kind = overrides.kind ?? 'verified-pass';
  return {
    eventId: `ev-${seq}`,
    routeId: `route-${seq}`,
    sliceId: key,
    modelId,
    rulesModelId: modelId,
    policyVersion: 0,
    kind,
    labelSource: 'verification-receipt',
    receiptId: kind.startsWith('verified') ? `rcpt-${seq}` : null,
    explored: false,
    propensity: 0.95,
    risk: 'low',
    costMicroUsd: 1_000_000,
    latencyMs: 60_000,
    authMode: 'api-key',
    at: `2026-09-26T00:00:${String(seq % 60).padStart(2, '0')}Z`,
    ...overrides,
  };
}

function record(state, e) {
  const r = recordRouteOutcome(state, e);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.state;
}

/** Outcomes under the bare slice (Opus 5.5 as the default, Sonnet 5 explored) only. */
function bareOnly() {
  let s = emptyLearningState({ workspaceId: 'ws-1', now: NOW });
  for (const kind of ['verified-pass', 'verified-pass', 'verified-pass', 'verified-fail']) s = record(s, event(SLICE, OPUS, { kind, costMicroUsd: 2_000_000 }));
  s = record(s, event(SLICE, 'claude-sonnet-5', { explored: true, propensity: 0.05, costMicroUsd: 500_000 }));
  return s;
}

/** The bare slice plus two Codex keys: the old baseline (GPT-6 Sol) with a cheaper explored arm, and the new one (GPT-6.1 Sol). */
function allKeys() {
  let s = bareOnly();
  for (let i = 0; i < 3; i += 1) s = record(s, event(OLD_KEY, OLD_SOL));
  s = record(s, event(OLD_KEY, LUNA, { explored: true, propensity: 0.05, costMicroUsd: 250_000, latencyMs: 30_000 }));
  for (let i = 0; i < 2; i += 1) s = record(s, event(NEW_KEY, NEW_SOL, { costMicroUsd: 1_500_000 }));
  return s;
}

test('a learning key names its own baseline: the model after the separator, nothing for a bare slice id', () => {
  assert.equal(core.keyBaselineOf(OLD_KEY), OLD_SOL);
  assert.equal(core.keyBaselineOf(NEW_KEY), NEW_SOL);
  assert.equal(core.keyBaselineOf(SLICE), null, 'a bare slice id is the registry baseline; it names no model of its own');
  // It inverts learningSliceKey for every harness's baseline in the registry.
  for (const row of BUNDLED_MODEL_REGISTRY.harnessDefaults ?? []) {
    const key = learningSliceKey(SLICE, row.baselineModelId, BUNDLED_MODEL_REGISTRY);
    assert.equal(core.keyBaselineOf(key) ?? BUNDLED_MODEL_REGISTRY.baselineModelId, row.baselineModelId, `${row.harness} -> ${key}`);
  }
  // A subagent key, and a model id that carries a colon of its own.
  assert.equal(core.keyBaselineOf(`subagent:explore::${OLD_SOL}`), OLD_SOL);
  assert.equal(core.keyBaselineOf(`${SLICE}::local:tag`), 'local:tag');
  // A key that ends at the separator names no model.
  assert.equal(core.keyBaselineOf(`${SLICE}::`), null);
});

test('JEV-0055: the GPT-6 Sol key is compared with GPT-6 Sol, in the economics numbers and in the lines', () => {
  const x = explainSliceLearning(allKeys(), OLD_KEY);
  assert.equal(x.sliceId, OLD_KEY);
  assert.equal(x.economics.defaultArmId, OLD_SOL, 'the default arm of the key is its own baseline, not the registry baseline');
  assert.deepEqual(x.economics.arms.map((a) => [a.armId, a.isDefault]), [[OLD_SOL, true], [LUNA, false]]);
  // The default arm and every arm against it: $1 and one minute for each of 3 verified GPT-6 Sol tasks.
  const [d, c] = x.economics.arms;
  assert.deepEqual([d.routes, d.verified, d.costPerVerifiedMicroUsd, d.wallMsPerVerified, d.costRatioVsDefault, d.wallRatioVsDefault], [3, 3, 1_000_000, 60_000, 1, 1]);
  assert.deepEqual([c.routes, c.verified, c.costPerVerifiedMicroUsd, c.costRatioVsDefault, c.wallRatioVsDefault], [1, 1, 250_000, 0.25, 0.5]);
  assert.ok(x.lines.includes(`Per verified task ${OLD_SOL}: $1.0000 billed, 1.0 min wall time, 3 verified over 3 routes (the default).`), x.lines.join('\n'));
  assert.ok(x.lines.includes(`Per verified task ${LUNA}: $0.2500 billed, 0.5 min wall time, 1 verified over 1 routes (vs ${OLD_SOL}: cost 0.25x, usage n/a, time 0.50x).`), x.lines.join('\n'));
  // Nothing in the key's view calls Opus 5.5 the default.
  assert.doesNotMatch(x.lines.join('\n'), new RegExp(`${OPUS} \\(the default\\)|vs ${OPUS}`));
  // The local-evidence guard waits on the key's own default arm too.
  const remaining = MIN_LOCAL_PER_ARM - 3;
  assert.deepEqual(x.guard?.waiting.map((g) => [g.armId, g.local, g.remaining]), [[OLD_SOL, 3, remaining], [LUNA, 1, MIN_LOCAL_PER_ARM - 1]]);
  assert.ok(x.lines.includes(`Waiting for ${String(remaining)} more local outcomes on ${OLD_SOL} (the default) before any switch.`), x.lines.join('\n'));
});

test('JEV-0055: each key lists its own default arm, and an unrelated key is not changed by the others', () => {
  const all = allKeys();
  const newer = explainSliceLearning(all, NEW_KEY);
  assert.equal(newer.economics.defaultArmId, NEW_SOL);
  assert.deepEqual(newer.economics.arms.map((a) => [a.armId, a.isDefault, a.verified, a.costPerVerifiedMicroUsd]), [[NEW_SOL, true, 2, 1_500_000]]);
  assert.ok(newer.lines.includes(`Per verified task ${NEW_SOL}: $1.5000 billed, 1.0 min wall time, 2 verified over 2 routes (the default).`), newer.lines.join('\n'));

  // The bare slice keeps Opus 5.5, and its whole explanation is the one it has with no Codex key in the state.
  const bare = explainSliceLearning(all, SLICE);
  assert.equal(bare.economics.defaultArmId, OPUS);
  assert.deepEqual(bare, explainSliceLearning(bareOnly(), SLICE));
  assert.ok(bare.lines.includes(`Per verified task ${OPUS}: $2.6667 billed, 1.3 min wall time, 3 verified over 4 routes (the default).`), bare.lines.join('\n'));

  // A key nobody has routed under yet still names its baseline as the default.
  const unseen = explainSliceLearning(all, `${SLICE}::gemini-3.8-flash`);
  assert.equal(unseen.economics.defaultArmId, 'gemini-3.8-flash');
  assert.deepEqual(unseen.economics.arms.map((a) => [a.armId, a.isDefault, a.verified]), [['gemini-3.8-flash', true, 0]]);
});

test('JEV-0055: a harness named for the view reads the key of its own baseline, and a pin does not move the default arm', () => {
  const all = allKeys();
  // The harness path was already right (it builds the key from the harness's baseline); it must stay so.
  const codex = explainSliceLearning(all, SLICE, undefined, { registry: BUNDLED_MODEL_REGISTRY, harness: 'codex' });
  assert.equal(codex.sliceId, NEW_KEY);
  assert.equal(codex.economics.defaultArmId, NEW_SOL);
  const claude = explainSliceLearning(all, SLICE, undefined, { registry: BUNDLED_MODEL_REGISTRY, harness: 'claude' });
  assert.equal(claude.sliceId, SLICE);
  assert.equal(claude.economics.defaultArmId, OPUS);
  // A pin holds the slice on a model; the key's default arm is still the baseline its outcomes were measured against.
  const pinned = explainSliceLearning(pinSlice(all, OLD_KEY, LUNA, NOW), OLD_KEY);
  assert.equal(pinned.policy.mode, 'pinned');
  assert.equal(pinned.economics.defaultArmId, OLD_SOL);
  // An explicit default (a caller that knows better) still wins over the key.
  assert.equal(explainSliceLearning(all, OLD_KEY, undefined, { defaultArmId: LUNA }).economics.defaultArmId, LUNA);
});

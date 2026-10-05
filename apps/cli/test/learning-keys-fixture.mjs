// Shared by the JEV-0055 tests: a workspace's route-learning state with three keys, one per
// baseline. The registry's own baseline (Opus 5.5) keeps the bare slice id; Codex's old baseline
// (GPT-6 Sol) and its current one (GPT-6.1 Sol) each learn under `<slice>::<model>`.
import assert from 'node:assert/strict';
import { sandbox } from '../../../test/acceptance/lib.mjs';

const core = await import('@jevris/core');
const { workspaceIdFor } = await import('../dist/public/context.js');

export const SLICE = 'bounded-edit';
export const OPUS = 'claude-opus-5-5';
export const OLD_SOL = 'gpt-6-sol';
export const NEW_SOL = 'gpt-6.1-sol';
export const LUNA = 'gpt-6-luna';
export const OLD_KEY = `${SLICE}::${OLD_SOL}`;
export const NEW_KEY = `${SLICE}::${NEW_SOL}`;

let seq = 0;
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

/** The bare slice (Opus 5.5 with a cheaper explored arm), the old Codex key (GPT-6 Sol with GPT-6 Luna) and the new one (GPT-6.1 Sol). */
export function seededState(workspaceId) {
  let state = core.emptyLearningState({ workspaceId, now: '2026-09-26T00:00:00Z' });
  const add = (e) => {
    const r = core.recordRouteOutcome(state, e);
    assert.equal(r.ok, true, JSON.stringify(r));
    state = r.state;
  };
  for (const kind of ['verified-pass', 'verified-pass', 'verified-pass', 'verified-fail']) add(event(SLICE, OPUS, { kind, costMicroUsd: 2_000_000 }));
  add(event(SLICE, 'claude-sonnet-5', { explored: true, propensity: 0.05, costMicroUsd: 500_000 }));
  for (let i = 0; i < 3; i += 1) add(event(OLD_KEY, OLD_SOL));
  add(event(OLD_KEY, LUNA, { explored: true, propensity: 0.05, costMicroUsd: 250_000, latencyMs: 30_000 }));
  for (let i = 0; i < 2; i += 1) add(event(NEW_KEY, NEW_SOL, { costMicroUsd: 1_500_000 }));
  return state;
}

/** A sandbox whose workspace holds that state (saved under the sandbox's own home). */
export async function seededBox(t) {
  const box = await sandbox(t);
  box.write('work/src/a.js', 'export const a = 1;\n');
  box.gitInit();
  assert.deepEqual(await core.saveLearningState(box.home, seededState(workspaceIdFor(box.work))), { ok: true });
  return box;
}

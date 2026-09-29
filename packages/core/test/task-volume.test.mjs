import test from 'node:test';
import assert from 'node:assert/strict';

// P11: the router's task volume per slice only ever rises above the default, to the measured p90.
const core = await import('@jevris/core');
const { sliceTaskVolume, sliceTaskVolumeLine, VOLUME_MIN_ROUTES, DEFAULT_TASK_VOLUME } = core;

function state(events) {
  return { events };
}
function event(i, tokens, extra = {}) {
  return { eventId: `e${i}`, routeId: `r${i}`, sliceId: 'code-edit', modelId: 'claude-sonnet-5', kind: 'verified-pass', tokens, ...extra };
}

test('below the minimum routes, or without a state, the default stands', () => {
  assert.equal(VOLUME_MIN_ROUTES, 12);
  assert.deepEqual(sliceTaskVolume(null, 'code-edit', DEFAULT_TASK_VOLUME), { volume: DEFAULT_TASK_VOLUME, basis: 'default', routes: 0, p90Tokens: null });
  const few = sliceTaskVolume(state(Array.from({ length: 11 }, (_, i) => event(i, 2_000_000))), 'code-edit', DEFAULT_TASK_VOLUME);
  assert.deepEqual([few.basis, few.routes, few.p90Tokens], ['default', 11, null]);
  assert.match(sliceTaskVolumeLine('code-edit', few), /11 of 12 routes with measured tokens so far/);
});

test('the measured p90 raises the volume, keeping the default split; smaller measures never lower it', () => {
  // 20 routes: 1..20 x 100k tokens; p90 (nearest rank 18) = 1.8M.
  const big = sliceTaskVolume(state(Array.from({ length: 20 }, (_, i) => event(i, (i + 1) * 100_000))), 'code-edit', DEFAULT_TASK_VOLUME);
  assert.equal(big.basis, 'measured-p90');
  assert.equal(big.p90Tokens, 1_800_000);
  assert.deepEqual(big.volume, { inputTokens: Math.ceil(400_000 * (1_800_000 / 440_000)), outputTokens: Math.ceil(40_000 * (1_800_000 / 440_000)) });
  assert.ok(big.volume.inputTokens + big.volume.outputTokens >= 1_800_000);
  assert.match(sliceTaskVolumeLine('code-edit', big), /the 90th percentile of 20 measured routes, above the default/);

  const small = sliceTaskVolume(state(Array.from({ length: 20 }, (_, i) => event(i, 50_000))), 'code-edit', DEFAULT_TASK_VOLUME);
  assert.deepEqual([small.basis, small.volume, small.p90Tokens], ['default', DEFAULT_TASK_VOLUME, 50_000]);
});

test('one value per route (its largest), only this slice, and no null or zero tokens', () => {
  const events = [
    ...Array.from({ length: 12 }, (_, i) => event(i, 100_000)),
    event(0, 5_000_000, { eventId: 'e0-late', kind: 'reverted' }),
    event(99, null),
    event(98, 0),
    event(97, 9_000_000, { sliceId: 'other' }),
  ];
  const v = sliceTaskVolume(state(events), 'code-edit', DEFAULT_TASK_VOLUME);
  assert.equal(v.routes, 12);
  // Route r0 counts once, at 5M; p90 of 12 (rank 11) is 100k, so the default stands.
  assert.deepEqual([v.basis, v.p90Tokens], ['default', 100_000]);
});

test('raiseVolume takes the larger per field and ignores a malformed measure', () => {
  const v = { inputTokens: 400_000, outputTokens: 40_000 };
  assert.deepEqual(core.raiseVolume(v, { inputTokens: 900_000, outputTokens: 10_000, n: 5 }), { inputTokens: 900_000, outputTokens: 40_000 });
  assert.deepEqual(core.raiseVolume(v, { inputTokens: 1, outputTokens: 1, n: 5 }), v);
  assert.deepEqual(core.raiseVolume(v, null), v);
  assert.deepEqual(core.raiseVolume(v, { inputTokens: -1, outputTokens: 9e9, n: 5 }), v);
  assert.deepEqual(core.raiseVolume(v, { inputTokens: 9e6, outputTokens: 9e6, n: 0 }), v);
});

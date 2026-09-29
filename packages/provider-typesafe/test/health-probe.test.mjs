import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');
const { createSidecarEngine, createMockFetch, CONFORMANCE_REQUEST } = provider;

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-probe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let serial = 0;
function request() {
  serial += 1;
  const compiled = core.compileDecisionSpec({ id: 'probe-check', version: 'v1', questions: CONFORMANCE_REQUEST.questions, evidenceRequirements: [], deadlineMs: 2000, fallback: 'rules-only' });
  return { spec: compiled.spec, questions: CONFORMANCE_REQUEST.questions, workspaceId: 'w-probe', evidenceRevision: 'rev-1', lane: 'background', packet: { objective: `Pick a helper name (${serial}).`, trustedPolicy: {}, facts: { n: serial }, evidence: [] } };
}

/** A Jev stub that is down (529) until `up` is set; every request body is recorded. */
function outage() {
  const state = { up: false, bodies: [] };
  const down = createMockFetch({ scenario: 'http-529' });
  const healthy = createMockFetch({ scenario: 'valid' });
  state.fetch = async (url, init) => {
    state.bodies.push(JSON.parse(init.body));
    return state.up ? healthy(url, init) : down(url, init);
  };
  return state;
}

test('PRV-08/W07: after an outage a bounded background probe restores observation first, then automation on the same model', async (t) => {
  let now = Date.parse('2026-09-25T10:00:00Z');
  const clock = { now: () => now };
  const jev = outage();
  const engine = await createSidecarEngine({ home: home(t), credential: 'test-key-not-a-secret', fetch: jev.fetch, env: {}, clock });
  const key = 'typesafe:primary';
  for (let i = 0; i < 6 && engine.breaker.snapshot(key).state !== 'open'; i += 1) await core.decide(request(), engine);
  assert.equal(engine.breaker.snapshot(key).state, 'open');
  const sentWhileOpen = jev.bodies.length;
  const refused = await core.decide(request(), engine);
  assert.equal(refused.reasonCode, 'CIRCUIT_OPEN');
  assert.equal(jev.bodies.length, sentWhileOpen, 'no call while open');
  assert.deepEqual(await engine.probeProvider(), { probed: false, state: 'open', reasonCode: 'COOLDOWN' });

  // Connectivity returns and the cooldown passes: the next decision starts one probe and is not delayed by it.
  jev.up = true;
  now += 31_000;
  const during = await core.decide(request(), engine);
  assert.equal(during.abstained, true, 'the decision keeps its fallback while the probe runs');
  const probe = await engine.probeProvider();
  // Single flight: either this joins the probe the decision started (PROBE_OK), or that probe
  // already finished and a second one inside the interval is refused (PROBE_RATE_LIMITED).
  assert.ok(['PROBE_OK', 'PROBE_RATE_LIMITED'].includes(probe.reasonCode), JSON.stringify(probe));
  const probes = jev.bodies.filter((b) => 'healthCheck' in b.questions);
  assert.equal(probes.length, 1, 'exactly one probe');
  assert.equal(JSON.stringify(probes[0]).includes('Pick a helper'), false, 'the probe carries no task content');
  assert.equal(engine.breaker.snapshot(key).state, 'observe-only', 'observation first');
  const observing = await core.decide(request(), engine);
  assert.equal(observing.reasonCode, 'OBSERVE_ONLY', 'automation stays off after one probe');

  // Rate limit: a second probe inside the interval is refused without a call.
  assert.equal((await engine.probeProvider()).reasonCode, 'PROBE_RATE_LIMITED');
  // Three more probes, each after the interval, restore automation (restoreAfter 3 on the same model).
  for (let i = 0; i < 3; i += 1) {
    now += 31_000;
    const next = await engine.probeProvider();
    assert.equal(next.reasonCode, 'PROBE_OK', JSON.stringify(next));
  }
  assert.equal(engine.breaker.snapshot(key).state, 'closed');
  const restored = await core.decide(request(), engine);
  assert.equal(restored.abstained, false, JSON.stringify(restored));
  assert.equal(jev.bodies.filter((b) => 'healthCheck' in b.questions).length, 4, 'four probes in total');
  const budget = await engine.budget.snapshot();
  assert.equal(budget.reservedMicroUsd, 0, 'every probe settled its reservation');
});

test('PRV-08: a failed probe reopens the breaker for another cooldown; no provider or no breaker means no probe', async (t) => {
  let now = Date.parse('2026-09-25T10:00:00Z');
  const jev = outage();
  const engine = await createSidecarEngine({ home: home(t), credential: 'test-key-not-a-secret', fetch: jev.fetch, env: {}, clock: { now: () => now } });
  for (let i = 0; i < 6 && engine.breaker.snapshot('typesafe:primary').state !== 'open'; i += 1) await core.decide(request(), engine);
  now += 31_000;
  const failed = await engine.probeProvider();
  assert.deepEqual([failed.probed, failed.state], [true, 'open']);
  assert.equal((await engine.probeProvider()).reasonCode, 'COOLDOWN');
  const rulesOnly = await createSidecarEngine({ home: home(t), credential: null, env: {} });
  assert.deepEqual(await rulesOnly.probeProvider(), { probed: false, state: null, reasonCode: 'PROVIDER_NOT_CONFIGURED' });
});

// C16, C52 through the built CLI: `jevris route learning` shows and changes C's baseline-first
// route learning (538cf77) for the workspace. Learning is on and automatic by default. Pairs:
// - no state and a learned state;
// - off (no question: it only lowers what learning may do) and on (confirmed);
// - automatic off (review, no question) and automatic on (confirmed, applying the owner-locked
//   thresholds; refused NOT_YET_CALIBRATED only while none are locked);
// - every other change unconfirmed (nothing written) and confirmed (a new policy version);
// - accept and reject of a pending proposal; pin, unpin, rollback and reset undo each other.
// No MCP tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { sandbox } from '../../../test/acceptance/lib.mjs';

const core = await import('@jevris/core');
const { workspaceIdFor } = await import('../dist/public/context.js');
const { renderHuman } = await import('../dist/public/render.js');

function proposal(id, sliceId, now) {
  const arm = (modelId, successes) => ({ modelId, labelled: 40, successes, rate: successes / 40, lower: 0.6, upper: 0.9, staleOrCancelled: 0, meanCostMicroUsd: 1000, medianLatencyMs: 900, usageLimited: 0, meanTokens: 5000, meanWeightedUsage: 5000 });
  return {
    proposalId: id,
    sliceId,
    modelId: 'claude-sonnet-4-6',
    baselineModelId: 'claude-opus-4-7',
    createdAt: now,
    basedOnVersion: 0,
    evidence: { sliceId, candidate: arm('claude-sonnet-4-6', 31), baseline: arm('claude-opus-4-7', 30), differenceLower: -0.02, margin: 0.05, minPerArm: 30, eventCount: 80 },
    status: 'pending',
  };
}

test('route learning: on and automatic by default, off and review as opt-outs, every other change confirmed and reversible (C16)', async (t) => {
  const readiness = core.automaticPromotionReady();
  const box = await sandbox(t);
  box.write('work/src/a.js', 'export const a = 1;\n');
  box.gitInit();
  const workspaceId = workspaceIdFor(box.work);
  const stateFile = core.learningStateFile(box.home, workspaceId);
  const status = () => box.jevris(['route', 'learning', 'status'], { json: true });
  const settings = async () => (await core.loadLearningState({ home: box.home, workspaceId })).settings;

  // Day 1: on, automatic (the default), nothing written.
  const fresh = status();
  assert.equal(fresh.code, 0, fresh.stdout + fresh.stderr);
  assert.deepEqual(
    [fresh.json.command, fresh.json.learned, fresh.json.enabled, fresh.json.automatic.enabled, fresh.json.automatic.ready],
    ['route learning status', false, true, core.learningSettings().promotionMode === 'automatic', readiness.ready],
  );
  const freshText = box.jevris(['route', 'learning', 'status']).stdout;
  assert.match(freshText, /^Route learning is on in this workspace; changes apply automatically/m);
  assert.match(freshText, /^No local outcomes yet: each slice follows the signed baseline release where one supports it/m);
  assert.equal(existsSync(stateFile), false, 'status wrote state');

  // Off needs no question and makes no policy version; on needs a person.
  const off = box.jevris(['route', 'learning', 'off'], { json: true });
  assert.deepEqual([off.code, off.json.changed, off.json.enabled, off.json.version], [0, true, false, 0], off.stdout + off.stderr);
  assert.equal((await settings()).enabled, false);
  assert.match(box.jevris(['route', 'learning', 'status']).stdout, /^Route learning is off in this workspace/m);
  assert.equal(box.jevris(['route', 'learning', 'on']).code, 2, 'on without confirmation');
  assert.equal((await settings()).enabled, false, 'an unconfirmed on changed the setting');
  const on = box.jevris(['route', 'learning', 'on', '--yes'], { json: true });
  assert.deepEqual([on.code, on.json.enabled, on.json.version], [0, true, 0]);

  // Review is an opt-out with no question; automatic on needs a person.
  const review = box.jevris(['route', 'learning', 'automatic', 'off'], { json: true });
  assert.deepEqual([review.code, review.json.promotionMode], [0, 'review']);
  assert.match(box.jevris(['route', 'learning', 'status']).stdout, /changes wait as proposals for your review/);
  if (!readiness.ready) {
    const auto = box.jevris(['route', 'learning', 'automatic', 'on', '--yes'], { json: true });
    assert.deepEqual([auto.code, auto.json.changed, auto.json.reasonCode], [1, false, 'NOT_YET_CALIBRATED']);
  } else {
    assert.equal(box.jevris(['route', 'learning', 'automatic', 'on']).code, 2, 'automatic on without confirmation');
    assert.equal((await settings()).promotionMode, 'review');
    const auto = box.jevris(['route', 'learning', 'automatic', 'on', '--yes'], { json: true });
    assert.deepEqual([auto.code, auto.json.changed, auto.json.promotionMode, auto.json.version], [0, true, 'automatic', 0], auto.stdout);
    const th = readiness.thresholds;
    const applied = await settings();
    assert.deepEqual(
      [applied.explorationRate, applied.nonInferiorityMargin, applied.activateBelow, applied.deactivateAbove, applied.flapFloor, applied.priorWeight, applied.demotionWindow],
      [th.explorationRate, th.nonInferiorityMargin, th.activateBelow, th.deactivateAbove, th.flapFloor, th.priorWeight, th.demotionWindow],
      'the owner-locked thresholds are applied',
    );
  }

  // A pin needs a person; confirmed, it makes version 1.
  const unconfirmed = box.jevris(['route', 'learning', 'pin', 'bounded-edit', 'claude-sonnet-4-6']);
  assert.equal(unconfirmed.code, 2);
  assert.equal(slices(status()).length, 0, 'an unconfirmed pin changed the policy');
  const pinned = box.jevris(['route', 'learning', 'pin', 'bounded-edit', 'claude-sonnet-4-6', '--yes'], { json: true });
  assert.equal(pinned.code, 0, pinned.stdout + pinned.stderr);
  assert.deepEqual([pinned.json.changed, pinned.json.version], [true, 1]);
  let learned = status();
  assert.equal(learned.json.learned, true);
  assert.deepEqual(slices(learned).map((s) => [s.sliceId, s.policy.mode, s.policy.modelId]), [['bounded-edit', 'pinned', 'claude-sonnet-4-6']]);

  // Two pending proposals on other slices, as C's review mode writes them.
  const now = new Date().toISOString();
  const seeded = await core.loadLearningState({ home: box.home, workspaceId });
  assert.ok(seeded !== null);
  assert.equal((await core.saveLearningState(box.home, { ...seeded, proposals: [proposal('p-accept', 'docs-edit', now), proposal('p-reject', 'test-fix', now)] })).ok, true);
  learned = status();
  assert.equal(learned.json.pendingProposals, 2);
  assert.match(box.jevris(['route', 'learning', 'status', '--slice', 'docs-edit']).stdout, /Pending proposal p-accept: claude-sonnet-4-6/);

  assert.deepEqual(((r) => [r.code, r.json.reasonCode])(box.jevris(['route', 'learning', 'accept', 'p-none', '--yes'], { json: true })), [1, 'PROPOSAL_UNKNOWN']);
  assert.equal(box.jevris(['route', 'learning', 'accept', 'p-accept']).code, 2, 'accepted without confirmation');
  const accepted = box.jevris(['route', 'learning', 'accept', 'p-accept', '--yes'], { json: true });
  assert.deepEqual([accepted.code, accepted.json.version], [0, 2], accepted.stdout);
  assert.deepEqual(((r) => [r.code, r.json.reasonCode])(box.jevris(['route', 'learning', 'accept', 'p-accept', '--yes'], { json: true })), [1, 'PROPOSAL_NOT_PENDING']);
  const rejected = box.jevris(['route', 'learning', 'reject', 'p-reject', '--yes'], { json: true });
  assert.deepEqual([rejected.code, rejected.json.version], [0, 2], 'a rejection makes no version');
  learned = status();
  assert.equal(learned.json.pendingProposals, 0);
  assert.match(box.jevris(['route', 'learning', 'status']).stdout, /Slices active: docs-edit; pinned: bounded-edit\./);

  // Unpin, roll back to the pin, then reset: each is a new version and undoes the one before.
  assert.equal(box.jevris(['route', 'learning', 'unpin', 'bounded-edit', '--yes']).code, 0);
  assert.deepEqual(((r) => [r.code, r.json.reasonCode])(box.jevris(['route', 'learning', 'unpin', 'bounded-edit', '--yes'], { json: true })), [1, 'NOT_PINNED']);
  assert.deepEqual(((r) => [r.code, r.json.reasonCode])(box.jevris(['route', 'learning', 'rollback', '99', '--yes'], { json: true })), [1, 'VERSION_UNKNOWN']);
  const rolled = box.jevris(['route', 'learning', 'rollback', '2', '--yes'], { json: true });
  assert.deepEqual([rolled.code, rolled.json.version], [0, 4]);
  assert.deepEqual(slices(status()).filter((s) => s.policy.mode !== 'advise').map((s) => [s.sliceId, s.policy.mode]), [['bounded-edit', 'pinned'], ['docs-edit', 'auto']]);
  const reset = box.jevris(['route', 'learning', 'reset', '--yes'], { json: true });
  assert.deepEqual([reset.code, reset.json.version], [0, 5]);
  const afterReset = slices(status());
  assert.ok(afterReset.length > 0 && afterReset.every((s) => s.policy.mode === 'advise'), JSON.stringify(afterReset.map((s) => s.policy)));

  const client = await box.mcp();
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).filter((name) => /learn/.test(name)), [], 'no model tool changes learning');
});

/** The status slices that carry a policy other than the implicit default. */
function slices(result) {
  return result.json.slices ?? [];
}

test('route learning refuses bad arguments before reading or writing anything', async (t) => {
  const box = await sandbox(t);
  box.gitInit();
  for (const argv of [
    ['route', 'learning'],
    ['route', 'learning', 'nope'],
    ['route', 'learning', 'status', '--yes'],
    ['route', 'learning', 'status', 'extra'],
    ['route', 'learning', 'accept'],
    ['route', 'learning', 'pin', 'bounded-edit'],
    ['route', 'learning', 'pin', 'bounded-edit', 'm', '--advise'],
    ['route', 'learning', 'pin', 'bounded-edit', '--advise', '--effort', 'low'],
    ['route', 'learning', 'pin', 'bounded-edit', 'claude-opus-5-5', '--effort', 'extreme'],
    ['route', 'learning', 'pin', 'bounded-edit', 'claude-opus-5-5', '--effort'],
    ['route', 'learning', 'unpin', 'bounded-edit', '--effort', 'low'],
    ['route', 'learning', 'status', '--effort', 'low'],
    ['route', 'learning', 'rollback', 'v1'],
    ['route', 'learning', 'automatic', 'maybe'],
    ['route', 'learning', 'off', 'now'],
    ['route', 'learning', 'on', '--clear-evidence'],
    ['route', 'learning', 'reset', '--slice', 'x'],
    ['route', 'learning', 'status', '--machine'],
    ['route', 'learning', 'reset', '--machine', '--clear-evidence'],
  ]) {
    assert.equal(box.jevris(argv).code, 2, argv.join(' '));
  }
  assert.match(box.jevris(['route', 'learning', '--help']).stdout, /^Usage: jevris route learning status/);
  assert.match(box.jevris(['help', 'route']).stdout, /Learning \(jevris route learning --help\)/);
});

test('route learning pin --effort pins a model at an effort; without it the pin is the model at its default effort (C16, C 1fc41b9)', async (t) => {
  const box = await sandbox(t);
  box.write('work/src/a.js', 'export const a = 1;\n');
  box.gitInit();
  const status = () => box.jevris(['route', 'learning', 'status', '--slice', 'bounded-edit'], { json: true });
  const policy = () => status().json.slices[0].policy;

  // Unconfirmed, nothing changes; the question names the arm.
  const unconfirmed = box.jevris(['route', 'learning', 'pin', 'bounded-edit', 'claude-opus-5-5', '--effort', 'low']);
  assert.equal(unconfirmed.code, 2);
  assert.equal(status().json.learned, false, 'an unconfirmed pin wrote the learning state');

  const low = box.jevris(['route', 'learning', 'pin', 'bounded-edit', 'claude-opus-5-5', '--effort', 'low', '--yes']);
  assert.equal(low.code, 0, low.stdout + low.stderr);
  assert.match(low.stdout, /^Pinned slice bounded-edit to claude-opus-5-5 at low effort; policy v1\.$/m);
  assert.deepEqual([policy().mode, policy().modelId, policy().effort], ['pinned', 'claude-opus-5-5', 'low']);
  assert.match(box.jevris(['route', 'learning', 'status', '--slice', 'bounded-edit']).stdout, /pinned to claude-opus-5-5 at low effort/);

  // The pair: the same pin without --effort, and with the model's default effort, is the bare model.
  for (const extra of [[], ['--effort', core.defaultEffortOf('claude-opus-5-5')]]) {
    const plain = box.jevris(['route', 'learning', 'pin', 'bounded-edit', 'claude-opus-5-5', ...extra, '--yes']);
    assert.equal(plain.code, 0, plain.stdout + plain.stderr);
    assert.match(plain.stdout, /^Pinned slice bounded-edit to claude-opus-5-5; policy v\d+\.$/m);
    assert.deepEqual([policy().modelId, policy().effort ?? null], ['claude-opus-5-5', null]);
  }
});

test('explain shows the route learning lines for the decision\'s slice when the sidecar sends them', () => {
  const payload = {
    decisionId: 'd-1',
    found: true,
    trace: {
      outcome: 'advisory',
      reasonCodes: ['KEEP_CURRENT'],
      resolvedModel: null,
      usage: { known: false, inputTokens: null, outputTokens: null },
      uncertainty: 'No calibration applies.',
      policyVersion: null,
      applied: false,
      rendered: 'Kept the current model.',
      learning: { sliceId: 'bounded-edit', mode: 'advise', version: 0, lines: ['Slice bounded-edit: advice only (the default until local evidence passes the margin), policy v0.', 'No local outcomes yet.'] },
    },
  };
  const text = renderHuman({ schemaVersion: '1.0', command: 'explain', mode: 'full', sidecar: { state: 'running', reasonCode: null, message: null }, workspace: { id: 'w1', root: null }, summary: 'Explained.', result: payload });
  assert.match(text, /^route learning: bounded-edit: advice only, policy v0$/m);
  const active = renderHuman({ schemaVersion: '1.0', command: 'explain', mode: 'full', sidecar: { state: 'running', reasonCode: null, message: null }, workspace: { id: 'w1', root: null }, summary: 'Explained.', result: { ...payload, trace: { ...payload.trace, learning: { ...payload.trace.learning, mode: 'auto', version: 3 } } } });
  assert.match(active, /^route learning: bounded-edit: active, policy v3$/m, 'auto reads as active');
  assert.match(text, /^No local outcomes yet\.$/m);
  const without = renderHuman({ schemaVersion: '1.0', command: 'explain', mode: 'full', sidecar: { state: 'running', reasonCode: null, message: null }, workspace: { id: 'w1', root: null }, summary: 'Explained.', result: { ...payload, trace: { ...payload.trace, learning: undefined } } });
  assert.doesNotMatch(without, /route learning/);
});

/** One verified outcome on bounded-edit for `modelId`, as the loop records it (writes the workspace's machine contribution). */
async function learnOne(home, workspaceId, n, modelId = 'claude-opus-5-5') {
  const event = {
    eventId: `ev-${workspaceId}-${n}`,
    routeId: `route-${workspaceId}-${n}`,
    sliceId: 'bounded-edit',
    modelId,
    rulesModelId: 'claude-opus-5-5',
    policyVersion: 0,
    kind: 'verified-pass',
    labelSource: 'verification-receipt',
    receiptId: `rcpt-${workspaceId}-${n}`,
    explored: false,
    propensity: 0.95,
    risk: 'low',
    costMicroUsd: 2_000_000,
    latencyMs: 60_000,
    authMode: 'api-key',
    at: `2026-09-26T00:00:${String(n).padStart(2, '0')}Z`,
  };
  const r = await core.learnFromOutcome({ home, workspaceId, event, baselineModelId: 'claude-opus-5-5', eligibleModelIds: ['claude-opus-5-5', 'claude-sonnet-5'], now: '2026-09-26T00:01:00Z', registry: core.BUNDLED_MODEL_REGISTRY });
  assert.equal(r.recorded, true, JSON.stringify(r));
}

test('route learning reset --machine clears the learning shared across the workspaces on this machine; reset --clear-evidence withdraws this workspace\'s share (C16, C 7bea448)', async (t) => {
  const box = await sandbox(t);
  box.write('work/src/a.js', 'export const a = 1;\n');
  box.gitInit();
  const workspaceId = workspaceIdFor(box.work);
  const contributions = () => (existsSync(core.machineLearningDir(box.home)) ? readdirSync(core.machineLearningDir(box.home)).filter((n) => /^mc-[0-9a-f]{16}\.json$/.test(n)).length : 0);
  await learnOne(box.home, workspaceId, 1);
  await learnOne(box.home, 'ws-other', 2);
  await learnOne(box.home, 'ws-other', 3);
  assert.equal(contributions(), 2);

  // This workspace sees the other workspace's outcomes as the machine part of its posterior.
  const shown = box.jevris(['route', 'learning', 'status', '--slice', 'bounded-edit'], { json: true });
  assert.equal(shown.code, 0, shown.stdout + shown.stderr);
  const opus = shown.json.slices[0].posteriors.find((p) => p.armId === 'claude-opus-5-5');
  assert.deepEqual([opus.machine.successes, opus.machine.failures, opus.machine.contributors], [2, 0, 1], JSON.stringify(opus));
  assert.match(box.jevris(['route', 'learning', 'status', '--slice', 'bounded-edit']).stdout, /^Machine prior claude-opus-5-5: .* in 1 other workspaces on this machine/m);

  // --clear-evidence: unconfirmed, nothing changes; confirmed, this workspace's contribution goes and the other stays.
  assert.equal(box.jevris(['route', 'learning', 'reset', '--clear-evidence']).code, 2);
  assert.equal(contributions(), 2);
  const cleared = box.jevris(['route', 'learning', 'reset', '--clear-evidence', '--yes'], { json: true });
  assert.equal(cleared.code, 0, cleared.stdout + cleared.stderr);
  assert.equal(contributions(), 1);
  assert.match(box.jevris(['route', 'learning', 'reset', '--clear-evidence', '--yes']).stdout, /this workspace's share of the machine-wide learning was withdrawn/);
  const version = (await core.loadLearningState({ home: box.home, workspaceId })).versions.length;

  // --machine: unconfirmed, nothing changes; confirmed, every contribution goes and no workspace state changes.
  assert.equal(box.jevris(['route', 'learning', 'reset', '--machine']).code, 2);
  assert.equal(contributions(), 1);
  const machine = box.jevris(['route', 'learning', 'reset', '--machine', '--yes'], { json: true });
  assert.equal(machine.code, 0, machine.stdout + machine.stderr);
  assert.deepEqual([machine.json.command, machine.json.changed, machine.json.scope, machine.json.removed], ['route learning reset', true, 'machine', 1]);
  assert.equal(contributions(), 0);
  assert.equal((await core.loadLearningState({ home: box.home, workspaceId })).versions.length, version, 'the workspace policy is untouched');
  assert.equal((await core.loadLearningState({ home: box.home, workspaceId: 'ws-other' })).arms['bounded-edit']['claude-opus-5-5'].successes, 2, 'the other workspace keeps its own outcomes');
  const after = box.jevris(['route', 'learning', 'status', '--slice', 'bounded-edit'], { json: true });
  assert.equal(after.json.slices[0].posteriors.some((p) => p.machine !== undefined), false, JSON.stringify(after.json.slices[0].posteriors));
  assert.match(box.jevris(['route', 'learning', 'reset', '--machine', '--yes']).stdout, /^The route learning shared by the workspaces on this machine is cleared \(0 contributions removed\)/);
});

test('route learning gone lists and clears the models found gone on this machine, without a workspace, and status shows them (C f5b19ab)', async (t) => {
  const box = await sandbox(t);
  box.write('work/src/a.js', 'export const a = 1;\n');
  box.gitInit();
  const { RouteLearningGoneContract } = await import('@jevris/contracts');
  const registry = core.BUNDLED_MODEL_REGISTRY;
  const record = async (modelId, reasonCode, port, authMode) => {
    const r = await core.recordModelUnavailable({ home: box.home, modelId, reasonCode, port, authMode, source: 'launch', nowMs: Date.UTC(2026, 8, 27, 9), registry });
    assert.equal(r.ok, true, JSON.stringify(r));
  };
  // Outside any repository: the record is per machine.
  const outside = { cwd: box.home };
  const empty = box.jevris(['route', 'learning', 'gone'], { json: true, ...outside });
  assert.equal(empty.code, 0, empty.stdout + empty.stderr);
  assert.equal(RouteLearningGoneContract.validate(empty.json).ok, true, empty.stdout);
  assert.deepEqual([empty.json.command, empty.json.registrySnapshotId, empty.json.entries], ['route learning gone list', registry.snapshotId, []]);
  assert.match(box.jevris(['route', 'learning', 'gone', 'list'], outside).stdout, /^No model is recorded as gone on this machine \(registry /);

  await record('claude-opus-5-5', 'MODEL_GONE', 'claude-api', 'api-key');
  await record('gpt-5.1-codex', 'MODEL_NOT_ACCESSIBLE', 'codex', 'subscription');
  const listed = box.jevris(['route', 'learning', 'gone', 'list'], { json: true, ...outside });
  assert.equal(RouteLearningGoneContract.validate(listed.json).ok, true, listed.stdout);
  assert.deepEqual(listed.json.entries.map((e) => [e.modelId, e.reasonCode]).sort(), [['claude-opus-5-5', 'MODEL_GONE'], ['gpt-5.1-codex', 'MODEL_NOT_ACCESSIBLE']]);
  assert.deepEqual(listed.json.lines, core.modelAvailabilityLines(listed.json.entries));
  const text = box.jevris(['route', 'learning', 'gone'], outside).stdout;
  assert.match(text, /^claude-opus-5-5 is not recommended: found gone on this machine \(MODEL_GONE/m);
  assert.match(text, /^gpt-5\.1-codex is not recommended on codex with subscription sign-in/m);

  // status (in the workspace) shows the same lines, and carries the entries in its JSON.
  const status = box.jevris(['route', 'learning', 'status'], { json: true });
  assert.deepEqual(status.json.unavailable.entries.map((e) => e.modelId).sort(), ['claude-opus-5-5', 'gpt-5.1-codex']);
  assert.match(box.jevris(['route', 'learning', 'status']).stdout, /^claude-opus-5-5 is not recommended: found gone on this machine/m);

  // clear: unconfirmed changes nothing; an id not recorded asks nothing and changes nothing.
  assert.equal(box.jevris(['route', 'learning', 'gone', 'clear', 'claude-opus-5-5'], outside).code, 2);
  assert.equal((await core.loadModelAvailability(box.home, registry)).length, 2);
  const unknown = box.jevris(['route', 'learning', 'gone', 'clear', 'claude-haiku-4-5-20251001'], { json: true, ...outside });
  assert.equal(unknown.code, 0, 'nothing to clear is already done');
  assert.equal(RouteLearningGoneContract.validate(unknown.json).ok, true, unknown.stdout);
  assert.deepEqual([unknown.json.changed, unknown.json.reasonCode, unknown.json.removed], [false, 'NOTHING_TO_CLEAR', 0]);
  // Confirmed: that model only, then every one.
  const one = box.jevris(['route', 'learning', 'gone', 'clear', 'claude-opus-5-5', '--yes'], { json: true, ...outside });
  assert.equal(one.code, 0, one.stdout + one.stderr);
  assert.deepEqual([one.json.target, one.json.changed, one.json.reasonCode, one.json.removed], ['claude-opus-5-5', true, 'CHANGED', 1]);
  assert.deepEqual((await core.loadModelAvailability(box.home, registry)).map((e) => e.modelId), ['gpt-5.1-codex']);
  const all = box.jevris(['route', 'learning', 'gone', 'clear', '--all', '--yes'], outside);
  assert.equal(all.code, 0, all.stdout + all.stderr);
  assert.match(all.stdout, /^Every model found gone on this machine was cleared \(1 record\)/);
  assert.deepEqual(await core.loadModelAvailability(box.home, registry), []);

  for (const argv of [
    ['route', 'learning', 'gone', 'clear'],
    ['route', 'learning', 'gone', 'clear', 'a', 'b'],
    ['route', 'learning', 'gone', 'clear', 'claude-opus-5-5', '--all'],
    ['route', 'learning', 'gone', 'forget'],
    ['route', 'learning', 'gone', 'list', '--yes'],
    ['route', 'learning', 'gone', '--all'],
    ['route', 'learning', 'status', '--all'],
  ]) {
    assert.equal(box.jevris(argv, outside).code, 2, argv.join(' '));
  }
});

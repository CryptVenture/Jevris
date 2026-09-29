// C16 through the product: `jevris explain <id> --slice <s>` and jevris_explain_decision with a
// sliceId show how route learning stands for that slice in this workspace, next to the decision.
// The pair: with no local learning the slice is advice only at policy version 0; after a
// confirmed `jevris route learning pin` the same explain shows the pin at version 1. Without a
// slice the trace has no learning part, the baseline prior and local evidence are separate lines,
// learning off is said first, and a malformed slice is refused before any sidecar call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from '../../../test/acceptance/lib.mjs';

const { jevrisPaths } = await import('@jevris/platform');
const core = await import('@jevris/core');
const { workspaceIdFor } = await import('../dist/public/context.js');

const DECISION = 'd-00000000-0000-4000-8000-000000000016';
const SLICE = 'bounded-edit';

// A current time: the sidecar's retention sweep at start (B 3254d35) prunes a journal entry past
// the retention cutoff, and would race the test for an entry from 1970.
function journalEntry(decisionId) {
  const record = {
    schemaVersion: '1.0',
    decisionId,
    specId: 'main-route',
    modelResolved: null,
    mode: 'advise',
    evidenceRevision: 'r1',
    outcome: 'advisory',
    reasonCodes: ['KEEP_CURRENT'],
    proposedAction: { kind: 'advise', templateId: 'main-route', evidenceIds: [] },
    appliedAction: null,
    usage: null,
    billingBasis: 'no-provider-call',
    actualTaskOutcome: 'unknown',
  };
  return { schemaVersion: 'jevris-decision-journal-1', decisionId, state: 'evaluated', history: [{ state: 'evaluated', atMs: Date.now() }], draft: {}, record, schemaFailure: null };
}

test('explain --slice shows the slice route learning, before and after a pin (C16)', async (t) => {
  const box = await sandbox(t);
  box.gitInit();
  assert.equal(box.startSidecar().code, 0, 'the sidecar did not start');
  const journal = join(jevrisPaths({ home: box.home }).data, 'decisions');
  mkdirSync(journal, { recursive: true });
  writeFileSync(join(journal, `${DECISION}.json`), `${JSON.stringify(journalEntry(DECISION))}\n`);
  const client = await box.mcp();
  const viaMcp = async (args) => (await client.callTool({ name: 'jevris_explain_decision', arguments: { decisionId: DECISION, ...args } })).structuredContent;

  // Without a slice: the decision alone, no learning part.
  const plain = box.jevris(['explain', DECISION], { json: true });
  assert.equal(plain.code, 0, `${plain.stdout} ${plain.stderr}`);
  assert.equal(plain.json.result.found, true);
  assert.equal(plain.json.result.trace.learning, undefined);
  assert.equal((await viaMcp({})).result.trace.learning, undefined);

  // No local learning yet: advice only, version 0.
  const fresh = box.jevris(['explain', DECISION, '--slice', SLICE], { json: true });
  assert.equal(fresh.code, 0, `${fresh.stdout} ${fresh.stderr}`);
  const before = { sliceId: SLICE, mode: 'advise', version: 0, lines: ['advice only; no local outcomes yet'] };
  const freshLearning = fresh.json.result.trace.learning;
  assert.deepEqual({ ...freshLearning, lines: freshLearning.lines.slice(0, 1) }, before);
  // DOMAINS 3f090fa: explain says why each registry model is or is not account-eligible; with no evidence yet, none is.
  const eligibility = freshLearning.lines.slice(1);
  assert.ok(eligibility.length > 0 && eligibility.every((line) => /is not eligible: it has not run on this machine and no harness listing names it \(NO_LOCAL_EVIDENCE\)\.$/.test(line)), JSON.stringify(eligibility));
  assert.deepEqual((await viaMcp({ sliceId: SLICE })).result.trace.learning, freshLearning);
  const human = box.jevris(['explain', DECISION, '--slice', SLICE]);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /route learning: bounded-edit: advice only, policy v0/);
  assert.match(human.stdout, /advice only; no local outcomes yet/);

  // A confirmed pin changes what explain reports for the slice, on both surfaces.
  const pinned = box.jevris(['route', 'learning', 'pin', SLICE, 'claude-sonnet-4-6', '--yes'], { json: true });
  assert.equal(pinned.code, 0, `${pinned.stdout} ${pinned.stderr}`);
  const after = box.jevris(['explain', DECISION, '--slice', SLICE], { json: true });
  assert.equal(after.code, 0, `${after.stdout} ${after.stderr}`);
  for (const learning of [after.json.result.trace.learning, (await viaMcp({ sliceId: SLICE })).result.trace.learning]) {
    assert.deepEqual([learning.sliceId, learning.mode, learning.version], [SLICE, 'pinned', 1], JSON.stringify(learning));
    assert.ok(learning.lines.length > 0);
    // The signed baseline prior and the local evidence are reported apart.
    assert.ok(learning.lines.some((line) => /^Baseline/.test(line)), JSON.stringify(learning.lines));
    assert.ok(learning.lines.some((line) => /^(No local outcomes yet|Local)/.test(line)), JSON.stringify(learning.lines));
  }
  assert.match(box.jevris(['explain', DECISION, '--slice', SLICE]).stdout, /route learning: bounded-edit: pinned, policy v1/);

  // Learning off in the workspace: explain says so first, on both surfaces.
  assert.equal(box.jevris(['route', 'learning', 'off']).code, 0);
  const off = box.jevris(['explain', DECISION, '--slice', SLICE], { json: true });
  for (const learning of [off.json.result.trace.learning, (await viaMcp({ sliceId: SLICE })).result.trace.learning]) {
    assert.match(learning.lines[0], /route learning is off in this workspace/);
  }

  // A malformed slice is a usage error on the CLI and a refusal over MCP.
  const bad = box.jevris(['explain', DECISION, '--slice', '../x'], { json: true });
  assert.equal(bad.code, 2, `${bad.stdout} ${bad.stderr}`);
  const refused = await client.callTool({ name: 'jevris_explain_decision', arguments: { decisionId: DECISION, sliceId: '../x' } });
  assert.equal(refused.isError, true, JSON.stringify(refused));
});

/** Route outcomes for the slice: the default on a key (3 of 4 verified at $2, 60 s) and a cheaper arm on a subscription (1 verified, $0.50 API-equivalent). */
function economicsState(workspaceId) {
  const now = '2026-09-26T00:00:00Z';
  let seq = 0;
  const event = (overrides) => {
    seq += 1;
    const verified = overrides.kind === undefined || overrides.kind.startsWith('verified');
    return {
      eventId: `ev-${seq}`,
      routeId: `route-${seq}`,
      sliceId: SLICE,
      modelId: 'claude-opus-5-5',
      rulesModelId: 'claude-opus-5-5',
      policyVersion: 0,
      kind: 'verified-pass',
      labelSource: 'verification-receipt',
      receiptId: verified ? `rcpt-${seq}` : null,
      explored: false,
      propensity: 0.95,
      risk: 'low',
      costMicroUsd: 2_000_000,
      latencyMs: 60_000,
      authMode: 'api-key',
      at: `2026-09-26T00:00:${String(seq).padStart(2, '0')}Z`,
      ...overrides,
    };
  };
  let state = core.emptyLearningState({ workspaceId, now });
  const events = [
    ...['verified-pass', 'verified-pass', 'verified-pass', 'verified-fail'].map((kind) => event({ kind })),
    event({ modelId: 'claude-sonnet-5', costMicroUsd: null, apiEquivalentMicroUsd: 500_000, tokens: 1_000_000, latencyMs: 30_000, authMode: 'subscription', explored: true, propensity: 0.05 }),
  ];
  for (const e of events) {
    const recorded = core.recordRouteOutcome(state, e);
    assert.equal(recorded.ok, true, JSON.stringify(recorded));
    state = recorded.state;
  }
  return state;
}

test('explain --slice carries each arm\'s economics per verified task against the default, money in integer micro-USD, and the machine-wide part of each posterior (C16, §22.2, C 6750120, 7bea448)', async (t) => {
  const box = await sandbox(t);
  box.gitInit();
  const workspaceId = workspaceIdFor(box.work);
  assert.equal((await core.saveLearningState(box.home, economicsState(workspaceId))).ok, true);
  // Another workspace on this machine has one verified outcome on the default arm (C 7bea448).
  const other = { ...economicsState('ws-other').events[0], eventId: 'ev-other-1', routeId: 'route-other-1', receiptId: 'rcpt-other-1' };
  const learned = await core.learnFromOutcome({ home: box.home, workspaceId: 'ws-other', event: other, baselineModelId: 'claude-opus-5-5', eligibleModelIds: ['claude-opus-5-5', 'claude-sonnet-5'], now: '2026-09-26T00:01:00Z', registry: core.BUNDLED_MODEL_REGISTRY });
  assert.equal(learned.recorded, true, JSON.stringify(learned));
  // A model found gone on this machine (C f5b19ab): explain says it is never recommended here.
  const goneRecorded = await core.recordModelUnavailable({ home: box.home, modelId: 'claude-haiku-4-5-20251001', reasonCode: 'MODEL_GONE', port: 'claude-api', authMode: 'api-key', source: 'launch', nowMs: Date.UTC(2026, 8, 27, 9), registry: core.BUNDLED_MODEL_REGISTRY });
  assert.equal(goneRecorded.ok, true, JSON.stringify(goneRecorded));
  assert.equal(box.startSidecar().code, 0, 'the sidecar did not start');
  const journal = join(jevrisPaths({ home: box.home }).data, 'decisions');
  mkdirSync(journal, { recursive: true });
  writeFileSync(join(journal, `${DECISION}.json`), `${JSON.stringify(journalEntry(DECISION))}\n`);

  const shown = box.jevris(['explain', DECISION, '--slice', SLICE], { json: true });
  assert.equal(shown.code, 0, `${shown.stdout} ${shown.stderr}`);
  const economics = shown.json.result.trace.learning.economics;
  assert.equal(economics.defaultArmId, 'claude-opus-5-5');
  assert.equal(economics.minVerified, core.ECONOMICS_MIN_VERIFIED);
  const [d, c] = economics.arms;
  // The default is listed first: $8 over 4 routes for 3 verified tasks, 240 s of wall time.
  assert.deepEqual(d, {
    armId: 'claude-opus-5-5',
    modelId: 'claude-opus-5-5',
    effort: null,
    isDefault: true,
    routes: 4,
    verified: 3,
    costPerVerifiedMicroUsd: 2_666_667,
    apiEquivalentPerVerifiedMicroUsd: 2_666_667,
    tokensPerVerified: null,
    usagePerVerified: null,
    wallMsPerVerified: 80_000,
    costRatioVsDefault: 1,
    usageRatioVsDefault: null,
    wallRatioVsDefault: 1,
  });
  // The subscription arm has no billed dollars; its API-equivalent estimate stands in.
  assert.deepEqual(
    [c.armId, c.isDefault, c.verified, c.costPerVerifiedMicroUsd, c.apiEquivalentPerVerifiedMicroUsd, c.tokensPerVerified, c.wallMsPerVerified],
    ['claude-sonnet-5', false, 1, null, 500_000, 1_000_000, 30_000],
  );
  assert.equal(c.costRatioVsDefault, core.explainSliceLearning(economicsState(workspaceId), SLICE).economics.arms[1].costRatioVsDefault);
  for (const arm of economics.arms) {
    for (const key of ['costPerVerifiedMicroUsd', 'apiEquivalentPerVerifiedMicroUsd', 'tokensPerVerified', 'usagePerVerified', 'wallMsPerVerified']) {
      assert.ok(arm[key] === null || Number.isSafeInteger(arm[key]), `${arm.armId} ${key} ${arm[key]}`);
    }
  }
  // The other workspace's outcome is the machine part of the default arm's posterior, kept apart from the local counts.
  const posteriors = shown.json.result.trace.learning.posteriors;
  const opus = posteriors.find((p) => p.armId === 'claude-opus-5-5');
  assert.deepEqual([opus.local.successes, opus.local.failures], [3, 1]);
  assert.deepEqual([opus.machine.successes, opus.machine.failures, opus.machine.rate, opus.machine.contributors], [1, 0, 1, 1], JSON.stringify(opus));
  assert.equal(posteriors.find((p) => p.armId === 'claude-sonnet-5').machine, null, 'no other workspace ran it');
  // C's found-gone line is in the trace lines, once, after C's own lines.
  const goneLine = core.modelAvailabilityLines([goneRecorded.entry])[0];
  const traceLines = shown.json.result.trace.learning.lines;
  assert.equal(traceLines.filter((l) => l === goneLine).length, 1, JSON.stringify(traceLines));
  assert.equal(traceLines.at(-1), goneLine);
  // The MCP tool carries the same numbers; the human trace shows them as lines.
  const client = await box.mcp();
  const viaMcp = await client.callTool({ name: 'jevris_explain_decision', arguments: { decisionId: DECISION, sliceId: SLICE } });
  assert.deepEqual(viaMcp.structuredContent.result.trace.learning.economics, economics);
  assert.deepEqual(viaMcp.structuredContent.result.trace.learning.posteriors, posteriors);
  const human = box.jevris(['explain', DECISION, '--slice', SLICE]).stdout;
  assert.match(human, /^Per verified task claude-opus-5-5: \$2\.6667 billed/m);
  assert.match(human, /^claude-haiku-4-5-20251001 is not recommended: found gone on this machine \(MODEL_GONE/m);
});

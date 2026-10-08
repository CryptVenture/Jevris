// Sonnet-first routing where people look (owner decision 2026-09-30, visibility), through the built
// CLI, sidecar and MCP server: `jevris status` and jevris_status carry the setting and, per harness,
// the first-try and baseline models and how many slices start on each; `jevris explain --slice` and
// jevris_explain_decision carry the verdict with its counts, numbers and reason code; `jevris
// cost-report` carries the first-try section. Each is shown in plain text and in JSON, for the
// states a person can be in: no data, a setting of baseline, and a ledger with a slice in each
// verdict. Temporary HOME, a sandbox sidecar, no network, no model call, no worker run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from '../../../test/acceptance/lib.mjs';

const orchestrator = await import('@jevris/orchestrator');
const { jevrisPaths } = await import('@jevris/platform');
const { surfacePayloadContract } = await import('@jevris/contracts');

// Claude Code's baseline is Sonnet 5.5 and its first try Haiku 5.5 (owner decision 2026-10-08).
const FIRST = 'claude-haiku-5-5';
const BASE = 'claude-sonnet-5-5';
const DECISION = 'd-00000000-0000-4000-8000-000000000b02';
const NO_SIDECAR = { extraEnv: { JEVRIS_SIDECAR_AUTOSTART: '0' } };
const ANTIGRAVITY_OFF = 'antigravity: off (no cheaper active model than gemini-3.8-flash, and its only stronger model is a preview, which is never started automatically)';

const note = (arm) => ({ firstTry: { arm, propensity: arm === 'control' ? 0.1 : 0.9, firstTryModelId: FIRST, baselineModelId: BASE, stepUpModelIds: [BASE], breakEven: 0.5, breakEvenBasis: 'estimated', overheadMicroUsd: 1000 } });
const run = (leaseId, model, costUsd) => ({ leaseId, requestedModel: model, actualModel: model, costUsd, authMode: 'api-key', durationMs: 1000 });

/** One finished task in the ledger: `pass` (first attempt passed) or `fail` (first attempt failed, no hand-off). */
async function task(ws, id, { slice, arm = 'first-try', outcome = 'pass', costUsd }) {
  const model = arm === 'control' ? BASE : FIRST;
  await orchestrator.keepFirstTryRoute(ws, { taskId: id, sliceId: slice, run: { leaseId: `l-${id}`, requestedModel: model }, note: note(arm), nowMs: 1 });
  await orchestrator.recordFirstTryOutcome(ws, id, outcome === 'pass' ? 'verified-pass' : 'verified-fail', { run: run(`l-${id}`, model, costUsd), nowMs: 2 });
  if (outcome === 'fail') await orchestrator.closeUnhandled(ws, id, 3);
}

/**
 * The ledger of one workspace: `issue-fix` pays (5 first-try passes at $0.02, one control pass at
 * $0.05), `failing-slice` does not (5 first-try failures), `learning-slice` is under the floor (2).
 */
async function seed(box) {
  const ws = orchestrator.openWorkspace({ home: box.home, workspaceRoot: box.work });
  for (let i = 0; i < 5; i += 1) await task(ws, `P${String(i)}`, { slice: 'issue-fix', costUsd: 0.02 });
  await task(ws, 'C0', { slice: 'issue-fix', arm: 'control', costUsd: 0.05 });
  for (let i = 0; i < 5; i += 1) await task(ws, `F${String(i)}`, { slice: 'failing-slice', outcome: 'fail', costUsd: 0.02 });
  for (let i = 0; i < 2; i += 1) await task(ws, `L${String(i)}`, { slice: 'learning-slice', costUsd: 0.02 });
}

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

function writeJournal(box) {
  const journal = join(jevrisPaths({ home: box.home }).data, 'decisions');
  mkdirSync(journal, { recursive: true });
  writeFileSync(join(journal, `${DECISION}.json`), `${JSON.stringify(journalEntry(DECISION))}\n`);
}

const lineOf = (text, prefix) => text.split('\n').find((l) => l.startsWith(prefix));
const statusLine = (text) => lineOf(text, 'first-try slices: ');
const mcpCall = async (client, name, args) => (await client.callTool({ name, arguments: args })).structuredContent;

test('auto with no data: status says the ladder per harness with no slices, explain and cost-report say there is no first-try task yet', async (t) => {
  const box = await sandbox(t);
  box.gitInit();

  // The reduced status (no sidecar) is the same view.
  const reduced = box.jevris(['status'], NO_SIDECAR);
  assert.equal(reduced.code, 0, reduced.stdout + reduced.stderr);
  const reducedJson = box.jevris(['status'], { json: true, ...NO_SIDECAR });
  assert.equal(surfacePayloadContract('status').validate(reducedJson.json.result).ok, true);

  assert.equal(box.startSidecar().code, 0, 'the sidecar did not start');
  writeJournal(box);
  const text = box.jevris(['status']);
  assert.equal(text.code, 0, text.stdout + text.stderr);
  assert.equal(
    statusLine(text.stdout),
    `first-try slices: claude: ${FIRST} first, ${BASE} baseline, no slices yet; codex: gpt-6-luna first, gpt-6.1-sol baseline, no slices yet; ${ANTIGRAVITY_OFF}`,
  );
  assert.equal(statusLine(reduced.stdout), statusLine(text.stdout));
  const json = box.jevris(['status'], { json: true });
  const view = json.json.result.firstTry;
  assert.equal(surfacePayloadContract('status').validate(json.json.result).ok, true);
  assert.deepEqual(view, reducedJson.json.result.firstTry);
  assert.deepEqual([view.setting, view.unavailable, view.other], ['auto', null, { firstTry: 0, baselineFirst: 0, learning: 0 }]);
  const claude = view.harnesses.find((h) => h.harness === 'claude');
  assert.deepEqual([claude.state, claude.firstTryModelId, claude.baselineModelId, claude.slices], ['on', FIRST, BASE, { firstTry: 0, baselineFirst: 0, learning: 0 }]);
  const agy = view.harnesses.find((h) => h.harness === 'antigravity');
  assert.deepEqual([agy.state, agy.reasonCode, agy.firstTryModelId, agy.strongerIsPreview], ['off', 'NO_CHEAPER_RUNG', null, true]);
  const client = await box.mcp();
  assert.deepEqual((await mcpCall(client, 'jevris_status', {})).result.firstTry, view);

  // Explain: one line, and the JSON has an empty group list.
  const explain = box.jevris(['explain', DECISION, '--slice', 'issue-fix']);
  assert.equal(explain.code, 0, explain.stdout + explain.stderr);
  assert.match(explain.stdout, /^first-try routing for slice issue-fix \(routing\.firstTry auto\): no first-try task has run for it in this workspace yet$/m);
  const explainJson = box.jevris(['explain', DECISION, '--slice', 'issue-fix'], { json: true });
  assert.deepEqual(explainJson.json.result.trace.firstTry, { sliceId: 'issue-fix', setting: 'auto', groups: [] });
  assert.deepEqual((await mcpCall(client, 'jevris_explain_decision', { decisionId: DECISION, sliceId: 'issue-fix' })).result.trace.firstTry, explainJson.json.result.trace.firstTry);
  // Without a slice the trace has no first-try part.
  assert.equal(box.jevris(['explain', DECISION], { json: true }).json.result.trace.firstTry, undefined);

  // Cost-report: one line, and the JSON section has no figure.
  const cost = box.jevris(['cost-report']);
  assert.equal(cost.code, 0, cost.stdout + cost.stderr);
  assert.match(cost.stdout, /^first-try routing: no first-try task has run in this workspace yet \(routing\.firstTry auto\)$/m);
  const costJson = box.jevris(['cost-report'], { json: true });
  assert.equal(costJson.json.report.firstTry.started, 0);
  assert.equal(costJson.json.report.firstTry.savedMicroUsd, null);
});

test('a ledger with a slice in each verdict: status counts them, explain gives the verdict and its numbers, cost-report gives the spend against the baseline estimate', async (t) => {
  const box = await sandbox(t);
  box.gitInit();
  await seed(box);
  assert.equal(box.startSidecar().code, 0, 'the sidecar did not start');
  writeJournal(box);
  const client = await box.mcp();

  // Status: one slice on the first try, one on the baseline, one still learning; the same in JSON and over MCP.
  const text = box.jevris(['status']);
  assert.equal(text.code, 0, text.stdout + text.stderr);
  assert.match(statusLine(text.stdout), new RegExp(`claude: ${FIRST} first, ${BASE} baseline, 1 on the first try, 1 on the baseline, 1 still learning; codex: gpt-6-luna first, gpt-6.1-sol baseline, no slices yet;`));
  assert.ok(statusLine(text.stdout).endsWith(ANTIGRAVITY_OFF), statusLine(text.stdout));
  const json = box.jevris(['status'], { json: true });
  assert.equal(surfacePayloadContract('status').validate(json.json.result).ok, true);
  const claude = json.json.result.firstTry.harnesses.find((h) => h.harness === 'claude');
  assert.deepEqual(claude.slices, { firstTry: 1, baselineFirst: 1, learning: 1 });
  assert.deepEqual((await mcpCall(client, 'jevris_status', {})).result.firstTry, json.json.result.firstTry);
  const reduced = box.jevris(['status'], NO_SIDECAR);
  assert.equal(statusLine(reduced.stdout), statusLine(text.stdout), 'the reduced status is the same view');

  // Explain, one slice per verdict: the verdict, its reason code and the numbers it used.
  const explainOf = (slice) => box.jevris(['explain', DECISION, '--slice', slice]).stdout;
  const group = (slice) => box.jevris(['explain', DECISION, '--slice', slice], { json: true }).json.result.trace.firstTry.groups[0];

  const paying = group('issue-fix');
  assert.deepEqual([paying.verdict, paying.reasonCode, paying.firstTryModelId, paying.baselineModelId], ['first-try', 'FIRST_TRY_WORTH_IT', FIRST, BASE]);
  assert.deepEqual(paying.started, { firstTry: 5, control: 1, open: 0 });
  assert.deepEqual(paying.firstTry, { finished: 5, verified: 5, firstAttemptPass: 5, firstAttemptFail: 0, handedOff: 0 });
  assert.deepEqual(paying.control, { finished: 1, verified: 1 });
  assert.deepEqual(paying.costPerVerified, { firstTryMicroUsd: 20_000, controlMicroUsd: 50_000, estimate: false });
  assert.equal(paying.breakEven.value, 0.5);
  assert.equal(paying.thresholds.reinstateBelow, 0.1);
  assert.equal(paying.thresholds.demoteAbove, 0.4);
  assert.equal(paying.thresholds.minFinishedToReinstate, 12);
  const payingText = explainOf('issue-fix');
  assert.match(payingText, /^first-try routing for slice issue-fix \(routing\.firstTry auto\):$/m);
  assert.match(payingText, new RegExp(`^- ${FIRST} before ${BASE}: first try \\(FIRST_TRY_WORTH_IT\\)$`, 'm'));
  assert.match(payingText, /^ {4}tasks: first try 5 started, 5 finished, 5 verified; 5 passed the check on the first attempt, 0 failed it, 0 handed up; control \(baseline first\) 1 started, 1 finished, 1 verified; 0 still open$/m);
  assert.match(payingText, /^ {4}break-even p\* = \(cS \+ h\) \/ \(cO \+ h\) = 0\.5000 \(estimated from list prices when the first task started\);/m);
  assert.match(payingText, /^ {4}cost per verified task: first try 20000 micro-USD \(\$0\.0200\), control 50000 micro-USD \(\$0\.0500\)$/m);
  assert.match(payingText, /^quality: unknown; a verified task is a passing check, not a quality score$/m);

  const failing = group('failing-slice');
  assert.equal(failing.verdict, 'baseline-first');
  assert.deepEqual(failing.firstTry, { finished: 5, verified: 0, firstAttemptPass: 0, firstAttemptFail: 5, handedOff: 0 });
  assert.ok(failing.pBelowBreakEven > 0.9, `P(success rate below p*) = ${failing.pBelowBreakEven}`);
  assert.match(explainOf('failing-slice'), new RegExp(`^- ${FIRST} before ${BASE}: baseline first \\(${failing.reasonCode}\\)$`, 'm'));

  const learning = group('learning-slice');
  assert.deepEqual([learning.verdict, learning.reasonCode, learning.firstTry.finished, learning.pBelowBreakEven], ['learning', 'DAY_1_PRIOR', 2, 0.125]);
  assert.match(explainOf('learning-slice'), /^ {4}first-try success: P\(success rate below p\*\) = 0\.125; demote above 0\.40, come back below 0\.10 with at least 12 finished first-try tasks$/m);

  // The MCP tool carries the same view as the CLI, and a slice never run has an empty list.
  assert.deepEqual((await mcpCall(client, 'jevris_explain_decision', { decisionId: DECISION, sliceId: 'issue-fix' })).result.trace.firstTry, box.jevris(['explain', DECISION, '--slice', 'issue-fix'], { json: true }).json.result.trace.firstTry);
  assert.deepEqual(group('never-run'), undefined);

  // Cost-report: only issue-fix has a control, so only it is compared; saved = 5 x $0.05 - 5 x $0.02.
  const cost = box.jevris(['cost-report']);
  assert.equal(cost.code, 0, cost.stdout + cost.stderr);
  assert.match(cost.stdout, /^First-try routing \(Sonnet-first\), routing\.firstTry auto:$/m);
  assert.match(cost.stdout, /^started on the first try: 12 \(0 still open\)$/m);
  assert.match(cost.stdout, /^handed up to a stronger model: 0$/m);
  assert.match(cost.stdout, /^completed on the first try: 7$/m);
  assert.match(cost.stdout, /^finished: 12, verified: 7$/m);
  assert.match(cost.stdout, /^spent on the finished first-try tasks: 100000 micro-USD \(\$0\.1000\)$/m);
  assert.match(cost.stdout, /^baseline estimate for the same verified tasks: 250000 micro-USD \(\$0\.2500\)$/m);
  assert.match(cost.stdout, /^saved against the baseline estimate: 150000 micro-USD \(\$0\.1500\)$/m);
  assert.match(cost.stdout, /^compared for 1 of 3 slice\(s\) with finished first-try tasks; the money figures cover only those$/m);
  assert.match(cost.stdout, /^control share caveat: /m);
  assert.match(cost.stdout, /^quality: unknown; a verified task is a passing check, not a quality score$/m);
  const costJson = box.jevris(['cost-report'], { json: true }).json.report.firstTry;
  assert.deepEqual(
    [costJson.started, costJson.open, costJson.handedUp, costJson.completedOnFirstTry, costJson.spentMicroUsd, costJson.baselineEstimateMicroUsd, costJson.savedMicroUsd, costJson.slices, costJson.compared],
    [12, 0, 0, 7, 100_000, 250_000, 150_000, 3, 1],
  );
  for (const key of ['spentMicroUsd', 'baselineEstimateMicroUsd', 'savedMicroUsd']) assert.ok(Number.isSafeInteger(costJson[key]), key);
  const unmatched = costJson.groups.find((g) => g.sliceId === 'failing-slice');
  assert.deepEqual([unmatched.baselineEstimateMicroUsd, unmatched.savedMicroUsd], [null, null], 'a slice with no control has no estimate, and no figure is invented');
});

test('routing.firstTry baseline: status says off, explain and cost-report name the setting, and the ledger is untouched', async (t) => {
  const box = await sandbox(t);
  box.gitInit();
  await seed(box);
  const set = box.jevris(['configure', 'set', 'routing.firstTry', 'baseline']);
  assert.equal(set.code, 0, set.stdout + set.stderr);
  assert.equal(box.startSidecar().code, 0, 'the sidecar did not start');
  writeJournal(box);
  const client = await box.mcp();

  const text = box.jevris(['status']);
  assert.equal(statusLine(text.stdout), 'first-try slices: off (routing.firstTry is baseline, so the baseline model runs first)');
  assert.equal(statusLine(box.jevris(['status'], NO_SIDECAR).stdout), statusLine(text.stdout));
  const view = box.jevris(['status'], { json: true }).json.result.firstTry;
  assert.equal(view.setting, 'baseline');
  for (const h of view.harnesses) assert.deepEqual([h.state, h.reasonCode], ['off', 'FIRST_TRY_OFF'], h.harness);
  assert.deepEqual((await mcpCall(client, 'jevris_status', {})).result.firstTry, view);

  const explain = box.jevris(['explain', DECISION, '--slice', 'issue-fix']);
  assert.match(explain.stdout, /^first-try routing for slice issue-fix \(routing\.firstTry baseline\):$/m, 'the verdict is still the ledger\'s, and the header names the setting');
  assert.match(box.jevris(['cost-report']).stdout, /^First-try routing \(Sonnet-first\), routing\.firstTry baseline:$/m);

  // Nothing about the ledger changed: switching back reads the same counts.
  assert.equal(orchestrator.firstTryRows(orchestrator.openWorkspace({ home: box.home, workspaceRoot: box.work })).length, 13);
});

import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { load, story } from './lib.mjs';
import { certifyHooks, deliverHook } from './certified-hooks.mjs';
import { startJevStub } from './jev-stub.mjs';
import { ownedWorkers, submit, taskNode, taskReader } from './owned.mjs';
import { verifySettled } from './verify-run.mjs';

// An owned worker finishes and says every check passed. It ran none, and its patch does not
// actually pass. Jev is reachable (egress approved) and the agent ends its turn with the same
// claim. The worker is D's scripted worker port; the stop is a real Claude Code Stop delivery.
const CLAIM = 'All checks passed. The task is complete.';
const HOST = {
  schemaVersion: '1.0',
  mode: 'bounded-auto',
  egress: 'approved-scoped',
  retention: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 },
  budget: { maxRequestBytes: 65536 },
  pin: { model: 'jev-1.13.0', respectHumanPins: true },
  packPrivileges: [],
  credentialRef: 'host-secret:typesafe-primary',
  installerEnvName: 'JEVRIS_INSTALLER_KEY',
  allowUncalibratedActuation: false,
};

story('US24', async ({ t, then, sandbox, evidence }) => {
  const jev = await startJevStub(t);
  const box = await sandbox({ env: jev.env });
  const { jevrisPaths } = await load('platform');
  box.write(join(relative(box.dir, jevrisPaths({ home: box.home }).config), 'host.json'), HOST);
  box.write('work/lib/total.mjs', 'export const total = (xs) => xs.length;\n');
  box.write('work/check-total.mjs', "import { total } from './lib/total.mjs';\nif (total([2, 3]) !== 5) {\n  console.error('total([2, 3]) should be 5');\n  process.exit(1);\n}\n");
  box.write('work/jevris.checks.json', {
    schemaVersion: 'jevris-checks-1',
    checks: [{ id: 'unit', argv: [process.execPath, 'check-total.mjs'], mandatory: true, resultFormat: 'exit-code', requirementIds: ['SUM-1'], description: 'the totals tests' }],
  });
  box.gitInit();
  await box.workerScript([{ writes: [{ path: 'lib/total.mjs', text: 'export const total = (xs) => xs.length + 1;\n' }], status: 'completed', costUsd: 0.02, reason: CLAIM }]);
  await ownedWorkers(box);
  assert.equal(box.startSidecar().code, 0, 'the sidecar did not start');
  await certifyHooks(box);
  submit(box, [taskNode('T1', { title: 'Sum the totals', requirementIds: ['SUM-1'], writeScopes: ['lib'] })]);
  const client = await box.mcp();
  const task = taskReader(client);
  const finished = await task('T1', 'awaiting-evidence');
  assert.equal(finished?.task?.state, 'awaiting-evidence', `T1 is ${finished?.task?.state}`);

  await then('The claim is unverified', async () => {
    evidence(finished);
    assert.equal(finished.worker.status, 'completed');
    assert.deepEqual(finished.receipts, [], 'the worker\'s report produced a receipt');
    // The agent cannot turn its claim into a receipt: linking one it invented is refused.
    const linked = await client.callTool({ name: 'jevris_record_verification', arguments: { receiptId: 'rcpt-all-checks-passed', checkId: 'unit', taskId: 'T1' } });
    evidence(linked.structuredContent);
    assert.deepEqual([linked.structuredContent.result.accepted, linked.structuredContent.result.receiptCreated, linked.structuredContent.result.reasonCode], [false, false, 'RECEIPT_NOT_FOUND']);
    // Ending the turn with the claim gets the missing-evidence answer, not a pass.
    const transcript = join(box.dir, 's-us24.jsonl');
    writeFileSync(transcript, '');
    appendFileSync(transcript, `${JSON.stringify({ type: 'assistant', text: CLAIM })}\n`);
    const stop = deliverHook(box, 'claude', { session_id: 's-us24', transcript_path: transcript, cwd: box.work, hook_event_name: 'Stop', stop_hook_active: false });
    evidence(stop.stdout);
    assert.match(JSON.parse(stop.stdout).systemMessage, /^Missing verification evidence: unit/);
    const required = box.jevris(['verify', 'required', 'unit'], { json: true });
    evidence(required.json);
    assert.equal(required.code, 1);
    assert.equal(required.json.checks[0].status, 'missing');
  });

  await then('the task cannot transition to verified based on Jev confidence or the final message', async () => {
    // Jev is asked for advice on the task and answers; the answer changes nothing.
    const advice = box.jevris(['recover', '--failure', 'total([2, 3]) should be 5', '--failure', 'total([2, 3]) should be 5', '--task', 'T1'], { json: true });
    evidence(advice.json);
    assert.equal(advice.code, 0, advice.stderr);
    assert.ok(jev.requests().length > 0, 'Jev was never asked, so its confidence was not exercised');
    let now = await task('T1');
    assert.equal(now.task.state, 'awaiting-evidence', 'advice moved the task');
    assert.deepEqual(now.receipts, []);
    // Only the runner decides, and the patch does not pass.
    const verify = await verifySettled(box, ['--task', 'T1'], { task: 'T1' });
    evidence(verify.json);
    assert.equal(verify.code, 1);
    assert.equal(verify.json.result.readiness, 'not-verified');
    assert.deepEqual(verify.json.result.missing, ['unit']);
    now = await task('T1');
    assert.equal(now.task.state, 'awaiting-evidence', `T1 is ${now.task.state}`);
    assert.equal(now.receipts[0].outcome, 'failed');
  });
});

import assert from 'node:assert/strict';
import { workflow } from './lib.mjs';
import { ownedWorkers } from './owned.mjs';
import { verifySettled } from './verify-run.mjs';

// W01: a small API response-field change done by a bounded owned worker. The worker is D's
// scripted worker port (test mode plus the sandbox's test-home marker): it writes its patch in
// its own worktree and reports a model and a cost. Everything else is the product: plan
// validation, the owned-worker launch under a root budget, the verification runner in the task's
// worktree, and the task record the final report reads.
const BEFORE = "export function user() {\n  return { id: 1, name: 'Ada' };\n}\n";
const AFTER = "export function user() {\n  return { id: 1, name: 'Ada', email: 'ada@example.com' };\n}\n";
const MODEL = 'claude-sonnet-4-5';

const node = (id, extra = {}) => ({
  id,
  schemaVersion: '1.0',
  workspaceId: 'api',
  revision: 'r1',
  state: 'proposed',
  title: 'Add email to the user response',
  requirementIds: ['API-7'],
  dependencyIds: [],
  writeScopes: ['lib'],
  acceptanceCheckIds: ['contract'],
  expectedOutputs: ['patch'],
  models: [MODEL],
  rootBudgetId: 'sprint',
  ...extra,
});
// The same task as a bare TaskNode: plain `jevris plan` validates the TaskNode contract only.
const bare = ({ title, models, expectedOutputs, ...rest }) => rest;

async function taskOf(client, taskId, until) {
  let result;
  for (let i = 0; i < 150; i += 1) {
    result = (await client.callTool({ name: 'jevris_get_task', arguments: { taskId } })).structuredContent?.result;
    if (until === undefined || result?.task?.state === until) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return result;
}

workflow('W01', 'A routine feature with a bounded worker', async ({ then, sandbox, evidence }) => {
  const box = await sandbox();
  box.write('work/lib/api.js', BEFORE);
  box.write('work/check-contract.mjs', "import { user } from './lib/api.js';\nif (typeof user().email !== 'string') {\n  console.error('the user response has no email field');\n  process.exit(1);\n}\nconsole.log('response contract ok');\n");
  box.write('work/jevris.checks.json', {
    schemaVersion: 'jevris-checks-1',
    checks: [{ id: 'contract', argv: [process.execPath, 'check-contract.mjs'], mandatory: true, resultFormat: 'exit-code', requirementIds: ['API-7'], description: 'the user response contract' }],
  });
  box.gitInit();
  await box.workerScript([
    { writes: [{ path: 'lib/api.js', text: AFTER }], status: 'completed', costUsd: 0.04, reason: 'added the email field' },
    { writes: [{ path: 'lib/notes.txt', text: 'looked at the admin response\n' }], status: 'completed', costUsd: 0.01, reason: 'no change needed' },
  ]);
  await ownedWorkers(box);
  const plan = box.write('work/plan.json', { tasks: [node('T1')] });
  const client = await box.mcp();

  await then('deterministic rules validate the plan before any worker starts', () => {
    const checked = box.jevris(['plan', '--graph', box.write('work/tasks.json', [bare(node('T1'))])], { json: true });
    evidence(checked.json);
    assert.equal(checked.code, 0, `plan: ${checked.stdout} ${checked.stderr}`);
    assert.equal(checked.json.result.valid, true);
    assert.deepEqual(checked.json.result.ready, ['T1']);
    // A task naming a check nobody approved is refused before any budget or worker exists.
    const unapproved = box.write('work/unapproved.json', { tasks: [node('T9', { acceptanceCheckIds: ['e2e'] })] });
    const refused = box.jevris(['plan', '--submit', '--graph', unapproved, '--budget', 'refused', '--limit-micro-usd', '1000000', '--authorization', box.authorizeBudget('refused'), '--yes'], { json: true });
    evidence(refused.json);
    assert.equal(refused.code, 1);
    assert.equal(refused.json.accepted, false);
    assert.deepEqual(refused.json.issues.map((issue) => issue.code), ['UNKNOWN_CHECK']);
    assert.deepEqual(refused.json.leaseIds, []);
  });

  await then('an owned-worker budget is reserved and the bounded worker changes only its own workspace', async () => {
    const submitted = box.jevris(['plan', '--submit', '--graph', plan, '--budget', 'sprint', '--limit-micro-usd', '2000000', '--authorization', box.authorizeBudget('sprint'), '--yes'], { json: true });
    evidence(submitted.json);
    assert.equal(submitted.code, 0, `plan --submit: ${submitted.stdout} ${submitted.stderr}`);
    assert.equal(submitted.json.rootBudgetId, 'sprint');
    assert.equal(submitted.json.leaseIds.length, 1, 'no owned worker was leased');
    const task = await taskOf(client, 'T1', 'awaiting-evidence');
    evidence(task);
    assert.equal(task?.task?.state, 'awaiting-evidence', `T1 is ${task?.task?.state}`);
    assert.equal(box.read('work/lib/api.js'), BEFORE, 'the worker wrote into the main checkout');
  });

  await then('completion requires fresh receipts from the declared checks', async () => {
    const waiting = await taskOf(client, 'T1');
    assert.deepEqual(waiting.receipts, [], 'the finished worker alone produced a receipt');
    assert.notEqual(waiting.task.state, 'verified', 'the worker finishing marked the task verified');
    const verify = await verifySettled(box, ['--task', 'T1'], { task: 'T1' });
    evidence(verify.json);
    assert.equal(verify.code, 0, `verify --task T1: ${verify.stdout} ${verify.stderr}`);
    assert.equal(verify.json.result.readiness, 'verified');
    const contract = verify.json.result.checks.find((check) => check.checkId === 'contract');
    assert.equal(contract.outcome, 'passed');
    assert.equal(contract.fresh, true);
    const done = await taskOf(client, 'T1');
    assert.equal(done.task.state, 'verified');
    assert.deepEqual(done.receipts.map(({ checkId, outcome, fresh }) => ({ checkId, outcome, fresh })), [{ checkId: 'contract', outcome: 'passed', fresh: true }]);
    assert.equal(done.receipts[0].receiptId, contract.receiptId);
  });

  await then('the final report shows the actual model, the verification and the cost basis', async () => {
    const report = await taskOf(client, 'T1');
    evidence(report);
    assert.equal(report.task.state, 'verified');
    assert.equal(report.worker.status, 'completed');
    assert.equal(report.worker.requestedModel, MODEL);
    assert.equal(report.worker.actualModel, MODEL, 'the observed model is not reported');
    assert.equal(report.worker.costBasis, 'reported');
    assert.equal(report.worker.costMicroUsd, 40_000);
    assert.equal(typeof report.worker.durationMs, 'number');
  });

  await then('missing evidence leaves the task waiting and is never guessed complete', async () => {
    // A second change whose worker produced nothing that satisfies the response contract.
    const second = box.write('work/plan-2.json', { tasks: [node('T2', { title: 'Add email to the admin response', rootBudgetId: 'sprint-2' })] });
    const submitted = box.jevris(['plan', '--submit', '--graph', second, '--budget', 'sprint-2', '--limit-micro-usd', '2000000', '--authorization', box.authorizeBudget('sprint-2'), '--yes'], { json: true });
    assert.equal(submitted.json?.leaseIds?.length, 1, `T2 was not leased: ${submitted.stdout}`);
    assert.equal((await taskOf(client, 'T2', 'awaiting-evidence'))?.task?.state, 'awaiting-evidence');
    const verify = await verifySettled(box, ['--task', 'T2'], { task: 'T2' });
    evidence(verify.json);
    assert.equal(verify.code, 1, 'an unmet contract verified');
    assert.equal(verify.json.result.readiness, 'not-verified');
    assert.deepEqual(verify.json.result.missing, ['contract']);
    const t2 = await taskOf(client, 'T2');
    assert.equal(t2.task.state, 'awaiting-evidence');
    assert.equal(t2.receipts[0].outcome, 'failed');
    // The other task's evidence is its own: T1 stays verified.
    const t1 = await taskOf(client, 'T1');
    assert.equal(t1.task.state, 'verified');
    assert.equal(t1.receipts[0].fresh, true);
  });
});

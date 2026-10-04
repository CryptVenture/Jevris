import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { workflow } from './lib.mjs';
import { ownedWorkers } from './owned.mjs';
import { verifySettled } from './verify-run.mjs';

// W02: a test keeps failing with the same diagnostic after repeated edits. The workers are D's
// scripted worker port (test mode plus the sandbox's test-home marker); the loop detection, the
// environment check, the bounded escalation to a stronger approved model, the receipts and the
// blocked report are the product's.
const FAILURE = 'AssertionError: expected 5, got -1 at tests/test_parse.py:14';
const REJECTED = 'return x or 0';
const WEAK = 'claude-haiku-4-5';
const STRONG = 'claude-sonnet-4-5';

async function ownedParseTask(sandbox, runs) {
  const box = await sandbox();
  box.write('work/pkg/parse.py', 'def parse(x):\n    return x\n');
  box.write('work/check-parse.mjs', "import { readFileSync } from 'node:fs';\nconst source = readFileSync('pkg/parse.py', 'utf8');\nif (!source.includes('int(x)')) {\n  console.error('" + FAILURE + "');\n  process.exit(1);\n}\n");
  box.write('work/jevris.checks.json', {
    schemaVersion: 'jevris-checks-1',
    checks: [{ id: 'unit', argv: [process.execPath, 'check-parse.mjs'], mandatory: true, resultFormat: 'exit-code', requirementIds: ['PARSE-1'], description: 'the parser tests' }],
  });
  box.gitInit();
  await box.workerScript(runs(box));
  await ownedWorkers(box);
  const plan = box.write('work/plan.json', {
    tasks: [{ id: 'T1', schemaVersion: '1.0', workspaceId: 'parser', revision: 'r1', state: 'proposed', title: 'Fix the parser test', requirementIds: ['PARSE-1'], dependencyIds: [], writeScopes: ['pkg'], acceptanceCheckIds: ['unit'], expectedOutputs: ['patch'], models: [WEAK, STRONG], rootBudgetId: 'fix' }],
  });
  const submitted = box.jevris(['plan', '--submit', '--graph', plan, '--budget', 'fix', '--limit-micro-usd', '3000000', '--authorization', box.authorizeBudget('fix'), '--yes'], { json: true });
  assert.equal(submitted.json?.leaseIds?.length, 1, `no owned worker started: ${submitted.stdout} ${submitted.stderr}`);
  const client = await box.mcp();
  const task = async (until) => {
    let result;
    for (let i = 0; i < 150; i += 1) {
      result = (await client.callTool({ name: 'jevris_get_task', arguments: { taskId: 'T1' } })).structuredContent?.result;
      if (until === undefined || result?.task?.state === until) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return result;
  };
  return { box, task };
}

const repeated = ['--failure', FAILURE, '--failure', FAILURE, '--failure', FAILURE, '--rejected', REJECTED, '--task', 'T1'];

workflow('W02', 'A debugging loop that needs evidence, not a larger model', async ({ then, sandbox, evidence }) => {
  const { box, task } = await ownedParseTask(sandbox, (b) => [
    { writes: [{ path: 'pkg/parse.py', text: 'def parse(x):\n    return x or 0\n' }], status: 'failed', costUsd: 0.01, reason: FAILURE },
    { writes: [{ path: 'pkg/parse.py', text: 'def parse(x):\n    return int(x)\n' }], status: 'completed', costUsd: 0.05, reason: 'parse converts to int', promptTo: join(b.dir, 'escalated-prompt.txt') },
  ]);
  const promptFile = join(box.dir, 'escalated-prompt.txt');
  const first = await task('failed');

  await then('rules detect the repeated diagnostic fingerprint', () => {
    evidence(first);
    assert.equal(first?.task?.state, 'failed', `T1 is ${first?.task?.state}`);
    assert.equal(first.worker.requestedModel, WEAK);
    const advice = box.jevris(['recover', '--failure', FAILURE, '--failure', FAILURE, '--failure', FAILURE], { json: true });
    evidence(advice.json);
    assert.equal(advice.code, 0);
    assert.equal(advice.json.result.classification, 'repeated-failure');
    assert.deepEqual(advice.json.result.signals, { failures: 3, distinctFingerprints: 1, maxRepeat: 3, environmentFailures: 0 });
  });

  await then('an environment failure points to the environment contract, never to a larger model', async () => {
    const advice = box.jevris(['recover', '--env-failure', 'ECONNREFUSED 127.0.0.1:5432', '--env-failure', 'ECONNREFUSED 127.0.0.1:5432', '--task', 'T1'], { json: true });
    evidence(advice.json);
    assert.equal(advice.json.result.classification, 'environment-failure');
    assert.match(advice.json.result.advice, /environment/);
    assert.match(advice.json.result.advice, /An environment failure is not escalated\./);
    const after = await task();
    assert.equal(after.task.state, 'failed', 'an environment failure changed the task');
    assert.equal(after.worker.requestedModel, WEAK, 'an environment failure launched another worker');
    assert.equal(existsSync(promptFile), false);
  });

  await then('a qualified stronger worker receives the compact history of failures and rejected patches', async () => {
    const advice = box.jevris(['recover', ...repeated], { json: true });
    evidence(advice.json);
    assert.equal(advice.json.result.action, 'route-stronger-worker');
    assert.match(advice.json.result.advice, /One escalation recorded\. Success requires a new current receipt\./);
    assert.match(advice.json.result.advice, new RegExp(`A stronger owned worker was launched once with the compact history\\. \\(${STRONG}\\)`));
    const relaunched = await task('awaiting-evidence');
    evidence(relaunched);
    assert.equal(relaunched.worker.requestedModel, STRONG);
    assert.equal(relaunched.worker.actualModel, STRONG);
    const prompt = readFileSync(promptFile, 'utf8');
    assert.match(prompt, new RegExp(`^Bounded escalation \\(one attempt\\) after ${WEAK} failed`, 'm'));
    assert.match(prompt, /Observed failures:/);
    assert.equal(prompt.includes(FAILURE), true, 'the stronger worker did not get the failing test');
    assert.match(prompt, /Rejected approaches \(do not repeat\):/);
    assert.equal(prompt.includes(REJECTED), true, 'the stronger worker did not get the rejected patch');
  });

  await then('the stronger worker cannot report success without a new test receipt', async () => {
    const waiting = await task();
    assert.equal(waiting.task.state, 'awaiting-evidence', 'a finished worker counted as success');
    assert.deepEqual(waiting.receipts, []);
    const verify = await verifySettled(box, ['--task', 'T1'], { task: 'T1' });
    evidence(verify.json);
    assert.equal(verify.code, 0, `verify --task T1: ${verify.stdout}`);
    const unit = verify.json.result.checks.find((check) => check.checkId === 'unit');
    assert.equal(unit.outcome, 'passed');
    assert.equal(unit.fresh, true);
    const done = await task();
    assert.equal(done.task.state, 'verified');
    assert.equal(done.receipts[0].receiptId, unit.receiptId);
  });

  await then('without progress after the bounded escalation the task ends blocked with a reproducible report', async () => {
    const stuck = await ownedParseTask(sandbox, () => [{ writes: [{ path: 'pkg/parse.py', text: 'def parse(x):\n    return x or 0\n' }], status: 'failed', costUsd: 0.01, reason: FAILURE }]);
    assert.equal((await stuck.task('failed'))?.task?.state, 'failed');
    const escalated = stuck.box.jevris(['recover', ...repeated], { json: true });
    assert.match(escalated.json.result.advice, /A stronger owned worker was launched once/);
    const blocked = await stuck.task('blocked');
    evidence(blocked);
    assert.equal(blocked.task.state, 'blocked', `after a failed escalation T1 is ${blocked.task.state}`);
    assert.equal(blocked.worker.requestedModel, STRONG);
    assert.equal(blocked.worker.status, 'failed');
    const report = stuck.box.jevris(['recover', ...repeated], { json: true });
    evidence(report.json);
    assert.match(report.json.result.advice, /Blocked report\. A further failure does not escalate again\./);
    assert.deepEqual(report.json.result.rejectedApproaches.slice(0, 1), [REJECTED]);
    const still = await stuck.task();
    assert.equal(still.task.state, 'blocked');
    assert.equal(still.worker.requestedModel, STRONG, 'a further failure launched another worker');
  });
});

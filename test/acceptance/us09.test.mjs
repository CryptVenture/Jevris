import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { story } from './lib.mjs';
import { ownedWorkers, submit, taskNode, taskReader } from './owned.mjs';
import { verifySettled } from './verify-run.mjs';

// The same source defect survives the repair budget: the parser still returns the wrong value
// after the weak worker's attempt. The workers are D's scripted worker port.
const DEFECT = 'AssertionError: parse("5") expected 5, got "5" at test/parse.test.mjs:9';
const REJECTED = 'return x || 0';
const WEAK = 'claude-haiku-4-5';
const STRONG = 'claude-sonnet-4-5';
const repeated = ['--failure', DEFECT, '--failure', DEFECT, '--failure', DEFECT, '--rejected', REJECTED, '--task', 'T1'];

story('US09', async ({ then, sandbox, evidence }) => {
  const box = await sandbox();
  box.write('work/lib/parse.mjs', 'export const parse = (x) => x;\n');
  box.write('work/check-parse.mjs', `import { parse } from './lib/parse.mjs';\nif (parse('5') !== 5) {\n  console.error(${JSON.stringify(DEFECT)});\n  process.exit(1);\n}\n`);
  box.write('work/jevris.checks.json', {
    schemaVersion: 'jevris-checks-1',
    checks: [{ id: 'unit', argv: [process.execPath, 'check-parse.mjs'], mandatory: true, resultFormat: 'exit-code', requirementIds: ['PARSE-1'], description: 'the parser tests' }],
  });
  box.gitInit();
  const prompt = join(box.dir, 'escalated-prompt.txt');
  await box.workerScript([
    { writes: [{ path: 'lib/parse.mjs', text: `export const parse = (x) => { ${REJECTED}; };\n` }], status: 'failed', costUsd: 0.01, reason: DEFECT },
    { writes: [{ path: 'lib/parse.mjs', text: 'export const parse = (x) => x.trim();\n' }], status: 'failed', costUsd: 0.05, reason: DEFECT, promptTo: prompt },
  ]);
  await ownedWorkers(box);
  submit(box, [taskNode('T1', { title: 'Fix the parser', requirementIds: ['PARSE-1'], writeScopes: ['lib'], models: [WEAK, STRONG] })]);
  const task = taskReader(await box.mcp());
  assert.equal((await task('T1', 'failed'))?.task?.state, 'failed', 'the first worker did not fail');
  // The defect is verified by the runner, not only reported by the worker.
  const verify = await verifySettled(box, ['--check', 'unit'], { checks: ['unit'] });
  assert.equal(verify.json.result.checks[0].outcome, 'failed');

  await then('One bounded escalation receives the rejected approaches and evidence', async () => {
    const advice = box.jevris(['recover', ...repeated], { json: true });
    evidence(advice.json);
    assert.equal(advice.json.result.classification, 'repeated-failure');
    assert.equal(advice.json.result.action, 'route-stronger-worker');
    assert.match(advice.json.result.advice, new RegExp(`A stronger owned worker was launched once with the compact history\\. \\(${STRONG}\\)`));
    const blocked = await task('T1', 'blocked');
    evidence(blocked);
    assert.equal(blocked.worker.requestedModel, STRONG);
    const text = readFileSync(prompt, 'utf8');
    evidence(text);
    assert.match(text, new RegExp(`^Bounded escalation \\(one attempt\\) after ${WEAK} failed`, 'm'));
    assert.match(text, /Observed failures:/);
    assert.equal(text.includes(DEFECT), true, 'the stronger worker did not get the failing evidence');
    assert.match(text, /Rejected approaches \(do not repeat\):/);
    assert.equal(text.includes(REJECTED), true, 'the stronger worker did not get the rejected approach');
  });

  await then('further failure ends in a blocked report', async () => {
    const blocked = await task('T1');
    assert.equal(blocked.task.state, 'blocked', `after the failed escalation T1 is ${blocked.task.state}`);
    assert.equal(blocked.worker.status, 'failed');
    const report = box.jevris(['recover', ...repeated], { json: true });
    evidence(report.json);
    assert.match(report.json.result.advice, /Blocked report\. A further failure does not escalate again\./);
    assert.deepEqual(report.json.result.rejectedApproaches.slice(0, 1), [REJECTED]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const still = await task('T1');
    assert.equal(still.task.state, 'blocked');
    assert.equal(still.worker.requestedModel, STRONG, 'a third worker was launched');
  });
});

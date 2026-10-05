import assert from 'node:assert/strict';
import { story } from './lib.mjs';
import { verifySettled } from './verify-run.mjs';

// US38: a COBOL batch project that no certified analyzer covers. Asking Jevris to optimize a
// task gives generic advice (plan, route, recovery) and a checkpoint; verification stays
// unsupported, with nothing invented, until the developer supplies and approves a runner
// manifest.
story('US38', async ({ then, sandbox, evidence }) => {
  const box = await sandbox();
  assert.equal(box.startSidecar().code, 0, 'sidecar did not start');
  box.write('work/src/PAYROLL.cbl', '       IDENTIFICATION DIVISION.\n       PROGRAM-ID. PAYROLL.\n       PROCEDURE DIVISION.\n           STOP RUN.\n');
  box.write('work/jcl/NIGHTLY.jcl', '//NIGHTLY JOB (ACCT),CLASS=A\n//STEP1 EXEC PGM=PAYROLL\n');
  const client = await box.mcp();
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;

  await then('Generic advice/checkpointing works, but verification remains unsupported until I supply an approved runner manifest', async () => {
    // No certified analyzer: the profile proposes nothing.
    const profile = box.jevris(['verify', 'profile'], { json: true });
    evidence(profile.json);
    assert.equal(profile.code, 1, `verify profile: ${profile.stdout} ${profile.stderr}`);
    assert.deepEqual(profile.json.proposal.checks, [], 'an uncertified project got proposed checks');

    // "Optimize this task": generic advice works.
    const node = (id, dependencyIds, writeScopes) => ({ id, schemaVersion: '1.0', workspaceId: 'payroll', revision: 'r1', state: 'proposed', requirementIds: ['PAY-1'], dependencyIds, writeScopes, acceptanceCheckIds: ['batch'], rootBudgetId: 'budget-1' });
    const graph = box.write('work/tasks.json', [node('split-io', [], ['src/PAYROLL.cbl']), node('tune-jcl', ['split-io'], ['jcl/NIGHTLY.jcl'])]);
    const plan = box.jevris(['plan', '--graph', graph], { json: true });
    evidence(plan.json);
    assert.equal(plan.code, 0, `plan failed: ${plan.stdout} ${plan.stderr}`);
    assert.equal(plan.json.result.valid, true);
    assert.equal(JSON.stringify(plan.json.result).includes('split-io'), true, 'the plan does not name the ready task');
    const route = box.jevris(['route', '--model', 'claude-opus-5'], { json: true });
    assert.equal(route.code, 0, `route failed: ${route.stdout} ${route.stderr}`);
    assert.equal(route.json.result.applied, false);
    const recover = await call('jevris_recover', { fingerprints: ['IGYPS2121-S PAYROLL not defined', 'IGYPS2121-S PAYROLL not defined'] });
    evidence(recover);
    assert.equal(typeof recover.result.advice, 'string');
    assert.equal(recover.result.advice.length > 0, true, 'no recovery advice');
    const checkpoint = box.jevris(['checkpoint', '--objective', 'Speed up the nightly payroll batch', '--constraint', 'Keep the record layout unchanged'], { json: true });
    evidence(checkpoint.json);
    assert.equal(checkpoint.code, 0, `checkpoint failed: ${checkpoint.stdout} ${checkpoint.stderr}`);
    assert.equal(checkpoint.json.result.written, true);
    assert.equal(checkpoint.json.result.retained.constraints, 1);

    // Verification is unsupported, and nothing claims otherwise: CLI, MCP and approve.
    const cli = box.jevris(['verify'], { json: true });
    evidence(cli.json);
    assert.equal(cli.code, 1, `verify claimed success: ${cli.stdout}`);
    assert.equal(cli.json.result.ran, false);
    assert.notEqual(cli.json.result.readiness, 'verified');
    assert.deepEqual(cli.json.result.checks, [], 'checks were invented');
    const mcp = await call('jevris_verify', {});
    assert.notEqual(mcp.result.readiness, 'verified');
    assert.deepEqual(mcp.result.checks, []);
    const nothing = box.jevris(['verify', 'approve'], { json: true });
    assert.equal(nothing.code, 1, `approve without a manifest: ${nothing.stdout}`);
    const record = await client.callTool({ name: 'jevris_record_verification', arguments: { receiptId: 'rcpt-made-up-by-the-model', checkId: 'batch' } });
    assert.equal(record.structuredContent?.result?.accepted, false, `a made-up receipt was not refused: ${JSON.stringify(record)}`);

    // The developer supplies and approves a runner manifest: now it verifies, through the runner.
    box.write('work/jevris.checks.json', {
      schemaVersion: 'jevris-checks-1',
      checks: [{ id: 'batch', argv: [process.execPath, '-e', "process.stdout.write('PAYROLL RC=0\\n')"], mandatory: true, resultFormat: 'exit-code', description: 'compile and run the payroll batch in the test region' }],
    });
    // A person approves it at a terminal (SR-1); the sandbox records it as the CLI does.
    const approve = await box.approveChecks();
    assert.equal(approve.code, 0, `verify approve failed: ${approve.reason}`);
    const run = await verifySettled(box, ['--check', 'batch'], { checks: ['batch'] });
    evidence(run.json);
    assert.equal(run.code, 0, `verify failed: ${run.stdout} ${run.stderr}`);
    // `ran` is not asserted: it says whether the run ended inside the command's answer window, and a loaded host's run ends after it, with its
    // receipt already written and the answer already reading it as verified (`ran: false`, nothing running; verify-run.mjs). What proves the
    // check went through the runner is the receipt: the manifest was approved a moment ago, nothing else has run it, and a runner receipt is
    // `rcpt-` (an imported CI receipt is `rcpt-ci-`).
    assert.equal(run.json.result.readiness, 'verified');
    assert.equal(run.json.result.checks[0].outcome, 'passed');
    assert.equal(run.json.result.checks[0].fresh, true);
    assert.match(run.json.result.checks[0].receiptId, /^rcpt-(?!ci-)/);
  });
});

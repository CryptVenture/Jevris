import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { story } from './lib.mjs';

function git(cwd, ...args) {
  const run = spawnSync('git', ['-c', 'user.email=ci@example.invalid', '-c', 'user.name=ci', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
}

/** check id -> status line of a `verify required --json` result. */
function required(box, ids) {
  const out = box.jevris(['verify', 'required', ...ids], { json: true });
  assert.notEqual(out.json, null, `verify required printed no JSON: ${out.stdout} ${out.stderr}`);
  return Object.fromEntries(out.json.checks.map((line) => [line.checkId, line.status]));
}

story('US17', async ({ then, sandbox, evidence }) => {
  const box = await sandbox();
  const up = box.startSidecar();
  assert.equal(up.code, 0, `sidecar start failed: ${up.stdout} ${up.stderr}`);
  // Two approved mandatory checks, each scoped to the sources it verifies.
  box.write('work/lib/a.js', 'export const a = 1;\n');
  box.write('work/docs/guide.md', '# Guide\n');
  box.write('work/jevris.checks.json', {
    schemaVersion: 'jevris-checks-1',
    checks: [
      { id: 'unit', argv: [process.execPath, '-e', '0'], mandatory: true, resultFormat: 'exit-code', inputScopes: ['lib'], description: 'unit tests over lib' },
      { id: 'docs', argv: [process.execPath, '-e', '0'], mandatory: true, resultFormat: 'exit-code', inputScopes: ['docs'], description: 'docs build' },
    ],
  });
  spawnSync(process.execPath, ['-e', `require('node:fs').rmSync(${JSON.stringify(join(box.work, '.git'))}, { recursive: true, force: true })`]);
  git(box.work, 'init', '-q');
  git(box.work, 'config', 'core.autocrlf', 'false');
  git(box.work, 'add', '.');
  git(box.work, 'commit', '-q', '-m', 'revision A');
  const approve = await box.approveChecks();
  assert.equal(approve.code, 0, `verify approve failed: ${approve.reason}`);

  // Given: all required checks passed on revision A.
  // A loaded host can answer before the run ends (the answer lists what is still running, or on a
  // late status says nothing settled); running `jevris verify` again joins the run, as documented.
  let onA = box.jevris(['verify', '--check', 'unit', '--check', 'docs'], { json: true });
  for (let again = 0; again < 4 && onA.json?.result?.readiness !== 'verified'; again += 1) {
    onA = box.jevris(['verify', '--check', 'unit', '--check', 'docs'], { json: true });
  }
  evidence(onA.json);
  assert.equal(onA.code, 0, `verify on A failed: ${onA.stdout} ${onA.stderr}`);
  assert.equal(onA.json.result.readiness, 'verified', `A is not verified: ${onA.stdout}`);
  const receiptsA = Object.fromEntries(onA.json.result.checks.map((c) => [c.checkId, c.receiptId]));

  // When: the source changes to revision B (lib only).
  box.write('work/lib/a.js', 'export const a = 2;\n');
  git(box.work, 'commit', '-q', '-am', 'revision B');

  await then('Affected receipts become stale and completion waits for the required checks on B', async () => {
    // The readiness report on B no longer counts the lib receipt from A.
    const report = required(box, ['unit', 'docs']);
    evidence(report);
    assert.notEqual(report.unit, 'passed', `verify required still counts unit's receipt from revision A as passed on B: ${JSON.stringify(report)}`);
    const lines = box.jevris(['verify', 'required', 'unit', 'docs'], { json: true }).json.checks;
    assert.equal(lines.find((line) => line.checkId === 'unit').stale, true, `the unit line does not say its receipt went stale: ${JSON.stringify(lines)}`);
    assert.equal(lines.find((line) => line.checkId === 'docs').stale, false);
    assert.match(box.jevris(['verify', 'required', 'unit', 'docs']).stdout, /^unit: missing \(its receipt is stale: run it again\)$/m);
    assert.equal(report.docs, 'passed', `an unaffected receipt was dropped: ${JSON.stringify(report)}`);

    // The worker's status view (MCP, read-only) names the stale receipt and does not complete.
    const client = await box.mcp();
    const status = await client.callTool({ name: 'jevris_verify', arguments: { checkIds: ['unit', 'docs'] } });
    evidence(status.structuredContent);
    const view = status.structuredContent.result;
    assert.equal(view.ran, false);
    assert.equal(view.readiness, 'not-verified', `completion did not wait on B: ${JSON.stringify(view)}`);
    const byId = Object.fromEntries(view.checks.map((c) => [c.checkId, c]));
    assert.equal(byId.unit.receiptId, receiptsA.unit, 'the stale line does not name the receipt from A');
    assert.equal(byId.unit.fresh, false);
    assert.equal(byId.unit.reasonCode, 'STALE');
    assert.equal(byId.docs.fresh, true, `the docs receipt is not affected by a lib change: ${JSON.stringify(byId.docs)}`);
    assert.deepEqual(view.missing, ['unit']);

    // Completion follows only once the required check has run on B.
    const onB = box.jevris(['verify', '--check', 'unit'], { json: true });
    evidence(onB.json);
    assert.equal(onB.code, 0, `verify on B failed: ${onB.stdout} ${onB.stderr}`);
    const after = await client.callTool({ name: 'jevris_verify', arguments: { checkIds: ['unit', 'docs'] } });
    assert.equal(after.structuredContent.result.readiness, 'verified', `B is not verified after its checks ran: ${JSON.stringify(after.structuredContent.result)}`);
    const fresh = Object.fromEntries(after.structuredContent.result.checks.map((c) => [c.checkId, c.receiptId]));
    assert.notEqual(fresh.unit, receiptsA.unit, 'completion on B reused the receipt from A');
    assert.equal(required(box, ['unit', 'docs']).unit, 'passed');
  });
});

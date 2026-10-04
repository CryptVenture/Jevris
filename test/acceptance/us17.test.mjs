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

/**
 * Runs `jevris verify` for `run` once, waits until the sidecar has no verification run under way,
 * and returns the first answer and the read-only status of `view` read after that.
 *
 * `jevris verify` starts a run and answers inside a fixed window of the request, so on a slow host
 * (Windows, a loaded runner) the answer comes before the run ends. Asking again once that run has
 * ended does not read its result: it starts a second run, whose receipts land after the answer
 * and replace the ones a test has just noted as the latest (CI run 37159176084, Windows: the stale
 * line named the second run's receipt, and the answer named the first's). A run that is still
 * ending also answers a status "verified" a moment before the run itself is over, and a view read
 * then can say RUNNING where the test expects STALE. So nothing is asked again while a run is under
 * way (the sidecar's health says how many), the status is read once none is, and `verify` is asked
 * again only when no run is under way and the checks are still not verified (the request never
 * arrived), at most three times.
 */
async function verifiedAfterRun(box, client, { run, view }) {
  const args = ['verify', ...run.flatMap((id) => ['--check', id])];
  const receiptsOf = (result) => Object.fromEntries(result.checks.map((check) => [check.checkId, check.receiptId]));
  const runsUnderWay = () => box.jevris(['sidecar', 'status'], { json: true }).json?.verificationRuns;
  const first = box.jevris(args, { json: true });
  const giveUpAt = Date.now() + 120_000;
  let asked = 0;
  for (;;) {
    const runs = runsUnderWay();
    assert.ok(Date.now() < giveUpAt, `a verification run was still under way (${String(runs)}) or the checks were not verified in time`);
    if (runs !== 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    const status = (await client.callTool({ name: 'jevris_verify', arguments: { checkIds: view } })).structuredContent.result;
    if (status.readiness === 'verified') {
      // A first answer that already says verified is the command's own report of these receipts.
      if (first.json?.result?.readiness === 'verified') {
        assert.equal(first.code, 0, `verify answered verified with exit ${String(first.code)}: ${first.stdout} ${first.stderr}`);
        assert.deepEqual(receiptsOf(first.json.result), receiptsOf(status), 'the command and the status name different receipts');
      }
      return { first, status };
    }
    // No run is under way, every check has a receipt and the status is still not verified: a run is not what it waits for.
    assert.equal(status.checks.every((check) => check.fresh), false, `the checks have receipts and are not verified: ${JSON.stringify(status)}`);
    asked += 1;
    assert.ok(asked <= 3, `no run is under way and the checks are still not verified: ${JSON.stringify(status)}`);
    box.jevris(args, { json: true });
  }
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
  const client = await box.mcp();
  const onA = await verifiedAfterRun(box, client, { run: ['unit', 'docs'], view: ['unit', 'docs'] });
  evidence(onA.status);
  assert.equal(onA.status.readiness, 'verified', `A is not verified: ${JSON.stringify(onA.status)}`);
  assert.equal(onA.status.ran, false, 'the status is read-only');
  const receiptsA = Object.fromEntries(onA.status.checks.map((c) => [c.checkId, c.receiptId]));
  assert.equal(Object.values(receiptsA).every((id) => typeof id === 'string'), true, `a check on A has no receipt: ${JSON.stringify(receiptsA)}`);

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
    const onB = await verifiedAfterRun(box, client, { run: ['unit'], view: ['unit', 'docs'] });
    evidence(onB.status);
    const after = onB.status;
    assert.equal(after.readiness, 'verified', `B is not verified after its checks ran: ${JSON.stringify(after)}`);
    const fresh = Object.fromEntries(after.checks.map((c) => [c.checkId, c.receiptId]));
    assert.notEqual(fresh.unit, receiptsA.unit, 'completion on B reused the receipt from A');
    assert.equal(required(box, ['unit', 'docs']).unit, 'passed');
  });
});

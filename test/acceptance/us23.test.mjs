import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { story } from './lib.mjs';
import { certifyHooks, deliverHook } from './certified-hooks.mjs';

// The required database check cannot run on this machine (its runner is not installed), and the
// agent keeps trying to finish. Each stop is a real Claude Code Stop delivery through the hook
// launcher to the sidecar.
const REMINDER = /^Missing verification evidence: db:not-run\. .*Run the declared checks \(jevris verify\) before finishing\.$/;
const UNVERIFIED = /^Unverified: the work ends without current passing receipts for db:not-run\. .*It is labelled unverified\.$/;

/** Null when the harness answer lets the stop through; otherwise what would continue the turn. */
function continuation(stdout) {
  if (stdout.trim() === '') return null;
  const body = JSON.parse(stdout);
  if (body.decision !== undefined && body.decision !== 'approve') return `decision ${String(body.decision)}`;
  if (body.continue === false) return 'continue false';
  if (body.reason !== undefined) return 'reason';
  if (body.hookSpecificOutput?.additionalContext !== undefined) return 'additionalContext';
  return null;
}

story('US23', async ({ then, sandbox, evidence }) => {
  const box = await sandbox();
  box.write('work/lib/store.mjs', 'export const rows = [];\n');
  box.write('work/jevris.checks.json', {
    schemaVersion: 'jevris-checks-1',
    checks: [{ id: 'db', argv: ['jevris-acceptance-missing-db-runner', 'test'], mandatory: true, resultFormat: 'exit-code', requirementIds: ['DB-1'], description: 'the database tests' }],
  });
  box.gitInit();
  assert.equal((await box.approveChecks()).code, 0, 'verify approve failed');
  assert.equal(box.startSidecar().code, 0, 'the sidecar did not start');
  await certifyHooks(box);
  const ran = box.jevris(['verify', '--check', 'db'], { json: true });
  assert.equal(ran.json.result.checks[0].outcome, 'not-run', 'the check was expected to be unavailable');
  const transcript = join(box.dir, 's-us23.jsonl');
  writeFileSync(transcript, '');
  const stop = (active) => {
    appendFileSync(transcript, `{"type":"assistant","text":"Done. Stopping (${String(active)})."}\n`);
    return deliverHook(box, 'claude', { session_id: 's-us23', transcript_path: transcript, cwd: box.work, hook_event_name: 'Stop', stop_hook_active: active });
  };
  const message = (out) => JSON.parse(out.stdout).systemMessage;

  // The first stop gets the one reminder, and (VER-05) the one capped continuation: Claude Code's
  // hooks are certified here, so the Stop blocks once with the missing evidence ids as its reason.
  const first = stop(false);
  evidence(first.stdout);
  assert.match(message(first), REMINDER);
  assert.equal(continuation(first.stdout), 'decision block', `the first stop was not continued once: ${first.stdout}`);
  assert.equal(JSON.parse(first.stdout).reason, 'Jevris: verification evidence is missing: db. Run the declared checks (jevris verify) before finishing.');

  await then('Jevris ends with an explicit unverified report instead of issuing an indefinite continuation loop', () => {
    // The agent stops again under the same condition: the explicit unverified report, no block.
    const second = stop(true);
    evidence(second.stdout);
    assert.match(message(second), UNVERIFIED);
    assert.equal(continuation(second.stdout), null, `the second stop was continued: ${second.stdout}`);
    // And again, even without stop_hook_active: the reminder is not repeated.
    const third = stop(false);
    assert.match(message(third), UNVERIFIED, 'a second reminder fired for the same condition');
    assert.equal(continuation(third.stdout), null);
    // The report is kept where a person reads it: the verify answer carries it while the work
    // is still not verified.
    const verify = box.jevris(['verify', '--check', 'db'], { json: true });
    evidence(verify.json);
    const report = verify.json.result?.stopReport;
    assert.equal(report?.outcome, 'unverified', `verify: ${verify.stdout}`);
    assert.match(report.text, UNVERIFIED);
    assert.deepEqual(report.missingEvidence, ['db']);
  });
});

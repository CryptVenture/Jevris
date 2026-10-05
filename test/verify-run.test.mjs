import test from 'node:test';
import assert from 'node:assert/strict';
import { answerSettled, verifySettled } from './acceptance/verify-run.mjs';

// The acceptance helper that reads a story's verification result (test/acceptance/verify-run.mjs), against a scripted sandbox: no sidecar, no process.
// `jevris verify` answers inside a window of its request and the run goes on after it, so a slow host's answer is not always the result. Three shapes of
// answer are not final although they name no check as running or queued, and a run ends after the answer that lists its receipts.

const check = (reasonCode, extra = {}) => ({ checkId: 'unit', mandatory: true, outcome: 'passed', receiptId: 'rcpt-1', fresh: true, reasonCode, environment: null, ...extra });
const answer = (checks, extra = {}) => ({ json: { result: { ran: true, readiness: 'verified', checks, missing: [], ...extra } } });

/** A sandbox that answers `verify` with `first`, reports `runs` verification runs under way one status read after another, and gives `status` for the read-only tool. */
function scriptedBox({ first, runs, status }) {
  const calls = [];
  const remaining = [...runs];
  return {
    calls,
    jevris(argv) {
      calls.push(argv.slice(0, 2).join(' '));
      if (argv[0] === 'verify') return { code: first.json.result.readiness === 'verified' ? 0 : 1, stdout: '', stderr: '', json: first.json };
      if (argv[0] === 'sidecar' && argv[1] === 'status') return { code: 0, stdout: '', stderr: '', json: { verificationRuns: remaining.length > 1 ? remaining.shift() : (remaining[0] ?? 0) } };
      throw new Error(`unexpected command ${argv.join(' ')}`);
    },
    async mcp() {
      return {
        async callTool({ name }) {
          calls.push(`mcp ${name}`);
          return { structuredContent: { result: status } };
        },
      };
    },
  };
}

test('an answer is final only when no check is running, queued or STALE: a status read that missed the window lists the approved checks STALE beside ran: true', () => {
  assert.equal(answerSettled(answer([check(null)])), true);
  assert.equal(answerSettled(answer([check('EXIT_NONZERO', { outcome: 'failed' })])), true, 'a failed check is a final outcome');
  assert.equal(answerSettled(answer([])), true, 'a project with no approved check has nothing to wait for');
  for (const reasonCode of ['RUNNING', 'QUEUED', 'STALE']) assert.equal(answerSettled(answer([check(null), check(reasonCode, { checkId: 'lint', fresh: false })])), false, reasonCode);
  assert.equal(answerSettled({ json: null }), false, 'no JSON is no answer');
});

test('a STALE answer is read again through the read-only status once no run is under way, and its result is the settled one (W04, verify --task A)', async () => {
  const stale = answer([check('STALE', { fresh: false })], { readiness: 'not-verified', missing: ['unit'] });
  const settled = { ran: false, readiness: 'verified', checks: [check(null)], missing: [] };
  const box = scriptedBox({ first: stale, runs: [1, 0], status: settled });
  const run = await verifySettled(box, ['--task', 'A'], { task: 'A' });
  assert.deepEqual(box.calls, ['verify --task', 'sidecar status', 'sidecar status', 'mcp jevris_verify']);
  assert.equal(run.settled, false);
  assert.equal(run.code, 0);
  assert.deepEqual(run.json.result, settled);
  assert.deepEqual(run.first.json.result, stale.json.result, 'the command\'s own answer stays on `first`');
});

test('a final answer is returned after the run has ended too: the run moves the task to verified and leases the next wave after the answer that lists its receipts (W04, integrate D)', async () => {
  const first = answer([check(null)]);
  const box = scriptedBox({ first, runs: [2, 1, 0], status: null });
  const run = await verifySettled(box, ['--task', 'D'], { task: 'D' });
  assert.deepEqual(box.calls, ['verify --task', 'sidecar status', 'sidecar status', 'sidecar status'], 'asked once, then waited for the sidecar to have no run under way; no status tool call');
  assert.equal(run.settled, true);
  assert.equal(run.code, 0);
  assert.deepEqual(run.json.result, first.json.result);
});

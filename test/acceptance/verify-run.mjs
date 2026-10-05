/**
 * `jevris verify` for a story that needs the checks' final outcomes.
 *
 * `jevris verify` starts a run in the sidecar and answers inside a fixed window of the request (40%
 * of the CLI's 5 s; docs/verification.md). A check that has not finished by then is listed as
 * running or queued (`RUNNING`, `QUEUED`), so on a slow host (a Windows runner starts a process in
 * seconds) the first answer is a still-running answer, and a story that read a check's outcome, its
 * receipt or the task's receipts from it failed there and nowhere else.
 *
 * Asking again is not the way to read the result: with no run under way it starts a second run,
 * whose receipts land after the answer and replace the ones the story has just noted (the US17
 * failure of CI run 37159176084). So:
 *
 * - the command is asked once;
 * - the story then waits until the sidecar says no verification run is under way
 *   (`jevris sidecar status`, `verificationRuns` 0). A run ends after the answer that lists its
 *   checks: its receipts are in, but a task's run still has its state to move to verified and the
 *   next wave to lease, and a story that reads the task or integrates right after the answer found
 *   `verifying` or `TASK_NOT_VERIFIED` on a slow host (W04);
 * - when the answer already holds every check's outcome (none running, queued or stale), that
 *   answer is the answer, exactly as before;
 * - otherwise the story reads the same checks through the read-only status tool (`jevris_verify`),
 *   which has the shape of a verify answer and runs nothing.
 *
 * The result is shaped like a `box.jevris(..., { json: true })` result, so a story's assertions on
 * `result.json.result.checks`, `.readiness`, `.missing` and the exit `code` stay as they were:
 * `json.result` is the settled payload, and `code` is the exit code the command gives that payload
 * (1 unless it is verified, the same rule the CLI applies). What describes the run itself stays on
 * `first` (the command's own answer: `first.json.result.ran`, `first.json.summary`, `first.stdout`).
 * `settled` says whether the first answer was already final.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './lib.mjs';

/** The longest the story waits for a run to end. */
const RUN_BOUND_MS = 120_000;

/**
 * Whether a verify answer already holds the final outcome of every check it lists. A check listed
 * as STALE is not final either: when even the status read after the run missed the answer window,
 * the answer lists the approved checks from their last receipts, shown as STALE "since their
 * freshness was not confirmed" (docs/verification.md), beside `ran: true` and the receipt the run
 * has just written (the W04 failure of the slow-host gate: `verify --task A` answered
 * not-verified with the passing receipt STALE, while the task went on to be verified).
 */
export function answerSettled(answer) {
  const checks = answer.json?.result?.checks;
  return Array.isArray(checks) && checks.every((check) => check.reasonCode !== 'RUNNING' && check.reasonCode !== 'QUEUED' && check.reasonCode !== 'STALE');
}

/** Waits until the sandbox's sidecar reports no verification run under way. */
export async function runsEnded(box) {
  const giveUpAt = Date.now() + RUN_BOUND_MS;
  for (;;) {
    const runs = box.jevris(['sidecar', 'status'], { json: true }).json?.verificationRuns;
    if (runs === 0) return;
    assert.ok(Date.now() < giveUpAt, `a verification run was still under way (${String(runs)}) after ${RUN_BOUND_MS} ms`);
    await sleep(100);
  }
}

const clients = new WeakMap();

/** One read-only MCP client per sandbox, closed with it. */
async function statusClient(box) {
  let client = clients.get(box);
  if (client === undefined) {
    client = await box.mcp();
    clients.set(box, client);
  }
  return client;
}

/**
 * Runs `jevris verify <args>` once and gives its settled answer. `checks` or `task` name what the
 * read-only status reads when the first answer came before the run ended (the same ids the command
 * was given: `--check` ids, or the `--task` id).
 */
export async function verifySettled(box, args, { checks, task } = {}) {
  const first = box.jevris(['verify', ...args], { json: true });
  await runsEnded(box);
  if (answerSettled(first)) return { ...first, first, settled: true };
  const client = await statusClient(box);
  const input = task !== undefined ? { taskId: task } : checks !== undefined ? { checkIds: checks } : {};
  const status = (await client.callTool({ name: 'jevris_verify', arguments: input })).structuredContent?.result;
  assert.notEqual(status, undefined, 'the read-only verify status answered nothing');
  assert.equal(status.ran, false, 'the status is read-only: it ran nothing');
  return {
    ...first,
    code: status.readiness === 'verified' ? 0 : 1,
    json: { ...(first.json ?? {}), result: status },
    first,
    settled: false,
  };
}

/**
 * The summary and the plain-text report the CLI gives a settled answer, rendered from `run.json.result`
 * by the CLI's own renderer. A story that asserts what the report says (not that the command printed
 * it) uses this, because a second `jevris verify` for the text would start a second run and answer
 * before it ends on a slow host, just as the first did. For an answer that was already settled, the
 * command's own summary is that renderer's output (`run.json.summary`), which a story can check too.
 */
export async function renderVerify(run) {
  assert.notEqual(run.first.json, null, `verify printed no JSON: ${run.first.stdout} ${run.first.stderr}`);
  const render = await import(pathToFileURL(join(repoRoot, 'apps', 'cli', 'dist', 'public', 'render.js')).href);
  const summary = render.summaryFor('verify', run.json.result, run.first.json.mode ?? 'full');
  return { summary, text: render.renderHuman({ ...run.first.json, result: run.json.result, summary }) };
}

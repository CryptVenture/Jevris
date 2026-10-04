/**
 * Asking a real, spawned sidecar from a test or from the offline feature driver.
 *
 * A spawned sidecar keeps the product's op budgets (900 ms hot, 5 s background; `SIDECAR_BUDGET_MS`), and a
 * test cannot raise them. On a slow, loaded host (the Windows CI cells: a journal, budget or circuit write that
 * waits seconds on a scanner or a flush) an op can pass its budget, and the sidecar then correctly answers
 * `DEADLINE`: the call was cut short and ran rules-only. A test of a Jev decision asserts what was asked and what
 * was sent, not the budget, so a slow host turned a correct product into a red test.
 *
 * `askSidecar` makes the decision a test would make by hand: the op was cut short, so ask again. Only a cut-short
 * answer is retried (`DEADLINE`, or a client-side timeout); any other refusal, and any answer, is returned at once.
 * Before it asks again it waits until the sidecar has finished the abandoned work of the cut-short attempt
 * (`waitUntilQuiet`): the sidecar lets that work run on (it holds an overrun slot), and a retry that started beside
 * it would queue behind its writes and meet the budget file's 2 s lock timeout instead of an idle sidecar. The wait
 * is on the sidecar's own state, not on a fixed sleep. After a bounded number of attempts the last answer is
 * returned, so a product that really cannot answer in time still fails the test, with its own reason code.
 *
 * Mind what a retry repeats. The late first attempt may already have written (a capsule, a decision record) or
 * sent a request to Jev, and the answer of a cut-short decision is not kept, so the retry may ask Jev again; or the
 * late attempt may have finished its decision after all, and the retry is then answered from the decision cache
 * (`CACHE_HIT`, no request, no usage of its own). A test that counts what happened counts over the whole case (the
 * stub's request count before the first attempt and after the last), asserts a floor or the set of what was sent,
 * and checks every request that was sent, not only the last attempt's. A test whose subject IS the deadline (an
 * abandoned call, a loop that stops asking when time is short) keeps its single attempt and calls
 * `sidecar.sidecarRequest` itself. An op that cannot be asked twice is not retried (`NOT_REPEATED_OPS`).
 *
 * The same slowness also moves work behind an answer, or makes a handler skip its consult for lack of time. A hook
 * event's subscriber that does not finish inside the event's slice is queued and runs on after the answer, so what it
 * asks Jev happens later (`waitUntilQuiet` is the wait for that too: a caller that counts the requests of an event
 * reads them after it); and a handler that asks Jev only while enough time is left answers from rules once it is not,
 * or a subscriber whose answer is no longer wanted does not ask at all. A caller that needs the consult to have happened
 * passes `satisfied`: an answer that came but did not do what the caller needs is asked again like a cut-short one,
 * within the same bound, and a bug that never asks still fails once the bound is reached. A repeated hook `event` is
 * sent with a fresh delivery key (`freshDelivery`), as the harness's next hook would be: the same key would only be
 * answered with the duplicate answer.
 */
import { createHash } from 'node:crypto';

/** Attempts one ask makes at most, the first included. */
export const DEADLINE_ATTEMPTS = 4;

/** How long a wait for the sidecar's own background work lasts at most, in ms (a loaded runner needs seconds). */
export const QUIET_BOUND_MS = 120_000;

/**
 * Ops that are not asked again, with the reason. `plan.submit` records its tasks, and a repeat answers `DUPLICATE_TASK`
 * (`accepted: false`): the plan op also bounds its own Jev wait, so a cut-short answer means the store did not answer,
 * which a second submission would not mend.
 */
export const NOT_REPEATED_OPS = new Set(['plan.submit']);

const POLL_MS = 200;
const READ_TIMEOUT_MS = 30_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The request of attempt `attempt` of a hook `event`: the same event as a fresh delivery. The sidecar answers a repeat of one
 * delivery key with the duplicate answer (the first was aborted, so nothing runs again: the consult would never happen), so the
 * repeat of an event carries a key of its own, in the body and in the envelope's `dedupKey`. A request that is not an event with a
 * delivery key is returned as it is.
 */
export function freshDelivery(request, attempt) {
  const body = request.body;
  if (request.op !== 'event' || body === null || typeof body !== 'object' || typeof body.deliveryKey !== 'string') return request;
  const fresh = (key) => createHash('sha256').update(`${key}#attempt-${String(attempt)}`).digest('hex');
  const envelope = body.envelope !== null && typeof body.envelope === 'object' && typeof body.envelope.dedupKey === 'string' ? { ...body.envelope, dedupKey: fresh(body.envelope.dedupKey) } : body.envelope;
  return { ...request, body: { ...body, deliveryKey: fresh(body.deliveryKey), ...(envelope === undefined ? {} : { envelope }) } };
}

/**
 * Whether the sidecar (or the client) cut the call short: the sidecar's `DEADLINE`, or a client-side timeout
 * (the connect, the handshake or the answer did not arrive in `timeoutMs`). A call the caller cancelled itself
 * (`ABORTED`) is not.
 */
export function cutShort(answer) {
  if (answer === null || typeof answer !== 'object' || answer.ok !== false) return false;
  if (answer.reasonCode === 'DEADLINE') return true;
  return answer.reason === 'timeout' && answer.reasonCode !== 'ABORTED';
}

/** The fields of the status `queue` that count work still to do behind an answer (not the requests being served now). */
const BEHIND_AN_ANSWER = ['overrun', 'running', 'held', 'queued', 'spooled'];

/**
 * Waits until the sidecar has nothing left to do behind an answer: no request answered past its deadline whose work still
 * runs, no background job running, held or queued, nothing spooled (the `queue` of `status`), and no verification run
 * under way (`verificationRuns` of `health`). Returns whether it got there inside `boundMs`; a sidecar that stays busy is
 * asked again anyway, and its own answer decides the test.
 */
export async function waitUntilQuiet(sidecar, request, { boundMs = QUIET_BOUND_MS, pollMs = POLL_MS, pause = sleep, now = Date.now } = {}) {
  const until = now() + boundMs;
  const read = (op) => sidecar.sidecarRequest({ home: request.home, op, scope: 'cli', ...(request.workspace === undefined ? {} : { workspace: request.workspace }), body: {}, timeoutMs: READ_TIMEOUT_MS });
  for (;;) {
    const status = await read('status');
    if (status.ok && BEHIND_AN_ANSWER.every((field) => (status.result?.queue?.[field] ?? 0) === 0)) {
      const health = await read('health');
      if (health.ok && (health.result?.verificationRuns ?? 0) === 0) return true;
    }
    if (now() >= until) return false;
    await pause(pollMs);
  }
}

/**
 * Sends `request` through `sidecar.sidecarRequest`, and again (up to `attempts` in all) while the answer says the
 * call was cut short, or came but is not what the caller needs. Returns `{ answer, attempts }`: the last answer, and how
 * many times it was asked.
 *
 * @param {{ sidecarRequest: Function }} sidecar the sidecar client (`apps/sidecar/dist/index.js`)
 * @param {object} request what `sidecarRequest` takes
 * @param {object} [options]
 * @param {number} [options.attempts] the most times it is asked, the first included (default `DEADLINE_ATTEMPTS`)
 * @param {Function} [options.settle] `settle(sidecar, request, answer, attempt)` waits between attempts (default `waitUntilQuiet`)
 * @param {Function} [options.satisfied] `satisfied(answer)`, sync or async, false when an answer that is ok did not do what the caller
 *   needs (its consult was skipped for lack of time): the call is asked again
 */
export async function askSidecarCounted(sidecar, request, { attempts = DEADLINE_ATTEMPTS, settle = waitUntilQuiet, satisfied } = {}) {
  const limit = NOT_REPEATED_OPS.has(request.op) ? 1 : Math.max(1, attempts);
  for (let attempt = 1; ; attempt += 1) {
    const answer = await sidecar.sidecarRequest(attempt === 1 ? request : freshDelivery(request, attempt));
    if (attempt >= limit) return { answer, attempts: attempt };
    const again = cutShort(answer) || (answer !== null && typeof answer === 'object' && answer.ok === true && satisfied !== undefined && !(await satisfied(answer)));
    if (!again) return { answer, attempts: attempt };
    await settle(sidecar, request, answer, attempt);
  }
}

/** `askSidecarCounted`, for a call site that wants only the answer (the shape `sidecarRequest` returns). */
export async function askSidecar(sidecar, request, options) {
  return (await askSidecarCounted(sidecar, request, options)).answer;
}

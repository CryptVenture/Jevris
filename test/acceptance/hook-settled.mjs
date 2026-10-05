/**
 * Real hook deliveries that have to be answered by every subscriber, on a host of any speed.
 *
 * The sidecar's `event` op measures how long each subscriber's `handle` runs before its first await. A
 * subscriber that took 100 ms or more (`SUBSCRIBER_SLOW_SYNC` in apps/sidecar/src/state.ts) is not waited
 * for on its next event: that event's answer comes from the others and its own work runs afterwards in the
 * background, where its answer is never used (it takes nothing, and the hook says SUBSCRIBER_QUEUED when
 * nothing else was proposed). The first event a sidecar process answers pays a cold cost (a schema
 * compiled, a module loaded) that passes 100 ms on a slow or instrumented host (coverage on the Linux CI
 * cell, windows-latest), so the event after it was deferred and a test that expected that event's answer failed.
 * That is the product keeping its hot path short, not a defect, so a test that needs an answer:
 * - warms the subscribers first (`warmHooks`), so the cold cost is paid by an event the test does not read;
 * - and, where it reads the event after another, takes the first answer that was not deferred (`DEFERRED`):
 *   a deferred answer took nothing, so waiting for the next one loses nothing.
 */
import assert from 'node:assert/strict';

/** The reason a hook answer carries when a subscriber was deferred and nothing else was proposed. */
export const DEFERRED = 'SUBSCRIBER_QUEUED';

/**
 * Sends `make(i)` events until two in a row were answered with no subscriber deferred. Each event is a
 * throwaway one (its own session, nothing to advise on), so what is read afterwards is not touched. The
 * deferral of one event ends when its background work has run, and the next hook process takes long
 * enough to start that the loop waits on the answers it reads, never on a guessed time.
 */
export function warmHooks(box, harness, make, options = {}) {
  let clean = 0;
  let last = null;
  for (let i = 0; i < 40 && clean < 2; i += 1) {
    last = box.hook(harness, make(i), options);
    assert.equal(last.code, 0, `a warm-up hook exited ${last.code}: ${last.stderr}`);
    clean = last.reason === DEFERRED ? 0 : clean + 1;
  }
  assert.equal(clean, 2, `the sidecar kept deferring its subscribers while warming up (last answer ${last?.reason})`);
}

/**
 * Sends `make(i)` until `shows(hook)` says the line arrived, at most `max` events. An event that showed nothing
 * must have been deferred (a deferred answer takes nothing, so the line is still held for the next one); any
 * other empty answer fails with what the hook said. Returns `{ hook, native, tries }` of the event that showed it.
 */
export function untilShown(box, harness, make, shows, options = {}, max = 12) {
  const seen = [];
  for (let tries = 1; tries <= max; tries += 1) {
    const native = make(tries);
    const hook = box.hook(harness, native, options);
    if (shows(hook)) return { hook, native, tries };
    seen.push(`${hook.reason ?? '?'}: ${hook.stdout.trim().slice(0, 120) || '(empty)'}`);
    assert.equal(hook.reason, DEFERRED, `the line was not shown, and the event was not deferred either: ${seen.join(' | ')}`);
  }
  assert.fail(`the line was not shown in ${max} events, every one deferred: ${seen.join(' | ')}`);
}

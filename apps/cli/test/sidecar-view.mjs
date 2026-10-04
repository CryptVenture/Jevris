/**
 * Reads of the sidecar's doctor view for a test that starts or stops a real sidecar.
 *
 * `sidecarDoctorView` asks a running sidecar for its health and gives up at its own short timeout, so
 * a single read right after a start (or a stop) on a slow, loaded host can see `timeout`,
 * `unavailable` or the state a moment before. A test waits for the state it expects, with a bound
 * long enough for such a host (a fast host pays nothing: the first read already holds), and then
 * asserts on the view it got, so a failure still names what the last read showed.
 */
import { setTimeout as sleep } from 'node:timers/promises';

const { sidecarDoctorView } = await import('../dist/runtime-commands.js');

/** Reads until `ok(value)` holds or `boundMs` has passed, and returns the last value either way. */
export async function readUntil(read, ok, { boundMs = 60_000, everyMs = 100 } = {}) {
  const stop = Date.now() + boundMs;
  let value = await read();
  while (!ok(value) && Date.now() < stop) {
    await sleep(everyMs);
    value = await read();
  }
  return value;
}

/** The doctor view once it shows `state` (the last view read when it never does). */
export const viewWhen = (home, state, options) => readUntil(() => sidecarDoctorView(home), (view) => view.state === state, options);

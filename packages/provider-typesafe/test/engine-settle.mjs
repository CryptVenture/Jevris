/**
 * A test that abandons a Jev call (the deadline passed, the caller moved on) leaves the engine
 * running that call's tail: it still settles the budget, records the failure in the circuit
 * breaker, ends the journal entry and, for a classification, records the advice. Those writes land
 * in the test's Jevris home, so a test that removes the home as soon as its own assertions are
 * done races them and fails with ENOTEMPTY on a loaded host. The product is right to finish that
 * work (the sidecar's home stays); the test must wait for it, on the work itself and not on elapsed
 * time.
 *
 * `trackEngine(engine)` follows every `decide`, `recordAdvice` and `lookup` call the engine
 * receives (`lookup` because a classification reads its own record back between the two writes).
 * `settled()` resolves once none is running and none starts in the turn after, and fails with a
 * named error when a call is still running at the bound. Call it before removing the home.
 */

const TRACKED = ['decide', 'recordAdvice', 'lookup'];
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

export function trackEngine(engine) {
  const running = new Set();
  for (const name of TRACKED) {
    if (typeof engine[name] !== 'function') continue;
    const original = engine[name].bind(engine);
    engine[name] = (...args) => {
      const call = original(...args);
      running.add(call);
      const done = () => {
        running.delete(call);
      };
      Promise.resolve(call).then(done, done);
      return call;
    };
  }
  return {
    running: () => running.size,
    /** Resolves when no tracked call is running. A call that is still running at `boundMs` is an error. */
    async settled({ boundMs = 30_000 } = {}) {
      let timer;
      const bound = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${running.size} engine call(s) were still running ${boundMs} ms after the test finished`)), boundMs);
      });
      bound.catch(() => undefined);
      try {
        // Two quiet turns in a row: a call that ends starts the next one (decide, then lookup, then recordAdvice) in the same turn.
        for (let quiet = 0; quiet < 2; ) {
          if (running.size === 0) quiet += 1;
          else {
            quiet = 0;
            await Promise.race([Promise.allSettled([...running]), bound]);
          }
          await Promise.race([nextTurn(), bound]);
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

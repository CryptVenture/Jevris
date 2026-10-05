/**
 * The test budget scale, from the test side (docs/testing.md "slow machines").
 *
 * The runner may set JEVRIS_TEST_BUDGET_SCALE (scripts/test.mjs: 6 on Windows under CI, or the
 * caller's own number). The product reads it only under JEVRIS_TEST=1, through one function
 * (`testBudgetScale` in packages/contracts), and multiplies the sidecar's hot, background and
 * answer-lane budgets, the hello and frame timers, a subscriber's slice and the hook launcher's
 * deadline, so a runner that stalls for seconds does not turn a correct DEADLINE into a red test.
 *
 * A test about a deadline, an abandon or a budget keeps the product's exact budgets. It does that
 * in ONE of these ways, and never by editing an environment ad hoc:
 * - a spawned product (sidecar, hook, CLI): `exactBudgets(env)` for the environment it gives the
 *   child, or `sandbox(t, { exactBudgets: true })` in test/acceptance/lib.mjs;
 * - an in-process daemon or service: `limits: EXACT_BUDGET_LIMITS` (any explicit `limits.budgetMs`
 *   pins the budgets);
 * - in-process code that reads the scale when it runs (a capability consult's default wait):
 *   `withExactBudgets(() => ...)`, which takes the variable out of this process's environment for
 *   the call;
 * - the hook launcher's `deadlineMs(env)` or `testBudgetScale(env)` called with an env that names
 *   no JEVRIS_TEST.
 * The scripts that measure or drive the product's real budgets never see the scale: the benchmark,
 * the load and drill scripts, pack-smoke and the docs generator build their child environments with
 * `testEnvironment` in scripts/test.mjs, which strips it (the suite's own test processes get it from
 * its `main`); the Jev feature suite clears it before it starts the hot-path sidecar; the
 * engine-overhead script starts no sidecar and reads no scale.
 */

export const BUDGET_SCALE_VARIABLE = 'JEVRIS_TEST_BUDGET_SCALE';

/** The variable that sets the CLI's sidecar autostart wait under a test run (`sidecarWaitMs` in apps/sidecar/src/client.ts). */
export const SIDECAR_WAIT_VARIABLE = 'JEVRIS_SIDECAR_WAIT_MS';

/** The most the product honors for it, and the wait a test gives when the runner's own is not set (`SIDECAR_TEST_WAIT_MAX_MS`). */
export const SIDECAR_START_WAIT_MS = 60_000;

/**
 * The product's op budgets and connection timers, pinned: what a deadline test gives an in-process
 * daemon as `limits` (`{ maxConnections: 2, ...EXACT_BUDGET_LIMITS }` to set others as well).
 */
export const EXACT_BUDGET_LIMITS = Object.freeze({ budgetMs: Object.freeze({ hot: 900, background: 5000 }), answerBudgetMs: 4000, helloMs: 2000, frameMs: 2000 });

/**
 * The slow-host settings the runner gives every test process (`testEnvironment` in scripts/test.mjs), for a child whose
 * environment a test builds by hand: `{ PATH, HOME, ..., ...slowHostSettings() }`. A hand-built environment has none of
 * them, and the product then runs on its own defaults: a spawned CLI waits 5 s for a sidecar to start and answers "starting;
 * this call ran rules-only" (exit 1) when a loaded host takes longer (windows-latest, CI run 37293344243), and a request it
 * names no timeout for waits 5 s, not the scaled wait. The variables act only with JEVRIS_TEST=1, which is why that is set;
 * JEVRIS_SIDECAR_WAIT_MS alone does nothing. The runner's own wait (at most 60 s) and scale pass through, so a run with
 * JEVRIS_TEST_BUDGET_SCALE=1 or 12 gives the child the same. A child whose subject is a deadline wraps the result in
 * `exactBudgets(...)`. A child whose environment is `{ ...process.env, ... }` already has all of this.
 */
export function slowHostSettings(env = process.env) {
  const own = env[SIDECAR_WAIT_VARIABLE];
  const scale = env[BUDGET_SCALE_VARIABLE];
  return {
    JEVRIS_TEST: '1',
    [SIDECAR_WAIT_VARIABLE]: typeof own === 'string' && /^\d{1,9}$/.test(own) ? own : String(SIDECAR_START_WAIT_MS),
    ...(typeof scale === 'string' && scale !== '' ? { [BUDGET_SCALE_VARIABLE]: scale } : {}),
  };
}

/** How long a spawned CLI may wait for a sidecar to start with `settings` (`slowHostSettings()`): the product's clamp of the setting. */
export function startWaitMs(settings = slowHostSettings()) {
  return Math.min(SIDECAR_START_WAIT_MS, Number(settings[SIDECAR_WAIT_VARIABLE]));
}

/** A copy of `env` with no budget scale, for a child that must run on the product's exact budgets. */
export function exactBudgets(env = process.env) {
  const copy = { ...env };
  delete copy[BUDGET_SCALE_VARIABLE];
  return copy;
}

/**
 * Runs `fn` with no budget scale in this process's own environment, then puts the variable back: for in-process code
 * that reads the scale when it runs (a capability consult's default wait, an in-process daemon). Tests of one file
 * run one after another, so nothing else sees the gap; a spawned child gets `exactBudgets(env)` instead.
 */
export async function withExactBudgets(fn) {
  const before = process.env[BUDGET_SCALE_VARIABLE];
  delete process.env[BUDGET_SCALE_VARIABLE];
  try {
    return await fn();
  } finally {
    if (before !== undefined) process.env[BUDGET_SCALE_VARIABLE] = before;
  }
}

const { testBudgetScale } = await import('@jevris/contracts');

/** The scale in `env`, read by the product's own function (1 outside a test run, and when none or an invalid one is set). */
export function budgetScaleOf(env = process.env) {
  return testBudgetScale(env);
}

/**
 * The bound, in ms, a test puts on the wall-clock latency of a REAL operation (a commit, a request, a start): the bound that
 * suits a quiet machine, made longer where this run is slower, and never past `capMs`.
 *
 *   min(capMs, (baseMs + quietMultiple x quietMs) x scale)
 *
 * - `baseMs` is the bound on a quiet developer machine: what the test would assert as a plain number.
 * - `quietMs` is this run's own quiet measurement (the same operation timed with nothing else running, a 90th percentile of a
 *   few samples): a runner whose plain commit takes 70 ms gets 10 of those added, so the bound follows the host and still shows
 *   a lock that was really held, which takes thousands of ms.
 * - `scale` is the run's budget scale (`budgetScaleOf`): 6 on the Windows CI runner and in `npm run test:slow`, 1 on a
 *   developer machine. A test never branches on process.platform for this: a Mac cannot run the Windows branch before a push,
 *   and the scale gives the slow host the longer bound the same way everywhere.
 * - `capMs` keeps the bound meaningful where the scale would stretch it past what it is there to exclude (a hot commit that
 *   waited for a held lock takes the store's busy_timeout, 2000 ms; a bound of 2400 would show nothing).
 *
 * lint/slow-ci.lint.mjs (`latency-bound`, `platform-bound`) fails a measured latency compared with a fixed number under 2 s or
 * a Windows-only number that does not come from here. A bound that IS the behaviour under test (a deadline) pins the exact
 * budgets instead (`exactBudgets`, `EXACT_BUDGET_LIMITS`) and measures with an injected clock.
 */
export function latencyBound(baseMs, { quietMs = 0, quietMultiple = 10, capMs = Number.POSITIVE_INFINITY, env = process.env } = {}) {
  if (!Number.isFinite(baseMs) || baseMs <= 0) throw new RangeError('latencyBound takes a positive base in ms');
  return Math.min(capMs, (baseMs + quietMultiple * Math.max(0, quietMs)) * budgetScaleOf(env));
}

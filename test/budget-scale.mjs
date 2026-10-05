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

/**
 * The product's op budgets and connection timers, pinned: what a deadline test gives an in-process
 * daemon as `limits` (`{ maxConnections: 2, ...EXACT_BUDGET_LIMITS }` to set others as well).
 */
export const EXACT_BUDGET_LIMITS = Object.freeze({ budgetMs: Object.freeze({ hot: 900, background: 5000 }), answerBudgetMs: 4000, helloMs: 2000, frameMs: 2000 });

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

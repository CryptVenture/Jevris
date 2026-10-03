// A command line has a size limit, and the test and lint runners put every file they run on one.
// Windows refuses a command line over 32,767 characters (spawnSync fails with ENAMETOOLONG, and
// no test runs at all); a checkout path like D:\a\Jevris\Jevris\ and about 560 test files reached
// it. This module keeps a runner under a budget well below that: a runner that fits runs exactly
// as it always did, in one process, and one that does not is split into batches that run one
// after another (a coverage run, which cannot be split, names its files as glob patterns instead:
// scripts/test.mjs runTestFiles). A file list of any length gets a command line within the budget;
// the one thing it cannot shrink is a single file name longer than the budget.
//
// Used by scripts/test.mjs and scripts/lint.mjs; test/test-runner-batches.test.mjs pins the sizes.

/**
 * The character budget for one command line, the program and every argument counted.
 * Windows allows 32,767 characters in all, so its budget is about three fifths of that: room for
 * quoting, a long program path and the longest single file path the budget cannot split. Linux
 * and macOS allow far more (about 1 MB on macOS and 2 MB on Linux, shared with the environment;
 * 128 KB at the least), so a run that fits 100,000 characters there stays one process.
 */
export const ARGV_BUDGET_WINDOWS = 20_000;
export const ARGV_BUDGET_POSIX = 100_000;

/** The least a budget can be set to (JEVRIS_TEST_ARGV_BUDGET): below it, every file runs in a batch of its own anyway. */
export const MIN_ARGV_BUDGET = 1_000;

/**
 * The budget for a run on `platform`: JEVRIS_TEST_ARGV_BUDGET when it names a whole number of
 * characters (a way to force a split on any host, for tests of the splitting itself), else the
 * platform's own.
 */
export function argvBudget(env = process.env, platform = process.platform) {
  const own = env.JEVRIS_TEST_ARGV_BUDGET;
  if (typeof own === 'string' && /^[1-9]\d{0,8}$/.test(own)) return Math.max(MIN_ARGV_BUDGET, Number(own));
  return platform === 'win32' ? ARGV_BUDGET_WINDOWS : ARGV_BUDGET_POSIX;
}

/**
 * The characters a command line costs on the host that counts most (Windows): the program and
 * each argument, a separator after each, and room for the quotes an argument with a space gets.
 */
export function commandLength(program, args) {
  let total = wordCost(program);
  for (const arg of args) total += wordCost(arg);
  return total;
}

/** What one word of a command line costs: its characters, a separator and room for quotes. */
export function wordCost(word) {
  return String(word).length + 3;
}

/**
 * `files` in the order given, cut into batches whose command line (program, the fixed arguments
 * and the batch) stays within `budget`. A file that does not fit beside the fixed arguments by
 * itself still gets a batch of its own, since nothing smaller exists.
 */
export function batchFiles(files, { program, fixed = [], budget = argvBudget() }) {
  const batches = [];
  let current = [];
  let used = commandLength(program, fixed);
  for (const file of files) {
    const cost = wordCost(file);
    if (current.length > 0 && used + cost > budget) {
      batches.push(current);
      current = [];
      used = commandLength(program, fixed);
    }
    current.push(file);
    used += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * The runs of one node --test over `parallel` then `serial` files. When the whole list fits the
 * budget it is one run with the files in the given order (what a run has always been). When it
 * does not, the `parallel` files go in as few batches as fit, in order, and each `serial` file
 * (a latency-bound one) then runs alone, after every other file has finished.
 *
 * `flags` are the fixed arguments of the one-run form; `splitFlags` those of a batch (it also
 * carries the batch's own report destinations), defaulting to `flags`.
 */
export function planRuns({ parallel, serial = [], program, flags, splitFlags = flags, budget = argvBudget() }) {
  const all = [...parallel, ...serial];
  if (commandLength(program, [...flags, ...all]) <= budget) return [all];
  return [...batchFiles(parallel, { program, fixed: splitFlags, budget }), ...serial.map((file) => [file])];
}

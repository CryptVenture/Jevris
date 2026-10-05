#!/usr/bin/env node
/**
 * npm run test:slow -- [--quick] [--runs N] [--burners N] [--scale N] [--seed N] [--no-build] [<test file>...]
 *
 * The suite on a host made to behave like the Windows CI runner (scripts/slow-host.mjs): CPU burners, the runner's
 * budget scale, slow file writes, process starts and git calls, and transient write errors on what the product retries.
 * Run it before you push; a test that assumes a fast host fails here and not only in CI.
 *
 * It takes the host suite lock first (the burners load the whole machine, so no other full suite may run beside them),
 * then the checkout's suite lock, builds once without the kit, and runs `scripts/test.mjs --no-build` under it: the same
 * `node --test` batches, the same summary lines. It prints each failing test by file and name, and what the run injected.
 * Exit 0: every run passed. Exit 1: a run failed. Exit 2: usage. Exit 75: a lock stayed held.
 */
import { isMain } from './build.mjs';
import { buildFirst, parseSlowArgs, refuseWindows, repoRoot, runSlow, usage } from './slow-host.mjs';

async function main(argv) {
  let options;
  try {
    options = parseSlowArgs(argv);
  } catch (error) {
    console.error(`test:slow: ${error.message}`);
    console.error(usage());
    return 2;
  }
  const refused = refuseWindows();
  if (refused !== null) {
    console.error(`test:slow: ${refused}`);
    return 2;
  }
  const { runHostLocked, runLocked } = await import('./suite-lock.mjs');
  return runHostLocked(() => runLocked(repoRoot, () => runSlow(options, { build: buildFirst })));
}

if (isMain(import.meta.url)) process.exit(await main(process.argv.slice(2)));

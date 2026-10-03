// A sidecar process whose count of verification runs is a file: while `<flag>` exists, one run is
// "under way". With `<flag>.late` present, the next count (the sidecar's decision on a shutdown
// frame) reads none and then a run begins, the way a request that was in flight starts one just
// after the stop was accepted. The same daemon the product starts (runSidecarMain), with only the
// run counter replaced, so a test can stop it with and without a run, from outside, the way the
// CLI does. Never started by product code. Usage: node busy-daemon.mjs <home> <flag-file>
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { runSidecarMain } from '../../dist/daemon.js';

const [home, flag] = process.argv.slice(2);
const late = `${flag}.late`;
const code = await runSidecarMain({
  home,
  idleMs: 0,
  supervised: false,
  packageOps: false,
  backgroundWork: () => {
    if (existsSync(flag)) return 1;
    if (existsSync(late)) {
      rmSync(late, { force: true });
      writeFileSync(flag, '');
    }
    return 0;
  },
  // A bound, so a test that leaves the wait running still ends.
  shutdownRunWaitMs: 60_000,
  write: () => undefined,
});
process.exit(code);

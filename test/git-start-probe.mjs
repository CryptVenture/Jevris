/**
 * A probe for where git processes are started (a test helper, never part of the product).
 *
 * `gitStartPreload(log, ms)` is the text of a CommonJS preload that wraps `child_process.spawn` in the thread it runs in: a start of git
 * appends the thread's id (0 is the main thread, the event loop) as a line to `log` and then blocks the thread for `ms`, as creating a
 * process does on a loaded Windows runner (CreateProcess runs inside `spawn`). It also gives every worker thread that thread starts the
 * same preload through `execArgv`, because NODE_OPTIONS reaches the main thread only. A sidecar started with the preload in its
 * NODE_OPTIONS is the sidecar's own, so the preload acts only where `process.argv[1]` names a sidecar, and in the worker threads it
 * started; `always` makes it act in a process that is not one (a test process that requires the file itself).
 */

/** The preload's source. */
export function gitStartPreload(log, ms, { always = false } = {}) {
  return `
'use strict';
const path = require('node:path');
const workers = require('node:worker_threads');
// A worker thread has no script in its argv, and only this preload's own patch gives it the preload: it is always the sidecar's.
if (${always ? 'true' : "!workers.isMainThread || /sidecar/.test(path.basename(process.argv[1] ?? ''))"}) {
  const cp = require('node:child_process');
  const fs = require('node:fs');
  const { syncBuiltinESMExports } = require('node:module');
  if (workers.isMainThread) {
    const Original = workers.Worker;
    workers.Worker = class Worker extends Original {
      constructor(file, options = {}) {
        super(file, { ...options, execArgv: [...(options.execArgv ?? []), '--require', __filename] });
      }
    };
  }
  const original = cp.spawn;
  cp.spawn = function spawn(command, ...rest) {
    if (/^git(\\.exe)?$/i.test(path.basename(String(command)))) {
      try {
        fs.appendFileSync(${JSON.stringify(log)}, workers.threadId + '\\n');
      } catch {
        // a probe never takes the process down
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${String(ms)});
    }
    return original.call(this, command, ...rest);
  };
  syncBuiltinESMExports();
}
`;
}

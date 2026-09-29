// Imported into every test process by scripts/test-preload.mjs. Windows only; a no-op elsewhere.
//
// On Windows a file stays held for a while after the process that had it open exits (the handle
// closes late, and a scanner opens new files after they are written), so a teardown's recursive,
// forced removal of a folder whose sidecar has just stopped can fail with EPERM or EBUSY though
// nothing holds the folder any more. Seen at 57e4847 in two teardowns in one run. A recursive,
// forced fs.rmSync or fs.promises.rm of a path inside this run's temporary folder (TEMP, set by
// scripts/test.mjs) is therefore retried for up to 30 s on those codes. Any other removal, and
// any other error, is untouched; a folder still held after 30 s fails as before.
import { createRequire } from 'node:module';
import { resolve, sep } from 'node:path';

const WINDOW_MS = 30_000;
const TRANSIENT = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES']);

/** Whether a removal of `path` with `options` is a teardown this module retries. */
export function retriedRemoval(path, options, runTemp, platform = process.platform) {
  if (typeof runTemp !== 'string' || runTemp.length === 0) return false;
  if (options === null || typeof options !== 'object' || options.recursive !== true || options.force !== true) return false;
  if (typeof path !== 'string') return false;
  // Windows paths compare without case, as the file system does.
  const fold = (text) => (platform === 'win32' ? text.toLowerCase() : text);
  const full = fold(resolve(path));
  const root = fold(resolve(runTemp));
  return full.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** The error code, when the removal may succeed on a later try. */
export function transient(error) {
  const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && TRANSIENT.has(code);
}

const runTemp = process.env.TEMP;
if (process.platform === 'win32' && typeof runTemp === 'string' && runTemp.length > 0 && typeof process.env.JEVRIS_TEMP_LEDGER === 'string') {
  const require = createRequire(import.meta.url);
  const fs = require('node:fs');
  const { syncBuiltinESMExports } = require('node:module');
  const rmSync = fs.rmSync;
  fs.rmSync = function retried(path, options) {
    if (!retriedRemoval(path, options, runTemp)) return rmSync.call(this, path, options);
    const until = Date.now() + WINDOW_MS;
    for (;;) {
      try {
        return rmSync.call(this, path, options);
      } catch (error) {
        if (!transient(error) || Date.now() >= until) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      }
    }
  };
  const rm = fs.promises.rm;
  fs.promises.rm = async function retried(path, options) {
    if (!retriedRemoval(path, options, runTemp)) return rm.call(this, path, options);
    const until = Date.now() + WINDOW_MS;
    for (;;) {
      try {
        return await rm.call(this, path, options);
      } catch (error) {
        if (!transient(error) || Date.now() >= until) throw error;
        await new Promise((done) => setTimeout(done, 250));
      }
    }
  };
  syncBuiltinESMExports();
}

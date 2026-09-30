import { readFileSync } from 'node:fs';

/**
 * Reads of a file that a running daemon, sidecar, worker or hook process writes (a trace, a log, a
 * journal, a latency file, a store side file). On Windows a read meets EBUSY, EPERM or EACCES
 * while the writer, a scanner or an indexer holds the file (windows-latest, 84ccf26:
 * `EBUSY: resource busy or locked, read` in security-hook-e2e). A test never reads such a file
 * with a bare readFileSync: it goes through these helpers, which retry those errors with a short
 * backoff and a generous bound, and say what the last error was when the bound is reached.
 * lint/live-read.lint.mjs flags a bare readFileSync in the tests that scan live files.
 */

const TRANSIENT = new Set(['EBUSY', 'EPERM', 'EACCES', 'EAGAIN', 'EMFILE', 'ENFILE']);
const codeOf = (error) => (typeof error === 'object' && error !== null ? error.code : undefined);
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Total time the helpers keep retrying: a loaded runner's scanner releases a file within seconds. */
export const LIVE_READ_BOUND_MS = 30_000;
const backoff = (attempt) => Math.min(250, 5 * 2 ** Math.min(attempt, 6));

/**
 * readFileSync that retries a transient error (EBUSY, EPERM, EACCES, ...). `read` and `sleep` are
 * seams for a test with an injected file system. ENOENT is not retried: it throws, or returns an
 * empty result with `vanished: 'empty'` (a scan of a folder whose files come and go).
 */
export function readLive(path, encoding, { vanished = 'throw', boundMs = LIVE_READ_BOUND_MS, read = readFileSync, pause = sleepSync } = {}) {
  const until = Date.now() + boundMs;
  let last;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return encoding === undefined ? read(path) : read(path, encoding);
    } catch (error) {
      last = error;
      const code = codeOf(error);
      if (code === 'ENOENT' && vanished === 'empty') return encoding === undefined ? Buffer.alloc(0) : '';
      if (!TRANSIENT.has(code ?? '') || Date.now() >= until) {
        if (TRANSIENT.has(code ?? '')) throw new Error(`${path} stayed unreadable for ${boundMs} ms (${String(code)}): ${String(error?.message ?? error)}`, { cause: last });
        throw error;
      }
      pause(backoff(attempt));
    }
  }
}

/** readLive for a scan of a folder's files: a file that vanished meanwhile reads as empty. */
export const scanRead = (path, encoding) => readLive(path, encoding, { vanished: 'empty' });

/** Waits until `predicate(text)` holds for the file's text (a missing file reads as ''), and returns the text. */
export async function waitForText(path, predicate = (text) => text.length > 0, { boundMs = LIVE_READ_BOUND_MS } = {}) {
  const until = Date.now() + boundMs;
  let text = '';
  let lastError = null;
  for (let attempt = 0; ; attempt += 1) {
    try {
      text = readFileSync(path, 'utf8');
      lastError = null;
      if (predicate(text)) return text;
    } catch (error) {
      const code = codeOf(error);
      if (code !== 'ENOENT' && !TRANSIENT.has(code ?? '')) throw error;
      lastError = error;
      text = '';
    }
    if (Date.now() >= until) throw new Error(`${path} did not reach the expected text within ${boundMs} ms${lastError === null ? '' : ` (last error ${String(codeOf(lastError))})`}; it held ${JSON.stringify(text.slice(0, 200))}`);
    await sleep(backoff(attempt));
  }
}

import { after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Temporary directories for the store tests. Each one is removed when the test file ends,
 * pass or fail (force, with retries for a Windows handle still closing), and again where a
 * test removes it early. JEVRIS_KEEP_TEST_DIRS=1 keeps them for debugging.
 */
const keep = process.env.JEVRIS_KEEP_TEST_DIRS === '1';
const made = new Set();

export function removeTempDir(dir) {
  if (keep) return;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    made.delete(dir);
  } catch {
    // left for the file-end sweep and the runner's temp folder removal
  }
}

export function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.add(dir);
  return dir;
}

after(() => {
  if (keep) {
    if (made.size > 0) process.stderr.write(`kept ${made.size} store test dir(s) (JEVRIS_KEEP_TEST_DIRS=1): ${[...made].join(', ')}\n`);
    return;
  }
  for (const dir of [...made]) removeTempDir(dir);
});

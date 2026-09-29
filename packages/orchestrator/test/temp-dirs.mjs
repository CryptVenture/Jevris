// Test temp directories: every one made through tempDir() is removed when the test file ends,
// pass or fail (a test's own cleanup may never run when its setup throws). Set
// JEVRIS_KEEP_TEST_DIRS=1 to keep them for a look.
import { after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const made = new Set();

after(() => {
  if (process.env.JEVRIS_KEEP_TEST_DIRS === '1') return;
  for (const dir of made) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  made.clear();
});

export function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.add(dir);
  return dir;
}

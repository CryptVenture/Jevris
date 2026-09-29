import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { deleteJevrisData } = await import('../dist/uninstall.js');
const { jevrisPaths } = await import('../../../packages/platform/dist/index.js');

test('data delete removes the per-OS data and a pre-migration ~/.jevris, and nothing else (BLD-02)', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'jevris-data-legacy-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const paths = jevrisPaths({ home });
  mkdirSync(paths.data, { recursive: true });
  writeFileSync(join(paths.data, 'ledger.jsonl'), '{}\n');
  mkdirSync(join(home, '.jevris'), { recursive: true });
  writeFileSync(join(home, '.jevris', 'old.jsonl'), '{}\n');
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), '{}\n');

  const result = await deleteJevrisData({ home });
  assert.equal(result.ok, true);
  assert.equal(existsSync(paths.data), false);
  assert.equal(existsSync(join(home, '.jevris')), false);
  assert.equal(existsSync(join(home, '.claude', 'settings.json')), true);
});

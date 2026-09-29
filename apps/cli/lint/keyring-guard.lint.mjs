// Source-text checks moved out of apps/cli/test/keyring-guard.test.mjs (QA-07).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));

test('only openHostEntry imports @napi-rs/keyring, and only after the test guard', () => {
  const hits = [];
  for (const base of ['apps', 'packages']) {
    for (const pkg of readdirSync(join(root, base))) {
      let names = [];
      try {
        names = readdirSync(join(root, base, pkg, 'src'));
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.ts') || name.endsWith('.d.ts')) continue;
        const text = readFileSync(join(root, base, pkg, 'src', name), 'utf8');
        if (text.includes("'@napi-rs/keyring'")) hits.push(`${base}/${pkg}/src/${name}`);
      }
    }
  }
  assert.deepEqual(hits, ['apps/cli/src/credential.ts']);
  const source = readFileSync(join(root, 'apps', 'cli', 'src', 'credential.ts'), 'utf8');
  const fn = source.slice(source.indexOf('export async function openHostEntry'));
  const guard = fn.indexOf('if (keyringBlockedInTests()) throw new KeyringBlockedError();');
  const load = fn.indexOf("import('@napi-rs/keyring')");
  assert.equal(guard > 0 && load > guard, true);
  const runner = readFileSync(join(root, 'scripts', 'test.mjs'), 'utf8');
  assert.equal(runner.includes("JEVRIS_TEST: '1'"), true);
  assert.equal(runner.includes('nodeOptionsWithPreload'), true);
});

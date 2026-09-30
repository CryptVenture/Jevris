import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A CLI command is a person's command: it does real work (a store write, a network round trip, a
 * git read, a ledger transaction), so it never asks the sidecar for the 900 ms hook budget. CI
 * answered DEADLINE to `control migrate` (windows-latest) and `budget update` (ubuntu-latest).
 * Ask through personRequest(ctx) (apps/cli/src/public/context.ts): the background budget and a
 * wait past it. Only a hook keeps 'hot'. apps/cli/test/person-budget.test.mjs captures the
 * request each listed command sends.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'apps', 'cli', 'src');

export function hotFindings(text) {
  return [...text.matchAll(/budget:\s*'hot'/g)].map((m) => text.slice(0, m.index).split('\n').length);
}

test('no apps/cli/src command asks the sidecar for the hot budget (use personRequest)', () => {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) for (const line of hotFindings(readFileSync(full, 'utf8'))) found.push(`${relative(root, full)}:${line}`);
    }
  };
  walk(src);
  assert.deepEqual(found, []);
});

test('the check sees a hot budget in a request', () => {
  assert.deepEqual(hotFindings("a\nsidecar.request({ op, budget: 'hot' })"), [2]);
  assert.deepEqual(hotFindings("...personRequest(ctx)"), []);
});

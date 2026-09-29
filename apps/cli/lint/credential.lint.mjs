// Source-text checks moved out of apps/cli/test/credential.test.mjs (QA-07).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CANARY = 'CANARY_SECRET_do_not_print';

test('openHostEntry pins secret-service only on linux and omits that option elsewhere', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/credential.ts', import.meta.url)), 'utf8');
  const start = source.indexOf('export async function openHostEntry');
  assert.equal(start >= 0, true);
  const fn = source.slice(start);
  const calls = [...fn.matchAll(/new Entry\([^()]*\)/g)].map((match) => match[0]);
  assert.deepEqual(calls, [
    "new Entry(service, account, { linux: { store: 'secret-service' } })",
    'new Entry(service, account)',
  ]);
  const linuxCall = fn.indexOf(calls[0]);
  const plainCall = fn.indexOf(calls[1], linuxCall + calls[0].length);
  const gate = fn.indexOf("process.platform === 'linux'");
  assert.equal(gate >= 0 && gate < linuxCall && linuxCall < plainCall, true);
  assert.equal(fn.includes('if (value === null || value.length === 0) return undefined;'), true);
  assert.equal(fn.includes('console.'), false);
  assert.equal(fn.includes(CANARY), false);
  // A missing binding is one typed error with a fixed plain message (BLD-13), never a raw one.
  assert.equal(fn.includes('new Error('), false);
  assert.equal(fn.includes('throw new KeyringUnavailableError();'), true);
});

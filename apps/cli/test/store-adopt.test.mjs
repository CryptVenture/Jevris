import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// DATA-10 `jevris store adopt`: an interactive terminal only, and never under JEVRIS_TEST, so a
// test, a hook, MCP or a script can never re-stamp a store. The re-stamp itself is tested in
// apps/sidecar/test/host-scope.test.mjs.

const { runRuntimeCommand } = await import('../dist/runtime-commands.js');

function tempHome(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-adopt-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

async function run(argv, hooks) {
  const chunks = [];
  const code = await runRuntimeCommand(argv, (text) => chunks.push(text), { actor: 'tester', ...hooks });
  return { code, text: chunks.join('') };
}

test('store adopt is refused under JEVRIS_TEST, even from a terminal (DATA-10)', async (t) => {
  const home = tempHome(t);
  assert.equal(process.env.JEVRIS_TEST, '1');
  const r = await run(['store', 'adopt', '--home', home], { interactive: () => true });
  assert.equal(r.code, 2);
  assert.match(r.text, /never run under JEVRIS_TEST/);
});

test('store adopt is refused without an interactive terminal (DATA-10)', async (t) => {
  const home = tempHome(t);
  const saved = process.env.JEVRIS_TEST;
  // Only the terminal check is reached: the command returns before touching the store.
  delete process.env.JEVRIS_TEST;
  try {
    const r = await run(['store', 'adopt', '--home', home], { interactive: () => false });
    assert.equal(r.code, 2);
    assert.match(r.text, /needs an interactive terminal/);
  } finally {
    process.env.JEVRIS_TEST = saved;
  }
});

test('store help lists adopt (DATA-10)', async () => {
  const r = await run(['help', 'store'], {});
  assert.equal(r.code, 0);
  assert.match(r.text, /\|adopt \[--home <dir>\]/);
  assert.match(r.text, /adopt {5}mark your own store/);
});

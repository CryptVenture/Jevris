// Harness parity audit G18: `jevris --home X install ...` once reached a legacy pre-v2 install
// path in cli.ts (the admin commands checked argv[0] only). An admin command named after global
// flags is now the admin command, with the same flags; the legacy branches are gone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.JEVRIS_SIDECAR_AUTOSTART = '0';
const { main, adminArgvAfterFlags } = await import('../dist/cli.js');

async function run(argv) {
  let text = '';
  const code = await main(argv, (chunk) => (text += chunk));
  return { code, text };
}

test('an admin command after global flags moves to the front, with its flags kept', () => {
  assert.deepEqual(adminArgvAfterFlags(['--home', '/h', 'install', '--harness', 'claude']), ['install', '--home', '/h', '--harness', 'claude']);
  assert.deepEqual(adminArgvAfterFlags(['--home=/h', 'uninstall']), ['uninstall', '--home=/h']);
  assert.deepEqual(adminArgvAfterFlags(['--harness', 'codex', '--home', '/h', 'doctor']), ['doctor', '--harness', 'codex', '--home', '/h']);
  assert.deepEqual(adminArgvAfterFlags(['--home', '/h', 'data', 'delete', '--yes']), ['data', 'delete', '--home', '/h', '--yes']);
  // A flag's value is never taken for the command, and nothing else is rerouted.
  assert.equal(adminArgvAfterFlags(['--home', 'install']), null);
  assert.equal(adminArgvAfterFlags(['install', '--home', '/h']), null, 'already first: the ordinary admin route');
  assert.equal(adminArgvAfterFlags(['--home', '/h', 'data', 'purge']), null);
  assert.equal(adminArgvAfterFlags(['--home', '/h', 'shortlist']), null);
  assert.equal(adminArgvAfterFlags(['--home', '/h']), null);
});

test('jevris --home X install reaches the admin install, never the legacy path', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'jevris-g18-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const command of [['install'], ['uninstall'], ['doctor'], ['data', 'delete']]) {
    const direct = await run([...command, '--help']);
    const after = await run(['--home', home, ...command, '--help']);
    assert.equal(after.code, direct.code, command.join(' '));
    assert.equal(after.text, direct.text, `${command.join(' ')} after --home prints the admin help`);
    assert.match(after.text, /^[Uu]sage: jevris /);
  }
});

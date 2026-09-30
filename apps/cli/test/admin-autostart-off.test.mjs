// JEV-0018 and JEV-0021 at the admin commands, against a real sidecar in a temporary home.
//  - JEVRIS_SIDECAR_AUTOSTART=0: no admin command starts the sidecar. `audit verify` and `audit export`
//    read the store file read-only and answer; the other admin commands refuse with SIDECAR_AUTOSTART_OFF.
//  - While the kill switch is on: `data purge` (not --dry-run) and `authorize` are refused with KILL_SWITCH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedHostSkip } from '../../../test/managed-host.mjs';
import { removeTree } from '../../../scripts/remove-tree.mjs';

const { runRuntimeCommand } = await import('../dist/runtime-commands.js');
const { jevrisPaths } = await import('@jevris/platform');
const here = dirname(fileURLToPath(import.meta.url));
const SIDECAR_MAIN = join(here, '..', '..', 'sidecar', 'dist', 'main.js');

async function withHome(fn) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'jvo-')));
  const saved = { entry: process.env.JEVRIS_SIDECAR_ENTRY, autostart: process.env.JEVRIS_SIDECAR_AUTOSTART };
  process.env.JEVRIS_SIDECAR_ENTRY = SIDECAR_MAIN;
  delete process.env.JEVRIS_SIDECAR_AUTOSTART;
  const run = async (argv, hooks = {}) => {
    const chunks = [];
    const code = await runRuntimeCommand([...argv, '--home', home], (text) => chunks.push(text), { actor: 'tester', interactive: () => false, ...hooks });
    return { code, text: chunks.join('') };
  };
  try {
    await fn({ home, run });
  } finally {
    delete process.env.JEVRIS_SIDECAR_AUTOSTART;
    await runRuntimeCommand(['sidecar', 'stop', '--home', home], () => undefined);
    for (const [key, value] of [['JEVRIS_SIDECAR_ENTRY', saved.entry], ['JEVRIS_SIDECAR_AUTOSTART', saved.autostart]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      removeTree(home);
    } catch {
      // the temporary home is best-effort cleaned
    }
  }
}

test('JEV-0018: with autostart off and no sidecar, audit verify and audit export read the store file and start nothing', { skip: managedHostSkip() }, async () => {
  await withHome(async ({ home, run }) => {
    // A store with one audit row, made by a sidecar that then stops.
    assert.equal((await run(['sidecar', 'start'])).code, 0);
    assert.equal((await run(['kill-switch', 'activate', '--reason', 'jev-0018'])).code, 0);
    assert.equal((await run(['sidecar', 'stop'])).code, 0);
    assert.notEqual((await run(['sidecar', 'status'])).code, 0, 'the sidecar is stopped');

    process.env.JEVRIS_SIDECAR_AUTOSTART = '0';
    const verify = await run(['audit', 'verify']);
    assert.equal(verify.code, 0, verify.text);
    assert.match(verify.text, /audit log: intact \(\d+ rows; read from the store file/);
    const json = JSON.parse((await run(['audit', 'verify', '--json'])).text);
    assert.equal(json.intact, true);
    assert.equal(json.via, 'store-file');
    assert.ok(json.count >= 1);

    const target = join(home, 'audit-out.jsonl');
    const exported = await run(['audit', 'export', target]);
    assert.equal(exported.code, 0, exported.text);
    assert.match(readFileSync(target, 'utf8'), /kill-switch\.activate/);
    assert.equal((await run(['audit', 'export', target])).code, 2, 'an existing output file is refused, as with a sidecar');

    // Another admin command does not start the sidecar either: it says why and exits 1.
    const backup = await run(['store', 'backup', join(home, 'b.db')]);
    assert.equal(backup.code, 1, backup.text);
    assert.match(backup.text, /SIDECAR_AUTOSTART_OFF/);
    assert.equal(existsSync(join(home, 'b.db')), false);

    assert.notEqual((await run(['sidecar', 'status'])).code, 0, 'no command started the sidecar');
  });
});

test('JEV-0018: audit verify with autostart off and no store file yet says intact with 0 rows and creates nothing', { skip: managedHostSkip() }, async () => {
  await withHome(async ({ home, run }) => {
    process.env.JEVRIS_SIDECAR_AUTOSTART = '0';
    const verify = await run(['audit', 'verify']);
    assert.equal(verify.code, 0, verify.text);
    assert.match(verify.text, /intact \(0 rows/);
    assert.equal(existsSync(join(jevrisPaths({ home }).data, 'jevris.db')), false);
    assert.notEqual((await run(['sidecar', 'status'])).code, 0);
  });
});

test('JEV-0021: while the kill switch is on, data purge and authorize are refused with KILL_SWITCH; a dry run still reads', { skip: managedHostSkip() }, async () => {
  await withHome(async ({ run }) => {
    assert.equal((await run(['sidecar', 'start'])).code, 0);
    assert.equal((await run(['kill-switch', 'activate', '--reason', 'jev-0021'])).code, 0);

    const purge = await run(['data', 'purge']);
    assert.equal(purge.code, 2, purge.text);
    assert.match(purge.text, /refused \(KILL_SWITCH\)/);
    assert.match(purge.text, /Clear the kill switch first/);

    const dry = await run(['data', 'purge', '--dry-run']);
    assert.equal(dry.code, 0, dry.text);
    assert.match(dry.text, /would be removed/);

    const mint = await run(['authorize', 'data.delete', '--scope', 'ledger'], { interactive: () => true });
    assert.equal(mint.code, 2, mint.text);
    assert.match(mint.text, /refused \(KILL_SWITCH\)/);
  });
});

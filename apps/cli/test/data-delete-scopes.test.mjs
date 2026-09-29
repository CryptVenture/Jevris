import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';

// DATA-12: jevris data delete has scopes (ledger, capsules, learning, config, credential, data, all) and
// --dry-run, stops the sidecar first, refuses while the kill switch is stopped, is not reachable
// over MCP, and says that local deletion is not vendor deletion. A temporary home and HOME, a
// stand-in keychain and a stand-in service manager: nothing real is touched.

const { runAdminCommand } = await import('../dist/admin-cli.js');
const { main } = await import('../dist/cli.js');
const { activateKillSwitch } = await import('../dist/kill-switch.js');
const { parseScopes } = await import('../dist/data-delete.js');
const { deleteJevrisData } = await import('../dist/uninstall.js');
const { jevrisPaths } = await import('../../../packages/platform/dist/index.js');

function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'f-data-delete-')));
  const home = join(dir, 'home');
  mkdirSync(home);
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  // The OS account home is elsewhere, so no service unit is ever in play.
  process.env.HOME = join(dir, 'account');
  process.env.USERPROFILE = join(dir, 'account');
  mkdirSync(process.env.HOME);
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const paths = jevrisPaths({ home });
  mkdirSync(join(paths.data, 'capsules', 'ws1'), { recursive: true });
  for (const name of ['jevris.db', 'jevris.db-wal', 'jevris.db-shm', 'jevris.db.authz-key', 'jevris.db.writer', 'jevris.db.pre-v3-20260926']) writeFileSync(join(paths.data, name), 'db');
  mkdirSync(join(paths.data, 'decisions'));
  writeFileSync(join(paths.data, 'decisions', 'd.jsonl'), '{}');
  writeFileSync(join(paths.data, 'jevris-notes.db'), 'not the ledger');
  writeFileSync(join(paths.data, 'capsules', 'ws1', 'c.json'), '{}');
  mkdirSync(join(paths.data, 'route-learning'));
  writeFileSync(join(paths.data, 'route-learning', 'ws1.json'), '{}');
  // C's machine-wide prior pooled across workspaces (owner 2026-09-26) is in the learning class.
  mkdirSync(join(paths.data, 'route-learning', 'machine'));
  writeFileSync(join(paths.data, 'route-learning', 'machine', 'prior.json'), '{}');
  // C's models-found-gone record (f5b19ab) is in the learning class too.
  writeFileSync(join(paths.data, 'route-learning', 'model-availability.json'), '{}', { mode: 0o600 });
  writeFileSync(join(paths.data, 'receipt.json'), '{}');
  mkdirSync(paths.config, { recursive: true });
  writeFileSync(join(paths.config, 'host.json'), '{}');
  const keychain = { value: 'x'.repeat(40), deletes: 0 };
  const openKeyring = async () => ({
    get: async () => keychain.value,
    set: async (value) => (keychain.value = value),
    delete: async () => {
      keychain.deletes += 1;
      keychain.value = null;
    },
  });
  const calls = [];
  const serviceExec = (file, args) => (calls.push([file, ...args]), { status: 0, stdout: '', stderr: '' });
  const run = async (args) => {
    let text = '';
    const code = await runAdminCommand(['data', 'delete', '--home', home, ...args], (chunk) => (text += chunk), { isTTY: false, openKeyring, serviceExec });
    return { code, text };
  };
  return { dir, home, paths, keychain, calls, run };
}

test('DATA-12: --scope parses a comma list; the whole data folder already holds the ledger and capsules', () => {
  assert.deepEqual(parseScopes(undefined), { whole: true, scopes: [] });
  assert.deepEqual(parseScopes('ledger,capsules'), { whole: false, scopes: ['ledger', 'capsules'] });
  assert.deepEqual(parseScopes('all'), { whole: true, scopes: ['config', 'credential'] });
  assert.deepEqual(parseScopes('data,ledger'), { whole: true, scopes: [] });
  assert.deepEqual(parseScopes('learning,ledger'), { whole: false, scopes: ['ledger', 'learning'] });
  assert.deepEqual(parseScopes('data,learning'), { whole: true, scopes: [] });
  assert.equal(parseScopes('everything'), null);
  assert.equal(parseScopes(''), null);
});

test('DATA-12: --dry-run lists every target and changes nothing; an unknown scope is a usage error', async (t) => {
  const box = fixture(t);
  const bad = await box.run(['--scope', 'everything']);
  assert.equal(bad.code, 2);
  const dry = await box.run(['--scope', 'all', '--dry-run', '--json']);
  assert.equal(dry.code, 0, dry.text);
  const doc = JSON.parse(dry.text);
  assert.equal(doc.dryRun, true);
  assert.deepEqual(doc.scopes, ['data', 'config', 'credential']);
  assert.deepEqual([...new Set(doc.items.map((item) => item.scope))], ['data', 'config', 'credential']);
  assert.ok(doc.items.some((item) => item.target === box.paths.data && item.present));
  assert.ok(doc.items.some((item) => item.scope === 'credential' && item.present));
  assert.match(doc.vendorNotice, /does not delete anything a model vendor or gateway already received/);
  const text = await box.run(['--dry-run']);
  assert.match(text.text, /would delete \(data\): /);
  assert.match(text.text, /nothing was changed \(--dry-run\)/);
  assert.equal(existsSync(join(box.paths.data, 'jevris.db')), true);
  assert.equal(box.keychain.deletes, 0);
});

test('DATA-12: each scope deletes only its own targets', { skip: managedHostSkip() }, async (t) => {
  const box = fixture(t);
  const ledger = await box.run(['--scope', 'ledger']);
  assert.equal(ledger.code, 0, ledger.text);
  assert.match(ledger.text, /Local deletion removes Jevris data on this machine only/);
  for (const name of ['jevris.db', 'jevris.db-wal', 'jevris.db-shm', 'jevris.db.authz-key', 'jevris.db.writer', 'jevris.db.pre-v3-20260926', 'decisions']) assert.equal(existsSync(join(box.paths.data, name)), false, name);
  assert.equal(existsSync(join(box.paths.data, 'jevris-notes.db')), true, 'only jevris.db* files are the ledger');
  assert.equal(existsSync(join(box.paths.data, 'capsules', 'ws1', 'c.json')), true, 'capsules kept');
  assert.equal(existsSync(join(box.paths.data, 'receipt.json')), true, 'other data kept');
  assert.equal(existsSync(join(box.paths.data, 'route-learning', 'ws1.json')), true, 'the ledger scope keeps route learning');
  assert.equal(existsSync(join(box.paths.data, 'route-learning', 'machine', 'prior.json')), true, 'the ledger scope keeps the machine-wide prior');
  assert.equal(existsSync(join(box.paths.data, 'route-learning', 'model-availability.json')), true, 'and model-availability.json');
  const learning = await box.run(['--scope', 'learning', '--json']);
  assert.equal(JSON.parse(learning.text).ok, true, learning.text);
  assert.deepEqual(JSON.parse(learning.text).items.map((item) => item.scope), ['learning']);
  assert.equal(existsSync(join(box.paths.data, 'route-learning')), false, 'the learning scope removes C\'s route-learning state');
  assert.equal(existsSync(join(box.paths.data, 'route-learning', 'machine')), false, 'the machine-wide prior goes with it');
  assert.equal(existsSync(join(box.paths.data, 'route-learning', 'model-availability.json')), false, 'and so does model-availability.json');
  assert.equal(existsSync(join(box.paths.data, 'capsules', 'ws1', 'c.json')), true, 'the learning scope keeps capsules');
  const capsules = await box.run(['--scope', 'capsules', '--json']);
  assert.equal(JSON.parse(capsules.text).ok, true, capsules.text);
  assert.equal(existsSync(join(box.paths.data, 'capsules')), false);
  assert.equal(existsSync(join(box.paths.config, 'host.json')), true, 'config kept');
  assert.equal(box.keychain.deletes, 0, 'the credential is kept');
  const credential = await box.run(['--scope', 'credential']);
  assert.equal(credential.code, 0, credential.text);
  assert.equal(box.keychain.deletes, 1);
  const config = await box.run(['--scope', 'config']);
  assert.equal(config.code, 0, config.text);
  assert.equal(existsSync(box.paths.config), false);
  assert.equal(existsSync(join(box.paths.data, 'receipt.json')), true, 'data kept');
  const whole = await box.run([]);
  assert.equal(whole.code, 0, whole.text);
  assert.equal(existsSync(box.paths.data), false);
  assert.deepEqual(box.calls, [], 'no service manager call for a home that is not the account home');
});

test('DATA-12: --scope learning also removes the learning records in the store, and with no store skips that half (purgeStoreLearning)', async (t) => {
  const box = fixture(t);
  const store = await import('@jevris/store');
  const { hostScopeForStore } = await import('@jevris/sidecar');
  // The fixture's jevris.db* files are stand-ins; a real store takes their place here.
  for (const name of ['jevris.db', 'jevris.db-wal', 'jevris.db-shm', 'jevris.db.authz-key', 'jevris.db.writer']) rmSync(join(box.paths.data, name), { force: true });
  const path = join(box.paths.data, 'jevris.db');
  const opened = store.openStore({ path, role: 'sidecar', workspaceId: 'host', ...hostScopeForStore(box.home, path) });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const atMs = Date.now();
  assert.equal(store.addLatencyCounts(opened, [{ atMs, scope: 'hook', name: 'claude', metric: 'answered', count: 3, totalMs: 30, maxMs: 12 }]).ok, true);
  assert.equal(store.latencyCounters(opened, { sinceMs: 0 }).length, 1);
  store.closeStore(opened);
  const learning = await box.run(['--scope', 'learning', '--json']);
  assert.equal(JSON.parse(learning.text).ok, true, learning.text);
  assert.equal(existsSync(join(box.paths.data, 'route-learning')), false, 'the route-learning folder goes');
  assert.equal(existsSync(path), true, 'the store itself stays');
  const check = store.openStore({ path, role: 'sidecar', workspaceId: 'host', ...hostScopeForStore(box.home, path) });
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.deepEqual(store.latencyCounters(check, { sinceMs: 0 }), [], 'the learning records in the store go too');
  store.closeStore(check);
  // No store: only the folder half runs.
  for (const name of ['jevris.db', 'jevris.db-wal', 'jevris.db-shm', 'jevris.db.authz-key', 'jevris.db.writer']) rmSync(join(box.paths.data, name), { force: true });
  mkdirSync(join(box.paths.data, 'route-learning'));
  const again = await box.run(['--scope', 'learning', '--json']);
  assert.equal(JSON.parse(again.text).ok, true, again.text);
  assert.equal(existsSync(path), false, 'no store is created to purge it');
});

test('DATA-12: uninstall --delete-data removes the learning files, model-availability.json included (deleteJevrisData)', async (t) => {
  const box = fixture(t);
  const availability = join(box.paths.data, 'route-learning', 'model-availability.json');
  assert.equal(existsSync(availability), true);
  assert.deepEqual(await deleteJevrisData({ home: box.home }), { ok: true });
  assert.equal(existsSync(availability), false);
  assert.equal(existsSync(join(box.paths.data, 'route-learning')), false);
});

test('DATA-12: a symlinked config folder is refused', async (t) => {
  const box = fixture(t);
  const elsewhere = join(box.dir, 'elsewhere');
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, 'keep.txt'), 'keep');
  rmSync(box.paths.config, { recursive: true, force: true });
  symlinkSync(elsewhere, box.paths.config, process.platform === 'win32' ? 'junction' : 'dir');
  const linked = await box.run(['--scope', 'config']);
  assert.equal(linked.code, 2, linked.text);
  assert.equal(readFileSync(join(elsewhere, 'keep.txt'), 'utf8'), 'keep');
});

test('DATA-12: the kill switch keeps everything, and MCP cannot delete', async (t) => {
  const box = fixture(t);
  const stopped = await activateKillSwitch({ home: box.home, actor: 'test', channel: 'cli', reason: 'DATA-12 test' });
  assert.equal(stopped.stopped, true);
  const refused = await box.run(['--scope', 'ledger', '--json']);
  assert.equal(refused.code, 2);
  assert.equal(JSON.parse(refused.text).reasonCode, 'KILL_SWITCH_ACTIVE');
  assert.equal(existsSync(join(box.paths.data, 'jevris.db')), true);

  let text = '';
  const code = await main(['__surface', 'data.delete'], (chunk) => (text += chunk), { readStdin: async () => new TextEncoder().encode(JSON.stringify({ home: box.home })) });
  assert.equal(code, 2);
  assert.match(text, /UNKNOWN_OPERATION/);
  assert.equal(existsSync(join(box.paths.data, 'jevris.db')), true);
});

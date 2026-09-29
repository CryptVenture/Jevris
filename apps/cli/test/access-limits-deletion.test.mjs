import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Access limits R62 (design access-limits.md 4.3): the machine's access-limit record
// (`<data>/route-learning/access-limits.json`, C2's R60) is in the route-learning retention class,
// is written owner-only, and each delete path removes it: `jevris data delete` (the learning scope
// and the whole data folder) and `jevris uninstall --delete-data`. A temporary home and HOME, a
// stand-in keychain and service manager: nothing real is touched.

const { runAdminCommand } = await import('../dist/admin-cli.js');
const { deleteJevrisData } = await import('../dist/uninstall.js');
const { jevrisPaths } = await import('@jevris/platform');
const { ROUTE_LEARNING_RETENTION } = await import('@jevris/store');
const core = await import('@jevris/core');
const contracts = await import('@jevris/contracts');

async function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'b-limits-delete-')));
  const home = join(dir, 'home');
  mkdirSync(home);
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
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
  // One entry, recorded as the product records it (an issued classification of a pinned text).
  const nowMs = Date.now();
  const signal = { port: 'codex', channel: 'error-text', certified: false, text: contracts.matchAccessText("You've hit your usage limit.", 'codex', nowMs) };
  const recorded = await core.recordAccessLimit({
    home,
    scope: { harness: 'codex', authMode: 'subscription', servingHost: 'openai', modelId: 'gpt-5.5', family: null },
    classification: core.classifyAccessSignal(signal, 'subscription', nowMs),
    source: 'owned-run',
    nowMs,
  });
  assert.equal(recorded.ok, true, JSON.stringify(recorded));
  const file = core.accessLimitsPath(home);
  mkdirSync(paths.config, { recursive: true });
  const openKeyring = async () => ({ get: async () => null, set: async () => undefined, delete: async () => undefined });
  const serviceExec = () => ({ status: 0, stdout: '', stderr: '' });
  const run = async (args) => {
    let text = '';
    const code = await runAdminCommand(['data', 'delete', '--home', home, ...args], (chunk) => (text += chunk), { isTTY: false, openKeyring, serviceExec });
    return { code, text };
  };
  return { home, paths, file, run };
}

test('the access-limit record is where the retention class says, and owner-only (R62)', async (t) => {
  const box = await fixture(t);
  assert.equal(box.file, join(box.paths.data, ROUTE_LEARNING_RETENTION.directory, 'access-limits.json'));
  assert.equal(ROUTE_LEARNING_RETENTION.files.includes('access-limits.json'), true);
  assert.equal(existsSync(box.file), true);
  if (process.platform !== 'win32') {
    assert.equal(statSync(box.file).mode & 0o777, 0o600, 'the file is 0600');
    assert.equal(statSync(join(box.paths.data, ROUTE_LEARNING_RETENTION.directory)).mode & 0o077, 0, 'its folder gives no group or other access');
  }
  assert.equal((await core.readAccessLimits(box.home)).entries.length, 1);
});

test('jevris data delete --scope learning removes the access-limit record, and --dry-run keeps it (R62)', async (t) => {
  const box = await fixture(t);
  const dry = await box.run(['--scope', 'learning', '--dry-run', '--json']);
  assert.equal(JSON.parse(dry.text).ok, true, dry.text);
  assert.equal(existsSync(box.file), true, 'a dry run removes nothing');
  const done = await box.run(['--scope', 'learning', '--json']);
  assert.equal(JSON.parse(done.text).ok, true, done.text);
  assert.equal(existsSync(box.file), false);
  assert.deepEqual((await core.readAccessLimits(box.home)).entries, [], 'no pause survives the delete');
});

test('jevris data delete --scope data removes the access-limit record with the data folder (R62)', async (t) => {
  const box = await fixture(t);
  const done = await box.run(['--scope', 'data', '--json']);
  assert.equal(JSON.parse(done.text).ok, true, done.text);
  assert.equal(existsSync(box.file), false);
});

test('jevris uninstall --delete-data removes the access-limit record (deleteJevrisData, R62)', async (t) => {
  const box = await fixture(t);
  assert.deepEqual(await deleteJevrisData({ home: box.home }), { ok: true });
  assert.equal(existsSync(box.file), false);
});

test('removeAccessLimits removes the record and counts its entries; a second call finds none (R62)', async (t) => {
  const box = await fixture(t);
  assert.deepEqual(await core.removeAccessLimits(box.home), { ok: true, removed: 1 });
  assert.equal(existsSync(box.file), false);
  assert.deepEqual(await core.removeAccessLimits(box.home), { ok: true, removed: 0 });
});

// MEDIUM 41 (C2's 644d08b7): a record that could not be parsed is set aside as
// `access-limits.json.damaged-<ms>` (0600, at most 3) before a new one is written. The set-aside
// files are in the route-learning folder, so every delete path removes them with the record.
async function withSetAside(t) {
  const box = await fixture(t);
  writeFileSync(box.file, '{not json', { mode: 0o600 });
  const nowMs = Date.now();
  const signal = { port: 'codex', channel: 'error-text', certified: false, text: contracts.matchAccessText("You've hit your usage limit.", 'codex', nowMs) };
  const recorded = await core.recordAccessLimit({
    home: box.home,
    scope: { harness: 'codex', authMode: 'subscription', servingHost: 'openai', modelId: 'gpt-5.5', family: null },
    classification: core.classifyAccessSignal(signal, 'subscription', nowMs),
    source: 'owned-run',
    nowMs,
  });
  assert.equal(recorded.ok, true, JSON.stringify(recorded));
  assert.equal(recorded.setAside, true);
  const folder = dirname(box.file);
  const asides = () => readdirSync(folder).filter((n) => /^access-limits\.json\.damaged-\d+$/.test(n));
  assert.equal(asides().length, 1);
  assert.equal(readFileSync(join(folder, asides()[0]), 'utf8'), '{not json', 'set aside byte for byte');
  if (process.platform !== 'win32') assert.equal(statSync(join(folder, asides()[0])).mode & 0o777, 0o600);
  return { ...box, asides };
}

test('jevris data delete --scope learning removes the damaged records set aside, and --dry-run keeps them (MEDIUM 41)', async (t) => {
  const box = await withSetAside(t);
  const dry = await box.run(['--scope', 'learning', '--dry-run', '--json']);
  assert.equal(JSON.parse(dry.text).ok, true, dry.text);
  assert.equal(box.asides().length, 1, 'a dry run removes nothing');
  const done = await box.run(['--scope', 'learning', '--json']);
  assert.equal(JSON.parse(done.text).ok, true, done.text);
  assert.equal(existsSync(dirname(box.file)) ? box.asides().length : 0, 0);
});

test('jevris data delete --scope data removes the damaged records set aside (MEDIUM 41)', async (t) => {
  const box = await withSetAside(t);
  const done = await box.run(['--scope', 'data', '--json']);
  assert.equal(JSON.parse(done.text).ok, true, done.text);
  assert.equal(existsSync(dirname(box.file)) ? box.asides().length : 0, 0);
});

test('jevris uninstall --delete-data removes the damaged records set aside (MEDIUM 41)', async (t) => {
  const box = await withSetAside(t);
  assert.deepEqual(await deleteJevrisData({ home: box.home }), { ok: true });
  assert.equal(existsSync(dirname(box.file)) ? box.asides().length : 0, 0);
});

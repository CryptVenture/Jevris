import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// OP-6 (C2's core, dc4808b5; owner decision DOMAINS 9deb30c8): the machine's usage readings
// (`<data>/route-learning/usage-readings.json`) are in the route-learning retention class, are
// written owner-only, and each delete path removes them: `jevris data delete` (the learning scope
// and the whole data folder) and `jevris uninstall --delete-data`. A temporary home and HOME, a
// stand-in keychain and service manager: nothing real is touched.

const { runAdminCommand } = await import('../dist/admin-cli.js');
const { deleteJevrisData } = await import('../dist/uninstall.js');
const { jevrisPaths } = await import('@jevris/platform');
const { ROUTE_LEARNING_RETENTION } = await import('@jevris/store');
const core = await import('@jevris/core');

async function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'b-usage-delete-')));
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
  // One reading, recorded as the product records it: numbers only, uncertified, nothing exhausted.
  const nowMs = Date.now();
  const recorded = await core.recordAccessUsageReading({
    home,
    reading: { harness: 'codex', authMode: 'subscription', windows: [{ usedPercent: 40, windowMinutes: 300, resetsAtMs: nowMs + 3_600_000 }], ordinaryUsageAllowed: true, certified: false },
    nowMs,
  });
  assert.equal(recorded.ok, true, JSON.stringify(recorded));
  assert.equal(recorded.kept, true);
  const file = core.accessUsagePath(home);
  mkdirSync(paths.config, { recursive: true });
  const openKeyring = async () => ({ get: async () => null, set: async () => undefined, delete: async () => undefined });
  const serviceExec = () => ({ status: 0, stdout: '', stderr: '' });
  const run = async (args) => {
    let text = '';
    const code = await runAdminCommand(['data', 'delete', '--home', home, ...args], (chunk) => (text += chunk), { isTTY: false, openKeyring, serviceExec });
    return { code, text };
  };
  return { home, paths, file, run, nowMs };
}

test('the usage readings are where the retention class says, owner-only, and numbers only (OP-6)', async (t) => {
  const box = await fixture(t);
  assert.equal(box.file, join(box.paths.data, ROUTE_LEARNING_RETENTION.directory, 'usage-readings.json'));
  assert.equal(ROUTE_LEARNING_RETENTION.files.includes('usage-readings.json'), true);
  assert.equal(existsSync(box.file), true);
  if (process.platform !== 'win32') {
    assert.equal(statSync(box.file).mode & 0o777, 0o600, 'the file is 0600');
    assert.equal(statSync(join(box.paths.data, ROUTE_LEARNING_RETENTION.directory)).mode & 0o077, 0, 'its folder gives no group or other access');
  }
  const text = readFileSync(box.file, 'utf8');
  assert.equal(/usedPercent|windowMinutes|used_percent|resets_at/.test(text), false, 'the raw fields are not kept, only the band');
  assert.equal((await core.readAccessUsageReadings(box.home, box.nowMs)).readings.length, 1);
});

test('jevris data delete --scope learning removes the usage readings, and --dry-run keeps them (OP-6)', async (t) => {
  const box = await fixture(t);
  const dry = await box.run(['--scope', 'learning', '--dry-run', '--json']);
  assert.equal(JSON.parse(dry.text).ok, true, dry.text);
  assert.equal(existsSync(box.file), true, 'a dry run removes nothing');
  const done = await box.run(['--scope', 'learning', '--json']);
  assert.equal(JSON.parse(done.text).ok, true, done.text);
  assert.equal(existsSync(box.file), false);
  assert.deepEqual((await core.readAccessUsageReadings(box.home, box.nowMs)).readings, [], 'no reading survives the delete');
});

test('jevris data delete --scope data removes the usage readings with the data folder (OP-6)', async (t) => {
  const box = await fixture(t);
  const done = await box.run(['--scope', 'data', '--json']);
  assert.equal(JSON.parse(done.text).ok, true, done.text);
  assert.equal(existsSync(box.file), false);
});

test('jevris uninstall --delete-data removes the usage readings (deleteJevrisData, OP-6)', async (t) => {
  const box = await fixture(t);
  assert.deepEqual(await deleteJevrisData({ home: box.home }), { ok: true });
  assert.equal(existsSync(box.file), false);
});

test('removeAccessUsageReadings removes the file; a second call finds it already gone (OP-6)', async (t) => {
  const box = await fixture(t);
  assert.deepEqual(await core.removeAccessUsageReadings(box.home), { ok: true });
  assert.equal(existsSync(box.file), false);
  assert.deepEqual(await core.removeAccessUsageReadings(box.home), { ok: true });
});

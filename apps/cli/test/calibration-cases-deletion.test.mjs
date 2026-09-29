import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// C's local calibration cases (`<data>/route-learning/calibration-cases/<workspace>.json`, 01c1e29)
// follow the decision window in the retention sweep (B's CALIBRATION_CASES_RETENTION, the sidecar's
// file-retention test), and each delete path the class names removes them: `jevris data delete`
// (the learning scope and the whole data folder) and `jevris uninstall --delete-data` here, and
// `jevris route learning reset --clear-evidence` for one workspace in help-accuracy.test.mjs. A
// temporary home and HOME, a stand-in keychain and service manager: nothing real is touched.

const { runAdminCommand } = await import('../dist/admin-cli.js');
const { deleteJevrisData } = await import('../dist/uninstall.js');
const { jevrisPaths } = await import('@jevris/platform');
const { CALIBRATION_CASES_RETENTION } = await import('@jevris/store');
const core = await import('@jevris/core');

function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'b-cal-delete-')));
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
  const files = ['wCalA', 'wCalB'].map((id) => core.localCalibrationFile(home, id));
  mkdirSync(join(paths.data, CALIBRATION_CASES_RETENTION.directory), { recursive: true });
  for (const file of files) writeFileSync(file, '{}\n', { mode: 0o600 });
  mkdirSync(paths.config, { recursive: true });
  const openKeyring = async () => ({ get: async () => null, set: async () => undefined, delete: async () => undefined });
  const serviceExec = () => ({ status: 0, stdout: '', stderr: '' });
  const run = async (args) => {
    let text = '';
    const code = await runAdminCommand(['data', 'delete', '--home', home, ...args], (chunk) => (text += chunk), { isTTY: false, openKeyring, serviceExec });
    return { code, text };
  };
  return { home, paths, files, run };
}

test('the calibration cases file is where the retention class says (P4)', (t) => {
  const box = fixture(t);
  for (const file of box.files) assert.equal(file.startsWith(join(box.paths.data, CALIBRATION_CASES_RETENTION.directory)), true, file);
});

test('jevris data delete --scope learning removes every workspace\'s calibration cases, and --dry-run lists them without removing (P4)', async (t) => {
  const box = fixture(t);
  const dry = await box.run(['--scope', 'learning', '--dry-run', '--json']);
  assert.equal(JSON.parse(dry.text).ok, true, dry.text);
  for (const file of box.files) assert.equal(existsSync(file), true, 'a dry run removes nothing');
  const done = await box.run(['--scope', 'learning', '--json']);
  assert.equal(JSON.parse(done.text).ok, true, done.text);
  for (const file of box.files) assert.equal(existsSync(file), false, file);
});

test('jevris data delete --scope data removes the calibration cases with the data folder (P4)', async (t) => {
  const box = fixture(t);
  const done = await box.run(['--scope', 'data', '--json']);
  assert.equal(JSON.parse(done.text).ok, true, done.text);
  for (const file of box.files) assert.equal(existsSync(file), false, file);
});

test('jevris uninstall --delete-data removes the calibration cases (deleteJevrisData, P4)', async (t) => {
  const box = fixture(t);
  assert.deepEqual(await deleteJevrisData({ home: box.home }), { ok: true });
  for (const file of box.files) assert.equal(existsSync(file), false, file);
  assert.equal(existsSync(join(box.paths.data, CALIBRATION_CASES_RETENTION.directory)), false);
});

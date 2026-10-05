// Owner decision 0eb319de: the default mode is bounded-auto, the mode is the single ceiling
// (routing.managedWorkers never exceeds it; below bounded-auto the main session is advice-only),
// a raise of mode, routing.managedWorkers or routing.mainSession needs a person at a terminal
// (SR-19), an unusable user file caps the mode at observe (SR-20), and a user file that still
// says the old default (observe) moves to bounded-auto once per home.
// Temporary homes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { jevrisPaths } from '@jevris/platform';
import { AUTHORITY_KEYS, DEFAULT_CONFIG, raiseRefusal, raisesAuthority, FAIL_CLOSED_MODE, MODE_DEFAULT_MARKER, MODE_MIGRATION_NOTICE, migrateModeDefault, modeMigrationNotice, readEffectiveConfig, replaceUnusableUserFile, setConfigValue } from '../dist/index.js';
import { tempDir } from './temp-dirs.mjs';

function home(config) {
  const dir = tempDir('jv-mode-default-');
  const h = join(dir, 'home');
  const configDir = jevrisPaths({ home: h }).config;
  mkdirSync(configDir, { recursive: true });
  const file = join(configDir, 'jevris.config.json');
  if (config !== undefined) writeFileSync(file, typeof config === 'string' ? config : `${JSON.stringify(config, null, 2)}\n`);
  return { home: h, file, marker: join(jevrisPaths({ home: h }).state, MODE_DEFAULT_MARKER), read: () => JSON.parse(readFileSync(file, 'utf8')) };
}

const noEgress = async () => 'not-approved';
const statMode = (path) => statSync(path).mode & 0o777;

test('the default mode is bounded-auto; an unusable ceiling still fails closed to observe', () => {
  assert.equal(DEFAULT_CONFIG.mode, 'bounded-auto');
  assert.equal(FAIL_CLOSED_MODE, 'observe');
  const eff = readEffectiveConfig({ home: home().home });
  assert.equal(eff.config.mode, 'bounded-auto');
  assert.equal(eff.config.routing.mainSession, 'plugin-bounded-auto');
  assert.equal(eff.config.routing.managedWorkers, 'bounded-auto');
  assert.equal(eff.modeSource, 'defaults');
  const bad = home();
  writeFileSync(join(jevrisPaths({ home: bad.home }).config, 'host.json'), '{not json');
  assert.equal(readEffectiveConfig({ home: bad.home }).config.mode, 'observe');
});

test('the mode caps managed workers and, below bounded-auto, the main session', () => {
  const cases = { off: ['off', 'advice-only'], observe: ['observe', 'advice-only'], advise: ['advise', 'advice-only'], 'bounded-auto': ['bounded-auto', 'plugin-bounded-auto'] };
  for (const [mode, [workers, main]] of Object.entries(cases)) {
    const eff = readEffectiveConfig({ home: home({ ...DEFAULT_CONFIG, mode }).home });
    assert.deepEqual([eff.config.routing.managedWorkers, eff.config.routing.mainSession], [workers, main], mode);
    assert.equal(eff.modeSource, 'user');
    if (mode !== 'bounded-auto') assert.ok(eff.narrowed.some((n) => n.key === 'routing.mainSession' && n.layer === 'user'), `${mode}: the note names the layer that set the mode`);
  }
  // Lower settings stay as they are.
  const low = readEffectiveConfig({ home: home({ ...DEFAULT_CONFIG, mode: 'advise', routing: { ...DEFAULT_CONFIG.routing, managedWorkers: 'observe', mainSession: 'advice-only' } }).home });
  assert.deepEqual([low.config.routing.managedWorkers, low.narrowed.length], ['observe', 0]);
});

test('SR-19: configure set of a value above the effective one needs confirmed (a person at a terminal); lowering and the same value do not', async () => {
  // Owner decision 2026-09-29: the Jev decision budget is a spend key whose raise needs a person too.
  // Owner decision 2026-09-30: so is turning on background verification at Stop, and turning first-try routing back on.
  // Owner decision 2026-10-01: so is turning Jev assist back on.
  // JEV-0050: so is raising privacy.sourceEgress, your own half of the consent for what may leave the machine.
  assert.deepEqual([...AUTHORITY_KEYS].sort(), ['decisions.monthlyBudgetMicroUsd', 'jev.assist', 'mode', 'privacy.sourceEgress', 'routing.firstTry', 'routing.mainSession', 'routing.managedWorkers', 'verification.backgroundAtStop']);
  const h = home({ ...DEFAULT_CONFIG, mode: 'advise' });
  await migrateModeDefault({ home: h.home });
  assert.equal(raisesAuthority({ home: h.home }, 'mode', 'bounded-auto'), true);
  assert.equal(raisesAuthority({ home: h.home }, 'mode', 'advise'), false, 'the same value');
  assert.equal(raisesAuthority({ home: h.home }, 'mode', 'observe'), false, 'lowering');
  assert.equal(raisesAuthority({ home: h.home }, 'routing.mainSession', 'plugin-bounded-auto'), true, 'advice-only below bounded-auto');
  assert.equal(raisesAuthority({ home: h.home }, 'routing.mainSession', 'owned-sdk-approved'), false, 'an administrator value is refused by the setter, not asked');
  assert.equal(raisesAuthority({ home: h.home }, 'mode', 'nonsense'), false, 'not a value');
  assert.equal(raisesAuthority({ home: h.home }, 'orchestration.enabled', 'true'), false, 'not an authority key');
  for (const [key, value] of [['mode', 'bounded-auto'], ['routing.managedWorkers', 'bounded-auto'], ['routing.mainSession', 'plugin-bounded-auto']]) {
    for (const confirmed of [undefined, false]) {
      const refused = await setConfigValue({ home: h.home, key, value, dryRun: false, sourceEgress: noEgress, ...(confirmed === undefined ? {} : { confirmed }) });
      assert.deepEqual([refused.ok, refused.reasonCode, refused.message], [false, 'CHANNEL_REFUSED', raiseRefusal(key, value)], key);
    }
  }
  assert.deepEqual(h.read(), { ...DEFAULT_CONFIG, mode: 'advise' }, 'nothing was written');
  const dry = await setConfigValue({ home: h.home, key: 'mode', value: 'bounded-auto', dryRun: true, sourceEgress: noEgress });
  assert.equal(dry.effective.mode, 'bounded-auto', 'a dry run shows it');
  assert.equal(h.read().mode, 'advise');
  const done = await setConfigValue({ home: h.home, key: 'mode', value: 'bounded-auto', dryRun: false, confirmed: true, sourceEgress: noEgress });
  assert.equal(done.effective.mode, 'bounded-auto');
  assert.equal(h.read().mode, 'bounded-auto');
  const same = await setConfigValue({ home: h.home, key: 'mode', value: 'bounded-auto', dryRun: false, sourceEgress: noEgress });
  assert.deepEqual(same.changed, [], 'the same value is free');
  const lower = await setConfigValue({ home: h.home, key: 'mode', value: 'observe', dryRun: false, sourceEgress: noEgress });
  assert.equal(lower.effective.mode, 'observe');
  assert.equal(lower.effective.mainSession, 'advice-only');
  // An administrator ceiling counts: under organization observe, advise is a raise even though the file says bounded-auto.
  const org = home({ ...DEFAULT_CONFIG });
  await migrateModeDefault({ home: org.home });
  writeFileSync(join(jevrisPaths({ home: org.home }).config, 'organization.json'), JSON.stringify({ schemaVersion: '1.0', mode: 'observe', egress: 'deny-until-approved', retention: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 }, budget: { maxRequestBytes: 131072 }, pin: { model: 'jev-1.13.0', respectHumanPins: true }, packPrivileges: [], credentialRef: 'host-secret:typesafe-primary', installerEnvName: 'TYPESAFE_API_KEY', allowUncalibratedActuation: false }));
  assert.equal(raisesAuthority({ home: org.home }, 'mode', 'advise'), true);
});

test('SR-20: a present user file that cannot be read, parsed or validated caps the mode at observe with a user: issue; a missing file is the defaults', () => {
  const missing = readEffectiveConfig({ home: home().home });
  assert.deepEqual([missing.config.mode, missing.valid, missing.issues], ['bounded-auto', true, []]);
  const cases = [
    ['{not json', 'INVALID_JSON'],
    [{ ...DEFAULT_CONFIG, surprise: 1 }, 'INVALID_CONFIG'],
    [{ ...DEFAULT_CONFIG, mode: 'everything' }, 'INVALID_CONFIG'],
  ];
  for (const [content, code] of cases) {
    const h = home(content);
    const eff = readEffectiveConfig({ home: h.home });
    assert.deepEqual([eff.valid, eff.config.mode, eff.config.routing.managedWorkers, eff.config.routing.mainSession], [false, 'observe', 'observe', 'advice-only'], code);
    assert.ok(eff.issues.some((issue) => issue.path === 'user:' && issue.code === code), JSON.stringify(eff.issues));
    assert.ok(eff.narrowed.some((n) => n.layer === 'user' && n.key === 'mode'));
  }
  // A directory where the file should be.
  const dir = home();
  mkdirSync(dir.file);
  const notFile = readEffectiveConfig({ home: dir.home });
  assert.equal(notFile.config.mode, 'observe');
  assert.ok(notFile.issues.some((issue) => issue.path === 'user:' && issue.code === 'NOT_REGULAR'));
  // An unreadable file (skipped where permissions do not apply: Windows, or running as root).
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const locked = home({ ...DEFAULT_CONFIG, mode: 'bounded-auto' });
    chmodSync(locked.file, 0o000);
    try {
      const eff = readEffectiveConfig({ home: locked.home });
      assert.equal(eff.config.mode, 'observe');
      assert.ok(eff.issues.some((issue) => issue.path === 'user:' && issue.code === 'UNREADABLE'));
    } finally {
      chmodSync(locked.file, 0o600);
    }
  }
  // A lower layer never lifts the cap.
  const bad = home('{not json');
  assert.equal(readEffectiveConfig({ home: bad.home, workspaceRoot: null }).config.mode, 'observe');
});

// SR-23: replacing an unusable file never leaves no file behind, so the observe cap holds on every failure.
function assertStillCapped(h, original, why) {
  const eff = readEffectiveConfig({ home: h.home });
  assert.equal(eff.config.mode, 'observe', why);
  assert.equal(eff.valid, false, why);
  assert.equal(readFileSync(h.file, 'utf8'), original, `${why}: the unusable file is in place`);
  const dir = dirname(h.file);
  assert.deepEqual(readdirSync(dir).filter((name) => /\.(new|invalid-tmp|jtmp)$/.test(name)), [], `${why}: no temporary file is left`);
}

test('SR-23: a symlinked config folder is refused before anything is touched, and the mode stays at observe', { skip: process.platform === 'win32' ? 'symlinks need privileges on Windows; the folder refusal is injected below' : false }, async () => {
  const dir = tempDir('jv-sr23-link-');
  const home = join(dir, 'home');
  const real = join(dir, 'stow', 'jevris-config');
  mkdirSync(real, { recursive: true, mode: 0o700 });
  const configDir = jevrisPaths({ home }).config;
  mkdirSync(dirname(configDir), { recursive: true });
  symlinkSync(real, configDir, 'dir');
  const h = { home, file: join(configDir, 'jevris.config.json') };
  writeFileSync(h.file, '{not json');
  await migrateModeDefault({ home });
  assert.equal(readEffectiveConfig({ home }).config.mode, 'observe');
  const refused = await setConfigValue({ home, key: 'mode', value: 'off', dryRun: false, sourceEgress: noEgress });
  assert.equal(refused.reasonCode, 'CONFIG_DIR_REFUSED', JSON.stringify(refused));
  assert.ok(refused.message.includes('ESYMLINK') && refused.message.includes(h.file) && refused.message.includes('capped at observe'), refused.message);
  assert.equal(existsSync(`${h.file}.invalid`), false, 'nothing was moved');
  assertStillCapped(h, '{not json', 'symlinked folder');
});

test('SR-23: a folder that is not yours (or whose ACL cannot be set) is refused before anything is touched', async () => {
  for (const code of ['EOWNER', 'EACL']) {
    const h = home('{not json');
    await migrateModeDefault({ home: h.home });
    const seen = [];
    const refused = await replaceUnusableUserFile({ home: h.home, mode: 'off', sourceEgress: noEgress, ports: { ensureDir: async (dir) => (seen.push(dir), { ok: false, code }) } });
    assert.deepEqual(seen, [dirname(h.file)]);
    assert.equal(refused.reasonCode, 'CONFIG_DIR_REFUSED');
    assert.ok(refused.message.includes(code) && refused.message.includes(dirname(h.file)), refused.message);
    assert.equal(existsSync(`${h.file}.invalid`), false);
    assertStillCapped(h, '{not json', code);
  }
});

test('SR-23: a failed write keeps the unusable file in place; a failed move puts it back; the mode stays at observe', async () => {
  const fail = (code) => async () => ({ ok: false, code });
  // A regular file: kept as .invalid through a hard link, then the durable write over it fails (a full disk).
  const full = home('{not json');
  const written = await replaceUnusableUserFile({ home: full.home, mode: 'off', sourceEgress: noEgress, ports: { writeFile: fail('ENOSPC') } });
  assert.equal(written.reasonCode, 'CONFIG_WRITE_FAILED');
  assert.ok(written.message.includes('ENOSPC') && written.message.includes('still in place'), written.message);
  assertStillCapped(full, '{not json', 'write fails after the backup');
  // No hard links: the fresh file is staged, the bad one moved aside, and the move in fails: it is moved back.
  const noLink = () => {
    throw Object.assign(new Error('no hard links'), { code: 'EPERM' });
  };
  const moved = home('{not json');
  const moves = [];
  const rename = async (from, to) => {
    moves.push([from, to]);
    if (to === moved.file && from.endsWith('.new')) return { ok: false, code: 'EIO' };
    const { renameWithRetry } = await import('@jevris/platform');
    return renameWithRetry(from, to);
  };
  const back = await replaceUnusableUserFile({ home: moved.home, mode: 'observe', sourceEgress: noEgress, ports: { link: noLink, rename } });
  assert.equal(back.reasonCode, 'CONFIG_WRITE_FAILED');
  assert.ok(back.message.includes('EIO') && back.message.includes('back in place'), back.message);
  assert.deepEqual(moves.map(([from, to]) => [from === moved.file ? 'file' : from === `${moved.file}.invalid` ? 'invalid' : from.endsWith('.new') ? 'staged' : from, to === moved.file ? 'file' : to === `${moved.file}.invalid` ? 'invalid' : to]), [['file', 'invalid'], ['staged', 'file'], ['invalid', 'file']]);
  assertStillCapped(moved, '{not json', 'the move in fails');
  // No hard links and the staged write fails: nothing is moved.
  const staged = home('{not json');
  const stagedFail = await replaceUnusableUserFile({ home: staged.home, mode: 'off', sourceEgress: noEgress, ports: { link: noLink, writeFile: fail('EDQUOT') } });
  assert.equal(stagedFail.reasonCode, 'CONFIG_WRITE_FAILED');
  assertStillCapped(staged, '{not json', 'the staged write fails');
  // A folder in the file's place (not regular): the staged path, and a failed move aside changes nothing.
  const folder = home();
  mkdirSync(folder.file);
  const aside = await replaceUnusableUserFile({ home: folder.home, mode: 'off', sourceEgress: noEgress, ports: { rename: fail('EBUSY') } });
  assert.equal(aside.reasonCode, 'CONFIG_WRITE_FAILED');
  assert.equal(readEffectiveConfig({ home: folder.home }).config.mode, 'observe');
  assert.deepEqual(readdirSync(dirname(folder.file)).filter((name) => name.endsWith('.new')), []);
});

test('SR-23: the success paths replace the file, keep the unusable one as .invalid and leave no temporary file', async () => {
  // A regular file (the hard-link path), replacing an earlier .invalid.
  const h = home('{not json');
  writeFileSync(`${h.file}.invalid`, 'an earlier one');
  const done = await replaceUnusableUserFile({ home: h.home, mode: 'off', sourceEgress: noEgress });
  assert.equal(done.effective.mode, 'off', JSON.stringify(done));
  assert.deepEqual(h.read(), { ...DEFAULT_CONFIG, mode: 'off' });
  assert.equal(readFileSync(`${h.file}.invalid`, 'utf8'), '{not json');
  if (process.platform !== 'win32') assert.equal(statMode(h.file), 0o600);
  // No hard links: the staged path gives the same result.
  const noLinks = home('{not json');
  const staged = await replaceUnusableUserFile({ home: noLinks.home, mode: 'observe', sourceEgress: noEgress, ports: { link: () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); } } });
  assert.equal(staged.effective.mode, 'observe');
  assert.equal(readFileSync(`${noLinks.file}.invalid`, 'utf8'), '{not json');
  // A folder in the file's place moves aside whole.
  const folder = home();
  mkdirSync(folder.file);
  writeFileSync(join(folder.file, 'inside'), 'x');
  assert.equal((await replaceUnusableUserFile({ home: folder.home, mode: 'off', sourceEgress: noEgress })).effective.mode, 'off');
  assert.equal(readFileSync(join(`${folder.file}.invalid`, 'inside'), 'utf8'), 'x');
  for (const x of [h, noLinks, folder]) assert.deepEqual(readdirSync(dirname(x.file)).filter((name) => /\.(new|invalid-tmp|jtmp)$/.test(name)), []);
  rmSync(`${folder.file}.invalid`, { recursive: true, force: true });
});

test('SR-20: configure set refuses writes to an unusable file naming it and the fix; configure set mode off or observe replaces it', async () => {
  const h = home('{not json');
  await migrateModeDefault({ home: h.home });
  const other = await setConfigValue({ home: h.home, key: 'orchestration.maxConcurrentWorkers', value: '4', dryRun: false, sourceEgress: noEgress });
  assert.equal(other.ok, false);
  assert.equal(other.reasonCode, 'CONFIG_INVALID');
  assert.ok(other.message.includes(h.file) && other.message.includes('jevris configure set mode off'), other.message);
  assert.equal(readFileSync(h.file, 'utf8'), '{not json', 'nothing was written');
  // advise raises the capped observe: refused without a person, and with one it still is not written.
  assert.equal((await setConfigValue({ home: h.home, key: 'mode', value: 'advise', dryRun: false, sourceEgress: noEgress })).reasonCode, 'CHANNEL_REFUSED');
  assert.equal((await setConfigValue({ home: h.home, key: 'mode', value: 'advise', dryRun: false, confirmed: true, sourceEgress: noEgress })).reasonCode, 'CONFIG_INVALID');
  // A dry run of mode off shows the refusal and moves nothing.
  assert.equal((await setConfigValue({ home: h.home, key: 'mode', value: 'off', dryRun: true, sourceEgress: noEgress })).reasonCode, 'CONFIG_INVALID');
  assert.equal(existsSync(`${h.file}.invalid`), false);
  const off = await setConfigValue({ home: h.home, key: 'mode', value: 'off', dryRun: false, sourceEgress: noEgress });
  assert.equal(off.ok, undefined, JSON.stringify(off));
  assert.equal(off.effective.mode, 'off');
  assert.equal(readFileSync(`${h.file}.invalid`, 'utf8'), '{not json');
  assert.deepEqual(h.read(), { ...DEFAULT_CONFIG, mode: 'off' });
  assert.equal(readEffectiveConfig({ home: h.home }).valid, true);
  const obs = home({ ...DEFAULT_CONFIG, surprise: 1 });
  await migrateModeDefault({ home: obs.home });
  assert.equal((await setConfigValue({ home: obs.home, key: 'mode', value: 'observe', dryRun: false, sourceEgress: noEgress })).effective.mode, 'observe');
  assert.deepEqual(obs.read(), { ...DEFAULT_CONFIG, mode: 'observe' });
});

test('migration: a user file saying observe (the old default) moves to bounded-auto once, keeping every other key', async () => {
  const written = { ...DEFAULT_CONFIG, mode: 'observe', orchestration: { ...DEFAULT_CONFIG.orchestration, maxConcurrentWorkers: 3 } };
  const h = home(written);
  assert.equal(await migrateModeDefault({ home: h.home }), 'migrated');
  assert.deepEqual(h.read(), { ...written, mode: 'bounded-auto' });
  assert.ok(existsSync(h.marker));
  // An observe set after the migration is the person's choice and stays.
  writeFileSync(h.file, JSON.stringify({ ...written, mode: 'observe' }));
  assert.equal(await migrateModeDefault({ home: h.home }), 'already-done');
  assert.equal(h.read().mode, 'observe');
});

test('migration: other modes, no file and an invalid file', async () => {
  for (const mode of ['off', 'advise', 'bounded-auto']) {
    const h = home({ ...DEFAULT_CONFIG, mode });
    assert.equal(await migrateModeDefault({ home: h.home }), 'unchanged', mode);
    assert.equal(h.read().mode, mode);
  }
  const none = home();
  assert.equal(await migrateModeDefault({ home: none.home }), 'unchanged');
  assert.equal(existsSync(none.file), false, 'no file is created');
  assert.ok(existsSync(none.marker));
  const invalid = home('{"mode": "observe"');
  assert.equal(await migrateModeDefault({ home: invalid.home }), 'not-now');
  assert.equal(existsSync(invalid.marker), false, 'an invalid file is retried after it is fixed');
});

test('configure set runs the migration first, so an old observe file does not survive an unrelated change', async () => {
  const h = home({ ...DEFAULT_CONFIG, mode: 'observe' });
  const out = await setConfigValue({ home: h.home, key: 'orchestration.maxConcurrentWorkers', value: '3', dryRun: false, sourceEgress: noEgress });
  assert.equal(out.effective.mode, 'bounded-auto');
  assert.deepEqual([h.read().mode, h.read().orchestration.maxConcurrentWorkers], ['bounded-auto', 3]);
  // A dry run writes nothing, the migration included.
  const dry = home({ ...DEFAULT_CONFIG, mode: 'observe' });
  await setConfigValue({ home: dry.home, key: 'orchestration.maxConcurrentWorkers', value: '3', dryRun: true, sourceEgress: noEgress });
  assert.equal(dry.read().mode, 'observe');
  assert.equal(existsSync(dry.marker), false);
});

test('notice: a moved mode is written as a fact, shown for 30 days, and ends at any configure set mode', async () => {
  const DAY = 86_400_000;
  const at = Date.UTC(2026, 8, 28);
  const h = home({ ...DEFAULT_CONFIG, mode: 'observe' });
  assert.equal(await migrateModeDefault({ home: h.home, nowMs: at }), 'migrated');
  const marker = JSON.parse(readFileSync(h.marker, 'utf8'));
  assert.deepEqual(marker, { migration: 'mode-default-bounded-auto', outcome: 'migrated', from: 'observe', to: 'bounded-auto', atMs: at, noticeCleared: false });
  assert.equal(MODE_MIGRATION_NOTICE, 'Mode moved from observe (the old default) to bounded-auto by the 1.2 upgrade; run `jevris configure set mode observe` to go back.');
  assert.equal(modeMigrationNotice({ home: h.home, nowMs: at + DAY }), MODE_MIGRATION_NOTICE);
  assert.equal(modeMigrationNotice({ home: h.home, nowMs: at + 29 * DAY }), MODE_MIGRATION_NOTICE);
  assert.equal(modeMigrationNotice({ home: h.home, nowMs: at + 30 * DAY }), null, 'shown for 30 days at most');
  // Another key does not end it; a dry run of the mode does not either; any real set of the mode does.
  await setConfigValue({ home: h.home, key: 'orchestration.maxConcurrentWorkers', value: '3', dryRun: false, sourceEgress: noEgress });
  await setConfigValue({ home: h.home, key: 'mode', value: 'observe', dryRun: true, sourceEgress: noEgress });
  assert.equal(modeMigrationNotice({ home: h.home, nowMs: at + DAY }), MODE_MIGRATION_NOTICE);
  await setConfigValue({ home: h.home, key: 'mode', value: 'bounded-auto', dryRun: false, confirmed: true, sourceEgress: noEgress });
  assert.equal(modeMigrationNotice({ home: h.home, nowMs: at + DAY }), null);
  assert.equal(JSON.parse(readFileSync(h.marker, 'utf8')).from, 'observe', 'the fact stays');
  // Nothing moved, nothing to say.
  for (const config of [undefined, { ...DEFAULT_CONFIG, mode: 'advise' }]) {
    const other = home(config);
    await migrateModeDefault({ home: other.home, nowMs: at });
    assert.equal(modeMigrationNotice({ home: other.home, nowMs: at + DAY }), null);
  }
});

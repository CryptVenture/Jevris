// B's MEDIUM 41 and the coordinator's rule per cause: recording never writes over a record it could
// not read. A transient read error or a newer record refuses (ACCESS_LIMITS_UNREADABLE) and leaves
// the file as it is; a damaged file is set aside (at most 3 kept) and a new record is written.
// B's LOW 42: a lift that wrote nothing says why. SR-16: the record is read without following a
// link, and only a later schema of its own family counts as newer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const core = await import('../dist/index.js');
const contracts = await import('@jevris/contracts');
const {
  classifyAccessSignal, recordAccessLimit, readAccessLimits, clearAccessLimits, removeAccessLimits, resetMachineLearning, accessLimitsPath,
  accessLimitsSetAside, recordAccessUsageReading, liftUsageWindows, recordAccessSuccess, ACCESS_LIMITS_SET_ASIDE_MAX,
} = core;

// pinned-clock: every record here is stamped at this fixed time.
const T = Date.parse('2026-09-28T12:00:00Z');
const MIN = 60_000;
const H = 3_600_000;

async function tempHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'jevris-unreadable-'));
  t.after(async () => {
    await chmod(accessLimitsPath(home), 0o700).catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  });
  return home;
}

const codex = (authMode = 'subscription') => ({ harness: 'codex', authMode, servingHost: 'openai', modelId: 'gpt-5.5', family: null });
const txt = (text) => ({ port: 'codex', channel: 'error-text', certified: false, text: contracts.matchAccessText(text, 'codex', T) });
const windowHit = () => classifyAccessSignal(txt("You've hit your usage limit."), 'subscription', T);
const credit = () => classifyAccessSignal({ port: 'opencode', channel: 'structured', certified: false, errorType: 'APIError', status: 402 }, 'api-key', T);
const zai = { harness: 'opencode', authMode: 'api-key', servingHost: 'zai', modelId: null, family: null };

/** A readable record holding an untimed credit pause (only a person clears it) and a timed window. */
async function seeded(t) {
  const home = await tempHome(t);
  assert.equal((await recordAccessLimit({ home, scope: zai, classification: credit(), source: 'session', nowMs: T })).entry.untilMs, null);
  assert.equal((await recordAccessLimit({ home, scope: codex(), classification: windowHit(), source: 'owned-run', nowMs: T })).ok, true);
  return home;
}

const asideNames = async (home) => (await readdir(dirname(accessLimitsPath(home)))).filter((n) => n.startsWith('access-limits.json.damaged-')).sort();

test('a newer record (a rollback after an upgrade) is never written over or downgraded: every writer refuses', async (t) => {
  const home = await seeded(t);
  const original = JSON.parse(await readFile(accessLimitsPath(home), 'utf8'));
  for (const schemaVersion of ['jevris-access-limits-2', 'jevris-access-limits-17']) {
    const bytes = JSON.stringify({ ...original, schemaVersion });
    await writeFile(accessLimitsPath(home), bytes);
    const read = await readAccessLimits(home);
    assert.deepEqual([read.readable, read.unreadable, read.entries.length], [false, 'newer', 0]);
    assert.deepEqual(await recordAccessLimit({ home, scope: codex(), classification: windowHit(), source: 'owned-run', nowMs: T + MIN }), { ok: false, reasonCode: 'ACCESS_LIMITS_UNREADABLE' });
    const usage = await recordAccessUsageReading({ home, reading: { harness: 'codex', authMode: 'subscription', windows: [{ usedPercent: 100, windowMinutes: 300, resetsAtMs: T + 2 * H }], ordinaryUsageAllowed: false, certified: false }, nowMs: T + MIN });
    assert.deepEqual(usage, { ok: false, reasonCode: 'ACCESS_LIMITS_UNREADABLE' });
    // LOW 42: a lift that wrote nothing gives the real code, not LOCK_BUSY.
    assert.deepEqual(await liftUsageWindows(home, codex(), T + H), { ok: false, cleared: [], reasonCode: 'ACCESS_LIMITS_UNREADABLE' });
    assert.equal((await recordAccessSuccess(home, codex(), T + H)).ok, true, 'nothing it can read to clear');
    assert.equal(await readFile(accessLimitsPath(home), 'utf8'), bytes, `${schemaVersion}: the bytes survive`);
    assert.deepEqual(await asideNames(home), [], 'a newer record is not set aside');
  }
});

test('SR-16: only a later schema of the family is newer; any other schemaVersion is damage, so one crafted file cannot stop recording for good', async (t) => {
  const home = await seeded(t);
  const original = JSON.parse(await readFile(accessLimitsPath(home), 'utf8'));
  for (const schemaVersion of ['future', 'jevris-access-limits-1x', 'jevris-access-limits-0', 'jevris-access-limits-01', 'other-access-limits-2']) {
    await writeFile(accessLimitsPath(home), JSON.stringify({ ...original, schemaVersion }), { mode: 0o600 });
    assert.equal((await readAccessLimits(home)).unreadable, 'damaged', schemaVersion);
    const out = await recordAccessLimit({ home, scope: codex(), classification: windowHit(), source: 'owned-run', nowMs: T + MIN });
    assert.deepEqual([out.ok, out.setAside], [true, true], `${schemaVersion}: set aside and recording goes on`);
    assert.equal((await readAccessLimits(home)).readable, true);
  }
});

test('SR-16: the record is never read through a symbolic link: a link is damage, set aside, and replaced by a regular file; its target is untouched', { skip: process.platform === 'win32' ? 'symlinks need privileges on Windows' : false }, async (t) => {
  const home = await seeded(t);
  const target = join(home, 'elsewhere.json');
  const bytes = await readFile(accessLimitsPath(home), 'utf8');
  await writeFile(target, bytes, { mode: 0o600 });
  await rm(accessLimitsPath(home));
  await symlink(target, accessLimitsPath(home));
  const read = await readAccessLimits(home);
  assert.deepEqual([read.readable, read.unreadable, read.entries.length], [false, 'damaged', 0], 'the pauses behind the link are not read');
  const out = await recordAccessLimit({ home, scope: codex(), classification: windowHit(), source: 'owned-run', nowMs: T + MIN });
  assert.deepEqual([out.ok, out.setAside], [true, true]);
  assert.equal((await lstat(accessLimitsPath(home))).isSymbolicLink(), false, 'a regular file replaces the link');
  assert.equal(await readFile(target, 'utf8'), bytes, 'the link target is not written');
});

test('a transient read error (not ENOENT) never turns into data loss: the record refuses and nothing moves', async (t) => {
  // A real non-ENOENT fs error: the record path is a directory (EISDIR on every OS).
  const home = await tempHome(t);
  await mkdir(join(accessLimitsPath(home), 'inside'), { recursive: true });
  const read = await readAccessLimits(home);
  assert.deepEqual([read.readable, read.unreadable], [false, 'transient']);
  assert.deepEqual(await recordAccessLimit({ home, scope: codex(), classification: windowHit(), source: 'owned-run', nowMs: T }), { ok: false, reasonCode: 'ACCESS_LIMITS_UNREADABLE' });
  assert.ok((await stat(join(accessLimitsPath(home), 'inside'))).isDirectory(), 'not renamed, not replaced');
  assert.deepEqual(await asideNames(home), []);
  // EACCES on a readable record, where the OS enforces it (not Windows, not root).
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const kept = await seeded(t);
    const bytes = await readFile(accessLimitsPath(kept));
    await chmod(accessLimitsPath(kept), 0o000);
    assert.equal((await readAccessLimits(kept)).unreadable, 'transient');
    assert.deepEqual(await recordAccessLimit({ home: kept, scope: codex(), classification: windowHit(), source: 'owned-run', nowMs: T + MIN }), { ok: false, reasonCode: 'ACCESS_LIMITS_UNREADABLE' });
    await chmod(accessLimitsPath(kept), 0o600);
    assert.deepEqual(await readFile(accessLimitsPath(kept)), bytes, 'the untimed pause survives');
    assert.equal((await readAccessLimits(kept)).entries.length, 2);
  }
});

test('a damaged record is set aside with its bytes, a new one is written, at most 3 are kept, and a clear removes them', async (t) => {
  const home = await seeded(t);
  const damaged = ['{not json', '[]', '{"entries":[]}', 'x'.repeat(70_000), '{"schemaVersion":1}'];
  for (const [i, body] of damaged.entries()) {
    await writeFile(accessLimitsPath(home), body, { mode: 0o600 });
    assert.equal((await readAccessLimits(home)).unreadable, 'damaged', `case ${i}`);
    const out = await recordAccessLimit({ home, scope: codex(), classification: windowHit(), source: 'owned-run', nowMs: T + i * MIN });
    assert.deepEqual([out.ok, out.setAside, out.outcome], [true, true, 'new'], `case ${i}`);
    const read = await readAccessLimits(home);
    assert.deepEqual([read.readable, read.entries.length], [true, 1]);
    const names = await asideNames(home);
    assert.equal(await readFile(join(dirname(accessLimitsPath(home)), names[names.length - 1]), 'utf8'), body, 'the damaged bytes are kept aside');
  }
  const names = await asideNames(home);
  assert.equal(ACCESS_LIMITS_SET_ASIDE_MAX, 3);
  assert.deepEqual(names, [2, 3, 4].map((i) => `access-limits.json.damaged-${String(T + i * MIN)}`), 'the oldest go first');
  if (process.platform !== 'win32') {
    for (const n of names) assert.equal((await stat(join(dirname(accessLimitsPath(home)), n))).mode & 0o777, 0o600);
  }
  assert.deepEqual(await accessLimitsSetAside(home), { count: 3, latestMs: T + 4 * MIN });
  // A readable record records normally: nothing more is set aside.
  const next = await recordAccessLimit({ home, scope: zai, classification: credit(), source: 'session', nowMs: T + 10 * MIN });
  assert.deepEqual([next.ok, next.setAside], [true, false]);
  // A person's clear --all removes the set-aside files too; so does reset --machine.
  assert.equal((await clearAccessLimits(home, { entries: 'all', nowMs: T })).ok, true);
  assert.deepEqual(await accessLimitsSetAside(home), { count: 0, latestMs: null });
  await writeFile(accessLimitsPath(home), '{not json');
  await recordAccessLimit({ home, scope: codex(), classification: windowHit(), source: 'owned-run', nowMs: T + 20 * MIN });
  assert.equal((await accessLimitsSetAside(home)).count, 1);
  assert.equal((await removeAccessLimits(home)).ok, true);
  assert.deepEqual(await accessLimitsSetAside(home), { count: 0, latestMs: null });
  await writeFile(accessLimitsPath(home), '{not json');
  await recordAccessLimit({ home, scope: codex(), classification: windowHit(), source: 'owned-run', nowMs: T + 30 * MIN });
  assert.equal((await resetMachineLearning(home)).ok, true);
  assert.deepEqual(await accessLimitsSetAside(home), { count: 0, latestMs: null });
  await assert.rejects(stat(accessLimitsPath(home)), { code: 'ENOENT' });
});

test('a damaged record clears only through clear --all; a keyed clear or a lift says it is unreadable', async (t) => {
  const home = await tempHome(t);
  await mkdir(dirname(accessLimitsPath(home)), { recursive: true });
  await writeFile(accessLimitsPath(home), '{not json');
  assert.deepEqual(await clearAccessLimits(home, { entries: ['0000000000000000'], nowMs: T }), { ok: false, cleared: [] });
  assert.equal(await readFile(accessLimitsPath(home), 'utf8'), '{not json');
  assert.deepEqual(await liftUsageWindows(home, codex(), T + H), { ok: false, cleared: [], reasonCode: 'ACCESS_LIMITS_UNREADABLE' });
  assert.deepEqual(await clearAccessLimits(home, { entries: 'all', nowMs: T }), { ok: true, cleared: [] });
  assert.equal((await readAccessLimits(home)).readable, true);
});

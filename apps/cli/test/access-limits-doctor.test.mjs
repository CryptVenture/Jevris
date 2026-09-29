// Coordinator's gap 5 (D's access trace; access limits design 6.3): doctor lists each access pause
// in force from the machine record, read-only: class, scope, when it lifts or how it clears, and
// whether it is weekly, in the words of `jevris route limits`. No fingerprint, no remote text. A
// timed pause is info, an untimed one or an unreadable record is action, never broken.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const { accessLimitsDoctorLines, accessLimitsDoctorLinesFrom } = await import('../dist/access-limits-doctor.js');
const { doctorLineSeverity } = await import('../dist/doctor-severity.js');
const core = await import('../../../packages/core/dist/index.js');
const contracts = await import('../../../packages/contracts/dist/index.js');

const T = Date.parse('2026-09-28T12:00:00Z');
const H = 3_600_000;

async function home(t) {
  const dir = await mkdtemp(join(tmpdir(), 'jevris-limits-doctor-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('doctor lists each pause in force with its class, scope and how it clears; nothing in force is ok', async (t) => {
  const h = await home(t);
  const none = await accessLimitsDoctorLines(h, T);
  assert.deepEqual(none, ['accessLimits: none in force']);
  assert.equal(doctorLineSeverity(none[0]), 'ok');

  const windowSignal = { port: 'codex', channel: 'error-text', certified: false, text: contracts.matchAccessText("You've hit your usage limit.", 'codex', T) };
  const creditSignal = { port: 'kilocode', channel: 'structured', certified: false, errorType: 'APIError', status: 402 };
  assert.equal((await core.recordAccessLimit({ home: h, scope: { harness: 'codex', authMode: 'subscription', servingHost: 'openai', modelId: 'gpt-5.5', family: null }, classification: core.classifyAccessSignal(windowSignal, 'subscription', T), source: 'owned-run', nowMs: T })).ok, true);
  const before = await readFile(core.accessLimitsPath(h), 'utf8');
  const timedOnly = await accessLimitsDoctorLines(h, T + H);
  assert.deepEqual(timedOnly, [
    'accessLimits: 1 in force (jevris route limits lists them; clear one there at an interactive terminal)',
    'accessLimit codex subscription openai: usage-window until 2026-09-28T17:00Z (rule) (owned-run)',
  ]);
  assert.deepEqual(timedOnly.map(doctorLineSeverity), ['info', 'info'], 'a timed pause lifts by itself');

  assert.equal((await core.recordAccessLimit({ home: h, scope: { harness: 'kilocode', authMode: 'api-key', servingHost: 'openrouter', modelId: null, family: null }, classification: core.classifyAccessSignal(creditSignal, 'api-key', T), source: 'session', nowMs: T })).ok, true);
  const both = await accessLimitsDoctorLines(h, T + H);
  assert.equal(both[0], 'accessLimits: 2 in force, 1 untimed (jevris route limits lists them; clear one there at an interactive terminal)');
  const credit = both.find((l) => l.includes('credit-exhausted'));
  assert.equal(credit, 'accessLimit kilocode api-key openrouter: credit-exhausted since 2026-09-28T12:00Z; clears with jevris route limits clear (session)');
  assert.equal(doctorLineSeverity(credit), 'action', 'an untimed pause needs the person');
  assert.equal(doctorLineSeverity(both[0]), 'action');
  assert.ok(both.every((l) => doctorLineSeverity(l) !== 'broken'));
  assert.ok(both.every((l) => !/fingerprint|[0-9a-f]{16}/.test(l)), 'no key or fingerprint');

  // After the window's reset only the credit stop is listed; doctor never rewrites the record.
  assert.equal((await accessLimitsDoctorLines(h, T + 6 * H)).length, 2);
  assert.notEqual(before, await readFile(core.accessLimitsPath(h), 'utf8'), 'the second record changed it');
  const after = await readFile(core.accessLimitsPath(h), 'utf8');
  await accessLimitsDoctorLines(h, T + 30 * 24 * H);
  assert.equal(await readFile(core.accessLimitsPath(h), 'utf8'), after, 'read-only: nothing pruned');
});

test('an unreadable record is action with its code and the fix; never broken', async (t) => {
  const h = await home(t);
  await mkdir(dirname(core.accessLimitsPath(h)), { recursive: true });
  await writeFile(core.accessLimitsPath(h), '{not json');
  const lines = await accessLimitsDoctorLines(h, T);
  assert.deepEqual(lines, ['accessLimits: the record could not be read (ACCESS_LIMITS_UNREADABLE), so it pauses nothing; the next pause recorded sets it aside, or jevris route limits clear --all, at an interactive terminal, rewrites it empty']);
  assert.equal(doctorLineSeverity(lines[0]), 'action');
});

test('B MEDIUM 41: a newer record says it is left untouched (action); a read that failed this time is info; a set-aside record is action', async (t) => {
  const h = await home(t);
  await mkdir(dirname(core.accessLimitsPath(h)), { recursive: true });
  await writeFile(core.accessLimitsPath(h), JSON.stringify({ schemaVersion: 'jevris-access-limits-9', entries: [] }));
  const newer = await accessLimitsDoctorLines(h, T);
  assert.deepEqual(newer, ['accessLimits: the record was written by a newer Jevris (ACCESS_LIMITS_UNREADABLE); it is left untouched, it pauses nothing here, and nothing new is recorded until Jevris is upgraded or jevris route limits clear --all, at an interactive terminal, rewrites it empty']);
  assert.equal(doctorLineSeverity(newer[0]), 'action');

  const transient = accessLimitsDoctorLinesFrom({ entries: [], readable: false, unreadable: 'transient', full: false }, T);
  assert.deepEqual(transient, ['accessLimits: the record could not be read this time (ACCESS_LIMITS_UNREADABLE); nothing was changed, and it pauses nothing until it reads again']);
  assert.equal(doctorLineSeverity(transient[0]), 'info');

  // A damaged record is set aside by the next pause recorded; doctor then names the set-aside file.
  const h2 = await home(t);
  await mkdir(dirname(core.accessLimitsPath(h2)), { recursive: true });
  await writeFile(core.accessLimitsPath(h2), '{not json');
  const creditSignal = { port: 'kilocode', channel: 'structured', certified: false, errorType: 'APIError', status: 402 };
  const recorded = await core.recordAccessLimit({ home: h2, scope: { harness: 'kilocode', authMode: 'api-key', servingHost: 'openrouter', modelId: null, family: null }, classification: core.classifyAccessSignal(creditSignal, 'api-key', T), source: 'session', nowMs: T });
  assert.equal(recorded.ok, true);
  const lines = await accessLimitsDoctorLines(h2, T + H);
  const aside = lines.find((l) => l.startsWith('accessLimits set aside:'));
  assert.equal(aside, 'accessLimits set aside: a damaged access-limit record was set aside (latest 2026-09-28T12:00Z); pauses recorded before it may be missing; jevris route limits clear --all, at an interactive terminal, or jevris route learning reset --machine removes them');
  assert.equal(doctorLineSeverity(aside), 'action');
  assert.equal(lines[0], 'accessLimits: 1 in force, 1 untimed (jevris route limits lists them; clear one there at an interactive terminal)');
  assert.match(accessLimitsDoctorLinesFrom({ entries: [], readable: true, full: false }, T, { count: 3, latestMs: T })[1], /^accessLimits set aside: 3 damaged access-limit records were set aside \(latest 2026-09-28T12:00Z\);/);
});

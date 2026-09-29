// OP-6 (owner decision 9deb30c8; C2's dc4808b5 core): status carries the last Codex usage reading
// per sign-in as an optional `accessUsage` (bands, weekly flags, resets, whether usage is allowed),
// never a percentage, the payload or text; status and doctor show one line each in core's words.
// A temp home only: nothing reads a real harness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const { accessUsageStatusLines } = await import('../dist/public/render.js');
const { accessUsageDoctorLines } = await import('../dist/access-limits-doctor.js');
const { doctorLineSeverity } = await import('../dist/doctor-severity.js');
const core = await import('../../../packages/core/dist/index.js');
const { AccessUsageStatusSchema, StatusPayloadSchema, ACCESS_USAGE_STATUS_MAX_READINGS, defineContract, jsonSchemaOf } = await import('../../../packages/contracts/dist/index.js');

const View = defineContract({ name: 'AccessUsageStatusTest', description: 'test', schema: AccessUsageStatusSchema });
const T = Date.parse('2026-09-28T12:00:00Z');
const H = 3_600_000;

const reading = {
  harness: 'codex',
  authMode: 'subscription',
  readAt: '2026-09-28T12:00:00.000Z',
  allowed: true,
  windows: [
    { weekly: false, band: '80-100', resetsAt: '2026-09-28T17:00:00.000Z' },
    { weekly: true, band: 'under-50', resetsAt: null },
  ],
};

test('the status contract takes an optional, nullable accessUsage of bands only, and refuses anything more', () => {
  const status = jsonSchemaOf(StatusPayloadSchema);
  assert.ok('accessUsage' in status.properties);
  assert.equal(status.required.includes('accessUsage'), false);
  const view = { readable: true, readings: [reading, { ...reading, authMode: 'api-key', allowed: null, windows: [] }] };
  assert.equal(View.validate(view).ok, true);
  assert.equal(View.validate({ readable: false, readings: [] }).ok, true);
  const refused = [
    { ...view, readings: [{ ...reading, harness: 'claude' }] },
    { ...view, readings: [{ ...reading, usedPercent: 91 }] },
    { ...view, readings: [{ ...reading, payload: {} }] },
    { ...view, readings: [{ ...reading, readAt: 1_790_000_000_000 }] },
    { ...view, readings: [{ ...reading, allowed: 'yes' }] },
    { ...view, readings: [{ ...reading, windows: [{ ...reading.windows[0], band: '91%' }] }] },
    { ...view, readings: [{ ...reading, windows: [{ ...reading.windows[0], usedPercent: 91 }] }] },
    { ...view, readings: [{ ...reading, windows: [...reading.windows, reading.windows[0]] }] },
    { ...view, readings: Array.from({ length: ACCESS_USAGE_STATUS_MAX_READINGS + 1 }, () => reading) },
    { ...view, text: 'x' },
  ];
  for (const r of refused) assert.equal(View.validate(r).ok, false, JSON.stringify(r).slice(0, 140));
});

test('status shows one line per reading in core words, "usage not allowed" first when it said so, and the unreadable note', () => {
  assert.deepEqual(accessUsageStatusLines({ readable: true, readings: [reading, { ...reading, authMode: 'api-key', allowed: false, windows: [{ weekly: false, band: 'exhausted', resetsAt: '2026-09-28T13:30:00.000Z' }] }] }), [
    "usage readings (the harness's own account windows):",
    '  codex subscription: short window 80-100% used (resets 2026-09-28T17:00Z); weekly window under 50% used (read 2026-09-28T12:00Z)',
    '  codex api-key: usage not allowed; short window used up (resets 2026-09-28T13:30Z) (read 2026-09-28T12:00Z)',
  ]);
  assert.deepEqual(accessUsageStatusLines({ readable: true, readings: [] }), []);
  // An unvalidated time never throws: the reading is skipped, or its reset reads as none (B's nit).
  assert.deepEqual(accessUsageStatusLines({ readable: true, readings: [{ ...reading, readAt: 'not a time' }] }), []);
  assert.deepEqual(accessUsageStatusLines({ readable: true, readings: [{ ...reading, windows: [{ weekly: false, band: '50-80', resetsAt: 'soon' }] }] }), [
    "usage readings (the harness's own account windows):",
    '  codex subscription: short window 50-80% used (read 2026-09-28T12:00Z)',
  ]);
  assert.deepEqual(accessUsageStatusLines({ readable: false, readings: [] }), ['usage readings: the file could not be read (ACCESS_USAGE_UNREADABLE), so it pauses and lifts nothing']);
});

test('doctor reads the kept readings read-only: a line each, action for a used-up window or usage not allowed, nothing when none', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'jevris-usage-doctor-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.deepEqual(await accessUsageDoctorLines(home, T), []);

  const recorded = await core.recordAccessUsageReading({
    home,
    reading: { harness: 'codex', authMode: 'subscription', windows: [{ usedPercent: 63, windowMinutes: 300, resetsAtMs: T + 2 * H }, { usedPercent: 12, windowMinutes: 10_080, resetsAtMs: null }], ordinaryUsageAllowed: true, certified: false },
    nowMs: T,
  });
  assert.equal(recorded.ok, true);
  const calm = await accessUsageDoctorLines(home, T + 60_000);
  assert.deepEqual(calm, ['accessUsage codex subscription: short window 50-80% used (resets 2026-09-28T14:00Z); weekly window under 50% used (read 2026-09-28T12:00Z)']);
  assert.equal(doctorLineSeverity(calm[0]), 'info');
  assert.doesNotMatch(calm[0], /63|12%/, 'never the percentage');

  await core.recordAccessUsageReading({ home, reading: { harness: 'codex', authMode: 'api-key', windows: [{ usedPercent: 100, windowMinutes: 300, resetsAtMs: T + H }], ordinaryUsageAllowed: false, certified: false }, nowMs: T + 120_000 });
  const lines = await accessUsageDoctorLines(home, T + 180_000);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], 'accessUsage codex api-key: usage not allowed; short window used up (resets 2026-09-28T13:00Z) (read 2026-09-28T12:02Z)');
  assert.deepEqual(lines.map(doctorLineSeverity), ['action', 'info']);
  assert.equal(doctorLineSeverity('accessUsage codex subscription: short window used up (read 2026-09-28T12:00Z)'), 'action');

  const path = core.accessUsagePath(home);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '{not json');
  const broken = await accessUsageDoctorLines(home, T);
  assert.deepEqual(broken, ['accessUsage: the readings file could not be read (ACCESS_USAGE_UNREADABLE), so it pauses and lifts nothing']);
  assert.equal(doctorLineSeverity(broken[0]), 'info');
});

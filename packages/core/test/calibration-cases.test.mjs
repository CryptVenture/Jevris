import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// P4 local calibration cases (owner decision 7922ee3): a decision's per-question provider
// probability joined with its task's verified outcome, for a person to review. Never applied.
const core = await import('@jevris/core');
const { buildLocalCalibrationCases, writeLocalCalibrationCases, removeLocalCalibrationCases, localCalibrationFile, localCalibrationLines, answerProbabilities, LOCAL_CALIBRATION_SCHEMA } = core;

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-calibration-cases-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const NOW = Date.UTC(2026, 8, 27); // pinned-clock: a fixed export time
function row(decisionId, extra = {}) {
  return { decisionId, kind: 'task-profile', decisionOutcome: 'advisory', providerCalls: 1, label: 'verified-pass', joinBasis: 'task', labelledAtMs: 10, ...extra };
}
function record(decisionId, extra = {}) {
  return {
    decisionId, specId: 'task-profile', specVersion: 'v1', workspaceId: 'wCal', modelResolved: 'jev-1.13.0',
    hashes: { questionHash: 'a'.repeat(64), packetHash: null },
    answerProbabilities: [{ questionId: 'ready', type: 'noul', probability: 0.8 }, { questionId: 'size', type: 'choice', probability: 0.6 }],
    ...extra,
  };
}

test('answerProbabilities keeps a Noul probability and a choice or score confidence, numbers only', () => {
  assert.deepEqual(
    answerProbabilities({ ready: { type: 'noul', noul: 0.7 }, size: { type: 'choice', choice: 'small', probabilities: { small: 0.9, large: 0.1 }, confidence: 0.9 }, bad: { type: 'noul', noul: 2 } }),
    [{ questionId: 'ready', type: 'noul', probability: 0.7 }, { questionId: 'size', type: 'choice', probability: 0.9 }],
  );
});

test('verified outcomes become cases per question; unverified, session-only and rules decisions do not', async () => {
  const records = {
    d1: record('d1'),
    d2: record('d2', { workerModel: { requested: null, observed: 'claude-sonnet-5', source: 'session', substituted: null, costPrecision: 'unknown' } }),
    d3: record('d3'),
    d4: record('d4'),
    d6: record('d6', { modelResolved: 'jevris-rules', answerProbabilities: undefined }),
    d7: record('d7', { workspaceId: 'wOther' }),
  };
  const exported = await buildLocalCalibrationCases({
    workspaceId: 'wCal',
    nowMs: NOW,
    rows: [
      row('d1'),
      row('d2', { label: 'reverted' }),
      row('d3', { label: 'cancelled' }),
      row('d4', { joinBasis: 'session-window' }),
      row('d5'),
      row('d6'),
      row('d7'),
    ],
    readRecord: async (id) => records[id] ?? null,
  });
  assert.equal(exported.schemaVersion, LOCAL_CALIBRATION_SCHEMA);
  assert.equal(exported.reviewState, 'unreviewed');
  assert.deepEqual(exported.totals, { decisions: 2, cases: 4 });
  assert.deepEqual(exported.excluded, { sessionWindowOnly: 1, notVerified: 1, noRecord: 2, noProbabilities: 1, overCap: 0 });
  assert.equal(exported.groups.length, 2);
  const noul = exported.groups.find((g) => g.questionId === 'ready');
  assert.equal(noul.questionType, 'noul');
  assert.equal(noul.model, 'jev-1.13.0');
  assert.equal(noul.sliceBasis, 'decision-spec');
  assert.deepEqual(noul.cases, [
    { sliceId: 'task-profile', probability: 0.8, outcome: true },
    { sliceId: 'task-profile', probability: 0.8, outcome: false, modelId: 'claude-sonnet-5' },
  ]);
  assert.equal(noul.successes, 1);
  assert.equal(noul.failures, 1);
  // Text-free: no decision id in the export.
  assert.doesNotMatch(JSON.stringify(exported), /"d[1-7]"/);
  assert.match(localCalibrationLines(exported, null)[0], /^Local calibration cases: 4 from 2 decision\(s\)/);
});

test('the export is written 0600 under route-learning and removed per workspace or all', async (t) => {
  const home = temp(t);
  const exported = await buildLocalCalibrationCases({ workspaceId: 'wCal', nowMs: NOW, rows: [row('d1')], readRecord: async () => record('d1') });
  const written = await writeLocalCalibrationCases(home, exported);
  assert.equal(written.ok, true);
  assert.equal(written.file, localCalibrationFile(home, 'wCal'));
  assert.match(written.file, /route-learning[\\/]calibration-cases[\\/]wCal\.json$/);
  if (process.platform !== 'win32') assert.equal(statSync(written.file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(written.file, 'utf8')).totals.cases, 2);
  const other = await writeLocalCalibrationCases(home, { ...exported, workspaceId: 'wTwo' });
  assert.equal(other.ok, true);
  assert.deepEqual(await removeLocalCalibrationCases(home, 'wCal'), { ok: true });
  assert.equal(existsSync(written.file), false);
  assert.equal(existsSync(other.file), true);
  assert.deepEqual(await removeLocalCalibrationCases(home), { ok: true });
  assert.equal(existsSync(other.file), false);
  assert.deepEqual(await removeLocalCalibrationCases(home), { ok: true });
});

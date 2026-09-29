/**
 * P7: the passive calibration report for the conservative token estimator. Estimate over the
 * provider-reported input tokens; below 1 is an under-estimate and a warning; it never changes the
 * estimator.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ENCODER_ID, SAFETY_FACTOR, estimatorCalibration, estimatorCalibrationLines } from '../dist/index.js';

const sample = (estimate, reported, extra = {}) => ({ estimate: { inputTokens: estimate, encoderId: ENCODER_ID }, usage: { inputTokens: reported, outputTokens: 10 }, ...extra });

test('P7: no decision with reported usage is no sample, not a pass', () => {
  const report = estimatorCalibration([{ estimate: null, usage: null }, sample(100, 0)]);
  assert.deepEqual([report.samples, report.ratio, report.status, report.reasonCodes], [0, null, 'no-samples', []]);
  assert.match(estimatorCalibrationLines(report)[0], /no decision with reported usage yet/);
});

test('P7: the ratio distribution over the current encoder; an under-estimate warns with a reason code; a repack after a size refusal counts apart; another encoder is not compared', () => {
  const records = [
    ...[120, 130, 140, 150, 160, 170, 180, 190, 200].map((e) => sample(e, 100)),
    sample(90, 100),
    sample(500, 100, { reasonCodes: ['PACKET_REPACKED'] }),
    { estimate: { inputTokens: 50, encoderId: 'jevris-conservative-v0' }, usage: { inputTokens: 100, outputTokens: 1 } },
  ];
  const report = estimatorCalibration(records);
  assert.equal(report.samples, 11);
  assert.deepEqual(report.ratio, { min: 0.9, p10: 1.2, p50: 1.6, p90: 2, max: 5 });
  assert.deepEqual([report.underEstimates, report.repacked, report.otherEncoder, report.status], [1, 1, 1, 'under-estimate']);
  assert.deepEqual(report.reasonCodes, ['ESTIMATE_BELOW_REPORTED', 'PROVIDER_REFUSED_SIZE']);
  const lines = estimatorCalibrationLines(report);
  assert.match(lines[0], /over 11 decision\(s\): min 0\.9, p10 1\.2, median 1\.6, p90 2, max 5\.$/);
  assert.ok(lines.some((l) => /ESTIMATE_BELOW_REPORTED.*changes only by release/.test(l)));
  assert.ok(lines.some((l) => /another encoder are not compared/.test(l)));
  // Every estimate at or above the report: ok.
  assert.equal(estimatorCalibration([sample(110, 100), sample(100, 100)]).status, 'ok');
  // The report never changes the estimator.
  assert.equal(SAFETY_FACTOR, 1.1);
});

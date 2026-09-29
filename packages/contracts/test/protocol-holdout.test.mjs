import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { EvaluationProtocolContract, evaluateQualityGate, EVAL_MIN_TASKS, EVAL_MIN_PER_SLICE } = await import('../dist/index.js');

const protocolPath = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/evaluation/protocol.json');
const shipped = JSON.parse(readFileSync(protocolPath, 'utf8'));

const HASH = `sha256:${'ab'.repeat(32)}`;

/** A complete synthetic evaluation: released holdout, consented labelled corpus, margin cleared. */
function synthetic() {
  const holdoutId = 'holdout-synthetic-2026-09-25';
  const slices = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`slice-${i}`, EVAL_MIN_PER_SLICE]));
  return {
    protocol: { ...shipped, holdoutId, labelledCorpus: true, nonInferiorityMargin: 0.02, preRegistrationHash: HASH },
    holdout: {
      schemaVersion: '1.0', kind: 'holdout-manifest', holdoutId, state: 'released', size: 120, contentHash: HASH,
      goldLabelSources: ['test', 'adjudicated-review'], sliceCounts: { a: 60, b: 60 }, releasedAt: '2026-09-25T00:00:00Z',
    },
    corpus: { labelled: true, consented: true, tasks: EVAL_MIN_TASKS, sliceCounts: slices },
    measurement: {
      metric: 'verified-success-ratio', arm: 'jev-routed', baseline: 'rules-only', point: 1.01, lower: 0.985, upper: 1.04,
      interval: 'wilson', confidence: 0.95, n: 120, holdoutId,
    },
  };
}

test('the shipped protocol is a valid EvaluationProtocol with the frozen split and annotation rule', () => {
  assert.equal(EvaluationProtocolContract.validate(shipped).ok, true);
  assert.deepEqual(shipped.frozenBaseline, ['rules-only', 'native']);
  assert.equal(shipped.splitPolicy, 'repository-and-time');
  assert.ok(shipped.annotationInstruction.includes('A gold label needs observable evidence or an adjudicated review.'));
  assert.ok(shipped.annotationInstruction.includes('must not re-optimize'));
  assert.equal(shipped.sourceCorpus, false);
  assert.equal(shipped.trainer, false);
  for (const key of ['measuredSpeedRatio', 'measuredCostRatio']) assert.equal(Object.hasOwn(shipped, key), false, 'no measured claim in the protocol');
});

test('the quality gate is computed: missing or invalid evidence is not a pass, with a named reason', () => {
  const alone = evaluateQualityGate({ protocol: shipped });
  assert.equal(alone.verdict, 'not-passed');
  for (const reason of ['MARGIN_MISSING', 'HOLDOUT_MISSING', 'CORPUS_MISSING', 'MEASUREMENT_MISSING', 'PROTOCOL_CORPUS_UNLABELLED']) {
    assert.ok(alone.reasons.includes(reason), reason);
  }
  assert.equal(alone.holdoutId, shipped.holdoutId);
  assert.equal(evaluateQualityGate({}).reasons.includes('PROTOCOL_MISSING'), true);

  const base = synthetic();
  const variants = [
    [{ holdout: { ...base.holdout, state: 'empty', size: 0, sliceCounts: {}, releasedAt: null } }, 'HOLDOUT_NOT_RELEASED'],
    [{ holdout: { ...base.holdout, contentHash: 'not-a-hash' } }, 'HOLDOUT_INVALID'],
    [{ holdout: { ...base.holdout, goldLabelSources: [] } }, 'HOLDOUT_NO_GOLD_LABELS'],
    [{ holdout: { ...base.holdout, holdoutId: 'holdout-other' } }, 'HOLDOUT_ID_MISMATCH'],
    [{ corpus: { ...base.corpus, labelled: false } }, 'CORPUS_UNLABELLED'],
    [{ corpus: { ...base.corpus, consented: false } }, 'CORPUS_NOT_CONSENTED'],
    [{ corpus: { ...base.corpus, tasks: EVAL_MIN_TASKS - 1 } }, 'CORPUS_TOO_SMALL'],
    [{ corpus: { ...base.corpus, sliceCounts: { ...base.corpus.sliceCounts, thin: EVAL_MIN_PER_SLICE - 1 } } }, 'SLICE_TOO_SMALL'],
    [{ measurement: { ...base.measurement, lower: 0.97, point: 1.0 } }, 'NON_INFERIORITY_NOT_SHOWN'],
    [{ measurement: { ...base.measurement, point: 2, upper: 1.5 } }, 'MEASUREMENT_INVALID'],
    [{ measurement: { ...base.measurement, baseline: 'static' } }, 'MEASUREMENT_BASELINE_NOT_FROZEN'],
    [{ protocol: { ...base.protocol, nonInferiorityMargin: undefined } }, 'MARGIN_MISSING'],
    [{ protocol: { ...base.protocol, preRegistrationHash: undefined } }, 'PREREGISTRATION_MISSING'],
  ];
  for (const [change, reason] of variants) {
    const input = { ...base, ...change };
    if (input.protocol.nonInferiorityMargin === undefined) delete input.protocol.nonInferiorityMargin;
    if (input.protocol.preRegistrationHash === undefined) delete input.protocol.preRegistrationHash;
    const result = evaluateQualityGate(input);
    assert.equal(result.verdict, 'not-passed', reason);
    assert.ok(result.reasons.includes(reason), `${reason}: ${result.reasons}`);
  }
});

test('valid synthetic evidence passes the quality gate', () => {
  const result = evaluateQualityGate(synthetic());
  assert.deepEqual(result.reasons, []);
  assert.equal(result.verdict, 'passed');
  assert.equal(result.holdoutId, 'holdout-synthetic-2026-09-25');
});

test('the declared status in a protocol file never decides the gate', () => {
  const claimed = { ...synthetic(), protocol: { ...synthetic().protocol, qualityGate: 'passed' } };
  delete claimed.holdout;
  assert.equal(evaluateQualityGate(claimed).verdict, 'not-passed');
  const modest = { ...synthetic(), protocol: { ...synthetic().protocol, qualityGate: 'not-passed' } };
  assert.equal(evaluateQualityGate(modest).verdict, 'passed', 'a stale declared status does not block real evidence');
});

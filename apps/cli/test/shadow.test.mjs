import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


const { buildShadowReport } = await import('@jevris/core');
const { formatShadowReport } = await import('../dist/shadow.js');
const { doctorReportStatus, main } = await import('../dist/cli.js');

const BANNED_RATIO_TOKENS = [
  '193.6',
  '444.6',
  '23.8',
  '47.6',
  '119.0',
  '238.1',
  '1.247',
  '4.81',
  '26.6',
  '13.4',
];

const REPORT_KEYS = [
  'schemaVersion',
  'kind',
  'baselines',
  'recordCount',
  'actuationCount',
  'measuredSpeedRatio',
  'measuredCostRatio',
  'vendorSpeedClaim',
  'vendorCostClaim',
  'fullCostPerVerifiedTask',
];

function comparisonFile() {
  return {
    schemaVersion: '1.0',
    mode: 'shadow',
    policyVersion: 'policyV1',
    rulesRecommendation: 'KNOWN_FAILURE',
    nativeRecommendation: 'claude-sonnet-5',
    jevRecommendation: 'jev-1.13.0',
    actualModel: 'claude-sonnet-5',
    actualWorker: null,
    applied: false,
    appliedAction: null,
    actuationCount: 0,
    sent: false,
    explanation: 'Shadow comparison recorded. The agent was not changed.',
  };
}

test('buildShadowReport returns a closed report with null measured ratios', () => {
  // SHAD-03 / chapter 19: measured ratios stay null. Vendor claims are not results.
  const report = buildShadowReport([comparisonFile()]);
  assert.deepEqual(Object.keys(report), REPORT_KEYS);
  assert.equal(report.schemaVersion, '1.0');
  assert.equal(report.kind, 'shadow-report');
  assert.deepEqual(report.baselines, ['rules-only', 'native', 'jev']);
  assert.equal(report.recordCount, 1);
  assert.equal(report.actuationCount, 0);
  assert.equal(report.measuredSpeedRatio, null);
  assert.equal(report.measuredCostRatio, null);
  assert.equal(report.vendorSpeedClaim, 'not-a-jevris-result');
  assert.equal(report.vendorCostClaim, 'not-a-jevris-result');
  assert.equal(report.fullCostPerVerifiedTask, 'unmeasured');
  assert.equal(Object.hasOwn(report, 'speedup'), false);
  assert.equal(Object.hasOwn(report, 'savings'), false);
  assert.equal(Object.hasOwn(report, 'costRatio'), false);
});

test('an actuation count other than zero is refused and is not reported', () => {
  const refused = buildShadowReport([{ ...comparisonFile(), actuationCount: 1 }]);
  assert.equal(refused.refused, true);
  assert.equal(Object.hasOwn(refused, 'kind'), false);
  assert.equal(Object.hasOwn(refused, 'actuationCount'), false);
});

test('formatShadowReport prints locked lines and is not a doctor report', () => {
  const report = buildShadowReport([comparisonFile()]);
  const text = formatShadowReport(report);
  const lines = text.split('\n');
  assert.equal(lines[0], 'Shadow report.');
  assert.equal(lines[1], 'Baselines: rules-only, native, jev');
  assert.equal(lines[2], 'Records: 1');
  assert.equal(lines[3], 'Actuation count: 0');
  assert.equal(lines[4], 'Measured speed ratio: not-a-jevris-result');
  assert.equal(lines[5], 'Measured cost ratio: not-a-jevris-result');
  assert.equal(lines[6], 'Vendor speed claim: not-a-jevris-result');
  assert.equal(lines[7], 'Vendor cost claim: not-a-jevris-result');
  assert.equal(lines[8], 'Full cost per verified task: unmeasured');
  assert.equal(lines[9].startsWith('JEVRIS_SHADOW '), true);
  assert.equal(lines[10], '');
  assert.equal(lines.length, 11);
  assert.equal(text.includes('\u001b'), false);
  assert.equal(text.includes('JEVRIS_REPORT '), false);
  assert.equal(doctorReportStatus(text), 'refused');

  const parsed = JSON.parse(lines[9].slice('JEVRIS_SHADOW '.length));
  assert.deepEqual(Object.keys(parsed), REPORT_KEYS);
  assert.equal(parsed.measuredSpeedRatio, null);
  assert.equal(parsed.measuredCostRatio, null);
  assert.equal(parsed.vendorSpeedClaim, 'not-a-jevris-result');
  assert.equal(parsed.vendorCostClaim, 'not-a-jevris-result');
  assert.equal(parsed.fullCostPerVerifiedTask, 'unmeasured');
  assert.equal(parsed.actuationCount, 0);
  for (const token of BANNED_RATIO_TOKENS) {
    assert.equal(text.includes(token), false);
  }
});

test('injected vendor and chapter 19 ratio tokens are refused', () => {
  const report = buildShadowReport([comparisonFile()]);
  for (const token of BANNED_RATIO_TOKENS) {
    const text = formatShadowReport({ ...report, note: token });
    assert.equal(text, 'refused\n');
    assert.equal(text.includes('JEVRIS_SHADOW'), false);
    assert.equal(text.includes('Shadow report.'), false);
  }
});

const FIXTURE_BYTE_CAP = 131072;
const SOURCE_CANARY = 'SOURCE_CANARY_do_not_store';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'jevris-shadow-cli-'));
}

function routeFixture(extra) {
  return {
    policyVersion: 'policyV1',
    actualModel: 'claude-sonnet-5',
    rulesInput: { kind: 'known-failure', family: 'type_error' },
    jevLabel: 'jev-1.13.0',
    setting: { provenance: 'administrator', sourceEgress: 'approved-scoped' },
    untrustedClaims: [],
    ...extra,
  };
}

async function run(args) {
  let text = '';
  const code = await main(args, (chunk) => {
    text += chunk;
  });
  return { code, text };
}

test('shadow records the three arms and does not change the agent', async () => {
  // US03: given approved egress, when a route is evaluated, the actual worker
  // and model stay unchanged and the counterfactual is recorded with its policy version.
  // E17: the comparable baselines are rules-only, native, and Jev.
  const parent = tempDir();
  const home = join(parent, 'absent-home');
  const fixture = join(parent, 'fixture.json');
  const out = join(parent, 'comparison.json');
  writeFileSync(fixture, JSON.stringify(routeFixture()));
  try {
    assert.equal(existsSync(home), false);
    const { code, text } = await run(['shadow', '--home', home, '--fixture', fixture, '--out', out]);
    assert.equal(code, 0);
    assert.equal(existsSync(home), false);
    assert.equal(text.includes('JEVRIS_SHADOW '), true);
    assert.equal(text.includes('permissionDecision'), false);
    assert.equal(text.includes('JEVRIS_REPORT '), false);
    assert.equal(doctorReportStatus(text), 'refused');
    const parsed = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(parsed.policyVersion, 'policyV1');
    assert.equal(parsed.rulesRecommendation, 'KNOWN_FAILURE');
    assert.equal(parsed.nativeRecommendation, 'claude-sonnet-5');
    assert.equal(parsed.jevRecommendation, 'jev-1.13.0');
    assert.equal(parsed.actualModel, 'claude-sonnet-5');
    assert.equal(parsed.actualWorker, null);
    assert.equal(parsed.applied, false);
    assert.equal(parsed.appliedAction, null);
    assert.equal(parsed.actuationCount, 0);
    assert.equal(parsed.sent, false);
    assert.equal(text.includes(SOURCE_CANARY), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('a rejected recommendation is feedback and the next comparison keeps the caller policy', async () => {
  // C16 / SHAD-02: a rejection is stored. The draft stays unpublished. Policy is not changed.
  const parent = tempDir();
  const home = join(parent, 'absent-home');
  const rejected = join(parent, 'rejected.json');
  const again = join(parent, 'again.json');
  const out = join(parent, 'comparison.json');
  const next = join(parent, 'next.json');
  writeFileSync(
    rejected,
    JSON.stringify(
      routeFixture({
        decision: 'rejected',
        recommendationId: 'routeAdvice',
        reason: 'preference',
        draft: true,
      }),
    ),
  );
  writeFileSync(again, JSON.stringify(routeFixture()));
  try {
    const first = await run(['shadow', '--home', home, '--fixture', rejected, '--out', out]);
    assert.equal(first.code, 0);
    assert.equal(existsSync(home), false);
    const feedback = JSON.parse(readFileSync(`${out}.feedback.json`, 'utf8'));
    assert.equal(feedback.kind, 'recommendation-feedback');
    assert.equal(feedback.decision, 'rejected');
    assert.equal(feedback.published, false);
    assert.equal(feedback.policyChanged, false);
    assert.equal(feedback.policyVersion, 'policyV1');
    const draft = JSON.parse(readFileSync(`${out}.draft.json`, 'utf8'));
    assert.equal(draft.kind, 'calibration-proposal');
    assert.equal(draft.published, false);
    assert.equal(draft.loaded, false);
    const second = await run(['shadow', '--home', home, '--fixture', again, '--out', next]);
    assert.equal(second.code, 0);
    const parsed = JSON.parse(readFileSync(next, 'utf8'));
    assert.equal(parsed.policyVersion, 'policyV1');
    assert.equal(parsed.rulesRecommendation, 'KNOWN_FAILURE');
    assert.equal(parsed.applied, false);
    assert.equal(parsed.actuationCount, 0);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('a missing home, a missing fixture, or a packs path is refused and creates nothing', async () => {
  const parent = tempDir();
  const home = join(parent, 'absent-home');
  const fixture = join(parent, 'fixture.json');
  const out = join(parent, 'comparison.json');
  const packs = join(parent, '.jevris', 'packs', 'comparison.json');
  writeFileSync(fixture, JSON.stringify(routeFixture()));
  try {
    // ADM-01: without --home the default home applies (JEVRIS_HOME, an absent temp dir here).
    const saved = process.env.JEVRIS_HOME;
    process.env.JEVRIS_HOME = home;
    const defaultOut = join(parent, 'default-home.json');
    try {
      const defaultHome = await run(['shadow', '--fixture', fixture, '--out', defaultOut]);
      assert.equal(defaultHome.code, 0);
      assert.equal(existsSync(defaultOut), true);
    } finally {
      if (saved === undefined) delete process.env.JEVRIS_HOME;
      else process.env.JEVRIS_HOME = saved;
    }
    assert.equal(existsSync(home), false);
    assert.equal(existsSync(out), false);

    const missingFixture = await run(['shadow', '--home', home, '--out', out]);
    assert.equal(missingFixture.code, 2);
    assert.equal(missingFixture.text, 'refused\n');
    assert.equal(existsSync(home), false);
    assert.equal(existsSync(out), false);

    const missingFile = await run(['shadow', '--home', home, '--fixture', join(parent, 'missing.json'), '--out', out]);
    assert.equal(missingFile.code, 2);
    assert.equal(missingFile.text, 'refused\n');
    assert.equal(existsSync(out), false);
    assert.equal(existsSync(home), false);

    const packed = await run(['shadow', '--home', home, '--fixture', fixture, '--out', packs]);
    assert.equal(packed.code, 2);
    assert.equal(packed.text, 'refused\n');
    assert.equal(existsSync(packs), false);
    assert.equal(existsSync(join(parent, '.jevris')), false);
    assert.equal(existsSync(home), false);

    const unknown = await run(['not-a-command', '--home', home]);
    assert.equal(unknown.code, 2);
    assert.equal(unknown.text, 'refused\n');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('an oversize fixture and a source-bearing fixture write nothing', async () => {
  const parent = tempDir();
  const home = join(parent, 'absent-home');
  const fixture = join(parent, 'fixture.json');
  const out = join(parent, 'comparison.json');
  try {
    writeFileSync(fixture, Buffer.alloc(FIXTURE_BYTE_CAP + 1, 0x20));
    const oversize = await run(['shadow', '--home', home, '--fixture', fixture, '--out', out]);
    assert.equal(oversize.code, 2);
    assert.equal(oversize.text, 'refused\n');
    assert.equal(existsSync(out), false);

    writeFileSync(fixture, JSON.stringify(routeFixture({ source: SOURCE_CANARY })));
    const sourced = await run(['shadow', '--home', home, '--fixture', fixture, '--out', out]);
    assert.equal(sourced.code, 2);
    assert.equal(sourced.text, 'refused\n');
    assert.equal(existsSync(out), false);
    assert.equal(sourced.text.includes(SOURCE_CANARY), false);
    assert.equal(existsSync(home), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('an omitted out path does not invent a comparison file', async () => {
  const parent = tempDir();
  const home = join(parent, 'absent-home');
  const fixture = join(parent, 'fixture.json');
  writeFileSync(fixture, JSON.stringify(routeFixture()));
  try {
    const { code, text } = await run(['shadow', '--home', home, '--fixture', fixture]);
    assert.equal(code, 0);
    assert.equal(text.includes('JEVRIS_SHADOW '), true);
    assert.equal(text.includes('permissionDecision'), false);
    assert.equal(readdirSync(parent).includes('comparison.json'), false);
    assert.equal(existsSync(home), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('the evaluation protocol fixture freezes the baseline and contains no source corpus', () => {
  // E05: frozen baseline, split policy, and annotation instructions. No source corpus.
  const protocolPath = join(import.meta.dirname, '../../../fixtures/evaluation/protocol.json');
  const text = readFileSync(protocolPath, 'utf8');
  const parsed = JSON.parse(text);
  assert.equal(parsed.kind, 'evaluation-protocol');
  assert.deepEqual(parsed.frozenBaseline, ['rules-only', 'native']);
  assert.equal(parsed.splitPolicy, 'repository-and-time');
  assert.equal(parsed.annotationInstruction.includes('observable evidence'), true);
  assert.equal(parsed.annotationInstruction.includes('adjudicated review'), true);
  assert.equal(parsed.sourceCorpus, false);
  assert.equal(parsed.trainer, false);
  assert.equal(text.includes(SOURCE_CANARY), false);
});

test('product hooks stay absent or certified after the shadow commands', async () => {
  // The shadow import bans are in apps/cli/lint/shadow.lint.mjs (QA-07).
  const { assertProductHooksAbsentOrCertified } = await import(new URL('../test/product-hooks.mjs', import.meta.url));
  await assertProductHooksAbsentOrCertified();
});

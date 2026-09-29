import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReviewSet, acceptReviewClaim, writeReviewRecords } from '../dist/review-record.js';


const root = fileURLToPath(new URL('../../..', import.meta.url));
const protocol = JSON.parse(await readFile(join(root, 'fixtures', 'evaluation', 'protocol.json'), 'utf8'));
const HASH = `sha256:${'cd'.repeat(32)}`;

/** A complete synthetic evaluation that passes the computed quality gate. */
function passingGate() {
  const holdoutId = 'holdout-synthetic-2026-09-25';
  return {
    protocol: { ...protocol, holdoutId, labelledCorpus: true, nonInferiorityMargin: 0.02, preRegistrationHash: HASH },
    holdout: {
      schemaVersion: '1.0', kind: 'holdout-manifest', holdoutId, state: 'released', size: 90, contentHash: HASH,
      goldLabelSources: ['test'], sliceCounts: {}, releasedAt: '2026-09-25T00:00:00Z',
    },
    corpus: { labelled: true, consented: true, tasks: 300, sliceCounts: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`s${i}`, 30])) },
    measurement: { metric: 'verified-success-ratio', arm: 'jev-routed', baseline: 'native', point: 1.0, lower: 0.99, upper: 1.01, interval: 'wilson', confidence: 0.95, n: 90, holdoutId },
  };
}

const IDS = [
  'CAP-24',
  'CAP-32',
  'CAP-40',
  'CAP-62',
  'CAP-65',
  'CAP-66',
  'CAP-67',
  'CAP-68',
  'CAP-69',
  'CAP-70',
  'CAP-71',
  'EPC-35',
  'EPC-36',
];

const WIN = 'beats-rules';

function assertLegalRecord(record, expected = { holdoutId: null, qualityGate: 'not-passed' }) {
  assert.equal(record.schemaVersion, 'p4-1');
  assert.equal(record.status, 'unsupported');
  assert.equal(record.applied, false);
  assert.equal(record.trainer, false);
  assert.equal(record.holdoutId, expected.holdoutId);
  assert.equal(record.qualityGate, expected.qualityGate);
  assert.equal(record.waivesLock, false);
  assert.equal(record.waivesReceipt, false);
  assert.equal(record.waivesQualityFloor, false);
  assert.equal(record.actuates, false);
  assert.equal(JSON.stringify(record).includes(WIN), false);
}

test('buildReviewSet returns one unsupported record per requirement id; with no evaluation input the gate is not a pass', () => {
  const records = buildReviewSet();
  assert.equal(records.length, IDS.length);
  assert.equal(new Set(records.map((record) => record.id)).size, IDS.length);
  for (const id of IDS) {
    const matches = records.filter((record) => record.id === id);
    assert.equal(matches.length, 1, id);
    assertLegalRecord(matches[0]);
  }
  const epc35 = records.find((record) => record.id === 'EPC-35');
  assert.equal(
    String(epc35.detail).includes('npm and network access were not treated as a bridge'),
    true,
  );
});

test('the review records carry the computed gate: the shipped protocol alone is not a pass, valid synthetic evidence is', () => {
  for (const record of buildReviewSet({ protocol })) assertLegalRecord(record, { holdoutId: protocol.holdoutId, qualityGate: 'not-passed' });
  const passing = buildReviewSet(passingGate());
  for (const record of passing) {
    assertLegalRecord(record, { holdoutId: 'holdout-synthetic-2026-09-25', qualityGate: 'passed' });
    assert.equal(record.status, 'unsupported', 'a passing quality gate does not certify an unsupported capability');
  }
  const unreleased = passingGate();
  unreleased.holdout = { ...unreleased.holdout, state: 'empty', size: 0, releasedAt: null };
  for (const record of buildReviewSet(unreleased)) assert.equal(record.qualityGate, 'not-passed');
});

test('acceptReviewClaim refuses a win, a trainer, a waiver, and a dangerous key', () => {
  assert.equal(acceptReviewClaim(null), 'refused');
  assert.equal(acceptReviewClaim(WIN), 'refused');
  assert.equal(acceptReviewClaim([WIN]), 'refused');
  assert.equal(acceptReviewClaim({ outcome: WIN }), 'refused');
  assert.equal(acceptReviewClaim({ trainer: true }), 'refused');
  assert.equal(acceptReviewClaim({ applied: true }), 'refused');
  assert.equal(acceptReviewClaim({ qualityGate: 'passed' }), 'refused');
  assert.equal(acceptReviewClaim({ waivesLock: true }), 'refused');
  assert.equal(acceptReviewClaim({ waivesReceipt: true }), 'refused');
  assert.equal(acceptReviewClaim({ waivesQualityFloor: true }), 'refused');
  assert.equal(acceptReviewClaim({ actuates: true }), 'refused');
  assert.equal(acceptReviewClaim(JSON.parse('{"__proto__":{"admin":true}}')), 'refused');
  assert.equal(acceptReviewClaim(JSON.parse('{"constructor":{"admin":true}}')), 'refused');
  assert.equal(acceptReviewClaim(JSON.parse('{"prototype":{"admin":true}}')), 'refused');
  assert.equal(acceptReviewClaim({ passed: true }), 'refused');
  assert.equal(
    acceptReviewClaim({
      schemaVersion: 'p4-1',
      status: 'unsupported',
      applied: false,
      trainer: false,
      holdoutId: protocol.holdoutId,
      qualityGate: 'not-passed',
      waivesLock: false,
      waivesReceipt: false,
      waivesQualityFloor: false,
      actuates: false,
    }),
    'accepted',
  );
});

test('writeReviewRecords with a refused claim writes no file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jevris-review-refuse-'));
  try {
    const claim = {
      outcome: WIN,
      trainer: true,
      applied: true,
      qualityGate: 'passed',
      waivesLock: true,
      waivesReceipt: true,
      waivesQualityFloor: true,
      actuates: true,
    };
    assert.equal(acceptReviewClaim(claim), 'refused');
    assert.equal(await writeReviewRecords(dir, claim), 'refused');
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a legal write is one file per id and does not unlink siblings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jevris-review-keep-'));
  try {
    await writeFile(join(dir, 'codex.json'), '{"status":"unsupported"}\n');
    await writeFile(join(dir, 'windows-launcher.json'), '{"status":"unsupported"}\n');
    assert.equal(await writeReviewRecords(dir, undefined, { protocol }), 'written');
    assert.equal(await readFile(join(dir, 'codex.json'), 'utf8'), '{"status":"unsupported"}\n');
    assert.equal(await readFile(join(dir, 'windows-launcher.json'), 'utf8'), '{"status":"unsupported"}\n');
    const names = await readdir(dir);
    for (const id of IDS) {
      const fileName = `${id.toLowerCase()}.json`;
      assert.equal(names.includes(fileName), true, fileName);
      const text = await readFile(join(dir, fileName), 'utf8');
      assert.equal(text.endsWith('\n'), true);
      assert.equal(text.includes(WIN), false);
      const parsed = JSON.parse(text);
      assert.equal(parsed.id, id);
      assertLegalRecord(parsed, { holdoutId: protocol.holdoutId, qualityGate: 'not-passed' });
    }
    assert.equal(names.includes('m3.json'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fixtures/p4 has one unsupported review file per requirement id', async () => {
  for (const id of IDS) {
    const text = await readFile(join(root, 'fixtures', 'p4', `${id.toLowerCase()}.json`), 'utf8');
    assert.equal(text.endsWith('\n'), true);
    assert.equal(text.includes(WIN), false);
    const parsed = JSON.parse(text);
    assert.equal(parsed.id, id);
    assert.deepEqual(parsed, buildReviewSet({ protocol }).find((record) => record.id === id), 'the fixture is what the builder writes');
  }
  const epc35 = JSON.parse(await readFile(join(root, 'fixtures', 'p4', 'epc-35.json'), 'utf8'));
  assert.equal(
    String(epc35.detail).includes('npm and network access were not treated as a bridge'),
    true,
  );
  await assert.rejects(readFile(join(root, 'fixtures', 'p4', 'm3.json'), 'utf8'));
});

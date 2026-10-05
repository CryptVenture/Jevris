// JEV-0049: the evidence record of the Jev feature suite (`jev-features-suite-1`) holds numbers and codes only. A capability row used to carry the
// advice's `recommendation` as text (the canary module path of C70, a skill, tool or agent name, an evidence handle), which would be real workspace
// text if the suite were pointed at one. The row now keeps how long the recommendation is, and a failure is a code, never a message.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedHostSkip } from '../../../test/managed-host.mjs';
import { runCases } from '../scripts/jev-feature-driver.mjs';
import { CASES as CASES_A, OWNED_CASES } from '../scripts/jev-feature-cases-a.mjs';
import { CASES as CASES_B } from '../scripts/jev-feature-cases-b.mjs';
import { CASES as CASES_C, PATH_MARK } from '../scripts/jev-feature-cases-c.mjs';

const { recordViolations } = await import('@jevris/provider-typesafe');
const script = fileURLToPath(new URL('../scripts/jev-features.mjs', import.meta.url));
const TITLES = [...CASES_A, ...OWNED_CASES, ...CASES_B, ...CASES_C].map((c) => c.title);
const PATH = 'caseC/ZZPATHMARK-C70-beta';

const caseOf = (extra = {}) => ({ id: 'C70', title: 'Project-wide change campaign: pick the canary', steps: [], call: { op: 'capability.advise', scope: 'mcp', body: {} }, expectAsked: false, ...extra });
const fake = (answer) => ({ async sidecarRequest() { return answer; } });

test('a row keeps the length of the advice\'s recommendation, never the text; every shape of summary is handled', async () => {
  const advice = { source: 'rules', reasonCode: 'SMALLEST_COVERED_MODULE', decisionId: null, verb: 'rank', recommendation: PATH };
  const [row] = await runCases({ sidecar: fake({ ok: true, result: advice }), home: 'unused', work: 'unused', cases: [caseOf()], requestCount: () => 0 });
  assert.equal(row.ok, true);
  assert.equal(row.recommendationLength, PATH.length);
  assert.equal(Object.hasOwn(row, 'recommendation'), false, 'the row holds the recommendation text');
  assert.equal(JSON.stringify(row).includes('ZZPATHMARK'), false);
  assert.deepEqual([row.source, row.reasonCode, row.verb], ['rules', 'SMALLEST_COVERED_MODULE', 'rank']);
  // No recommendation (null) is a length of null; a case's own summarizer may name one too.
  const [none] = await runCases({ sidecar: fake({ ok: true, result: { ...advice, recommendation: null } }), home: 'unused', work: 'unused', cases: [caseOf()], requestCount: () => 0 });
  assert.equal(none.recommendationLength, null);
  const [custom] = await runCases({ sidecar: fake({ ok: true, result: {} }), home: 'unused', work: 'unused', cases: [caseOf({ summarize: () => ({ source: null, reasonCode: null, decisionId: null, verb: 'recover', recommendation: PATH }) })], requestCount: () => 0 });
  assert.equal(custom.recommendationLength, PATH.length);
  assert.equal(Object.hasOwn(custom, 'recommendation'), false);
});

test('a failure is a code in the row: a refused op names its reason code, an error names its kind, and the message goes to stderr only', async (t) => {
  const [refused] = await runCases({ sidecar: fake({ ok: false, reasonCode: 'WORKSPACE_ROOT_UNKNOWN', reason: 'the workspace /home/me/work is not registered' }), home: 'unused', work: 'unused', cases: [caseOf()], requestCount: () => 0 });
  assert.equal(refused.ok, false);
  assert.equal(refused.failure, 'capability.advise: WORKSPACE_ROOT_UNKNOWN');
  // A reason that is a sentence is not a code: the row says UNKNOWN rather than quoting it.
  const [sentence] = await runCases({ sidecar: fake({ ok: false, reason: 'the workspace /home/me/work is not registered' }), home: 'unused', work: 'unused', cases: [caseOf()], requestCount: () => 0 });
  assert.equal(sentence.failure, 'capability.advise: UNKNOWN');
  const [stepRefused] = await runCases({ sidecar: fake({ ok: false, reasonCode: 'KILL_SWITCH_ACTIVE' }), home: 'unused', work: 'unused', cases: [caseOf({ steps: [{ op: 'plan.submit', body: {} }] })], requestCount: () => 0 });
  assert.equal(stepRefused.failure, 'step plan.submit: KILL_SWITCH_ACTIVE');
  const written = [];
  t.mock.method(process.stderr, 'write', (chunk) => {
    written.push(String(chunk));
    return true;
  });
  const [threw] = await runCases({ sidecar: { async sidecarRequest() { throw Object.assign(new Error(`ENOENT: no such file ${PATH}`), { code: 'ENOENT' }); } }, home: 'unused', work: 'unused', cases: [caseOf()], requestCount: () => 0 });
  assert.equal(threw.ok, false);
  assert.equal(threw.failure, 'threw: Error:ENOENT');
  assert.equal(JSON.stringify(threw).includes('ZZPATHMARK'), false, 'the error message is in the row');
  assert.ok(written.some((line) => line.includes('ZZPATHMARK')), 'the message is kept for whoever reads the run, on stderr');
  t.mock.restoreAll();
  for (const r of [refused, sentence, stepRefused, threw]) assert.deepEqual(recordViolations({ capabilities: { rows: [{ ...r, part: 'c', egress: 'denied' }] } }, { titles: TITLES }), [], r.failure);
});

test('--mock part C writes a record whose C70 row has a recommendation length and no module path, and whose every string is a code or a fixed title', { skip: managedHostSkip(), timeout: 300_000 }, () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jev-features-record-')));
  try {
    const evidence = join(dir, 'features.json');
    // The part that holds C70, one egress state, with no engine groups and no hot path: one sidecar.
    const out = spawnSync(process.execPath, [script, '--mock', '--parts', 'c', '--egress', 'denied', '--skip', 'engine,hot', '--evidence', evidence], { encoding: 'utf8', env: { ...process.env }, timeout: 280_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    assert.equal(out.status, 0, `${(out.stdout ?? '').slice(-1200)}\n${(out.stderr ?? '').slice(-600)}`);
    const record = JSON.parse(readFileSync(evidence, 'utf8'));
    const c70 = record.capabilities.rows.find((r) => r.id === 'C70');
    assert.ok(c70 !== undefined, 'the record has no C70 row');
    assert.ok(c70.recommendationLength > 0, 'C70 recommended a canary');
    assert.equal(Object.hasOwn(c70, 'recommendation'), false);
    assert.equal(JSON.stringify(record).includes(PATH_MARK), false, 'a module path is in the record');
    assert.deepEqual(recordViolations(record, { titles: TITLES }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

// The record of the Jev feature suite (`jev-features-suite-1`) holds numbers, booleans, codes and fixed labels only (JEV-0049). `recordViolations` is the
// allow-list: a string is accepted only at a listed path and only with the shape that field holds, so a free-text field (a recommendation that names a
// module path, an error message, a sentence) fails the suite's own tests and the script before the record is written, and a new field has to be listed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const provider = await import('../dist/index.js');
const { createCallMeter, createMockFetch, createSidecarEngine, recordViolations, runFeatureSuite } = provider;

const TITLES = ['Project-wide change campaign: pick the canary', 'Tell an environment failure from a source defect'];
const row = (extra = {}) => ({ id: 'C70', title: TITLES[0], expectAsked: true, egressNeeded: true, ok: true, attempts: 1, requests: 0, source: 'rules', reasonCode: 'SMALLEST_COVERED_MODULE', decisionId: null, verb: 'rank', recommendationLength: 24, elapsedMs: 66, failure: null, usage: null, costMicroUsd: null, durationMs: null, jevReasonCodes: [], answerProbabilities: [], part: 'c', egress: 'denied', ...extra });
const record = (rows, engineRows = []) => ({ schemaVersion: 'jev-features-suite-1', kind: 'jev-features-suite', mode: 'mock', producedAt: '2026-10-05T12:02:11.914Z', pinnedModel: 'jev-1.13.0', capabilities: { passes: [{ part: 'c', egress: 'denied', cases: rows.length, knownDefects: [], knownLeaks: [] }], rows }, engine: { schemaVersion: 'jev-features-suite-1', rows: engineRows, failures: [] }, failures: [] });

test('a record of numbers, booleans, nulls, codes and fixed titles has no violation', () => {
  assert.deepEqual(recordViolations(record([row(), row({ id: 'C38', title: TITLES[1], source: 'jev', reasonCode: 'JEV_CHOICE', decisionId: 'd-8f6be3fa-bdf8-42bd-9aee-03f5abce6b4a', usage: { inputTokens: 40 }, jevReasonCodes: ['DECISION_ADVISORY'], answerProbabilities: [{ id: 'q', type: 'choice', probability: 0.9 }] })]), { titles: TITLES }), []);
});

test('the module path a C70 row used to carry in `recommendation` is a violation, named by its field and never quoted', () => {
  const planted = 'caseC/ZZPATHMARK-C70-beta';
  const found = recordViolations(record([row({ recommendation: planted })]), { titles: TITLES });
  assert.equal(found.length, 1);
  assert.match(found[0], /^capabilities\.rows\[\]\.recommendation: a string where the record holds numbers and codes/);
  assert.equal(found.join('\n').includes(planted), false, 'the violation quotes the value');
  assert.equal(found.join('\n').includes('ZZPATHMARK'), false);
});

test('a string of any other kind is refused at the field that holds it: a path or a sentence in a code, a message in a failure, an unlisted key, a title that is not a case\'s', () => {
  const cases = [
    [record([], [{ group: 'slice', id: 'slice-feature', spec: 'slice-classify', phase: 'cold', expected: 'feature', got: 'src/app/parser.ts' }]), /engine\.rows\[\]\.got: not the code or label/],
    [record([], [{ group: 'slice', id: 'slice-feature', spec: 'slice-classify', phase: 'cold', detail: { note: 'the parser in src was slow' } }]), /engine\.rows\[\]\.detail\.note: not the code or label/],
    [record([], [{ group: 'slice', id: 'slice-feature', spec: 'slice-classify', phase: 'cold', source: 'a model said so' }]), /engine\.rows\[\]\.source: not the code or label/],
    [record([row({ failure: 'threw: ENOENT: no such file /home/me/work/pkg/a.json' })]), /capabilities\.rows\[\]\.failure: not the code or label/],
    [record([row({ reasonCode: 'a sentence, not a code' })]), /capabilities\.rows\[\]\.reasonCode: not the code or label/],
    [record([row({ title: 'A title the cases do not have' })], []), /capabilities\.rows\[\]\.title: not a fixed title of a case/],
    [record([row({ note: 'free text' })]), /capabilities\.rows\[\]\.note: a string where the record holds numbers and codes/],
    [{ ...record([]), hot: { route: { rowsCold: [{ op: 'route', phase: 'cold', source: 'none', reasonCode: 'SLICE_HIGH_RISK', decisionId: 'not an id' }] } } }, /hot\.route\.rowsCold\[\]\.decisionId: not the code or label/],
  ];
  for (const [rec, pattern] of cases) {
    const found = recordViolations(rec, { titles: TITLES });
    assert.ok(found.some((line) => pattern.test(line)), `${pattern}: ${JSON.stringify(found)}`);
  }
  // Without the case titles, a title is accepted by its shape (a phrase with no path separator).
  assert.deepEqual(recordViolations(record([row({ title: 'A title the cases do not have' })])), []);
  assert.equal(recordViolations(record([row({ title: 'pkg/a/b' })])).length, 1, 'a title with a path separator is not a title');
});

test('the record the engine part writes offline holds numbers and codes only, and a field it did not list would fail here', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'jevris-features-record-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const meter = createCallMeter(createMockFetch({ scenario: 'valid' }), { maxCalls: 400, maxMicroUsd: 100_000 });
  const createEngine = async ({ egress }) => createSidecarEngine({ home, credential: 'test-key-not-a-secret', fetch: meter.fetch, env: {}, budgetLimitMicroUsd: 5_000_000, sourceEgress: () => ({ provenance: 'administrator', sourceEgress: egress ? 'approved-scoped' : 'deny-until-approved' }) });
  const createProbeEngine = async ({ fetch, clock }) => {
    const probeHome = mkdtempSync(join(tmpdir(), 'jevris-features-record-probe-'));
    t.after(() => rmSync(probeHome, { recursive: true, force: true }));
    return createSidecarEngine({ home: probeHome, credential: 'test-key-not-a-secret', fetch, clock, env: {}, budgetLimitMicroUsd: 5_000_000 });
  };
  const engine = await runFeatureSuite({ meter, createEngine, createProbeEngine, cold: 1, cached: 1 });
  assert.ok(engine.rows.length > 50, `${String(engine.rows.length)} rows`);
  assert.deepEqual(recordViolations({ engine }), []);
  // A free-text field added to a row is caught, wherever in the rows it appears.
  const dirty = { engine: { ...engine, rows: engine.rows.map((r, i) => (i === 3 ? { ...r, detail: { ...r.detail, recommendation: 'rename pkg/a/index.ts' } } : r)) } };
  assert.equal(recordViolations(dirty).length, 1);
});

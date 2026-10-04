// Why the worker-readiness question has the wording it has (decision of 2026-10-04). A signed calibration release is bound to
// the question's hash (US34, specification 18.4) and none ships in 1.2.0, so the wording was fixed before one is signed: the
// original text (563d51e), the text before this change (5003d42) and a candidate that names the thresholds in the names of the
// facts were asked live on the same nine fixed shapes, two runs each. fixtures/worker-readiness-wordings-measured.json holds the
// numbers; this test shows that the wording in route-worker.ts is the measured candidate, that it was the best of the three by
// correctness and by certainty, and replays its real answers through the product's own advice function.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackEngine } from './engine-settle.mjs';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');
const contracts = await import('@jevris/contracts');
const MEASURED = JSON.parse(readFileSync(new URL('./fixtures/worker-readiness-wordings-measured.json', import.meta.url), 'utf8'));

const stateOf = (row) => (row.certainty < core.WORKER_READINESS_MIN_CERTAINTY ? 'unsure' : row.noul >= 0.5 ? 'ready' : 'not-ready');
function tally(variant) {
  const rows = MEASURED.rows.filter((r) => r.variant === variant);
  const right = rows.filter((r) => stateOf(r) === r.expected);
  const certainties = right.map((r) => r.certainty);
  return { n: rows.length, right: right.length, unsure: rows.filter((r) => stateOf(r) === 'unsure').length, wrong: rows.filter((r) => stateOf(r) !== 'unsure' && stateOf(r) !== r.expected).length, minCertainty: Math.min(...certainties), meanCertainty: certainties.reduce((a, b) => a + b, 0) / certainties.length };
}

test('the wording in route-worker.ts is the measured candidate, and its hash differs from the two it replaced', () => {
  const shipped = contracts.questionHash(core.WORKER_READINESS_QUESTIONS);
  assert.equal(shipped, MEASURED.variants.candidate.questionHash, 'the text that was measured is the text that ships');
  assert.notEqual(shipped, MEASURED.variants.original.questionHash);
  assert.notEqual(shipped, MEASURED.variants.head.questionHash);
  assert.equal(core.workerCalibrationContext({ sliceId: 'bounded-edit', nowMs: 1 }).questionHash, shipped, 'a signed release binds to this hash');
});

test('measured on nine shapes, two runs each: the candidate read all 18 right at 0.90 or more, the earlier wording 16 right and two unsure, the original 10 right and 8 wrong', () => {
  assert.equal(new Set(MEASURED.rows.map((r) => r.shape)).size, 9);
  const original = tally('original');
  const head = tally('head');
  const candidate = tally('candidate');
  assert.deepEqual([original.n, original.right, original.unsure, original.wrong], [18, 10, 0, 8], 'the original never said a bounded task was ready');
  assert.deepEqual([head.n, head.right, head.unsure, head.wrong], [18, 16, 2, 0], 'the 40-file task read 0.53, under the floor');
  assert.deepEqual([candidate.n, candidate.right, candidate.unsure, candidate.wrong], [18, 18, 0, 0]);
  assert.ok(candidate.minCertainty >= 0.9, `the least certain right answer of the candidate is ${String(candidate.minCertainty)}`);
  // The pick rule: correctness first, then certainty on the clear cases; a tie goes to the simplest wording. The candidate wins on correctness, so no tie.
  assert.ok(candidate.right > head.right && head.right > original.right);
  assert.ok(candidate.meanCertainty > head.meanCertainty && candidate.meanCertainty > original.meanCertainty);
  // The shapes the launch asks (the rules do not answer them): the candidate 12 of 12, the earlier wording 10 of 12, the original 4 of 12.
  const askedRight = (variant) => MEASURED.rows.filter((r) => r.variant === variant && !r.rulesAnswerInProduct && stateOf(r) === r.expected).length;
  assert.deepEqual([askedRight('original'), askedRight('head'), askedRight('candidate')], [4, 10, 12]);
});

const manyFiles = (n) => Array.from({ length: n }, (_, i) => `src/module-${String(i)}.ts`);
const SHAPES = {
  'bounded-1file-check': { title: 'fix the parser bug', paths: ['src/parser.ts'], checkIds: ['unit-tests'] },
  '3files-check': { title: 'fix the parser bug', paths: ['src/parser.ts', 'src/lexer.ts', 'test/parser.test.ts'], checkIds: ['unit-tests'] },
  'no-check': { title: 'fix the parser bug', paths: ['src/parser.ts', 'src/lexer.ts', 'src/util.ts'], checkIds: [] },
  'protected-security-1file': { title: 'fix the login check', paths: ['src/auth/login.ts'], checkIds: ['unit-tests'] },
  '40-files-check': { title: 'refactor the importer', paths: manyFiles(40), checkIds: ['unit-tests'] },
  'no-files-no-check': { title: 'improve the product', paths: [], checkIds: [] },
  'docs-only-check': { title: 'update the install guide', paths: ['docs/guide.md', 'docs/install.md'], checkIds: ['lint-docs'] },
  migration: { title: 'migrate the users table', paths: ['db/migrations/0042_users.sql', 'src/db/users.ts'], checkIds: ['unit-tests'] },
  '8-files-2-checks': { title: 'rename the helper across the importer', paths: manyFiles(8), checkIds: ['unit-tests', 'lint'] },
};

test('the real answers of the shipped wording, replayed through adviseWorkerReadiness: the rules answer three shapes without a request, and the six it asks state the expected readiness', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'jevris-wordings-'));
  let tracker = null;
  t.after(async () => {
    try {
      await tracker?.settled();
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });
  const requests = [];
  let noul = 0.5;
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    return new Response(JSON.stringify({ model: body.model, answers: { workerReady: { type: 'noul', noul } }, usage: { input_tokens: 678, output_tokens: 8 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const engine = await provider.createSidecarEngine({ home, credential: 'test-key-not-a-secret', fetch, env: {}, sourceEgress: () => ({ provenance: 'administrator', sourceEgress: 'deny-until-approved' }) });
  tracker = trackEngine(engine);
  for (const [shape, hints] of Object.entries(SHAPES)) {
    const real = MEASURED.rows.filter((r) => r.variant === 'candidate' && r.shape === shape);
    assert.equal(real.length, 2, shape);
    const expected = real[0].expected;
    const before = requests.length;
    noul = real[0].noul;
    const advice = await core.adviseWorkerReadiness(engine, hints, { workspaceId: 'w-wordings', evidenceRevision: 'r1', taskId: `t-${shape}` }, { assist: 'classify', mode: 'bounded-auto', deadlineMs: 30_000 });
    if (real[0].rulesAnswerInProduct) {
      assert.deepEqual([advice.state, advice.source, advice.asked, requests.length - before], [expected, 'rules', false, 0], `${shape}: a fact decides, no request`);
    } else {
      assert.equal(requests.length - before, 1, `${shape}: asked once`);
      assert.deepEqual([advice.state, advice.source, advice.reasonCode, advice.probability], [expected, 'jev', 'WORKER_READINESS_JEV', real[0].noul], shape);
      assert.deepEqual(requests.at(-1).questions, JSON.parse(JSON.stringify(core.WORKER_READINESS_QUESTIONS)), 'the shipped wording is what is asked');
      assert.ok(real[0].certainty >= 0.9, `${shape}: the real answer was at 0.90 or more`);
    }
  }
});

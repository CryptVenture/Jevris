// Regression tests built from REAL jev-1.13.0 answers (fixtures/jev-real-answers.json: numbers observed
// on 2026-10-03 by the live feature suite for the product's own synthetic questions). The answers are
// replayed through the real engine, validators and gates, so what the live API did is what is tested:
// probabilities rounded to 0.01 (some with float noise, 0.27999999999999997), a Choice `confidence` that is
// not its top probability, a Score `score` that is the expected value of its distribution, and a
// Choice whose two best options tie (seen in 1 of 99 live Choice answers). No live call; scripted fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackEngine } from './engine-settle.mjs';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');

const REAL = JSON.parse(readFileSync(new URL('./fixtures/jev-real-answers.json', import.meta.url), 'utf8'));
const APPROVED = () => ({ provenance: 'administrator', sourceEgress: 'approved-scoped' });

/** Replays real answers: `pick(id, question)` returns a fixture answer (numbers only) for each question, or null. */
function replayFetch(pick) {
  const requests = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      const real = pick(id, q, body);
      if (real === null || real === undefined) continue;
      if (q.type === 'score') {
        answers[id] = { type: 'score', score: real.score, probabilities: real.probabilities, legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])), confidence: real.confidence };
      } else if (q.type === 'choice') {
        answers[id] = { type: 'choice', choice: real.choice, probabilities: real.probabilities, confidence: real.confidence };
      } else {
        answers[id] = { type: 'noul', noul: real.noul };
      }
    }
    return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 700, output_tokens: 100 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, requests };
}

async function setup(t, pick, sourceEgress = APPROVED) {
  const home = mkdtempSync(join(tmpdir(), 'jevris-real-'));
  let tracker = null;
  t.after(async () => {
    try {
      await tracker?.settled();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  const script = replayFetch(pick);
  const engine = await provider.createSidecarEngine({ home, credential: 'test-key-not-a-secret', fetch: script.fetch, env: {}, sourceEgress });
  tracker = trackEngine(engine);
  return { engine, requests: script.requests };
}

const IDS = { workspaceId: 'w-real', sessionId: 'sess-real' };

const FAMILIES = [...core.TASK_FAMILIES].sort();
const TIED = { type: 'choice', choice: 'scope', confidence: 0.24, probabilities: { scope: 0.35, acceptance: 0.35, target: 0.1, 'edge-cases': 0.1, compatibility: 0.05, none: 0.03, unknown: 0.02 } };

/** A real family answer (keyed by family name, as the first live run asked it) in C01's option keys (f0, f1, ...). */
function inOptionKeys(real) {
  const key = (name) => (name === 'none' || name === 'unknown' ? name : `f${FAMILIES.indexOf(name)}`);
  return { ...real, choice: key(real.choice), probabilities: Object.fromEntries(Object.entries(real.probabilities).map(([name, p]) => [key(name), p])) };
}

test('new-task from a real family answer: C01 selects the family at confidence 1.0, C02 asks nothing it is not sure of, and the line names the family', async (t) => {
  const real = REAL.newTask['newtask-clear'].answers;
  const { engine } = await setup(t, (id) => (id === 'taskFamily' ? inOptionKeys(real.family) : { noul: 0.1 }));
  const advice = await provider.adviseNewTask(engine, 'Fix the failing unit test in the date parser: parse("2026-02-30") should throw an error instead of returning March 2.', { assist: 'classify', mode: 'bounded-auto', deadlineMs: 30_000, ids: IDS });
  assert.deepEqual([advice.family, advice.open, advice.text, advice.reasonCode], ['bugfix', null, 'Jevris: This looks like a bugfix task.', 'NEW_TASK_JEV']);
});

test('a tie in one Choice does not throw away the other answers of the request (a tied family-less secondary question beside a confident one)', async (t) => {
  // Live (the first design asked a family Choice and an open-question Choice in one request), the open question's two best
  // options came back 0.35 and 0.35 (confidence 0.24) beside a family answer of 1.0; the whole decision was abstained as
  // CHOICE_TIE and the paid-for family answer was lost. The engine's rule is general: it holds for any request of two Choices.
  const real = REAL.newTask['newtask-clear'].answers;
  const { engine } = await setup(t, (id) => (id === 'family' ? real.family : TIED));
  const questions = {
    family: { type: 'choice', instructions: 'Which listed workflow family fits the request in the evidence item request?', criteria: Object.fromEntries([...core.TASK_FAMILIES, 'none', 'unknown'].map((f) => [f, core.TASK_FAMILY_TEXT[f] ?? `No family (${f}).`])) },
    open: { type: 'choice', instructions: 'Which one open question about the request in the evidence item request would most change the implementation?', criteria: Object.fromEntries(['scope', 'acceptance', 'target', 'edge-cases', 'compatibility', 'none', 'unknown'].map((k) => [k, `The request leaves ${k} open.`])) },
  };
  const packet = { objective: 'Read the one request in the evidence (advice only).', trustedPolicy: { grantsAuthority: false }, facts: {}, evidence: [{ id: 'request', text: 'Fix the failing unit test in the date parser.', sourceKind: 'user', priority: 'mandatory' }] };
  const asked = await core.askBoundedDecision(engine, 'tie-regression', questions, packet, { ...IDS, evidenceRevision: 'rev-1', deadlineMs: 30_000 }, true);
  assert.equal(asked.ok, true, 'the decision still answers');
  assert.equal(asked.answers.family.choice, 'bugfix', 'the confident family answer is used');
  assert.equal(asked.answers.open, undefined, 'the tied question is dropped');
  const record = await engine.lookup(asked.decisionId);
  assert.equal(record.outcome, 'advisory');
  assert.ok(record.reasonCodes.includes('CHOICE_TIE_DROPPED'), record.reasonCodes.join(','));
});

test('when every answer of a request ties, or the only question ties, the decision still abstains as CHOICE_TIE', async (t) => {
  const { engine } = await setup(t, () => TIED);
  const questions = { open: { type: 'choice', instructions: 'Which one open question about the request in the evidence item request would most change the implementation?', criteria: Object.fromEntries(['scope', 'acceptance', 'target', 'edge-cases', 'compatibility', 'none', 'unknown'].map((k) => [k, `The request leaves ${k} open.`])) } };
  const packet = { objective: 'Read the one request in the evidence (advice only).', trustedPolicy: { grantsAuthority: false }, facts: {}, evidence: [{ id: 'request', text: 'Fix the failing unit test in the date parser.', sourceKind: 'user', priority: 'mandatory' }] };
  const asked = await core.askBoundedDecision(engine, 'tie-regression-2', questions, packet, { ...IDS, evidenceRevision: 'rev-1', deadlineMs: 30_000 }, true);
  assert.deepEqual([asked.ok, asked.reasonCode], [false, 'CHOICE_TIE'], 'the only Choice tied: nothing usable');
  // And through the adviser: C01 tied, C02 sure of nothing, so there is nothing to say and the reason says why.
  const tiedFamily = { type: 'choice', choice: 'f0', confidence: 0.5, probabilities: { f0: 0.25, f1: 0.25, f2: 0.2, f3: 0.1, f4: 0.1, f5: 0.05, f6: 0.03, f7: 0.01, none: 0.01, unknown: 0 } };
  const adviser = await setup(t, (id) => (id === 'taskFamily' ? tiedFamily : { noul: 0.5 }));
  const advice = await provider.adviseNewTask(adviser.engine, 'Fix the failing unit test in the date parser: parse("2026-02-30") should throw an error.', { assist: 'classify', mode: 'bounded-auto', deadlineMs: 30_000, ids: IDS });
  assert.equal(advice.text, null);
  assert.notEqual(advice.family, 'bugfix');
});

test('check ranking from real answers: Jev orders by its expected score, to half a level, and a flat answer keeps the rules order, not the input order', async (t) => {
  const checks = ['unit-tests', 'lint', 'typecheck', 'build', 'coverage', 'docs-lint', 'pack-smoke', 'e2e'].map((id) => ({ id, state: 'missing' }));
  const ctx = { workspaceId: 'w-real' };
  const ask = { assist: 'classify', deadlineMs: 30_000 };
  // A change that edits a doc, a test and a config file (no source): the rules are not sure, so Jev is asked. Live, every
  // answer came back at level 2 (1.62 to 2.27, confidence 0.56 to 0.73): level 2 for all, so the order fell to the INPUT order.
  const flat = REAL.checks['docs-test-config'].answers;
  const { engine } = await setup(t, (id) => flat[id] ?? null);
  const paths = ['docs/a.md', 'test/a.test.ts', 'package.json'];
  const rules = [...core.rulesOrderOf({ checks, paths }, 'X').order];
  const ranking = await core.rankChecks(engine, { checks, paths }, ctx, ask);
  assert.equal(ranking.source, 'jev');
  assert.deepEqual([...ranking.order].sort(), checks.map((c) => c.id).sort(), 'every check is in the order exactly once');
  // Typecheck scored 2.27 (half a level above the rest); unit-tests, lint, build, e2e, coverage and docs-lint scored 1.83 to 2.14,
  // all level 2 at half-level resolution; pack-smoke's answer (confidence 0.56) is not used. Ties are broken by the rules' own
  // score (the test, lint and build kinds above coverage and docs for this change), then a scored check before an unscored one.
  // With the old rounding (all level 2, ties to the input order) the e2e check came last: unit-tests, lint, typecheck, build, coverage, docs-lint, pack-smoke, e2e.
  assert.deepEqual(ranking.order, ['typecheck', 'unit-tests', 'lint', 'build', 'e2e', 'coverage', 'docs-lint', 'pack-smoke']);
  assert.notDeepEqual(ranking.order, checks.map((c) => c.id), 'not the input order');
  assert.ok(rules.indexOf('e2e') < rules.indexOf('coverage'), 'the rules rank the e2e test check above coverage for this change, and so does the answer');
});

test('check ranking from real answers: confident extremes move a check, the rest keep the rules (docs-lint at 0.01 with confidence 0.99 goes last)', async (t) => {
  const checks = ['unit-tests', 'lint', 'typecheck', 'build', 'coverage', 'docs-lint', 'pack-smoke', 'e2e'].map((id) => ({ id, state: 'missing' }));
  const real = REAL.checks['source-and-test'].answers;
  const { engine } = await setup(t, (id) => real[id] ?? null);
  const ranking = await core.rankChecks(engine, { checks, paths: ['src/a.ts', 'test/a.test.ts'] }, { workspaceId: 'w-real' }, { assist: 'classify', deadlineMs: 30_000 });
  assert.equal(ranking.source, 'jev');
  assert.equal(ranking.order.at(-1), 'docs-lint', 'Jev rated the docs check 0.01 of 4 at confidence 0.99');
  assert.equal(ranking.order[0], 'unit-tests');
  assert.equal(ranking.usedCount, 2, 'only the two answers at confidence 0.6 or more are used (typecheck 0.79, docs-lint 0.99)');
});

test('the check-ranking request tells Jev what each kind of check covers (live: without it a test run scored 1.07 of 4 for a source change)', async (t) => {
  const checks = ['unit-tests', 'lint', 'typecheck'].map((id) => ({ id, state: 'missing' }));
  const { engine, requests } = await setup(t, () => null);
  await core.rankChecks(engine, { checks, paths: ['src/a.ts', 'test/a.test.ts'] }, { workspaceId: 'w-real' }, { assist: 'classify', deadlineMs: 30_000 });
  assert.equal(requests.length, 1);
  const legend = requests[0].state.trustedPolicy.kinds;
  assert.match(legend.test, /covers the behaviour of changed source and test files/);
  assert.match(legend.docs, /changed documentation files only/);
  const anchors = requests[0].questions.c1.criteria;
  assert.equal(anchors.length, 5);
  assert.match(anchors[0], /covers none of the changed files/);
  assert.match(requests[0].questions.c1.instructions, /trusted policy explains what each kind covers/);
});

test('real slice answers are accepted by the validators: probabilities with float noise, a confidence that is not the top probability', async (t) => {
  const real = REAL.slice.feature.answers;
  const { engine } = await setup(t, (id) => real[id] ?? null);
  const r = await core.classifyTaskSlice(engine, { title: 'Add a dark mode toggle to the settings page', paths: ['src/settings/page.tsx', 'src/settings/theme.ts', 'src/styles/theme.css'], checkIds: ['unit-tests'] }, { workspaceId: 'w-real', evidenceRevision: 'r1', deadlineMs: 30_000 }, { assist: 'classify' });
  assert.equal(r.jevSlice, 'feature', 'Jev answered and the answer was accepted');
  assert.equal(r.confidence, 0.36, 'the provider confidence, not the 0.42 top probability');
  assert.equal(r.reasonCode, 'SLICE_JEV_LOW_CONFIDENCE', 'below 0.6: the rules slice stands');
  assert.equal(r.sliceId, 'feature');
  assert.equal(r.source, 'rules');
});

test('a real defect-fix answer (issue-fix at 0.84 over the rules test-fix) is used over the weak rules slice', async (t) => {
  // v2 definitions: the same request the live API read as test-fix with the v1 text. The answer shape is the real one.
  const real = REAL.slice['bugfix-with-test'].answers;
  const answer = { ...real, slice: { type: 'choice', choice: 'issue-fix', confidence: 0.84, probabilities: { 'issue-fix': 0.85, 'test-fix': 0.07, 'bounded-edit': 0.08, feature: 0, refactor: 0, docs: 0, review: 0, research: 0, debug: 0, migration: 0, terminal: 0, unknown: 0 } } };
  const { engine } = await setup(t, (id) => answer[id] ?? null);
  const r = await core.classifyTaskSlice(engine, { title: 'Fix crash when parsing empty input', paths: ['src/parse.ts', 'test/parse.test.ts'], checkIds: ['unit-tests'] }, { workspaceId: 'w-real', evidenceRevision: 'r1', deadlineMs: 30_000 }, { assist: 'classify' });
  assert.deepEqual([r.sliceId, r.source, r.reasonCode, r.rulesAlternative], ['issue-fix', 'jev', 'SLICE_JEV_OVER_RULES', 'test-fix']);
});

test('repeated failure from a real same-failure answer: a Noul of 0.73 is used, and the artifact stays the rules\' pick', async (t) => {
  // fail-unsure-3 is the live answer to the same-failure question (0.73) asked beside the "which artifact next" Choice of the first
  // design; only the Noul is replayed, because that Choice was measured and removed (failure-next-artifact-measured.test.mjs).
  const real = REAL.failure['fail-unsure-3'].answers;
  const { engine, requests } = await setup(t, (id) => (id === 'same' ? { noul: real.same.noul } : null), () => ({ provenance: 'administrator', sourceEgress: 'deny-until-approved' }));
  const features = provider.parseFailureFeatures({ toolClass: 'shell', exitClass: 'nonzero', family: 'shell:nonzero', signature: 'bbbbbbbbbbbbbbbb', commandDigest: 'cccccccccccccccc', environmental: false, elapsed: 'lt10s', present: [] });
  const context = provider.failureContextOf(features, { attempts: 3, sameCommand: true, editsSince: 0, unsure: true, previous: { environmental: false, elapsed: 'lt10s', present: [] } }, 9);
  const advice = await provider.adviseRepeatedFailure(engine, context, { assist: 'classify', deadlineMs: 30_000, ids: IDS });
  assert.deepEqual([advice.source, advice.reasonCode, advice.sameByJev, advice.next, advice.askedCount], ['jev', 'REPEATED_FAILURE_JEV', true, 'failing-test-output', 1]);
  assert.deepEqual(Object.keys(requests[0].questions), ['same'], 'the one question');
});

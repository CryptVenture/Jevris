import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');
const contracts = await import('@jevris/contracts');

/**
 * A scripted Jev endpoint: `answer(id, question)` returns a partial answer, completed here into
 * a valid wire answer. Every request body is recorded.
 */
function scriptedFetch(answer) {
  const requests = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      const want = answer(id, q, body) ?? {};
      if (q.type === 'noul') answers[id] = { type: 'noul', noul: want.noul ?? 0.5 };
      else if (q.type === 'score') {
        const level = want.score ?? 0;
        const probabilities = Object.fromEntries(q.criteria.map((_, i) => [String(i), i === level ? 1 : 0]));
        answers[id] = { type: 'score', score: level, probabilities, legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])), confidence: 1 };
      } else {
        const keys = Object.keys(q.criteria);
        const given = want.probabilities ?? { [want.choice ?? keys[0]]: 0.9 };
        const rest = keys.filter((k) => !(k in given));
        const left = 1 - Object.values(given).reduce((a, b) => a + b, 0);
        const probabilities = Object.fromEntries(keys.map((k) => [k, k in given ? given[k] : Math.round((left / rest.length) * 10000) / 10000]));
        const choice = want.choice ?? keys.reduce((a, b) => (probabilities[b] > probabilities[a] ? b : a));
        answers[id] = { type: 'choice', choice, probabilities, confidence: probabilities[choice] };
      }
    }
    return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 300, output_tokens: 10 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, requests };
}

const APPROVED = () => ({ provenance: 'administrator', sourceEgress: 'approved-scoped' });
const DENIED = () => ({ provenance: 'administrator', sourceEgress: 'deny-until-approved' });

async function engineWith(t, answer, sourceEgress = APPROVED) {
  const home = mkdtempSync(join(tmpdir(), 'jevris-intent-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const script = scriptedFetch(answer);
  const engine = await provider.createSidecarEngine({ home, credential: 'test-key-not-a-secret', fetch: script.fetch, env: {}, sourceEgress });
  return { engine, requests: script.requests };
}

// The scripted provider answers at once; a generous deadline keeps a loaded machine (a full suite
// at load average ~20 took 2.3 s here) from turning the 2 s default into a deadline abstain.
const CTX = { workspaceId: 'w-intent', evidenceRevision: 'rev-1', taskId: 'task-1', deadlineMs: 30_000 };
const T = (id, family, extra = {}) => ({ id, family, summary: `Steps for ${family} work`, trusted: true, source: 'installed', ...extra });
const TEMPLATES = [T('bugfix-basic', 'bugfix', { tags: ['test', 'bug'] }), T('bugfix-regression', 'bugfix', { tags: ['regression', 'bug'] }), T('docs-page', 'docs', { tags: ['docs'] }), { id: 'deploy-remote', family: 'deploy', summary: 'Remote deploy steps', trusted: false, source: 'external', tags: ['bug'] }];

test('INT-01: triage selects a trusted family or abstains, and always preserves the original request', async (t) => {
  let script = { choice: 'f0', probabilities: { f0: 0.8 } };
  const { engine, requests } = await engineWith(t, () => script);
  const objective = 'Fix the crash when the cart is empty';
  const selected = await core.triageTaskFamily(engine, { objective, templates: TEMPLATES }, CTX);
  assert.deepEqual([selected.outcome, selected.family, selected.templateIds], ['selected', 'bugfix', ['bugfix-basic', 'bugfix-regression']]);
  assert.equal(selected.originalRequest, objective);
  const q = requests[0].questions.taskFamily;
  assert.deepEqual(Object.keys(q.criteria), ['f0', 'f1', 'none', 'unknown'], 'only trusted installed families are options');
  assert.equal(JSON.stringify(requests[0]).includes('deploy'), false);
  for (const [want, reason] of [[{ choice: 'none', probabilities: { none: 0.9 } }, 'NO_TEMPLATE_FITS'], [{ choice: 'unknown', probabilities: { unknown: 0.9 } }, 'FAMILY_UNKNOWN'], [{ choice: 'f0', probabilities: { f0: 0.45, f1: 0.4 } }, 'LOW_CONFIDENCE']]) {
    script = want;
    // A different request (the cache keys on packet content, not the revision label).
    const request = `${objective} (${reason})`;
    const out = await core.triageTaskFamily(engine, { objective: request, templates: TEMPLATES }, CTX);
    assert.deepEqual([out.outcome, out.reasonCode, out.family, out.originalRequest], ['abstain', reason, null, request]);
  }
  const before = requests.length;
  const none = await core.triageTaskFamily(engine, { objective, templates: [TEMPLATES[3]] }, CTX);
  assert.deepEqual([none.outcome, none.reasonCode, none.originalRequest], ['abstain', 'NO_TRUSTED_TEMPLATES', objective]);
  assert.equal(requests.length, before, 'no call without a trusted template');
});

test('INT-02: the template shortlist reads metadata only and never installs an external suggestion', async (t) => {
  const { engine, requests } = await engineWith(t, () => ({ probabilities: { t1: 0.7, t0: 0.2 } }));
  const guarded = TEMPLATES.map((tpl) => Object.defineProperty({ ...tpl }, 'body', { get() { throw new Error('a template body was loaded'); }, enumerable: false }));
  const out = await core.shortlistTemplates(engine, { taskProfile: { family: 'bugfix', tags: ['bug', 'regression'] }, templates: guarded }, CTX);
  assert.equal(out.reasonCode, 'RANKED');
  assert.deepEqual(out.shortlist, ['bugfix-basic', 'bugfix-regression']);
  assert.deepEqual(out.external, [{ id: 'deploy-remote', action: 'review-manually' }]);
  assert.deepEqual(out.installActions, []);
  assert.equal(JSON.stringify(requests).includes('deploy-remote'), false, 'an external template is never an option');
  const single = await core.shortlistTemplates(engine, { taskProfile: { tags: ['docs'] }, templates: guarded }, CTX);
  assert.deepEqual([single.shortlist, single.reasonCode, single.decisionId], [['docs-page'], 'SINGLE_MATCH', null]);
});

const UNKNOWNS = [
  { id: 'u-sort', topic: 'Should the list sort by name or by date', options: ['name', 'date'], consequence: 'only the display order' },
  { id: 'u-store', topic: 'Should labels be stored per user or per account', options: ['per user', 'per account'], consequence: 'the database schema and the migration' },
];

test('INT-03: ambiguity asks one consequence-focused question only when material, and never answers it', async (t) => {
  let noul = { material0: 0.3, material1: 0.85 };
  const { engine, requests } = await engineWith(t, (id) => ({ noul: noul[id] }));
  const asked = await core.detectAmbiguity(engine, { objective: 'Add labels', unknowns: UNKNOWNS }, CTX);
  assert.equal(asked.outcome, 'ask');
  assert.equal(asked.question.unknownId, 'u-store');
  assert.equal(asked.question.text, 'Should labels be stored per user or per account? This decides the database schema and the migration. Options: per user, per account.');
  assert.equal(asked.answer, null, 'the answer is left to the person');
  // The untrusted topic travels as evidence, never in the question text.
  assert.equal(JSON.stringify(requests[0].questions).includes('per account'), false);
  noul = { material0: 0.3, material1: 0.4 };
  const calm = await core.detectAmbiguity(engine, { objective: 'Add labels to orders', unknowns: UNKNOWNS }, CTX);
  assert.deepEqual([calm.outcome, calm.reasonCode, calm.question], ['proceed', 'NOT_MATERIAL', null]);
  const n = requests.length;
  assert.equal((await core.detectAmbiguity(engine, { objective: 'Add labels', unknowns: [] }, CTX)).reasonCode, 'NO_EXPLICIT_UNKNOWNS');
  assert.equal(requests.length, n);
});

test('INT-03/INT-04 (paired): without approved egress, evidence-dependent questions are not asked', async (t) => {
  const { engine, requests } = await engineWith(t, () => ({ noul: 0.9 }), DENIED);
  const amb = await core.detectAmbiguity(engine, { objective: 'Add labels', unknowns: UNKNOWNS }, CTX);
  assert.deepEqual([amb.outcome, amb.reasonCode], ['proceed', 'EGRESS_NOT_APPROVED']);
  const suff = await core.checkEvidenceSufficiency(engine, { objective: 'Fix the failing test', required: [{ id: 'log', description: 'test log', available: true, fresh: true }], approvedRoots: ['/w'] }, CTX);
  assert.deepEqual([suff.outcome, suff.reasonCode], ['undetermined', 'EGRESS_NOT_APPROVED']);
  assert.equal(requests.length, 0);
});

test('INT-04 (features): over the fixed artifact vocabulary, sufficiency is asked with egress denied and no text of the caller leaves', async (t) => {
  const { engine, requests } = await engineWith(t, (id) => (id === 'sufficient' ? { noul: 0.1 } : { probabilities: { a0: 0.8 } }), DENIED);
  const r = await core.checkEvidenceSufficiency(engine, {
    objective: 'Find out why the nightly job fails, TEXT-MARKER-OBJECTIVE',
    required: [{ id: 'failing-test-output', description: 'free text TEXT-MARKER-DESCRIPTION', available: true, fresh: true }],
    obtainable: [{ id: 'stack-trace', description: 'free text TEXT-MARKER-OPTION', available: false, fresh: null }, { id: 'logs', description: 'job logs', available: false, fresh: null }],
    approvedRoots: [],
  }, CTX);
  assert.equal(requests.length, 1, 'the fixed vocabulary needs no egress approval');
  assert.doesNotMatch(JSON.stringify(requests[0]), /TEXT-MARKER/, 'neither the objective nor a description is sent while egress is denied');
  assert.deepEqual([r.outcome, r.reasonCode, r.artifact.id], ['request-artifact', 'REQUEST_BEFORE_ESCALATION', 'stack-trace']);
});

test('INT-04: a specific missing artifact is requested before escalation, only from an approved root', async (t) => {
  let script = { sufficient: { noul: 0.8 } };
  const { engine, requests } = await engineWith(t, (id) => script[id]);
  const base = { objective: 'Fix the failing test', approvedRoots: ['/w/repo'] };
  const missing = await core.checkEvidenceSufficiency(engine, { ...base, required: [{ id: 'junit', description: 'JUnit report of the failing run', available: false, fresh: null, location: '/w/repo/build/junit.xml' }] }, CTX);
  assert.deepEqual([missing.outcome, missing.reasonCode, missing.artifact.location, missing.escalate, missing.notObserved], ['request-artifact', 'MISSING_REQUIRED_ARTIFACT', '/w/repo/build/junit.xml', false, ['junit']]);
  const outside = await core.checkEvidenceSufficiency(engine, { ...base, required: [{ id: 'junit', description: 'JUnit report', available: false, fresh: null, location: '/etc/passwd' }] }, CTX);
  assert.equal(outside.artifact.location, null, 'a location outside the approved roots is never suggested');
  assert.equal(core.withinApprovedRoots('/w/repo/../other/x', ['/w/repo']), false);
  const stale = await core.checkEvidenceSufficiency(engine, { ...base, required: [{ id: 'log', description: 'CI log', available: true, fresh: false }] }, CTX);
  assert.equal(stale.reasonCode, 'STALE_ARTIFACT');
  assert.equal(requests.length, 0, 'the rules answered without a call');
  const present = [{ id: 'log', description: 'CI log of the failing run', available: true, fresh: true }];
  const enough = await core.checkEvidenceSufficiency(engine, { ...base, required: present }, CTX);
  assert.deepEqual([enough.outcome, enough.reasonCode], ['sufficient', 'EVIDENCE_SUFFICIENT']);
  script = { sufficient: { noul: 0.2 }, nextArtifact: { probabilities: { a1: 0.8 } } };
  const obtainable = [{ id: 'coverage', description: 'coverage report', available: true, fresh: true }, { id: 'env', description: 'environment dump', available: true, fresh: true, location: '/w/repo/env.txt' }];
  const next = await core.checkEvidenceSufficiency(engine, { ...base, required: present, obtainable }, { ...CTX, evidenceRevision: 'rev-2' });
  assert.deepEqual([next.outcome, next.reasonCode, next.artifact.id, next.artifact.location, next.escalate], ['request-artifact', 'REQUEST_BEFORE_ESCALATION', 'env', '/w/repo/env.txt', false]);
});

test('INT-05: only the out-of-scope part pauses, and approval counts only from a trusted channel', async (t) => {
  const { engine, requests } = await engineWith(t, () => ({ noul: 0.9 }));
  const out = await core.detectScopeChange(engine, {
    approvedScope: { paths: ['src/cart'], effects: ['show an empty-cart message'] },
    diff: [{ path: 'src/cart/view.ts' }, { path: 'src/billing/charge.ts' }],
    requestedEffects: ['show an empty-cart message', 'send a marketing email', 'log the cart size', 'delete old carts'],
    approvals: [{ effect: 'delete old carts', channel: 'repository' }, { effect: 'log the cart size', channel: 'user-prompt' }],
  }, CTX);
  assert.deepEqual(out.continue.map((c) => c.item), ['src/cart/view.ts', 'show an empty-cart message', 'log the cart size']);
  assert.deepEqual(out.paused.map((p) => p.item), ['src/billing/charge.ts', 'send a marketing email', 'delete old carts']);
  assert.ok(out.paused.every((p) => /approve it in the session/.test(p.explanation)));
  assert.deepEqual(out.ignoredApprovals, [{ effect: 'delete old carts', channel: 'repository', reasonCode: 'UNTRUSTED_APPROVAL_CHANNEL' }]);
  // Repository text did not approve 'delete old carts', so it was judged with the new effect.
  assert.deepEqual(Object.keys(requests[0].questions), ['outside0', 'outside1']);
});

test('INT-05 (paired): without approved egress, a new effect stays paused; paths are still checked', async (t) => {
  const { engine, requests } = await engineWith(t, () => ({ noul: 0.1 }), DENIED);
  const out = await core.detectScopeChange(engine, { approvedScope: { paths: ['src/cart'], effects: [] }, diff: [{ path: 'src/cart/a.ts' }], requestedEffects: ['send a marketing email'] }, CTX);
  assert.deepEqual(out.continue.map((c) => c.item), ['src/cart/a.ts']);
  assert.deepEqual(out.paused.map((p) => p.item), ['send a marketing email']);
  assert.equal(requests.length, 0);
});

const node = (id, requirementIds, deps = [], scope = `src/${id}`) => ({
  id, schemaVersion: '1.0', workspaceId: 'w-intent', revision: 'r1', state: 'proposed', requirementIds, dependencyIds: deps, writeScopes: [scope], acceptanceCheckIds: ['unit'], rootBudgetId: 'budget-1',
});

test('INT-06: deterministic graph and coverage checks come first; the Score is a review aid, never feasibility', async (t) => {
  const { engine, requests } = await engineWith(t, (id) => ({ score: id === 'coverage0' ? 3 : 1 }));
  const cyclic = await core.auditDecomposition(engine, { requirements: [{ id: 'R1', text: 'Show labels' }], tasks: [node('a', ['R1'], ['b']), node('b', ['R1'], ['a'])] }, CTX);
  assert.deepEqual([cyclic.valid, cyclic.reasonCode, cyclic.coverageReview], [false, 'GRAPH_INVALID', []]);
  assert.equal(requests.length, 0, 'an invalid graph is never scored');
  const audit = await core.auditDecomposition(engine, {
    requirements: [{ id: 'R1', text: 'Show labels' }, { id: 'R2', text: 'Store labels per account' }, { id: 'R3', text: 'Export labels' }],
    tasks: [node('a', ['R1']), node('b', ['R2'], ['a'])],
  }, CTX);
  assert.equal(audit.valid, true);
  assert.deepEqual(audit.coverageReview.map((c) => [c.requirementId, c.score]), [['R1', 3], ['R2', 1]]);
  assert.deepEqual(audit.issues, [{ id: 'R3', code: 'UNCOVERED_REQUIREMENT' }, { id: 'R2', code: 'REVIEW_COVERAGE' }]);
  assert.deepEqual([audit.label, audit.isFeasibility], ['decomposition-review-score', false]);
  assert.equal(/feasib/i.test(JSON.stringify(requests)), false, 'no question calls the score feasibility');
  for (const anchor of core.COVERAGE_RUBRIC) assert.equal(/feasib/i.test(anchor), false);
});

test('INT-07: plans are ranked by ordinal anchors for planner review; a high score is not feasibility', async (t) => {
  const scores = { plan0: 2, plan1: 4, plan2: 1 };
  const { engine, requests } = await engineWith(t, (id) => ({ score: scores[id] }));
  const plans = ['p-small', 'p-full', 'p-quick'].map((id) => ({ id, summary: `Plan ${id}`, constraints: ['keep the API'], tradeoffs: ['time versus scope'] }));
  const ranked = await core.rankPlanCandidates(engine, { plans }, CTX);
  assert.deepEqual(ranked.ranking.map((r) => [r.planId, r.score, r.rank]), [['p-full', 4, 1], ['p-small', 2, 2], ['p-quick', 1, 3]]);
  assert.deepEqual([ranked.reviewRequired, ranked.reviewStep, ranked.isFeasibility, ranked.label], [true, 'planner-review', false, 'plan-review-score']);
  assert.equal(ranked.ranking[0].anchor, core.PLAN_RUBRIC[4]);
  assert.match(ranked.note, /not evidence that a plan is feasible/);
  assert.equal(requests[0].questions.plan0.criteria.length, 5);
  const one = await core.rankPlanCandidates(engine, { plans: plans.slice(0, 1) }, CTX);
  assert.deepEqual([one.reasonCode, one.ranking[0].score], ['FEWER_THAN_TWO_PLANS', null]);
  // Each capability's decision is a normal journal record.
  assert.equal(contracts.DecisionRecordContract.validate(await engine.lookup(ranked.decisionId)).ok, true);
});

function handlerInput(engine, body, { root = '/work/repo', trigger = 'new-task', revision = 'rev-h1' } = {}) {
  return {
    ctx: { op: 'event', client: 'hook', scopes: ['observe'], workspace: { id: 'w-intent', root }, body, home: '/nonexistent', signal: new AbortController().signal, deadline: { remainingMs: () => 800, expired: () => false }, store: null, killSwitchStopped: false, engine, trace() {} },
    envelope: { workspaceId: 'w-intent', sessionId: 'sess-h', expectedRevision: revision, taskId: 'task-h' },
    event: {}, trigger, engine, queues: {},
  };
}

// INT-01, INT-02 and INT-03 on the hook path are `live-new-task-advice.test.mjs`: one handler (`newTaskAdvice`) runs C01, C04 and C02,
// detached, with egress approved only. The older handler that ran the same decisions on a body's own templates and unknowns is gone.

test('INT-04 wiring: after a failure, a missing artifact is requested before escalation, only inside the workspace root', async (t) => {
  const { engine, requests } = await engineWith(t, () => ({ noul: 0.2 }));
  const required = [{ id: 'failing-log', description: 'the full failing test log', available: false, fresh: null, location: '/work/repo/test.log' }];
  const inside = await provider.evidenceAdvice(handlerInput(engine, { evidence: { required } }, { trigger: 'repeated-failure' }));
  assert.equal(inside.reasonCode, 'MISSING_REQUIRED_ARTIFACT');
  assert.match(inside.hookOutcome.text, /before escalating, get failing-log: the full failing test log \(\/work\/repo\/test\.log\)\./);
  const outside = await provider.evidenceAdvice(handlerInput(engine, { evidence: { required: [{ ...required[0], location: '/etc/secret.log' }] } }, { trigger: 'repeated-failure' }));
  assert.equal(outside.hookOutcome.text.includes('/etc'), false, 'a location outside the approved root is never suggested');
  const noRoot = await provider.evidenceAdvice(handlerInput(engine, { evidence: { required } }, { root: null, trigger: 'new-failure-family' }));
  assert.equal(noRoot.hookOutcome.text.includes('/work'), false, 'no workspace root: no location');
  assert.equal(requests.length, 0, 'the missing artifact is found by rule, with no call');
  assert.equal(await provider.evidenceAdvice(handlerInput(engine, {})), null);
});

test('INT-05 wiring: at a diff boundary only the out-of-scope part pauses; an untrusted approval does not count', async (t) => {
  const { engine } = await engineWith(t, () => ({ noul: 0.9 }));
  const scope = { approvedScope: { paths: ['src/cart'], effects: [] }, diff: [{ path: 'src/cart/total.ts' }, { path: 'infra/deploy.yml' }], requestedEffects: [], approvals: [] };
  const paused = await provider.scopeChangeAdvice(handlerInput(engine, { scope }, { trigger: 'diff-boundary' }));
  assert.equal(paused.reasonCode, 'SCOPE_CHANGE');
  assert.match(paused.hookOutcome.text, /infra\/deploy\.yml/);
  assert.equal(paused.hookOutcome.text.includes('src/cart/total.ts'), false);
  const inScope = await provider.scopeChangeAdvice(handlerInput(engine, { scope: { ...scope, diff: [{ path: 'src/cart/total.ts' }] } }, { trigger: 'diff-boundary' }));
  assert.equal(inScope, null);
  // The product shape: F's hooks send { diff, requestedEffects } and the sidecar adds D's
  // approvedScopeFor (the leased task's write scopes, glob patterns included).
  const { engine: counted, requests } = await engineWith(t, () => ({ noul: 0.9 }));
  const product = { diff: [{ path: 'src/cart/a.ts' }, { path: 'docs/notes.md' }], requestedEffects: [], approvedScope: { taskId: 'T1', paths: ['src/*'], effects: [] } };
  const productPaused = await provider.scopeChangeAdvice(handlerInput(counted, { scope: product }, { trigger: 'diff-boundary' }));
  assert.equal(productPaused.reasonCode, 'SCOPE_CHANGE');
  assert.match(productPaused.hookOutcome.text, /docs\/notes\.md is outside the approved paths \(src\/\*\)/);
  assert.equal(productPaused.hookOutcome.text.includes('src/cart/a.ts'), false);
  assert.equal(requests.length, 0, 'paths are judged deterministically; no provider call');
  assert.equal(await provider.scopeChangeAdvice(handlerInput(counted, { scope: { diff: product.diff, requestedEffects: [] } }, { trigger: 'diff-boundary' })), null, 'no approved scope yet: nothing is paused');
});

test('INT-06/INT-07 wiring: the plan op adds a review block only when asked, inside the plan contract', async (t) => {
  const { engine } = await engineWith(t, (id) => ({ score: id === 'plan1' ? 4 : id === 'coverage0' ? 3 : 1 }));
  const plan = provider.sidecarOps.find((def) => def.op === 'plan');
  const call = (body) => plan.handle({ ...handlerInput(engine, body).ctx, op: 'plan', client: 'cli', scopes: ['advice'] });
  const tasks = [node('a', ['R1']), node('b', ['R2'], ['a'])];
  const bare = await call({ tasks });
  assert.equal(bare.ok, true, JSON.stringify(bare));
  assert.equal('review' in bare.body, false, 'no requirements or candidates: the plan payload is unchanged');
  const out = await call({
    tasks,
    requirements: [{ id: 'R1', text: 'Show labels in the cart' }, { id: 'R2', text: 'Store labels per account' }, { id: 'R3', text: 'Export labels to CSV' }],
    candidates: [{ id: 'p-small', summary: 'Ship labels first', constraints: ['keep the API'] }, { id: 'p-full', summary: 'Ship labels and export', tradeoffs: ['more time'] }],
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(contracts.surfacePayloadContract('plan').validate(out.body).ok, true);
  assert.deepEqual(out.body.review.decomposition.coverage, [{ requirementId: 'R1', score: 3 }, { requirementId: 'R2', score: 1 }]);
  assert.deepEqual(out.body.review.decomposition.issues.map((i) => i.code), ['UNCOVERED_REQUIREMENT', 'REVIEW_COVERAGE']);
  assert.deepEqual(out.body.review.plans.ranking.map((r) => [r.planId, r.rank]), [['p-full', 1], ['p-small', 2]]);
  assert.deepEqual([out.body.review.plans.reviewRequired, out.body.review.plans.isFeasibility], [true, false]);
  const cyclic = await call({ tasks: [node('a', ['R1'], ['b']), node('b', ['R1'], ['a'])], requirements: [{ id: 'R1', text: 'Show labels in the cart' }] });
  assert.deepEqual([cyclic.body.valid, cyclic.body.review.decomposition.reasonCode, cyclic.body.review.plans], [false, 'GRAPH_INVALID', null]);
  const bad = await call({ tasks, candidates: [{ id: 'bad id', summary: 'x' }] });
  assert.equal(bad.ok, false);
});

// ------------------------------------------------------------------ DEC-12 / US31 late decisions

const LATE_UNKNOWNS = [{ id: 'u1', topic: 'Should totals round per line or per order', options: ['per line', 'per order'], consequence: 'the stored invoice amounts' }];

/** An engine whose first provider request runs `during()` before it is answered. */
async function lateEngine(t) {
  const home = mkdtempSync(join(tmpdir(), 'jevris-late-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const script = scriptedFetch(() => ({ noul: 0.9 }));
  const hold = { during: null };
  const fetch = async (url, init) => {
    const run = hold.during;
    hold.during = null;
    if (run !== null) await run();
    return script.fetch(url, init);
  };
  const engine = await provider.createSidecarEngine({ home, credential: 'test-key-not-a-secret', fetch, env: {}, sourceEgress: APPROVED });
  return { engine, requests: script.requests, hold };
}

async function records(engine) {
  const ids = await engine.journal.list();
  return (await Promise.all(ids.map((id) => engine.lookup(id)))).filter((r) => r !== null);
}

test('DEC-12/US31: a result that arrives after the revision moved is kept as stale, never used; a fresh decision runs once when still useful', async (t) => {
  const revisions = new core.WorkspaceRevisions();
  revisions.observe('w-late', { revision: 'rev-7', wrote: false });
  const { engine, requests, hold } = await lateEngine(t);
  // While the first request is evaluated, the agent writes a file: the revision moves.
  hold.during = () => revisions.observe('w-late', { wrote: true });
  const ctx = { workspaceId: 'w-late', evidenceRevision: revisions.current('w-late'), deadlineMs: 30_000, currentRevision: () => revisions.current('w-late'), stillUseful: () => true };
  const result = await core.detectAmbiguity(engine, { objective: 'Add invoice totals (late)', unknowns: LATE_UNKNOWNS }, ctx);
  assert.equal(requests.length, 2, 'the late result was not used; one fresh decision ran');
  assert.equal(result.outcome, 'ask');
  const all = await records(engine);
  const late = all.find((r) => r.outcome === 'stale');
  assert.deepEqual([late.reasonCodes[0], late.evidenceRevision, late.proposedAction.kind], ['STALE_REVISION', 'rev-7', 'abstain'], 'stored for analysis, cannot actuate');
  const fresh = all.find((r) => r.decisionId === result.decisionId);
  assert.deepEqual([fresh.outcome, fresh.evidenceRevision], ['advisory', 'rev-7.w1'], 'the fresh decision is on the new revision');
});

test('DEC-12/US31: no fresh decision when a newer event superseded the stale one', async (t) => {
  const revisions = new core.WorkspaceRevisions();
  revisions.observe('w-late', { revision: 'rev-7', wrote: false });
  const { engine, requests, hold } = await lateEngine(t);
  // The repository moves to a new revision, and a newer request supersedes this one, while it is evaluated.
  let superseded = false;
  hold.during = () => {
    revisions.observe('w-late', { revision: 'rev-8', wrote: false });
    superseded = true;
  };
  const ctx = { workspaceId: 'w-late', evidenceRevision: revisions.current('w-late'), deadlineMs: 30_000, currentRevision: () => revisions.current('w-late'), stillUseful: () => !superseded };
  const old = await core.detectAmbiguity(engine, { objective: 'Add invoice totals (superseded)', unknowns: LATE_UNKNOWNS }, ctx);
  assert.deepEqual([old.outcome, old.reasonCode], ['proceed', 'STALE_REVISION'], 'the superseded late result is not used');
  assert.equal(requests.length, 1, 'and it was not rescheduled');
  assert.equal((await records(engine)).filter((r) => r.outcome === 'stale').length, 1);
});

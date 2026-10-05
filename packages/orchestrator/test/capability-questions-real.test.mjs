// Regression tests for the questions redesigned after the live run of 2026-10-04 (C29 loop class, C35 document
// coverage, C72 next step). The answers are REAL jev-1.13.0 answers to the redesigned questions for synthetic cases
// (fixtures/capability-questions-real.json: numbers only), replayed through the real engine, the real validators and the
// real consult floors, so what the live API did is what is tested. The old wording, measured the same way on the same
// cases, was wrong or unsure: a failure that came back once after another (maxRepeat 2) was called a repeated failure at
// 0.9, a stalled run with one failure too (0.85), a plain two-failure progress case answered 0.47 to 0.64, a document that
// states the policy asked about scored 2.24 at 0.52, and a project with no approved check was answered declare-checks at
// 0.19 to 0.26. The question text itself is asserted too, so a reword has to be measured again: each definition names
// the facts it is judged on, and every fact it names is in the request.
// A scripted fetch, temporary homes and repositories, no live call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSidecarEngine } from '@jevris/provider-typesafe';
import { LOOP_DEFINITIONS, adviseCapability, approveManifests, assessLoop, manifestHash, openWorkspace, parseManifest, recordSignals, runVerification, signalsFrom } from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

const REAL = JSON.parse(readFileSync(new URL('./fixtures/capability-questions-real.json', import.meta.url), 'utf8'));

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

/** Replays one real answer per request, found by the capability the request names; records every request body. */
function replay(answerOf) {
  const requests = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const real = answerOf(body.state.trustedPolicy.capability);
    const q = body.questions.q;
    const answer = q.type === 'score' ? { type: 'score', score: real.score, probabilities: real.probabilities, legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])), confidence: real.confidence } : { type: 'choice', choice: real.choice, probabilities: real.probabilities, confidence: real.confidence };
    return new Response(JSON.stringify({ model: body.model, answers: { q: answer }, usage: { input_tokens: 700, output_tokens: 100 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, requests };
}

/** `egress`: whether the administrator approved source egress. The text capabilities (C35's query and document) are asked only when it is; C29 and C72 judge counts and flags and are asked either way. */
async function fixture(t, answerOf, files = {}, { egress = false } = {}) {
  const dir = tempDir('jv-qreal-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'README.md'), '# app\n');
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(repo, ...rel.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(repo, ...rel.split('/')), text);
  }
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  const store = testStore(dir);
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
  const script = replay(answerOf);
  const engineHome = mkdtempSync(join(tmpdir(), 'jevris-qreal-engine-'));
  const engine = await createSidecarEngine({ home: engineHome, credential: 'test-key-not-a-secret', fetch: script.fetch, env: {}, sourceEgress: () => ({ provenance: 'administrator', sourceEgress: egress ? 'approved-scoped' : 'deny-until-approved' }) });
  t.after(() => {
    closeTestStore(store);
    rmSync(dir, { recursive: true, force: true });
    rmSync(engineHome, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  return { ws, home, engine, requests: script.requests, advise: (capabilityId, input = {}) => adviseCapability(ws, { capabilityId, input, home, env: { HOME: home }, engine }) };
}

const FAILURE_A = 'AssertionError: expected total to equal 42 in the checkout test';
const FAILURE_B = 'TypeError: cannot read properties of undefined while parsing the cart';
const BUDGETS = { perTask: 6, perFamily: 3, stallMs: 100 };

/** C29: one failed command recorded at atMs 1000, the given fingerprints seen now; returns what Jev was asked and what the assessment said. */
async function loop(t, answerOf, { fingerprints, nowMs, taskId = 'G' }) {
  const f = await fixture(t, answerOf);
  await recordSignals(f.ws, signalsFrom(f.ws.workspaceId, { taskId, atMs: 1000, command: 'npm test', failed: true, output: FAILURE_A, diffHash: null }));
  const out = await assessLoop(f.ws, { taskId, fingerprints, nowMs, budgets: BUDGETS, engine: f.engine });
  return { out, requests: f.requests };
}

test('C29 progress: two different failures, not stalled: the real answer is used and the class is progress', async (t) => {
  const { out, requests } = await loop(t, () => REAL.c29.progress, { fingerprints: [FAILURE_B], nowMs: 1050 });
  assert.equal(requests.length, 1, 'Jev was asked once');
  assert.deepEqual([out.classification, out.source], ['progress', 'jev']);
});

test('C29 flaky: one failure back after another: the real answer is used and the class is flaky-suspected, not a repeated failure', async (t) => {
  const { out, requests } = await loop(t, () => REAL.c29.flaky, { fingerprints: [FAILURE_B, FAILURE_A], nowMs: 1050 });
  assert.equal(requests[0].state.facts.maxRepeat, 2);
  assert.deepEqual([out.classification, out.source], ['flaky-suspected', 'jev']);
});

test('C29 stalled: a long stall with one failure: the real answer is used and the class is no-progress', async (t) => {
  const { out, requests } = await loop(t, () => REAL.c29.stalled, { fingerprints: [], nowMs: 1_000_000 });
  assert.equal(requests[0].state.facts.stalled, true);
  assert.deepEqual([out.classification, out.source], ['no-progress', 'jev']);
});

test('C29: the options are the class definitions, no advice sentence, and each definition names facts that are in the request', async (t) => {
  const { requests } = await loop(t, () => REAL.c29.progress, { fingerprints: [FAILURE_B], nowMs: 1050 });
  const q = requests[0].questions.q;
  assert.deepEqual(Object.keys(q.criteria), ['progress', 'repeated_failure', 'environment_failure', 'flaky_suspected', 'no_progress', 'patch_oscillation']);
  for (const [key, text] of Object.entries(q.criteria)) {
    assert.equal(text, LOOP_DEFINITIONS[key.replace(/_/g, '-')], key);
    assert.doesNotMatch(text, /stronger worker|random changes|Rerun the check|capsule|Restore the last good/, `${key} is a definition, not advice`);
  }
  const facts = requests[0].state.facts;
  const named = new Set(Object.values(q.criteria).flatMap((text) => [...text.matchAll(/\b([a-z]+[A-Z][A-Za-z]*|failures|distinct|stalled|oscillating)\b/g)].map((m) => m[1])));
  for (const name of named) assert.ok(name in facts, `${name} is named by a definition and is not a fact of the request`);
  for (const name of ['stalled', 'commandRepeat', 'oscillating', 'maxRepeat', 'distinct', 'environmentFailures', 'diffStates', 'failures']) assert.ok(name in facts, name);
  assert.deepEqual([typeof facts.stalled, typeof facts.commandRepeat, typeof facts.oscillating], ['boolean', 'number', 'boolean'], 'content-free: a flag, a count, a flag');
});

const POLICY = '# Retry policy\nPayment calls retry with exponential backoff, at most four attempts. A call that still fails is reported to the caller; nothing retries forever.\n';

test('C35: the real answer for a document that states the policy (2.92 at 0.92) is used; one that covers it only partly (0.52) is below the floor and the rules answer', async (t) => {
  const used = await fixture(t, () => REAL.c35.authoritative, { 'docs/retries.md': POLICY }, { egress: true });
  const a = await used.advise('C35', { query: 'payment retries backoff' });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.deepEqual([a.advice.source, a.advice.reasonCode], ['jev', 'JEV_SCORE']);
  const unsure = await fixture(t, () => REAL.c35.partial, { 'docs/retries.md': POLICY }, { egress: true });
  const b = await unsure.advise('C35', { query: 'payment retries backoff' });
  assert.deepEqual([b.advice.source, b.advice.reasonCode], ['rules', 'LEXICAL_SCORE']);
});

test('C35: with egress denied the question about the document is not asked, and the rules answer with no decision', async (t) => {
  const f = await fixture(t, () => REAL.c35.authoritative, { 'docs/retries.md': POLICY });
  const a = await f.advise('C35', { query: 'payment retries backoff' });
  assert.deepEqual([a.advice.source, a.advice.reasonCode, a.advice.decisionId], ['rules', 'LEXICAL_SCORE', null]);
  assert.equal(f.requests.length, 0, 'a request about the document left without egress approval');
});

test('C35: the anchors differ in what the document covers, and the question says which evidence is the task and which is the document', async (t) => {
  const f = await fixture(t, () => REAL.c35.background, { 'docs/retries.md': POLICY }, { egress: true });
  await f.advise('C35', { query: 'payment retries backoff' });
  const q = f.requests[0].questions.q;
  assert.match(q.instructions, /first evidence is the task and the second is a document/);
  assert.equal(q.criteria.length, 4);
  assert.deepEqual(q.criteria.map((c) => /^The document /.test(c)), [true, true, true, true]);
  assert.doesNotMatch(q.criteria.join(' '), /authoritative/i, 'authority is a judgement the document does not show');
});

async function approve(ws, specs) {
  const ms = specs.map((s) => parseManifest(s).manifest);
  await approveManifests(ws, ms, Object.fromEntries(ms.map((m) => [m.id, manifestHash(m)])), 'test');
}

test('C72: no approved check: the real answer (declare-checks at 1.0) is used; unverified device checks: hardware-runner at 1.0 is used', async (t) => {
  const none = await fixture(t, () => REAL.c72.declare);
  const a = await none.advise('C72');
  assert.deepEqual([a.advice.source, a.advice.recommendation], ['jev', 'declare-checks']);
  const device = await fixture(t, () => REAL.c72.hardware);
  await approve(device.ws, [{ id: 'host-build', argv: [process.execPath, '-e', '0'], resultFormat: 'exit-code' }, { id: 'flash-test', argv: [process.execPath, '-e', '0'], resultFormat: 'exit-code', hardware: 'stm32-board' }]);
  await runVerification(device.ws, { taskId: null, checkIds: [] });
  const b = await device.advise('C72');
  assert.deepEqual([b.advice.source, b.advice.recommendation], ['jev', 'hardware-runner']);
});

test('C72: each option names the fact it answers, and the request carries that fact', async (t) => {
  const f = await fixture(t, () => REAL.c72.declare);
  await f.advise('C72');
  const q = f.requests[0].questions.q;
  const facts = f.requests[0].state.facts;
  assert.match(q.criteria['declare-checks'], /approvedChecks is 0/);
  assert.match(q.criteria['host-triage'], /hostFailed is above 0/);
  assert.match(q.criteria['hardware-runner'], /deviceUnverified is above 0/);
  for (const name of ['approvedChecks', 'hostFailed', 'deviceUnverified']) assert.ok(name in facts, name);
  // Fixed text: nothing of the workspace is in an option.
  assert.doesNotMatch(JSON.stringify(q), /ZZMARKER|\/Users\/|stm32/);
});

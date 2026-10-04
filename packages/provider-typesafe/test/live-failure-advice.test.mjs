// Live repeated-failure advice (owner decision 2026-10-01, Jev as an active decision aid; C05 and
// C29 on the hook path). When the same tool failure comes back, one short line says which evidence
// would help most next. The input is the adapter's content-free `failure` features and the trigger
// filter's counts: no error text, path, command or output, so it needs no egress approval. Rules
// first (`adviseFailureLoop`, `maxRepairAttempts`, a fixed priority list); Jev is asked in ONE request
// only when the rules cannot settle it, and every miss falls back to the rules advice with a reason
// code. The hook never waits: a question runs after the hook has answered and the line is shown at the
// next event. Scripted fetch and stub engines, temporary homes, no live call, no real harness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackEngine } from './engine-settle.mjs';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');
const contracts = await import('@jevris/contracts');
const claude = await import('@jevris/adapter-claude-code');
const { createDeadline } = await import('@jevris/platform');

const ops = Object.fromEntries(provider.sidecarOps.map((def) => [def.op, def]));
const sha = (text) => createHash('sha256').update(text).digest('hex');

const APPROVED = () => ({ provenance: 'administrator', sourceEgress: 'approved-scoped' });
const DENIED = () => ({ provenance: 'administrator', sourceEgress: 'deny-until-approved' });

/**
 * A scripted Jev endpoint: `answer(id, question, body)` gives a partial answer (null for none),
 * completed into a valid wire answer. Every request body is recorded. `gate` holds every answer until
 * opened; `hang` never answers at all.
 */
function scriptedFetch(answer, { gate = null, hang = false } = {}) {
  const requests = [];
  let finished = 0;
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (hang) return new Promise(() => {});
    if (gate !== null) await gate;
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      const want = answer(id, q, body);
      if (want === null) continue;
      if (q.type === 'noul') answers[id] = { type: 'noul', noul: want.noul ?? 0.5 };
      else {
        const keys = Object.keys(q.criteria);
        const given = want.probabilities ?? { [want.choice ?? keys[0]]: want.confidence ?? 0.9 };
        const rest = keys.filter((k) => !(k in given));
        const left = 1 - Object.values(given).reduce((a, b) => a + b, 0);
        const probabilities = Object.fromEntries(keys.map((k) => [k, k in given ? given[k] : Math.round((left / rest.length) * 10000) / 10000]));
        const choice = want.choice ?? keys.reduce((a, b) => (probabilities[b] > probabilities[a] ? b : a));
        answers[id] = { type: 'choice', choice, probabilities, confidence: probabilities[choice] };
      }
    }
    finished += 1;
    return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 300, output_tokens: 10 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, requests, finishedCount: () => finished };
}

async function setup(t, answer, options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'jevris-failure-'));
  let tracker = null;
  // A late answer may still be writing its record when the test ends: wait for the engine's own work (not for a fixed time), then remove the home.
  t.after(async () => {
    try {
      await tracker?.settled();
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });
  const script = scriptedFetch(answer, options);
  // Repeated-failure advice sends features only, so it works with source egress DENIED (the default).
  const engine = await provider.createSidecarEngine({ home, credential: 'test-key-not-a-secret', fetch: script.fetch, env: {}, sourceEgress: options.sourceEgress ?? DENIED });
  tracker = trackEngine(engine);
  return { home, engine, script, requests: script.requests };
}

async function until(condition) {
  const stop = performance.now() + 30_000;
  while (!condition() && performance.now() < stop) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(condition(), true, 'the condition held before the generous bound');
}

const F = (over = {}) => ({ toolClass: 'shell', exitClass: 'nonzero', family: 'shell:nonzero', signature: 'aaaaaaaaaaaaaaaa', commandDigest: 'cccccccccccccccc', environmental: false, elapsed: 'lt10s', present: [], ...over });
const OBS = (over = {}) => ({ attempts: 2, sameSignature: true, sameCommand: true, editsSince: 0, gapMs: 1000, unsure: false, previous: null, ...over });
const context = (features = {}, observation = {}, maxRepairAttempts = 2) => provider.failureContextOf(provider.parseFailureFeatures(F(features)), OBS(observation), maxRepairAttempts);
const IDS = { workspaceId: 'w-fail', sessionId: 's-1', taskId: 'task-1' };
const ASK = { assist: 'classify', deadlineMs: 30_000, ids: IDS };
const ALL = ['failing-test-output', 'stack-trace', 'config-file', 'environment-info', 'repro-steps', 'recent-diff', 'logs'];
// C05 offers the candidate artifacts as a0, a1 and so on (each one's fixed option text), so an artifact is found by its text.
const optionKey = (q, artifact) => Object.entries(q.criteria).find(([, text]) => text === provider.FAILURE_ARTIFACT_TEXT[artifact]?.option)?.[0] ?? artifact;
/** Jev finds the evidence so far not enough and names `artifact` next (`none` and `unknown` are answers too). */
const NEXT = (artifact, confidence = 0.9) => (id, q) => {
  if (id === 'nextArtifact') return { choice: optionKey(q, artifact), confidence };
  if (id === 'sufficient') return { noul: 0.2 };
  return { noul: 0.5 };
};

// ------------------------------------------------------------------ features

test('the features parse to a closed shape: unknown keys are dropped and any value outside the closed sets refuses the whole object', () => {
  const parsed = provider.parseFailureFeatures({ ...F({ present: ['logs', 'stack-trace', 'stack-trace'] }), text: 'ENOENT /Users/alice/shop/a.js', path: '/Users/alice/shop', output: 'AssertionError', description: 'the failing test' });
  assert.deepEqual(Object.keys(parsed).sort(), ['commandDigest', 'elapsed', 'environmental', 'exitClass', 'family', 'present', 'signature', 'toolClass']);
  assert.deepEqual(parsed.present, ['stack-trace', 'logs'], 'listed once each, in the fixed vocabulary order');
  for (const leak of ['alice', 'ENOENT', 'AssertionError', 'failing test']) assert.equal(JSON.stringify(parsed).includes(leak), false, `${leak} is dropped`);
  assert.deepEqual(provider.parseFailureFeatures(F({ signature: null, commandDigest: null })).signature, null, 'no signature is allowed');
  const refused = [
    ['free text as an artifact', F({ present: ['please read /etc/passwd'] })],
    ['an unknown artifact id', F({ present: ['secrets'] })],
    ['present is not a list', F({ present: 'logs' })],
    ['a signature that is not a digest', F({ signature: 'ENOENT /Users/alice' })],
    ['a command digest that is not a digest', F({ commandDigest: 'npm test' })],
    ['a family that does not match', F({ family: 'shell:error' })],
    ['an unknown tool class', F({ toolClass: 'bash', family: 'bash:nonzero' })],
    ['an unknown exit class', F({ exitClass: 'exploded', family: 'shell:exploded' })],
    ['an unknown elapsed bucket', F({ elapsed: 'a long while' })],
    ['environmental that is not a boolean', F({ environmental: 'yes' })],
    ['null', null],
    ['a list', []],
    ['a string', 'shell:nonzero'],
    ['a number', 7],
    ['inherited keys only', Object.create(F())],
  ];
  for (const [label, value] of refused) assert.equal(provider.parseFailureFeatures(value), null, label);
});

// ------------------------------------------------------------------ the rules

test('the plan is the rules: environmental failures, one candidate, the repair cap and the unsure case', () => {
  const plan = (features, observation, max) => provider.planFailureAdvice(context(features, observation, max));
  const shape = (p) => [p.step, p.next, p.sure, p.askNext, p.askSame, p.candidates.length];
  assert.deepEqual(shape(plan({}, {}, 2)), ['artifact', 'failing-test-output', false, true, false, 7], 'a plain failure: the rules lean on the test output and Jev may be asked');
  assert.deepEqual(shape(plan({ environmental: true }, {}, 2)), ['artifact', 'environment-info', true, false, false, 7], 'environmental: the rules are sure, no question');
  assert.deepEqual(shape(plan({ environmental: true }, { attempts: 4 }, 10)), ['environment', 'environment-info', true, false, false, 7], 'environmental and past two attempts: the environment line');
  assert.deepEqual(shape(plan({}, { attempts: 4 }, 2)), ['capped', null, true, false, false, 7], 'the same call again with nothing edited and the repair attempts used up: stop and report');
  assert.deepEqual(shape(plan({}, { attempts: 4 }, 0)), ['capped', null, true, false, false, 7], 'a bound of 0 is used up at once');
  assert.deepEqual(shape(plan({}, { attempts: 4, editsSince: 1 }, 2)), ['artifact', 'failing-test-output', false, true, false, 7], 'an edit in between is progress: not capped');
  assert.deepEqual(shape(plan({}, { attempts: 4, sameCommand: false }, 2)), ['artifact', 'failing-test-output', false, true, false, 7], 'a different call is not the same attempt');
  assert.deepEqual(shape(plan({}, { attempts: 6 }, 10)), ['artifact', 'failing-test-output', false, true, false, 7], 'the larger bound from the settings keeps going');
  const one = plan({ present: ALL.filter((id) => id !== 'logs') }, {}, 2);
  assert.deepEqual([one.step, one.next, one.sureCode, one.askNext], ['artifact', 'logs', 'REPEATED_FAILURE_ONE_CANDIDATE', false], 'one artifact left: named by the rules');
  const none = plan({ present: ALL }, {}, 2);
  assert.deepEqual([none.step, none.next, none.sureCode], ['none', null, 'REPEATED_FAILURE_NO_CANDIDATE'], 'every artifact is already shown: nothing to ask for');
  assert.deepEqual(plan({ present: ['failing-test-output', 'stack-trace'] }, {}, 2).candidates, ['recent-diff', 'repro-steps', 'logs', 'config-file', 'environment-info'], 'what the failure already shows is not asked for again');
  assert.equal(plan({ exitClass: 'timeout', family: 'shell:timeout' }, {}, 2).next, 'logs', 'a timeout leans on the logs');
  const unsure = plan({ signature: 'bbbbbbbbbbbbbbbb' }, { unsure: true, sameSignature: false }, 2);
  assert.deepEqual([unsure.askSame, unsure.askNext], [true, true], 'signatures differ but the same call ran again with nothing edited: Jev is asked whether it is the same failure');
  assert.equal(plan({}, {}, 2).askSame, false, 'equal signatures are the same failure: no question');
});

test('the advice line is a fixed template over the vocabulary and never carries text of the failure', () => {
  assert.equal(provider.failureAdviceText('artifact', 3, 'failing-test-output', false), 'Jevris: this failure has come back 3 times; the next most useful evidence is the failing test output.');
  assert.equal(provider.failureAdviceText('artifact', 2, 'stack-trace', true), 'Jevris: this failure has come back 2 times and looks environmental; the next most useful evidence is the full stack trace.');
  assert.match(provider.failureAdviceText('environment', 4, 'environment-info', true), /^Jevris: this failure has come back 4 times and looks environmental; get the environment information/);
  assert.match(provider.failureAdviceText('capped', 4, null, false), /^Jevris: this failure has come back 4 times with nothing changed and the repair attempts are used up; stop and report what was tried\.$/);
  assert.equal(provider.failureAdviceText('none', 3, null, false), null);
  assert.equal(provider.failureAdviceText('artifact', 3, null, false), null);
  for (const id of ALL) {
    const line = provider.failureAdviceText('artifact', 2, id, false);
    assert.match(line, /^Jevris: this failure has come back 2 times; the next most useful evidence is .+\.$/, id);
    assert.ok(line.length < 200, 'one short line');
  }
  assert.deepEqual(Object.keys(provider.FAILURE_ARTIFACT_TEXT).sort(), [...contracts.FAILURE_ARTIFACT_IDS].sort(), 'the wording covers exactly the fixed vocabulary');
});

test('with the rules sure there is no question: no request, an advisory record, and each gate keeps the rules advice with its reason code', async (t) => {
  const { engine, requests } = await setup(t, () => ({}));
  const sure = await provider.adviseRepeatedFailure(engine, context({ environmental: true }), ASK);
  assert.deepEqual([sure.source, sure.reasonCode, sure.asked, sure.step, sure.next], ['rules', 'REPEATED_FAILURE_RULES_SURE', false, 'artifact', 'environment-info']);
  assert.match(sure.text, /looks environmental; the next most useful evidence is the environment information/);
  assert.equal(requests.length, 0, 'a deterministic fact needs no model');
  const record = await engine.lookup(sure.decisionId);
  assert.deepEqual([record.specId, record.outcome], ['repeated-failure', 'advisory']);
  assert.ok(record.reasonCodes.includes('FAIL_SOURCE_RULES') && record.reasonCodes.includes('REPEATED_FAILURE_RULES_SURE') && record.reasonCodes.includes('FAIL_ENV'));

  const rulesText = provider.failureAdviceText('artifact', 2, 'failing-test-output', false);
  const gates = [
    ['kill switch', { killSwitchStopped: true }, engine, 'REPEATED_FAILURE_KILL_SWITCH'],
    ['mode off', { mode: 'off' }, engine, 'REPEATED_FAILURE_MODE_OFF'],
    ['jev.assist off', { assist: 'off' }, engine, 'REPEATED_FAILURE_ASSIST_OFF'],
    ['no engine', {}, null, 'REPEATED_FAILURE_NO_PROVIDER'],
    ['no provider configured', {}, { providerConfigured: false, decide: async () => null, lookup: async () => null }, 'REPEATED_FAILURE_NO_PROVIDER'],
    ['too little time for a call to finish', { deadlineMs: 100 }, engine, 'REPEATED_FAILURE_NO_TIME'],
  ];
  for (const [label, extra, who, code] of gates) {
    const advice = await provider.adviseRepeatedFailure(who, context(), { ...ASK, ...extra });
    assert.deepEqual([advice.source, advice.reasonCode, advice.asked, advice.text], ['rules', code, false, rulesText], label);
  }
  assert.equal(requests.length, 0, 'no gate lets a request out');
  const off = await provider.adviseRepeatedFailure(engine, context(), { ...ASK, mode: 'off' });
  assert.equal(off.decisionId, null, 'below observe nothing is recorded');
  const stopped = await provider.adviseRepeatedFailure(engine, context(), { ...ASK, killSwitchStopped: true });
  assert.equal(stopped.decisionId, null, 'a stopped kill switch records nothing');
  const gated = await provider.adviseRepeatedFailure(engine, context(), { ...ASK, assist: 'off' });
  assert.equal(typeof gated.decisionId, 'string', 'jev.assist off still records the rules advice');
});

// ------------------------------------------------------------------ Jev

test('Jev picks the next artifact: one request, fixed questions, an advisory record, then a cache hit with no second call', async (t) => {
  const { engine, requests } = await setup(t, NEXT('stack-trace'));
  const first = await provider.adviseRepeatedFailure(engine, context(), ASK);
  assert.deepEqual([first.source, first.reasonCode, first.asked, first.askedCount, first.usedCount, first.cacheHit, first.next], ['jev', 'REPEATED_FAILURE_JEV', true, 1, 1, false, 'stack-trace']);
  assert.equal(first.text, 'Jevris: this failure has come back 2 times; the next most useful evidence is the full stack trace.');
  assert.equal(requests.length, 1, 'one request');
  const questions = requests[0].questions;
  assert.deepEqual(Object.keys(questions), ['sufficient', 'nextArtifact'], 'equal signatures are the same failure: no same-failure Noul; C05 asks whether the evidence suffices and which artifact next');
  assert.equal(questions.nextArtifact.type, 'choice');
  const candidates = provider.planFailureAdvice(context()).candidates;
  assert.deepEqual(Object.keys(questions.nextArtifact.criteria), [...candidates.map((_, i) => `a${i}`), 'none', 'unknown'], 'the candidates in the rules order, then none and unknown');
  candidates.forEach((id, i) => assert.equal(questions.nextArtifact.criteria[`a${i}`], provider.FAILURE_ARTIFACT_TEXT[id].option, 'the option text is the fixed template'));
  assert.ok(Object.keys(questions).length <= contracts.MAX_QUESTIONS);
  const record = await engine.lookup(first.decisionId);
  assert.deepEqual([record.specId, record.outcome, record.taskId, record.sessionId], ['repeated-failure', 'advisory', 'task-1', 's-1']);
  for (const code of ['FAIL_FAMILY_SHELL_NONZERO', 'FAIL_ATTEMPTS_2', 'FAIL_SOURCE_JEV', 'FAIL_STEP_ARTIFACT', 'FAIL_NEXT_STACK_TRACE', 'FAIL_RULES_FAILING_TEST_OUTPUT', 'FAIL_ASKED_1', 'FAIL_USED_1', 'JEV_CACHE_MISS', 'REPEATED_FAILURE_JEV']) assert.ok(record.reasonCodes.includes(code), code);
  assert.deepEqual(record.proposedAction.evidenceIds, ['feature-family', 'feature-attempts', 'feature-environmental', 'feature-elapsed'], 'the evidence ids are feature names');
  assert.equal(typeof record.durationMs, 'number', 'the latency is recorded');
  const again = await provider.adviseRepeatedFailure(engine, context(), ASK);
  assert.deepEqual([again.source, again.cacheHit, again.next], ['jev', true, 'stack-trace']);
  assert.equal(requests.length, 1, 'the same features are answered from the decision cache with no second call');
  assert.notEqual(again.decisionId, first.decisionId, 'each advised failure is its own record');
  // Another count bucket is another question, so it is not served from the cache.
  const fourth = await provider.adviseRepeatedFailure(engine, context({}, { attempts: 6 }, 10), ASK);
  assert.equal(fourth.cacheHit, false);
  assert.equal(requests.length, 2);
  assert.match(fourth.text, /come back 6 times/);
});

test('the Choice names an artifact the failure does not already show: the options are the candidates only', async (t) => {
  const { engine, requests } = await setup(t, NEXT('logs'));
  const advice = await provider.adviseRepeatedFailure(engine, context({ present: ['failing-test-output', 'stack-trace'] }), ASK);
  assert.deepEqual(Object.values(requests[0].questions.nextArtifact.criteria).slice(0, 5), ['recent-diff', 'repro-steps', 'logs', 'config-file', 'environment-info'].map((id) => provider.FAILURE_ARTIFACT_TEXT[id].option));
  assert.deepEqual(Object.keys(requests[0].questions.nextArtifact.criteria), ['a0', 'a1', 'a2', 'a3', 'a4', 'none', 'unknown']);
  assert.equal(advice.next, 'logs');
  assert.deepEqual((await engine.lookup(advice.decisionId)).proposedAction.evidenceIds, ['feature-family', 'feature-attempts', 'feature-environmental', 'feature-elapsed', 'feature-artifacts']);
  assert.equal(requests[0].state.facts.present, 'failing-test-output,stack-trace');
});

test('the same-failure Noul is asked only when the signatures differ but the same call ran again with nothing edited', async (t) => {
  const unsure = { signature: 'bbbbbbbbbbbbbbbb' };
  const observation = { sameSignature: false, unsure: true, previous: { exitClass: 'nonzero', environmental: false, elapsed: 'lt10s', present: [] } };
  let script = (id, q) => (id === 'same' ? { noul: 0.92 } : NEXT('recent-diff', 0.85)(id, q));
  const { engine, requests } = await setup(t, (id, q, body) => script(id, q, body));
  const yes = await provider.adviseRepeatedFailure(engine, context(unsure, observation), ASK);
  assert.equal(requests.length, 2, 'two decisions, side by side: the same-failure Noul and C05');
  const sameRequest = requests.find((r) => 'same' in r.questions);
  assert.deepEqual(Object.keys(sameRequest.questions), ['same']);
  assert.equal(sameRequest.questions.same.type, 'noul');
  assert.deepEqual(Object.keys(requests.find((r) => 'nextArtifact' in r.questions).questions), ['sufficient', 'nextArtifact']);
  assert.deepEqual([yes.source, yes.reasonCode, yes.askedCount, yes.usedCount, yes.sameByJev, yes.next], ['jev', 'REPEATED_FAILURE_JEV', 2, 2, true, 'recent-diff']);
  assert.ok((await engine.lookup(yes.decisionId)).reasonCodes.includes('FAIL_SAME_JEV'));
  // Jev says it is a different failure: nothing to say, and the question is still on the record.
  script = (id, q) => (id === 'same' ? { noul: 0.05 } : NEXT('logs')(id, q));
  // Each case is its own question (its own count bucket), so the decision cache never serves an earlier answer.
  const no = await provider.adviseRepeatedFailure(engine, context({ signature: 'dddddddddddddddd' }, { ...observation, attempts: 4 }, 10), ASK);
  assert.deepEqual([no.text, no.reasonCode, no.source, no.asked], [null, 'REPEATED_FAILURE_NOT_SAME', 'jev', true]);
  assert.equal(typeof no.decisionId, 'string', 'the miss is recorded');
  // An unsure Noul (below 0.6 either way) is not used; the Choice still is.
  script = (id, q) => (id === 'same' ? { noul: 0.55 } : NEXT('config-file', 0.9)(id, q));
  const unclear = await provider.adviseRepeatedFailure(engine, context({ signature: 'eeeeeeeeeeeeeeee' }, { ...observation, attempts: 6 }, 10), ASK);
  assert.deepEqual([unclear.reasonCode, unclear.usedCount, unclear.sameByJev, unclear.next], ['REPEATED_FAILURE_JEV_PARTIAL', 1, false, 'config-file']);
  const sameSignature = await provider.adviseRepeatedFailure(engine, context({ signature: 'ffffffffffffffff' }), ASK);
  assert.equal(requests.at(-1).questions.same, undefined, 'equal signatures are the same failure by rule: no Noul');
  assert.ok(sameSignature.asked);
});

test('only features leave: no error text, path, command, output or digest in any request, whatever the body carried', async (t) => {
  // A realistic failure from the Claude Code adapter: the error text, path and command stay in the adapter.
  const error = 'Exit code 1\n  1) checkout totals\n     AssertionError: expected 41 to equal 42\n      at Context.<anonymous> (/Users/alice/work/shop/test/cart.test.js:10:5)\n      at process.processImmediate (node:internal/timers:483:21)';
  const normalized = claude.normalize({ session_id: 's1', cwd: '/Users/alice/work/shop', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'npm test -- --grep checkout' }, error, duration_ms: 4200 }, {});
  assert.equal(normalized.ok, true);
  const failure = normalized.intent.failure;
  const { engine, requests } = await setup(t, NEXT('recent-diff'));
  // Junk keys a hook could add to the body's failure object are dropped by the parser.
  const parsed = provider.parseFailureFeatures({ ...failure, text: error, path: '/Users/alice/work/shop/test/cart.test.js', command: 'npm test -- --grep checkout', description: 'the failing checkout test' });
  assert.notEqual(parsed, null);
  const advice = await provider.adviseRepeatedFailure(engine, provider.failureContextOf(parsed, OBS({ previous: { exitClass: 'nonzero', environmental: false, elapsed: 'lt10s', present: ['failing-test-output'] } }), 2), ASK);
  assert.equal(requests.length, 1);
  const wire = JSON.stringify(requests);
  for (const leak of ['alice', 'cart.test', 'AssertionError', 'checkout', 'npm test', 'grep', 'processImmediate', 'timers', 'task-1', 's-1', failure.signature, failure.commandDigest]) assert.equal(wire.includes(leak), false, `${leak} must not leave`);
  assert.deepEqual([requests[0].state.untrustedEvidence, requests[0].state.withheldEvidence], [[], []], 'no evidence span at all');
  const facts = requests[0].state.facts;
  assert.deepEqual(Object.keys(facts).sort(), ['attempts', 'editsSince', 'elapsed', 'environmental', 'family', 'have', 'maxRepairAttempts', 'obtainable', 'present', 'previousElapsed', 'previousEnvironmental', 'previousPresent', 'required', 'sameCommand']);
  assert.deepEqual([facts.family, facts.attempts, facts.environmental, facts.elapsed, facts.present], ['shell:nonzero', '2', false, 'lt10s', 'failing-test-output,stack-trace']);
  assert.equal(advice.source, 'jev');
  assert.equal(advice.text.includes('alice'), false);
  for (const text of [advice.text, JSON.stringify(await engine.lookup(advice.decisionId))]) for (const leak of ['alice', 'cart.test', 'AssertionError', 'checkout', failure.signature, failure.commandDigest]) assert.equal(text.includes(leak), false, `${leak} is not in the advice or the record`);
});

test('works with source egress approved too, and the request is the same features either way', async (t) => {
  const denied = await setup(t, NEXT('logs'), { sourceEgress: DENIED });
  const approved = await setup(t, NEXT('logs'), { sourceEgress: APPROVED });
  await provider.adviseRepeatedFailure(denied.engine, context(), ASK);
  await provider.adviseRepeatedFailure(approved.engine, context(), ASK);
  assert.deepEqual(denied.requests[0].state, approved.requests[0].state);
});

// ------------------------------------------------------------------ every miss keeps the rules

test('a Jev answer that is not sure, not usable, or names nothing listed keeps the rules advice, with the reason', async (t) => {
  let script = NEXT('stack-trace', 0.4);
  const { engine } = await setup(t, (id, q, body) => script(id, q, body));
  const rules = provider.failureAdviceText('artifact', 2, 'failing-test-output', false);
  // Each case is its own question (its own count), so an earlier answer in the cache never serves it.
  const ask = (attempts) => provider.adviseRepeatedFailure(engine, context({}, { attempts }, 10), ASK);
  const low = await ask(2);
  assert.deepEqual([low.source, low.reasonCode, low.asked, low.usedCount, low.text], ['rules', 'REPEATED_FAILURE_JEV_LOW_CONFIDENCE', true, 0, rules], 'below 0.6 confidence');
  script = () => null;
  const silent = await provider.adviseRepeatedFailure(engine, context({ present: ['config-file'] }, {}, 10), ASK);
  assert.deepEqual([silent.source, silent.reasonCode, silent.text], ['rules', 'REPEATED_FAILURE_JEV_INVALID_RESPONSE', rules], 'a response with no answer in it is refused by the engine');
  // An answer set that passes through with nothing usable in it (a stub engine) is no answer.
  const empty = { decide: async () => ({ abstained: false, decisionId: 'd-00000000-0000-4000-8000-000000000002', result: { answers: {} }, automation: true, rulesOnly: false }), lookup: async () => null };
  const noAnswer = await provider.adviseRepeatedFailure(empty, context(), ASK);
  assert.deepEqual([noAnswer.source, noAnswer.reasonCode, noAnswer.usedCount, noAnswer.text], ['rules', 'REPEATED_FAILURE_JEV_NO_ANSWER', 0, rules]);
  script = NEXT('unknown', 0.95);
  const unknown = await provider.adviseRepeatedFailure(engine, context({ present: ['logs'] }, {}, 10), ASK);
  assert.deepEqual([unknown.source, unknown.reasonCode, unknown.next], ['rules', 'REPEATED_FAILURE_JEV_UNUSABLE', 'failing-test-output'], 'a sure answer that names no listed artifact is unusable, not low confidence');
  script = NEXT('none', 0.95);
  const none = await provider.adviseRepeatedFailure(engine, context({ present: ['repro-steps'] }, {}, 10), ASK);
  assert.deepEqual([none.text, none.step, none.source, none.asked], [null, 'none', 'jev', true], 'Jev says no listed evidence would help: nothing is shown');
  assert.equal(typeof none.decisionId, 'string');
});

test('a Jev error, an open circuit, an exhausted budget and a late answer keep the rules advice with the reason in the code', async () => {
  const rules = provider.failureAdviceText('artifact', 2, 'failing-test-output', false);
  const stub = (reasonCode) => ({ decide: async () => ({ abstained: true, reasonCode, decisionId: 'd-00000000-0000-4000-8000-000000000001', fallback: 'rules-only' }), lookup: async () => null });
  // Refused on this machine before anything is sent: Jev was not asked. A deadline is a request that went out.
  for (const [reason, expected, asked] of [['CIRCUIT_OPEN', 'REPEATED_FAILURE_JEV_CIRCUIT_OPEN', false], ['BUDGET', 'REPEATED_FAILURE_JEV_BUDGET', false], ['BUDGET_MACHINE_LIMIT', 'REPEATED_FAILURE_JEV_BUDGET_MACHINE_LIMIT', false], ['DEADLINE', 'REPEATED_FAILURE_JEV_DEADLINE', true], ['EGRESS_NOT_APPROVED', 'REPEATED_FAILURE_JEV_EGRESS_NOT_APPROVED', false]]) {
    const advice = await provider.adviseRepeatedFailure(stub(reason), context(), ASK);
    assert.deepEqual([advice.source, advice.reasonCode, advice.text, advice.asked, advice.askedCount], ['rules', expected, rules, asked, asked ? advice.askedCount : 0], reason);
    if (asked) assert.ok(advice.askedCount > 0);
  }
  const throwing = { decide: async () => { throw new Error('boom'); }, lookup: async () => null };
  const failed = await provider.adviseRepeatedFailure(throwing, context(), ASK);
  assert.deepEqual([failed.source, failed.reasonCode, failed.text], ['rules', 'REPEATED_FAILURE_ERROR', rules]);
  assert.equal(failed.decisionId, null, 'an engine that cannot record still advises');
});

test('a slow Jev is abandoned at the deadline and the rules advice answers; the late answer only warms the cache', async (t) => {
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  // Opened first on the way out (hooks run in the order they were registered), so a test that failed with the gate shut does not wait for the call's own deadline.
  t.after(() => open());
  const { engine, requests, script } = await setup(t, NEXT('logs'), { gate });
  const rules = provider.failureAdviceText('artifact', 2, 'failing-test-output', false);
  const late = await provider.adviseRepeatedFailure(engine, context(), { ...ASK, deadlineMs: 150, lateGraceMs: 60_000 });
  assert.deepEqual([late.source, late.reasonCode, late.text, late.asked], ['rules', 'REPEATED_FAILURE_DEADLINE', rules, true], 'the caller did not wait for Jev');
  // The engine does several durable journal writes before it sends: on a slow disk the request goes out after the 150 ms. Wait for the request, not for a fixed time.
  await until(() => requests.length === 1);
  assert.equal(script.finishedCount(), 0, 'Jev has not answered yet');
  open();
  await until(() => script.finishedCount() === 1);
  // The engine puts the late answer in the decision cache just after the response: wait for the entry, not for a fixed time.
  await until(() => engine.cache.stats().entries === 1);
  const warm = await provider.adviseRepeatedFailure(engine, context(), { ...ASK, record: false });
  assert.deepEqual([warm.source, warm.cacheHit, warm.next], ['jev', true, 'logs']);
  assert.equal(requests.length, 1, 'and cost no second call');
});

// ------------------------------------------------------------------ C29, the loop assessment

test('C29 loop consult: the family codes and vocabulary ids need no egress; the failure text is withheld while egress is denied and goes, screened, once it is approved', async (t) => {
  const orchestrator = await import('@jevris/orchestrator');
  const consult = (engine) =>
    orchestrator.consultChoice(engine, {
      capabilityId: 'C29',
      specVersion: '1',
      objective: 'Classify whether the agent is making progress or looping.',
      instructions: 'Classify the recent failure pattern of a coding agent. Choose the single best description.',
      options: { progress: 'The agent is making progress.', repeated_failure: 'The same failure keeps coming back.' },
      evidence: [{ id: 'sig-0', text: 'test: TypeError at app/parse.ts:14', sourceKind: 'tool', priority: 'high' }],
      facts: { failures: 2, distinct: 1, families: 'test=2', artifacts: 'logs,stack-trace' },
      workspaceId: 'w-c29',
      evidenceRevision: 'loop-2',
      taskId: 'task-c29',
      // The default deadline is 5 s; a real engine on a loaded runner needs far less than this long bound and the deadline is not what is under test.
      deadlineMs: 30_000,
      rules: () => ({ choice: 'progress', reasonCode: 'RULES' }),
    });
  const denied = await setup(t, () => ({}));
  const refused = await consult(denied.engine);
  assert.equal(refused.source, 'jev', 'a question of codes alone is asked with egress denied');
  assert.equal(denied.requests.length, 1);
  const deniedWire = JSON.stringify(denied.requests[0]);
  for (const leak of ['TypeError', 'app/parse.ts']) assert.equal(deniedWire.includes(leak), false, `${leak} stays here while egress is denied`);
  assert.equal(denied.requests[0].state.facts.families, 'test=2', 'the closed family codes are sent');
  assert.equal(denied.requests[0].state.facts.artifacts, 'logs,stack-trace', 'and the vocabulary ids');
  const approved = await setup(t, () => ({}), { sourceEgress: APPROVED });
  await consult(approved.engine);
  assert.equal(JSON.stringify(approved.requests[0]).includes('TypeError at app/parse.ts:14'), true, 'with egress approved the failure text goes, as it did before');
});

// ------------------------------------------------------------------ explain

test('jevris explain renders the advisory decision: what failed, who advised, what was asked, the evidence, and that it decides nothing', async (t) => {
  const { home, engine } = await setup(t, NEXT('stack-trace'));
  const advice = await provider.adviseRepeatedFailure(engine, context(), ASK);
  const text = core.explainDecision(await engine.lookup(advice.decisionId));
  assert.match(text, /Repeated failure: a shell command failed with a non-zero exit 2 times in this session; the advice is from Jev and decides nothing\./);
  assert.match(text, /Advice: name the one kind of evidence to obtain next: stack trace \(the rules would have said failing test output\)\./);
  assert.match(text, /Jev was asked 1 question and 1 answer cleared the confidence bar \(asked Jev, \d+ ms\)\./);
  assert.match(text, /Reason: REPEATED_FAILURE_JEV\./);
  assert.match(text, /Evidence: feature-family, feature-attempts, feature-environmental, feature-elapsed \(structured features only; no error text, paths, command text or tool output\)\./);
  assert.match(text, /changes no permission, runs nothing and marks nothing done/);
  // The engine's own record of the Jev call (same spec id, also advisory) is not the adviser's, so it gets no adviser's lines.
  assert.equal(typeof advice.jevDecisionId, 'string');
  const callText = core.explainDecision(await engine.lookup(advice.jevDecisionId));
  assert.doesNotMatch(callText, /Repeated failure:|Advice: name the one kind/, 'the Jev call record is explained as a provider call');
  const again = await provider.adviseRepeatedFailure(engine, context(), ASK);
  assert.match(core.explainDecision(await engine.lookup(again.decisionId)), /\(cache hit, \d+ ms\)/);
  assert.doesNotMatch(core.explainDecision(await engine.lookup(again.jevDecisionId)), /Repeated failure:/, 'and so is the cache hit\'s own record');
  const rules = await provider.adviseRepeatedFailure(engine, context({ environmental: true }), ASK);
  const rulesText = core.explainDecision(await engine.lookup(rules.decisionId));
  assert.match(rulesText, /the advice is from rules and decides nothing/);
  assert.match(rulesText, /looks environmental/);
  assert.match(rulesText, /Jev was not asked/);
  const capped = await provider.adviseRepeatedFailure(engine, context({}, { attempts: 4 }), ASK);
  assert.match(core.explainDecision(await engine.lookup(capped.decisionId)), /say the repair attempts are used up, so stop and report what was tried/);
  const request = { op: 'explain', client: 'cli', scopes: ['status', 'advice'], workspace: { id: IDS.workspaceId, root: null }, body: { decisionId: advice.decisionId }, home, signal: new AbortController().signal, deadline: createDeadline(2000), store: undefined, killSwitchStopped: false, engine, trace() {}, mode: 'advise' };
  const out = await ops.explain.handle(request);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(contracts.surfacePayloadContract('explain').validate(out.body).ok, true, JSON.stringify(out.body));
  assert.match(JSON.stringify(out.body), /Repeated failure: a shell command failed/);
});

// ------------------------------------------------------------------ the hook path

let n = 0;
function harnessEvent(kind, { toolName = null, session = 'sess-1' } = {}) {
  n += 1;
  return { schemaVersion: '1.0', harness: 'claude', nativeEventName: 'Hook', kind, sessionId: session, turnId: null, toolUseId: `tu-${n}`, toolName, agentId: null, model: null, permissionMode: null, cwd: null, trigger: null, blocking: true, responseRequired: false, payload: {}, dedupKey: sha(`failure-event-${n}`) };
}

function hookCtx(kind, { toolName = kind === 'tool.finished' ? 'Edit' : 'Bash', session, failure, engine, mode = 'bounded-auto', jevAssist = 'classify', repair = { maxAttempts: 2 }, showsExplain, killSwitchStopped = false, signal, revision = 'rev-1', remainingMs = 500 } = {}) {
  const body = { envelope: harnessEvent(kind, { toolName, session }), deliveryKey: `k-${n}`, revision, taskId: 'task-1' };
  if (failure !== undefined) body.failure = failure;
  if (repair !== null) body.repair = repair;
  if (showsExplain !== undefined) body.showsExplain = showsExplain;
  return { op: 'event', client: 'hook', scopes: ['observe'], workspace: { id: 'w-hook', root: '/nowhere' }, body, home: '/nonexistent-home', signal: signal ?? new AbortController().signal, deadline: { remainingMs: () => remainingMs, expired: () => false }, store: null, killSwitchStopped, engine, mode, jevAssist, trace: () => {} };
}

function liveSubscriber(t, { engine, deadlineMs = 30_000, lateGraceMs, now, recordWaitMaxMs } = {}) {
  const store = new provider.PendingAdviceStore(now === undefined ? {} : { now });
  const background = [];
  const traces = [];
  const handler = provider.createRepeatedFailureHandler({ store, background: (work) => background.push(work), deadlineMs, ...(lateGraceMs === undefined ? {} : { lateGraceMs }), ...(recordWaitMaxMs === undefined ? {} : { recordWaitMaxMs }) });
  const subscriber = provider.createDecisionSubscriber({ handlers: { 'repeated-failure': [handler] }, certifications: provider.recordsCertificationSource(async () => []), now: () => Date.parse('2026-10-03T10:00:00Z'), operatingSystem: 'linux', pending: store });
  const send = (ctx) => subscriber.handle({ ...ctx, trace: (entry) => traces.push(entry) });
  return { subscriber, send, store, background, traces, engine };
}

test('the count escalates across a session: the same failure at attempt 2 names evidence at the next event, at attempt 4 the cap says stop; two different failures are not merged', async (t) => {
  const { engine, requests } = await setup(t, NEXT('failing-test-output'));
  // The hook waits at most 250 ms for the advisory record and then answers without its decision id (the product is right to stop
  // waiting; live-handler-record-deadline.test.mjs proves that bound). This test reads the record, so it gives the wait a long bound and
  // the hook plenty of time: a slow disk then cannot turn the record into what the test races.
  const live = liveSubscriber(t, { engine, recordWaitMaxMs: 120_000 });
  const a = F();
  const fail = (failure, options = {}) => live.send(hookCtx('tool.failed', { failure, engine, remainingMs: 300_000, ...options }));
  // Attempt 1: a new family, no handler registered for it. Attempt 2: the same failure again.
  assert.equal((await fail(a)).hookOutcome.kind, 'observe');
  const second = await fail(a);
  assert.equal(second.trigger, 'repeated-failure');
  assert.equal(second.hookOutcome.kind, 'observe', 'the hook answers at once: Jev is being asked, the line waits for the next event');
  await Promise.all(live.background);
  assert.equal(requests.length, 1);
  assert.equal(live.store.count('w-hook', 'sess-1'), 1, 'the finished line is queued for the session');
  // The next event of the session hands it over (attempt 3 is not a trigger by itself).
  const third = await fail(a);
  assert.deepEqual([third.hookOutcome.kind, third.reasonCode], ['explain', 'PENDING_ADVICE_DELIVERED']);
  assert.equal(third.hookOutcome.text, 'Jevris: this failure has come back 2 times; the next most useful evidence is the failing test output.');
  assert.equal(live.store.count('w-hook', 'sess-1'), 0, 'delivered once');
  // Attempt 4 with nothing edited and the repair bound of 2 used up: the rules settle it, no request, the line comes back with the answer.
  const fourth = await fail(a);
  assert.equal(fourth.trigger, 'repeated-failure');
  assert.equal(fourth.hookOutcome.kind, 'explain');
  assert.match(fourth.hookOutcome.text, /^Jevris: this failure has come back 4 times with nothing changed and the repair attempts are used up; stop and report what was tried\.$/);
  assert.equal(requests.length, 1, 'no second request for a deterministic cap');
  assert.equal(fourth.decisionIds.length, 1, 'the advisory decision is named in the answer');
  const record = await engine.lookup(fourth.decisionIds[0]);
  assert.deepEqual([record.specId, record.outcome], ['repeated-failure', 'advisory']);
  assert.ok(record.reasonCodes.includes('FAIL_STEP_CAPPED') && record.reasonCodes.includes('FAIL_ATTEMPTS_4'));
  // A different failure of the same family starts its own count: not 5, not merged with the first.
  const b = F({ signature: 'bbbbbbbbbbbbbbbb', commandDigest: 'dddddddddddddddd' });
  assert.equal((await fail(b)).trigger, null, 'a different failure is progress, not a repeat');
  const bSecond = await fail(b);
  assert.equal(bSecond.trigger, 'repeated-failure');
  await Promise.all(live.background);
  const bShown = await fail(b);
  assert.match(bShown.hookOutcome.text, /^Jevris: this failure has come back 2 times; the next most useful evidence is the failing test output\.$/, 'the second failure counts from its own first');
  assert.equal(requests.length, 1, 'the same shape of failure at the same count is the same question: answered from the decision cache');
  assert.equal((await engine.lookup(live.traces.at(-1).decisionId ?? live.traces.findLast((x) => x.decisionId !== undefined).decisionId)).reasonCodes.includes('JEV_CACHE_HIT'), true);
});

test('the hook answers at once whether or not the provider ever answers: the question is detached and the line falls back to the rules at the deadline', async (t) => {
  // The provider answers nothing until the test ends: a held answer, opened first on the way out (hooks run in the order they were registered). The engine's own call gets a generous grace, so a slow disk cannot cut it off before it sends; the line's wait is the 1 s deadline under test.
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  t.after(() => open());
  const { engine, requests } = await setup(t, () => ({}), { gate });
  const live = liveSubscriber(t, { engine, deadlineMs: 1_000, lateGraceMs: 60_000 });
  const fail = () => live.send(hookCtx('tool.failed', { failure: F(), engine }));
  await fail();
  const answered = await fail();
  assert.equal(answered.hookOutcome.kind, 'observe', 'the hook was answered before the provider did anything');
  assert.equal(live.background.length, 1, 'the question runs detached');
  assert.equal(live.store.count('w-hook', 'sess-1'), 0, 'and nothing is queued yet');
  await Promise.all(live.background);
  await until(() => requests.length === 1);
  assert.equal(requests.length, 1, 'the one request was made and never answered');
  assert.equal(live.traces.findLast((x) => x.event === 'repeated-failure-advice').reasonCode, 'REPEATED_FAILURE_DEADLINE');
  const waiting = live.store.peek('w-hook', 'sess-1');
  assert.equal(waiting.text, 'Jevris: this failure has come back 2 times; the next most useful evidence is the failing test output.', 'the rules advice stands');
  assert.equal(waiting.reasonCode, 'REPEATED_FAILURE_DEADLINE');
});

test('each gate on the hook path is the rules line at once, no detached run and no request', async (t) => {
  const { engine, requests } = await setup(t, NEXT('logs'));
  const rules = 'Jevris: this failure has come back 2 times; the next most useful evidence is the failing test output.';
  const cases = [
    ['jev.assist off', { jevAssist: 'off' }, 'REPEATED_FAILURE_ASSIST_OFF'],
    ['no provider', { engine: undefined }, 'REPEATED_FAILURE_NO_PROVIDER'],
  ];
  for (const [label, extra, code] of cases) {
    const live = liveSubscriber(t, { engine });
    const fail = () => live.send(hookCtx('tool.failed', { failure: F(), engine, ...extra }));
    await fail();
    const answered = await fail();
    assert.deepEqual([answered.hookOutcome, answered.reasonCode], [{ kind: 'explain', text: rules }, code], label);
    assert.equal(live.background.length, 0, `${label}: nothing runs after the hook`);
  }
  assert.equal(requests.length, 0);
  // A stopped kill switch and mode off never reach the handler at all.
  const stopped = await liveSubscriber(t, { engine }).send(hookCtx('tool.failed', { failure: F(), engine, killSwitchStopped: true }));
  assert.deepEqual([stopped.hookOutcome.kind, stopped.reasonCode], ['observe', 'KILL_SWITCH']);
  const off = await liveSubscriber(t, { engine }).send(hookCtx('tool.failed', { failure: F(), engine, mode: 'off' }));
  assert.deepEqual([off.hookOutcome.kind, off.reasonCode], ['observe', 'MODE_OFF']);
  assert.equal(requests.length, 0);
});

test('a kill switch stopped after the hook answered stops the detached question before any request', async (t) => {
  const { engine, requests } = await setup(t, NEXT('logs'));
  const live = liveSubscriber(t, { engine });
  let stopped = false;
  const send = (extra = {}) => live.send({ ...hookCtx('tool.failed', { failure: F(), engine }), killSwitchNow: async () => stopped, ...extra });
  await send();
  stopped = true;
  const answered = await send();
  assert.equal(answered.hookOutcome.kind, 'observe');
  await Promise.all(live.background);
  assert.equal(requests.length, 0, 'the detached run re-read the kill switch and stopped');
  assert.equal(live.store.count('w-hook', 'sess-1'), 0);
  assert.equal(live.traces.findLast((x) => x.event === 'repeated-failure-advice').reasonCode, 'REPEATED_FAILURE_KILL_SWITCH');
});

test('observe mode records the counterfactual and shows nothing; advise mode shows the line at the next event', async (t) => {
  const { engine, requests } = await setup(t, NEXT('logs'));
  const observe = liveSubscriber(t, { engine });
  const fail = (live, mode) => live.send(hookCtx('tool.failed', { failure: F(), engine, mode }));
  await fail(observe, 'observe');
  const answered = await fail(observe, 'observe');
  assert.deepEqual([answered.hookOutcome.kind, answered.reasonCode], ['observe', 'MODE_DOES_NOT_ADVISE']);
  await Promise.all(observe.background);
  assert.equal(requests.length, 1, 'the question was asked and recorded');
  assert.equal(observe.store.count('w-hook', 'sess-1'), 0, 'but nothing is queued to be shown');
  const shown = liveSubscriber(t, { engine });
  await fail(shown, 'advise');
  await fail(shown, 'advise');
  await Promise.all(shown.background);
  assert.equal(shown.store.count('w-hook', 'sess-1'), 1);
});

test('on an event where the harness shows nothing the rules line waits for the next one that can, instead of being lost', async (t) => {
  const { engine, requests } = await setup(t, NEXT('logs'));
  const live = liveSubscriber(t, { engine });
  const fail = (extra = {}) => live.send(hookCtx('tool.failed', { failure: F({ environmental: true }), engine, ...extra }));
  await fail({ showsExplain: false });
  const second = await fail({ showsExplain: false });
  assert.deepEqual([second.trigger, second.hookOutcome.kind], ['repeated-failure', 'observe'], 'nothing is returned where it cannot be shown');
  assert.equal(live.store.count('w-hook', 'sess-1'), 1, 'the line is queued');
  assert.equal(live.background.length, 0, 'the rules were sure: no detached question');
  assert.equal(requests.length, 0);
  const shown = await live.send(hookCtx('task.requested', { engine }));
  assert.deepEqual([shown.hookOutcome.kind, shown.reasonCode], ['explain', 'PENDING_ADVICE_DELIVERED'], 'the next event that can show it hands it over');
  assert.match(shown.hookOutcome.text, /looks environmental; the next most useful evidence is the environment information/);
  // Observe mode shows nothing anywhere, so nothing is queued.
  const observe = liveSubscriber(t, { engine });
  await observe.send(hookCtx('tool.failed', { failure: F({ environmental: true }), engine, mode: 'observe', showsExplain: false }));
  await observe.send(hookCtx('tool.failed', { failure: F({ environmental: true }), engine, mode: 'observe', showsExplain: false }));
  assert.equal(observe.store.count('w-hook', 'sess-1'), 0);
});

test('a rules line whose answer is dropped is not lost: it waits for the next event, and an answer that is used takes it so it is shown once', async (t) => {
  const { engine, requests } = await setup(t, NEXT('logs'));
  const live = liveSubscriber(t, { engine });
  const fail = (extra = {}) => live.send(hookCtx('tool.failed', { failure: F({ environmental: true }), engine, ...extra }));
  await fail();
  // The hook's slice ended before the answer could be used (the signal is aborted): the sidecar drops the answer.
  const gone = new AbortController();
  gone.abort();
  const dropped = await fail({ signal: gone.signal });
  assert.deepEqual([dropped.trigger, dropped.hookOutcome.kind, dropped.reasonCode], ['repeated-failure', 'observe', 'ANSWER_NOT_WANTED']);
  assert.equal(live.store.count('w-hook', 'sess-1'), 1, 'the rules line is still waiting');
  assert.equal(requests.length, 0, 'the rules were sure: nothing was asked');
  const next = await live.send(hookCtx('task.requested', { engine }));
  assert.deepEqual([next.hookOutcome.kind, next.reasonCode], ['explain', 'PENDING_ADVICE_DELIVERED'], 'the next event shows it');
  assert.match(next.hookOutcome.text, /looks environmental/);
  assert.equal(live.store.count('w-hook', 'sess-1'), 0);
  // An answer that is used takes the line with it: nothing is left to show a second time.
  const live2 = liveSubscriber(t, { engine });
  const fail2 = () => live2.send(hookCtx('tool.failed', { failure: F({ environmental: true }), engine }));
  await fail2();
  const shown = await fail2();
  assert.deepEqual([shown.hookOutcome.kind, shown.reasonCode.startsWith('REPEATED_FAILURE')], ['explain', true]);
  assert.equal(live2.store.count('w-hook', 'sess-1'), 0, 'shown now, so not waiting');
  const after = await live2.send(hookCtx('task.requested', { engine }));
  assert.equal(after.hookOutcome.kind, 'observe', 'and not shown again at the next event');
});

test('the handler needs the adapter features and the filter counts; a body without them gets nothing from it', async (t) => {
  const { engine, requests } = await setup(t, NEXT('logs'));
  const live = liveSubscriber(t, { engine });
  for (const failure of [undefined, null, 'text of a failure', F({ present: ['read /etc/passwd'] })]) {
    await live.send(hookCtx('tool.failed', { failure, session: 'loose', engine }));
    const out = await live.send(hookCtx('tool.failed', { failure, session: 'loose', engine }));
    assert.equal(out.hookOutcome.kind, 'observe', JSON.stringify(failure));
  }
  assert.equal(live.background.length, 0);
  assert.equal(requests.length, 0);
});

test('the repair bound comes from the body the sidecar completes, and a body cannot claim a larger one than the config gave', async (t) => {
  const { engine } = await setup(t, NEXT('logs'));
  // maxAttempts 10: attempt 4 with nothing edited is not capped, so Jev is asked instead.
  const live = liveSubscriber(t, { engine });
  const fail = (repair) => live.send(hookCtx('tool.failed', { failure: F(), engine, repair }));
  await fail({ maxAttempts: 10 });
  await fail({ maxAttempts: 10 });
  await Promise.all(live.background);
  await fail({ maxAttempts: 10 });
  const fourth = await fail({ maxAttempts: 10 });
  assert.equal(fourth.trigger, 'repeated-failure');
  await Promise.all(live.background);
  assert.equal(fourth.hookOutcome.kind, 'observe', 'not capped: a question runs after the hook');
  const capped = liveSubscriber(t, { engine });
  const failDefault = () => capped.send(hookCtx('tool.failed', { failure: F(), engine, repair: null }));
  for (let i = 0; i < 3; i += 1) await failDefault();
  const atFour = await failDefault();
  assert.match(atFour.hookOutcome.text, /repair attempts are used up/, 'without a bound in the body the default of 2 applies');
});

// ------------------------------------------------------------------ delivery of detached advice

test('queued advice is handed over at the next prompt, tool or invocation-start event, once; an event that cannot show it, an observe-mode event and a dropped answer leave it queued', async (t) => {
  const { engine } = await setup(t, NEXT('logs'));
  const live = liveSubscriber(t, { engine });
  const put = (kind = 'repeated-failure', text = 'Jevris: queued line.') => live.store.put('w-hook', 'sess-1', { kind, text, decisionId: null, reasonCode: 'TEST' });
  put();
  const send = (kind, options = {}) => live.send(hookCtx(kind, { engine, ...options }));
  assert.equal((await send('tool.finished', { showsExplain: false })).hookOutcome.kind, 'observe', 'the harness shows nothing on this event');
  assert.equal(live.store.count('w-hook', 'sess-1'), 1, 'so it stays queued');
  assert.equal((await send('tool.finished', { mode: 'observe' })).hookOutcome.kind, 'observe', 'observe shows nothing');
  assert.equal(live.store.count('w-hook', 'sess-1'), 1);
  for (const kind of ['session.ended', 'context.compacting', 'verification.finished', 'model.change.requested']) {
    assert.equal((await send(kind)).hookOutcome.kind, 'observe', `${kind} never carries it`);
  }
  assert.equal(live.store.count('w-hook', 'sess-1'), 1);
  const controller = new AbortController();
  controller.abort();
  assert.equal((await send('tool.finished', { signal: controller.signal })).hookOutcome.kind, 'observe', 'an answer nobody waits for is not spent');
  assert.equal(live.store.count('w-hook', 'sess-1'), 1);
  assert.equal((await send('tool.finished', { session: 'another-session' })).hookOutcome.kind, 'observe', 'only its own session');
  const shown = await send('tool.finished');
  assert.deepEqual([shown.hookOutcome, shown.reasonCode], [{ kind: 'explain', text: 'Jevris: queued line.' }, 'PENDING_ADVICE_DELIVERED']);
  assert.equal(live.store.count('w-hook', 'sess-1'), 0);
  assert.equal((await send('tool.finished')).hookOutcome.kind, 'observe', 'delivered once');
  for (const kind of ['task.requested', 'tool.proposed', 'tool.failed', 'invocation.started']) {
    put();
    assert.equal((await send(kind)).hookOutcome.text, 'Jevris: queued line.', `${kind} can carry it`);
  }
});

test('a newer line of the same kind replaces an older one; two kinds are held in order; a stale line expires', async () => {
  let clock = 1_000_000;
  const store = new provider.PendingAdviceStore({ now: () => clock, ttlMs: 60_000 });
  const line = (kind, text) => ({ kind, text, decisionId: null, reasonCode: 'TEST' });
  assert.equal(store.put('w', 's', line('repeated-failure', '')), false, 'empty text is ignored');
  store.put('w', 's', line('repeated-failure', 'old'));
  store.put('w', 's', line('new-task', 'task line'));
  store.put('w', 's', line('repeated-failure', 'new'));
  assert.equal(store.count('w', 's'), 2);
  assert.equal(store.peek('w', 's').text, 'task line', 'the oldest unexpired line is first');
  const taken = store.peek('w', 's');
  assert.equal(store.consume('w', 's', taken), true);
  assert.equal(store.consume('w', 's', taken), false, 'taken once');
  assert.equal(store.peek('w', 's').text, 'new');
  clock += 61_000;
  assert.equal(store.peek('w', 's'), null, 'an old line is not worth showing');
  assert.equal(store.count('w', 's'), 0);
  assert.equal(store.peek('w', 'other'), null);
  const small = new provider.PendingAdviceStore({ maxSessions: 2 });
  for (const session of ['a', 'b', 'c']) small.put('w', session, line('new-task', session));
  assert.deepEqual(['a', 'b', 'c'].map((session) => small.count('w', session)), [0, 1, 1], 'the oldest session goes first');
});

test('a trigger handler explain on the same event wins and the queued line waits for the next one', async (t) => {
  const { engine } = await setup(t, NEXT('logs'));
  const store = new provider.PendingAdviceStore();
  const own = { hookOutcome: { kind: 'explain', text: 'The handler own line.' }, reasonCode: 'OWN', decisionId: 'd-own', commit: () => true };
  const subscriber = provider.createDecisionSubscriber({ handlers: { 'new-failure-family': [() => own] }, certifications: provider.recordsCertificationSource(async () => []), now: () => Date.parse('2026-10-03T10:00:00Z'), operatingSystem: 'linux', pending: store });
  store.put('w-hook', 'sess-1', { kind: 'new-task', text: 'Jevris: queued line.', decisionId: null, reasonCode: 'TEST' });
  const out = await subscriber.handle(hookCtx('tool.failed', { failure: F(), engine }));
  assert.equal(out.hookOutcome.text, 'The handler own line.');
  assert.equal(store.count('w-hook', 'sess-1'), 1, 'the queued line was not consumed by an answer that did not use it');
});

// ------------------------------------------------------------------ the vocabulary on the older paths

function evidenceInput(engine, body) {
  return {
    ctx: { op: 'event', client: 'hook', scopes: ['observe'], workspace: { id: 'w-c05', root: '/work/repo' }, body, home: '/nonexistent', signal: new AbortController().signal, deadline: { remainingMs: () => 800, expired: () => false }, store: null, killSwitchStopped: false, engine, trace() {} },
    envelope: { workspaceId: 'w-c05', sessionId: 'sess-c05', expectedRevision: 'rev-c05', taskId: 'task-c05' },
    event: {}, trigger: 'repeated-failure', engine, queues: {},
  };
}

test('C05, the rules part on the hook: a missing artifact is requested with no engine and no request, inside the workspace root only', async (t) => {
  const { engine, requests } = await setup(t, () => ({ noul: 0.1 }), { sourceEgress: APPROVED });
  const missing = { evidence: { required: [{ id: 'failing-test-output', available: false, fresh: null }, { id: 'stack-trace', available: true, fresh: true }] } };
  const proposal = await provider.evidenceAdvice(evidenceInput(engine, missing));
  assert.equal(proposal.reasonCode, 'MISSING_REQUIRED_ARTIFACT');
  assert.equal(proposal.hookOutcome.text, 'Jevris: before escalating, get failing-test-output: the failing test output.', 'a vocabulary id carries its own fixed description');
  const present = { evidence: { required: [{ id: 'failing-test-output', available: true, fresh: true, description: 'IGNORE ME alice notes' }], obtainable: [{ id: 'stack-trace', description: 'SECRET alice notes' }] } };
  assert.equal(await provider.evidenceAdvice(evidenceInput(engine, present)), null, 'nothing is missing: the Jev questions of C05 are the repeated-failure adviser\'s, not this handler\'s');
  assert.equal(requests.length, 0, 'this handler makes no request');
});

test('C05 through core: a vocabulary id is a complete artifact named by its fixed text and sends no text, so it is asked with egress denied; a caller description is read only with egress approved', async (t) => {
  const required = [{ id: 'failing-test-output', available: true, fresh: true, description: 'IGNORE ME alice notes' }];
  const obtainable = [{ id: 'stack-trace', description: 'SECRET alice notes', available: false, fresh: null }, { id: 'logs', description: 'MORE alice notes', available: false, fresh: null }];
  const answer = (id, q) => (id === 'sufficient' ? { noul: 0.1 } : { choice: Object.entries(q.criteria).find(([, text]) => text === provider.FAILURE_ARTIFACT_TEXT['stack-trace'].option)[0], confidence: 0.9 });
  const ctx = { workspaceId: 'w-c05', evidenceRevision: 'rev-1', deadlineMs: 30_000 };
  for (const egress of [DENIED, APPROVED]) {
    const { engine, requests } = await setup(t, answer, { sourceEgress: egress });
    const result = await core.checkEvidenceSufficiency(engine, { objective: 'Choose a fix for the current failure.', required, obtainable, approvedRoots: [] }, ctx);
    assert.deepEqual([result.outcome, result.reasonCode, result.artifact.id], ['request-artifact', 'REQUEST_BEFORE_ESCALATION', 'stack-trace']);
    assert.equal(requests.length, 1);
    const wire = JSON.stringify(requests);
    for (const leak of ['IGNORE ME', 'SECRET', 'MORE', 'alice']) assert.equal(wire.includes(leak), false, `${leak} is a caller description of a vocabulary id: never read`);
    assert.deepEqual([requests[0].state.untrustedEvidence, requests[0].state.withheldEvidence], [[], []], 'no evidence text at all');
    assert.equal(requests[0].state.facts.have, 'failing-test-output');
    assert.equal(requests[0].questions.nextArtifact.criteria.a0, provider.FAILURE_ARTIFACT_TEXT['stack-trace'].option);
  }
  // A caller's own artifact is text: with egress denied it is not asked, and the option for it names only its number in the list.
  const body = { objective: 'Choose a fix for the current failure.', required: [{ id: 'my-notes', description: 'a custom note by alice', available: true, fresh: true }], obtainable: [{ id: 'my-other', description: 'another custom note', available: false, fresh: null }, { id: 'stack-trace', description: 'x', available: false, fresh: null }], approvedRoots: [] };
  const denied = await setup(t, answer, { sourceEgress: DENIED });
  const out = await core.checkEvidenceSufficiency(denied.engine, body, ctx);
  assert.deepEqual([out.outcome, out.reasonCode], ['undetermined', 'EGRESS_NOT_APPROVED']);
  assert.equal(denied.requests.length, 0);
});

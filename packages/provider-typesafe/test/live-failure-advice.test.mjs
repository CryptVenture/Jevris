// Live repeated-failure advice (owner decision 2026-10-01, Jev as an active decision aid; the rules part
// of C05 and C29 on the hook path). When the same tool failure comes back, one short line says which
// evidence would help most next. The input is the adapter's content-free `failure` features and the
// trigger filter's counts: no error text, path, command or output, so it needs no egress approval.
// Rules first (`adviseFailureLoop`, `maxRepairAttempts`, a fixed priority list that always names the next
// artifact: Jev is NOT asked which artifact is best, because measured live that Choice cleared the
// confidence floors in 2 of 24 answers even with the failure's first line as evidence, decision of
// 2026-10-04). The one question Jev is asked is the same-failure Noul, in ONE request, only when the
// signatures differ but the same call ran again with nothing edited; every miss falls back to the rules
// advice with a reason code. The hook never waits: that question runs after the hook has answered and the
// line is shown at the next event. Scripted fetch and stub engines, temporary homes, no live call, no real harness.
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

/** `setup` with source egress approved: the widest setting, to show that nothing of the failure is read or sent either way. */
const setupApproved = (t, answer, options = {}) => setup(t, answer, { ...options, sourceEgress: APPROVED });

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
// The only question Jev is asked: the same-failure Noul. `SAME(p)` answers it with probability p.
const SAME = (noul) => (id) => (id === 'same' ? { noul } : null);
// A failure whose signature differs from the previous one, the same call run again with nothing edited: the one case that asks.
const UNSURE_OBS = { sameSignature: false, unsure: true, previous: { exitClass: 'nonzero', environmental: false, elapsed: 'lt10s', present: [] } };
const unsureContext = (features = {}, observation = {}, maxRepairAttempts = 2) => context({ signature: 'bbbbbbbbbbbbbbbb', ...features }, { ...UNSURE_OBS, ...observation }, maxRepairAttempts);

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

test('the plan is the rules: environmental failures, one candidate, the repair cap and the unsure case; the next artifact is always the rules\' pick', () => {
  const plan = (features, observation, max) => provider.planFailureAdvice(context(features, observation, max));
  const shape = (p) => [p.step, p.next, p.rulesCode, p.askSame, p.candidates.length];
  assert.deepEqual(shape(plan({}, {}, 2)), ['artifact', 'failing-test-output', 'REPEATED_FAILURE_NEXT_RULES', false, 7], 'a plain failure: the priority list names the test output, Jev is not asked which artifact is best');
  assert.deepEqual(shape(plan({ environmental: true }, {}, 2)), ['artifact', 'environment-info', 'REPEATED_FAILURE_RULES_SURE', false, 7], 'environmental: the rules are sure');
  assert.deepEqual(shape(plan({ environmental: true }, { attempts: 4 }, 10)), ['environment', 'environment-info', 'REPEATED_FAILURE_RULES_SURE', false, 7], 'environmental and past two attempts: the environment line');
  assert.deepEqual(shape(plan({}, { attempts: 4 }, 2)), ['capped', null, 'REPEATED_FAILURE_RULES_SURE', false, 7], 'the same call again with nothing edited and the repair attempts used up: stop and report');
  assert.deepEqual(shape(plan({}, { attempts: 4 }, 0)), ['capped', null, 'REPEATED_FAILURE_RULES_SURE', false, 7], 'a bound of 0 is used up at once');
  assert.deepEqual(shape(plan({}, { attempts: 4, editsSince: 1 }, 2)), ['artifact', 'failing-test-output', 'REPEATED_FAILURE_NEXT_RULES', false, 7], 'an edit in between is progress: not capped');
  assert.deepEqual(shape(plan({}, { attempts: 4, sameCommand: false }, 2)), ['artifact', 'failing-test-output', 'REPEATED_FAILURE_NEXT_RULES', false, 7], 'a different call is not the same attempt');
  assert.deepEqual(shape(plan({}, { attempts: 6 }, 10)), ['artifact', 'failing-test-output', 'REPEATED_FAILURE_NEXT_RULES', false, 7], 'the larger bound from the settings keeps going');
  const one = plan({ present: ALL.filter((id) => id !== 'logs') }, {}, 2);
  assert.deepEqual([one.step, one.next, one.rulesCode], ['artifact', 'logs', 'REPEATED_FAILURE_ONE_CANDIDATE'], 'one artifact left: named by the rules');
  const none = plan({ present: ALL }, {}, 2);
  assert.deepEqual([none.step, none.next, none.rulesCode], ['none', null, 'REPEATED_FAILURE_NO_CANDIDATE'], 'every artifact is already shown: nothing to ask for');
  assert.deepEqual(plan({ present: ['failing-test-output', 'stack-trace'] }, {}, 2).candidates, ['recent-diff', 'repro-steps', 'logs', 'config-file', 'environment-info'], 'what the failure already shows is not asked for again');
  assert.equal(plan({ exitClass: 'timeout', family: 'shell:timeout' }, {}, 2).next, 'logs', 'a timeout leans on the logs');
  const unsure = plan({ signature: 'bbbbbbbbbbbbbbbb' }, { unsure: true, sameSignature: false }, 2);
  assert.equal(unsure.askSame, true, 'signatures differ but the same call ran again with nothing edited: Jev is asked whether it is the same failure');
  assert.equal(unsure.next, 'failing-test-output', 'and the artifact is still the rules\' pick');
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

  // Which artifact comes next is the rules' pick: no request, with source egress denied or approved, one record, and the code says so.
  const rulesText = provider.failureAdviceText('artifact', 2, 'failing-test-output', false);
  const approved = await setupApproved(t, () => ({}));
  for (const who of [engine, approved.engine]) {
    const plain = await provider.adviseRepeatedFailure(who, context(), ASK);
    assert.deepEqual([plain.source, plain.reasonCode, plain.asked, plain.askedCount, plain.usedCount, plain.next, plain.text, plain.jevDecisionId], ['rules', 'REPEATED_FAILURE_NEXT_RULES', false, 0, 0, 'failing-test-output', rulesText, null]);
    const plainRecord = await who.lookup(plain.decisionId);
    assert.ok(plainRecord.reasonCodes.includes('REPEATED_FAILURE_NEXT_RULES') && plainRecord.reasonCodes.includes('FAIL_SOURCE_RULES'));
    assert.equal(plainRecord.reasonCodes.some((code) => code.startsWith('FAIL_ASKED_')), false, 'no Jev call, so none recorded');
  }
  assert.equal(requests.length + approved.requests.length, 0, 'no request for the pick, whatever the egress setting');

  // The gates keep the same-failure question from being asked: the rules advice stands, with the gate's code.
  const gates = [
    ['kill switch', { killSwitchStopped: true }, engine, 'REPEATED_FAILURE_KILL_SWITCH'],
    ['mode off', { mode: 'off' }, engine, 'REPEATED_FAILURE_MODE_OFF'],
    ['jev.assist off', { assist: 'off' }, engine, 'REPEATED_FAILURE_ASSIST_OFF'],
    ['no engine', {}, null, 'REPEATED_FAILURE_NO_PROVIDER'],
    ['no provider configured', {}, { providerConfigured: false, decide: async () => null, lookup: async () => null }, 'REPEATED_FAILURE_NO_PROVIDER'],
    ['too little time for a call to finish', { deadlineMs: 100 }, engine, 'REPEATED_FAILURE_NO_TIME'],
  ];
  for (const [label, extra, who, code] of gates) {
    const advice = await provider.adviseRepeatedFailure(who, unsureContext(), { ...ASK, ...extra });
    assert.deepEqual([advice.source, advice.reasonCode, advice.asked, advice.text], ['rules', code, false, rulesText], label);
  }
  assert.equal(requests.length, 0, 'no gate lets a request out');
  const off = await provider.adviseRepeatedFailure(engine, unsureContext(), { ...ASK, mode: 'off' });
  assert.equal(off.decisionId, null, 'below observe nothing is recorded');
  const stopped = await provider.adviseRepeatedFailure(engine, unsureContext(), { ...ASK, killSwitchStopped: true });
  assert.equal(stopped.decisionId, null, 'a stopped kill switch records nothing');
  const gated = await provider.adviseRepeatedFailure(engine, unsureContext(), { ...ASK, assist: 'off' });
  assert.equal(typeof gated.decisionId, 'string', 'jev.assist off still records the rules advice');
});

// ------------------------------------------------------------------ Jev

test('Jev is asked one question, the same-failure Noul: one request, a fixed question over closed codes, an advisory record, then a cache hit with no second call', async (t) => {
  const { engine, requests } = await setup(t, SAME(0.92));
  const first = await provider.adviseRepeatedFailure(engine, unsureContext(), ASK);
  assert.deepEqual([first.source, first.reasonCode, first.asked, first.askedCount, first.usedCount, first.cacheHit, first.sameByJev, first.next], ['jev', 'REPEATED_FAILURE_JEV', true, 1, 1, false, true, 'failing-test-output']);
  assert.equal(first.text, 'Jevris: this failure has come back 2 times; the next most useful evidence is the failing test output.', 'the artifact is the rules\' pick');
  assert.equal(requests.length, 1, 'one request');
  assert.deepEqual(Object.keys(requests[0].questions), ['same'], 'only the same-failure question: which artifact next is not asked');
  assert.equal(requests[0].questions.same.type, 'noul');
  assert.ok(Object.keys(requests[0].questions).length <= contracts.MAX_QUESTIONS);
  assert.deepEqual([requests[0].state.untrustedEvidence, requests[0].state.withheldEvidence], [[], []], 'no evidence span: closed codes and counts only');
  const record = await engine.lookup(first.decisionId);
  assert.deepEqual([record.specId, record.outcome, record.taskId, record.sessionId], ['repeated-failure', 'advisory', 'task-1', 's-1']);
  for (const code of ['FAIL_FAMILY_SHELL_NONZERO', 'FAIL_ATTEMPTS_2', 'FAIL_SOURCE_JEV', 'FAIL_STEP_ARTIFACT', 'FAIL_NEXT_FAILING_TEST_OUTPUT', 'FAIL_SAME_JEV', 'FAIL_ASKED_1', 'FAIL_USED_1', 'JEV_CACHE_MISS', 'REPEATED_FAILURE_JEV']) assert.ok(record.reasonCodes.includes(code), code);
  assert.deepEqual(record.proposedAction.evidenceIds, ['feature-family', 'feature-attempts', 'feature-environmental', 'feature-elapsed'], 'the evidence ids are feature names');
  assert.equal(typeof record.durationMs, 'number', 'the latency is recorded');
  const again = await provider.adviseRepeatedFailure(engine, unsureContext(), ASK);
  assert.deepEqual([again.source, again.cacheHit, again.sameByJev], ['jev', true, true]);
  assert.equal(requests.length, 1, 'the same features are answered from the decision cache with no second call');
  assert.notEqual(again.decisionId, first.decisionId, 'each advised failure is its own record');
  // Another count bucket is another question, so it is not served from the cache.
  const fourth = await provider.adviseRepeatedFailure(engine, unsureContext({}, { attempts: 6 }, 10), ASK);
  assert.equal(fourth.cacheHit, false);
  assert.equal(requests.length, 2);
  assert.match(fourth.text, /come back 6 times/);
});

test('which artifact comes next never goes to Jev: the rules\' priority list names it, for every kind of failure, with source egress denied or approved and the failure\'s first line at hand', async (t) => {
  const denied = await setup(t, () => ({}), { sourceEgress: DENIED });
  const approved = await setupApproved(t, () => ({}));
  const cases = [
    [context(), 'failing-test-output'],
    [context({ present: ['failing-test-output', 'stack-trace'] }), 'recent-diff'],
    [context({ present: ['stack-trace'] }, { attempts: 5 }, 10), 'failing-test-output'],
    [context({ exitClass: 'timeout', family: 'shell:timeout' }), 'logs'],
    [context({ present: ALL.filter((id) => id !== 'config-file' && id !== 'environment-info') }), 'config-file'],
  ];
  for (const who of [denied, approved]) {
    for (const [ctx, expected] of cases) {
      // A line a caller might pass is not an input of this adviser any more: it is never read, never sent.
      const advice = await provider.adviseRepeatedFailure(who.engine, ctx, { ...ASK, failureLine: 'FAIL src/cart.test.ts > totals > applies the member discount' });
      assert.deepEqual([advice.source, advice.next, advice.asked], ['rules', expected, false]);
    }
    assert.equal(who.requests.length, 0, 'no request for the pick');
  }
});

test('the same-failure Noul is asked only when the signatures differ but the same call ran again with nothing edited', async (t) => {
  let script = SAME(0.92);
  const { engine, requests } = await setup(t, (id, q, body) => script(id, q, body));
  const yes = await provider.adviseRepeatedFailure(engine, unsureContext(), ASK);
  assert.equal(requests.length, 1, 'one request: the same-failure Noul');
  assert.deepEqual(Object.keys(requests[0].questions), ['same']);
  assert.equal(requests[0].questions.same.type, 'noul');
  assert.deepEqual([yes.source, yes.reasonCode, yes.askedCount, yes.usedCount, yes.sameByJev, yes.next], ['jev', 'REPEATED_FAILURE_JEV', 1, 1, true, 'failing-test-output']);
  assert.ok((await engine.lookup(yes.decisionId)).reasonCodes.includes('FAIL_SAME_JEV'));
  // Jev says it is a different failure: nothing to say, and the question is still on the record.
  script = SAME(0.05);
  // Each case is its own question (its own count bucket), so the decision cache never serves an earlier answer.
  const no = await provider.adviseRepeatedFailure(engine, unsureContext({ signature: 'dddddddddddddddd' }, { attempts: 4 }, 10), ASK);
  assert.deepEqual([no.text, no.reasonCode, no.source, no.asked], [null, 'REPEATED_FAILURE_NOT_SAME', 'jev', true]);
  assert.equal(typeof no.decisionId, 'string', 'the miss is recorded');
  // An unsure Noul (below 0.6 either way) is not used: the rules advice stands.
  script = SAME(0.55);
  const unclear = await provider.adviseRepeatedFailure(engine, unsureContext({ signature: 'eeeeeeeeeeeeeeee' }, { attempts: 6 }, 10), ASK);
  assert.deepEqual([unclear.source, unclear.reasonCode, unclear.usedCount, unclear.sameByJev, unclear.next], ['rules', 'REPEATED_FAILURE_JEV_LOW_CONFIDENCE', 0, false, 'failing-test-output']);
  const sameSignature = await provider.adviseRepeatedFailure(engine, context({ signature: 'ffffffffffffffff' }), ASK);
  assert.equal(requests.length, 3, 'equal signatures are the same failure by rule: no Noul');
  assert.equal(sameSignature.asked, false);
});

test('only features leave: no error text, path, command, output or digest in any request, whatever the body carried', async (t) => {
  // A realistic failure from the Claude Code adapter: the error text, path and command stay in the adapter.
  const error = 'Exit code 1\n  1) checkout totals\n     AssertionError: expected 41 to equal 42\n      at Context.<anonymous> (/Users/alice/work/shop/test/cart.test.js:10:5)\n      at process.processImmediate (node:internal/timers:483:21)';
  const normalized = claude.normalize({ session_id: 's1', cwd: '/Users/alice/work/shop', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'npm test -- --grep checkout' }, error, duration_ms: 4200 }, {});
  assert.equal(normalized.ok, true);
  const failure = normalized.intent.failure;
  // Egress approved is the widest setting: nothing of the failure is read either way.
  const { engine, requests } = await setupApproved(t, SAME(0.9));
  // Junk keys a hook could add to the body's failure object are dropped by the parser.
  const parsed = provider.parseFailureFeatures({ ...failure, text: error, path: '/Users/alice/work/shop/test/cart.test.js', command: 'npm test -- --grep checkout', description: 'the failing checkout test' });
  assert.notEqual(parsed, null);
  const previous = { exitClass: 'nonzero', environmental: false, elapsed: 'lt10s', present: ['failing-test-output'] };
  const advice = await provider.adviseRepeatedFailure(engine, provider.failureContextOf(parsed, OBS({ unsure: true, sameSignature: false, previous }), 2), ASK);
  assert.equal(requests.length, 1);
  const wire = JSON.stringify(requests);
  for (const leak of ['alice', 'cart.test', 'AssertionError', 'checkout', 'npm test', 'grep', 'processImmediate', 'timers', 'task-1', 's-1', failure.signature, failure.commandDigest]) assert.equal(wire.includes(leak), false, `${leak} must not leave`);
  assert.deepEqual([requests[0].state.untrustedEvidence, requests[0].state.withheldEvidence], [[], []], 'no evidence span at all');
  const facts = requests[0].state.facts;
  assert.deepEqual(Object.keys(facts).sort(), ['attempts', 'editsSince', 'elapsed', 'environmental', 'family', 'maxRepairAttempts', 'present', 'previousElapsed', 'previousEnvironmental', 'previousPresent', 'sameCommand']);
  assert.deepEqual([facts.family, facts.attempts, facts.environmental, facts.elapsed, facts.present], ['shell:nonzero', '2', false, 'lt10s', 'failing-test-output,stack-trace']);
  assert.equal(advice.source, 'jev');
  assert.equal(advice.text.includes('alice'), false);
  for (const text of [advice.text, JSON.stringify(await engine.lookup(advice.decisionId))]) for (const leak of ['alice', 'cart.test', 'AssertionError', 'checkout', failure.signature, failure.commandDigest]) assert.equal(text.includes(leak), false, `${leak} is not in the advice or the record`);
});

test('works with source egress approved too, and the request is the same features either way', async (t) => {
  const denied = await setup(t, SAME(0.9), { sourceEgress: DENIED });
  const approved = await setup(t, SAME(0.9), { sourceEgress: APPROVED });
  await provider.adviseRepeatedFailure(denied.engine, unsureContext(), ASK);
  await provider.adviseRepeatedFailure(approved.engine, unsureContext(), ASK);
  assert.deepEqual(denied.requests[0].state, approved.requests[0].state);
});

// ------------------------------------------------------------------ every miss keeps the rules

test('a Jev answer that is not sure or not usable keeps the rules advice, with the reason', async (t) => {
  let script = SAME(0.55);
  const { engine } = await setup(t, (id, q, body) => script(id, q, body));
  const rules = provider.failureAdviceText('artifact', 2, 'failing-test-output', false);
  // Each case is its own question (its own count), so an earlier answer in the cache never serves it.
  const ask = (attempts) => provider.adviseRepeatedFailure(engine, unsureContext({}, { attempts }, 10), ASK);
  const low = await ask(2);
  assert.deepEqual([low.source, low.reasonCode, low.asked, low.usedCount, low.text], ['rules', 'REPEATED_FAILURE_JEV_LOW_CONFIDENCE', true, 0, rules], 'below 0.6 certainty either way');
  script = () => null;
  const silent = await provider.adviseRepeatedFailure(engine, unsureContext({ present: ['config-file'] }, {}, 10), ASK);
  assert.deepEqual([silent.source, silent.reasonCode, silent.text], ['rules', 'REPEATED_FAILURE_JEV_INVALID_RESPONSE', rules], 'a response with no answer in it is refused by the engine');
  // An answer set that passes through with nothing usable in it (a stub engine) is no answer.
  const empty = { decide: async () => ({ abstained: false, decisionId: 'd-00000000-0000-4000-8000-000000000002', result: { answers: {} }, automation: true, rulesOnly: false }), lookup: async () => null };
  const noAnswer = await provider.adviseRepeatedFailure(empty, unsureContext(), ASK);
  assert.deepEqual([noAnswer.source, noAnswer.reasonCode, noAnswer.usedCount, noAnswer.text], ['rules', 'REPEATED_FAILURE_JEV_NO_ANSWER', 0, rules]);
  script = SAME(0.97);
  const sure = await provider.adviseRepeatedFailure(engine, unsureContext({}, { attempts: 6 }, 10), ASK);
  assert.deepEqual([sure.source, sure.reasonCode, sure.usedCount, sure.sameByJev], ['jev', 'REPEATED_FAILURE_JEV', 1, true]);
});

test('a Jev error, an open circuit, an exhausted budget and a late answer keep the rules advice with the reason in the code', async () => {
  const rules = provider.failureAdviceText('artifact', 2, 'failing-test-output', false);
  const stub = (reasonCode) => ({ decide: async () => ({ abstained: true, reasonCode, decisionId: 'd-00000000-0000-4000-8000-000000000001', fallback: 'rules-only' }), lookup: async () => null });
  // Refused on this machine before anything is sent: Jev was not asked. A deadline is a request that went out.
  for (const [reason, expected, asked] of [['CIRCUIT_OPEN', 'REPEATED_FAILURE_JEV_CIRCUIT_OPEN', false], ['BUDGET', 'REPEATED_FAILURE_JEV_BUDGET', false], ['BUDGET_MACHINE_LIMIT', 'REPEATED_FAILURE_JEV_BUDGET_MACHINE_LIMIT', false], ['DEADLINE', 'REPEATED_FAILURE_JEV_DEADLINE', true], ['EGRESS_NOT_APPROVED', 'REPEATED_FAILURE_JEV_EGRESS_NOT_APPROVED', false]]) {
    const advice = await provider.adviseRepeatedFailure(stub(reason), unsureContext(), ASK);
    assert.deepEqual([advice.source, advice.reasonCode, advice.text, advice.asked, advice.askedCount], ['rules', expected, rules, asked, asked ? 1 : 0], reason);
  }
  const throwing = { decide: async () => { throw new Error('boom'); }, lookup: async () => null };
  const failed = await provider.adviseRepeatedFailure(throwing, unsureContext(), ASK);
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
  const { engine, requests, script } = await setup(t, SAME(0.9), { gate });
  const rules = provider.failureAdviceText('artifact', 2, 'failing-test-output', false);
  const late = await provider.adviseRepeatedFailure(engine, unsureContext(), { ...ASK, deadlineMs: 150, lateGraceMs: 60_000 });
  assert.deepEqual([late.source, late.reasonCode, late.text, late.asked], ['rules', 'REPEATED_FAILURE_DEADLINE', rules, true], 'the caller did not wait for Jev');
  // The engine does several durable journal writes before it sends: on a slow disk the request goes out after the 150 ms. Wait for the request, not for a fixed time.
  await until(() => requests.length === 1);
  assert.equal(script.finishedCount(), 0, 'Jev has not answered yet');
  open();
  await until(() => script.finishedCount() === 1);
  // The engine puts the late answer in the decision cache just after the response: wait for the entry, not for a fixed time.
  await until(() => engine.cache.stats().entries === 1);
  const warm = await provider.adviseRepeatedFailure(engine, unsureContext(), { ...ASK, record: false });
  assert.deepEqual([warm.source, warm.cacheHit, warm.sameByJev], ['jev', true, true]);
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
  const { home, engine } = await setup(t, SAME(0.92));
  const advice = await provider.adviseRepeatedFailure(engine, unsureContext(), ASK);
  const text = core.explainDecision(await engine.lookup(advice.decisionId));
  assert.match(text, /Repeated failure: a shell command failed with a non-zero exit 2 times in this session; the advice is from Jev and decides nothing\./);
  assert.match(text, /Advice: name the one kind of evidence to obtain next: failing test output\./);
  assert.match(text, /Questions: Jev read it as the same failure as before\. Which kind of evidence to get next, from a fixed list of seven kinds, is not asked of Jev: the rules' priority order names it\. Jev was asked 1 question and 1 answer cleared the confidence bar \(asked Jev, \d+ ms\)\./);
  assert.match(text, /Reason: REPEATED_FAILURE_JEV\./);
  assert.match(text, /Evidence: feature-family, feature-attempts, feature-environmental, feature-elapsed \(structured features only; no error text, paths, command text or tool output\)\./);
  assert.match(text, /changes no permission, runs nothing and marks nothing done/);
  // The engine's own record of the Jev call (same spec id, also advisory) is not the adviser's, so it gets no adviser's lines.
  assert.equal(typeof advice.jevDecisionId, 'string');
  const callText = core.explainDecision(await engine.lookup(advice.jevDecisionId));
  assert.doesNotMatch(callText, /Repeated failure:|Advice: name the one kind/, 'the Jev call record is explained as a provider call');
  const again = await provider.adviseRepeatedFailure(engine, unsureContext(), ASK);
  assert.match(core.explainDecision(await engine.lookup(again.decisionId)), /\(cache hit, \d+ ms\)/);
  assert.doesNotMatch(core.explainDecision(await engine.lookup(again.jevDecisionId)), /Repeated failure:/, 'and so is the cache hit\'s own record');
  const rules = await provider.adviseRepeatedFailure(engine, context({ environmental: true }), ASK);
  const rulesText = core.explainDecision(await engine.lookup(rules.decisionId));
  assert.match(rulesText, /the advice is from rules and decides nothing/);
  assert.match(rulesText, /looks environmental/);
  assert.match(rulesText, /Jev was not asked/);
  const plain = await provider.adviseRepeatedFailure(engine, context(), ASK);
  const plainText = core.explainDecision(await engine.lookup(plain.decisionId));
  assert.match(plainText, /the advice is from rules and decides nothing/);
  assert.match(plainText, /Which kind of evidence to get next, from a fixed list of seven kinds, is not asked of Jev: the rules' priority order names it\. Jev was not asked/);
  assert.match(plainText, /Reason: REPEATED_FAILURE_NEXT_RULES\./);
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

// Failures of one call whose error text differs each time (a timestamp, a port): possibly the same failure, so the same-failure Noul is asked.
const sig = (n) => F({ signature: n.toString(16).padStart(16, '0') });

test('the count escalates across a session: the same call again with other error text asks Jev at the next event, the same failure again at attempt 4 hits the cap; two different failures are not merged', async (t) => {
  const { engine, requests } = await setup(t, SAME(0.92));
  // The hook waits at most 250 ms for the advisory record and then answers without its decision id (the product is right to stop
  // waiting; live-handler-record-deadline.test.mjs proves that bound). This test reads the record, so it gives the wait a long bound and
  // the hook plenty of time: a slow disk then cannot turn the record into what the test races.
  const live = liveSubscriber(t, { engine, recordWaitMaxMs: 120_000 });
  const fail = (failure, options = {}) => live.send(hookCtx('tool.failed', { failure, engine, remainingMs: 300_000, ...options }));
  // Attempt 1: a new family, no handler registered for it. Attempt 2: the same call again, its error text differs.
  assert.equal((await fail(sig(1))).hookOutcome.kind, 'observe');
  const second = await fail(sig(2));
  assert.equal(second.trigger, 'repeated-failure');
  assert.equal(second.hookOutcome.kind, 'observe', 'the hook answers at once: Jev is being asked, the line waits for the next event');
  await Promise.all(live.background);
  assert.equal(requests.length, 1);
  assert.deepEqual(Object.keys(requests[0].questions), ['same'], 'the only question: is it the same failure');
  assert.equal(live.store.count('w-hook', 'sess-1'), 1, 'the finished line is queued for the session');
  // The next event of the session hands it over (attempt 3 is not a trigger by itself).
  const third = await fail(sig(3));
  assert.deepEqual([third.hookOutcome.kind, third.reasonCode], ['explain', 'PENDING_ADVICE_DELIVERED']);
  assert.equal(third.hookOutcome.text, 'Jevris: this failure has come back 2 times; the next most useful evidence is the failing test output.');
  assert.equal(live.store.count('w-hook', 'sess-1'), 0, 'delivered once');
  // Attempt 4 is the same failure as attempt 3 with nothing edited and the repair bound of 2 used up: the rules settle it, no request, the line comes back with the answer.
  const fourth = await fail(sig(3));
  assert.equal(fourth.trigger, 'repeated-failure');
  assert.equal(fourth.hookOutcome.kind, 'explain');
  assert.match(fourth.hookOutcome.text, /^Jevris: this failure has come back 4 times with nothing changed and the repair attempts are used up; stop and report what was tried\.$/);
  assert.equal(requests.length, 1, 'no second request for a deterministic cap');
  assert.equal(fourth.decisionIds.length, 1, 'the advisory decision is named in the answer');
  const record = await engine.lookup(fourth.decisionIds[0]);
  assert.deepEqual([record.specId, record.outcome], ['repeated-failure', 'advisory']);
  assert.ok(record.reasonCodes.includes('FAIL_STEP_CAPPED') && record.reasonCodes.includes('FAIL_ATTEMPTS_4'));
  // A different call of the same family starts its own count: not 5, not merged with the first.
  const b = F({ signature: 'bbbbbbbbbbbbbbbb', commandDigest: 'dddddddddddddddd' });
  assert.equal((await fail(b)).trigger, null, 'a different failure is progress, not a repeat');
  // The same failure of that call again: a repeat by rule. Which artifact comes next is the rules' pick, so the line comes back at once.
  const bSecond = await fail(b);
  assert.equal(bSecond.trigger, 'repeated-failure');
  assert.deepEqual([bSecond.hookOutcome.kind, bSecond.reasonCode], ['explain', 'REPEATED_FAILURE_NEXT_RULES']);
  assert.match(bSecond.hookOutcome.text, /^Jevris: this failure has come back 2 times; the next most useful evidence is the failing test output\.$/, 'the second failure counts from its own first');
  assert.equal(requests.length, 1, 'and no request was made for it');
});

test('a failure that raises no same-failure question is answered at once by the rules, with no detached run and no request, with source egress denied or approved', async (t) => {
  const rules = 'Jevris: this failure has come back 2 times; the next most useful evidence is the failing test output.';
  for (const options of [{ sourceEgress: DENIED }, { sourceEgress: APPROVED }]) {
    const { engine, requests } = await setup(t, () => ({}), options);
    const live = liveSubscriber(t, { engine, recordWaitMaxMs: 120_000 });
    const fail = () => live.send(hookCtx('tool.failed', { failure: F(), engine, remainingMs: 300_000 }));
    await fail();
    const second = await fail();
    assert.deepEqual([second.trigger, second.hookOutcome, second.reasonCode], ['repeated-failure', { kind: 'explain', text: rules }, 'REPEATED_FAILURE_NEXT_RULES']);
    assert.equal(live.background.length, 0, 'no detached run');
    assert.equal(requests.length, 0, 'no request');
    assert.equal(second.decisionIds.length, 1, 'one advisory record');
    assert.equal(live.store.count('w-hook', 'sess-1'), 0, 'shown now, not queued');
    const record = await engine.lookup(second.decisionIds[0]);
    assert.ok(record.reasonCodes.includes('REPEATED_FAILURE_NEXT_RULES') && !record.reasonCodes.some((code) => code.startsWith('FAIL_ASKED_')), 'no Jev call recorded for it');
  }
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
  await live.send(hookCtx('tool.failed', { failure: sig(1), engine }));
  const answered = await live.send(hookCtx('tool.failed', { failure: sig(2), engine }));
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
  const { engine, requests } = await setup(t, SAME(0.9));
  const rules = 'Jevris: this failure has come back 2 times; the next most useful evidence is the failing test output.';
  const cases = [
    ['jev.assist off', { jevAssist: 'off' }, 'REPEATED_FAILURE_ASSIST_OFF'],
    ['no provider', { engine: undefined }, 'REPEATED_FAILURE_NO_PROVIDER'],
  ];
  for (const [label, extra, code] of cases) {
    const live = liveSubscriber(t, { engine });
    await live.send(hookCtx('tool.failed', { failure: sig(1), engine, ...extra }));
    const answered = await live.send(hookCtx('tool.failed', { failure: sig(2), engine, ...extra }));
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
  const { engine, requests } = await setup(t, SAME(0.9));
  const live = liveSubscriber(t, { engine });
  let stopped = false;
  const send = (failure, extra = {}) => live.send({ ...hookCtx('tool.failed', { failure, engine }), killSwitchNow: async () => stopped, ...extra });
  await send(sig(1));
  stopped = true;
  const answered = await send(sig(2));
  assert.equal(answered.hookOutcome.kind, 'observe');
  await Promise.all(live.background);
  assert.equal(requests.length, 0, 'the detached run re-read the kill switch and stopped');
  assert.equal(live.store.count('w-hook', 'sess-1'), 0);
  assert.equal(live.traces.findLast((x) => x.event === 'repeated-failure-advice').reasonCode, 'REPEATED_FAILURE_KILL_SWITCH');
});

test('observe mode records the counterfactual and shows nothing; advise mode shows the line at the next event', async (t) => {
  const { engine, requests } = await setup(t, SAME(0.9));
  const observe = liveSubscriber(t, { engine });
  const fail = (live, failure, mode) => live.send(hookCtx('tool.failed', { failure, engine, mode }));
  await fail(observe, sig(1), 'observe');
  const answered = await fail(observe, sig(2), 'observe');
  assert.deepEqual([answered.hookOutcome.kind, answered.reasonCode], ['observe', 'MODE_DOES_NOT_ADVISE']);
  await Promise.all(observe.background);
  assert.equal(requests.length, 1, 'the question was asked and recorded');
  assert.equal(observe.store.count('w-hook', 'sess-1'), 0, 'but nothing is queued to be shown');
  const shown = liveSubscriber(t, { engine });
  await fail(shown, sig(1), 'advise');
  await fail(shown, sig(2), 'advise');
  await Promise.all(shown.background);
  assert.equal(shown.store.count('w-hook', 'sess-1'), 1);
});

test('on an event where the harness shows nothing the rules line waits for the next one that can, instead of being lost', async (t) => {
  const { engine, requests } = await setup(t, SAME(0.9));
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
  const { engine, requests } = await setup(t, SAME(0.9));
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
  const { engine, requests } = await setup(t, SAME(0.9));
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
  const { engine } = await setup(t, SAME(0.9));
  // maxAttempts 10: attempt 4 with nothing edited is not capped, so the same-failure question is asked instead.
  const live = liveSubscriber(t, { engine });
  const fail = (failure, repair) => live.send(hookCtx('tool.failed', { failure, engine, repair }));
  await fail(sig(1), { maxAttempts: 10 });
  await fail(sig(2), { maxAttempts: 10 });
  await Promise.all(live.background);
  await fail(sig(3), { maxAttempts: 10 });
  const fourth = await fail(sig(4), { maxAttempts: 10 });
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
  const { engine } = await setup(t, SAME(0.9));
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
  const { engine } = await setup(t, SAME(0.9));
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

test('C05, by rule on the hook: a missing artifact is requested with no engine and no request, inside the workspace root only', async (t) => {
  const { engine, requests } = await setup(t, () => ({ noul: 0.1 }), { sourceEgress: APPROVED });
  const missing = { evidence: { required: [{ id: 'failing-test-output', available: false, fresh: null }, { id: 'stack-trace', available: true, fresh: true }] } };
  const proposal = await provider.evidenceAdvice(evidenceInput(engine, missing));
  assert.equal(proposal.reasonCode, 'MISSING_REQUIRED_ARTIFACT');
  assert.equal(proposal.hookOutcome.text, 'Jevris: before escalating, get failing-test-output: the failing test output.', 'a vocabulary id carries its own fixed description');
  const present = { evidence: { required: [{ id: 'failing-test-output', available: true, fresh: true, description: 'IGNORE ME alice notes' }], obtainable: [{ id: 'stack-trace', description: 'SECRET alice notes' }] } };
  assert.equal(await provider.evidenceAdvice(evidenceInput(engine, present)), null, 'nothing is missing: nothing is asked of Jev about which artifact is next');
  assert.equal(requests.length, 0, 'this handler makes no request');
});

test('C05 through core is rules only: it names a missing or stale artifact, inside the approved roots only, and never claims the evidence is enough', () => {
  const art = (over) => ({ id: 'failing-test-output', description: 'The failing run output', available: true, fresh: true, ...over });
  const none = core.checkEvidenceSufficiency({ required: [art({})], approvedRoots: [] });
  assert.deepEqual([none.outcome, none.reasonCode, none.escalate, none.notObserved], ['undetermined', 'NOTHING_MISSING', false, []], 'nothing missing is not "sufficient"');
  const missing = core.checkEvidenceSufficiency({ required: [art({}), art({ id: 'stack-trace', available: false, fresh: null, location: '/work/repo/out/trace.txt' })], approvedRoots: ['/work/repo'] });
  assert.deepEqual([missing.outcome, missing.reasonCode, missing.artifact.id, missing.artifact.location, missing.notObserved], ['request-artifact', 'MISSING_REQUIRED_ARTIFACT', 'stack-trace', '/work/repo/out/trace.txt', ['stack-trace']]);
  assert.equal(core.checkEvidenceSufficiency({ required: [art({ id: 'stack-trace', available: false, fresh: null, location: '/etc/passwd' })], approvedRoots: ['/work/repo'] }).artifact.location, null, 'a location outside the approved roots is never suggested');
  const stale = core.checkEvidenceSufficiency({ required: [art({ fresh: false })], approvedRoots: [] });
  assert.deepEqual([stale.outcome, stale.reasonCode, stale.artifact.id], ['request-artifact', 'STALE_ARTIFACT', 'failing-test-output']);
  assert.equal(core.checkEvidenceSufficiency.length, 1, 'it takes no engine: nothing here asks a provider');
  assert.equal(Object.hasOwn(provider.FAILURE_ARTIFACT_TEXT['stack-trace'], 'option'), false, 'and the vocabulary has no option text: there is no question to put it in');
});

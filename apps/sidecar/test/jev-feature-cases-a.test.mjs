import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sandbox } from '../../../test/acceptance/lib.mjs';
import { startJevStub } from '../../../test/acceptance/jev-stub.mjs';
import { managedHostSkip } from '../../../test/managed-host.mjs';
import { MARKER, runCases, writeWorkspace } from '../scripts/jev-feature-driver.mjs';
import { DEADLINE_ATTEMPTS, askSidecar, askSidecarCounted } from '../scripts/sidecar-ask.mjs';
import { CASES, FILES, KNOWN_DEFECTS, KNOWN_LEAKS, OWNED_CASES, preparePart, wrapSidecar } from '../scripts/jev-feature-cases-a.mjs';

// The part A capability cases of the live Jev feature suite (C25, C26, C28, C30, C33 to C38), run
// offline: a real sidecar in a sandbox, its Jev provider aimed at the conformance stub. For each case
// the test proves that the setup and the call make the handler send a valid Jev request, that a
// consult which carries workspace or caller text waits for source egress approval, and that with
// egress denied no request carries a marker the case put in free text.

const MODEL = 'jev-1.13.0';
const OPTION_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** The question type each capability asks (the catalogue's primitive). */
const PRIMITIVE = { C25: 'choice', C26: 'choice', C28: 'noul', C30: 'noul', C33: 'choice', C34: 'score', C35: 'score', C36: 'choice', C37: 'noul', C38: 'choice' };

/**
 * A sandbox, a Jev stub, the workspace prepared by the part's own `preparePart`, and a running
 * sidecar. `egress` is `denied` or `approved`. The mode is `advise` unless a scripted worker port is
 * asked for (`workerRuns`): in `advise` no owned worker starts, so a plan step leaves its tasks queued
 * and no worker port is ever loaded.
 */
async function startPass(t, { egress, workerRuns, stubOptions, exactBudgets }) {
  // `confident`: the stub's answers clear the consult floors (confidence 0.6, margin 0.15), so "asked" and "answered from Jev" mean the same thing here.
  const stub = await startJevStub(t, stubOptions ?? { scenario: 'confident' });
  // A pass whose subject is a deadline passes `exactBudgets`: its sidecar keeps the product's budgets whatever scale the runner sets.
  const box = await sandbox(t, { env: stub.env, ...(exactBudgets === true ? { exactBudgets: true } : {}) });
  const work = join(box.dir, 'ws');
  writeWorkspace(work, FILES);
  await preparePart({ home: box.home, work, egress, mode: workerRuns === undefined ? 'advise' : 'bounded-auto' });
  if (workerRuns !== undefined) await box.workerScript(workerRuns);
  const started = box.startSidecar();
  assert.equal(started.code, 0, `the sidecar did not start: ${started.stdout} ${started.stderr}`);
  const sidecar = wrapSidecar(await import('../dist/index.js'));
  return { stub, box, work, sidecar, egress };
}

/** JSON pointers of every string (or key) in `value` that holds the marker. */
function markerPaths(value, path = '') {
  const out = [];
  if (typeof value === 'string') return value.includes(MARKER) ? [path] : out;
  if (Array.isArray(value)) value.forEach((item, i) => out.push(...markerPaths(item, `${path}/${String(i)}`)));
  else if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (key.includes(MARKER)) out.push(`${path}/${key}#key`);
      out.push(...markerPaths(inner, `${path}/${key}`));
    }
  }
  return out;
}

const markersIn = (entries) => [...new Set(entries.flatMap((entry) => markerPaths(JSON.parse(entry.body), '')))];

/** Asserts one request the stub received is a valid Jev request; returns its parsed body. */
function assertJevRequest(entry, label) {
  assert.equal(entry.method, 'POST', label);
  assert.equal(entry.path, '/v1/systemone', label);
  assert.ok(Buffer.byteLength(entry.body, 'utf8') <= 131_072, `${label}: the request is over the byte cap`);
  const body = JSON.parse(entry.body);
  assert.equal(body.model, MODEL, `${label}: the model is not the pin`);
  const questions = Object.entries(body.questions ?? {});
  assert.ok(questions.length >= 1 && questions.length <= 12, `${label}: ${String(questions.length)} questions`);
  for (const [id, question] of questions) {
    assert.match(id, OPTION_KEY, `${label}: question id`);
    assert.equal(typeof question.instructions, 'string', `${label}: instructions`);
    if (question.type === 'choice') {
      const keys = Object.keys(question.criteria ?? {});
      assert.ok(keys.length >= 2, `${label}: a choice question needs two or more criteria, has ${String(keys.length)}`);
      for (const key of keys) {
        assert.match(key, OPTION_KEY, `${label}: choice key ${key}`);
        assert.equal(typeof question.criteria[key], 'string', `${label}: choice text`);
      }
    } else if (question.type === 'score') {
      assert.ok(Array.isArray(question.criteria) && question.criteria.length >= 2 && question.criteria.length <= 10, `${label}: score criteria`);
      assert.ok(question.criteria.every((c) => typeof c === 'string' && c.trim() !== ''), `${label}: score anchors`);
    } else {
      assert.equal(question.type, 'noul', `${label}: unknown question type ${String(question.type)}`);
      assert.deepEqual(Object.keys(question.criteria ?? {}).sort(), ['false', 'true'], `${label}: noul criteria`);
    }
  }
  return body;
}

/** Asserts the requests of a case's call are the capability's own question, of the type the catalogue names. */
function assertOwnQuestion(c, call) {
  const capabilityId = c.call.body.capabilityId;
  const primitive = PRIMITIVE[capabilityId];
  for (const entry of call) {
    const body = assertJevRequest(entry, c.id);
    assert.equal(body.state?.trustedPolicy?.capability, capabilityId, `${c.id}: the request is for another capability`);
    assert.deepEqual(Object.values(body.questions).map((q) => q.type), [primitive], `${c.id}: the question is not a ${primitive} question`);
  }
}

/**
 * Runs `cases` one at a time and returns, per case, the driver's row, every request since the case
 * began (setup and call), and the requests of the call alone. The row carries the decision record's
 * reason codes, usage and cost.
 */
async function runEach({ stub, box, work, sidecar, egress }, cases) {
  const lookup = async (decisionId) => {
    const answer = await askSidecar(sidecar, { home: box.home, op: 'decision.get', scope: 'cli', workspace: work, body: { decisionId }, timeoutMs: 20_000 });
    return answer.ok && answer.result?.found === true ? answer.result.record : null;
  };
  const out = [];
  for (const c of cases) {
    const marks = [];
    const begin = stub.requests().length;
    // A call the sidecar cuts short (DEADLINE on a slow host) is asked again, and so is one that came but did not use Jev although this case
    // must (a handler asks only while enough time is left, and discards a Jev answer that comes after its deadline); `row.requests` then
    // counts every attempt.
    const asks = (kase) => kase.expectAsked && !Object.hasOwn(KNOWN_DEFECTS, kase.id) && !(kase.egressNeeded && egress === 'denied');
    const done = (kase, got) => !asks(kase) || (got.requests >= 1 && got.summary.source === 'jev');
    const [row] = await runCases({ sidecar, home: box.home, work, cases: [c], lookup, attempts: DEADLINE_ATTEMPTS, done, requestCount: () => marks[marks.push(stub.requests().length) - 1] });
    const all = stub.requests();
    // The count is read before the call, after each attempt that is judged, and once at the end: the call's requests lie between the first and the last.
    out.push({ c, row, since: all.slice(begin), call: marks.length >= 2 ? all.slice(marks[0], marks.at(-1)) : [] });
  }
  return out;
}

/** Runs `check` and records what it throws as one problem line instead of stopping the run. */
function guarded(problems, label, check) {
  try {
    check();
  } catch (error) {
    problems.push(`${label}: ${String(error?.message ?? error).split('\n')[0]}`);
  }
}

/** The one-line diagnostic of a row: what the call did and what it cost. */
function describe(label, row) {
  const cost = row.costMicroUsd === null ? 'n/a' : String(row.costMicroUsd);
  const usage = row.usage === null ? 'n/a' : `${String(row.usage.inputTokens ?? row.usage.input_tokens)}/${String(row.usage.outputTokens ?? row.usage.output_tokens)}`;
  return `${label} ok=${String(row.ok)} attempts=${String(row.attempts)} requests=${String(row.requests)} source=${String(row.source)} reason=${String(row.reasonCode)} verb=${String(row.verb)} codes=${row.jevReasonCodes.join('|')} tokens=${usage} microUsd=${cost} ms=${String(row.elapsedMs)} failure=${String(row.failure)}`;
}

// ------------------------------------------------------------------ the cases

test('the cases are well formed and every free-text field carries its marker', () => {
  const ids = [...CASES, ...OWNED_CASES].map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'case ids are not unique');
  const fixtures = Object.values(FILES).join('\n');
  for (const c of [...CASES, ...OWNED_CASES]) {
    assert.match(c.site, /^packages\/orchestrator\/src\/capabilities\/(orchestration|retrieval)\.ts:\d+$/, c.id);
    assert.equal(typeof c.title, 'string', c.id);
    assert.equal(typeof c.expectAsked, 'boolean', c.id);
    assert.equal(typeof c.egressNeeded, 'boolean', c.id);
    assert.ok(c.notes.length > 40, `${c.id} says nothing about what the setup must hold`);
    assert.equal(c.call.op, 'capability.advise', c.id);
    assert.ok(Object.hasOwn(PRIMITIVE, c.call.body.capabilityId), `${c.id} names no known capability`);
    assert.ok(`${JSON.stringify([c.steps, c.call])}\n${fixtures}`.includes(`${MARKER}-${c.id.split('-')[0]}`), `${c.id} holds no ${MARKER}-<id> marker in an input or a fixture`);
  }
  for (const id of [...Object.keys(KNOWN_LEAKS), ...Object.keys(KNOWN_DEFECTS)]) assert.ok(ids.includes(id), `${id} is not a case`);
  // The ten consults of the assignment: one case each (C28 also has its owned variant).
  assert.deepEqual(CASES.map((c) => c.call.body.capabilityId), ['C25', 'C26', 'C28', 'C30', 'C33', 'C34', 'C35', 'C36', 'C37', 'C38']);
  // Every consult of this part is about workspace or caller text (an option text, a task title, a query, a span, a command, a failure line): with egress
  // denied the packet builder withholds the evidence and only a hash and a length would be sent, so none of them is asked without approval.
  assert.deepEqual(CASES.filter((c) => c.egressNeeded).map((c) => c.id), ['C25', 'C26', 'C28', 'C30', 'C33', 'C34', 'C35', 'C36', 'C37', 'C38']);
  assert.deepEqual(OWNED_CASES.filter((c) => c.egressNeeded).map((c) => c.id), ['C28-owned']);
});

test('preparePart refuses an egress or a mode it does not know, before it touches anything', async () => {
  await assert.rejects(preparePart({ home: 'unused-home', work: 'unused-work', egress: 'maybe', mode: 'advise' }), /egress must be denied or approved/);
  await assert.rejects(preparePart({ home: 'unused-home', work: 'unused-work', egress: 'denied', mode: 'everything' }), /mode must be one of/);
  assert.equal(wrapSidecar(FILES), FILES, 'a part with no pseudo-ops hands the client back unchanged');
});

test('part A cases with source egress denied: every consult is reached with a valid request and no source text leaves', { skip: managedHostSkip(), timeout: 600_000 }, async (t) => {
  const pass = await startPass(t, { egress: 'denied' });
  const results = await runEach(pass, CASES);
  const problems = [];
  for (const { c, row, since, call } of results) {
    t.diagnostic(`${describe(c.id, row)} setupRequests=${String(since.length - call.length)}`);
    guarded(problems, c.id, () => {
      assert.equal(row.failure, null, String(row.failure));
      assert.equal(row.ok, true, 'the op did not answer ok');
      assertOwnQuestion(c, call);
      const defect = Object.hasOwn(KNOWN_DEFECTS, c.id);
      if (c.egressNeeded) {
        // The question carries workspace or caller text: with egress denied nothing is asked and nothing is decided.
        assert.equal(row.requests, 0, 'a consult that carries workspace text sent a request while egress was denied');
        assert.equal(row.source, 'rules', 'the answer did not come from rules');
        assert.equal(row.decisionId, null, 'a decision was built although nothing may be asked');
      } else if (c.expectAsked && !defect) {
        assert.ok(row.requests >= 1, `the call sent no Jev request (reason ${String(row.reasonCode)}, codes ${row.jevReasonCodes.join('|')})`);
        assert.equal(row.source, 'jev', `the answer did not come from Jev (reason ${String(row.reasonCode)})`);
        // A call that was asked again can be answered from the decision the cut-short attempt finished late and the engine cached: that record
        // is a CACHE_HIT with no usage of its own, and the request that paid for it was sent during the case (asserted above).
        const cachedAfterRetry = row.attempts > 1 && row.jevReasonCodes.includes('CACHE_HIT');
        assert.ok(typeof row.decisionId === 'string' && (row.usage !== null || cachedAfterRetry), 'the Jev decision left no record with usage');
      } else if (defect) {
        t.diagnostic(`${c.id}: KNOWN DEFECT: ${KNOWN_DEFECTS[c.id]} (decision codes ${row.jevReasonCodes.join('|')})`);
        assert.equal(row.requests, 0, 'the known defect no longer holds (a request was sent): remove it from KNOWN_DEFECTS');
        assert.equal(row.source, 'rules', 'the known defect no longer holds: remove it from KNOWN_DEFECTS');
      } else {
        assert.equal(row.requests, 0, 'a case that cannot reach Jev sent a request');
        assert.equal(row.source, 'rules', 'the answer did not come from rules');
      }
      // Without egress approval the evidence is described by features: no evidence text is in any request of the case.
      for (const entry of since) {
        const state = JSON.parse(entry.body).state ?? {};
        assert.deepEqual((state.untrustedEvidence ?? []).filter((item) => item.text.trim() !== ''), [], 'evidence text was sent without egress approval');
      }
    });
    // Privacy: no request of the case (setup or call) holds the marker, except a documented leak.
    const found = markersIn(since);
    if (Object.hasOwn(KNOWN_LEAKS, c.id)) {
      t.diagnostic(`${c.id}: KNOWN LEAK: ${KNOWN_LEAKS[c.id]} (found at ${found.join(', ')})`);
      guarded(problems, c.id, () => assert.ok(found.length > 0, 'the known leak no longer appears: remove it from KNOWN_LEAKS'));
    } else if (found.length > 0) {
      problems.push(`${c.id}: a request carried ${MARKER} while egress was denied, at ${found.join(', ')}`);
    }
  }
  assert.deepEqual(problems, []);
  assert.equal(pass.box.stopSidecar().code, 0);
});

test('part A cases with source egress approved: every consult asks, the requests are valid and the text now travels', { skip: managedHostSkip(), timeout: 600_000 }, async (t) => {
  const pass = await startPass(t, { egress: 'approved' });
  const results = await runEach(pass, CASES);
  const problems = [];
  for (const { c, row, call } of results) {
    t.diagnostic(describe(`${c.id} (approved)`, row));
    guarded(problems, c.id, () => {
      assert.equal(row.failure, null, String(row.failure));
      assertOwnQuestion(c, call);
      if (c.expectAsked && !Object.hasOwn(KNOWN_DEFECTS, c.id)) {
        assert.ok(row.requests >= 1, `no Jev request with egress approved (reason ${String(row.reasonCode)}, codes ${row.jevReasonCodes.join('|')})`);
        assert.equal(row.source, 'jev', `not answered by Jev with egress approved (reason ${String(row.reasonCode)})`);
        // The marker in the case's free text reaches the request now: the denied run's silence was the withholding, not a vacuous marker.
        assert.ok(markersIn(call).length > 0, `no request carried ${MARKER}: the text did not travel with egress approved`);
      } else if (Object.hasOwn(KNOWN_DEFECTS, c.id)) {
        assert.equal(row.requests, 0, 'the known defect no longer holds (a request was sent): remove it from KNOWN_DEFECTS');
      } else {
        assert.equal(row.requests, 0, 'a case that cannot reach Jev sent a request');
      }
    });
  }
  assert.deepEqual(problems, []);
  assert.equal(pass.box.stopSidecar().code, 0);
});

// ------------------------------------------------------------------ the owned-worker case

/** Runs an owned case: its plan, a wait until the scripted workers have finished, then the call. */
async function runOwned(pass, c) {
  const { stub, box, work, sidecar } = pass;
  const begin = stub.requests().length;
  for (const step of c.steps) {
    // A plan submission is never asked twice (it records its tasks: a repeat answers DUPLICATE_TASK), so this is one attempt.
    const answer = await askSidecar(sidecar, { home: box.home, op: step.op, scope: step.scope, workspace: work, body: step.body, timeoutMs: 60_000 });
    assert.equal(answer.ok, true, `${c.id}: ${step.op}: ${JSON.stringify(answer)}`);
    assert.equal(answer.result.accepted, true, `${c.id}: ${step.op} was not accepted: ${JSON.stringify(answer.result)}`);
  }
  const until = Date.now() + 60_000;
  for (const { taskId, state } of c.waitFor) {
    for (;;) {
      const read = await askSidecar(sidecar, { home: box.home, op: 'task.get', scope: 'mcp', workspace: work, body: { taskId }, timeoutMs: 20_000 });
      const now = read.ok ? read.result?.task?.state : read.reasonCode;
      if (now === state) break;
      if (['failed', 'blocked', 'cancelled'].includes(now)) {
        const { jevrisPaths } = await import('@jevris/platform');
        const log = readFileSync(join(jevrisPaths({ home: box.home }).state, 'logs', 'sidecar.log'), 'utf8').split('\n').slice(-30).join('\n');
        assert.fail(`${c.id}: ${taskId} did not reach ${state}, it is ${String(now)}: ${JSON.stringify(read.result)}\n${log}`);
      }
      assert.ok(Date.now() < until, `${c.id}: ${taskId} did not reach ${state}, it is ${String(now)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const [item] = await runEach(pass, [{ ...c, steps: [] }]);
  return { ...item, since: stub.requests().slice(begin) };
}

for (const egress of ['denied', 'approved']) {
  test(`C28 reaches Jev when two owned tasks are active, with scripted workers, and only with egress approved (egress ${egress})`, { skip: managedHostSkip(), timeout: 600_000 }, async (t) => {
    for (const c of OWNED_CASES) {
      const pass = await startPass(t, { egress, workerRuns: c.workerRuns });
      const { row, since, call } = await runOwned(pass, c);
      t.diagnostic(describe(`${c.id} (${egress})`, row));
      assert.equal(row.failure, null, String(row.failure));
      if (egress === 'denied') {
        // The question is about the two tasks' titles and paths, which the packet builder would withhold: it is not asked, and nothing is decided.
        assert.equal(row.requests, 0, `${c.id}: a question about workspace text was sent while egress was denied`);
        assert.equal(row.source, 'rules', `${c.id}: the rules did not answer`);
        assert.equal(row.decisionId, null, `${c.id}: a decision was built for a question that is not asked`);
        assert.deepEqual(markersIn(since), [], `${c.id}: a request carried ${MARKER} while egress was denied`);
      } else {
        assertOwnQuestion(c, call);
        assert.ok(row.requests >= 1, `${c.id}: the call sent no Jev request (reason ${String(row.reasonCode)}, codes ${row.jevReasonCodes.join('|')}, summary ${String(row.verb)})`);
        assert.equal(row.source, 'jev', `${c.id}: not answered by Jev`);
        assert.ok(markersIn(call).length > 0, `${c.id}: no request carried ${MARKER} with egress approved`);
      }
      assert.equal(pass.box.stopSidecar().code, 0);
    }
  });
}

// ------------------------------------------------------------------ probes beyond the cases

const SKILL = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`;
const AGENT = (name, description, tools) => `---\nname: ${name}\ndescription: ${description}\n${tools === null ? '' : `tools: ${tools}\n`}---\n\nBody.\n`;

/** Rewrites one file of a probe workspace (the sidecar reads the working tree). */
function put(root, rel, text) {
  const file = join(root, ...rel.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/**
 * One `capability.advise` call at `workspace`: the answer, the requests it sent and how many times it was asked. A call the
 * sidecar cuts short (DEADLINE on a slow host) is asked again, up to `attempts` times; `sent` covers every attempt.
 */
async function adviseAt({ stub, box, sidecar }, workspace, body, { attempts = DEADLINE_ATTEMPTS } = {}) {
  const before = stub.requests().length;
  const { answer, attempts: asked } = await askSidecarCounted(sidecar, { home: box.home, op: 'capability.advise', scope: 'mcp', workspace, body, timeoutMs: 20_000 }, { attempts });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  return { advice: answer.result, sent: stub.requests().slice(before), asked };
}

/**
 * A consult that asks once per call sent one request, or, when the sidecar cut an attempt short, at least one and at most one
 * per attempt (a cut-short attempt may have sent its request before it was abandoned, and its answer is not kept). With a single
 * attempt this is exactly one.
 */
function assertAskedOnce(sent, asked, label) {
  assert.ok(sent.length >= 1 && sent.length <= asked, `${label}: ${String(sent.length)} request(s) in ${String(asked)} attempt(s), expected one per attempt at most and at least one`);
}

/** The wire key the conformance mock would pick for a request body (the mock is a pure function of the question). */
async function mockWinner(mock, entry) {
  const response = await mock('https://api.typesafe.ai/v1/systemone', { method: 'POST', headers: { authorization: 'Bearer probe' }, body: entry.body });
  return (await response.json()).answers.q.choice;
}

// Handlers accept ids with a dot, a colon or a leading digit (a skill, agent or tool name), and the
// question contract does not allow them as option keys. A consult sends such an option under a safe
// key (option_<n>) and maps the answer back to the real id; a Choice question with fewer than two
// options is not asked at all. These consults carry workspace or caller text, so egress is approved.
test('probe: an id the question contract refuses is sent under a safe key and mapped back; a single option is not asked', { skip: managedHostSkip(), timeout: 600_000 }, async (t) => {
  const pass = await startPass(t, { egress: 'approved' });
  const { box } = pass;
  const { createMockFetch } = await import('@jevris/provider-typesafe');
  const mock = createMockFetch();
  const one = join(box.dir, 'ws-one');
  writeWorkspace(one, { '.claude/agents/solo.md': AGENT('solo', 'The only agent', 'Read, Grep') });
  const probe = join(box.dir, 'ws-probe');
  writeWorkspace(probe, {
    '.claude/skills/dotted/SKILL.md': SKILL('casea.dotted:probe', 'Zebra quokka probe skill'),
    '.claude/skills/plain/SKILL.md': SKILL('casea-plainskill', 'Zebra quokka plain skill'),
    '.claude/agents/dotted.md': AGENT('casea.agent:probe', 'Probe agent for exploring', 'Read, Grep, Glob'),
    '.claude/agents/plain.md': AGENT('casea-plain', 'Plain agent for exploring', 'Read, Grep, Glob'),
  });
  const wireKeys = (entry) => Object.keys(Object.values(JSON.parse(entry.body).questions)[0].criteria);

  // One eligible agent: one option, so nothing is asked, no decision is built, and rules answer.
  const solo = await adviseAt(pass, one, { capabilityId: 'C26', input: { phase: 'reviewer' } });
  t.diagnostic(`C26 with one eligible agent: requests=${String(solo.sent.length)} source=${String(solo.advice.source)} reason=${String(solo.advice.reasonCode)} decisionId=${String(solo.advice.decisionId)}`);
  assert.equal(solo.sent.length, 0, 'a one-option question was sent');
  assert.equal(solo.advice.source, 'rules');
  assert.equal(solo.advice.decisionId, null, 'a decision was built for a question with one option');

  // C33: the whole list is asked, every wire key matches the contract, and a win by the safe key maps back to the dotted id.
  let mapped = 0;
  for (let attempt = 0; attempt < 24 && mapped === 0; attempt += 1) {
    // The option text is part of the question, so a new description is a new question and the mock may pick another winner.
    put(probe, '.claude/skills/dotted/SKILL.md', SKILL('casea.dotted:probe', `Zebra quokka probe skill, revision ${String(attempt)}`));
    const { advice, sent, asked } = await adviseAt(pass, probe, { capabilityId: 'C33', input: { intent: 'zebra quokka' } });
    assertAskedOnce(sent, asked, 'the shortlist was not asked once');
    // Every request that was sent is checked, not only the last attempt's.
    for (const entry of sent) {
      assertJevRequest(entry, 'C33 with a dotted skill');
      const keys = wireKeys(entry);
      assert.equal(keys.length, 3, `the whole list was not asked: ${keys.join(', ')}`);
      assert.ok(keys.includes('none') && keys.includes('casea-plainskill'), `the plain options changed their keys: ${keys.join(', ')}`);
      assert.equal(keys.filter((key) => key.startsWith('option_')).length, 1, `the dotted skill is not under a safe key: ${keys.join(', ')}`);
    }
    const winner = await mockWinner(mock, sent[0]);
    const expected = winner.startsWith('option_') ? 'casea.dotted:probe' : winner;
    assert.equal(advice.source, 'jev');
    assert.equal(advice.recommendation, expected, `the answer ${winner} did not map back to ${expected}`);
    assert.deepEqual(advice.ranked.map((r) => r.id).sort(), ['casea-plainskill', 'casea.dotted:probe', 'none'], 'the ranking shows a safe key instead of the real id');
    if (winner.startsWith('option_')) mapped += 1;
  }
  t.diagnostic(`C33 mapped a win by the safe key back to the dotted skill: ${String(mapped)} time(s)`);
  assert.equal(mapped, 1, 'no attempt had the mock choose the safe key, so the mapping back was never exercised');

  // C26: both agents are asked, the dotted one under a safe key; the answer is a real agent name.
  const agents = await adviseAt(pass, probe, { capabilityId: 'C26', input: { phase: 'explorer' } });
  assertAskedOnce(agents.sent, agents.asked, 'the agents were not asked once');
  for (const entry of agents.sent) {
    assertJevRequest(entry, 'C26 with a dotted agent');
    const agentKeys = wireKeys(entry);
    assert.deepEqual(agentKeys.filter((key) => !key.startsWith('option_')), ['casea-plain'], `wire keys ${agentKeys.join(', ')}`);
    assert.equal(agentKeys.length, 2);
  }
  const agentWinner = await mockWinner(mock, agents.sent[0]);
  assert.equal(agents.advice.recommendation, agentWinner.startsWith('option_') ? 'casea.agent:probe' : agentWinner);

  // C36: the same for tools.
  const tools = await adviseAt(pass, probe, { capabilityId: 'C36', input: { intent: 'read the file', allowlist: ['mcp.read:file', 'casea-read'], tools: [{ id: 'mcp.read:file', description: 'Read a file' }, { id: 'casea-read', description: 'Read one file' }] } });
  assertAskedOnce(tools.sent, tools.asked, 'the tools were not asked once');
  for (const entry of tools.sent) {
    assertJevRequest(entry, 'C36 with a dotted tool');
    const toolKeys = wireKeys(entry);
    assert.deepEqual(toolKeys.filter((key) => !key.startsWith('option_')).sort(), ['casea-read', 'none'], `wire keys ${toolKeys.join(', ')}`);
    assert.equal(toolKeys.length, 3);
  }
  const toolWinner = await mockWinner(mock, tools.sent[0]);
  assert.equal(tools.advice.recommendation, toolWinner.startsWith('option_') ? 'mcp.read:file' : toolWinner);
  assert.equal(pass.box.stopSidecar().code, 0);
});

// A consult in a loop (C34 asks once per candidate span) stops asking when the time left runs short:
// with a Jev that answers in 700 ms and ten candidate files, the whole call used to run past the
// op's five-second budget and answer DEADLINE, with no advice at all. The assertion is on the outcome
// (the op answered, from fewer requests than candidates), not on how long it took.
test('probe: C34 with a slow Jev stops asking when time is short and still answers', { skip: managedHostSkip(), timeout: 600_000 }, async (t) => {
  // The op's own five-second budget is the subject, so this pass keeps it exactly (test/budget-scale.mjs). The question is about the span text, so it is
  // asked only with egress approved.
  const pass = await startPass(t, { egress: 'approved', stubOptions: { scenario: 'late', lateMs: 700 }, exactBudgets: true });
  const slow = join(pass.box.dir, 'ws-slow');
  const files = {};
  for (let i = 0; i < 10; i += 1) files[`src/retry${String(i)}.ts`] = `export function retryBackoff${String(i)}() { return ${String(i)}; } // retry backoff payment client\n`;
  writeWorkspace(slow, files);
  // The subject is the deadline (the loop stops asking when time is short and the op still answers), so this is one attempt.
  const { advice, sent } = await adviseAt(pass, slow, { capabilityId: 'C34', input: { query: 'retry backoff payment client' } }, { attempts: 1 });
  t.diagnostic(`C34 with a 700 ms Jev and ten candidates: requests=${String(sent.length)} source=${String(advice.source)} ranked=${String(advice.ranked.length)}`);
  assert.ok(sent.length >= 1, 'no span was asked');
  assert.ok(sent.length < 8, `every candidate was asked (${String(sent.length)} requests): the loop did not stop when time ran short`);
  assert.ok(advice.ranked.length >= 1, 'the answer ranked nothing');
  for (const entry of sent) assertJevRequest(entry, 'C34 slow');
  assert.equal(pass.box.stopSidecar().code, 0);
});

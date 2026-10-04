import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sandbox } from '../../../test/acceptance/lib.mjs';
import { startJevStub } from '../../../test/acceptance/jev-stub.mjs';
import { managedHostSkip } from '../../../test/managed-host.mjs';
import { MARKER, runCases, writeWorkspace } from '../scripts/jev-feature-driver.mjs';
import { CASES, FILES, KNOWN_DEFECTS, KNOWN_LEAKS, LAB, LAB_HANDLE, LEAK_FIELDS, PATH_MARK, WORKSPACE_TEXT, preparePart, wrapSidecar } from '../scripts/jev-feature-cases-c.mjs';

// The offline proof of the part C capability cases (research, memory and loop advice): each case's
// setup and call, run against a real sidecar in a sandbox whose Jev is the conformance stub, makes the
// handler send the request the case says it sends; every request is a valid Jev request; and with
// source egress denied (or only a user preference approving it) no request carries the free text or
// the file names the cases plant. No live Jev call, no key, no network beyond loopback.
//
// The sandbox is prepared the way the live script prepares it: the workspace is written into a folder
// that does not exist yet (`writeWorkspace`), then `preparePart` writes the host policy and, for
// approved egress, the user preference; the sidecar client is `wrapSidecar(sidecar)`.

const sidecar = await import('../dist/index.js');
const { resolveSourceEgress } = await import('../dist/egress-guard.js');
const orchestrator = await import('@jevris/orchestrator');
const core = await import('@jevris/core');
const contracts = await import('@jevris/contracts');
const { jevrisPaths } = await import('@jevris/platform');

const skip = managedHostSkip();

/** The capabilities this part covers: every one needs a case. */
const ASSIGNED = ['C18', 'C19', 'C20', 'C21', 'C22', 'C23', 'C24', 'C29', 'C32', 'C40', 'C62', 'C65', 'C66', 'C67', 'C68', 'C69', 'C70', 'C71', 'C72'];

/** Whether a stub request (or any text) carries a marker of this part. */
const marked = (text) => text.includes(MARKER) || text.includes(PATH_MARK);

/** The JSON pointers of every key or text in `value` that carries a marker. */
function markedPointers(value, at = '') {
  if (typeof value === 'string') return marked(value) ? [at] : [];
  if (value === null || typeof value !== 'object') return [];
  const out = [];
  for (const [key, child] of Object.entries(value)) {
    const pointer = `${at}/${key}`;
    if (marked(key)) out.push(pointer);
    out.push(...markedPointers(child, pointer));
  }
  return out;
}

// ------------------------------------------------------------------------------ request validity

/** The questions of a Jev request: at most 12, each a choice, a score or a noul of the documented shape. */
function assertQuestions(questions, label) {
  assert.equal(questions !== null && typeof questions === 'object' && !Array.isArray(questions), true, `${label}: questions is not an object`);
  const ids = Object.keys(questions);
  assert.ok(ids.length >= 1 && ids.length <= contracts.MAX_QUESTIONS && ids.length <= 12, `${label}: ${ids.length} questions`);
  for (const id of ids) {
    const q = questions[id];
    assert.equal(typeof q.instructions, 'string', `${label}/${id}: no instructions`);
    if (q.type === 'choice') {
      assert.equal(q.criteria !== null && typeof q.criteria === 'object' && !Array.isArray(q.criteria), true, `${label}/${id}: choice criteria is not an object`);
      assert.ok(Object.keys(q.criteria).length >= 2, `${label}/${id}: a choice needs at least two criteria`);
      for (const text of Object.values(q.criteria)) assert.equal(typeof text, 'string', `${label}/${id}: a criterion is not text`);
    } else if (q.type === 'score') {
      assert.equal(Array.isArray(q.criteria), true, `${label}/${id}: score criteria is not a list`);
      assert.ok(q.criteria.length >= 2 && q.criteria.length <= 10, `${label}/${id}: ${q.criteria.length} score anchors`);
      for (const text of q.criteria) assert.equal(typeof text, 'string', `${label}/${id}: an anchor is not text`);
    } else {
      assert.equal(q.type, 'noul', `${label}/${id}: unknown question type ${String(q.type)}`);
      assert.deepEqual(Object.keys(q.criteria ?? {}).sort(), ['false', 'true'], `${label}/${id}: noul criteria`);
    }
  }
}

/** One request the stub received: a POST to the Jev route with a valid body. */
function assertValidRequest(entry, label) {
  assert.equal(entry.method, 'POST', `${label}: method`);
  assert.equal(entry.path, '/v1/systemone', `${label}: path`);
  const wire = JSON.parse(entry.body);
  assert.equal(wire.model, 'jev-1.13.0', `${label}: model`);
  assert.equal(wire.state !== null && typeof wire.state === 'object' && typeof wire.state.objective === 'string', true, `${label}: no state`);
  assertQuestions(wire.questions, label);
}

// ------------------------------------------------------------------------------- sandbox and passes

/** The user preference `privacy.sourceEgress: approved-scoped` alone, as a person could hand-edit it (host policy still denies). */
function writePreferenceOnly(home) {
  const file = orchestrator.configFilePath({ home });
  const config = orchestrator.readEffectiveConfig({ home }).config;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...config, privacy: { ...config.privacy, sourceEgress: 'approved-scoped' } }, null, 2)}\n`, { mode: 0o600 });
}

/**
 * A sandbox with this part's workspace committed (in a folder that does not exist yet), the stub as Jev
 * and a running sidecar. `egress` is what `preparePart` is given; `preference` adds the user preference
 * with host policy still denying (two separate switches: the engine's transport guard reads host policy,
 * the checkpoint op reads the preference).
 */
async function startBox(t, { egress, preference = false }) {
  const stub = await startJevStub(t, { scenario: 'confident' });
  const box = await sandbox(t, { env: stub.env });
  const work = join(box.dir, 'case-c-work');
  writeWorkspace(work, FILES);
  const prepared = await preparePart({ home: box.home, work, egress, mode: 'advise' });
  assert.equal(prepared.preference, egress === 'approved');
  if (preference) writePreferenceOnly(box.home);
  const started = box.startSidecar();
  assert.equal(started.code, 0, `the sidecar did not start: ${started.stderr}`);
  const ping = await sidecar.sidecarRequest({ home: box.home, op: 'ping', scope: 'cli', workspace: work, body: {}, timeoutMs: 30_000 });
  assert.equal(ping.ok, true, 'the sidecar does not answer');
  return { stub, box, work };
}

/** Runs the cases one at a time; each result keeps the requests the stub saw during that case. */
async function runPass({ stub, box, work }, cases) {
  const lookup = async (decisionId) => (await sidecar.sidecarRequest({ home: box.home, op: 'decision.get', scope: 'cli', workspace: work, body: { decisionId }, timeoutMs: 30_000 })).result?.record ?? null;
  const client = wrapSidecar(sidecar);
  const results = [];
  for (const c of cases) {
    const before = stub.requests().length;
    const [row] = await runCases({ sidecar: client, home: box.home, work, cases: [c], requestCount: () => stub.requests().length, lookup });
    results.push({ c, row, sent: stub.requests().slice(before) });
  }
  return results;
}

/** What a case does in a pass: stays quiet, is refused by the question lint, or asks Jev. */
function expectation(c, mode) {
  if (!c.expectAsked) return 'quiet';
  if (c.egressNeeded && mode === 'denied') return 'quiet';
  if (c.egressNeeded && c.egressVia === 'host' && mode === 'preference-only') return 'quiet';
  if (Object.hasOwn(KNOWN_DEFECTS, c.id)) return 'refused-by-lint';
  return 'asked';
}

function checkPass(t, results, mode) {
  for (const { c, row, sent } of results) {
    assert.equal(row.failure, null, `${c.id}: ${row.failure}`);
    assert.equal(row.ok, true, `${c.id}: the op did not answer ok`);
    for (const entry of sent) assertValidRequest(entry, c.id);

    const what = expectation(c, mode);
    t.diagnostic(`${mode} ${c.id}: ${what}, requests ${row.requests} (all ${sent.length}), source ${String(row.source)}, decision codes ${row.jevReasonCodes.join('+') || '-'}`);
    if (what === 'quiet') {
      assert.equal(row.requests, 0, `${c.id}: asked Jev (${mode}) but should stay rules-only`);
      assert.equal(sent.length, 0, `${c.id}: a setup step asked Jev (${mode})`);
      assert.notEqual(row.source, 'jev', `${c.id}: answered from Jev without a request`);
      if (c.noDecision === true) assert.equal(row.decisionId, null, `${c.id}: a decision was built for a question that is not asked`);
    } else if (what === 'refused-by-lint') {
      const defect = KNOWN_DEFECTS[c.id];
      assert.equal(row.requests, 0, `${c.id}: the defect is fixed (a request was sent); delete KNOWN_DEFECTS.${c.id}`);
      for (const code of defect.codes) assert.ok(row.jevReasonCodes.includes(code), `${c.id}: the decision record lacks ${code} (${row.jevReasonCodes.join(', ')}); update or delete KNOWN_DEFECTS.${c.id}`);
      assert.equal(row.source, 'rules', `${c.id}: a refused question answered from ${String(row.source)}`);
    } else {
      assert.ok(row.requests >= 1, `${c.id}: no Jev request was sent (${mode}); source ${String(row.source)}, decision codes ${row.jevReasonCodes.join(', ')}`);
      if (row.source !== null) assert.equal(row.source, 'jev', `${c.id}: answered from ${row.source}`);
      assert.equal(typeof row.decisionId, 'string', `${c.id}: no decision id`);
      assert.ok(row.jevReasonCodes.includes('DECISION_ADVISORY'), `${c.id}: the decision was not answered by Jev (${row.jevReasonCodes.join(', ')})`);
    }

    const pointers = sent.flatMap((entry) => markedPointers(JSON.parse(entry.body)));
    if (mode === 'approved') {
      // With egress approved the planted text may travel, but only as evidence, or in the one question field a
      // case declares (the module paths of C70).
      const carrier = WORKSPACE_TEXT[c.id];
      for (const pointer of pointers) assert.ok(pointer.startsWith('/state/untrustedEvidence') || (carrier !== undefined && pointer.startsWith(carrier)), `${c.id}: planted text is in ${pointer}, which is neither evidence nor a declared field`);
      if (carrier !== undefined && what === 'asked') assert.ok(pointers.some((pointer) => pointer.startsWith(carrier)), `${c.id}: the declared carrier ${carrier} holds no workspace text`);
    } else if (Object.hasOwn(KNOWN_LEAKS, c.id) && c.unreachable !== true) {
      // The privacy audit with a known exemption: the leak stays where it is documented, and nowhere else.
      t.diagnostic(`KNOWN LEAK ${c.id} at ${[...new Set(pointers)].join(', ')}: ${KNOWN_LEAKS[c.id]}`);
      assert.equal(pointers.length > 0, what === 'asked', `${c.id}: the known leak ${pointers.length > 0 ? 'appears where it should not' : 'is gone; delete KNOWN_LEAKS.' + c.id}`);
      for (const pointer of pointers) assert.ok(pointer.startsWith(LEAK_FIELDS[c.id]), `${c.id}: a marker is in ${pointer}, outside the known leak ${LEAK_FIELDS[c.id]}`);
    } else {
      // The privacy audit: while the host does not approve egress no marker may be in any request.
      assert.deepEqual(pointers, [], `${c.id}: a request carries planted text or a path while source egress is not approved (${mode})`);
    }
  }
}

async function finish(box, work) {
  assert.equal(box.stopSidecar().code, 0, 'the sidecar did not stop');
  const after = await sidecar.sidecarRequest({ home: box.home, op: 'ping', scope: 'cli', workspace: work, body: {}, timeoutMs: 5_000 });
  assert.equal(after.ok, false, 'a sidecar still answers after it was stopped');
}

// --------------------------------------------------------------------------------------- tests

test('the case table covers every assigned capability once or more, with a site and a known call', () => {
  const ids = CASES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'case ids are not unique');
  const covered = new Set(CASES.map((c) => c.capability));
  for (const id of ASSIGNED) assert.ok(covered.has(id), `${id} has no case`);
  for (const c of CASES) {
    assert.match(c.site, /^packages\/orchestrator\/src\/[\w./-]+:\d+/, `${c.id}: site`);
    assert.equal(typeof c.title, 'string');
    assert.equal(typeof c.notes, 'string');
    assert.equal(Array.isArray(c.steps), true, `${c.id}: steps`);
    assert.equal(typeof c.call.op, 'string', `${c.id}: call`);
    assert.equal(c.expectAsked === true || c.expectAsked === false, true, `${c.id}: expectAsked`);
    if (c.unreachable === true) assert.equal(c.expectAsked, false, `${c.id}: an unreachable consult cannot be expected to ask`);
    if (c.egressNeeded === true) assert.ok(c.egressVia === 'host' || c.egressVia === 'preference', `${c.id}: egressNeeded names which switch opens it`);
    for (const step of c.steps) assert.equal(step.files !== undefined || typeof step.op === 'string', true, `${c.id}: a step is neither files nor an op`);
  }
  for (const id of [...Object.keys(KNOWN_DEFECTS), ...Object.keys(KNOWN_LEAKS), ...Object.keys(WORKSPACE_TEXT)]) assert.ok(ids.includes(id), `a finding names an unknown case ${id}`);
  for (const text of Object.values(FILES)) assert.equal(marked(text), false, 'a workspace file holds a marker, which other parts could read');
});

test('preparePart writes the host policy and, for approved egress, the user preference, inside the given home only', { skip }, async (t) => {
  for (const egress of ['denied', 'approved']) {
    const box = await sandbox(t, {});
    const work = join(box.dir, 'case-c-work');
    writeWorkspace(work, FILES);
    const prepared = await preparePart({ home: box.home, work, egress, mode: 'advise' });
    const config = jevrisPaths({ home: box.home }).config;
    const host = JSON.parse(readFileSync(join(config, 'host.json'), 'utf8'));
    assert.equal(host.egress, egress === 'approved' ? 'approved-scoped' : 'deny-until-approved');
    assert.equal(host.mode, 'advise');
    assert.equal(prepared.preference, egress === 'approved');
    assert.equal(orchestrator.readEffectiveConfig({ home: box.home }).config.privacy.sourceEgress, egress === 'approved' ? 'approved-scoped' : 'deny-until-approved');
    assert.equal(resolveSourceEgress({ home: box.home }), egress === 'approved' ? 'approved' : 'not-approved', 'the sidecar guard disagrees with the host policy file');
    if (process.platform !== 'win32') assert.equal(statSync(join(config, 'host.json')).mode & 0o077, 0, 'the host policy file is not owner-only');
    assert.equal(statSync(work).isDirectory(), true);
  }
  await assert.rejects(preparePart({ home: '/nowhere', work: '/nowhere', egress: 'maybe', mode: 'advise' }), /egress must be denied or approved/);
});

test('with source egress denied every case reaches Jev or stays quiet as documented, and no request carries planted text (egress denied)', { skip }, async (t) => {
  const running = await startBox(t, { egress: 'denied' });
  const { box, work } = running;
  const results = await runPass(running, CASES);
  checkPass(t, results, 'denied');
  const asked = results.filter(({ row }) => row.requests >= 1).map(({ c }) => c.id);
  t.diagnostic(`asked Jev: ${asked.join(', ')}`);
  // The consults the product answers itself while egress is denied: C18 (needs the preference) and C70 (workspace paths in the question).
  for (const id of ['C18-capsule', 'C70']) assert.equal(asked.includes(id), false, `${id} asked while egress is denied`);
  // C69 cites the report the C71 step stores: the handle this file recomputes is the one the sidecar answers with.
  const lab = await sidecar.sidecarRequest({ home: box.home, op: 'capability.advise', scope: 'mcp', workspace: work, body: { capabilityId: 'C71', input: LAB }, timeoutMs: 30_000 });
  assert.equal(lab.ok, true);
  assert.ok(lab.result.evidenceIds.includes(LAB_HANDLE), 'the C71 report is not stored under the handle the C69 case cites');
  // The state the cases leave: nothing of this part is uncommitted.
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: work, encoding: 'utf8', windowsHide: true });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.stdout.includes('caseC'), false, `this part left uncommitted changes: ${status.stdout}`);
  await finish(box, work);
});

test('with host policy and the user preference approving egress every asking case sends a valid request (egress approved)', { skip }, async (t) => {
  const running = await startBox(t, { egress: 'approved' });
  const { box, stub, work } = running;
  const results = await runPass(running, CASES);
  checkPass(t, results, 'approved');
  const asked = results.filter(({ row }) => row.requests >= 1).map(({ c }) => c.id);
  t.diagnostic(`asked Jev: ${asked.join(', ')}`);
  // Every case that expects to ask did, including the capsule and the canary choice that need egress.
  for (const { c, row } of results) if (c.expectAsked) assert.ok(row.requests >= 1, `${c.id}: did not ask with egress approved`);
  // The evidence the cases plant now travels, as approved: the capsule item, the failure text, a finding, the module paths.
  const bodies = new Map(results.map(({ c, sent }) => [c.id, sent.map((entry) => entry.body).join('\n')]));
  for (const id of ['C18-capsule', 'C29', 'C40', 'C67']) assert.ok(marked(bodies.get(id) ?? ''), `${id}: approved evidence did not reach the request`);
  assert.ok((bodies.get('C70') ?? '').includes(PATH_MARK), 'C70: the module path did not reach the request');
  assert.ok(stub.requests().length > 0);
  await finish(box, work);
});

test('with only the user preference approving egress, the capsule asks with its text withheld and the canary choice stays quiet (host policy denies)', { skip }, async (t) => {
  const running = await startBox(t, { egress: 'denied', preference: true });
  const { box, work } = running;
  const wanted = CASES.filter((c) => c.egressNeeded === true);
  assert.ok(wanted.length >= 2);
  const results = await runPass(running, wanted);
  checkPass(t, results, 'preference-only');
  for (const { c, row, sent } of results) {
    if (c.egressVia === 'host') {
      assert.equal(row.requests, 0, `${c.id}: asked with the preference alone, but it needs host policy`);
      continue;
    }
    assert.ok(row.requests >= 1, `${c.id}: the preference alone did not open the consult`);
    const wire = JSON.parse(sent[0].body);
    assert.deepEqual(wire.state.untrustedEvidence, [], `${c.id}: evidence text left the machine without host approval`);
    assert.ok(wire.state.withheldEvidence.length >= 1, `${c.id}: the withheld evidence is not described by features`);
  }
  await finish(box, work);
});

// ---------------------------------------------------------------- consult sites no op reaches

/** An engine that records every decide request, answers each question validly and states its source-egress setting. */
function recorder(egress = 'denied') {
  const calls = [];
  return {
    calls,
    engine: {
      sourceEgress: () => egress,
      async decide(request) {
        calls.push(request);
        const q = request.questions.q;
        // Confident answers (the consult floors are confidence 0.6 and a 0.15 margin): the engine always gives a Choice or a Score its confidence.
        const first = Object.keys(q.criteria)[0];
        const answer = q.type === 'choice' ? { choice: first, confidence: 0.9, probabilities: { [first]: 0.9 } } : q.type === 'score' ? { score: 1, confidence: 0.9 } : { noul: 0.9 };
        return { abstained: false, decisionId: `d-recorded-${calls.length}`, result: { answers: { q: answer } } };
      },
    },
  };
}

/**
 * What every decide request of one consult site must satisfy; the question lint result must match the known
 * defects. `workspaceText` names the question field that may hold workspace text (the site is flagged to be
 * asked only with egress approved).
 */
function checkSite(t, id, rec, workspaceText) {
  assert.ok(rec.calls.length >= 1, `${id}: the function asked nothing`);
  const lintErrors = new Set();
  for (const request of rec.calls) {
    assertQuestions(request.questions, id);
    assert.equal(contracts.DecisionSpecContract.validate(request.spec).ok, true, `${id}: the decision spec is invalid`);
    assert.equal(request.spec.questionHash, contracts.questionHash(request.questions), `${id}: the spec does not match its question`);
    for (const error of core.lintQuestions(request.questions).errors) lintErrors.add(error.code);
    // What leaves whatever the egress setting: the question, the objective, the facts and the policy.
    const pointers = markedPointers({ questions: request.questions, objective: request.packet.objective, facts: request.packet.facts, trustedPolicy: request.packet.trustedPolicy });
    if (Object.hasOwn(KNOWN_LEAKS, id)) {
      t.diagnostic(`KNOWN LEAK ${id} at ${[...new Set(pointers)].join(', ')}: ${KNOWN_LEAKS[id]}`);
      assert.ok(pointers.length > 0, `${id}: the known leak is gone; delete KNOWN_LEAKS.${id}`);
      for (const pointer of pointers) assert.ok(pointer.startsWith(LEAK_FIELDS[id]), `${id}: a marker is in ${pointer}, outside the known leak ${LEAK_FIELDS[id]}`);
    } else if (workspaceText !== undefined) {
      assert.ok(pointers.length > 0, `${id}: the declared carrier ${workspaceText} holds no workspace text`);
      for (const pointer of pointers) assert.ok(pointer.startsWith(workspaceText), `${id}: a marker is in ${pointer}, outside ${workspaceText}`);
    } else assert.deepEqual(pointers, [], `${id}: the question, objective or facts carry planted text`);
    // The evidence is where text belongs; with egress denied the packet builder withholds all of it.
    const denied = core.buildPacket(request.packet, core.DEFAULT_PACKET_LIMITS, { sourceEgress: 'denied', salt: 'test-salt' });
    assert.equal(denied.ok, true, `${id}: the packet is refused with egress denied`);
    assert.deepEqual(denied.state.untrustedEvidence, [], `${id}: evidence text stays in the denied packet`);
    assert.equal(marked(JSON.stringify(denied.state)), false, `${id}: the denied packet carries planted text`);
  }
  const known = Object.hasOwn(KNOWN_DEFECTS, id) ? KNOWN_DEFECTS[id].codes : [];
  assert.deepEqual([...lintErrors].sort(), [...known].sort(), `${id}: the question lint result changed; update or delete KNOWN_DEFECTS.${id}`);
  t.diagnostic(`${id}: ${rec.calls.length} request(s), ${rec.calls[0].questions.q.type}, lint ${lintErrors.size === 0 ? 'ok' : [...lintErrors].join('+')}`);
}

test('the consult sites no op reaches (C19 to C24) build valid questions and keep text out of the question and facts', { skip }, async (t) => {
  const box = await sandbox(t, {});
  const work = join(box.dir, 'case-c-work');
  writeWorkspace(work, FILES);
  const ws = orchestrator.openWorkspace({ home: box.home, workspaceRoot: work, platform: process.platform });

  let rec = recorder();
  const readiness = await orchestrator.compactionReadiness(ws, { taskId: null, facts: { capacityTokens: 100_000, outputReservationTokens: 4_000, overheadTokens: 12_000, marginFraction: 0.1 }, usedTokens: 60_000, episodeId: 'episode-ZZMARKER-C19', engine: rec.engine });
  assert.equal(readiness.source, 'jev');
  checkSite(t, 'C19-readiness', rec);

  await orchestrator.declare(ws, null, { objective: 'Keep the totals exact ZZMARKER-C20', decisions: [{ text: 'Store the totals in sqlite ZZMARKER-C20' }] });
  const capsule = await orchestrator.writeCapsule(ws, { taskId: null });
  rec = recorder();
  const audit = await orchestrator.auditOmissions(ws, capsule, { summary: 'The summary keeps nothing of the decisions ZZMARKER-C20', engine: rec.engine, egressApproved: true });
  assert.equal(audit.source, 'jev');
  assert.equal(audit.flagged.length, 1);
  checkSite(t, 'C20-audit', rec);

  // C21: the capsule objectives are the option texts, so the Choice is asked only while the engine's egress is approved.
  await orchestrator.declare(ws, 'T-c21-a', { objective: 'First task objective ZZMARKER-C21' });
  await orchestrator.declare(ws, 'T-c21-b', { objective: 'Second task objective ZZMARKER-C21' });
  await orchestrator.writeCapsule(ws, { taskId: 'T-c21-a' });
  await orchestrator.writeCapsule(ws, { taskId: 'T-c21-b' });
  rec = recorder('denied');
  const withheld = await orchestrator.rehydrate(ws, { taskId: null, engine: rec.engine });
  assert.equal(withheld.found, true);
  assert.equal(withheld.source, 'rules');
  assert.equal(rec.calls.length, 0, 'C21 sent the saved objectives with egress denied');
  rec = recorder('approved');
  const rehydrated = await orchestrator.rehydrate(ws, { taskId: null, engine: rec.engine });
  assert.equal(rehydrated.source, 'jev');
  checkSite(t, 'C21-rehydrate', rec, WORKSPACE_TEXT['C21-rehydrate']);

  rec = recorder();
  const noisy = Array.from({ length: 1500 }, (_, i) => `line ${i} of the noisy output ZZMARKER-C22`).join('\n');
  const view = await orchestrator.distillOutput(ws, { command: 'check', exitCode: 1, stdout: noisy, stderr: '', engine: rec.engine, egressApproved: true });
  assert.equal(view.mode, 'distilled');
  assert.ok(rec.calls.length <= 8, `C22 asked ${rec.calls.length} questions for one output`);
  checkSite(t, 'C22-distill', rec);

  await orchestrator.recordFact(ws, { subject: 'api.timeout-ms', value: '30 ZZMARKER-C23', revision: 'r1', status: 'observed', source: 'test' });
  await orchestrator.recordFact(ws, { subject: 'api.retry-count', value: 'never retry ZZMARKER-C23', revision: 'r1', status: 'observed', source: 'test' });
  rec = recorder();
  const contradictions = await orchestrator.triageContradictions(ws, { engine: rec.engine, semantic: [{ a: 'api.timeout-ms', b: 'api.retry-count' }] });
  assert.equal(contradictions.length, 1);
  checkSite(t, 'C23-facts', rec);

  for (let i = 0; i < 4; i += 1) await orchestrator.admitProjectMemory(ws, { scope: 'org', kind: 'decision', text: `Storage choice ${i} is sqlite ZZMARKER-C24`, revision: 'r1', approvedBy: 'owner' });
  rec = recorder();
  const memory = await orchestrator.retrieveProjectMemory(ws, { scopes: ['org'], query: 'sqlite storage ZZMARKER-C24', limit: 1, engine: rec.engine, egressApproved: true });
  assert.equal(memory.length, 1);
  checkSite(t, 'C24-memory', rec);
});

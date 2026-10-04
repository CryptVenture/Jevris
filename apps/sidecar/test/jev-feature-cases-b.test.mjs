import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandbox } from '../../../test/acceptance/lib.mjs';
import { startJevStub } from '../../../test/acceptance/jev-stub.mjs';
import { managedHostSkip } from '../../../test/managed-host.mjs';
import { MARKER, runCases, writeWorkspace } from '../scripts/jev-feature-driver.mjs';
import { CASES, FILES, KNOWN_DEFECTS, KNOWN_LEAKS, openTaskIds, preparePart, wrapSidecar } from '../scripts/jev-feature-cases-b.mjs';

// The verification and delivery capabilities (C41 to C47, C57 to C61, C64) of the live Jev feature
// suite, proven offline: each case sets up its workspace, makes its one capability.advise call
// against a real sidecar whose Jev is the conformance stub, and must reach its Jev question. While
// source egress is denied no request may carry the marker the cases put in every free-text field;
// with it approved the requests must still be valid. No live call, no key, no network.
// The sandbox is set up through the part's own entry points (`preparePart`, `wrapSidecar`), the ones
// the live script uses, so they are covered here.

const sidecar = await import('../dist/index.js');
const orchestrator = await import('@jevris/orchestrator');
const { resolveSourceEgress } = await import('../dist/egress-guard.js');
const { jevrisPaths } = await import('@jevris/platform');

/** The request caps of the reference policy (SSOT §7): questions and request bytes. */
const MAX_QUESTIONS = 12;
const MAX_REQUEST_BYTES = 131_072;

const OP_TIMEOUT_MS = 60_000;

/**
 * Cases whose request carries the marker once source egress is approved, because their evidence text
 * (a changed path, a requirement, a failure line, a diff, a document) or a fact (C59's package name)
 * goes out then. Denied, none of them may.
 */
const CARRIES_TEXT_WHEN_APPROVED = ['C41', 'C42', 'C43', 'C44', 'C45', 'C47', 'C57', 'C58', 'C59', 'C60', 'C61'];

/** Jev requests each call makes: one per consult, and C43 asks once per patch candidate (it is given two). */
const REQUESTS_PER_CALL = { C43: 2 };

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;

/** Parses one request the stub received and asserts it is a valid Jev request; returns the body. */
function validRequest(id, text) {
  assert.ok(Buffer.byteLength(text) <= MAX_REQUEST_BYTES, `${id}: the request is over the byte cap`);
  const body = JSON.parse(text);
  assert.equal(body.model, 'jev-1.13.0', `${id}: the model is not the pin`);
  assert.ok(isObject(body.questions), `${id}: no questions object`);
  const ids = Object.keys(body.questions);
  assert.ok(ids.length >= 1 && ids.length <= MAX_QUESTIONS, `${id}: ${String(ids.length)} questions`);
  for (const qid of ids) {
    const q = body.questions[qid];
    assert.ok(isObject(q) && nonEmpty(q.instructions), `${id}/${qid}: no instructions`);
    if (q.type === 'choice') {
      assert.ok(isObject(q.criteria), `${id}/${qid}: choice criteria are not an object`);
      const keys = Object.keys(q.criteria);
      assert.ok(keys.length >= 2, `${id}/${qid}: a choice needs at least two options`);
      assert.ok(keys.every((key) => nonEmpty(q.criteria[key])), `${id}/${qid}: an option has no text`);
    } else if (q.type === 'score') {
      assert.ok(Array.isArray(q.criteria) && q.criteria.length >= 2 && q.criteria.length <= 10, `${id}/${qid}: a score needs 2 to 10 anchors`);
      assert.ok(q.criteria.every(nonEmpty), `${id}/${qid}: an anchor has no text`);
    } else if (q.type === 'noul') {
      assert.ok(isObject(q.criteria) && nonEmpty(q.criteria.true) && nonEmpty(q.criteria.false), `${id}/${qid}: a noul needs a true and a false statement`);
    } else {
      assert.fail(`${id}/${qid}: unknown question type ${String(q.type)}`);
    }
  }
  return body;
}

/** The decision records of one capability's spec among the sidecar's recent decisions. */
async function recordsOfSpec(box, specId) {
  const request = { home: box.home, scope: 'cli', workspace: box.work, timeoutMs: OP_TIMEOUT_MS };
  const status = await sidecar.sidecarRequest({ ...request, op: 'status', body: {} });
  assert.equal(status.ok, true, JSON.stringify(status));
  const records = [];
  for (const item of status.result.recentDecisions) {
    const got = await sidecar.sidecarRequest({ ...request, op: 'decision.get', body: { decisionId: item.decisionId } });
    if (got.ok && got.result.record?.specId === specId) records.push(got.result.record);
  }
  return records;
}

/**
 * One pass over every case in a sandbox of its own (temporary home, synthetic git workspace, a
 * real sidecar whose Jev is the stub), set up the way the live script sets a part up: the workspace
 * is written first, then `preparePart` writes the host policy (the only thing that approves source
 * egress, written only inside the sandbox home), then the sidecar starts, and the client is wrapped
 * with `wrapSidecar`.
 */
async function runPass(t, { approved }) {
  const stub = await startJevStub(t, { scenario: 'confident' });
  const box = await sandbox(t, { env: stub.env });
  rmSync(join(box.work, '.git'), { recursive: true, force: true });
  writeWorkspace(box.work, FILES);
  await preparePart({ home: box.home, work: box.work, egress: approved ? 'approved' : 'denied', mode: 'advise' });
  // Another part's approved check, mandatory and never run by these cases: approving this part's
  // checks must keep it, and a readiness report must still be reachable with it in the workspace.
  const ws = orchestrator.openWorkspace({ home: box.home, workspaceRoot: box.work, platform: process.platform });
  const foreign = orchestrator.parseManifest({ id: 'foreign-check', argv: [process.execPath, '-e', '0'], mandatory: true, resultFormat: 'exit-code' });
  assert.equal(foreign.ok, true);
  await orchestrator.approveManifests(ws, [foreign.manifest], { 'foreign-check': foreign.hash }, 'test');
  const started = box.startSidecar();
  assert.equal(started.code, 0, `the sidecar did not start: ${started.stderr}`);
  const client = wrapSidecar(sidecar);
  const lookup = async (decisionId) => {
    const got = await sidecar.sidecarRequest({ home: box.home, op: 'decision.get', scope: 'cli', workspace: box.work, body: { decisionId }, timeoutMs: OP_TIMEOUT_MS });
    return got.ok ? got.result.record : null;
  };
  const results = [];
  for (const c of CASES) {
    const before = stub.requests().length;
    const [row] = await runCases({ sidecar: client, home: box.home, work: box.work, cases: [c], requestCount: () => stub.requests().length, lookup, timeoutMs: OP_TIMEOUT_MS });
    const sent = stub.requests().slice(before);
    const spec = `d-${c.id.toLowerCase()}`;
    // Decisions of the capability's spec: the refusals of a known defect, or (egress denied) the proof
    // that a case which needs egress made no decision at all.
    const wantRecords = Object.hasOwn(KNOWN_DEFECTS, c.id) || (c.egressNeeded && !approved);
    results.push({ c, row, sent, called: sent.slice(sent.length - row.requests), records: wantRecords ? await recordsOfSpec(box, spec) : [] });
  }
  return { box, stub, results, approved: orchestrator.approvedManifests(ws).map((m) => m.id).sort() };
}

function assertPass(t, { results, approved: approvedChecks }, { approved }) {
  const diagnostics = [];
  // Approving this part's checks kept the other part's check and left only the last case's own.
  assert.deepEqual(approvedChecks, ['b-unit-ci', 'foreign-check']);
  for (const { c, row, sent, called, records } of results) {
    const where = `${c.id} (${c.site})`;
    assert.equal(row.failure, null, `${where}: ${String(row.failure)}`);
    assert.equal(row.ok, true, where);
    // Every request that left during the case, setup included, is a valid Jev request.
    const bodies = sent.map((request) => validRequest(c.id, request.body));
    assert.equal(called.length, row.requests, `${where}: the request count of the call`);
    if (sent.length > called.length) diagnostics.push(`${c.id}: ${String(sent.length - called.length)} request(s) left during the setup steps, before the call`);

    if (Object.hasOwn(KNOWN_DEFECTS, c.id)) {
      // The handler reached its consult, and the engine refused the question before any provider call.
      assert.equal(row.requests, 0, `${where}: asked Jev now; delete its KNOWN_DEFECTS entry`);
      assert.equal(row.source, 'rules', where);
      assert.ok(records.length >= 1, `${where}: the handler never reached its consult (no decision of spec d-${c.id.toLowerCase()})`);
      for (const record of records) {
        assert.equal(record.outcome, 'refused', `${where}: ${record.outcome}`);
        assert.deepEqual(record.reasonCodes, KNOWN_DEFECTS[c.id].codes, `${where}: refused for ${record.reasonCodes.join(',')}; update its KNOWN_DEFECTS entry`);
        assert.equal(record.providerCalls, 0, where);
      }
      diagnostics.push(`${c.id} not asked, refused as ${KNOWN_DEFECTS[c.id].codes.join(' ')}: ${KNOWN_DEFECTS[c.id].detail}`);
    } else if (c.egressNeeded && !approved) {
      // The question carries workspace text, so it is not asked while egress is denied: no request, no
      // decision, the rules answer.
      assert.equal(row.requests, 0, `${where}: a request left while egress was denied`);
      assert.equal(row.source, 'rules', where);
      assert.deepEqual(records, [], `${where}: a decision was made while egress was denied`);
      assert.equal(sent.length, 0, `${where}: a request left during the case while egress was denied`);
    } else if (c.expectAsked) {
      const expected = REQUESTS_PER_CALL[c.id] ?? 1;
      assert.equal(row.requests, expected, `${where}: ${String(row.requests)} Jev requests left during the call, expected ${String(expected)} (reason ${String(row.reasonCode)})`);
      assert.equal(row.source, 'jev', `${where}: answered by ${String(row.source)} (reason ${String(row.reasonCode)})`);
      assert.match(String(row.reasonCode), /^JEV_(CHOICE|SCORE|NOUL)$/, where);
      assert.equal(typeof row.decisionId, 'string', where);
      assert.ok(row.usage !== null && row.usage.inputTokens > 0, `${where}: the decision record holds no usage`);
    } else {
      assert.equal(row.requests, 0, `${where}: asked Jev although it is not expected to`);
    }

    if (!approved) {
      // Source egress denied: the packet carries structured features only, and no marker travels.
      for (const body of bodies) assert.deepEqual(body.state.untrustedEvidence, [], `${where}: evidence text left while egress is denied`);
      // C59 asks without the package name: the facts hold the versions, the bump and counts only.
      if (c.id === 'C59') for (const body of bodies) assert.equal(Object.hasOwn(body.state.facts, 'package'), false, `${where}: the package name left while egress was denied`);
      const leaks = sent.filter((request) => request.body.includes(MARKER));
      if (Object.hasOwn(KNOWN_LEAKS, c.id)) {
        assert.ok(leaks.length >= 1, `${where}: no longer leaks the marker; delete its KNOWN_LEAKS entry`);
        diagnostics.push(`${c.id} leaks the marker with egress denied: ${KNOWN_LEAKS[c.id]}`);
      } else {
        assert.equal(leaks.length, 0, `${where}: a request carried the marker while egress was denied`);
      }
    } else if (CARRIES_TEXT_WHEN_APPROVED.includes(c.id)) {
      assert.ok(called.some((request) => request.body.includes(`${MARKER}-${c.id}`)), `${where}: the approved request does not carry the case marker`);
    }
  }
  for (const line of diagnostics) t.diagnostic(line);
}

test('the case list is well formed and the known findings name real cases', () => {
  const ids = CASES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate case ids');
  assert.deepEqual(ids, ['C41', 'C42', 'C43', 'C44', 'C45', 'C46', 'C47', 'C57', 'C58', 'C59', 'C60', 'C61', 'C64']);
  for (const c of CASES) {
    assert.match(c.site, /^packages\/orchestrator\/src\/capabilities\/(verification|delivery)\.ts:\d+$/, c.id);
    assert.equal(c.call.op, 'capability.advise', c.id);
    assert.equal(c.call.body.capabilityId, c.id);
    assert.ok(['cli', 'mcp', 'hook'].includes(c.call.scope), c.id);
    assert.equal(typeof c.expectAsked, 'boolean', c.id);
    assert.equal(typeof c.egressNeeded, 'boolean', c.id);
    assert.ok(c.notes.length > 40, `${c.id}: say why the input reaches Jev`);
  }
  assert.deepEqual(CASES.filter((c) => c.egressNeeded).map((c) => c.id), ['C42'], 'only C42 asks nothing without egress');
  for (const known of [KNOWN_LEAKS, KNOWN_DEFECTS]) for (const id of Object.keys(known)) assert.ok(ids.includes(id), `${id} is not a case`);
  for (const id of CARRIES_TEXT_WHEN_APPROVED) assert.ok(ids.includes(id), `${id} is not a case`);
  for (const path of Object.keys(FILES)) assert.ok(path.startsWith('caseB/'), `${path} is outside the part's folder`);
  // Every marker field is case-specific, so a leak names its case.
  const text = JSON.stringify({ FILES, CASES });
  for (const id of ids) if (id !== 'C46') assert.ok(text.includes(`${MARKER}-${id}`), `${id}: no case-specific marker`);
});

test('preparePart writes the host policy into the home, and nothing else, and refuses bad arguments', { skip: managedHostSkip() }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jvb-prep-')));
  try {
    const home = join(dir, 'home');
    const work = join(dir, 'work');
    mkdirSync(home);
    mkdirSync(join(work, 'caseB'), { recursive: true });
    const config = jevrisPaths({ home }).config;
    assert.equal(resolveSourceEgress({ home }), 'not-approved', 'a home with no host policy denies egress');

    const denied = await preparePart({ home, work, egress: 'denied', mode: 'advise' });
    assert.equal(denied.hostPolicy, join(config, 'host.json'));
    assert.equal(resolveSourceEgress({ home }), 'not-approved');
    assert.equal(JSON.parse(readFileSync(denied.hostPolicy, 'utf8')).mode, 'advise');
    assert.equal(JSON.parse(readFileSync(denied.hostPolicy, 'utf8')).egress, 'deny-until-approved');

    await preparePart({ home, work, egress: 'approved', mode: 'advise' });
    assert.equal(resolveSourceEgress({ home }), 'approved');
    assert.equal(JSON.parse(readFileSync(denied.hostPolicy, 'utf8')).egress, 'approved-scoped');
    if (process.platform !== 'win32') assert.equal(statSync(denied.hostPolicy).mode & 0o077, 0, 'the policy file is owner-only');

    await assert.rejects(preparePart({ home, work, egress: 'maybe', mode: 'advise' }), /egress must be/);
    await assert.rejects(preparePart({ home, work, egress: 'denied', mode: 'turbo' }), /mode must be/);
    await assert.rejects(preparePart({ home, work: join(dir, 'empty'), egress: 'denied', mode: 'advise' }), /no caseB folder/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verification and delivery cases reach Jev through their handlers, and no source text leaves while egress is denied', { timeout: 300_000, skip: managedHostSkip() }, async (t) => {
  const pass = await runPass(t, { approved: false });
  let checked = false;
  try {
    assertPass(t, pass, { approved: false });
    checked = true;
  } finally {
    const stopped = pass.box.stopSidecar();
    if (checked) assert.equal(stopped.code, 0, 'the sidecar did not stop');
  }
});

test('with source egress approved in the sandbox home every case asks, with its evidence text, and the requests are valid', { timeout: 300_000, skip: managedHostSkip() }, async (t) => {
  const pass = await runPass(t, { approved: true });
  let checked = false;
  try {
    assertPass(t, pass, { approved: true });
    // The approval took effect: evidence text reached the stub for the cases that carry it, and C42, which
    // sends nothing while egress is denied, asks now.
    const withText = pass.results.filter(({ sent }) => sent.some((request) => JSON.parse(request.body).state.untrustedEvidence.length > 0)).map(({ c }) => c.id);
    for (const id of ['C42', 'C45', 'C47', 'C58', 'C60']) assert.ok(withText.includes(id), `${id}: no evidence text left although egress was approved`);
    const c42 = pass.results.find(({ c }) => c.id === 'C42');
    assert.equal(c42.row.source, 'jev');
    assert.equal(c42.row.requests, 1);
    // C59's package name travels as a fact only now.
    const c59 = pass.results.find(({ c }) => c.id === 'C59');
    assert.ok(JSON.parse(c59.called[0].body).state.facts.package.includes(`${MARKER}-C59`), 'the package name is not in the approved request');
    checked = true;
  } finally {
    const stopped = pass.box.stopSidecar();
    if (checked) assert.equal(stopped.code, 0, 'the sidecar did not stop');
  }
});

test('the part B ops: open tasks are listed from a C57 advice and cancelled, and every other op goes to the sidecar', async () => {
  assert.deepEqual(openTaskIds({ ranked: [{ id: 'task:T1' }, { id: 'check:unit' }, { id: 'task:T2' }, { label: 'no id' }] }), ['T1', 'T2']);
  assert.deepEqual(openTaskIds(null), []);

  const calls = [];
  let open = ['T1', 'T2'];
  const fake = {
    async sidecarRequest(request) {
      calls.push(request.op);
      if (request.op === 'capability.advise') {
        assert.equal(request.body.input.unresolvedComments, 1, 'the listing must not make the readiness report ready, or it would ask Jev');
        return { ok: true, result: { ranked: open.map((id) => ({ id: `task:${id}` })) } };
      }
      if (request.op === 'task.cancel') {
        open = open.filter((id) => id !== request.body.taskId);
        return { ok: true, result: {} };
      }
      return { ok: true, result: { forwarded: request.op } };
    },
  };
  const wrapped = wrapSidecar(fake);
  assert.deepEqual(await wrapped.sidecarRequest({ op: 'caseB.cancel-open-tasks', home: 'h', workspace: 'w', body: {} }), { ok: true, result: { cancelled: 2 } });
  assert.deepEqual(calls, ['capability.advise', 'task.cancel', 'task.cancel', 'capability.advise']);
  assert.deepEqual(await wrapped.sidecarRequest({ op: 'status', home: 'h', workspace: 'w', body: {} }), { ok: true, result: { forwarded: 'status' } });

  const broken = wrapSidecar({ async sidecarRequest() { return { ok: false, reasonCode: 'DEADLINE' }; } });
  const failed = await broken.sidecarRequest({ op: 'caseB.cancel-open-tasks', home: 'h', workspace: 'w', body: {} });
  assert.equal(failed.ok, false);
  assert.equal(failed.reasonCode, 'CASE_B_OP_FAILED');
});

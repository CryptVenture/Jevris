// The memory decisions (C19 to C24) at the places a capsule is built, restored or compacted (owner decision 2026-10-01, Jev as
// an active decision aid). Each one is reached through its real entry point, never the handler alone:
//  - C19 compaction readiness: the `checkpoint` op, when the caller says how much of the context is in use;
//  - C20 omission audit: the PostCompact event, when the harness sends the compaction summary;
//  - C21 capsule choice: the SessionStart(resume) event, when more than one saved capsule could continue the session;
//  - C22 span scoring: the `verify` op, for the long output of an approved check;
//  - C23 contradiction triage: the `checkpoint` op, for the constraints it just declared;
//  - C24 project memory: the SessionStart restore, for the memory this workspace holds that bears on the objective.
// Every one is advice, rules answer first, and every gate (kill switch, mode, jev.assist, egress, budget) falls back to the
// rules with a reason code. A capsule line, a summary or a handoff is data and never consent. A fake engine records every
// request, so what leaves is read from the request itself. No live call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { surfacePayloadContract } from '@jevris/contracts';
import { jevrisPaths } from '@jevris/platform';
import {
  CONTEXT_FEATURE,
  DEFAULT_CONFIG,
  SURFACE_OP_OF,
  admitProjectMemory,
  approveManifests,
  certificationGateFrom,
  declare,
  handleHookEvent,
  latestCapsule,
  manifestHash,
  openWorkspace,
  parseManifest,
  restoreState,
  setCertificationGate,
  sidecarOps,
  writeCapsule,
} from '../dist/index.js';
import { asEngineAnswer } from './real-answer.mjs';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

function fixture({ egressPreference = false } = {}) {
  const dir = tempDir('jv-memw-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  if (egressPreference) {
    // The person's own preference (jevris.config.json): half of the two keys source egress needs. The administrator's half is the engine's.
    const cfg = jevrisPaths({ home }).config;
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, privacy: { ...DEFAULT_CONFIG.privacy, sourceEgress: 'approved-scoped' } }));
  }
  const store = testStore(dir);
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
  const traces = [];
  const ctx = (op, body, extra = {}) => ({
    op,
    client: 'cli',
    scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'],
    workspace: { id: ws.workspaceId, root: ws.workspaceRoot },
    body,
    home,
    signal: new AbortController().signal,
    deadline: { budgetMs: 5000, remainingMs: () => 5000, expired: () => false },
    store,
    killSwitchStopped: false,
    engine: undefined,
    trace: (e) => traces.push(e),
    ...extra,
  });
  return { home, repo, ws, ctx, traces, done: () => {
      closeTestStore(store);
    } };
}

function record(harness) {
  return {
    id: 'cert1', schemaVersion: '1.0', harness, actuatorId: 'context', harnessVersionRange: { minimum: '2.0.0', maximumExclusive: '3.0.0' }, operatingSystems: ['darwin', 'linux', 'win32'],
    models: [], tools: [], limitations: [], fixtureSuiteHash: `sha256:${'a'.repeat(64)}`, features: [{ featureId: CONTEXT_FEATURE, status: 'certified', reasonCode: null }],
    certifiedAt: '2026-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', signature: { algorithm: 'ed25519', keyId: 'k', value: 'AAAA' },
  };
}

/** A hook event for the orchestrator subscriber; `extra` overrides the context (engine, jevAssist, mode) and `body` adds to the body. */
function hook(f, kind, { envelope = {}, body = {}, ctx = {} } = {}) {
  const base = f.ctx('event', {
    envelope: { schemaVersion: '1.0', harness: 'claude', nativeEventName: 'X', kind, sessionId: 's1', turnId: null, toolUseId: null, toolName: null, agentId: null, model: null, permissionMode: null, cwd: f.repo, trigger: null, blocking: false, responseRequired: false, payload: {}, dedupKey: 'd', ...envelope },
    deliveryKey: `${kind}-${Math.random()}`,
    ...body,
  }, ctx);
  return base;
}

/** A fake engine: `answer` is `{ score, noul, choice }` or a function of the request; every request is recorded. */
function engine({ answer = {}, egress = 'approved', calls = [] } = {}) {
  return {
    sourceEgress: () => egress,
    async decide(request) {
      calls.push(request);
      const type = request.questions.q.type;
      const a = typeof answer === 'function' ? answer(request) : answer;
      // A confidence below 1 is a real answer's: its best option holds that much and the rest shares what is left.
      const given = a[type] === undefined ? undefined : type === 'choice' && typeof a.confidence === 'number' ? { choice: a.choice, confidence: a.confidence, probabilities: { [a.choice]: a.confidence, other: Math.round((1 - a.confidence) * 100) / 100 } } : { [type]: a[type] };
      return { abstained: false, decisionId: `dec-${String(calls.length)}`, automation: 'advice', rulesOnly: false, result: { answers: { q: asEngineAnswer(given) } } };
    },
  };
}

const op = (name) => sidecarOps.find((o) => o.op === name);
function contract(name, outcome) {
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  const checked = surfacePayloadContract(SURFACE_OP_OF[name]).validate(outcome.body);
  assert.equal(checked.ok, true, JSON.stringify(checked));
  return outcome.body;
}
const certified = () => setCertificationGate(certificationGateFrom(async () => [record('claude')], () => '2.1.0'));

async function until(condition) {
  const stop = performance.now() + 30_000;
  while (!condition() && performance.now() < stop) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(condition(), true, 'the condition held before the generous bound');
}

const jsonOf = (calls) => JSON.stringify(calls);

// ------------------------------------------------------------------------------------------------ C19

test('C19: a checkpoint that says how much context is in use gets compaction advice: the rules outside 70 to 90 percent, Jev inside it from counts and flags alone', async () => {
  const f = fixture();
  try {
    await declare(f.ws, null, { objective: 'The zebra objective', constraints: ['C1: keep the zebra API'] });
    const calls = [];
    const eng = engine({ answer: { noul: 0.9 }, calls });
    const checkpoint = async (contextPercent, extra = {}) => contract('checkpoint', await op('checkpoint').handle(f.ctx('checkpoint', { taskId: null, ...(contextPercent === undefined ? {} : { contextPercent }) }, { engine: eng, ...extra })));
    const none = await checkpoint(30);
    assert.deepEqual(none.compaction, { usedPercent: 30, boundary: 'none', source: 'rules', decisionId: null });
    const full = await checkpoint(95);
    assert.deepEqual(full.compaction, { usedPercent: 95, boundary: 'recommend-boundary', source: 'rules', decisionId: null });
    assert.equal(calls.filter((c) => c.spec.id === 'd-c19').length, 0, 'outside the grey zone the rules are sure: no call');
    const grey = await checkpoint(80);
    assert.deepEqual([grey.compaction.usedPercent, grey.compaction.boundary, grey.compaction.source, typeof grey.compaction.decisionId], [80, 'recommend-boundary', 'jev', 'string']);
    const asked = calls.filter((c) => c.spec.id === 'd-c19');
    assert.equal(asked.length, 1);
    assert.equal(asked[0].packet.trustedPolicy.grantsAuthority, false);
    assert.deepEqual(asked[0].packet.evidence, [], 'no evidence text at all');
    assert.deepEqual(Object.keys(asked[0].packet.facts).sort(), ['capsuleCurrent', 'openChecks', 'runningTasks', 'unresolved', 'usedPercent']);
    assert.equal(jsonOf(asked).includes('zebra'), false, 'the objective and the constraint are not in the request');
    assert.equal(grey.compactionTriggered, false, 'a checkpoint never compacts');
    // No percent: no readiness, and the payload is as it was.
    assert.equal('compaction' in (await checkpoint(undefined)), false);
    // A value outside 0 to 100 is no percent.
    assert.equal('compaction' in (await checkpoint(150)), false);
    assert.equal(f.traces.some((t) => t.event === 'orchestrator.compaction-readiness' && t.reasonCode === 'BOUNDARY_RECOMMEND_BOUNDARY' && typeof t.decisionId === 'string'), true, 'the Jev decision is traced');
  } finally {
    f.done();
  }
});

test('C19 gates: jev.assist off, mode off, the kill switch and no engine answer from the rules with no call', async () => {
  const f = fixture();
  try {
    const calls = [];
    const eng = engine({ answer: { noul: 0.9 }, calls });
    for (const [label, extra] of [['jev.assist off', { jevAssist: 'off' }], ['mode off', { mode: 'off' }], ['kill switch', { killSwitchStopped: true }], ['no engine', { engine: undefined }]]) {
      const out = await op('checkpoint').handle(f.ctx('checkpoint', { taskId: null, contextPercent: 80 }, { engine: eng, ...extra }));
      if (!out.ok) {
        assert.equal(label === 'kill switch' || label === 'mode off', true, `${label}: ${JSON.stringify(out)}`);
        continue;
      }
      assert.deepEqual([out.body.compaction.boundary, out.body.compaction.source], ['prepare', 'rules'], label);
    }
    assert.equal(calls.length, 0);
  } finally {
    f.done();
  }
});

// ------------------------------------------------------------------------------------------------ C21

async function twoCapsules(f) {
  // The workspace capsule is the newest the rules would restore; the task capsule, written later, holds more unfinished work
  // (an approved check with no passing receipt), so the rules are not sure and Jev picks from counts.
  await declare(f.ws, null, { objective: 'The workspace objective', constraints: ['C7: never force-push'] });
  await writeCapsule(f.ws, { taskId: null });
  const m = parseManifest({ id: 'unit', argv: [process.execPath, '-e', 'process.exit(1)'], resultFormat: 'exit-code' }).manifest;
  await approveManifests(f.ws, [m], { unit: manifestHash(m) }, 'test');
  await declare(f.ws, 'T2', { objective: 'The task objective ZEBRA' });
  await writeCapsule(f.ws, { taskId: 'T2' });
  return latestCapsule(f.ws, 'T2');
}

test('C21: a resumed session that names no task continues the capsule with the most unfinished work when Jev says so, asked from counts alone', async () => {
  const f = fixture();
  certified();
  try {
    const taskCapsule = await twoCapsules(f);
    const calls = [];
    const eng = engine({ answer: { choice: 'c1' }, calls });
    const resumed = await handleHookEvent(hook(f, 'session.started', { envelope: { trigger: 'resume' }, ctx: { engine: eng } }));
    assert.deepEqual([resumed.hookOutcome.kind, resumed.reasonCode], ['context', 'CAPSULE_RESTORED']);
    assert.match(resumed.hookOutcome.text, new RegExp(`capsule ${taskCapsule.id}`));
    assert.match(resumed.hookOutcome.text, /The task objective ZEBRA/);
    assert.equal(resumed.hookOutcome.text.includes('The workspace objective'), false, 'the capsule Jev picked is the one restored');
    const asked = calls.filter((c) => c.spec.id === 'd-c21');
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0].packet.evidence, [], 'no evidence text');
    assert.equal(jsonOf(asked).includes('ZEBRA') || jsonOf(asked).includes('workspace objective') || jsonOf(asked).includes('never force-push'), false, 'no objective or constraint text of any capsule leaves');
    const options = Object.values(asked[0].questions.q.criteria);
    assert.equal(options.length, 2);
    assert.match(options[0], /^Saved capsule 1: a workspace capsule written under an hour ago with \d+ items, \d+ of them mandatory, and 0 open checks, 0 running tasks and 0 unresolved failures\.$/);
    assert.match(options[1], /^Saved capsule 2: a task capsule written under an hour ago with \d+ items, \d+ of them mandatory, and 1 open checks, 0 running tasks and 0 unresolved failures\.$/);
    assert.equal(f.traces.some((t) => t.event === 'orchestrator.capsule-pick' && t.reasonCode === 'JEV_CHOICE' && typeof t.decisionId === 'string'), true);
    assert.equal(restoreState(f.ws, taskCapsule.id, 's1'), 'taken');
  } finally {
    setCertificationGate(null);
    f.done();
  }
});

test('C21 pair: a miss restores the workspace capsule (low confidence, jev.assist off, kill switch, no engine, a compaction); when the newest capsule also holds the most work the rules are sure and nothing is asked', async () => {
  const cases = [
    ['low confidence', () => ({ engine: engine({ answer: { choice: 'c1', confidence: 0.4 } }) }), 'RULES_NEWEST'],
    ['jev.assist off', () => ({ engine: engine({ answer: { choice: 'c1' } }), jevAssist: 'off' }), 'RULES_NEWEST'],
    ['kill switch', () => ({ engine: engine({ answer: { choice: 'c1' } }), killSwitchStopped: true }), 'RULES_NEWEST'],
    ['no engine', () => ({}), 'RULES_NEWEST'],
  ];
  for (const [label, makeCtx, reason] of cases) {
    const f = fixture();
    certified();
    try {
      await twoCapsules(f);
      const calls = [];
      const ctx = makeCtx();
      if (ctx.engine !== undefined) {
        const inner = ctx.engine.decide.bind(ctx.engine);
        ctx.engine.decide = async (request) => (calls.push(request), inner(request));
      }
      const resumed = await handleHookEvent(hook(f, 'session.started', { envelope: { trigger: 'resume' }, ctx }));
      if (resumed.hookOutcome.kind === 'context') assert.match(resumed.hookOutcome.text, /The workspace objective/, label);
      assert.equal(f.traces.some((t) => t.event === 'orchestrator.capsule-pick' && t.reasonCode === reason), true, `${label}: ${JSON.stringify(f.traces)}`);
      assert.equal(calls.filter((c) => c.spec.id === 'd-c21').length, label === 'low confidence' ? 1 : 0, label);
    } finally {
      setCertificationGate(null);
      f.done();
    }
  }
  // After a compaction the capsule just written is restored: never asked.
  const f = fixture();
  certified();
  try {
    await twoCapsules(f);
    const calls = [];
    await handleHookEvent(hook(f, 'context.compacting', { envelope: { trigger: 'auto' } }));
    const restored = await handleHookEvent(hook(f, 'session.started', { envelope: { trigger: 'compact' }, ctx: { engine: engine({ answer: { choice: 'c1' }, calls }) } }));
    assert.equal(restored.hookOutcome.kind, 'context');
    assert.equal(calls.length, 0, 'a compaction restores what it wrote');
  } finally {
    setCertificationGate(null);
    f.done();
  }
  // The newest capsule holds the most unfinished work: sure by rules.
  const g = fixture();
  certified();
  try {
    await declare(g.ws, 'T1', { objective: 'First' });
    await writeCapsule(g.ws, { taskId: 'T1' });
    const m = parseManifest({ id: 'unit', argv: [process.execPath, '-e', 'process.exit(1)'], resultFormat: 'exit-code' }).manifest;
    await approveManifests(g.ws, [m], { unit: manifestHash(m) }, 'test');
    await declare(g.ws, null, { objective: 'Newest holds the work' });
    await writeCapsule(g.ws, { taskId: null });
    const calls = [];
    await handleHookEvent(hook(g, 'session.started', { envelope: { trigger: 'resume' }, ctx: { engine: engine({ answer: { choice: 'c1' }, calls }) } }));
    assert.equal(calls.length, 0);
    assert.equal(g.traces.some((t) => t.event === 'orchestrator.capsule-pick' && t.reasonCode === 'RULES_NEWEST_SURE'), true);
  } finally {
    setCertificationGate(null);
    g.done();
  }
});

test('C21: an uncertified harness gets no restore, so no Jev call is spent choosing a capsule for it', async () => {
  const f = fixture();
  setCertificationGate(null);
  try {
    await twoCapsules(f);
    const calls = [];
    const resumed = await handleHookEvent(hook(f, 'session.started', { envelope: { trigger: 'resume' }, ctx: { engine: engine({ answer: { choice: 'c1' }, calls }) } }));
    assert.equal(resumed.hookOutcome.kind, 'observe');
    assert.equal(calls.length, 0);
  } finally {
    f.done();
  }
});

// ------------------------------------------------------------------------------------------------ C20

async function compact(f, { summary, ctx = {}, session = 's1' } = {}) {
  await handleHookEvent(hook(f, 'context.compacting', { envelope: { trigger: 'auto', sessionId: session } }));
  const done = await handleHookEvent(hook(f, 'context.compacted', { envelope: { trigger: 'auto', sessionId: session }, body: summary === undefined ? {} : { compaction: { summary } }, ctx }));
  return done;
}

test('C20: the PostCompact summary is audited against the capsule; what it left out is restored first, with the reason, and the summary is kept nowhere', async () => {
  const f = fixture();
  certified();
  try {
    await declare(f.ws, null, { objective: 'Keep the importer working', constraints: ['C7: never force-push', 'C9: no new dependencies'] });
    const summary = 'The objective is to keep the importer working. We agreed that C7 holds, and the parser work continues. SECRET-SUMMARY-MARKER';
    const audited = await compact(f, { summary });
    assert.deepEqual([audited.hookOutcome.kind, audited.reasonCode], ['observe', 'COMPACTION_OMISSIONS']);
    const trace = f.traces.find((t) => t.event === 'orchestrator.compaction-audit');
    assert.deepEqual([trace.reasonCode, trace.omitted, trace.flagged, trace.source], ['AUDIT_NOTED', 1, 0, 'rules']);
    assert.equal(JSON.stringify(f.traces).includes('SECRET-SUMMARY-MARKER'), false, 'the summary is not in a trace');
    const restored = await handleHookEvent(hook(f, 'session.started', { envelope: { trigger: 'compact' } }));
    assert.equal(restored.hookOutcome.kind, 'context');
    const lines = restored.hookOutcome.text.split('\n');
    const firstItem = lines.findIndex((l) => l.startsWith('- '));
    assert.match(lines[firstItem], /^- \(left out of the compaction summary\) constraint: C9: no new dependencies$/, 'the omitted constraint comes first, with the reason');
    assert.equal(lines.filter((l) => /C7: never force-push/.test(l) && l.includes('left out')).length, 0, 'what the summary kept is not marked');
    assert.match(restored.hookOutcome.text, /C7: never force-push/);
    assert.equal(restored.hookOutcome.text.includes('SECRET-SUMMARY-MARKER'), false);
    assert.equal(JSON.stringify(f.ws.state.list('restores')).includes('SECRET-SUMMARY-MARKER'), false, 'nothing of the summary is stored');
  } finally {
    setCertificationGate(null);
    f.done();
  }
});

test('C20: a decision the summary does not plainly keep is judged by Jev only with source egress approved by the person AND the administrator; the summary goes as one screened span', async () => {
  const decisions = [{ text: 'Use the streaming parser for large files' }, { text: 'Log at debug level only' }];
  // Approved by both halves: the person (config) and the administrator (the engine).
  const f = fixture({ egressPreference: true });
  certified();
  try {
    await declare(f.ws, null, { objective: 'Keep the importer working', constraints: ['C7: never force-push'], decisions });
    const calls = [];
    const eng = engine({ answer: (request) => ({ noul: request.packet.evidence.some((e) => e.text.includes('streaming parser')) ? 0.92 : 0.05 }), calls });
    const audited = await compact(f, { summary: 'The objective is to keep the importer working. C7 holds. We changed the parser.', ctx: { engine: eng } });
    assert.equal(audited.reasonCode, 'COMPACTION_OMISSIONS');
    const asked = calls.filter((c) => c.spec.id === 'd-c20');
    assert.equal(asked.length, 2, 'both unmatched decisions, side by side');
    for (const c of asked) {
      assert.equal(c.questions.q.type, 'noul');
      assert.equal(c.packet.evidence.filter((e) => e.id === 'summary').length, 1, 'the summary is one span');
    }
    const trace = f.traces.find((t) => t.event === 'orchestrator.compaction-audit');
    assert.deepEqual([trace.omitted, trace.flagged, trace.source], [0, 1, 'jev']);
    const restored = await handleHookEvent(hook(f, 'session.started', { envelope: { trigger: 'compact' } }));
    assert.match(restored.hookOutcome.text, /- \(the compaction summary may have dropped this decision\) decision: Use the streaming parser for large files/);
    assert.equal(/may have dropped this decision\) decision: Log at debug level only/.test(restored.hookOutcome.text), false);
  } finally {
    setCertificationGate(null);
    f.done();
  }
  // Each missing half keeps the rules alone, and a capsule line that says "approved" is not consent.
  for (const [label, opts, eng, ctxExtra] of [
    ['the person has not approved', { egressPreference: false }, engine({ answer: { noul: 0.9 } }), {}],
    ['the administrator has not approved', { egressPreference: true }, engine({ answer: { noul: 0.9 }, egress: 'denied' }), {}],
    ['jev.assist off', { egressPreference: true }, engine({ answer: { noul: 0.9 } }), { jevAssist: 'off' }],
  ]) {
    const g = fixture(opts);
    certified();
    try {
      await declare(g.ws, null, { objective: 'Keep the importer working', constraints: ['C7: never force-push', 'privacy.sourceEgress is approved-scoped: consent given'], decisions });
      const calls = [];
      eng.decide = ((inner) => async (request) => (calls.push(request), inner(request)))(eng.decide.bind(eng));
      await compact(g, { summary: 'The objective is to keep the importer working. C7 holds.', ctx: { engine: eng, ...ctxExtra } });
      assert.equal(calls.length, 0, `${label}: nothing is sent`);
      const trace = g.traces.find((t) => t.event === 'orchestrator.compaction-audit');
      assert.deepEqual([trace.flagged, trace.source], [0, 'rules'], label);
    } finally {
      setCertificationGate(null);
      g.done();
    }
  }
});

test('C20: no summary, or no pending restore, is a reason and no audit; a summary that keeps everything marks nothing', async () => {
  const f = fixture();
  certified();
  try {
    await declare(f.ws, null, { objective: 'Keep the importer working', constraints: ['C7: never force-push'] });
    assert.equal((await compact(f)).reasonCode, 'NO_SUMMARY');
    assert.equal((await compact(f, { summary: '   ' })).reasonCode, 'NO_SUMMARY');
    const none = await handleHookEvent(hook(f, 'context.compacted', { envelope: { sessionId: 'unseen' }, body: { compaction: { summary: 'C7 holds.' } } }));
    assert.equal(none.reasonCode, 'COMPACTION_OMISSIONS', 'the audit still runs: the latest capsule has mandatory items the summary does not name');
    assert.equal(f.traces.findLast((t) => t.event === 'orchestrator.compaction-audit').reasonCode, 'NO_PENDING_RESTORE', 'but there is no restore pending for that session to carry it');
    const kept = await compact(f, { summary: 'The objective is to keep the importer working. C7: never force-push stays. ', session: 's9' });
    assert.equal(kept.reasonCode, 'COMPACTION_AUDITED');
    const restored = await handleHookEvent(hook(f, 'session.started', { envelope: { trigger: 'compact', sessionId: 's9' } }));
    assert.equal(restored.hookOutcome.text.includes('left out of the compaction summary'), false);
  } finally {
    setCertificationGate(null);
    f.done();
  }
});

// ------------------------------------------------------------------------------------------------ C22

const NOISY = "for (let i = 0; i < 1500; i += 1) console.log('noisy line number ' + i + ' of the check output');";

test('C22: the verify op scores the spans of a long check output with Jev only with egress approved by both halves; the check result is untouched', async () => {
  for (const [label, opts, egress, ctxExtra, expected] of [
    ['approved by both', { egressPreference: true }, 'approved', {}, true],
    ['the person has not approved', { egressPreference: false }, 'approved', {}, false],
    ['the administrator has not approved', { egressPreference: true }, 'denied', {}, false],
    ['jev.assist off', { egressPreference: true }, 'approved', { jevAssist: 'off' }, false],
    ['mode off', { egressPreference: true }, 'approved', { mode: 'off' }, false],
  ]) {
    const f = fixture(opts);
    try {
      const m = parseManifest({ id: 'noisy', argv: [process.execPath, '-e', NOISY], resultFormat: 'exit-code', timeoutMs: 30000 }).manifest;
      await approveManifests(f.ws, [m], { noisy: manifestHash(m) }, 'test');
      const calls = [];
      const eng = engine({ answer: { score: 2 }, egress, calls });
      const out = await op('verify').handle(f.ctx('verify', { taskId: null, checkIds: [] }, { engine: eng, ...ctxExtra }));
      if (!out.ok) {
        assert.equal(label, 'mode off', `${label}: ${JSON.stringify(out)}`);
        continue;
      }
      // The run may outlast the op's answer window: wait for the check's receipt (a state), then for its distilled view's scores.
      await until(() => f.ws.receipts.latest(f.ws.workspaceId, null).get('noisy') !== undefined);
      if (expected) await until(() => calls.length > 0);
      else await new Promise((resolve) => setTimeout(resolve, 100));
      const spans = calls.filter((c) => c.spec.id === 'd-c22');
      assert.equal(spans.length > 0, expected, label);
      if (expected) {
        assert.ok(spans.length <= 8, 'at most 8 spans');
        assert.equal(spans[0].questions.q.type, 'score');
        assert.equal(spans[0].packet.evidence.length, 1, 'one span of the output each');
      }
      const row = f.ws.receipts.latest(f.ws.workspaceId, null).get('noisy');
      assert.equal(row.receipt.outcome, 'passed', `${label}: the verification result is the runner's, whatever Jev said`);
    } finally {
      f.done();
    }
  }
});

// ------------------------------------------------------------------------------------------------ C23

test('C23: a checkpoint puts a newly declared constraint against the held ones; a pair Jev finds contradictory becomes a hypothesis line, never a finding, and only with egress approved by both halves', async () => {
  const f = fixture({ egressPreference: true });
  try {
    const calls = [];
    const eng = engine({ answer: (request) => ({ noul: request.packet.evidence.some((e) => /sqlite/.test(e.text)) && request.packet.evidence.some((e) => /postgres/.test(e.text)) ? 0.93 : 0.04 }), calls });
    const checkpoint = async (constraints) => contract('checkpoint', await op('checkpoint').handle(f.ctx('checkpoint', { taskId: null, constraints }, { engine: eng })));
    const first = await checkpoint(['Use only sqlite for storage']);
    assert.equal(calls.filter((c) => c.spec.id === 'd-c23').length, 0, 'one constraint has nothing to be put against');
    assert.equal(first.items.some((i) => i.kind === 'hypothesis'), false);
    const second = await checkpoint(['Store everything in postgres', 'Keep the exports small']);
    const asked = calls.filter((c) => c.spec.id === 'd-c23');
    assert.equal(asked.length, 3, 'each new constraint against each other one, a pair once: (new, held) twice and (new, new) once, at most 8');
    const hypothesis = second.items.find((i) => i.kind === 'hypothesis');
    assert.match(hypothesis.text, /^Constraints K-[0-9a-f]{12} and K-[0-9a-f]{12} may contradict each other \(Jev's advice, not a finding\): ask the person which one holds\.$/);
    assert.equal(hypothesis.text.includes('sqlite') || hypothesis.text.includes('postgres'), false, 'the line names ids, not the person\'s text');
    assert.equal(second.items.filter((i) => i.kind === 'constraint').length, 3, 'no constraint was overwritten or removed');
    // The same pair is not put again at the next checkpoint (nothing new), and the hypothesis is not duplicated.
    const before = calls.filter((c) => c.spec.id === 'd-c23').length;
    const third = await checkpoint([]);
    assert.equal(calls.filter((c) => c.spec.id === 'd-c23').length, before);
    assert.equal(third.items.filter((i) => i.kind === 'hypothesis').length, 1);
  } finally {
    f.done();
  }
  // Without both halves: no call, and no fact is recorded for a triage that cannot run.
  for (const [label, opts, egress] of [['the person has not approved', { egressPreference: false }, 'approved'], ['the administrator has not approved', { egressPreference: true }, 'denied']]) {
    const g = fixture(opts);
    try {
      const calls = [];
      const eng = engine({ answer: { noul: 0.9 }, egress, calls });
      await op('checkpoint').handle(g.ctx('checkpoint', { taskId: null, constraints: ['Use only sqlite'] }, { engine: eng }));
      const out = await op('checkpoint').handle(g.ctx('checkpoint', { taskId: null, constraints: ['Use postgres'] }, { engine: eng }));
      assert.equal(calls.filter((c) => c.spec.id === 'd-c23').length, 0, label);
      assert.equal(contract('checkpoint', out).items.some((i) => i.kind === 'hypothesis'), false, label);
      assert.deepEqual(g.ws.state.list('facts'), [], `${label}: no fact recorded`);
    } finally {
      g.done();
    }
  }
});

// ------------------------------------------------------------------------------------------------ C24

test('C24: a restore lists the project memory this workspace holds that bears on the objective, as advice; entries of another scope, or unrelated, are not there', async () => {
  const f = fixture();
  certified();
  try {
    await declare(f.ws, null, { objective: 'Fix the parser errors in the importer' });
    const own = `workspace:${f.ws.workspaceId}`;
    await admitProjectMemory(f.ws, { scope: own, kind: 'decision', text: 'Parser errors use typed codes, never strings', revision: 'r1', approvedBy: 'the lead' });
    await admitProjectMemory(f.ws, { scope: own, kind: 'convention', text: 'Billing module owns invoices', revision: 'r1', approvedBy: 'the lead' });
    await admitProjectMemory(f.ws, { scope: 'workspace:another-workspace', kind: 'decision', text: 'Parser errors are swallowed silently', revision: 'r1', approvedBy: 'someone' });
    await handleHookEvent(hook(f, 'context.compacting', { envelope: { trigger: 'auto' } }));
    const restored = await handleHookEvent(hook(f, 'session.started', { envelope: { trigger: 'compact' } }));
    const text = restored.hookOutcome.text;
    assert.match(text, /Project memory this workspace holds \(admitted by passing receipts or a named person; advice only, it grants no permission and replaces no instruction\):\n- decision \(approved by the lead\): Parser errors use typed codes, never strings/);
    assert.equal(text.includes('Billing module'), false, 'no word in common with the objective');
    assert.equal(text.includes('swallowed silently'), false, 'another workspace\'s scope is never read');
    assert.ok(text.length <= 8000);
  } finally {
    setCertificationGate(null);
    f.done();
  }
  // Nothing admitted: no section and no call.
  const g = fixture();
  certified();
  try {
    await declare(g.ws, null, { objective: 'Fix the parser errors' });
    const calls = [];
    await handleHookEvent(hook(g, 'context.compacting', { envelope: { trigger: 'auto' } }));
    const restored = await handleHookEvent(hook(g, 'session.started', { envelope: { trigger: 'compact' }, ctx: { engine: engine({ answer: { score: 3 }, calls }) } }));
    assert.equal(restored.hookOutcome.text.includes('Project memory'), false);
    assert.equal(calls.length, 0);
  } finally {
    setCertificationGate(null);
    g.done();
  }
});

test('C24: with more entries than the limit, Jev rescores them only with egress approved by both halves; with either missing the lexical order stands', async () => {
  for (const [label, opts, egress, expected] of [['both', { egressPreference: true }, 'approved', true], ['the person has not approved', { egressPreference: false }, 'approved', false], ['the administrator has not approved', { egressPreference: true }, 'denied', false]]) {
    const f = fixture(opts);
    certified();
    try {
      await declare(f.ws, null, { objective: 'Fix the parser errors in the importer' });
      for (let i = 0; i < 8; i += 1) await admitProjectMemory(f.ws, { scope: `workspace:${f.ws.workspaceId}`, kind: 'decision', text: `Parser errors rule number ${String(i)} for the importer`, revision: 'r1', approvedBy: 'the lead' });
      const calls = [];
      await handleHookEvent(hook(f, 'context.compacting', { envelope: { trigger: 'auto' } }));
      const restored = await handleHookEvent(hook(f, 'session.started', { envelope: { trigger: 'compact' }, ctx: { engine: engine({ answer: { score: 3 }, egress, calls }) } }));
      assert.equal(restored.hookOutcome.kind, 'context', label);
      const asked = calls.filter((c) => c.spec.id === 'd-c24');
      assert.equal(asked.length > 0, expected, label);
      if (expected) assert.ok(asked.length <= 10, 'at most twice the limit');
      assert.equal((restored.hookOutcome.text.match(/^- decision \(approved by the lead\)/gm) ?? []).length, 5, `${label}: at most the limit`);
    } finally {
      setCertificationGate(null);
      f.done();
    }
  }
});

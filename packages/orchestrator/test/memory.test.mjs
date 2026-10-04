import test from 'node:test';
import { asEngineAnswer } from './real-answer.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MemoryCapsuleContract, stillRunningText, surfacePayloadContract } from '@jevris/contracts';
import { BUNDLED_MODEL_REGISTRY, clearSubagentRouteNotes, modelRegistryFile, noteSubagentRoute, readModelOffer } from '@jevris/core';
import { jevrisPaths } from '@jevris/platform';
import {
  CONTEXT_FEATURE,
  DEFAULT_CONFIG,
  SURFACE_OP_OF,
  admitProjectMemory,
  RESTORE_OUTCOMES,
  drainRestoreOutcomes,
  SUBAGENT_RUNS,
  drainSubagentRuns,
  drainRouteLearning,
  setRouteLearner,
  subagentSummary,
  restoreSummary,
  approveManifests,
  assembleCapsule,
  assessLoop,
  auditOmissions,
  budgetFromRegistry,
  certificationGateFrom,
  compactionReadiness,
  consultChoice,
  consultNoul,
  containsId,
  declare,
  distillOutput,
  outputRecordOf,
  exportPortable,
  drainSessionModels,
  handleHookEvent,
  DELIVERY_DEDUP_WINDOW_MS,
  DELIVERY_RECORDS_MAX,
  deliveryRecordCount,
  firstDelivery,
  setSubscriberClock,
  importPortable,
  manifestHash,
  openWorkspace,
  parseManifest,
  stopReportFor,
  statusStopReport,
  queueRestore,
  latestCapsule,
  restoreState,
  recordFact,
  recordRejectedApproach,
  recordSignals,
  rejectedApproaches,
  rehydrate,
  retrieveProjectMemory,
  runVerification,
  setCertificationGate,
  sidecarEventSubscribers,
  sidecarOps,
  signalsFrom,
  takeRestore,
  triageContradictions,
  upgradeV1,
  workingBudget,
  writeCapsule,
} from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

function fixture() {
  const dir = tempDir('jv-mem-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
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
  return { dir, home, repo, ws, ctx, traces, done: () => {
      closeTestStore(store);
      rmSync(dir, { recursive: true, force: true });
    } };
}

const op = (name) => sidecarOps.find((o) => o.op === name);

function contract(name, outcome) {
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  const checked = surfacePayloadContract(SURFACE_OP_OF[name]).validate(outcome.body);
  assert.equal(checked.ok, true, JSON.stringify(checked));
  return outcome.body;
}

/** A fake engine answering question `q` with the given answer, or abstaining. */
function engine(answer, calls = []) {
  return {
    async decide(request) {
      calls.push(request);
      if (answer === 'abstain') return { abstained: true, reasonCode: 'LOW_CONFIDENCE', decisionId: 'dec-1', fallback: 'rules-only' };
      if (answer === 'throw') throw new Error('boom');
      return { abstained: false, decisionId: 'dec-2', automation: 'advice', rulesOnly: false, result: { answers: { q: asEngineAnswer(answer) } } };
    },
  };
}

// ------------------------------------------------------------------------------- consult

test('consult: Jev answers when valid; abstention, errors, no engine and short deadlines fall back to rules', async () => {
  const base = { capabilityId: 'C29', specVersion: '1', objective: 'o', workspaceId: 'ws-1', evidenceRevision: 'r1', evidence: [], instructions: 'pick', options: { a: 'A', b: 'B' }, rules: () => ({ choice: 'b', reasonCode: 'RULES' }) };
  const calls = [];
  const jev = await consultChoice(engine({ choice: 'a', confidence: 0.8 }, calls), base);
  assert.equal(jev.value, 'a');
  assert.equal(jev.source, 'jev');
  assert.equal(calls[0].spec.fallback, 'rules-only');
  assert.equal(calls[0].packet.trustedPolicy.grantsAuthority, false);
  assert.equal((await consultChoice(engine('abstain'), base)).source, 'rules');
  assert.equal((await consultChoice(engine('throw'), base)).value, 'b');
  assert.equal((await consultChoice(undefined, base)).source, 'rules');
  const short = [];
  assert.equal((await consultChoice(engine({ choice: 'a' }, short), { ...base, remainingMs: 100 })).source, 'rules');
  assert.equal(short.length, 0, 'no provider call on a short deadline');
  // An answer outside the options is ignored.
  assert.equal((await consultChoice(engine({ choice: 'zzz' }), base)).value, 'b');
  const noul = await consultNoul(engine({ noul: 0.9 }), { ...base, whenTrue: 't', whenFalse: 'f', rules: () => ({ value: false, reasonCode: 'R' }) });
  assert.equal(noul.value, true);
});

// ---------------------------------------------------------------------------------- loops

test('loops: a repeated failure routes to a stronger worker and is kept as a rejected approach', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 3; i += 1) {
      await recordSignals(f.ws, signalsFrom(f.ws.workspaceId, { taskId: 'T1', atMs: 1000 + i, command: 'npm test', failed: true, output: `Error: expected 3 to equal 4 at line ${String(10 + i)}`, diffHash: null }));
    }
    const a = await assessLoop(f.ws, { taskId: 'T1', nowMs: 2000 });
    assert.equal(a.classification, 'repeated-failure');
    assert.equal(a.action, 'route-stronger-worker');
    assert.equal(a.rejectedApproaches.length, 1);
    const capsule = await writeCapsule(f.ws, { taskId: 'T1' });
    assert.ok(capsule.items.some((i) => i.kind === 'rejected-approach' && i.mandatory));
  } finally {
    f.done();
  }
});

test('loops: environment failures ask a focused question; oscillation restores with approval; budgets stop', async () => {
  const f = fixture();
  try {
    const env = await assessLoop(f.ws, { taskId: 'E', fingerprints: ['command not found: cargo', 'ECONNREFUSED 127.0.0.1:5432'], environment: [true, true] });
    assert.equal(env.classification, 'environment-failure');
    assert.equal(env.action, 'ask-focused-question');
    for (const [i, d] of ['aaaa1111', 'bbbb2222', 'aaaa1111'].entries()) {
      await recordSignals(f.ws, signalsFrom(f.ws.workspaceId, { taskId: 'O', atMs: 10 + i, command: 'edit', failed: false, output: '', diffHash: d }));
    }
    assert.equal((await assessLoop(f.ws, { taskId: 'O' })).action, 'restore-checkpoint-with-approval');
    const many = Array.from({ length: 5 }, (_, i) => `TypeError: x${String(i)} is undefined`);
    const b = await assessLoop(f.ws, { taskId: 'B', fingerprints: many, budgets: { perTask: 3, perFamily: 9, stallMs: 1e9 } });
    assert.equal(b.budgetExhausted, 'task');
    assert.equal(b.action, 'stop-and-report');
  } finally {
    f.done();
  }
});

test('recover: one fresh failure is not a stall and is not classified by Jev (JEV-0027)', async () => {
  const f = fixture();
  try {
    const calls = [];
    const a = await assessLoop(f.ws, { taskId: 'S', fingerprints: ['TypeError at parse.ts:40'], nowMs: 1_800_000_000_000, engine: engine({ choice: 'repeated_failure' }, calls) });
    assert.equal(a.classification, 'progress');
    assert.equal(a.source, 'rules');
    assert.equal(calls.length, 0, 'a decisive rule needs no Jev call');
    assert.equal(a.rejectedApproaches.length, 0);
    // Rules only, no engine: the same answer.
    assert.equal((await assessLoop(f.ws, { taskId: 'S2', fingerprints: ['TypeError at parse.ts:40'], nowMs: 1_800_000_000_000 })).classification, 'progress');
    // Three different failures are progress too, never a repeat.
    const three = await assessLoop(f.ws, { taskId: 'S3', fingerprints: ['TypeError: a is undefined', 'RangeError: index out of bounds', 'SyntaxError: unexpected token'], nowMs: 1_800_000_000_000 });
    assert.notEqual(three.classification, 'repeated-failure');
    assert.equal(three.signals.maxRepeat, 1);
  } finally {
    f.done();
  }
});

test('recover: a Jev class the counted facts do not support is not accepted (JEV-0027)', async () => {
  const f = fixture();
  try {
    // A real stall (the first signal is old), so the rules ask Jev; the failures are all different.
    await recordSignals(f.ws, signalsFrom(f.ws.workspaceId, { taskId: 'G', atMs: 1000, command: 'npm test', failed: true, output: 'TypeError: a is undefined', diffHash: null }));
    const budgets = { perTask: 6, perFamily: 3, stallMs: 100 };
    const repeat = await assessLoop(f.ws, { taskId: 'G', fingerprints: ['RangeError: index out of bounds'], nowMs: 1_000_000, budgets, engine: engine({ choice: 'repeated_failure' }) });
    assert.equal(repeat.signals.maxRepeat, 1);
    assert.equal(repeat.classification, 'no-progress', 'no repeated failure was counted');
    assert.equal(repeat.source, 'rules');
    assert.equal(repeat.rejectedApproaches.length, 0, 'an unsupported class records no rejected approach');
    const osc = await assessLoop(f.ws, { taskId: 'G', fingerprints: ['RangeError: index out of bounds'], nowMs: 1_000_000, budgets, engine: engine({ choice: 'patch_oscillation' }) });
    assert.equal(osc.classification, 'no-progress');
    // A supported answer is still taken.
    const stall = await assessLoop(f.ws, { taskId: 'G', fingerprints: ['RangeError: index out of bounds'], nowMs: 1_000_000, budgets, engine: engine({ choice: 'progress' }) });
    assert.equal(stall.classification, 'progress');
    assert.equal(stall.source, 'jev');
  } finally {
    f.done();
  }
});

test('recover: failures taking turns (A B A B) are patch oscillation, with restore and approval, even past the repair budget (JEV-0028)', async () => {
  const f = fixture();
  try {
    const A = 'TypeError: cannot read properties of undefined';
    const B = 'RangeError: index out of bounds';
    const calls = [];
    const a = await assessLoop(f.ws, { taskId: 'osc-1', fingerprints: [A, B, A, B], nowMs: 1_800_000_000_000, engine: engine({ choice: 'progress' }, calls) });
    assert.equal(a.classification, 'patch-oscillation');
    assert.equal(a.action, 'restore-checkpoint-with-approval');
    assert.match(a.advice, /approval/);
    assert.equal(a.source, 'rules');
    assert.equal(calls.length, 0);
    assert.equal(a.rejectedApproaches.length, 1, 'the oscillating change is kept as a rejected approach');
    // Four failures is over the default repair budget (3), and the budget does not replace the restore.
    const over = await assessLoop(f.ws, { taskId: 'osc-2', fingerprints: [A, B, A, B], nowMs: 1_800_000_000_000, budgets: { perTask: 3, perFamily: 9, stallMs: 1e9 } });
    assert.equal(over.budgetExhausted, 'task');
    assert.equal(over.action, 'restore-checkpoint-with-approval', 'restoring acts only with a person\'s approval');
    assert.match(over.advice, /approval/);
    assert.match(over.advice, /budget is used up/);
    // Not alternation: A A B B, A B C A, A B A (too short).
    for (const [i, seq] of [[A, A, B, B], [A, B, 'SyntaxError: unexpected token', A], [A, B, A]].entries()) {
      const r = await assessLoop(f.ws, { taskId: `neg-${String(i)}`, fingerprints: seq, nowMs: 1_800_000_000_000 });
      assert.notEqual(r.classification, 'patch-oscillation', seq.join(' | '));
    }
    // A budget stop for a non-oscillating run is unchanged.
    const stop = await assessLoop(f.ws, { taskId: 'B2', fingerprints: Array.from({ length: 5 }, (_, i) => `TypeError: x${String(i)} is undefined`), budgets: { perTask: 3, perFamily: 9, stallMs: 1e9 } });
    assert.equal(stop.action, 'stop-and-report');
  } finally {
    f.done();
  }
});

// -------------------------------------------------------------------------------- capsule

test('capsule v2: constraints, changed files, open checks and hypotheses come from Jevris state with epistemic classes', async () => {
  const f = fixture();
  try {
    const m = parseManifest({ id: 'unit', argv: [process.execPath, '-e', 'process.exit(1)'], resultFormat: 'exit-code' }).manifest;
    await approveManifests(f.ws, [m], { unit: manifestHash(m) }, 'test');
    await runVerification(f.ws, { taskId: null, checkIds: [] });
    writeFileSync(join(f.repo, 'a.txt'), 'changed\n');
    await declare(f.ws, null, { objective: 'Ship the parser', constraints: ['C1: never touch prod'], hypotheses: [{ text: 'The flake is a timing bug' }], approvals: [{ id: 'ap1', scope: 'edit src', grantedAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-02T00:00:00Z' }] });
    const { capsule } = await assembleCapsule(f.ws, { taskId: null });
    const kinds = (k) => capsule.items.filter((i) => i.kind === k);
    assert.equal(kinds('constraint')[0].mandatory, true);
    assert.equal(kinds('constraint')[0].epistemic, 'fact');
    assert.equal(kinds('hypothesis')[0].epistemic, 'hypothesis');
    assert.ok(kinds('changed-file').some((i) => i.text.startsWith('a.txt')));
    assert.ok(kinds('open-check').some((i) => i.text.includes('unit')));
    assert.ok(kinds('unresolved').some((i) => i.text.includes('unit failed')));
    assert.equal(capsule.approvals[0].status, 'historical', 'an expired approval is history only');
    assert.match(capsule.contentHash, /^sha256:[0-9a-f]{64}$/);
  } finally {
    f.done();
  }
});

test('capsule: a receipt made stale by an edit is an open check at checkpoint time (JEV-0009)', async () => {
  const f = fixture();
  try {
    const m = parseManifest({ id: 'unit', argv: [process.execPath, '-e', 'process.exit(0)'], resultFormat: 'exit-code' }).manifest;
    await approveManifests(f.ws, [m], { unit: manifestHash(m) }, 'test');
    await runVerification(f.ws, { taskId: null, checkIds: [] });
    const before = (await assembleCapsule(f.ws, { taskId: null })).capsule;
    assert.equal(before.items.some((i) => i.kind === 'open-check'), false, 'a current passing receipt is not open');
    writeFileSync(join(f.repo, 'a.txt'), 'edited after the check\n');
    const after = (await assembleCapsule(f.ws, { taskId: null })).capsule;
    assert.ok(after.items.some((i) => i.kind === 'open-check' && i.text.includes('unit') && i.text.includes('stale receipt')));
    assert.ok(after.items.some((i) => i.kind === 'next-action' && i.text.includes('unit')));
  } finally {
    f.done();
  }
});

test('capsule: check lines say why a check is open and how it failed, in words, and mark a failure that is stale', async () => {
  const f = fixture();
  try {
    const m = parseManifest({ id: 'unit', argv: [process.execPath, '-e', 'process.exit(1)'], resultFormat: 'exit-code' }).manifest;
    await approveManifests(f.ws, [m], { unit: manifestHash(m) }, 'test');
    await runVerification(f.ws, { taskId: null, checkIds: [] });
    const current = (await assembleCapsule(f.ws, { taskId: null })).capsule;
    assert.deepEqual(current.items.filter((i) => i.kind === 'unresolved').map((i) => i.text), ['Check unit failed (exit code 1).'], 'a current failure reads as words, not the code exit:1');
    writeFileSync(join(f.repo, 'a.txt'), 'edited after the check\n');
    const stale = (await assembleCapsule(f.ws, { taskId: null })).capsule;
    assert.deepEqual(stale.items.filter((i) => i.kind === 'unresolved').map((i) => i.text), ['Check unit failed (exit code 1) before the latest changes and has not been re-run.'], 'a stale failure is not passed off as a fresh one');
    const open = stale.items.find((i) => i.kind === 'open-check' && i.text.includes('unit'));
    assert.match(open.text, /stale receipt: files it covers changed since it ran; its last outcome was failed/);
  } finally {
    f.done();
  }
});

test('capsule packing: mandatory first; over budget writes an immutable reference index behind a handle', async () => {
  const f = fixture();
  try {
    const constraints = Array.from({ length: 40 }, (_, i) => `K${String(i)}: constraint number ${String(i)} ${'must hold exactly as written '.repeat(4)}`);
    await declare(f.ws, null, { objective: 'o', constraints, decisions: [{ text: 'use tabs' }] });
    const { capsule } = await assembleCapsule(f.ws, { taskId: null, budgetTokens: 400 });
    assert.notEqual(capsule.referenceIndex, null);
    assert.equal(capsule.truncated, true);
    const bytes = f.ws.evidence.get(capsule.referenceIndex.handle, f.ws.workspaceId);
    const index = JSON.parse(new TextDecoder().decode(bytes));
    assert.equal(index.items.filter((i) => i.kind === 'constraint').length, 40, 'nothing silently dropped');
    assert.ok(capsule.items.some((i) => i.id === 'reference-index'));
    const roomy = (await assembleCapsule(f.ws, { taskId: null, budgetTokens: 20000 })).capsule;
    assert.equal(roomy.referenceIndex, null);
    assert.equal(roomy.ranking, 'rules');
  } finally {
    f.done();
  }
});

test('capsule: a v1.0 capsule upgrades to v2 with hypotheses kept as hypotheses', () => {
  const v1 = {
    id: 'cap1',
    schemaVersion: '1.0',
    workspaceId: 'ws-1',
    revision: 'r1',
    objective: 'obj',
    pinnedEvidence: [],
    optionalEvidence: [],
    taskIds: ['T1'],
    unresolvedItems: ['fix x'],
    hypotheses: ['maybe y'],
    authorizationHistoryRefs: ['auth1'],
    validUntil: '2030-01-01T00:00:00Z',
  };
  assert.equal(MemoryCapsuleContract.validate(v1).ok, true);
  const v2 = upgradeV1(v1);
  assert.equal(v2.schemaVersion, 'jevris-capsule-2');
  assert.equal(v2.items.find((i) => i.kind === 'hypothesis').epistemic, 'hypothesis');
  assert.equal(v2.approvals[0].status, 'historical');
});

// ---------------------------------------------------------------------------------- audit

const stable = (v) => (v === null || typeof v !== 'object' ? JSON.stringify(v) ?? 'null' : Array.isArray(v) ? `[${v.map(stable).join(',')}]` : `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`);

test('K2 (sidecar concurrency audit): two capsules written at once form one chain; the later supersedes the earlier, and each hash still matches its content', async () => {
  const f = fixture();
  try {
    await declare(f.ws, null, { objective: 'o', constraints: ['C1: never touch prod'] });
    const first = await writeCapsule(f.ws, { taskId: null });
    const [a, b] = await Promise.all([writeCapsule(f.ws, { taskId: null }), writeCapsule(f.ws, { taskId: null })]);
    const byId = new Map([a, b].map((c) => [c.id, c]));
    const latest = latestCapsule(f.ws, null);
    const older = latest.supersedes === first.id ? null : byId.get(latest.supersedes);
    assert.ok(older !== undefined && older !== null, 'the latest supersedes the other concurrent capsule, not the shared predecessor');
    assert.equal(older.supersedes, first.id);
    for (const c of [a, b]) {
      const { contentHash, ...body } = f.ws.state.get('capsules', c.id);
      assert.equal(contentHash, `sha256:${createHash('sha256').update(stable(body)).digest('hex')}`);
      assert.deepEqual(f.ws.state.get('capsules', c.id), byId.get(c.id), 'the returned capsule is the stored one');
    }
  } finally {
    f.done();
  }
});

test('omission audit: ids match on token boundaries (C1 is not C10) and a missing item is restored once', async () => {
  assert.equal(containsId('see C10 and C2', 'C1'), false);
  assert.equal(containsId('keep C1.', 'C1'), true);
  const f = fixture();
  try {
    await declare(f.ws, null, { objective: 'o', constraints: ['C1: never touch prod', 'C2: keep the public API'] });
    const capsule = await writeCapsule(f.ws, { taskId: null });
    const audit = await auditOmissions(f.ws, capsule, { summary: 'We agreed C10 and C2 hold. Objective: o' });
    assert.ok(audit.missing.some((m) => m.text.startsWith('C1:')));
    assert.ok(audit.present.some((m) => m.text.startsWith('C2:')));
    assert.equal(await queueRestore(f.ws, capsule.id, 's1', audit.missing.map((m) => m.itemId)), true);
    assert.equal(await queueRestore(f.ws, capsule.id, 's1', ['x']), false);
    const first = await takeRestore(f.ws, capsule, 's1');
    assert.ok(first.some((i) => i.text.startsWith('C1:')));
    assert.equal(await takeRestore(f.ws, capsule, 's1'), null, 'restored once');
  } finally {
    f.done();
  }
});

// ------------------------------------------------------------------------------ readiness

test('readiness: working budget from the registry; defer only with a certified signal, once, never on manual', async () => {
  const registry = { entries: [{ modelId: 'm1', contextTokens: 200000, maxOutputTokens: 32000 }] };
  const facts = budgetFromRegistry(registry, 'm1');
  assert.equal(workingBudget(facts), 200000 - 32000 - 12000 - 20000);
  assert.equal(budgetFromRegistry(registry, 'unknown'), null);
  const f = fixture();
  try {
    const high = { taskId: null, facts, usedTokens: 130000, episodeId: 'e1' };
    const r = await compactionReadiness(f.ws, high);
    assert.equal(r.boundary, 'recommend-boundary');
    assert.equal(r.nativeAllowed, true);
    assert.equal(r.deferred, false);
    assert.equal((await compactionReadiness(f.ws, { ...high, trigger: 'manual', certifiedSafeTrigger: true })).deferReason, 'MANUAL_NEVER_DEFERRED');
    assert.equal((await compactionReadiness(f.ws, { ...high, trigger: 'auto', certifiedSafeTrigger: true })).deferred, true);
    assert.equal((await compactionReadiness(f.ws, { ...high, trigger: 'auto', certifiedSafeTrigger: true })).deferred, false, 'at most once per episode');
  } finally {
    f.done();
  }
});

// -------------------------------------------------------------------------------- distill

test('distill: failures, exit code and handle are kept; the original bytes come back; binary and secrets pass through', async () => {
  const f = fixture();
  try {
    const lines = Array.from({ length: 3000 }, (_, i) => `ok ${String(i)} - passing test number ${String(i)}`);
    lines[1500] = 'not ok 1500 - parser handles empty input';
    lines[1501] = '  AssertionError: expected 0 to equal 1';
    const stdout = lines.join('\n');
    const r = await distillOutput(f.ws, { command: 'npm test', exitCode: 1, stdout, stderr: 'npm ERR! Test failed.', budgetTokens: 800 });
    assert.equal(r.mode, 'distilled');
    assert.match(r.text, /exit code: 1/);
    assert.match(r.text, /not ok 1500/);
    assert.match(r.text, /AssertionError/);
    assert.match(r.text, /npm ERR!/);
    assert.ok(r.text.includes(r.handle));
    assert.ok(r.omittedLines > 2000);
    const back = new TextDecoder().decode(f.ws.evidence.get(r.handle, f.ws.workspaceId));
    assert.equal(back, `${stdout}\nnpm ERR! Test failed.`);
    // US15: the original keeps its error state and the view's kept spans point into it.
    const rec = outputRecordOf(f.ws, r.handle);
    assert.equal(rec.exitCode, 1);
    assert.equal(rec.errorState, 'failed');
    assert.equal(rec.stderrOffset, Buffer.byteLength(stdout) + 1);
    assert.equal(back.slice(rec.stderrOffset), 'npm ERR! Test failed.');
    const raw = Buffer.from(back);
    const keptText = rec.keptSpans.map((sp) => raw.subarray(sp.startByte, sp.endByte).toString('utf8')).join('\n');
    assert.match(keptText, /not ok 1500 - parser handles empty input\n {2}AssertionError: expected 0 to equal 1/);
    assert.equal(rec.keptSpans.reduce((n, sp) => n + sp.endLine - sp.startLine, 0), rec.keptLines);
    assert.equal(rec.viewText, r.text);
    const bin = await distillOutput(f.ws, { command: null, exitCode: 0, stdout: new Uint8Array([0, 1, 2, 3]) });
    assert.equal(bin.passthroughReason, 'binary');
    const secret = await distillOutput(f.ws, { command: null, exitCode: 0, stdout: `${'x\n'.repeat(5000)}token sk-ant-api03-abcdefghijklmnop` });
    assert.equal(secret.passthroughReason, 'sensitive');
  } finally {
    f.done();
  }
});

// ------------------------------------------------------------------------------ rehydrate

test('rehydrate: resolves from Jevris state, flags a moved HEAD and keeps expired approvals as history', async () => {
  const f = fixture();
  try {
    await declare(f.ws, null, { objective: 'Finish the importer', constraints: ['Keep the CLI flags stable'], approvals: [{ id: 'ap', scope: 'push to main', grantedAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-02T00:00:00Z' }] });
    await writeCapsule(f.ws, { taskId: null });
    writeFileSync(join(f.repo, 'b.txt'), 'b\n');
    git(f.repo, 'add', '.');
    git(f.repo, 'commit', '-q', '-m', 'two');
    const r = await rehydrate(f.ws, { taskId: null });
    assert.equal(r.found, true);
    assert.equal(r.validity.headMatches, false);
    assert.match(r.additionalContext, /advice only/);
    assert.match(r.additionalContext, /HEAD moved/);
    assert.match(r.additionalContext, /Keep the CLI flags stable/);
    assert.match(r.additionalContext, /History only \(expired\): push to main/);
    assert.doesNotMatch(r.additionalContext, /Approval in force/);
    assert.ok(r.additionalContext.length <= 8000);
  } finally {
    f.done();
  }
});

// -------------------------------------------------------------------------------- handoff

test('handoff: exporting an unknown task id is not found and never exports an unrelated capsule (JEV-0014)', async () => {
  const f = fixture();
  try {
    await declare(f.ws, null, { objective: 'Port the parser' });
    await writeCapsule(f.ws, { taskId: null });
    await writeCapsule(f.ws, { taskId: 'T1' });
    const unknown = exportPortable(f.ws, { capsuleId: null, taskId: 'nope' });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.reasonCode, 'NOT_FOUND');
    assert.equal(exportPortable(f.ws, { capsuleId: null, taskId: 'T1' }).ok, true, 'a task with its own capsule exports it');
    assert.equal(exportPortable(f.ws, { capsuleId: null, taskId: null }).ok, true, 'no task id exports the newest workspace capsule');
  } finally {
    f.done();
  }
});

test('handoff: Claude to OpenCode and Claude to Codex negotiate actuate, advice-only and unresolved tool refs', async () => {
  const f = fixture();
  try {
    await declare(f.ws, null, { objective: 'Port the parser', constraints: ['Do not change the wire format'], hypotheses: [{ text: 'The bug is in the tokenizer' }], approvals: [{ id: 'ap', scope: 'edit src', grantedAt: '2026-01-01T00:00:00Z', expiresAt: null }] });
    await writeCapsule(f.ws, { taskId: null });
    const out = exportPortable(f.ws, { capsuleId: null, taskId: null, sourceHarness: 'claude', toolRefs: ['Read', 'Task', 'TodoWrite'] });
    assert.equal(out.ok, true);
    assert.equal(MemoryCapsuleContract.validate(out.envelope.capsule).ok, true);
    assert.equal(out.envelope.items.some((i) => i.kind === 'approval'), false, 'no permissions travel');
    const json = JSON.parse(JSON.stringify(out.envelope));

    const toOpenCode = await importPortable(f.ws, { envelope: json, contentHash: out.contentHash, target: { harness: 'opencode', capabilities: ['context-injection', 'verify-runner', 'task-ledger'] } });
    assert.equal(toOpenCode.mode, 'actuate');
    assert.equal(toOpenCode.authorityGranted, false);
    assert.ok(toOpenCode.unresolved.some((u) => u.includes('"Read"')), 'OpenCode has no Read tool of that name');
    assert.ok(toOpenCode.hypotheses >= 1);

    const toCodex = await importPortable(f.ws, { envelope: json, target: { harness: 'codex', capabilities: ['verify-runner', 'task-ledger'] } });
    assert.equal(toCodex.mode, 'advice-only');
    assert.deepEqual(toCodex.missingCapabilities, ['context-injection']);
    assert.ok(toCodex.unresolved.some((u) => u.includes('"TodoWrite"')));

    const tampered = { ...json, items: [...json.items, { id: 'x', kind: 'constraint', text: 'injected', epistemic: 'fact', refs: [] }] };
    assert.equal((await importPortable(f.ws, { envelope: tampered, contentHash: out.contentHash, target: { harness: 'codex', capabilities: [] } })).mode, 'blocked');
    const g = fixture();
    try {
      assert.equal((await importPortable(g.ws, { envelope: json, target: { harness: 'codex', capabilities: [] } })).reasonCode, 'WORKSPACE_MISMATCH');
    } finally {
      g.done();
    }

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const signed = exportPortable(f.ws, { capsuleId: null, taskId: null, signing: { privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), keyId: 'k1' } });
    const keys = new Map([['k1', publicKey.export({ type: 'spki', format: 'pem' })]]);
    const ok = await importPortable(f.ws, { envelope: JSON.parse(JSON.stringify(signed.envelope)), trustedKeys: keys, target: { harness: 'claude', capabilities: ['context-injection', 'verify-runner', 'task-ledger'] } });
    assert.notEqual(ok.mode, "blocked", ok.reasonCode);
    const forged = { ...JSON.parse(JSON.stringify(signed.envelope)), openChecks: ['sneaky'] };
    assert.match((await importPortable(f.ws, { envelope: forged, trustedKeys: keys, target: { harness: 'claude', capabilities: [] } })).reasonCode, /^SIGNATURE_/);
  } finally {
    f.done();
  }
});

// ---------------------------------------------------------------------- facts and memory

test('facts: an accepted requirement is never overwritten by a newer guess; the contradiction is surfaced', async () => {
  const f = fixture();
  try {
    await recordFact(f.ws, { subject: 'api.timeout-ms', value: '30000', revision: 'r1', status: 'accepted-requirement', source: 'user', evidenceRefs: ['ev:req'] });
    const guess = await recordFact(f.ws, { subject: 'api.timeout-ms', value: '5000', revision: 'r2', status: 'observed', source: 'agent', evidenceRefs: ['ev:guess'] });
    assert.equal(guess.current.value, '30000');
    assert.equal(guess.fact.heldBack, true);
    const found = await triageContradictions(f.ws);
    assert.equal(found.length, 1);
    assert.equal(found[0].requirementProtected, true);
    assert.deepEqual([...found[0].originals].sort(), ['ev:guess', 'ev:req']);
  } finally {
    f.done();
  }
});

test('project memory: only verified or approved facts are admitted, and retrieval honours scopes', async () => {
  const f = fixture();
  try {
    const refused = await admitProjectMemory(f.ws, { scope: 'org', kind: 'decision', text: 'We use tabs', revision: 'r1' });
    assert.deepEqual(refused, { ok: false, reasonCode: 'UNVERIFIED' });
    const bad = await admitProjectMemory(f.ws, { scope: 'org', kind: 'decision', text: 'x', revision: 'r1', receiptIds: ['nope'] });
    assert.equal(bad.reasonCode, 'RECEIPT_NOT_PASSING');
    assert.equal((await admitProjectMemory(f.ws, { scope: 'module:src/parser', kind: 'ownership', text: 'The parser module is owned by the core team', revision: 'r1', approvedBy: 'lead' })).ok, true);
    assert.equal((await admitProjectMemory(f.ws, { scope: `workspace:${f.ws.workspaceId}`, kind: 'decision', text: 'Parser errors use typed codes', revision: 'r1', approvedBy: 'lead' })).ok, true);
    const mine = await retrieveProjectMemory(f.ws, { scopes: [`workspace:${f.ws.workspaceId}`], query: 'parser errors' });
    assert.equal(mine.length, 1);
    assert.match(mine[0].text, /typed codes/);
    const mod = await retrieveProjectMemory(f.ws, { scopes: ['module:src'], query: 'parser owned' });
    assert.equal(mod.length, 1);
  } finally {
    f.done();
  }
});

test('recover: a repeated source failure with the repair budget spent escalates once through the bounded escalation, then reports blocked; an environment failure is never escalated (W02)', async () => {
  const f = fixture();
  try {
    const cfg = jevrisPaths({ home: f.ws.home }).config;
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, managedWorkers: 'bounded-auto' }, orchestration: { ...DEFAULT_CONFIG.orchestration, enabled: true } }));
    const again = (fp) => op('recover').handle(f.ctx('recover', { taskId: 'T9', signals: { fingerprints: [fp, fp, fp] } }));
    const first = contract('recover', await again('E1 AssertionError parse.py:10'));
    assert.equal(first.classification, 'repeated-failure');
    assert.match(first.advice, /One escalation recorded\. Success requires a new current receipt\. No worker was launched\./);
    const second = contract('recover', await again('E1 AssertionError parse.py:10'));
    assert.match(second.advice, /Blocked report/);
    const env = contract('recover', await op('recover').handle(f.ctx('recover', { taskId: 'T8', signals: { fingerprints: ['ECONNREFUSED 127.0.0.1:5432 connection refused', 'ECONNREFUSED 127.0.0.1:5432 connection refused', 'ECONNREFUSED 127.0.0.1:5432 connection refused'] } })));
    if (env.classification === 'environment-failure') assert.match(env.advice, /request environment evidence\. An environment failure is not escalated/);
    assert.doesNotMatch(env.advice, /escalation recorded/);
  } finally {
    f.done();
  }
});

// ------------------------------------------------------------------------------------ ops

test('ops: checkpoint, recover, evidence.select and handoff bodies validate against their payload contracts', async () => {
  const f = fixture();
  try {
    for (const name of ['checkpoint', 'recover', 'evidence.select', 'handoff.export', 'handoff.import']) assert.ok(op(name), name);
    assert.equal(op('checkpoint').scope, 'checkpoint');
    assert.equal(op('recover').scope, 'advice');
    const cp = contract('checkpoint', await op('checkpoint').handle(f.ctx('checkpoint', { objective: 'Fix the importer', constraints: ['Keep API stable'], taskId: null })));
    assert.equal(cp.written, true);
    assert.equal(cp.compactionTriggered, false);
    assert.equal(cp.retained.constraints, 1);
    const rec = contract('recover', await op('recover').handle(f.ctx('recover', { taskId: null, signals: { fingerprints: ['E1 boom', 'E1 boom', 'E1 boom'], environment: [false, false, false] }, rejectedApproaches: ['Tried pinning the version'] })));
    assert.equal(rec.classification, 'repeated-failure');
    assert.ok(rec.rejectedApproaches.includes('Tried pinning the version'));
    const sel = contract('evidence.select', await op('evidence.select').handle(f.ctx('evidence.select', { intent: 'importer', maxItems: 5 })));
    assert.equal(sel.items[0].kind, 'capsule');
    const ex = contract('handoff.export', await op('handoff.export').handle(f.ctx('handoff.export', { capsuleId: null, taskId: null })));
    assert.equal(ex.found, true);
    const im = contract('handoff.import', await op('handoff.import').handle(f.ctx('handoff.import', { capsule: ex.capsule })));
    assert.equal(im.accepted, true);
    assert.equal(im.authorityGranted, false);
    assert.ok(['actuate', 'advice-only'].includes(im.mode), im.mode);
    assert.ok(Array.isArray(im.missingCapabilities));
    const bad = contract('handoff.import', await op('handoff.import').handle(f.ctx('handoff.import', { capsule: { nope: true } })));
    assert.equal(bad.accepted, false);
    assert.equal(bad.mode, 'blocked');
  } finally {
    f.done();
  }
});

// ----------------------------------------------------------------------------- subscriber

function record(harness) {
  return {
    id: 'cert1',
    schemaVersion: '1.0',
    harness,
    actuatorId: 'context',
    harnessVersionRange: { minimum: '2.0.0', maximumExclusive: '3.0.0' },
    operatingSystems: ['darwin', 'linux', 'win32'],
    models: [],
    tools: [],
    limitations: [],
    fixtureSuiteHash: `sha256:${'a'.repeat(64)}`,
    features: [{ featureId: CONTEXT_FEATURE, status: 'certified', reasonCode: null }],
    certifiedAt: '2026-01-01T00:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z',
    signature: { algorithm: 'ed25519', keyId: 'k', value: 'AAAA' },
  };
}

function event(f, kind, extra = {}, deliveryKey = `${kind}-${Math.random()}`) {
  return f.ctx('event', {
    envelope: { schemaVersion: '1.0', harness: 'claude', nativeEventName: 'X', kind, sessionId: 's1', turnId: null, toolUseId: null, toolName: null, agentId: null, model: null, permissionMode: null, cwd: f.repo, trigger: null, blocking: false, responseRequired: false, payload: {}, dedupKey: 'd', ...extra },
    deliveryKey,
  });
}

test('subscriber: a compaction writes a capsule; a certified resume restores it once as context', async () => {
  const f = fixture();
  setCertificationGate(certificationGateFrom(async () => [record('claude')], () => '2.1.0'));
  try {
    assert.equal(sidecarEventSubscribers[0].name, 'orchestrator');
    await declare(f.ws, null, { objective: 'Keep going', constraints: ['C7: never force-push'] });
    const pre = await handleHookEvent(event(f, 'context.compacting', { trigger: 'auto' }));
    assert.deepEqual(pre.hookOutcome, { kind: 'observe' });
    const start = await handleHookEvent(event(f, 'session.started', { trigger: 'compact' }));
    assert.equal(start.hookOutcome.kind, 'context');
    assert.equal(start.certified, true);
    assert.match(start.hookOutcome.text, /C7: never force-push/);
    const again = await handleHookEvent(event(f, 'session.started', { trigger: 'compact' }));
    assert.equal(again.hookOutcome.kind, 'observe', 'restored once');
  } finally {
    setCertificationGate(null);
    f.done();
  }
});

test('owner decision c065d52 (RAN_HERE), R12: a main session\'s reported model and a Kilo or OpenCode answer\'s model are recorded as run on their harness, in the background; a subagent\'s start and an unknown id are not', async () => {
  const f = fixture();
  try {
    assert.equal((await handleHookEvent(event(f, 'session.started', { trigger: 'startup', model: 'claude-opus-5-5[1m]' }))).hookOutcome.kind, 'observe');
    await handleHookEvent(event(f, 'session.started', { trigger: 'startup', sessionId: 's2', agentId: 'sub-1', model: 'claude-haiku-4-5-20251001' }));
    await handleHookEvent(event(f, 'session.started', { trigger: 'startup', sessionId: 's3', model: 'not a model id' }));
    await drainSessionModels();
    const offer = await readModelOffer(f.ws.home);
    assert.deepEqual(offer.runs.map((r) => [r.harness, r.authMode, r.modelId, r.raw, r.servingHost, r.source]), [['claude', 'unknown', 'claude-opus-5-5', 'claude-opus-5-5[1m]', 'anthropic', 'reported']], 'R42: the raw spelling and its host');
    // R12: on Kilo and OpenCode the model that answered (message.completed) counts, a child
    // session's too; the same model again within minutes is not written again.
    for (const agentId of [null, 'child-1', null]) {
      await handleHookEvent(event(f, 'message.completed', { harness: 'opencode', sessionId: 'oc-1', agentId, model: 'anthropic/claude-sonnet-5' }));
    }
    await handleHookEvent(event(f, 'message.completed', { harness: 'opencode', sessionId: 'oc-1', model: 'nobody/unknown-model-9' }));
    // R42 and R38: a gateway spelling the bundled snapshot pins is recorded as served by the gateway, never as the maker's own run.
    await handleHookEvent(event(f, 'message.completed', { harness: 'kilocode', sessionId: 'kc-1', model: 'openrouter/moonshotai/kimi-k3' }));
    // A maker's second endpoint is its own spelling, served by the maker.
    await handleHookEvent(event(f, 'message.completed', { harness: 'kilocode', sessionId: 'kc-1', model: 'moonshotai-cn/kimi-k3' }));
    await drainSessionModels();
    const after = await readModelOffer(f.ws.home);
    assert.deepEqual(after.runs.map((r) => [r.harness, r.modelId, r.raw, r.servingHost, r.source]).sort(), [
      ['claude', 'claude-opus-5-5', 'claude-opus-5-5[1m]', 'anthropic', 'reported'],
      ['kilocode', 'kimi-k3', 'moonshotai-cn/kimi-k3', 'moonshot', 'reported'],
      ['kilocode', 'kimi-k3', 'openrouter/moonshotai/kimi-k3', 'openrouter', 'reported'],
      ['opencode', 'claude-sonnet-5', 'anthropic/claude-sonnet-5', 'anthropic', 'reported'],
    ]);
  } finally {
    f.done();
  }
});

test('R42: a Kilo answer and a Kilo child on a gateway spelling the registry pins are recorded with that spelling and served by the gateway, never as the maker\'s own run', async () => {
  const f = fixture();
  try {
    const R = BUNDLED_MODEL_REGISTRY;
    const tariff = { ...R.entries.find((e) => e.modelId === 'kimi-k3').tariff, version: 'openrouter-2026-09-27', sourceId: 'MODELSDEV-TEST' };
    const placed = {
      ...R,
      harnessHosts: [{ harness: 'kilocode', host: 'openrouter', segment: 'openrouter', signIns: ['api-key'], sourceIds: ['MODELSDEV-TEST'] }],
      servings: [{ host: 'openrouter', provider: 'moonshot', modelId: 'kimi-k3', hostModelId: 'moonshotai/kimi-k3', tariff, tariffBasis: 'host', sourceIds: ['MODELSDEV-TEST'] }],
    };
    const file = modelRegistryFile(f.ws.home);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(placed));
    await handleHookEvent(event(f, 'worker.started', { harness: 'kilocode', sessionId: 'kc-1', agentId: 'ses_k1', parentSessionId: 'kc-1', payload: { agentType: 'general' } }));
    await drainSubagentRuns();
    await handleHookEvent(event(f, 'message.completed', { harness: 'kilocode', sessionId: 'kc-1', model: 'openrouter/moonshotai/kimi-k3' }));
    await handleHookEvent(event(f, 'message.completed', { harness: 'kilocode', sessionId: 'kc-1', agentId: 'ses_k1', model: 'openrouter/moonshotai/kimi-k3' }));
    await drainSessionModels();
    await drainSubagentRuns();
    const offer = await readModelOffer(f.ws.home);
    assert.deepEqual(offer.runs.map((r) => [r.harness, r.modelId, r.raw, r.servingHost, r.source]), [['kilocode', 'kimi-k3', 'openrouter/moonshotai/kimi-k3', 'openrouter', 'reported']]);
    const child = f.ws.state.list(SUBAGENT_RUNS).find((r) => r.agentId === 'ses_k1');
    assert.deepEqual([child.reportedModel, child.reportedRaw, child.servingHost], ['kimi-k3', 'openrouter/moonshotai/kimi-k3', 'openrouter']);
  } finally {
    f.done();
  }
});

test('P9: a restore keeps how it went and what followed (a re-ask, a repeated failure family, a check, verification), ids and counts only; an uncertified one is refused', async () => {
  const f = fixture();
  setCertificationGate(certificationGateFrom(async () => [record('claude')], () => '2.1.0'));
  try {
    await declare(f.ws, null, { objective: 'Keep going', constraints: ['C7: never force-push'] });
    const fail = () => handleHookEvent(event(f, 'tool.failed', { toolName: 'Bash', payload: { toolInputKeys: ['command'], toolInputBytes: 20, toolResponseBytes: 300 } }));
    await fail();
    await handleHookEvent(event(f, 'context.compacting', { trigger: 'auto' }));
    assert.equal((await handleHookEvent(event(f, 'session.started', { trigger: 'compact' }))).hookOutcome.kind, 'context');
    await drainRestoreOutcomes();
    const rows = () => f.ws.state.list(RESTORE_OUTCOMES);
    const [row] = rows();
    assert.deepEqual([row.sessionId, row.state, row.reasonCode, row.omittedItemIds, row.invalid, row.attempts], ['s1', 'delivered', 'CAPSULE_RESTORED', [], [], 1]);
    assert.ok(row.mandatoryItems >= 1 && row.priorFamilies.length === 1, JSON.stringify(row));
    // What followed: the session asks again, the same failure comes back, a check runs, the stop verifies.
    await handleHookEvent(event(f, 'session.started', { trigger: 'compact' }));
    await fail();
    const m = parseManifest({ id: 'unit', argv: [process.execPath, '-e', 'process.exit(0)'], resultFormat: 'exit-code' }).manifest;
    await approveManifests(f.ws, [m], { unit: manifestHash(m) }, 'test');
    await runVerification(f.ws, { taskId: null, checkIds: [] });
    assert.equal((await handleHookEvent(event(f, 'turn.stopped', { payload: { stopHookActive: false } }))).reasonCode, 'VERIFIED');
    await drainRestoreOutcomes();
    const [after] = rows();
    assert.deepEqual([after.reasks, after.failuresWatched, after.repeatFamilies, after.checkStartedMs !== null, after.verifiedAtMs !== null], [1, 1, 1, true, true]);
    assert.doesNotMatch(JSON.stringify(rows()), /force-push|Keep going|Bash/);
    // Another session on a harness not certified for context: refused, and it follows nothing up.
    setCertificationGate(certificationGateFrom(async () => [record('codex')], () => '2.1.0'));
    await handleHookEvent(event(f, 'session.started', { trigger: 'compact', sessionId: 's2' }));
    await drainRestoreOutcomes();
    const refused = rows().find((r) => r.sessionId === 's2');
    assert.deepEqual([refused.state, refused.omittedItemIds], ['refused', []]);
    assert.deepEqual(restoreSummary(f.ws), { delivered: 1, degraded: 0, refused: 1, omittedItems: 0, reasked: 1, withRepeats: 1, checkStarted: 1, verified: 1 });
  } finally {
    setCertificationGate(null);
    await drainRestoreOutcomes();
    f.done();
  }
});

test('P13: SubagentStart and SubagentStop keep the harness, subagent type, slice and times, and a later verified parent Stop marks the stopped ones; ids, codes and times only', async () => {
  const f = fixture();
  let now = 1_000_000;
  setSubscriberClock(() => now);
  try {
    const sub = (kind, agentId, agentType, extra = {}) => handleHookEvent(event(f, kind, { agentId, parentSessionId: 's1', payload: { agentType, lastAssistantMessageBytes: 900 }, ...extra }));
    // C's note for the Explore launch (its PreToolUse answer): D claims it at SubagentStart.
    clearSubagentRouteNotes();
    assert.equal(noteSubagentRoute({ workspaceId: f.ws.workspaceId, sessionId: 's1', subagentType: 'Explore', reasonCode: 'NO_EVIDENCE', outcome: 'abstained', atMs: now - 500 }), true);
    const started = await sub('worker.started', 'a1', 'Explore');
    assert.deepEqual(started, { hookOutcome: { kind: 'observe' }, certified: false, reasonCode: 'SUBAGENT_RECORDED' });
    await sub('worker.started', 'a2', 'general-purpose');
    now += 4_000;
    await sub('worker.finished', 'a1', 'Explore');
    // A stop without a seen start (it began before Jevris), and a type that is not a safe slice key.
    await sub('worker.finished', 'a3', 'bad type!');
    // Not a subagent: no agent id.
    await sub('worker.started', null, 'Explore');
    // Codex (SubagentStart and SubagentStop with agent_type) and OpenCode (a child session, no type):
    // the same timing record, keyed by harness; C routes a subagent on both (R20), so a launch with
    // no note is unknown, not not-applicable. Only Antigravity's is not applicable.
    await sub('worker.started', 'a1', 'Explore', { harness: 'codex' });
    await sub('worker.started', 'ses_child', undefined, { harness: 'opencode' });
    await sub('worker.finished', 'ses_child', undefined, { harness: 'opencode' });
    await sub('worker.started', 'g1', 'research', { harness: 'antigravity' });
    await drainSubagentRuns();
    const all = () => f.ws.state.list(SUBAGENT_RUNS);
    assert.deepEqual(all().filter((r) => r.harness !== 'claude').map((r) => [r.harness, r.agentId, r.sliceId, r.route, r.stops]).sort(), [['antigravity', 'g1', 'subagent:research', 'not-applicable', 0], ['codex', 'a1', 'subagent:Explore', null, 0], ['opencode', 'ses_child', null, null, 1]]);
    const row = (id) => all().find((r) => r.agentId === id && r.harness === 'claude');
    assert.deepEqual([row('a1').sliceId, row('a1').startedAtMs, row('a1').stoppedAtMs, row('a1').stops, row('a1').route], ['subagent:Explore', 1_000_000, 1_004_000, 1, { outcome: 'abstained', reasonCode: 'NO_EVIDENCE' }]);
    assert.equal(row('a2').route, null, 'no note for that type');
    assert.deepEqual([row('a2').sliceId, row('a2').stoppedAtMs], ['subagent:general-purpose', null]);
    assert.deepEqual([row('a3').subagentType, row('a3').sliceId, row('a3').startedAtMs], [null, null, null]);
    assert.equal(all().filter((r) => r.harness === 'claude').length, 3);
    // The parent's Stop verifies: only the subagents that had stopped are marked.
    const m = parseManifest({ id: 'unit', argv: [process.execPath, '-e', 'process.exit(0)'], resultFormat: 'exit-code' }).manifest;
    await approveManifests(f.ws, [m], { unit: manifestHash(m) }, 'test');
    await runVerification(f.ws, { taskId: null, checkIds: [] });
    now += 1_000;
    assert.equal((await handleHookEvent(event(f, 'turn.stopped', { payload: { stopHookActive: false } }))).reasonCode, 'VERIFIED');
    await drainSubagentRuns();
    assert.deepEqual([row('a1').parentVerifiedAtMs, row('a2').parentVerifiedAtMs, row('a3').parentVerifiedAtMs], [1_005_000, null, 1_005_000]);
    const summary = subagentSummary(f.ws);
    assert.deepEqual({ ...summary, types: undefined }, { runs: 6, running: 3, finished: 3, parentVerified: 2, routes: { proposed: 0, rendered: 0, explained: 0, abstained: 1, 'not-applicable': 1, unknown: 4 }, harnesses: { antigravity: 1, claude: 3, codex: 1, opencode: 1 }, types: undefined });
    assert.deepEqual(summary.types.find((t) => t.sliceId === 'subagent:Explore'), { sliceId: 'subagent:Explore', runs: 2, finished: 1, medianDurationMs: 4_000, routed: 0, parentVerified: 1 });
    // learning.report carries the counts.
    const report = await op('learning.report').handle(f.ctx('learning.report', {}));
    assert.equal(report.body.subagents.runs, 6);
    // The payload byte count (900) is not kept: match it as a value, not inside the random workspace id.
    assert.doesNotMatch(JSON.stringify(f.ws.state.list(SUBAGENT_RUNS)), /:900\b|lastAssistant/);
  } finally {
    setSubscriberClock(undefined);
    await drainSubagentRuns();
    await drainRouteLearning();
    f.done();
  }
});

test('R20: a parent Stop with a verdict from a mandatory receipt labels its stopped subagents once, on every routable harness, on the model they ran; a launch that named a model is never recorded', async () => {
  const f = fixture();
  let now = 2_000_000;
  setSubscriberClock(() => now);
  const events = [];
  setRouteLearner(async (input) => {
    events.push({ ...input.event, baselineModelId: input.baselineModelId, eligibleModelIds: input.eligibleModelIds });
    return { recorded: true, reasonCode: null, regression: null, promotion: null, proposalId: null, version: 0, saved: true };
  });
  try {
    clearSubagentRouteNotes();
    const note = (sessionId, subagentType, reasonCode, outcome, modelId = null) => noteSubagentRoute({ workspaceId: f.ws.workspaceId, sessionId, subagentType, reasonCode, outcome, atMs: now - 100, modelId });
    const sub = (kind, sessionId, agentId, agentType, extra = {}) => handleHookEvent(event(f, kind, { sessionId, agentId, parentSessionId: sessionId, payload: { agentType }, ...extra }));
    // Claude Code: one launch the route abstained on (the default ran), one the person named a model for.
    note('s1', 'Explore', 'NO_EVIDENCE', 'abstained');
    note('s1', 'Plan', 'EXPLICIT_MODEL', 'abstained');
    // A route the harness applied (C's note names its model, c640d8c): recorded on that model.
    note('s1', 'Build', 'SUBAGENT_ROUTE_LEARNED', 'proposed', 'claude-haiku-4-5');
    note('s1', 'Build', 'SUBAGENT_ROUTE_LEARNED', 'rendered');
    await sub('worker.started', 's1', 'c1', 'Explore');
    await sub('worker.started', 's1', 'c2', 'Plan');
    await sub('worker.started', 's1', 'c4', 'Build');
    // OpenCode: a child that names the model it ran; Codex: a launch with no note and no model.
    await sub('worker.started', 's1', 'ses_c1', 'general', { harness: 'opencode' });
    await handleHookEvent(event(f, 'message.completed', { harness: 'opencode', sessionId: 's1', agentId: 'ses_c1', model: 'anthropic/claude-sonnet-5' }));
    await sub('worker.started', 's1', 'x1', 'worker', { harness: 'codex' });
    // Still running at the Stop: not labelled.
    note('s1', 'Explore', 'NO_EVIDENCE', 'abstained');
    await sub('worker.started', 's1', 'c3', 'Explore');
    now += 1_000;
    for (const [agentId, harness] of [['c1', 'claude'], ['c2', 'claude'], ['c4', 'claude'], ['ses_c1', 'opencode'], ['x1', 'codex']]) await sub('worker.finished', 's1', agentId, undefined, { harness });
    await drainSubagentRuns();
    const m = parseManifest({ id: 'unit', argv: [process.execPath, '-e', 'process.exit(0)'], resultFormat: 'exit-code' }).manifest;
    await approveManifests(f.ws, [m], { unit: manifestHash(m) }, 'test');
    await runVerification(f.ws, { taskId: null, checkIds: [] });
    now += 1_000;
    for (const harness of ['claude', 'opencode', 'codex']) await handleHookEvent(event(f, 'turn.stopped', { harness, payload: { stopHookActive: false } }));
    await drainSubagentRuns();
    await drainRouteLearning();
    const row = (id) => f.ws.state.list(SUBAGENT_RUNS).find((r) => r.agentId === id);
    assert.deepEqual(['c1', 'c2', 'c4', 'ses_c1', 'x1', 'c3'].map((id) => row(id).learned?.reasonCode ?? null), ['RECORDED', 'EXPLICIT_MODEL', 'RECORDED', 'RECORDED', 'NO_ROUTE_NOTE', null]);
    assert.deepEqual(row('c4').route, { outcome: 'rendered', reasonCode: 'SUBAGENT_ROUTE_LEARNED', modelId: 'claude-haiku-4-5' });
    assert.deepEqual([row('ses_c1').reportedModel, row('ses_c1').reportedRaw, row('ses_c1').servingHost], ['claude-sonnet-5', 'anthropic/claude-sonnet-5', 'anthropic'], 'R42: the raw spelling and its host are kept');
    const byRoute = Object.fromEntries(events.map((e) => [e.routeId, e]));
    assert.deepEqual(Object.keys(byRoute).sort(), ['subagent:none:c1', 'subagent:none:c4', 'subagent:none:ses_c1']);
    assert.deepEqual([byRoute['subagent:none:c4'].sliceId, byRoute['subagent:none:c4'].modelId], ['subagent:Build', 'claude-haiku-4-5']);
    const c1 = byRoute['subagent:none:c1'];
    assert.deepEqual([c1.sliceId, c1.modelId, c1.kind, c1.labelSource, c1.explored, c1.propensity, c1.costMicroUsd, c1.latencyMs, c1.tokens, c1.rulesModelId], ['subagent:Explore', c1.baselineModelId, 'verified-pass', 'verification-receipt', false, null, null, null, null, null]);
    assert.match(c1.receiptId, /\S/);
    assert.deepEqual([byRoute['subagent:none:ses_c1'].sliceId, byRoute['subagent:none:ses_c1'].modelId], ['subagent:general', 'claude-sonnet-5']);
    assert.ok(byRoute['subagent:none:ses_c1'].eligibleModelIds.includes('claude-sonnet-5'));
    // A second verified Stop labels nothing again; a failing receipt later labels only what stopped since.
    const count = events.length;
    await handleHookEvent(event(f, 'turn.stopped', { payload: { stopHookActive: false } }));
    await drainSubagentRuns();
    await drainRouteLearning();
    assert.equal(events.length, count);
    now += 1_000;
    await sub('worker.finished', 's1', 'c3', undefined);
    await drainSubagentRuns();
    const bad = parseManifest({ id: 'unit', argv: [process.execPath, '-e', 'process.exit(1)'], resultFormat: 'exit-code' }).manifest;
    await approveManifests(f.ws, [bad], { unit: manifestHash(bad) }, 'test');
    await runVerification(f.ws, { taskId: null, checkIds: [] });
    now += 1_000;
    await handleHookEvent(event(f, 'turn.stopped', { payload: { stopHookActive: false } }));
    await drainSubagentRuns();
    await drainRouteLearning();
    assert.deepEqual(events.slice(count).map((e) => [e.routeId, e.kind]), [['subagent:none:c3', 'verified-fail']]);
  } finally {
    setRouteLearner(null);
    setSubscriberClock(undefined);
    await drainSubagentRuns();
    f.done();
  }
});

test('subscriber: uncertified (wrong version, no record, other harness) gives observe; a duplicate delivery gives observe', async () => {
  const f = fixture();
  try {
    await declare(f.ws, null, { objective: 'o', constraints: ['c'] });
    await handleHookEvent(event(f, 'context.compacting'));
    setCertificationGate(certificationGateFrom(async () => [record('claude')], () => '3.5.0'));
    const wrongVersion = await handleHookEvent(event(f, 'session.started', { trigger: 'compact' }));
    assert.deepEqual(wrongVersion, { hookOutcome: { kind: 'observe' }, certified: false, reasonCode: 'VERSION_OUT_OF_RANGE' });
    setCertificationGate(certificationGateFrom(async () => [record('codex')], () => '2.1.0'));
    assert.equal((await handleHookEvent(event(f, 'session.started', { trigger: 'compact' }))).hookOutcome.kind, 'observe');
    setCertificationGate(certificationGateFrom(async () => [], () => null));
    assert.equal((await handleHookEvent(event(f, 'session.started', { trigger: 'compact' }))).reasonCode, 'HARNESS_VERSION_UNKNOWN');
    // Still pending: a later certified start restores it.
    setCertificationGate(certificationGateFrom(async () => [record('claude')], () => '2.1.0'));
    const dupKey = 'same-delivery';
    const first = await handleHookEvent(event(f, 'session.started', { trigger: 'compact' }, dupKey));
    assert.equal(first.hookOutcome.kind, 'context');
    const dup = await handleHookEvent(event(f, 'session.started', { trigger: 'compact' }, dupKey));
    assert.deepEqual(dup, { hookOutcome: { kind: 'observe' }, certified: false, reasonCode: 'DUPLICATE_DELIVERY' });
  } finally {
    setCertificationGate(null);
    f.done();
  }
});

test('subscriber: a second compaction of one session with the same delivery key is handled after the dedup window, and delivery records stay bounded', async () => {
  const f = fixture();
  let now = 1_800_000_000_000;
  setSubscriberClock(() => now);
  setCertificationGate(certificationGateFrom(async () => [record('claude')], () => '2.1.0'));
  try {
    await declare(f.ws, null, { objective: 'Long session', constraints: ['C9: keep the public API'] });
    // Keys as the adapter derives them without a turn id: the same for every compaction.
    assert.equal((await handleHookEvent(event(f, 'context.compacting', { trigger: 'auto' }, 'pre-s1'))).reasonCode, 'CAPSULE_WRITTEN');
    assert.equal((await handleHookEvent(event(f, 'session.started', { trigger: 'compact' }, 'start-s1'))).hookOutcome.kind, 'context');
    now += 30_000;
    assert.equal((await handleHookEvent(event(f, 'session.started', { trigger: 'compact' }, 'start-s1'))).reasonCode, 'DUPLICATE_DELIVERY', 'a quick retry is a redelivery');
    now += DELIVERY_DEDUP_WINDOW_MS;
    assert.equal((await handleHookEvent(event(f, 'context.compacting', { trigger: 'auto' }, 'pre-s1'))).reasonCode, 'CAPSULE_WRITTEN', 'the second compaction writes a new capsule');
    const second = await handleHookEvent(event(f, 'session.started', { trigger: 'compact' }, 'start-s1'));
    assert.equal(second.hookOutcome.kind, 'context', 'and it is restored after the second compaction');
    assert.match(second.hookOutcome.text, /C9: keep the public API/);
    now += DELIVERY_DEDUP_WINDOW_MS;
    for (let i = 0; i < 5; i += 1) await handleHookEvent(event(f, 'tool.finished', { toolName: 'Read' }, `t-${String(i)}`));
    // P1 (sidecar concurrency audit): dedup is in memory, with no ledger write per event.
    assert.deepEqual(f.ws.state.list('hook-deliveries'), [], 'no delivery record is written');
    assert.equal(deliveryRecordCount(), 5, 'expired keys are dropped');
    for (let i = 0; i < DELIVERY_RECORDS_MAX + 10; i += 1) firstDelivery(f.ws.workspaceId, `k-${String(i)}`, now);
    assert.equal(deliveryRecordCount(), DELIVERY_RECORDS_MAX, 'and at most DELIVERY_RECORDS_MAX are kept');
    assert.ok(DELIVERY_RECORDS_MAX >= 256);
  } finally {
    setSubscriberClock(undefined);
    setCertificationGate(null);
    f.done();
  }
});

test('subscriber: repeated tool failures are recorded and explained once', async () => {
  const f = fixture();
  try {
    const fail = () => handleHookEvent(event(f, 'tool.failed', { toolName: 'Bash', payload: { toolInputKeys: ['command'], toolInputBytes: 20, toolResponseBytes: 300 } }));
    assert.equal((await fail()).hookOutcome.kind, 'observe');
    assert.equal((await fail()).hookOutcome.kind, 'observe');
    const third = await fail();
    assert.equal(third.hookOutcome.kind, 'explain');
    assert.match(third.hookOutcome.text, /same failure/);
    assert.equal((await fail()).hookOutcome.kind, 'observe');
  } finally {
    f.done();
  }
});

// The session capsule's rejected-approach lines (owner report, 2026-09-30): a failed hook event
// carries argument key names and sizes, which are the same for every Bash call, so unrelated failures
// were counted as one repeated approach and printed as `Approach that ends in "error: Bash(command,
// description) in=196 out=0" failed 3 times.` A failure now carries a one-way digest of its input
// (never the command text, which the privacy rules keep out of the event); only the same digest is
// the same approach.
const bashFailure = (f, command, extra = {}) =>
  handleHookEvent(
    event(f, 'tool.failed', {
      toolName: 'Bash',
      payload: { toolInputKeys: ['command', 'description'], toolInputBytes: 196, toolResponseBytes: 0, toolInputDigest: createHash('sha256').update(command).digest('hex').slice(0, 16), ...extra },
    }),
  );

test('subscriber: three different failing Bash commands with the same argument keys are not one repeated approach', async () => {
  const f = fixture();
  try {
    for (const command of ['npm test', 'git push origin main', 'cargo build']) {
      assert.equal((await bashFailure(f, command)).hookOutcome.kind, 'observe', command);
    }
    assert.deepEqual(rejectedApproaches(f.ws, null), [], 'nothing repeated, so nothing rejected');
    const capsule = await writeCapsule(f.ws, { taskId: null });
    assert.deepEqual(capsule.items.filter((i) => i.kind === 'rejected-approach'), []);
  } finally {
    f.done();
  }
});

test('subscriber: the same command failing three times is one rejected approach, named by tool and digest, never by command text', async () => {
  const f = fixture();
  try {
    assert.equal((await bashFailure(f, 'npm test')).hookOutcome.kind, 'observe');
    assert.equal((await bashFailure(f, 'git status')).hookOutcome.kind, 'observe', 'another command in between');
    assert.equal((await bashFailure(f, 'npm test')).hookOutcome.kind, 'observe');
    assert.equal((await bashFailure(f, 'npm test')).hookOutcome.kind, 'explain', 'the third identical failure');
    const rows = rejectedApproaches(f.ws, null);
    assert.equal(rows.length, 1);
    const handle = createHash('sha256').update('npm test').digest('hex').slice(0, 8);
    assert.match(rows[0].text, new RegExp(`"Bash call ${handle} \\(same input each time\\)" failed 3 times`));
    assert.doesNotMatch(rows[0].text, /npm/, 'the command text is not kept');
    const capsule = await writeCapsule(f.ws, { taskId: null });
    const lines = capsule.items.filter((i) => i.kind === 'rejected-approach').map((i) => i.text);
    assert.equal(lines.length, 1);
    assert.doesNotMatch(lines[0], /\bin=\d|\bout=\d|\(command|npm/, 'no argument keys, byte counts or command text');
  } finally {
    f.done();
  }
});

test('subscriber: a failure with no identity (names and sizes only) still counts but keeps no rejected-approach line', async () => {
  const f = fixture();
  try {
    const shapeOnly = () => handleHookEvent(event(f, 'tool.failed', { toolName: 'Bash', payload: { toolInputKeys: ['command', 'description'], toolInputBytes: 196, toolResponseBytes: 0 } }));
    await shapeOnly();
    await shapeOnly();
    assert.equal((await shapeOnly()).hookOutcome.kind, 'explain', 'the loop advice is unchanged');
    assert.deepEqual(rejectedApproaches(f.ws, null), []);
    const capsule = await writeCapsule(f.ws, { taskId: null });
    assert.deepEqual(capsule.items.filter((i) => i.kind === 'rejected-approach'), []);
  } finally {
    f.done();
  }
});

test('subscriber: a malformed digest is no identity, so nothing is printed', async () => {
  const f = fixture();
  try {
    const call = (digest) => handleHookEvent(event(f, 'tool.failed', { toolName: 'Bash', payload: { toolInputKeys: ['command'], toolInputBytes: 9, toolResponseBytes: 0, toolInputDigest: digest } }));
    for (let i = 0; i < 3; i += 1) await call('rm -rf /home/someone');
    assert.deepEqual(rejectedApproaches(f.ws, null), [], 'a digest that is not 16 hex characters is not trusted as an identity');
  } finally {
    f.done();
  }
});

test('capsule: a rejected-approach row written before failures carried an identity is not carried', async () => {
  const f = fixture();
  try {
    const noise = 'Approach that ends in "error: Bash(command,description) in=196 out=0" failed 3 times.';
    await recordRejectedApproach(f.ws, { taskId: null, text: noise, evidence: [], source: 'worker' });
    await recordRejectedApproach(f.ws, { taskId: null, text: 'Approach that ends in "Bash call 3f9a1c22 (same input each time)" failed 3 times.', evidence: [], source: 'worker' });
    const texts = rejectedApproaches(f.ws, null).map((r) => r.text);
    assert.deepEqual(texts, ['Approach that ends in "Bash call 3f9a1c22 (same input each time)" failed 3 times.']);
    const capsule = await writeCapsule(f.ws, { taskId: null });
    assert.deepEqual(capsule.items.filter((i) => i.kind === 'rejected-approach').map((i) => i.text), texts);
    const { isShapeOnlyLabel } = await import('../dist/index.js');
    for (const label of ['error: Bash(command,description,timeout) in=345 out=0', 'error: Bash(command) in=297 out=0', 'Bash(command) in=20']) assert.equal(isShapeOnlyLabel(label), true, label);
    for (const label of ['Bash call 3f9a1c22 (same input each time)', 'Error: expected 3 to equal 4', 'error: TS2345 in f(x) is bad']) assert.equal(isShapeOnlyLabel(label), false, label);
  } finally {
    f.done();
  }
});

test('subscriber: a certified harness gets a certified stop continuation; with maxStopContinuationsPerCondition 0 there is none (VER-05)', async () => {
  const f = fixture();
  setCertificationGate(certificationGateFrom(async () => [record('claude')], () => '2.1.0'));
  try {
    const m = parseManifest({ id: 'unit', argv: [process.execPath, '-e', 'process.exit(1)'], resultFormat: 'exit-code' }).manifest;
    await approveManifests(f.ws, [m], { unit: manifestHash(m) }, 'test');
    const first = await handleHookEvent(event(f, 'turn.stopped', { payload: { stopHookActive: false } }));
    assert.deepEqual([first.reasonCode, first.stopContinuation.certified, first.stopContinuation.missingEvidence], ['STOP_REMINDER', true, ['unit']]);
    // Configured to 0: a new condition gets the unverified report only.
    const cfg = jevrisPaths({ home: f.home }).config;
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, orchestration: { ...DEFAULT_CONFIG.orchestration, maxStopContinuationsPerCondition: 0 } }));
    writeFileSync(join(f.repo, 'a.txt'), 'changed\n');
    const none = await handleHookEvent(event(f, 'turn.stopped', { payload: { stopHookActive: false } }));
    assert.equal(none.reasonCode, 'STOP_UNVERIFIED');
    assert.equal(none.stopContinuation, undefined);
  } finally {
    setCertificationGate(null);
    f.done();
  }
});

test('subscriber: a stop continuation names the missing checks a background run is still producing, and only those (US23, pair)', async () => {
  const { scheduleVerification } = await import('../dist/verify/runs.js');
  const approveTwo = async (f) => {
    const manifests = ['lint', 'unit'].map((id) => parseManifest({ id, argv: [process.execPath, '-e', 'process.exit(1)'], resultFormat: 'exit-code' }).manifest);
    await approveManifests(f.ws, manifests, Object.fromEntries(manifests.map((m) => [m.id, manifestHash(m)])), 'test');
  };
  // Nothing running: the continuation asks for both, with no pending map.
  const quiet = fixture();
  try {
    await approveTwo(quiet);
    const idle = await handleHookEvent(event(quiet, 'turn.stopped', { payload: { stopHookActive: false } }));
    assert.equal(idle.reasonCode, 'STOP_REMINDER');
    assert.deepEqual(idle.stopContinuation.missingEvidence, ['lint', 'unit']);
    assert.equal(idle.stopContinuation.pending, undefined);
  } finally {
    quiet.done();
  }
  // unit is being produced by a run under way: the continuation says so, and lint is still asked for.
  const f = fixture();
  let release = () => {};
  const held = new Promise((resolve) => (release = resolve));
  try {
    await approveTwo(f);
    const run = scheduleVerification(f.ws.workspaceId, ['unit'], () => held, () => {});
    const busy = await handleHookEvent(event(f, 'turn.stopped', { payload: { stopHookActive: false } }));
    assert.equal(busy.reasonCode, 'STOP_REMINDER', JSON.stringify(busy));
    assert.deepEqual(busy.stopContinuation.missingEvidence, ['lint', 'unit']);
    assert.deepEqual(busy.stopContinuation.pending, { unit: 'RUNNING' });
    assert.ok(busy.stopContinuation.text.includes(stillRunningText([['unit', 'RUNNING']])), 'the decision and the Stop block share the words');
    release();
    await run;
  } finally {
    release();
    f.done();
  }
});

test('subscriber: Stop without current receipts reminds once (a continuation), then reports unverified; stop_hook_active never continues (VER-05)', async () => {
  const f = fixture();
  try {
    // No approved checks: nothing to continue for.
    assert.equal((await handleHookEvent(event(f, 'turn.stopped', { payload: { stopHookActive: false } }))).reasonCode, 'NO_CHECKS');
    const m = parseManifest({ id: 'unit', argv: [process.execPath, '-e', 'process.exit(1)'], resultFormat: 'exit-code' }).manifest;
    await approveManifests(f.ws, [m], { unit: manifestHash(m) }, 'test');
    const first = await handleHookEvent(event(f, 'turn.stopped', { payload: { stopHookActive: false } }));
    assert.equal(first.reasonCode, 'STOP_REMINDER');
    assert.equal(first.hookOutcome.kind, 'explain');
    assert.match(first.stopContinuation.text, /Missing verification evidence: unit/);
    assert.equal(first.stopContinuation.certified, false, 'no hooks.context certification in this home');
    assert.deepEqual(first.stopContinuation.missingEvidence, ['unit'], 'check ids only, no workspace text');
    // The same unchanged condition: no second reminder, an explicit unverified report.
    const second = await handleHookEvent(event(f, 'turn.stopped', { payload: { stopHookActive: false } }));
    assert.equal(second.reasonCode, 'STOP_UNVERIFIED');
    assert.equal(second.stopContinuation, undefined);
    assert.match(second.hookOutcome.text, /^Unverified:/);
    assert.equal(stopReportFor(f.ws, null).outcome, 'unverified', 'status and explain read the stored report');
    const status = await sidecarOps.find((o) => o.op === 'verify.status').handle(f.ctx('verify.status', { taskId: null, checkIds: [] }));
    assert.equal(status.ok, true, JSON.stringify(status));
    assert.match(status.body.stopReport.text, /^Unverified:/, 'verify status renders the last unverified stop');
    assert.deepEqual(status.body.stopReport.missingEvidence, ['unit']);
    assert.deepEqual(statusStopReport(f.ws).missingEvidence, ['unit'], 'the status op reads the same report cheaply');
    // A new condition (the file changed) while the harness says the stop hook is already active.
    writeFileSync(join(f.repo, 'a.txt'), 'changed\n');
    const active = await handleHookEvent(event(f, 'turn.stopped', { payload: { stopHookActive: true } }));
    assert.equal(active.reasonCode, 'STOP_UNVERIFIED');
    assert.equal(active.stopContinuation, undefined, 'never continue while stop_hook_active');
  } finally {
    f.done();
  }
});

// ------------------------------------------------------- answers the sidecar does not use (US14)

/** The event context whose answer the sidecar no longer wants (its slice ended): signal aborted. */
function unwanted(ctx) {
  const gone = new AbortController();
  gone.abort();
  return { ...ctx, signal: gone.signal };
}

test('subscriber: a restore whose answer is not used stays pending and is restored at the next SessionStart, once (US14; pair: a used answer takes it)', async () => {
  const f = fixture();
  setCertificationGate(certificationGateFrom(async () => [record('claude')], () => '2.1.0'));
  try {
    await declare(f.ws, null, { objective: 'Keep going', constraints: ['C7: never force-push'] });
    await handleHookEvent(event(f, 'context.compacting', { trigger: 'auto' }));
    const capsule = latestCapsule(f.ws, null);
    // The slice ended before the answer: nothing is taken.
    const missed = await handleHookEvent(unwanted(event(f, 'session.started', { trigger: 'compact' }, 'start-1')));
    assert.deepEqual([missed.hookOutcome.kind, missed.reasonCode], ['observe', 'ANSWER_NOT_WANTED']);
    assert.equal(restoreState(f.ws, capsule.id, 's1'), 'pending');
    // The slice ends while the subscriber is working (after it started): still not taken.
    const controller = new AbortController();
    const running = handleHookEvent({ ...event(f, 'session.started', { trigger: 'compact' }, 'start-2'), signal: controller.signal });
    controller.abort();
    assert.equal((await running).reasonCode, 'ANSWER_NOT_WANTED');
    assert.equal(restoreState(f.ws, capsule.id, 's1'), 'pending');
    // A replay of a delivery is still a duplicate, and takes nothing.
    assert.equal((await handleHookEvent(event(f, 'session.started', { trigger: 'compact' }, 'start-1'))).reasonCode, 'DUPLICATE_DELIVERY');
    assert.equal(restoreState(f.ws, capsule.id, 's1'), 'pending');
    // Pair: the next SessionStart whose answer is used restores it, and only once.
    const next = await handleHookEvent(event(f, 'session.started', { trigger: 'compact' }, 'start-3'));
    assert.equal(next.hookOutcome.kind, 'context');
    assert.match(next.hookOutcome.text, /C7: never force-push/);
    assert.equal(restoreState(f.ws, capsule.id, 's1'), 'taken');
    const after = await handleHookEvent(event(f, 'session.started', { trigger: 'compact' }, 'start-4'));
    assert.deepEqual([after.hookOutcome.kind, after.reasonCode], ['observe', 'ALREADY_RESTORED']);
  } finally {
    setCertificationGate(null);
    f.done();
  }
});

test('subscriber: a loop explanation whose answer is not used is not marked shown; the next failure explains it (US14; pair)', async () => {
  const f = fixture();
  try {
    const fail = (wanted = true) => {
      const ctx = event(f, 'tool.failed', { toolName: 'Bash', payload: { toolInputKeys: ['command'], toolInputBytes: 20, toolResponseBytes: 300 } });
      return handleHookEvent(wanted ? ctx : unwanted(ctx));
    };
    await fail();
    await fail();
    assert.equal((await fail(false)).reasonCode, 'ANSWER_NOT_WANTED');
    const shown = await fail();
    assert.equal(shown.hookOutcome.kind, 'explain', 'explained once the answer is used');
    assert.equal((await fail()).reasonCode, 'ALREADY_EXPLAINED');
  } finally {
    f.done();
  }
});

/** The event context of a launcher that says the harness shows no answer on this event (G2). */
function hidden(ctx) {
  return { ...ctx, body: { ...ctx.body, showsExplain: false } };
}

test('subscriber: where the harness shows no answer (showsExplain false) and has no later showing event, no explanation is spent; the next event that shows it gets it (G2; pair)', async () => {
  const f = fixture();
  try {
    const fail = (shows) => {
      const ctx = event(f, 'tool.failed', { toolName: 'Bash', payload: { toolInputKeys: ['command'], toolInputBytes: 20, toolResponseBytes: 300 } });
      return handleHookEvent(shows === false ? hidden(ctx) : shows === true ? { ...ctx, body: { ...ctx.body, showsExplain: true } } : ctx);
    };
    await fail();
    await fail();
    assert.equal((await fail(false)).reasonCode, 'ANSWER_NOT_WANTED');
    assert.equal((await fail(true)).hookOutcome.kind, 'explain', 'shown once a harness can show it');
    assert.equal((await fail()).reasonCode, 'ALREADY_EXPLAINED', 'a body without the field (an older launcher) counts as showing');
  } finally {
    f.done();
  }
});

test('subscriber: on Kilo, OpenCode and Antigravity an answer due on an event they do not show is queued for the session and goes out on its next showing event, once (G4, G5; pair)', async () => {
  for (const [harness, showing] of [['kilocode', 'task.requested'], ['antigravity', 'invocation.started']]) {
    const f = fixture();
    try {
      const fail = (sessionId) => handleHookEvent(hidden(event(f, 'tool.failed', { harness, sessionId, toolName: 'Bash', payload: { toolInputKeys: ['command'], toolInputBytes: 20, toolResponseBytes: 300 } })));
      const sessionId = `s-${harness}`;
      await fail(sessionId);
      await fail(sessionId);
      const due = await fail(sessionId);
      assert.deepEqual([due.hookOutcome.kind, due.reasonCode], ['observe', 'DISPLAY_QUEUED'], harness);
      // Another session's showing event does not take it.
      assert.equal((await handleHookEvent(event(f, showing, { harness, sessionId: 'other' }))).hookOutcome.kind, 'observe');
      // A showing event whose answer is not used leaves it queued.
      assert.equal((await handleHookEvent(unwanted(event(f, showing, { harness, sessionId })))).reasonCode, 'ANSWER_NOT_WANTED');
      const shown = await handleHookEvent(event(f, showing, { harness, sessionId }));
      assert.deepEqual([shown.hookOutcome.kind, shown.reasonCode], ['explain', 'DISPLAY_FLUSHED'], harness);
      assert.ok(shown.hookOutcome.text.length > 0);
      assert.equal((await handleHookEvent(event(f, showing, { harness, sessionId }))).hookOutcome.kind, 'observe', 'once');
      // Claude shows its answers where they are due: nothing is queued there.
      assert.equal((await handleHookEvent(event(f, 'task.requested', { sessionId: 's-claude' }))).hookOutcome.kind, 'observe');
    } finally {
      f.done();
    }
  }
});

test('subscriber: a Stop reminder that reaches the agent as the harness\'s continuation is spent even where no text shows (Antigravity, G6; G2 pair)', async () => {
  const f = fixture();
  try {
    const m = parseManifest({ id: 'unit', argv: [process.execPath, '-e', 'process.exit(1)'], resultFormat: 'exit-code' }).manifest;
    await approveManifests(f.ws, [m], { unit: manifestHash(m) }, 'test');
    const agy = await handleHookEvent(hidden(event(f, 'turn.stopped', { payload: { stopHookActive: false }, harness: 'antigravity' })));
    assert.equal(agy.reasonCode, 'STOP_REMINDER');
    assert.deepEqual(agy.stopContinuation.missingEvidence, ['unit']);
  } finally {
    f.done();
  }
});

test('subscriber: a Kilo or OpenCode compaction takes the capsule as compaction context, once and only where certified; Claude\'s PreCompact does not (G3; pair)', async () => {
  const f = fixture();
  setCertificationGate(certificationGateFrom(async () => [record('kilocode')], () => '2.1.0'));
  try {
    await declare(f.ws, null, { objective: 'Keep going', constraints: ['C7: never force-push'] });
    const compact = (harness, sessionId = 's1', shows = true) => {
      const ctx = event(f, 'context.compacting', { trigger: 'auto', harness, sessionId });
      return handleHookEvent(shows ? ctx : hidden(ctx));
    };
    // Claude: the capsule is written, and the restore waits for SessionStart.
    assert.deepEqual((await compact('claude')).hookOutcome, { kind: 'observe' });
    // Kilo, certified: the capsule goes out with the compaction, and is taken.
    const kilo = await compact('kilocode', 's2');
    assert.deepEqual([kilo.hookOutcome.kind, kilo.reasonCode, kilo.certified], ['context', 'CAPSULE_RESTORED', true]);
    assert.match(kilo.hookOutcome.text, /C7: never force-push/);
    assert.equal(restoreState(f.ws, latestCapsule(f.ws, null).id, 's2'), 'taken');
    // OpenCode without a certification record: written, not restored (MEM-09).
    const open = await compact('opencode', 's3');
    assert.deepEqual([open.hookOutcome.kind, open.reasonCode.startsWith('CAPSULE_WRITTEN_')], ['observe', true]);
    // A Kilo compaction whose answer the harness would not show holds it for the session's next message (G4).
    const quiet = await compact('kilocode', 's4', false);
    assert.deepEqual([quiet.hookOutcome.kind, quiet.reasonCode], ['observe', 'DISPLAY_QUEUED']);
    const next = await handleHookEvent(event(f, 'task.requested', { harness: 'kilocode', sessionId: 's4' }));
    assert.deepEqual([next.hookOutcome.kind, next.certified], ['context', true]);
    assert.match(next.hookOutcome.text, /C7: never force-push/);
  } finally {
    setCertificationGate(null);
    f.done();
  }
});

test('subscriber: a stop reminder whose answer is not used is not spent; the next stop gets it, then the report (US14, US23; pair)', async () => {
  const f = fixture();
  setCertificationGate(certificationGateFrom(async () => [record('claude')], () => '2.1.0'));
  try {
    const m = parseManifest({ id: 'unit', argv: [process.execPath, '-e', 'process.exit(1)'], resultFormat: 'exit-code' }).manifest;
    await approveManifests(f.ws, [m], { unit: manifestHash(m) }, 'test');
    const stop = (wanted = true) => {
      const ctx = event(f, 'turn.stopped', { payload: { stopHookActive: false } });
      return handleHookEvent(wanted ? ctx : unwanted(ctx));
    };
    assert.equal((await stop(false)).reasonCode, 'ANSWER_NOT_WANTED');
    const first = await stop();
    assert.equal(first.reasonCode, 'STOP_REMINDER', 'the reminder was kept');
    assert.equal((await stop()).reasonCode, 'STOP_UNVERIFIED', 'one reminder, then the report');
  } finally {
    setCertificationGate(null);
    f.done();
  }
});

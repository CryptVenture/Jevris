import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTEXT_FEATURE,
  assembleCapsule,
  auditOmissions,
  budgetFromRegistry,
  certificationGateFrom,
  compactionReadiness,
  consultScore,
  DEADLINE_MARGIN_MS,
  declare,
  distillOutput,
  DEFAULT_CONFIG,
  sidecarOps,
  harnessVersionOf,
  isCertified,
  mayReplaceOutput,
  openWorkspace,
  recordFact,
  recordHarnessVersion,
  rehydrate,
  restoreText,
  setCertificationGate,
  triageContradictions,
  writeCapsule,
} from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { jevrisPaths } from '@jevris/platform';
import { tempDir } from './temp-dirs.mjs';

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

function fixture() {
  const dir = tempDir('jv-meme-');
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
  return { home, repo, ws, done: () => {
      closeTestStore(store);
      rmSync(dir, { recursive: true, force: true });
    } };
}

/** A fake engine that answers by question type. */
function engine(answers, calls = []) {
  return {
    async decide(request) {
      calls.push(request);
      const type = request.questions.q.type;
      return { abstained: false, decisionId: `dec-${String(calls.length)}`, automation: 'advice', rulesOnly: false, result: { answers: { q: { [type]: answers[type] } } } };
    },
  };
}

test('certification: the harness version ledger feeds the gate; a forwarded version wins; failures are uncertified', async () => {
  const f = fixture();
  try {
    assert.equal(harnessVersionOf(f.home, 'claude'), null);
    await recordHarnessVersion(f.home, 'claude', 'not-a-version');
    assert.equal(harnessVersionOf(f.home, 'claude'), null);
    await recordHarnessVersion(f.home, 'claude', '2.1.0');
    assert.equal(harnessVersionOf(f.home, 'claude'), '2.1.0');
    const rec = {
      harness: 'claude',
      harnessVersionRange: { minimum: '2.0.0', maximumExclusive: '3.0.0' },
      operatingSystems: [process.platform],
      certifiedAt: '2026-01-01T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
      features: [{ featureId: CONTEXT_FEATURE, status: 'certified', reasonCode: null }],
    };
    const gate = certificationGateFrom(async () => [rec]);
    const q = { home: f.home, harness: 'claude', featureId: CONTEXT_FEATURE, nowMs: Date.now() };
    assert.equal((await gate(q)).certified, true);
    assert.equal((await gate({ ...q, harnessVersion: '9.0.0' })).reasonCode, 'VERSION_OUT_OF_RANGE');
    assert.equal((await certificationGateFrom(async () => { throw new Error('x'); })(q)).reasonCode, 'CERTIFICATIONS_UNAVAILABLE');
    setCertificationGate(async () => { throw new Error('boom'); });
    assert.deepEqual(await isCertified(q), { certified: false, reasonCode: 'GATE_FAILED' });
    setCertificationGate(null);
    // The default gate: no F loader records here means uncertified.
    assert.equal((await isCertified(q)).certified, false);
    assert.equal(mayReplaceOutput(true, false), false);
    assert.equal(mayReplaceOutput(true, true), true);
  } finally {
    setCertificationGate(null);
    f.done();
  }
});

test('engine paths: C18 ranking, C20 flags, C19 boundary and C21 capsule choice consult the engine as advice', async () => {
  const f = fixture();
  try {
    await declare(f.ws, null, { objective: 'o', constraints: ['C1: keep it'], decisions: [{ text: 'Use the streaming parser for large files' }, { text: 'Log at debug level only' }] });
    const calls = [];
    const e = engine({ score: 3, noul: 0.9, choice: 'c1' }, calls);
    const assembled = await assembleCapsule(f.ws, { taskId: null, engine: e, egressApproved: true });
    const ranked = assembled.capsule;
    assert.match(assembled.decisionId, /^dec-/, 'the ranking decision is named');
    assert.equal((await assembleCapsule(f.ws, { taskId: null })).decisionId, null, 'rules ranking names no decision');
    assert.equal(ranked.ranking, 'jev');
    assert.ok(calls.some((c) => c.spec.id === 'd-c18'));
    const audit = await auditOmissions(f.ws, ranked, { summary: 'C1 is kept.', engine: e, egressApproved: true });
    assert.equal(audit.source, 'jev');
    assert.ok(audit.flagged.length >= 1);
    const readiness = await compactionReadiness(f.ws, { taskId: null, facts: budgetFromRegistry({ entries: [{ modelId: 'm', contextTokens: 100000, maxOutputTokens: 10000 }] }, 'm'), usedTokens: 50000, episodeId: 'ep', engine: e });
    assert.equal(readiness.boundary, 'recommend-boundary');
    assert.equal(readiness.source, 'jev');
    await writeCapsule(f.ws, { taskId: null });
    await declare(f.ws, 'T2', { objective: 'second task' });
    await writeCapsule(f.ws, { taskId: 'T2' });
    const r = await rehydrate(f.ws, { taskId: null, engine: e });
    assert.equal(r.source, 'jev');
    assert.equal(r.found, true);
    assert.match(restoreText(ranked.items, ranked.id, 600), /more items remain|advice only/);
  } finally {
    f.done();
  }
});

test('engine paths: C22 span scoring, C23 semantic contradictions and score bounds', async () => {
  const f = fixture();
  try {
    const e = engine({ score: 2, noul: 0.8 });
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${String(i)} ${i % 50 === 0 ? 'setup detail' : 'ok'}`);
    const r = await distillOutput(f.ws, { command: 'make', exitCode: 2, stdout: lines.join('\n'), budgetTokens: 1500, engine: e, egressApproved: true });
    assert.equal(r.source, 'jev');
    assert.equal(r.mode, 'distilled');
    await recordFact(f.ws, { subject: 'db.engine', value: 'postgres', revision: 'r1', status: 'verified', source: 'receipt' });
    await recordFact(f.ws, { subject: 'storage.backend', value: 'sqlite only', revision: 'r1', status: 'observed', source: 'agent' });
    const found = await triageContradictions(f.ws, { engine: e, semantic: [{ a: 'db.engine', b: 'storage.backend' }] });
    assert.equal(found.length, 1);
    assert.equal(found[0].kind, 'semantic');
    const base = { capabilityId: 'C41', specVersion: '1', objective: 'o', workspaceId: 'ws-1', evidenceRevision: 'r', evidence: [], instructions: 'i', anchors: ['a', 'b'], rules: () => ({ score: 0, reasonCode: 'R' }) };
    assert.equal((await consultScore(engine({ score: 7 }), base)).source, 'rules', 'out-of-range score is ignored');
    assert.equal((await consultScore(engine({ score: 1 }), base)).value, 1);
    assert.equal((await consultScore({ decide: async () => null }, base)).source, 'rules');
  } finally {
    f.done();
  }
});

test('the engine deadline never outlives the op budget: with little time left the decision still settles inside it (recover, C22)', async () => {
  const f = fixture();
  try {
    const calls = [];
    const e = engine({ score: 2 }, calls);
    const base = { capabilityId: 'C22', specVersion: '1', objective: 'o', instructions: 'i', anchors: ['a', 'b', 'c', 'd'], evidence: [{ id: 'e1', text: 't', sourceKind: 'tool', priority: 'optional' }], workspaceId: f.ws.workspaceId, evidenceRevision: 'r1', rules: () => ({ score: 0, reasonCode: 'RULES' }) };
    const nearlySpent = await consultScore(e, { ...base, remainingMs: 1_000 });
    assert.equal(nearlySpent.source, 'jev', 'the engine still answers');
    assert.ok(calls[0].spec.deadlineMs <= 1_000 - DEADLINE_MARGIN_MS, String(calls[0].spec.deadlineMs));
    await consultScore(e, { ...base });
    assert.equal(calls[1].spec.deadlineMs, 5_000, 'without a budget the default deadline stands');
    await consultScore(e, { ...base, remainingMs: 60_000, deadlineMs: 2_000 });
    assert.equal(calls[2].spec.deadlineMs, 2_000);
  } finally {
    f.done();
  }
});

test('checkpoint and recover answers name the Jev decision they were recorded as (decisionId), and null without one', async () => {
  const f = fixture();
  try {
    const cfg = jevrisPaths({ home: f.home }).config;
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, privacy: { ...DEFAULT_CONFIG.privacy, sourceEgress: 'approved-scoped' } }));
    await declare(f.ws, null, { objective: 'o', decisions: [{ text: 'Use the streaming parser' }] });
    const call = (op, body, eng) => sidecarOps.find((o) => o.op === op).handle({
      op, client: 'cli', scopes: ['status', 'advice', 'checkpoint'], workspace: { id: f.ws.workspaceId, root: f.ws.workspaceRoot }, body, home: f.home,
      signal: new AbortController().signal, deadline: { budgetMs: 5000, remainingMs: () => 5000, expired: () => false }, store: undefined, killSwitchStopped: false, engine: eng, trace: () => {},
    });
    const e = engine({ score: 3, choice: 'c1', classification: 'repeated-failure' });
    const cp = await call('checkpoint', { objective: 'o', taskId: null }, e);
    assert.equal(cp.ok, true, JSON.stringify(cp));
    assert.match(cp.body.decisionId, /^dec-/);
    const plain = await call('checkpoint', { objective: 'o', taskId: null }, undefined);
    assert.equal(plain.body.decisionId, null);
    const rec = await call('recover', { taskId: null, signals: { fingerprints: ['E1 boom', 'E1 boom', 'E1 boom'] } }, undefined);
    assert.equal(rec.ok, true, JSON.stringify(rec));
    assert.ok('decisionId' in rec.body);
    assert.equal(rec.body.decisionId, null, 'no engine, no decision');
    const mixed = await call('recover', { taskId: 'T5', signals: { fingerprints: ['E1 boom at a.txt:1', 'E2 other at b.txt:2', 'E1 boom at a.txt:1', 'E3 third at c.txt:3'] } }, engine({ choice: 'repeated_failure' }));
    assert.equal(mixed.ok, true);
    assert.match(mixed.body.decisionId, /^dec-/, 'a Jev-classified loop names its decision');
  } finally {
    f.done();
  }
});

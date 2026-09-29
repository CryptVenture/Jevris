import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signRecord } from '@jevris/contracts';
import {
  addTrustedIssuer,
  approveManifests,
  importCiBundle,
  manifestHash,
  openWorkspace,
  parseManifest,
  requiredCheckReport,
  sidecarOps,
  verificationStatus,
  waiveCheck,
} from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function keys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ type: 'spki', format: 'pem' }).toString(), priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

async function fixture() {
  const dir = tempDir('jv-ci-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(repo, 'lib'), { recursive: true });
  writeFileSync(join(repo, 'lib', 'a.js'), 'export const a = 1;\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  const head = git(repo, 'rev-parse', 'HEAD').trim();
  const store = testStore(dir);
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
  const parsed = ['unit', 'lint'].map((id) => parseManifest({ id, argv: [process.execPath, '-e', '0'], resultFormat: 'exit-code' }).manifest);
  await approveManifests(ws, parsed, Object.fromEntries(parsed.map((m) => [m.id, manifestHash(m)])), 'test');
  return { dir, repo, head, ws, store, done: () => {
      closeTestStore(store);
      rmSync(dir, { recursive: true, force: true });
    } };
}

const ARTIFACT = new TextEncoder().encode('TAP version 13\nok 1\n1..1\n');

function bundle(head, priv, keyId, extra = {}) {
  return signRecord(
    {
      schemaVersion: 'jevris-ci-receipts-1',
      issuerId: 'gh-actions',
      jobId: 'run-42',
      repository: 'acme/app',
      revision: head,
      createdAt: '2026-09-01T00:00:00.000Z',
      checks: [{ checkId: 'unit', outcome: 'passed', rawOutputHash: sha(ARTIFACT), artifact: { name: 'unit.tap', sha256: sha(ARTIFACT) } }],
      ...extra,
    },
    priv,
    keyId,
  );
}

const artifacts = (bytes = ARTIFACT) => ({ fetch: async (_i, _j, name) => (name === 'unit.tap' ? bytes : null) });

test('an allowlisted, signed CI bundle for HEAD records current receipts that count toward completion (VER-06)', async () => {
  const f = await fixture();
  try {
    const k = keys();
    await addTrustedIssuer(f.ws, { issuerId: 'gh-actions', keys: { k1: k.pub }, repository: 'acme/app' });
    const result = await importCiBundle(f.ws, { bundle: bundle(f.head, k.priv, 'k1'), artifacts: artifacts() });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.binding, 'current');
    const report = requiredCheckReport(f.ws, ['unit', 'lint']);
    assert.deepEqual(report.map((l) => [l.checkId, l.status]), [['unit', 'passed'], ['lint', 'missing']]);
    assert.equal(report.find((l) => l.checkId === 'unit').issuer, 'gh-actions');
    const status = await verificationStatus(f.ws, { taskId: null, checkIds: [], acceptanceCheckIds: ['unit'] });
    assert.equal(status.checks.find((c) => c.checkId === 'unit').status, 'passed');
  } finally {
    f.done();
  }
});

test('a forged issuer, unknown key, bad signature or tampered artifact is refused and writes nothing (VER-06)', async () => {
  const f = await fixture();
  try {
    const real = keys();
    const forger = keys();
    const b = bundle(f.head, real.priv, 'k1');
    assert.equal((await importCiBundle(f.ws, { bundle: b, artifacts: artifacts() })).reasonCode, 'UNKNOWN_ISSUER');
    await addTrustedIssuer(f.ws, { issuerId: 'gh-actions', keys: { k1: real.pub }, repository: 'acme/app' });
    assert.equal((await importCiBundle(f.ws, { bundle: bundle(f.head, forger.priv, 'k1'), artifacts: artifacts() })).reasonCode, 'BAD_SIGNATURE');
    assert.equal((await importCiBundle(f.ws, { bundle: bundle(f.head, forger.priv, 'k9'), artifacts: artifacts() })).reasonCode, 'UNKNOWN_KEY');
    const tampered = { ...b, checks: [{ ...b.checks[0], outcome: 'passed', checkId: 'lint' }] };
    assert.equal((await importCiBundle(f.ws, { bundle: tampered, artifacts: artifacts() })).reasonCode, 'BAD_SIGNATURE');
    const { signature: _s, ...unsigned } = b;
    assert.equal((await importCiBundle(f.ws, { bundle: unsigned, artifacts: artifacts() })).reasonCode, 'MISSING_SIGNATURE');
    assert.equal(
      (await importCiBundle(f.ws, { bundle: bundle(f.head, real.priv, 'k1', { repository: 'evil/fork' }), artifacts: artifacts() })).reasonCode,
      'REPOSITORY_MISMATCH',
    );
    assert.equal((await importCiBundle(f.ws, { bundle: b, artifacts: { fetch: async () => null } })).reasonCode, 'ARTIFACT_UNAVAILABLE');
    assert.equal((await importCiBundle(f.ws, { bundle: b, artifacts: artifacts(new TextEncoder().encode('x')) })).reasonCode, 'ARTIFACT_MISMATCH');
    assert.equal(f.ws.receipts.list(f.ws.workspaceId).length, 0);
  } finally {
    f.done();
  }
});

test('a bundle for another revision is historical only and never satisfies a required check (VER-06)', async () => {
  const f = await fixture();
  try {
    const k = keys();
    await addTrustedIssuer(f.ws, { issuerId: 'gh-actions', keys: { k1: k.pub }, repository: null });
    const other = 'a'.repeat(40);
    const result = await importCiBundle(f.ws, { bundle: bundle(other, k.priv, 'k1'), artifacts: artifacts() });
    assert.equal(result.ok, true);
    assert.equal(result.binding, 'historical');
    const rows = f.ws.receipts.list(f.ws.workspaceId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].validity, 'invalidated');
    assert.equal(requiredCheckReport(f.ws, ['unit'])[0].status, 'missing');
  } finally {
    f.done();
  }
});

test('a newer historical receipt never masks the current one: a current failure stays failed (VER-06, W08)', async () => {
  const f = await fixture();
  try {
    const k = keys();
    await addTrustedIssuer(f.ws, { issuerId: 'gh-actions', keys: { k1: k.pub }, repository: null });
    const failed = { checks: [{ checkId: 'unit', outcome: 'failed', rawOutputHash: sha(ARTIFACT), artifact: { name: 'unit.tap', sha256: sha(ARTIFACT) } }] };
    const current = await importCiBundle(f.ws, { bundle: bundle(f.head, k.priv, 'k1', failed), artifacts: artifacts() });
    assert.equal(current.binding, 'current');
    const old = await importCiBundle(f.ws, { bundle: bundle('a'.repeat(40), k.priv, 'k1', { jobId: 'run-43', createdAt: '2026-09-02T00:00:00.000Z' }), artifacts: artifacts() });
    assert.equal(old.binding, 'historical');
    const [line] = requiredCheckReport(f.ws, ['unit']);
    assert.equal(line.status, 'failed');
    assert.equal(line.receiptId, current.receiptIds[0]);
  } finally {
    f.done();
  }
});

test('a waiver names its authority and is reported as waived, never as passed (VER-06)', async () => {
  const f = await fixture();
  try {
    await assert.rejects(waiveCheck(f.ws, 'lint', '  ', 'no reason'));
    const w = await waiveCheck(f.ws, 'lint', 'release-manager', 'linter outage');
    assert.equal(w.channel, 'cli');
    const line = requiredCheckReport(f.ws, ['lint'])[0];
    assert.equal(line.status, 'waived');
    assert.equal(line.waiverAuthority, 'release-manager');
  } finally {
    f.done();
  }
});

test('verify.import-ci op: CLI-only scope, artifacts as bytes, a bad artifact refuses (VER-06)', async () => {
  const f = await fixture();
  try {
    const k = keys();
    await addTrustedIssuer(f.ws, { issuerId: 'gh-actions', keys: { k1: k.pub }, repository: 'acme/app' });
    const op = sidecarOps.find((o) => o.op === 'verify.import-ci');
    assert.equal(op.scope, 'submit');
    assert.equal(op.stoppedByKillSwitch, true);
    const ctx = (body) => ({ op: 'verify.import-ci', client: 'cli', scopes: ['submit'], workspace: { id: f.ws.workspaceId, root: f.ws.workspaceRoot }, body, home: f.ws.home, signal: new AbortController().signal, deadline: { budgetMs: 5000, remainingMs: () => 5000, expired: () => false }, store: f.store, killSwitchStopped: false, engine: undefined, trace: () => {} });
    const b64 = Buffer.from(ARTIFACT).toString('base64');
    const ok = await op.handle(ctx({ bundle: bundle(f.head, k.priv, 'k1'), artifacts: [{ name: 'unit.tap', base64: b64 }] }));
    assert.equal(ok.ok, true);
    assert.equal(ok.body.accepted, true);
    assert.equal(ok.body.binding, 'current');
    assert.equal(ok.body.receiptIds.length, 1);
    // verify.required reads the same store receipts (the CLI has no local receipt path).
    const required = sidecarOps.find((o) => o.op === 'verify.required');
    assert.equal(required.scope, 'status');
    const report = await required.handle({ ...ctx({ checkIds: ['unit', 'lint'] }), op: 'verify.required', scopes: ['status'] });
    assert.deepEqual(report.body.checks.map((c) => [c.checkId, c.status]), [['unit', 'passed'], ['lint', 'missing']], 'in the order asked');
    assert.equal((await required.handle({ ...ctx({ checkIds: [] }), op: 'verify.required' })).reasonCode, 'INVALID_REQUEST');
    assert.equal((await required.handle({ ...ctx({ checkIds: ['../x'] }), op: 'verify.required' })).reasonCode, 'INVALID_REQUEST');
    assert.equal((await required.handle({ ...ctx({ checkIds: ['unit'] }), op: 'verify.required', workspace: { id: null, root: null } })).reasonCode, 'WORKSPACE_ROOT_UNKNOWN');
    const bad = await op.handle(ctx({ bundle: bundle(f.head, k.priv, 'k1'), artifacts: [{ name: 'unit.tap', base64: Buffer.from('tampered').toString('base64') }] }));
    assert.deepEqual({ accepted: bad.body.accepted, reasonCode: bad.body.reasonCode }, { accepted: false, reasonCode: 'ARTIFACT_MISMATCH' });
    assert.equal((await op.handle(ctx({ bundle: 'x', artifacts: [] }))).reasonCode, 'INVALID_REQUEST');
    assert.equal((await op.handle(ctx({ bundle: {}, artifacts: [{ name: '../x', base64: '' }] }))).reasonCode, 'INVALID_REQUEST');
  } finally {
    f.done();
  }
});

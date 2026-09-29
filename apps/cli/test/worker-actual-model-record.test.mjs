// worker.actual-model (K8; the Linux RC6 run found that no record carried it, so the gate rows
// portability.worker-actual-model.{codex,kilocode,opencode} failed on every OS). The K8 stub case
// results stand in for a real run (npm test never starts a harness). Temp home, file-based local
// key, no keychain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { recordFeatures, signedCertificationRecord, workerActualModelChecks, WORKER_ACTUAL_MODEL_STUB_CASES } = await import('../dist/certification.js');
const { fixtureSuiteHash } = await import('../dist/conformance-run.js');
const { localSigningKey } = await import('@jevris/cli/certifications');

const root = fileURLToPath(new URL('../../..', import.meta.url));
const os = process.platform;
const VERSIONS = { codex: '0.157.1', kilocode: '7.8.1', opencode: '1.18.32' };

const pass = (id) => ({ id, passed: true, reasonCode: null, detail: '' });
const fail = (id, reasonCode) => ({ id, passed: false, reasonCode, detail: '' });
const running = [
  { featureId: 'plugin.install', passed: true, reasonCode: null, detail: 'stand-in' },
  { featureId: 'hooks.observe', passed: true, reasonCode: null, detail: 'stand-in' },
];

function tempHome(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-k8-cert-')));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return home;
}

async function record(home, harness, stubCases, live = running) {
  const features = recordFeatures({ harness, live, extra: [], stubCases, policies: [] });
  const signed = await signedCertificationRecord({ harness, os, harnessVersion: VERSIONS[harness], nowMs: Date.now(), root, features, conformant: true, suiteHash: fixtureSuiteHash(harness), key: await localSigningKey(home) });
  return signed.features.find((item) => item.featureId === 'worker.actual-model');
}

test('worker.actual-model: a passing K8 case certifies it in the signed record of Codex, Kilo and OpenCode', async (t) => {
  const home = tempHome(t);
  assert.deepEqual(WORKER_ACTUAL_MODEL_STUB_CASES, { codex: 'codex.worker-actual-model', kilocode: 'kilocode.worker-actual-model', opencode: 'opencode.worker-actual-model' });
  for (const harness of ['codex', 'kilocode', 'opencode']) {
    const id = `${harness}.worker-actual-model`;
    assert.deepEqual(await record(home, harness, [pass(id)]), { featureId: 'worker.actual-model', status: 'certified', reasonCode: null }, harness);
  }
});

test('worker.actual-model: a failed, missing or hookless K8 case leaves it uncertified; Claude Code and Antigravity have none', async (t) => {
  const home = tempHome(t);
  for (const harness of ['codex', 'kilocode', 'opencode']) {
    const id = `${harness}.worker-actual-model`;
    assert.deepEqual(await record(home, harness, [fail(id, 'MODEL_NOT_REPORTED')]), { featureId: 'worker.actual-model', status: 'unsupported', reasonCode: 'WORKER_ACTUAL_MODEL_CASE_FAILED' }, `${harness}: failed`);
    assert.deepEqual(await record(home, harness, []), { featureId: 'worker.actual-model', status: 'unsupported', reasonCode: 'WORKER_ACTUAL_MODEL_CASE_NOT_RUN' }, `${harness}: not run`);
    const hookless = [{ ...running[0] }, { ...running[1], passed: false, reasonCode: 'HOOKS_NOT_RUNNING' }];
    assert.deepEqual(await record(home, harness, [pass(id)], hookless), { featureId: 'worker.actual-model', status: 'unsupported', reasonCode: 'HOOKS_NOT_RUNNING' }, `${harness}: a passing case never lifts hooks that did not run`);
    assert.equal((await record(home, harness, [pass(`${harness}.worker-actual-models`), pass('claude.worker-actual-model')])).status, 'unsupported', 'only the harness\'s own case id counts');
  }
  for (const harness of ['claude', 'antigravity']) {
    assert.deepEqual(workerActualModelChecks(harness, running, [pass(`${harness}.worker-actual-model`)]), [], harness);
    assert.equal(recordFeatures({ harness, live: running, extra: [], stubCases: [], policies: [] }).some((item) => item.featureId === 'worker.actual-model'), false, harness);
  }
});

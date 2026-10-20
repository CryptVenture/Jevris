import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';

// `status` through the real sidecar says, per harness, whether a subagent's model can be set for one call (hooks.route certified for the
// installed version, else why not) and what this workspace's launches got, built from the hook events themselves. Temp home, no
// credential, no harness binary; the certification gate is the test's.

const { startDaemon, sidecarRequest } = await import('../dist/index.js');
const { certificationGateFrom, recordHarnessVersion, setCertificationGate } = await import('@jevris/orchestrator');
const { surfacePayloadContract } = await import('@jevris/contracts');

const sha = (text) => createHash('sha256').update(text).digest('hex');
let n = 0;

const record = (harness, over = {}) => ({
  id: `cert-${harness}`, schemaVersion: '1.0', harness, actuatorId: `${harness}-hooks`, harnessVersionRange: { minimum: '2.1.295', maximumExclusive: '2.2.0' },
  operatingSystems: ['darwin', 'linux', 'win32'], models: [], tools: [], limitations: [], fixtureSuiteHash: `sha256:${'a'.repeat(64)}`,
  features: [{ featureId: 'hooks.route', status: 'certified', reasonCode: null }], certifiedAt: '2026-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z',
  signature: { algorithm: 'ed25519', keyId: 'k', value: 'AAAA' }, ...over,
});

async function event(home, repo, harness, kind, payload, { sessionId = 'sess-routing', agentId = null, model = 'claude-sonnet-5-5' } = {}) {
  n += 1;
  const key = `routing-${n}`;
  const envelope = {
    schemaVersion: '1.0', harness, nativeEventName: kind === 'worker.started' ? 'SubagentStart' : 'PreToolUse', kind, sessionId, turnId: null, toolUseId: kind === 'tool.proposed' ? `tu-${n}` : null,
    toolName: kind === 'tool.proposed' ? 'Agent' : null, agentId, model, permissionMode: null, cwd: null, trigger: null, blocking: kind === 'tool.proposed', responseRequired: kind === 'tool.proposed', payload, dedupKey: sha(key), flags: {},
  };
  const res = await sidecarRequest({ home, op: 'event', workspace: repo, scope: 'hook', timeoutMs: 60_000, body: { deliveryKey: key, harnessVersion: '2.1.304', envelope } });
  assert.equal(res.ok, true, JSON.stringify(res));
}

test('status shows subagent routing per harness: off with the coverage code, then on with what the launches got', { skip: managedHostSkip() }, async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-status-routing-')));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3 }));
  t.after(() => setCertificationGate(null));
  const repo = join(home, 'repo');
  mkdirSync(repo);
  await recordHarnessVersion(home, 'claude', '2.1.304');
  const started = await startDaemon({ home, idleMs: 0, log: () => undefined, liveCertification: false, limits: { budgetMs: { hot: 60_000, background: 60_000 } } });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  try {
    const status = async () => {
      const res = await sidecarRequest({ home, op: 'status', workspace: repo, scope: 'cli', body: {} });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(surfacePayloadContract('status').validate(res.result).ok, true, 'the status body meets its contract');
      return res.result.subagentRouting;
    };
    const claude = async () => (await status()).find((v) => v.harness === 'claude');

    // No record covers the harness: routing is off, with the code; only the harness the ledger knows is listed.
    setCertificationGate(certificationGateFrom(async () => [], () => '2.1.304'));
    const off = await status();
    assert.deepEqual(off.map((v) => v.harness), ['claude']);
    assert.deepEqual([off[0].version, off[0].certified, off[0].certificationReasonCode, off[0].launches], ['2.1.304', false, 'NO_RECORD', 0]);

    // The record ran out, and the installed version moved out of range: the two other codes a person meets.
    setCertificationGate(certificationGateFrom(async () => [record('claude', { expiresAt: '2026-01-02T00:00:00Z' })], () => '2.1.304'));
    assert.equal((await claude()).certificationReasonCode, 'EXPIRED');
    setCertificationGate(certificationGateFrom(async () => [record('claude', { harnessVersionRange: { minimum: '2.0.0', maximumExclusive: '2.1.0' } })], () => '2.1.304'));
    assert.equal((await claude()).certificationReasonCode, 'VERSION_OUT_OF_RANGE');

    // Certified: on, no code. Then launches: one that names its own model (left alone, EXPLICIT_MODEL), one with no note at all.
    setCertificationGate(certificationGateFrom(async () => [record('claude')], () => '2.1.304'));
    const on = await claude();
    assert.deepEqual([on.certified, on.certificationReasonCode, on.launches], [true, null, 0]);
    await event(home, repo, 'claude', 'tool.proposed', { toolName: 'Agent', subagentType: 'Explore', requestedModel: 'opus', toolInputBytes: 600, toolInputKeys: ['prompt'] });
    await event(home, repo, 'claude', 'worker.started', { agentType: 'Explore' }, { agentId: 'agent-1' });
    await event(home, repo, 'claude', 'worker.started', { agentType: 'code-reviewer' }, { agentId: 'agent-2' });
    const until = Date.now() + 30_000;
    let seen = await claude();
    while (seen.launches < 2 && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      seen = await claude();
    }
    assert.deepEqual([seen.launches, seen.routed, seen.advised, seen.leftAlone, seen.unknown, seen.days], [2, 0, 0, 1, 1, 7]);
    assert.deepEqual(seen.reasons, [{ code: 'EXPLICIT_MODEL', count: 1 }]);
    // Content-free: no subagent type or prompt in the view.
    assert.doesNotMatch(JSON.stringify(seen), /Explore|code-reviewer|opus/);
  } finally {
    await started.daemon.stop('test');
  }
});

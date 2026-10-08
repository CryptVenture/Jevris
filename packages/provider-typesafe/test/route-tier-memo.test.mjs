// Tiered routing, step 2b (owner decisions 2026-10-08): `jevris route` produces the tier on a default Claude Code install (the
// hooks.route certification is the proof of Claude Code's own family aliases, HARNESS_ALIAS) and keeps it as the session's tier
// memo for ten minutes; the subagent hook reads that memo and never asks Jev. Other harnesses still need local evidence.
// Temporary homes, scripted engine, no live call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');

const ops = Object.fromEntries(provider.sidecarOps.map((def) => [def.op, def]));
const HARD = { title: 'rework the zebra login flow', paths: ['src/auth/login.ts'], checkIds: ['test'] };
const WS = 'w-tier-memo';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const fixedDeadline = (budgetMs) => ({ budgetMs, remainingMs: () => budgetMs, expired: () => false });

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-tier-memo-'));
  core.clearSessionTierMemos();
  provider.setRouteCertification(null);
  t.after(() => {
    provider.setRouteCertification(null);
    core.clearSessionTierMemos();
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

async function route(dir, body) {
  const ctx = { op: 'route', client: 'cli', scopes: ['status', 'advice'], workspace: { id: WS, root: null }, body, home: dir, signal: new AbortController().signal, deadline: fixedDeadline(60_200), store: undefined, killSwitchStopped: false, engine: undefined, trace() {}, mode: 'advise', jevAssist: 'off' };
  const out = await ops.route.handle(ctx);
  assert.equal(out.ok, true, JSON.stringify(out));
  return out.body;
}

test('a default Claude Code install gets the tier once hooks.route is certified, and not before; another harness with no local evidence gets none', async (t) => {
  const dir = home(t);
  const request = { currentModel: 'claude-sonnet-5-5', harness: 'claude', authMode: 'subscription', task: HARD };
  assert.equal((await route(dir, request)).tier, undefined, 'no certification, no alias proof, no local evidence: no tier');
  provider.setRouteCertification(async () => true);
  const out = await route(dir, request);
  assert.deepEqual([out.tier.tier, out.tier.baselineModel, out.tier.targetModel, out.tier.basis], ['step-up', 'claude-sonnet-5-5', 'claude-opus-5-5', 'tier-rule']);
  assert.ok(out.tier.candidates.every((id) => id.startsWith('claude-')) && !out.tier.candidates.includes('claude-fable-5-1'));
  // The proof is Claude Code's own: Codex and the others get nothing from it.
  for (const [harness, model] of [['codex', 'gpt-6.1-sol'], ['antigravity', 'gemini-3.8-flash'], ['kilocode', 'gpt-6.1-sol'], ['opencode', 'claude-sonnet-5-5']]) {
    assert.equal((await route(dir, { currentModel: model, harness, authMode: 'api-key', task: HARD })).tier, undefined, harness);
  }
  // A throwing or false check is not certified.
  provider.setRouteCertification(async () => {
    throw new Error('boom');
  });
  assert.equal((await route(dir, request)).tier, undefined);
});

test('the judged tier is kept for the session and the harness for ten minutes; the subagent hook reads it and goes up, with no Jev call', async (t) => {
  const dir = home(t);
  provider.setRouteCertification(async () => true);
  await route(dir, { currentModel: 'claude-sonnet-5-5', harness: 'claude', authMode: 'subscription', sessionId: 'sess-memo', task: HARD });
  const now = Date.now();
  const own = core.readSessionTier(WS, 'sess-memo', now);
  assert.deepEqual([own.tier, own.targetModelId, own.baselineModelId, own.basis], ['step-up', 'claude-opus-5-5', 'claude-sonnet-5-5', 'tier-rule']);
  assert.ok(own.reasonCodes.includes('TIER_PROTECTED_PATH'));
  assert.doesNotMatch(JSON.stringify(own), /zebra|login/, 'ids and codes only: no title, no path');
  assert.equal(core.readSessionTier(WS, 'another', now), null);
  assert.equal(core.readSessionTier(WS, 'another', now, 'claude').tier, 'step-up', 'the harness slot serves a hook whose session the route request did not name');
  assert.equal(core.readSessionTier(WS, 'sess-memo', now + core.SESSION_TIER_MEMO_TTL_MS + 5000), null, 'ten minutes');
  // The hook: a write-capable launch in the same session goes up, a read-only one down.
  const record = (features) => ({
    id: 'cert-claude-1', schemaVersion: '1.0', harness: 'claude', actuatorId: 'claude-hooks', harnessVersionRange: { minimum: '0.0.1', maximumExclusive: '99.0.0' },
    operatingSystems: ['darwin', 'linux', 'win32'], models: [], tools: [], limitations: [], fixtureSuiteHash: `sha256:${'a'.repeat(64)}`,
    features: features.map((featureId) => ({ featureId, status: 'certified', reasonCode: 'FIXTURES_PASSED' })), certifiedAt: '2026-09-01T00:00:00Z', expiresAt: '2099-12-01T00:00:00Z', signature: 'sig',
  });
  const subscriber = provider.createDecisionSubscriber({ handlers: { 'worker-creation': [provider.subagentRouteAdvice] }, certifications: provider.recordsCertificationSource(async () => [record(['hooks.route', 'hooks.context'])]), now: () => now, operatingSystem: 'linux' });
  const event = (payload, k) => ({ schemaVersion: '1.0', harness: 'claude', nativeEventName: 'PreToolUse', kind: 'tool.proposed', sessionId: 'sess-memo', turnId: null, toolUseId: k, toolName: 'Agent', agentId: null, model: 'claude-sonnet-5-5', permissionMode: null, cwd: null, trigger: null, blocking: true, responseRequired: true, payload: { toolName: 'Agent', toolInputKeys: ['prompt', 'subagent_type'], ...payload }, dedupKey: sha(k) });
  const calls = [];
  const engine = { providerConfigured: false, now: () => now, decide: () => (calls.push('decide'), Promise.reject(new Error('no'))), recordAdvice: async () => ({ ok: false }) };
  const ctx = (envelope) => ({ op: 'event', client: 'hook', scopes: ['observe'], workspace: { id: WS, root: dir }, body: { envelope, deliveryKey: `k-${envelope.dedupKey.slice(0, 8)}`, revision: 'rev-1', harnessVersion: '2.1.0' }, home: dir, signal: new AbortController().signal, deadline: fixedDeadline(900), store: null, killSwitchStopped: false, engine, trace() {}, mode: 'bounded-auto' });
  const up = await subscriber.handle(ctx(event({ subagentType: 'general-purpose', toolInputBytes: 400 }, 'a1')));
  assert.deepEqual([up.hookOutcome.kind, up.hookOutcome.model, up.reasonCode], ['route', 'claude-opus-5-5', 'SUBAGENT_ROUTE_TIER_UP']);
  const down = await subscriber.handle(ctx(event({ subagentType: 'Explore', toolInputBytes: 400 }, 'a2')));
  assert.deepEqual([down.hookOutcome.kind, down.hookOutcome.model], ['route', 'claude-haiku-5-5']);
  assert.deepEqual(calls, []);
});

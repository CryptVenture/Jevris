// Owner decision 0eb319de: the decision subscriber asks modeAllows. A certified route renders only
// in bounded-auto; in advise it is explained with its fallback text; in observe the handlers still
// run (the counterfactual is recorded) but nothing is shown; in off no handler runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const { createDecisionSubscriber, recordsCertificationSource } = await import('../dist/index.js');

const NOW = Date.parse('2026-09-25T10:00:00Z');
let n = 0;

function ctx(mode) {
  n += 1;
  const envelope = {
    schemaVersion: '1.0', harness: 'claude', nativeEventName: 'Hook', kind: 'tool.proposed', sessionId: 'sess-mode', turnId: null, toolUseId: `tu-mode-${n}`, toolName: 'Agent',
    agentId: null, model: null, permissionMode: null, cwd: null, trigger: null, blocking: true, responseRequired: false, payload: {}, dedupKey: createHash('sha256').update(`mode-${n}`).digest('hex'),
  };
  return {
    op: 'event', client: 'hook', scopes: ['observe'], workspace: { id: 'w1', root: '/nowhere' }, body: { envelope, deliveryKey: `k-mode-${n}`, revision: 'rev-1', harnessVersion: '2.1.0' }, home: '/nonexistent-home',
    signal: new AbortController().signal, deadline: { remainingMs: () => 500, expired: () => false }, store: null, killSwitchStopped: false, engine: undefined, trace: () => {}, ...(mode === undefined ? {} : { mode }),
  };
}

const certification = {
  id: 'cert-claude-1', schemaVersion: '1.0', harness: 'claude', actuatorId: 'claude-hooks', harnessVersionRange: { minimum: '2.0.0', maximumExclusive: '3.0.0' },
  operatingSystems: ['darwin', 'linux', 'win32'], models: [], tools: [], limitations: [], fixtureSuiteHash: `sha256:${'a'.repeat(64)}`,
  features: [{ featureId: 'hooks.route', status: 'certified', reasonCode: 'FIXTURES_PASSED' }],
  certifiedAt: '2026-09-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z', signature: 'sig',
};

const FALLBACK = 'Jevris suggests a smaller model for this worker.';

test('a certified route by mode: rendered, explained, recorded only, or not asked', async () => {
  const seen = {};
  for (const mode of ['off', 'observe', 'advise', 'bounded-auto', undefined]) {
    let asked = 0;
    let committed = 0;
    const route = () => {
      asked += 1;
      return { hookOutcome: { kind: 'route', model: 'claude-sonnet-4-5' }, fallbackText: FALLBACK, reasonCode: 'ROUTE_ADVICE', decisionId: 'd-route', commit: () => ((committed += 1), true) };
    };
    const sub = createDecisionSubscriber({ handlers: { 'worker-creation': [route] }, certifications: recordsCertificationSource(async () => [certification]), now: () => NOW, operatingSystem: 'linux' });
    const result = await sub.handle(ctx(mode));
    seen[String(mode)] = { outcome: result.hookOutcome.kind, asked, committed, reasonCode: result.reasonCode };
    if (mode === 'advise') assert.deepEqual(result.hookOutcome, { kind: 'explain', text: FALLBACK });
  }
  assert.deepEqual(seen, {
    off: { outcome: 'observe', asked: 0, committed: 0, reasonCode: 'MODE_OFF' },
    observe: { outcome: 'observe', asked: 1, committed: 0, reasonCode: 'MODE_DOES_NOT_ADVISE' },
    advise: { outcome: 'explain', asked: 1, committed: 1, reasonCode: 'ROUTE_ADVICE' },
    'bounded-auto': { outcome: 'route', asked: 1, committed: 1, reasonCode: 'ROUTE_ADVICE' },
    // A direct call with no sidecar-resolved mode is narrowed only by certification.
    undefined: { outcome: 'route', asked: 1, committed: 1, reasonCode: 'ROUTE_ADVICE' },
  });
});

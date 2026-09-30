import test from 'node:test';
import assert from 'node:assert/strict';

// GOV-02..04 (JEV-0021): every sidecar operation that changes something answers KILL_SWITCH while
// the kill switch is stopped. The exemptions are named, each with its reason, in docs/security.md.

const { loadOps } = await import('../dist/index.js');
const { accessLimitsOps } = await import('../dist/access-limits-ops.js');
const { jevReenableOps } = await import('../dist/jev-reenable-ops.js');
const { providerConsentOps } = await import('../dist/provider-consent.js');
const storeApi = await import('@jevris/store');

/** Package ops the generic guard (SidecarOpDefinition.stoppedByKillSwitch) stops. */
const STOPPED_BY_FLAG = ['decision.feedback', 'checkpoint', 'handoff.import', 'verify', 'verify.import-ci'];

test('the package ops that record or change something carry the kill-switch flag', async () => {
  const { ops } = await loadOps();
  for (const name of STOPPED_BY_FLAG) {
    const definition = ops.get(name);
    assert.ok(definition, `${name} is registered`);
    assert.equal(definition.stoppedByKillSwitch, true, `${name} must be stopped by the kill switch`);
  }
  // Read-only and advice ops are never flagged: a stopped Jevris still answers status and explains.
  for (const name of ['explain', 'decision.get', 'verify.status', 'evidence.get', 'evidence.select', 'recover', 'handoff.export']) {
    if (ops.has(name)) assert.notEqual(ops.get(name).stoppedByKillSwitch, true, `${name} stays available while stopped`);
  }
});

test('access-limits.clear, jev.reenable and provider.consent.grant refuse a stopped kill switch and say to clear it first', async () => {
  const held = () => undefined;
  // A store handle that is never used: each refusal below comes before any store read or write.
  const heldStore = () => ({ store: {}, api: storeApi });
  const defs = new Map(
    [
      ...accessLimitsOps({ store: held, clear: async () => ({ ok: false }) }),
      ...jevReenableOps({ store: held, engine: () => undefined }),
      ...providerConsentOps({ store: heldStore }),
    ].map((d) => [d.op, d]),
  );
  for (const op of ['access-limits.clear', 'jev.reenable', 'provider.consent.grant']) {
    const definition = defs.get(op);
    assert.ok(definition, op);
    const ctx = (killSwitchStopped) => ({ body: { channel: 'terminal', all: true, provider: 'anthropic', textVersion: 'x', entries: 'all' }, killSwitchStopped, home: '/nonexistent', store: undefined });
    const stopped = await definition.handle(ctx(true));
    assert.equal(stopped.ok, false, op);
    assert.equal(stopped.reasonCode, 'KILL_SWITCH', op);
    assert.match(stopped.message, /Clear the kill switch first/, op);
    // Paired: with the switch clear, the same call goes on to its own checks (never KILL_SWITCH).
    const clear = await definition.handle(ctx(false));
    assert.notEqual(clear.reasonCode, 'KILL_SWITCH', op);
  }
});

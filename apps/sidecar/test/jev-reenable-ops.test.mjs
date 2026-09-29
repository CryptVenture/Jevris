// `jevris credential reenable` (coordinator decision ea2af91a on A's R77 finding): `jev.reenable`
// is an admin op, only from a terminal. It clears the engine's own billing (402) or account (403)
// disable, never a key refusal (401), and leaves one audit row with a count and the reason class.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';

const { startDaemon, sidecarRequest } = await import('../dist/index.js');
const { jevReenableOps } = await import('../dist/jev-reenable-ops.js');
const { circuitDisabledReason, jevCircuitOf } = await import('../dist/state.js');
const core = await import('@jevris/core');
const { surfacePayloadContract } = await import('@jevris/contracts');
const api = await import('@jevris/store');

const T = Date.now();
const KEY = 'typesafe:acct';
const FP = 'fp-current';

function tempDir(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** An engine shaped as core's decision engine builds its circuit handle, over a real breaker. */
async function engineWith(home, failure) {
  const breaker = await core.CircuitBreaker.load(join(home, 'jev-circuit.json'), { now: () => T });
  if (failure !== null) breaker.recordFailure(KEY, failure, FP);
  let calls = 0;
  const engine = {
    providerConfigured: true,
    decide: async () => {
      calls += 1;
      throw new Error('no Jev call is expected');
    },
    circuit: {
      snapshot: () => breaker.snapshot(KEY, FP),
      clearDisabled: async () => {
        const result = breaker.clearDisabled(KEY);
        return { ...result, persisted: result.ok ? await breaker.persist() : true };
      },
    },
  };
  return { engine, breaker, calls: () => calls };
}

function opOf(deps) {
  return new Map(jevReenableOps(deps).map((d) => [d.op, d])).get('jev.reenable');
}

test('reenable: terminal only; a billing disable clears to observe-only, persisted, with one audit row', async () => {
  const home = tempDir('b-reenable-');
  const store = api.openStore({ path: join(home, 'jevris.db'), role: 'sidecar', workspaceId: 'host', hostScope: 'hostA', fsKind: () => ({ kind: 'local', label: 't' }) });
  assert.equal(store.ok, true, JSON.stringify(store));
  try {
    const held = await engineWith(home, 'billing');
    assert.equal(held.engine.circuit.snapshot().state, 'disabled');
    assert.match(circuitDisabledReason(held.engine) ?? '', /PROVIDER_BILLING.*jevris credential reenable/);
    assert.deepEqual(jevCircuitOf(held.engine), { state: 'disabled', reasonCode: 'PROVIDER_BILLING', reasonClass: 'BILLING', since: new Date(T).toISOString(), command: 'jevris credential reenable' });
    const op = opOf({ store: () => ({ store, api }), engine: () => held.engine, nowMs: () => T + 1 });
    assert.equal(op.scope, 'admin');
    const call = (body) => op.handle({ home, body });

    assert.equal((await call({})).reasonCode, 'CHANNEL_REFUSED', 'no channel');
    assert.equal((await call({ channel: 'cli' })).reasonCode, 'CHANNEL_REFUSED', 'a non-interactive CLI');
    assert.equal(held.engine.circuit.snapshot().state, 'disabled', 'a refused call changes nothing');

    const answer = await call({ channel: 'terminal', actor: 'warren', key: 'someone-else' });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.deepEqual(answer.body, { cleared: 'BILLING', persisted: true, audited: true });
    assert.equal(held.engine.circuit.snapshot().state, 'observe-only');
    assert.equal(circuitDisabledReason(held.engine), null);
    assert.equal(jevCircuitOf(held.engine), null, 'observe-only is not disabled');
    assert.equal(held.calls(), 0, 'nothing calls Jev');

    const reloaded = await core.CircuitBreaker.load(join(home, 'jev-circuit.json'), { now: () => T });
    assert.equal(reloaded.snapshot(KEY, FP).state, 'observe-only', 'the clear survives a restart');

    assert.equal((await call({ channel: 'terminal' })).reasonCode, 'NOT_DISABLED', 'a second clear has nothing to do');

    const rows = api.readAudit(store, { kinds: ['credential.reenable'] });
    assert.deepEqual(
      rows.map((r) => [r.actor, r.channel, r.detail]),
      [['warren', 'terminal', { count: 1, reasonClass: 'BILLING' }]],
      'one row: a count and the reason class, never a key or fingerprint',
    );
  } finally {
    api.closeStore(store);
    rmSync(home, { recursive: true, force: true });
  }
});

test('reenable: an account disable clears; a key refusal never does; no circuit is NOT_DISABLED', async () => {
  const home = tempDir('b-reenable2-');
  try {
    const account = await engineWith(home, 'forbidden');
    assert.equal(jevCircuitOf(account.engine).reasonCode, 'PROVIDER_DISABLED');
    assert.equal(jevCircuitOf(account.engine).command, 'jevris credential reenable');
    const cleared = await opOf({ store: () => undefined, engine: () => account.engine }).handle({ home, body: { channel: 'terminal' } });
    assert.equal(cleared.ok, true, JSON.stringify(cleared));
    assert.deepEqual(cleared.body, { cleared: 'ACCOUNT', persisted: true, audited: false });

    const authHome = tempDir('b-reenable3-');
    try {
      const auth = await engineWith(authHome, 'auth');
      assert.equal(auth.engine.circuit.snapshot().state, 'disabled');
      assert.deepEqual(jevCircuitOf(auth.engine), { state: 'disabled', reasonCode: 'PROVIDER_DISABLED', reasonClass: 'AUTH', since: new Date(T).toISOString(), command: 'jevris credential set' });
      const refused = await opOf({ store: () => undefined, engine: () => auth.engine }).handle({ home: authHome, body: { channel: 'terminal' } });
      assert.equal(refused.reasonCode, 'AUTH_NEEDS_NEW_KEY');
      assert.match(refused.message ?? '', /jevris credential set/);
      assert.equal(auth.engine.circuit.snapshot().state, 'disabled', 'a key refusal stays tied to the key');
    } finally {
      rmSync(authHome, { recursive: true, force: true });
    }

    for (const engine of [undefined, null, {}, { circuit: null }, { circuit: {} }]) {
      assert.equal((await opOf({ store: () => undefined, engine: () => engine }).handle({ home, body: { channel: 'terminal' } })).reasonCode, 'NOT_DISABLED');
      assert.equal(circuitDisabledReason(engine), null);
      assert.equal(jevCircuitOf(engine), null);
    }
    const odd = { circuit: { clearDisabled: async () => ({ ok: true, cleared: 'AUTH' }), snapshot: () => { throw new Error('x'); } } };
    assert.equal((await opOf({ store: () => undefined, engine: () => odd }).handle({ home, body: { channel: 'terminal' } })).reasonCode, 'WRITE_FAILED', 'an answer outside the contract clears nothing');
    assert.equal(circuitDisabledReason(odd), null, 'a throwing snapshot reads as not disabled');
    const throwing = { circuit: { clearDisabled: async () => { throw new Error('disk'); } } };
    assert.equal((await opOf({ store: () => undefined, engine: () => throwing }).handle({ home, body: { channel: 'terminal' } })).reasonCode, 'WRITE_FAILED');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('reenable answers only on the CLI key; hook and MCP scopes are refused', { skip: managedHostSkip() }, async () => {
  const home = tempDir('b-reenable4-');
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  try {
    for (const scope of ['hook', 'mcp']) {
      const refused = await sidecarRequest({ home, op: 'jev.reenable', scope, body: { channel: 'terminal' } });
      assert.equal(refused.ok, false, scope);
    }
    const answered = await sidecarRequest({ home, op: 'jev.reenable', scope: 'cli', body: { channel: 'terminal' } });
    assert.equal(answered.ok, false);
    assert.equal(answered.reasonCode, 'NOT_DISABLED', 'no credential: no circuit to re-enable');
  } finally {
    await started.daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  }
});

test('status carries the disabled circuit as jevCircuit and degradedReason; a CLI reenable clears both (E e1220f80)', { skip: managedHostSkip() }, async () => {
  const home = tempDir('b-reenable5-');
  const root = join(home, 'ws');
  mkdirSync(root);
  const held = await engineWith(home, 'billing');
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined, engine: held.engine });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  try {
    const status = async () => {
      const res = await sidecarRequest({ home, op: 'status', scope: 'cli', workspace: root, body: {} });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(surfacePayloadContract('status').validate(res.result).ok, true, 'the status payload fits the contract');
      return res.result;
    };
    const before = await status();
    assert.deepEqual(before.jevCircuit, { state: 'disabled', reasonCode: 'PROVIDER_BILLING', reasonClass: 'BILLING', since: new Date(T).toISOString(), command: 'jevris credential reenable' });
    assert.equal(before.decisionHealth, 'degraded');
    assert.match(before.degradedReason, /PROVIDER_BILLING.*jevris credential reenable/);

    const cleared = await sidecarRequest({ home, op: 'jev.reenable', scope: 'cli', body: { channel: 'terminal' } });
    assert.equal(cleared.ok, true, JSON.stringify(cleared));
    assert.equal(cleared.result.cleared, 'BILLING');
    const after = await status();
    assert.equal(after.jevCircuit, null);
    assert.doesNotMatch(String(after.degradedReason), /PROVIDER_BILLING/);
    assert.equal(held.calls(), 0, 'nothing calls Jev');
  } finally {
    await started.daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  }
});

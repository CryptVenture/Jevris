// Access limits R78 (agreed with E): `access-limits.clear` is an admin op, only from a terminal,
// by the keys a person saw (or all), and each clear leaves one audit row with counts and classes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';

const { startDaemon, sidecarRequest } = await import('../dist/index.js');
const { accessLimitsOps, ACCESS_LIMITS_CLEAR_MAX_KEYS } = await import('../dist/access-limits-ops.js');
const core = await import('@jevris/core');
const contracts = await import('@jevris/contracts');
const api = await import('@jevris/store');

const T = Date.now();

function tempDir(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** Two entries under `home` (codex under each sign-in), recorded as the product records them. */
async function seed(home) {
  const text = (nowMs) => ({ port: 'codex', channel: 'error-text', certified: false, text: contracts.matchAccessText("You've hit your usage limit.", 'codex', nowMs) });
  for (const authMode of ['subscription', 'api-key']) {
    const classification = core.classifyAccessSignal(text(T), authMode, T);
    const scope = { harness: 'codex', authMode, servingHost: 'openai', modelId: 'gpt-5.5', family: null };
    const recorded = await core.recordAccessLimit({ home, scope, classification, source: 'owned-run', nowMs: T });
    assert.equal(recorded.ok, true, JSON.stringify(recorded));
  }
  return (await core.readAccessLimits(home)).entries;
}

test('clear: terminal only, known keys or all, and one audit row of counts and classes', async () => {
  const home = tempDir('b-limits-');
  const store = api.openStore({ path: join(home, 'jevris.db'), role: 'sidecar', workspaceId: 'host', hostScope: 'hostA', fsKind: () => ({ kind: 'local', label: 't' }) });
  assert.equal(store.ok, true, JSON.stringify(store));
  try {
    const entries = await seed(home);
    assert.equal(entries.length, 2);
    const ops = new Map(accessLimitsOps({ store: () => ({ store, api }), nowMs: () => T + 1 }).map((d) => [d.op, d]));
    const clear = ops.get('access-limits.clear');
    assert.equal(clear.scope, 'admin');
    const call = (body) => clear.handle({ home, body });

    assert.equal((await call({ entries: 'all' })).reasonCode, 'CHANNEL_REFUSED', 'no channel');
    assert.equal((await call({ entries: 'all', channel: 'cli' })).reasonCode, 'CHANNEL_REFUSED', 'a non-interactive CLI');
    for (const bad of [undefined, [], ['ZZZZ'], [entries[0].key, entries[0].key], 'some', Array.from({ length: ACCESS_LIMITS_CLEAR_MAX_KEYS + 1 }, (_, i) => i.toString(16).padStart(16, '0'))]) {
      assert.equal((await call({ entries: bad, channel: 'terminal' })).reasonCode, 'INVALID_INPUT', JSON.stringify(bad)?.slice(0, 40));
    }
    assert.equal((await core.readAccessLimits(home)).entries.length, 2, 'a refused call changes nothing');

    const unknown = await call({ entries: ['0123456789abcdef'], channel: 'terminal' });
    assert.equal(unknown.ok, true);
    assert.deepEqual(unknown.body.cleared, [], 'an unknown key clears nothing');

    const one = await call({ entries: [entries[0].key], channel: 'terminal', actor: 'warren' });
    assert.equal(one.ok, true, JSON.stringify(one));
    assert.deepEqual(one.body.cleared.map((c) => c.key), [entries[0].key]);
    assert.equal(one.body.audited, true);
    assert.deepEqual((await core.readAccessLimits(home)).entries.map((e) => e.key), [entries[1].key]);

    const all = await call({ entries: 'all', channel: 'terminal', actor: 'bad actor name!' });
    assert.deepEqual(all.body.cleared.map((c) => c.key), [entries[1].key]);
    assert.equal((await core.readAccessLimits(home)).entries.length, 0);

    const rows = api.readAudit(store, { kinds: ['access-limit.clear'] });
    assert.deepEqual(
      rows.map((r) => [r.actor, r.channel, r.detail]),
      [
        ['cli', 'terminal', { classes: [], count: 0 }],
        ['warren', 'terminal', { classes: [entries[0].class], count: 1 }],
        ['cli', 'terminal', { classes: [entries[1].class], count: 1 }],
      ],
      'the actor falls back to cli; the row carries counts and classes, never a scope or key',
    );
  } finally {
    api.closeStore(store);
    rmSync(home, { recursive: true, force: true });
  }
});

test('clear: a failed write clears nothing; with no store the clear still answers, unaudited', async () => {
  const home = tempDir('b-limits2-');
  try {
    const failing = new Map(accessLimitsOps({ store: () => undefined, clear: async () => ({ ok: false, cleared: [] }) }).map((d) => [d.op, d]));
    assert.equal((await failing.get('access-limits.clear').handle({ home, body: { entries: 'all', channel: 'terminal' } })).reasonCode, 'WRITE_FAILED');
    const throwing = new Map(accessLimitsOps({ store: () => undefined, clear: async () => { throw new Error('disk'); } }).map((d) => [d.op, d]));
    assert.equal((await throwing.get('access-limits.clear').handle({ home, body: { entries: 'all', channel: 'terminal' } })).reasonCode, 'WRITE_FAILED');
    await seed(home);
    const noStore = new Map(accessLimitsOps({ store: () => undefined }).map((d) => [d.op, d]));
    const answer = await noStore.get('access-limits.clear').handle({ home, body: { entries: 'all', channel: 'terminal' } });
    assert.equal(answer.ok, true);
    assert.equal(answer.body.cleared.length, 2);
    assert.equal(answer.body.audited, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('clear answers only on the CLI key; hook and MCP scopes are refused', { skip: managedHostSkip() }, async () => {
  const home = tempDir('b-limits3-');
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  try {
    for (const scope of ['hook', 'mcp']) {
      const refused = await sidecarRequest({ home, op: 'access-limits.clear', scope, body: { entries: 'all', channel: 'terminal' } });
      assert.equal(refused.ok, false, scope);
    }
    const answered = await sidecarRequest({ home, op: 'access-limits.clear', scope: 'cli', body: { entries: 'all', channel: 'terminal' } });
    assert.equal(answered.ok, true, JSON.stringify(answered));
    assert.deepEqual(answered.result.cleared, []);
  } finally {
    await started.daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  }
});

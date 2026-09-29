// Per-provider egress consent through the sidecar (owner DOMAINS 7be3c43 and OD-4): admin ops on
// the CLI key only, a grant only from a terminal and only for today's consent text, and the
// engine's point read for C's route elimination.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';

const { startDaemon, sidecarRequest } = await import('../dist/index.js');
const { providerConsentOps, providerConsentReader, currentConsentTextVersion, knownProviders, partyOf, servingHostIds } = await import('../dist/provider-consent.js');
const api = await import('@jevris/store');

function tempDir(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

async function withStore(fn) {
  const dir = tempDir('b-consent-');
  const store = api.openStore({ path: join(dir, 'jevris.db'), role: 'sidecar', workspaceId: 'host', hostScope: 'hostA', fsKind: () => ({ kind: 'local', label: 't' }) });
  assert.equal(store.ok, true, JSON.stringify(store));
  try {
    return await fn(store);
  } finally {
    api.closeStore(store);
    rmSync(dir, { recursive: true, force: true });
  }
}

test('grant needs the terminal channel and today\'s text; revoke tightens; status says whether a grant is current', async () => {
  await withStore(async (store) => {
    let text = { deepseek: 'deepseek-1', openai: 'openai-1' };
    const ops = new Map(providerConsentOps({ store: () => ({ store, api }), text: (p) => text[p], nowMs: () => 5_000, knownProviders: async () => ['openai'] }).map((d) => [d.op, d]));
    const call = (op, body) => ops.get(op).handle({ body });
    for (const op of ['provider.consent.status', 'provider.consent.grant', 'provider.consent.revoke']) assert.equal(ops.get(op).scope, 'admin', op);

    assert.equal(call('provider.consent.grant', { provider: 'deepseek', textVersion: 'deepseek-1' }).reasonCode, 'CHANNEL_REFUSED');
    assert.equal(call('provider.consent.grant', { provider: 'deepseek', textVersion: 'deepseek-0', channel: 'terminal' }).reasonCode, 'PROVIDER_CONSENT_TEXT_MISMATCH');
    assert.equal(call('provider.consent.grant', { provider: 'unknown', textVersion: 'x', channel: 'terminal' }).reasonCode, 'UNKNOWN_PROVIDER');
    assert.equal(call('provider.consent.grant', { provider: 'Bad Id', textVersion: 'x', channel: 'terminal' }).reasonCode, 'UNKNOWN_PROVIDER');
    assert.deepEqual(call('provider.consent.grant', { provider: 'deepseek', textVersion: 'deepseek-1', channel: 'terminal' }), { ok: true, body: { result: 'granted', provider: 'deepseek', party: 'maker', textVersion: 'deepseek-1' } });

    const read = providerConsentReader(() => ({ store, api }), (p) => text[p]);
    assert.deepEqual(read('deepseek'), { granted: true, provider: 'deepseek', textVersion: 'deepseek-1', grantedAtMs: 5_000 });
    assert.deepEqual(read('moonshot'), { granted: false, provider: 'moonshot', reasonCode: 'PROVIDER_CONSENT_MISSING' }, 'no text, no consent');
    assert.deepEqual(providerConsentReader(() => undefined, (p) => text[p])('deepseek'), { granted: false, provider: 'deepseek', reasonCode: 'PROVIDER_CONSENT_UNREADABLE' });

    text = { deepseek: 'deepseek-2', openai: 'openai-1' };
    assert.equal(read('deepseek').reasonCode, 'PROVIDER_CONSENT_STALE');
    assert.deepEqual(call('provider.consent.status', {}).body.providers, [
      { provider: 'deepseek', party: 'maker', state: 'granted', textVersion: 'deepseek-1', grantedAtMs: 5_000, revokedAtMs: null, revokedBy: null, current: false },
    ]);
    // Revoke all also refuses every known provider never granted (openai here), so a provider the
    // signed-in default would allow is refused too (B's routing review).
    assert.deepEqual((await call('provider.consent.revoke', { all: true })).body, { result: 'revoked', providers: ['deepseek', 'openai'] });
    assert.deepEqual((await call('provider.consent.revoke', { provider: 'deepseek' })).body, { result: 'not-granted', providers: [] });
    assert.equal(read('deepseek').reasonCode, 'PROVIDER_CONSENT_REVOKED');
    assert.equal(read('openai').reasonCode, 'PROVIDER_CONSENT_REVOKED');
    // One provider never granted can be refused on its own; the stored row names no text version.
    assert.deepEqual((await call('provider.consent.revoke', { provider: 'moonshot' })).body, { result: 'revoked', providers: ['moonshot'] });
    const moonshot = call('provider.consent.status', {}).body.providers.find((row) => row.provider === 'moonshot');
    assert.deepEqual([moonshot.state, moonshot.textVersion, moonshot.grantedAtMs, moonshot.current], ['revoked', api.NEVER_GRANTED_TEXT_VERSION, 0, false]);
  });
});

test('the consent ops answer only on the CLI key; MCP and hook scopes are refused', { skip: managedHostSkip() }, async () => {
  const home = tempDir('b-consent-daemon-');
  try {
    const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined });
    assert.equal(started.ok, true, started.ok ? '' : started.message);
    try {
      const status = await sidecarRequest({ home, op: 'provider.consent.status', scope: 'cli', body: {} });
      assert.equal(status.ok, true, JSON.stringify(status));
      assert.deepEqual(status.result.providers, []);
      for (const scope of ['mcp', 'hook']) {
        const refused = await sidecarRequest({ home, op: 'provider.consent.grant', scope, body: { provider: 'deepseek', textVersion: 'x', channel: 'terminal' } });
        assert.equal(refused.ok, false, scope);
      }
      const noTerminal = await sidecarRequest({ home, op: 'provider.consent.grant', scope: 'cli', body: { provider: 'deepseek', textVersion: 'x' } });
      assert.equal(noTerminal.ok, false);
      assert.equal(noTerminal.reasonCode, 'CHANNEL_REFUSED');
      // Today's text comes from contracts' PROVIDER_CONSENT_TEXT (E); a stale version is refused.
      const version = currentConsentTextVersion('deepseek');
      assert.equal(typeof version, 'string');
      const stale = await sidecarRequest({ home, op: 'provider.consent.grant', scope: 'cli', body: { provider: 'deepseek', textVersion: 'deepseek-1900-01-01', channel: 'terminal' } });
      assert.equal(stale.reasonCode, 'PROVIDER_CONSENT_TEXT_MISMATCH');
      const granted = await sidecarRequest({ home, op: 'provider.consent.grant', scope: 'cli', body: { provider: 'deepseek', textVersion: version, channel: 'terminal' } });
      assert.equal(granted.ok, true, JSON.stringify(granted));
      assert.deepEqual(granted.result, { result: 'granted', provider: 'deepseek', party: 'maker', textVersion: version });
      const listed = await sidecarRequest({ home, op: 'provider.consent.status', scope: 'cli', body: {} });
      assert.deepEqual(listed.result.providers.map((row) => [row.provider, row.state, row.current]), [['deepseek', 'granted', true]]);
    } finally {
      await started.daemon.stop('test');
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('R46: the ops take a pinned serving host as a party: grant, status, revoke all, and a host with no text is never grantable', async () => {
  await withStore(async (store) => {
    const text = { openrouter: 'openrouter-2026-09-28', moonshot: 'moonshot-1' };
    const hosts = () => ['kilo', 'nvidia', 'openrouter'];
    const ops = new Map(providerConsentOps({ store: () => ({ store, api }), text: (p) => text[p], nowMs: () => 7_000, servingHosts: hosts, knownProviders: (home) => knownProviders(home, hosts()) }).map((d) => [d.op, d]));
    const call = (op, body) => ops.get(op).handle({ body, home: tempDir('b-known-') });
    assert.deepEqual(call('provider.consent.grant', { provider: 'openrouter', textVersion: 'openrouter-2026-09-28', channel: 'terminal' }).body, { result: 'granted', provider: 'openrouter', party: 'host', textVersion: 'openrouter-2026-09-28' });
    assert.equal(call('provider.consent.grant', { provider: 'nvidia', textVersion: 'x', channel: 'terminal' }).reasonCode, 'CONSENT_TEXT_MISSING');
    assert.equal(call('provider.consent.grant', { provider: 'openrouter', textVersion: 'openrouter-2026-09-28' }).reasonCode, 'CHANNEL_REFUSED', 'a host grant needs the terminal too');
    assert.deepEqual(call('provider.consent.status', {}).body.providers.map((row) => [row.provider, row.party, row.current]), [['openrouter', 'host', true]]);
    const read = providerConsentReader(() => ({ store, api }), (p) => text[p]);
    assert.equal(read('openrouter').granted, true);
    assert.equal(read('nvidia').reasonCode, 'PROVIDER_CONSENT_MISSING', 'no text reads as not consented');
    // Revoke all covers every pinned host, with text or not, beside the registry's makers.
    const all = (await call('provider.consent.revoke', { all: true })).body;
    for (const id of ['kilo', 'nvidia', 'openrouter', 'moonshot', 'deepseek']) assert.ok(all.providers.includes(id), id);
    assert.equal(read('openrouter').reasonCode, 'PROVIDER_CONSENT_REVOKED');
  });
});

test('R46: party lookup and the text lookup read the pinned host list and both text maps, and fail closed on an id in both', () => {
  assert.equal(partyOf('openrouter', ['openrouter']), 'host');
  assert.equal(partyOf('moonshot', ['openrouter']), 'maker');
  // Whatever contracts pin today, every host id is a valid store id and none is a maker's text id.
  for (const id of servingHostIds()) {
    assert.equal(api.isProviderId(id), true, id);
    assert.equal(partyOf(id), 'host', id);
  }
  assert.equal(currentConsentTextVersion('no-such-party'), undefined);
});

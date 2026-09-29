// Per-provider egress consent (owner DOMAINS 7be3c43 and OD-4): one machine-wide row per provider
// with the consent text version, the grant time and how it was revoked; no email, account id or
// free text. A grant counts only for the text it names; neither a grant nor a revoke ages out, and a
// revoke is stored even for a provider never granted (B's routing review).
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { makeTempDir, removeTempDir } from './temp-dirs.mjs';

const s = await import(new URL('../dist/index.js', import.meta.url).href);
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const DAY = 86_400_000;
const dirs = [];
test.after(() => {
  for (const dir of dirs) removeTempDir(dir);
});

function openHost() {
  const dir = makeTempDir('jevris-store-consent-');
  dirs.push(dir);
  const path = join(dir, 'jevris.db');
  const opened = s.openStore({ path, role: 'sidecar', workspaceId: 'host', hostScope: 'hostA', fsKind: () => ({ kind: 'local', label: 't' }) });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  return { store: opened, path };
}

const who = { actor: 'cli', channel: 'terminal' };

test('the store is at schema 9 with provider_consent; the class keeps grants and revokes, unswept', () => {
  const { store } = openHost();
  assert.ok(s.latestSchemaVersion() >= 9);
  assert.equal(store.schemaVersion, s.latestSchemaVersion());
  assert.equal(s.PROVIDER_CONSENT_RETENTION.table, 'provider_consent');
  assert.equal(s.PROVIDER_CONSENT_RETENTION.swept, false);
  assert.equal(Object.hasOwn(s.PROVIDER_CONSENT_RETENTION, 'window'), false);
  s.closeStore(store);
});

test('a grant counts for its text version only; revoke and re-grant; each change has its audit row', () => {
  const { store, path } = openHost();
  const read = (current = 'deepseek-1') => s.readProviderConsent(store, { provider: 'deepseek', currentTextVersion: current });
  assert.deepEqual(read(), { granted: false, provider: 'deepseek', reasonCode: 'PROVIDER_CONSENT_MISSING' });

  const granted = s.grantProviderConsent(store, { provider: 'deepseek', textVersion: 'deepseek-1', atMs: 1_000, ...who });
  assert.equal(granted.ok, true, JSON.stringify(granted));
  assert.equal(granted.result, 'granted');
  assert.equal(granted.textVersion, 'deepseek-1');
  assert.deepEqual(read(), { granted: true, provider: 'deepseek', textVersion: 'deepseek-1', grantedAtMs: 1_000 });
  assert.deepEqual(read('deepseek-2'), { granted: false, provider: 'deepseek', reasonCode: 'PROVIDER_CONSENT_STALE' }, 'a changed text asks again');
  const again = s.grantProviderConsent(store, { provider: 'deepseek', textVersion: 'deepseek-1', atMs: 2_000, ...who });
  assert.equal(again.result, 'already-granted');
  assert.equal(again.auditSeq, null, 'nothing changed, nothing audited');

  // Any registry provider id is accepted (OD-4), and a revoke of all takes every grant back.
  assert.equal(s.grantProviderConsent(store, { provider: 'openai', textVersion: 'openai-1', atMs: 3_000, ...who }).result, 'granted');
  const revoked = s.revokeProviderConsent(store, { provider: 'all', actor: 'cli', channel: 'cli', atMs: 4_000 });
  assert.equal(revoked.ok, true);
  assert.deepEqual(revoked.providers, ['deepseek', 'openai']);
  assert.deepEqual(read(), { granted: false, provider: 'deepseek', reasonCode: 'PROVIDER_CONSENT_REVOKED' });
  assert.equal(s.revokeProviderConsent(store, { provider: 'deepseek', actor: 'cli', channel: 'cli', atMs: 5_000 }).result, 'not-granted');

  const regrant = s.grantProviderConsent(store, { provider: 'deepseek', textVersion: 'deepseek-2', atMs: 6_000, ...who });
  assert.equal(regrant.result, 'granted');
  assert.deepEqual(read('deepseek-2'), { granted: true, provider: 'deepseek', textVersion: 'deepseek-2', grantedAtMs: 6_000 });

  const rows = s.listProviderConsent(store);
  assert.deepEqual(rows, [
    { provider: 'deepseek', state: 'granted', textVersion: 'deepseek-2', grantedAtMs: 6_000, revokedAtMs: null, revokedBy: null },
    { provider: 'openai', state: 'revoked', textVersion: 'openai-1', grantedAtMs: 3_000, revokedAtMs: 4_000, revokedBy: 'user' },
  ]);

  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const audit = db.prepare("SELECT kind, channel, detail FROM audit_log WHERE kind LIKE 'provider-consent.%' ORDER BY seq").all();
    assert.deepEqual(audit.map((row) => [row.kind, row.channel]), [
      ['provider-consent.grant', 'terminal'],
      ['provider-consent.grant', 'terminal'],
      ['provider-consent.revoke', 'cli'],
      ['provider-consent.grant', 'terminal'],
    ]);
    assert.deepEqual(JSON.parse(audit[3].detail), { provider: 'deepseek', party: 'maker', textVersion: 'deepseek-2', replaced: 'revoked' });
    const columns = db.prepare('PRAGMA table_info(provider_consent)').all().map((c) => c.name);
    assert.deepEqual(columns, ['provider', 'state', 'text_version', 'granted_at_ms', 'revoked_at_ms', 'revoked_by'], 'no email, account or text column');
  } finally {
    db.close();
  }
  s.closeStore(store);
});

test('bad input is refused: provider ids, text versions, and an actor that could hold an email', () => {
  const { store } = openHost();
  for (const provider of ['', 'DeepSeek', 'a b', 'x'.repeat(33), 'all']) {
    const out = s.grantProviderConsent(store, { provider, textVersion: 'v1', atMs: 1, ...who });
    assert.deepEqual(out, { ok: false, reason: 'invalid-input' }, provider);
  }
  assert.equal(s.grantProviderConsent(store, { provider: 'moonshot', textVersion: 'has space', atMs: 1, ...who }).ok, false);
  assert.equal(s.grantProviderConsent(store, { provider: 'moonshot', textVersion: 'v1', atMs: 1, actor: 'someone@example.test', channel: 'terminal' }).ok, false);
  assert.equal(s.grantProviderConsent(store, { provider: 'moonshot', textVersion: 'v1', atMs: 1, actor: 'cli', channel: 'repository' }).ok, false);
  assert.deepEqual(s.readProviderConsent(store, { provider: 'moonshot', currentTextVersion: '' }), { ok: false, reason: 'invalid-input' });
  assert.deepEqual(s.listProviderConsent(store), []);
  s.closeStore(store);
});

test('the retention sweep keeps grants and revokes, however old: a swept revoke would re-allow a signed-in provider', () => {
  const { store } = openHost();
  const now = Date.now();
  s.grantProviderConsent(store, { provider: 'moonshot', textVersion: 'm1', atMs: now - 400 * DAY, ...who });
  s.grantProviderConsent(store, { provider: 'deepseek', textVersion: 'd1', atMs: now - 400 * DAY, ...who });
  s.grantProviderConsent(store, { provider: 'xai', textVersion: 'x1', atMs: now - 400 * DAY, ...who });
  s.revokeProviderConsent(store, { provider: 'deepseek', actor: 'cli', channel: 'cli', atMs: now - 400 * DAY });
  s.revokeProviderConsent(store, { provider: 'xai', actor: 'cli', channel: 'cli', atMs: now - 1 * DAY });
  const swept = s.sweepRetention(store, { policy: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 }, nowMs: now });
  assert.equal(swept.ok, true, JSON.stringify(swept));
  assert.equal(swept.removed.provider_consent ?? 0, 0);
  assert.deepEqual(s.listProviderConsent(store).map((row) => [row.provider, row.state]), [['deepseek', 'revoked'], ['moonshot', 'granted'], ['xai', 'revoked']]);
  s.closeStore(store);
});

test('a revoke is stored for a provider never granted, and reads as revoked, so the signed-in default cannot allow it', () => {
  const { store } = openHost();
  const now = Date.now();
  const revoked = s.revokeProviderConsent(store, { provider: 'openai', actor: 'cli', channel: 'cli', atMs: now });
  assert.equal(revoked.ok, true, JSON.stringify(revoked));
  assert.deepEqual(revoked.providers, ['openai']);
  const [row] = s.listProviderConsent(store);
  assert.equal(row.provider, 'openai');
  assert.equal(row.state, 'revoked');
  assert.equal(row.textVersion, s.NEVER_GRANTED_TEXT_VERSION);
  assert.equal(row.grantedAtMs, 0);
  assert.equal(row.revokedAtMs, now);
  const read = s.readProviderConsent(store, { provider: 'openai', currentTextVersion: 'o1' });
  assert.equal(read.granted, false);
  assert.equal(read.reasonCode, 'PROVIDER_CONSENT_REVOKED');
  // a second revoke changes nothing
  assert.equal(s.revokeProviderConsent(store, { provider: 'openai', actor: 'cli', channel: 'cli', atMs: now + 1 }).result, 'not-granted');
  // a grant then replaces the revoke
  assert.equal(s.grantProviderConsent(store, { provider: 'openai', textVersion: 'o1', atMs: now + 2, ...who }).ok, true);
  assert.equal(s.readProviderConsent(store, { provider: 'openai', currentTextVersion: 'o1' }).granted, true);
  s.closeStore(store);
});

test('revoke all refuses every granted provider and every known one, and skips bad or already-revoked ids', () => {
  const { store } = openHost();
  const now = Date.now();
  s.grantProviderConsent(store, { provider: 'moonshot', textVersion: 'm1', atMs: now - 10, ...who });
  s.revokeProviderConsent(store, { provider: 'xai', actor: 'cli', channel: 'cli', atMs: now - 5 });
  const all = s.revokeProviderConsent(store, { provider: 'all', knownProviders: ['openai', 'google', 'xai', 'Not An Id!'], actor: 'cli', channel: 'cli', atMs: now });
  assert.equal(all.ok, true, JSON.stringify(all));
  assert.deepEqual([...all.providers].sort(), ['google', 'moonshot', 'openai']);
  assert.deepEqual(s.listProviderConsent(store).map((row) => [row.provider, row.state]), [['google', 'revoked'], ['moonshot', 'revoked'], ['openai', 'revoked'], ['xai', 'revoked']]);
  assert.equal(s.revokeProviderConsent(store, { provider: 'all', knownProviders: ['openai'], actor: 'cli', channel: 'cli', atMs: now + 1 }).result, 'not-granted');
  s.closeStore(store);
});

test('R46: a serving host is a consent party in the same table, with no migration; each audit row names the party', () => {
  const { store, path } = openHost();
  const now = Date.now();
  // A host id fits the provider id pattern; a grant names its party, and a bad party is refused.
  assert.equal(s.isProviderId('openrouter'), true);
  assert.equal(s.isProviderId('kilo'), true);
  assert.equal(s.grantProviderConsent(store, { provider: 'openrouter', textVersion: 'openrouter-2026-09-28', party: 'gateway', atMs: now - 10, ...who }).reason, 'invalid-input');
  assert.equal(s.grantProviderConsent(store, { provider: 'openrouter', textVersion: 'openrouter-2026-09-28', party: 'host', atMs: now - 10, ...who }).result, 'granted');
  assert.equal(s.grantProviderConsent(store, { provider: 'moonshot', textVersion: 'm1', party: 'maker', atMs: now - 9, ...who }).result, 'granted');
  // A host grant is stale on a new text version, like a maker's.
  assert.equal(s.readProviderConsent(store, { provider: 'openrouter', currentTextVersion: 'openrouter-2026-10-01' }).reasonCode, 'PROVIDER_CONSENT_STALE');
  // Revoke all covers the pinned hosts passed as known, granted or not, and labels each party.
  const all = s.revokeProviderConsent(store, { provider: 'all', knownProviders: ['kilo', 'nvidia', 'openai'], hosts: ['kilo', 'nvidia', 'openrouter'], actor: 'cli', channel: 'cli', atMs: now });
  assert.deepEqual(all.providers, ['kilo', 'moonshot', 'nvidia', 'openai', 'openrouter']);
  for (const id of all.providers) assert.equal(s.readProviderConsent(store, { provider: id, currentTextVersion: 'x' }).reasonCode, 'PROVIDER_CONSENT_REVOKED', id);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const details = db.prepare("SELECT detail FROM audit_log WHERE kind LIKE 'provider-consent.%' ORDER BY seq").all().map((row) => JSON.parse(row.detail));
    assert.equal(details[0].party, 'host');
    assert.equal(details[1].party, 'maker');
    assert.deepEqual(details[2], { providers: ['kilo', 'moonshot', 'nvidia', 'openai', 'openrouter'], parties: ['host', 'maker', 'host', 'maker', 'host'] });
  } finally {
    db.close();
  }
  s.closeStore(store);
});

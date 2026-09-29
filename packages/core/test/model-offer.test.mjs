/**
 * Account eligibility from local evidence (owner decision DOMAINS 3f090fa): the model-offer
 * record (listings and runs per harness and sign-in) and the eligibility rule the router's account
 * gate uses. The end-to-end route on a default install is in provider-typesafe's
 * route-evaluation test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  BUNDLED_MODEL_REGISTRY,
  filterCandidates,
  locallyEligibleModels,
  modelEligibility,
  modelEligibilityLines,
  modelOfferFile,
  readModelOffer,
  recordModelListing,
  recordModelRun,
  removeModelOffer,
} from '../dist/index.js';

// pinned-clock: every record here is written at this fixed time or offsets from it.
const T = Date.parse('2026-09-27T10:00:00Z');
const REGISTRY = BUNDLED_MODEL_REGISTRY;
const SONNET = 'claude-sonnet-5';
const HAIKU = 'claude-haiku-4-5-20251001';

async function tempHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'jevris-model-offer-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

const eligibilityOf = (offer, scope, extra = {}) => Object.fromEntries(modelEligibility({ registry: REGISTRY, accountId: null, offer, scope, ...extra }).map((e) => [e.modelId, e.reasonCode]));

test('model offer: listings and runs are recorded per harness and sign-in, ids only, at mode 0600; a failed listing keeps the last models', async (t) => {
  const home = await tempHome(t);
  assert.equal(await readModelOffer(home), null, 'no record yet');
  assert.equal(await recordModelListing(home, { harness: 'kilocode', authMode: 'api-key', result: { ok: true, version: '4.2.0', models: [SONNET, SONNET, 'has space', HAIKU] }, nowMs: T }), true);
  assert.equal(await recordModelListing(home, { harness: 'kilocode', authMode: 'api-key', result: { ok: false, reasonCode: 'LISTING_TIMEOUT' }, nowMs: T + 60_000 }), true);
  assert.equal(await recordModelListing(home, { harness: 'kilocode', authMode: 'api-key', result: { ok: false, reasonCode: 'error text with /path' }, nowMs: T + 120_000 }), true);
  assert.equal(await recordModelRun(home, { harness: 'claude', authMode: 'subscription', modelId: SONNET, nowMs: T }), true);
  assert.equal(await recordModelRun(home, { harness: 'claude', authMode: 'subscription', modelId: SONNET, nowMs: T + 5_000 }), true);
  assert.equal(await recordModelRun(home, { harness: 'claude-api', authMode: 'api-key', modelId: HAIKU, nowMs: T }), true);
  const offer = await readModelOffer(home);
  assert.deepEqual(offer.listings, [{ harness: 'kilocode', authMode: 'api-key', models: [SONNET, HAIKU], spellings: [], observedAt: new Date(T).toISOString(), attemptedAt: new Date(T + 120_000).toISOString(), harnessVersion: '4.2.0', reasonCode: 'LISTING_FAILED' }]);
  assert.deepEqual(offer.runs.find((r) => r.harness === 'claude'), { harness: 'claude', authMode: 'subscription', modelId: SONNET, firstAt: new Date(T).toISOString(), lastAt: new Date(T + 5_000).toISOString(), raw: null, servingHost: null, source: 'reported' });
  const raw = await readFile(modelOfferFile(home), 'utf8');
  assert.equal(raw.includes('/path'), false, 'no text reaches the record');
  if (process.platform !== 'win32') assert.equal((await stat(modelOfferFile(home))).mode & 0o777, 0o600);
  // Invalid input is refused, never thrown.
  for (const bad of [
    recordModelListing(home, { harness: 'vim', authMode: 'api-key', result: { ok: true, version: null, models: [] }, nowMs: T }),
    recordModelListing(home, { harness: 'codex', authMode: 'root', result: { ok: true, version: null, models: [] }, nowMs: T }),
    recordModelListing(home, { harness: 'codex', authMode: 'api-key', result: null, nowMs: T }),
    recordModelRun(home, { harness: 'claude', authMode: 'api-key', modelId: '../x', nowMs: T }),
    recordModelRun(home, { harness: 'typesafe', authMode: 'api-key', modelId: SONNET, nowMs: T }),
    recordModelRun(home, { harness: 'claude', authMode: 'api-key', modelId: SONNET, nowMs: Number.NaN }),
  ]) assert.equal(await bad, false);
  // A corrupt or foreign file is no evidence.
  await writeFile(modelOfferFile(home), '{"schema":"other","listings":[],"runs":[]}');
  assert.equal(await readModelOffer(home), null);
  assert.deepEqual(await removeModelOffer(home), { ok: true });
  await assert.rejects(stat(modelOfferFile(home)), { code: 'ENOENT' });
  assert.deepEqual(await removeModelOffer(home), { ok: true }, 'a missing file is already removed');
});

test('model offer: the run record keeps the 512 most recent (harness, sign-in, model) rows', async (t) => {
  const home = await tempHome(t);
  const runs = Array.from({ length: 520 }, (_, i) => ({ harness: 'claude', authMode: 'api-key', modelId: `model-${i}`, firstAt: new Date(T + i * 1000).toISOString(), lastAt: new Date(T + i * 1000).toISOString() }));
  await mkdir(dirname(modelOfferFile(home)), { recursive: true });
  await writeFile(modelOfferFile(home), JSON.stringify({ schema: 'jevris-model-offer-1', listings: [], runs: runs.slice(0, 512) }));
  for (let i = 512; i < 520; i += 1) assert.equal(await recordModelRun(home, { harness: 'claude', authMode: 'api-key', modelId: `model-${i}`, nowMs: T + i * 1000 }), true);
  const kept = (await readModelOffer(home)).runs;
  assert.equal(kept.length, 512);
  assert.equal(kept.some((r) => r.modelId === 'model-0'), false, 'the oldest went');
  assert.equal(kept.some((r) => r.modelId === 'model-519'), true);
});

test('eligibility: no evidence is not eligible; a run on this harness and sign-in is; a listing is where the harness map gives the provider; found gone overrides both', () => {
  const offer = {
    listings: [
      { harness: 'opencode', authMode: 'subscription', models: [SONNET], observedAt: new Date(T).toISOString(), attemptedAt: new Date(T).toISOString(), harnessVersion: null, reasonCode: null },
      { harness: 'codex', authMode: 'api-key', models: [SONNET], observedAt: new Date(T).toISOString(), attemptedAt: new Date(T).toISOString(), harnessVersion: null, reasonCode: null },
    ],
    runs: [{ harness: 'claude', authMode: 'subscription', modelId: HAIKU, firstAt: new Date(T).toISOString(), lastAt: new Date(T).toISOString() }],
  };
  // No evidence: an Anthropic model has none yet; another provider's model is not on Claude Code at all.
  const bare = eligibilityOf(null, { harness: 'claude', authMode: 'subscription' });
  assert.ok(REGISTRY.entries.every((m) => bare[m.modelId] === (m.provider === 'anthropic' ? 'NO_LOCAL_EVIDENCE' : 'NOT_ON_HARNESS')), JSON.stringify(bare));
  assert.deepEqual([eligibilityOf(offer, { harness: 'claude', authMode: 'subscription' })[HAIKU], eligibilityOf(offer, { harness: 'claude', authMode: 'api-key' })[HAIKU]], ['RAN_HERE', 'NO_LOCAL_EVIDENCE']);
  assert.equal(eligibilityOf(offer, { harness: 'opencode', authMode: 'subscription' })[SONNET], 'LISTED_BY_HARNESS');
  assert.equal(eligibilityOf(offer, { harness: 'codex', authMode: 'api-key' })[SONNET], 'NOT_ON_HARNESS');
  // The advice path (harness unknown) takes evidence from any harness, still within the map.
  const advice = eligibilityOf(offer, { harness: null, authMode: null });
  assert.deepEqual([advice[SONNET], advice[HAIKU]], ['LISTED_BY_HARNESS', 'RAN_HERE']);
  // Found gone overrides a run and a listing.
  const gone = eligibilityOf(offer, { harness: 'claude', authMode: 'subscription' }, { unavailable: { [HAIKU]: 'MODEL_GONE' } });
  assert.equal(gone[HAIKU], 'MODEL_GONE');
  // A registry without a harness map narrows no harness: evidence alone decides.
  const unmapped = Object.fromEntries(modelEligibility({ registry: { ...REGISTRY, harnessAccess: undefined }, accountId: null, offer, scope: { harness: 'codex', authMode: 'api-key' } }).map((e) => [e.modelId, e.reasonCode]));
  assert.equal(unmapped[SONNET], 'LISTED_BY_HARNESS');
});

test('eligibility feeds the router account gate: only locally eligible models pass without an account; an account id makes the registry check decide', () => {
  const offer = { listings: [], runs: [{ harness: 'claude', authMode: 'api-key', modelId: SONNET, firstAt: new Date(T).toISOString(), lastAt: new Date(T).toISOString() }] };
  const scope = { harness: 'claude', authMode: 'api-key' };
  const locallyEligible = locallyEligibleModels(modelEligibility({ registry: REGISTRY, accountId: null, offer, scope }));
  assert.deepEqual(locallyEligible, [SONNET]);
  const policy = { managedAllowlist: null, allowedRegions: ['global'], requiredContextTokens: 0, requiredCapabilities: [], pins: { modelPin: null, effortPin: null }, riskFloorFamilies: null, accountId: null, nowMs: T };
  assert.deepEqual(filterCandidates(REGISTRY, policy).eligible, [], 'no evidence given: nothing passes (fail-closed)');
  assert.deepEqual(filterCandidates(REGISTRY, { ...policy, locallyEligible }).eligible.map((m) => m.modelId), [SONNET]);
  // With an account id the local list is not consulted: the bundled registry has no checks.
  assert.deepEqual(filterCandidates(REGISTRY, { ...policy, accountId: 'acct-1', locallyEligible }).eligible, []);
  const admin = modelEligibility({ registry: REGISTRY, accountId: 'acct-1', offer, scope });
  assert.ok(admin.every((e) => e.reasonCode === 'ACCOUNT_NOT_CHECKED' && e.basis === 'account-check'));
  assert.deepEqual(locallyEligibleModels(admin), []);
  const lines = modelEligibilityLines(modelEligibility({ registry: REGISTRY, accountId: null, offer, scope }), scope);
  assert.match(lines.find((l) => l.startsWith(SONNET)), /is eligible: it has run on claude with api-key sign-in \(RAN_HERE\)\.$/);
  assert.match(lines.find((l) => l.startsWith(HAIKU)), /not eligible: it has not run on claude with api-key sign-in and no harness listing names it \(NO_LOCAL_EVIDENCE\)/);
});

test('the shipped registry carries the harness-to-model map, per provider, with its sources', () => {
  assert.deepEqual(REGISTRY.harnessAccess.map((r) => [r.harness, r.provider, r.access]), [
    ['claude', 'anthropic', 'native'], ['opencode', 'anthropic', 'provider-config'], ['kilocode', 'anthropic', 'provider-config'],
    ['codex', 'openai', 'native'], ['opencode', 'openai', 'provider-config'], ['kilocode', 'openai', 'provider-config'],
    ['antigravity', 'google', 'native'], ['opencode', 'google', 'provider-config'], ['kilocode', 'google', 'provider-config'],
    ['opencode', 'xai', 'provider-config'], ['kilocode', 'xai', 'provider-config'], ['opencode', 'zai', 'provider-config'], ['kilocode', 'zai', 'provider-config'],
    ['opencode', 'moonshot', 'provider-config'], ['kilocode', 'moonshot', 'provider-config'], ['opencode', 'deepseek', 'provider-config'], ['kilocode', 'deepseek', 'provider-config'],
  ]);
  // Kilo resolves provider ids against the models.dev catalog it ships (KILO-CATALOG), so it reaches
  // Z.ai directly as well as through its gateway.
  assert.deepEqual(REGISTRY.harnessAccess.find((r) => r.harness === 'kilocode' && r.provider === 'zai')?.providerIds, ['zai', 'zai-coding-plan']);
});

// ------------------------------------------------------------------ v2 (serving hosts R41, 8c1f85d)

test('model offer v2: a v1 file reads with no spelling and no host; the next write is v2', async (t) => {
  const { seenSpellings } = await import('../dist/index.js');
  const home = await tempHome(t);
  const file = modelOfferFile(home);
  await mkdir(dirname(file), { recursive: true });
  const at = new Date(T).toISOString();
  await writeFile(file, JSON.stringify({
    schema: 'jevris-model-offer-1',
    listings: [{ harness: 'opencode', authMode: 'api-key', models: ['kimi-k3'], observedAt: at, attemptedAt: at, harnessVersion: '1.18.32', reasonCode: null }],
    runs: [{ harness: 'kilocode', authMode: 'unknown', modelId: 'kimi-k3', firstAt: at, lastAt: at }],
  }));
  const v1 = await readModelOffer(home);
  assert.deepEqual(v1.listings[0].spellings, []);
  assert.deepEqual([v1.runs[0].raw, v1.runs[0].servingHost, v1.runs[0].source], [null, null, 'reported']);
  // A v1 row proves the model (eligibility is unchanged), never a host.
  assert.equal(eligibilityOf(v1, { harness: 'kilocode', authMode: 'unknown' })['kimi-k3'], 'RAN_HERE');
  assert.deepEqual(seenSpellings(v1, { harness: 'kilocode' }, 'kimi-k3'), []);
  assert.equal(await recordModelRun(home, { harness: 'kilocode', authMode: 'unknown', modelId: 'kimi-k3', raw: 'openrouter/moonshotai/kimi-k3', servingHost: 'openrouter', nowMs: T + 1000 }), true);
  const written = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(written.schema, 'jevris-model-offer-2');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  // The v1 row and the new spelling are two rows: the same model through a known host is new evidence.
  const v2 = await readModelOffer(home);
  assert.deepEqual(v2.runs.map((r) => [r.modelId, r.raw, r.servingHost]).sort((a, b) => String(a[1]).localeCompare(String(b[1]))), [['kimi-k3', null, null], ['kimi-k3', 'openrouter/moonshotai/kimi-k3', 'openrouter']]);
  assert.deepEqual(seenSpellings(v2, { harness: 'kilocode' }, 'kimi-k3'), [{ raw: 'openrouter/moonshotai/kimi-k3', servingHost: 'openrouter' }]);
});

test('model offer v2: spellings are kept per listing and per run; a gateway clean run is refused; bad rows are dropped', async (t) => {
  const { seenSpellings } = await import('../dist/index.js');
  const home = await tempHome(t);
  const listed = await recordModelListing(home, {
    harness: 'opencode',
    authMode: 'api-key',
    nowMs: T,
    result: {
      ok: true,
      version: '1.18.32',
      models: ['kimi-k3', SONNET],
      spellings: [
        { raw: 'moonshotai/kimi-k3', modelId: 'kimi-k3', servingHost: 'moonshot' },
        { raw: 'openrouter/moonshotai/kimi-k3', modelId: 'kimi-k3', servingHost: 'openrouter' },
        { raw: 'anthropic/claude-sonnet-5', modelId: SONNET, servingHost: 'anthropic' },
        { raw: 'openrouter/moonshotai/kimi-k3:free', modelId: 'kimi-k3', servingHost: 'openrouter' },
        { raw: 'openrouter/x-ai/grok-9', modelId: 'grok-9', servingHost: 'openrouter' },
        { raw: 'moonshotai/kimi-k3', modelId: 'kimi-k3', servingHost: 'Not A Host' },
      ],
    },
  });
  assert.equal(listed, true);
  let offer = await readModelOffer(home);
  assert.deepEqual(offer.listings[0].spellings.map((s) => s.raw), ['moonshotai/kimi-k3', 'openrouter/moonshotai/kimi-k3', 'anthropic/claude-sonnet-5'], 'a suffix, an unlisted model and a bad host are dropped');
  assert.deepEqual(seenSpellings(offer, { harness: 'opencode' }, 'kimi-k3'), [{ raw: 'moonshotai/kimi-k3', servingHost: 'moonshot' }, { raw: 'openrouter/moonshotai/kimi-k3', servingHost: 'openrouter' }]);
  assert.deepEqual(seenSpellings(offer, { harness: 'opencode', authMode: 'subscription' }, 'kimi-k3'), [], 'scoped to the sign-in when one is given');
  // A failed listing keeps the last spellings.
  await recordModelListing(home, { harness: 'opencode', authMode: 'api-key', nowMs: T + 1, result: { ok: false, reasonCode: 'LISTING_TIMEOUT' } });
  offer = await readModelOffer(home);
  assert.equal(offer.listings[0].spellings.length, 3);
  // C's clean-run rule: a run that only requested its model counts only through a maker's own host.
  assert.equal(await recordModelRun(home, { harness: 'kilocode', authMode: 'api-key', modelId: 'kimi-k3', raw: 'kilo/moonshotai/kimi-k3', servingHost: 'kilo', source: 'requested-clean-run', nowMs: T }), false);
  assert.equal(await recordModelRun(home, { harness: 'kilocode', authMode: 'api-key', modelId: 'kimi-k3', source: 'requested-clean-run', nowMs: T }), false, 'a clean run with no host proves nothing');
  assert.equal(await recordModelRun(home, { harness: 'kilocode', authMode: 'api-key', modelId: 'kimi-k3', raw: 'moonshotai-cn/kimi-k3', servingHost: 'moonshot', source: 'requested-clean-run', nowMs: T }), true);
  // A spelling and a host go together, and both must be well formed.
  assert.equal(await recordModelRun(home, { harness: 'kilocode', authMode: 'api-key', modelId: 'kimi-k3', raw: 'moonshotai/kimi-k3', nowMs: T }), false);
  assert.equal(await recordModelRun(home, { harness: 'kilocode', authMode: 'api-key', modelId: 'kimi-k3', raw: '~moonshotai/kimi-k3', servingHost: 'moonshot', nowMs: T }), false);
  // A later report of the same spelling outranks the clean run.
  assert.equal(await recordModelRun(home, { harness: 'kilocode', authMode: 'api-key', modelId: 'kimi-k3', raw: 'moonshotai-cn/kimi-k3', servingHost: 'moonshot', nowMs: T + 5 }), true);
  offer = await readModelOffer(home);
  assert.deepEqual(offer.runs.map((r) => [r.raw, r.source]), [['moonshotai-cn/kimi-k3', 'reported']]);
  // A hand-edited v2 row that pairs a clean run with a gateway is dropped on read.
  const file = modelOfferFile(home);
  const doc = JSON.parse(await readFile(file, 'utf8'));
  doc.runs.push({ ...doc.runs[0], raw: 'openrouter/moonshotai/kimi-k3', servingHost: 'openrouter', source: 'requested-clean-run' });
  await writeFile(file, JSON.stringify(doc));
  assert.equal((await readModelOffer(home)).runs.length, 1);
  // Reset still deletes the whole record.
  assert.deepEqual(await removeModelOffer(home), { ok: true });
  assert.equal(await readModelOffer(home), null);
});

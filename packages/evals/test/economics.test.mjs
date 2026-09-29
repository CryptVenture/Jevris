import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const e = await import('../dist/index.js');
const core = await import('@jevris/core');
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');

function envelopes(limits = {}) {
  const budgets = {};
  for (const name of e.ENVELOPES) budgets[name] = core.DecisionBudget.open(null, { limitMicroUsd: limits[name] ?? 1_000_000, now: () => 1_000 });
  return new e.BudgetEnvelopes(budgets);
}

test('EVL-07: each envelope is its own ledger; exhausting one never spends another', async () => {
  const set = envelopes({ generation: 500_000 });
  const cost = e.estimate(300_000, 200_000, 400_000, 'registry:anthropic-2026-09-22');
  assert.equal((await set.reserve('generation', { id: 'g1', workspaceId: 'w', estimate: cost })).ok, true);
  const second = await set.reserve('generation', { id: 'g2', workspaceId: 'w', estimate: cost });
  assert.equal(second.ok, false, 'the upper bound is reserved, so the second call does not fit');
  assert.equal(second.reasonCode, 'BUDGET');
  const available = await set.available();
  assert.equal(available.generation, 100_000);
  for (const name of e.ENVELOPES.filter((n) => n !== 'generation')) assert.equal(available[name], 1_000_000, name);
  // Safe shutdown keeps its own reserve even after generation is exhausted.
  assert.equal((await set.reserve('safe-shutdown', { id: 's1', workspaceId: 'w', estimate: e.estimate(10, 10, 10, 'fixed') })).ok, true);
  const shared = core.DecisionBudget.open(null, { limitMicroUsd: 1 });
  const all = Object.fromEntries(e.ENVELOPES.map((n) => [n, shared]));
  assert.throws(() => new e.BudgetEnvelopes(all), /ENVELOPES_SHARED/);
  assert.throws(() => new e.BudgetEnvelopes({ decisions: shared }), /ENVELOPES_MISSING/);
});

test('EVL-07: every estimate names a source and an interval containing the point', () => {
  const value = e.estimate(10, 5, 20, 'provider-usage');
  assert.deepEqual(value, { microUsd: 10, lowerMicroUsd: 5, upperMicroUsd: 20, source: 'provider-usage' });
  assert.throws(() => e.estimate(30, 5, 20, 'x'), /ESTIMATE_INVALID/);
  assert.throws(() => e.estimate(10, 5, 20, ' '), /ESTIMATE_INVALID/);
});

test('EVL-07: requests and tokens per minute roll off; concurrency follows quota and latency', () => {
  let now = 0;
  const rates = new e.RateTracker(() => now);
  rates.record(1_000);
  now = 30_000;
  rates.record(2_000);
  assert.deepEqual(rates.rates(), { requestsPerMinute: 2, tokensPerMinute: 3_000 });
  assert.equal(rates.admits({ requestsPerMinute: 3, tokensPerMinute: 4_000 }, 1_000), true);
  assert.equal(rates.admits({ requestsPerMinute: 3, tokensPerMinute: 3_500 }, 1_000), false, 'tokens bind');
  assert.equal(rates.admits({ requestsPerMinute: 2, tokensPerMinute: 1e9 }, 1), false, 'requests bind');
  now = 60_001;
  assert.deepEqual(rates.rates(), { requestsPerMinute: 1, tokensPerMinute: 2_000 });
  // 60 requests per minute at 10 s latency sustain 10 in flight; a token quota can bind first.
  assert.equal(e.allocateConcurrency({ requestsPerMinute: 60, tokensPerMinute: 1e9, expectedLatencyMs: 10_000, tokensPerRequest: 1_000 }), 10);
  assert.equal(e.allocateConcurrency({ requestsPerMinute: 60, tokensPerMinute: 30_000, expectedLatencyMs: 10_000, tokensPerRequest: 1_000 }), 5);
  assert.equal(e.allocateConcurrency({ requestsPerMinute: 6_000, tokensPerMinute: 1e12, expectedLatencyMs: 60_000, tokensPerRequest: 1, maxConcurrency: 8 }), 8);
  assert.equal(e.allocateConcurrency({ requestsPerMinute: 0, tokensPerMinute: 0, expectedLatencyMs: 1_000, tokensPerRequest: 1 }), 0);
});

test('EVL-08: the cost report keeps actual, API-equivalent and counterfactual as separate labelled measures', () => {
  const unknown = e.buildCostReport({ subscriptionActual: 'unknown', apiEquivalentEstimate: 'unmeasured', counterfactualHypothetical: 'hypothetical' }, { billingMode: 'subscription' });
  assert.equal(unknown.savingMicroUsd, null);
  assert.deepEqual([unknown.actual.value, unknown.actual.precision], ['unknown', 'unknown']);
  assert.deepEqual([unknown.apiEquivalent.value, unknown.counterfactual.value], ['unmeasured', 'hypothetical']);
  assert.ok(unknown.notes.some((n) => n.includes('not money removed from the fixed plan')));
  const measured = e.buildCostReport({ subscriptionActual: 1_200n, apiEquivalentEstimate: 9_000n, counterfactualHypothetical: 20_000n }, { billingMode: 'api', actualSource: 'billing-export' });
  assert.deepEqual([measured.actual.value, measured.actual.precision, measured.actual.label], [1_200, 'billing-export', 'billed cost']);
  assert.deepEqual([measured.apiEquivalent.value, measured.apiEquivalent.precision], [9_000, 'estimate']);
  assert.deepEqual([measured.counterfactual.value, measured.counterfactual.precision], [20_000, 'hypothetical']);
  assert.equal(measured.savingMicroUsd, null, 'a difference between measures is never reported as a saving');
  assert.equal(JSON.stringify(measured).toLowerCase().includes('saved'), false);
});

const ANTHROPIC = readFileSync(join(root, 'fixtures', 'evaluation', 'billing', 'anthropic-usage.csv'), 'utf8');
const TYPESAFE = readFileSync(join(root, 'fixtures', 'evaluation', 'billing', 'typesafe-usage.json'), 'utf8');

test('EVL-09: anonymized billing exports import; malformed rows are named, never guessed', () => {
  const anthropic = e.importBillingExport('anthropic', ANTHROPIC);
  assert.equal(anthropic.ok, true);
  assert.equal(anthropic.lines.length, 3);
  assert.deepEqual(anthropic.skipped, [{ line: 4, reason: 'INVALID_COST' }]);
  assert.deepEqual(anthropic.lines[0], { provider: 'anthropic', day: '2026-09-20', model: 'claude-sonnet-5', inputTokens: 120000, outputTokens: 8000, costMicroUsd: 320000, requestId: 'req-anon-0001' });
  const typesafe = e.importBillingExport('typesafe', TYPESAFE);
  assert.equal(typesafe.ok, true);
  assert.equal(typesafe.lines.length, 2);
  assert.equal(typesafe.lines[0].costMicroUsd, 21);
  assert.deepEqual(e.importBillingExport('typesafe', 'not json'), { ok: false, reasonCode: 'NOT_JSON' });
  assert.deepEqual(e.importBillingExport('typesafe', '{}'), { ok: false, reasonCode: 'NO_USAGE_ARRAY' });
  // The fixtures carry no personal data: no e-mail addresses, keys or organisation names.
  for (const text of [ANTHROPIC, TYPESAFE]) assert.equal(/@|sk-|org[-_]/i.test(text), false);
});

test('EVL-09: reconciliation is conservative: unmatched billing counts, a mismatch takes the larger amount', () => {
  const { lines } = e.importBillingExport('anthropic', ANTHROPIC);
  const local = [
    { requestId: 'req-anon-0001', day: '2026-09-20', model: 'claude-sonnet-5', estimatedMicroUsd: 300_000 },
    { requestId: null, day: '2026-09-21', model: 'claude-opus-5', estimatedMicroUsd: 900_000 },
    { requestId: 'req-anon-9999', day: '2026-09-23', model: 'claude-sonnet-5', estimatedMicroUsd: 50_000 },
  ];
  const r = e.reconcileBilling(lines, local);
  assert.deepEqual([r.matched, r.unmatchedBilled, r.unmatchedLocal], [2, 1, 1]);
  // 320000 (billed > estimate) + max(850000, 900000) + unmatched billed 40000 + unmatched local 50000.
  assert.equal(r.reconciledMicroUsd, 320_000 + 900_000 + 40_000 + 50_000);
  assert.ok(r.reconciledMicroUsd >= r.billedMicroUsd && r.reconciledMicroUsd >= r.estimatedMicroUsd);
});

const REGISTRY = JSON.parse(readFileSync(join(root, 'fixtures', 'evaluation', 'cost-registry.json'), 'utf8'));

test('EVL-10: every registry price is dated and sourced; §19.1 is recomputed from the registry', () => {
  for (const row of REGISTRY.prices) assert.equal(e.validatePriceRow(row), true, row.modelId);
  const s = e.section191(REGISTRY);
  assert.equal(s.hundredEvaluationsUsd, 0.021);
  assert.equal(s.thousandEvaluationsUsd, 0.21);
  assert.deepEqual(s.ratios, { 'Claude Haiku 4.5': 23.8, 'Claude Sonnet 5': 47.6, 'Claude Opus 5.5': 95.2, 'Claude Opus 5': 119, 'Claude Fable 5.1': 238.1 });
  // The shipped copy matches the reviewed source.
  assert.equal(readFileSync(join(root, 'assets', 'evaluation', 'cost-registry.json'), 'utf8'), readFileSync(join(root, 'fixtures', 'evaluation', 'cost-registry.json'), 'utf8'));
  assert.equal(REGISTRY.vendorClaimIsJevrisResult, false);
});

test('EVL-10: the cost registry joins the model registry on provider and API id, and the prices agree', async () => {
  const { BUNDLED_MODEL_REGISTRY } = await import('@jevris/core');
  for (const entry of BUNDLED_MODEL_REGISTRY.entries) {
    const row = e.priceRowFor(REGISTRY, entry.provider, entry.modelId);
    assert.notEqual(row, null, `${entry.provider}/${entry.modelId} has one price row`);
    assert.deepEqual([row.input, row.output], [entry.tariff.inputPerMillion, entry.tariff.outputPerMillion], entry.modelId);
    assert.equal(row.fetchedOn, entry.tariff.version.slice(-10), 'both were read on the same day');
  }
  assert.equal(e.priceRowFor(REGISTRY, 'anthropic', 'Claude Opus 5.5'), null, 'the display name is not the join key');
  const row = REGISTRY.prices.find((p) => p.apiModelId === 'claude-opus-5-5');
  assert.equal(e.validatePriceRow({ ...row, apiModelId: undefined }), false, 'the join key comes in pairs');
  assert.equal(e.validatePriceRow({ ...row, provider: 'Anthropic Inc' }), false);
  const { provider: _p, apiModelId: _a, ...legacy } = row;
  assert.equal(e.validatePriceRow(legacy), true, 'a row written before the join key stays valid');
});

test('EVL-10: a refresh replaces rows by vendor and model, adds new ones, and refuses unsourced rows', () => {
  const update = { vendor: 'TypeSafe', modelId: 'jev-1.13.0', sourceUrl: 'https://docs.typesafe.ai/models', fetchedOn: '2026-10-01', input: 0.05, output: null, unit: 'USD per million tokens' };
  const added = { ...update, modelId: 'jev-2.0.0', input: 0.08 };
  const next = e.refreshPrices(REGISTRY, [update, added], '2026-10-01');
  assert.equal(next.fetchedOn, '2026-10-01');
  assert.equal(e.priceOf(next, 'jev-1.13.0').input, 0.05);
  assert.equal(next.prices.length, REGISTRY.prices.length + 1);
  assert.equal(e.section191(next).hundredEvaluationsUsd, 0.025);
  assert.equal(REGISTRY.prices.find((p) => p.modelId === 'jev-1.13.0').input, 0.042, 'the input registry is not mutated');
  assert.throws(() => e.refreshPrices(REGISTRY, [{ ...update, sourceUrl: 'http://docs.typesafe.ai/models' }], '2026-10-01'), /PRICE_ROW_INVALID/);
  assert.throws(() => e.refreshPrices(REGISTRY, [{ ...update, fetchedOn: 'today' }], '2026-10-01'), /PRICE_ROW_INVALID/);
  assert.throws(() => e.refreshPrices(REGISTRY, [update], 'soon'), /PRICE_DATE/);
});

test('EVL-10: the refresh script is a dry run by default and refuses an invalid updates file', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-prices-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(here, '..', 'scripts', 'refresh-prices.mjs');
  const good = join(dir, 'good.json');
  writeFileSync(good, JSON.stringify([{ vendor: 'TypeSafe', modelId: 'jev-1.13.0', sourceUrl: 'https://docs.typesafe.ai/models', fetchedOn: '2026-10-01', input: 0.042, output: null, unit: 'USD per million tokens' }]));
  const before = readFileSync(join(root, 'fixtures', 'evaluation', 'cost-registry.json'), 'utf8');
  const dry = spawnSync(process.execPath, [script, '--updates', good, '--date', '2026-10-01'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: dir } });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /100 evaluations x 5000 tokens = \$0\.021/);
  assert.match(dry.stdout, /dry run/);
  assert.equal(readFileSync(join(root, 'fixtures', 'evaluation', 'cost-registry.json'), 'utf8'), before, 'a dry run writes nothing');
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, JSON.stringify([{ vendor: 'X', modelId: 'y', input: 1 }]));
  const refused = spawnSync(process.execPath, [script, '--updates', bad], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: dir } });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /invalid row/);
});

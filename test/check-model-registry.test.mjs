import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COST_PROPOSAL, MODEL_PROPOSAL, registryChecks } from '../scripts/check-model-registry.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = join(root, 'scripts', 'check-model-registry.mjs');

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-registry-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

const failing = (results) => results.filter((item) => !item.ok).map((item) => item.name);

test('the committed registries pass every check, one line each (registry:check)', (t) => {
  const run = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const lines = run.stdout.trim().split('\n');
  // Eight checks (the eighth is the harness-to-model map, DOMAINS 3f090fa), then the retirement
  // and promotional-price reports: each one ok line, or a WARN line per item (today's date).
  const checks = lines.slice(0, -1);
  const warned = checks.filter((line) => line.startsWith('WARN ')).length;
  assert.equal(checks.filter((line) => line.startsWith('ok   ')).length + warned, checks.length);
  assert.ok(checks.length >= 10, run.stdout);
  assert.ok(lines.some((line) => /^ok {3}harness-to-model map: the bundled registry maps harnesses with resolvable sources/.test(line)), run.stdout);
  assert.match(lines.at(-1), new RegExp(`^registry:check: ${checks.length}/${checks.length} checks pass${warned === 0 ? '' : `, ${warned} warning\\(s\\)`}$`));
  t.diagnostic(lines.at(-1));
});

test('registry:check warns about each recommended model near, due or deprecated, at a pinned clock, and never fails on it (registry:check)', async () => {
  const at = (iso) => Date.parse(iso);
  const retirement = (results) => results.filter((item) => item.name.startsWith('bundled model registry:') && !item.name.endsWith('validateModelRegistry'));
  // 2026-09-27: Haiku 4.5 may retire from 2026-10-15, in 18 days; a warning, not a failure.
  const soon = retirement(await registryChecks({ root, nowMs: at('2026-09-27T00:00:00Z') }));
  assert.deepEqual(soon.map((item) => [item.name, item.ok, item.warn]), [['bundled model registry: Haiku 4.5 (claude-haiku-4-5-20251001) may retire from 2026-10-15, in 18 day(s)', true, true]]);
  assert.match(soon[0].detail, /^refresh the registry by docs\/model-refresh\.md; the release gate warns too, and fails only on inconsistent data/);
  // 2026-11-01: Haiku 4.5's "not sooner than" date has passed: still recommended, MODEL_RETIREMENT_DUE.
  const due = retirement(await registryChecks({ root, nowMs: at('2026-11-01T00:00:00Z') }));
  assert.deepEqual(due.map((item) => [item.name, item.ok, item.warn]), [['bundled model registry: Haiku 4.5 (claude-haiku-4-5-20251001) may be retired any day: its "not sooner than" date 2026-10-15 has passed (MODEL_RETIREMENT_DUE)', true, true]]);
  // A registry with nothing near: one ok line.
  const core = await import('../packages/core/dist/index.js');
  const far = { ...core.BUNDLED_MODEL_REGISTRY, entries: core.BUNDLED_MODEL_REGISTRY.entries.filter((e) => e.modelId !== 'claude-haiku-4-5-20251001') };
  const clear = retirement(await registryChecks({ root, nowMs: at('2026-11-01T00:00:00Z'), bundledRegistry: far }));
  assert.deepEqual(clear.map((item) => [item.name, item.ok, item.warn]), [['bundled model registry: no recommended model retires within 30 days, is due or is deprecated', true, false]]);
});

test('a planted invalid price row, a planted bad registry entry and a missing Jev price each fail by name (registry:check)', async (t) => {
  const dir = scratch(t);
  const cost = JSON.parse(readFileSync(join(root, COST_PROPOSAL), 'utf8'));
  const model = JSON.parse(readFileSync(join(root, MODEL_PROPOSAL), 'utf8'));
  // A row with an http source and no date; a registry entry with its exact id removed.
  cost.prices.push({ vendor: 'Planted', modelId: 'planted-1', sourceUrl: 'http://example.com/', input: 1, output: 2, unit: 'USD per million tokens' });
  delete model.registry.entries[0].modelId;
  const costFile = join(dir, 'cost.json');
  const modelFile = join(dir, 'model.json');
  writeFileSync(costFile, JSON.stringify(cost));
  writeFileSync(modelFile, JSON.stringify(model));
  const results = await registryChecks({ root, model: modelFile, cost: costFile });
  assert.deepEqual(failing(results), [
    'model registry proposal: ModelRegistryContract',
    'model registry proposal: JSON Schema (Ajv)',
    'cost registry proposal: every row passes validatePriceRow',
  ]);
  assert.match(results.find((item) => item.name.endsWith('validatePriceRow')).detail, /Planted planted-1/);

  // Without the Jev price the §19.1 figures cannot be computed.
  const noJev = { ...cost, prices: cost.prices.filter((row) => !/^jev/i.test(String(row.modelId)) && row.vendor !== 'TypeSafe' && row.vendor !== 'Planted') };
  writeFileSync(costFile, JSON.stringify(noJev));
  const again = await registryChecks({ root, model: join(root, MODEL_PROPOSAL), cost: costFile });
  assert.deepEqual(failing(again), ['cost registry proposal: section191']);

  // The CLI exits 1 and prints FAIL for the failed check.
  const run = spawnSync(process.execPath, [script, '--cost', costFile], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /^FAIL cost registry proposal: section191: no Jev price row/m);
});

test('R7: registry:check warns about a promotional price near or past its announced end, at a pinned clock, and never fails on it (registry:check)', async () => {
  const at = (iso) => Date.parse(iso);
  const prices = (results) => results.filter((item) => item.name.startsWith('bundled prices:'));
  // 2026-09-27: GPT-5.6 Sol's promotional price holds through 2026-11-22, beyond 30 days.
  assert.deepEqual(prices(await registryChecks({ root, nowMs: at('2026-09-27T00:00:00Z') })).map((item) => [item.name, item.ok, item.warn]), [['bundled prices: no promotional price ends within 30 days', true, false]]);
  const soon = prices(await registryChecks({ root, nowMs: at('2026-11-01T00:00:00Z') }));
  assert.equal(soon.length, 1);
  assert.match(soon[0].name, /^bundled prices: .*\(gpt-5.6-sol\)'s promotional price is announced through 2026-11-22, in 21 day\(s\)$/);
  assert.deepEqual([soon[0].ok, soon[0].warn], [true, true]);
  const ended = prices(await registryChecks({ root, nowMs: at('2026-12-01T00:00:00Z') }));
  assert.match(ended[0].name, /\(gpt-5.6-sol\)'s promotional price was announced through 2026-11-22, which has passed; the bundled dollars may be low$/);
  assert.match(ended[0].detail, /^refresh the registry by docs\/model-refresh\.md$/);
  assert.equal(ended[0].ok, true);
});

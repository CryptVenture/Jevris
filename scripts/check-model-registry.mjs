#!/usr/bin/env node
/**
 * Checks the model knowledge the product and the research rely on
 * (docs/model-refresh.md). Run after `npm run build`:
 *
 *   npm run registry:check
 *
 * 1. The model registry proposal (fixtures/registry/v1.2-model-registry-proposal.json, its
 *    `registry`) against ModelRegistryContract, and against the committed JSON Schemas
 *    packages/contracts/schemas/model-registry*.schema.json with Ajv.
 * 2. Every price row of the cost registry proposal (fixtures/registry/v1.2-cost-registry-proposal.json)
 *    with validatePriceRow, and section191 over it (the Jev price must be present).
 * 3. The registry bundled with the product (BUNDLED_MODEL_REGISTRY) with validateModelRegistry, and
 *    its harness-to-model map (`harnessAccess`: rows present, every source id known).
 * 4. Model retirement: one `WARN` line for each bundled model the router still recommends with a
 *    firm or "not sooner than" date within 30 days, a passed "not sooner than" date
 *    (MODEL_RETIREMENT_DUE) or a deprecated status, pointing at the refresh procedure. A warning
 *    fails neither registry:check nor the release gate (owner decisions 3ff4c0f, 9d1e7eb).
 * 5. Promotional prices (R7): one `WARN` line for each bundled price whose announced end
 *    (`Tariff.validUntil`) is within 30 days or has passed, pointing at the refresh procedure.
 *
 * One line per check, `ok`, `WARN` or `FAIL` with the reason. Exit 0 no check failed; 1 any
 * check failed; 2 the build output is missing. `--model <file>` and `--cost <file>` check other
 * files.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMain } from './build.mjs';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
export const MODEL_PROPOSAL = join('fixtures', 'registry', 'v1.2-model-registry-proposal.json');
export const COST_PROPOSAL = join('fixtures', 'registry', 'v1.2-cost-registry-proposal.json');
export const MODEL_REFRESH_PROCEDURE = 'docs/model-refresh.md';

async function load(root, rel) {
  return import(pathToFileURL(join(root, rel)).href);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Runs every check; returns [{ name, ok, detail }]. */
export async function registryChecks({ root = repoRoot, model = join(root, MODEL_PROPOSAL), cost = join(root, COST_PROPOSAL), nowMs = Date.now(), bundledRegistry } = {}) {
  const contracts = await load(root, 'packages/contracts/dist/index.js');
  const core = await load(root, 'packages/core/dist/index.js');
  const evals = await load(root, 'packages/evals/dist/index.js');
  const gates = await load(root, 'apps/cli/dist/gate-records.js');
  const { Ajv2020 } = await import(pathToFileURL(join(root, 'node_modules', 'ajv', 'dist', '2020.js')).href);
  const results = [];
  const record = (name, ok, detail = '', warn = false) => results.push({ name, ok, detail, warn });

  let registry;
  try {
    const proposal = readJson(model);
    registry = proposal?.registry;
    record('model registry proposal is readable JSON with a registry', registry !== undefined && registry !== null, registry === undefined ? 'no "registry" key' : '');
  } catch (error) {
    record('model registry proposal is readable JSON with a registry', false, error.message);
  }
  if (registry !== undefined && registry !== null) {
    const checked = contracts.ModelRegistryContract.validate(registry);
    record('model registry proposal: ModelRegistryContract', checked.ok, checked.ok ? `${registry.entries?.length ?? 0} entries` : checked.issues.slice(0, 8).map((i) => `${i.path}:${i.code}`).join(', '));
    const ajv = new Ajv2020({ strict: true, allErrors: true, coerceTypes: false, removeAdditional: false, useDefaults: false, validateFormats: true });
    ajv.addFormat('date-time', { type: 'string', validate: (value) => contracts.isTimestamp(value) });
    const schemas = join(root, 'packages', 'contracts', 'schemas');
    ajv.addSchema(readJson(join(schemas, 'model-registry-entry.schema.json')));
    const validate = ajv.compile(readJson(join(schemas, 'model-registry.schema.json')));
    const ok = validate(registry) === true;
    record('model registry proposal: JSON Schema (Ajv)', ok, ok ? '' : (validate.errors ?? []).slice(0, 8).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; '));
  }

  let costFile;
  try {
    costFile = readJson(cost);
    record('cost registry proposal is readable JSON with prices[]', Array.isArray(costFile?.prices), Array.isArray(costFile?.prices) ? `${costFile.prices.length} rows` : 'no prices array');
  } catch (error) {
    record('cost registry proposal is readable JSON with prices[]', false, error.message);
  }
  if (Array.isArray(costFile?.prices)) {
    const bad = costFile.prices.map((row, index) => ({ row, index })).filter(({ row }) => !evals.validatePriceRow(row));
    record('cost registry proposal: every row passes validatePriceRow', bad.length === 0, bad.length === 0 ? `${costFile.prices.length} rows` : bad.slice(0, 8).map(({ row, index }) => `row ${index} (${String(row?.vendor ?? '?')} ${String(row?.modelId ?? '?')})`).join(', '));
    let summary = null;
    try {
      summary = evals.section191(costFile);
    } catch (error) {
      record('cost registry proposal: section191', false, error.message);
    }
    if (!results.some((item) => item.name === 'cost registry proposal: section191')) {
      record('cost registry proposal: section191', summary !== null, summary === null ? 'no Jev price row, so the §19.1 figures cannot be computed' : `100 evaluations $${summary.hundredEvaluationsUsd}, 1000 $${summary.thousandEvaluationsUsd}`);
    }
  }

  const bundled = core.validateModelRegistry(core.BUNDLED_MODEL_REGISTRY);
  record('bundled model registry: validateModelRegistry', bundled.ok, bundled.ok ? `${bundled.registry.entries.length} entries` : bundled.issues.slice(0, 8).join(', '));

  // The harness-to-model map (owner decision DOMAINS 3f090fa): present, and every source resolves.
  const access = (bundledRegistry ?? core.BUNDLED_MODEL_REGISTRY).harnessAccess ?? [];
  const unsourced = access.flatMap((row) => row.sourceIds.filter((id) => core.BUNDLED_REGISTRY_SOURCES[id] === undefined).map((id) => `${row.harness}/${row.provider}:${id}`));
  record('harness-to-model map: the bundled registry maps harnesses with resolvable sources', access.length > 0 && unsourced.length === 0, access.length === 0 ? 'no harnessAccess rows' : unsourced.length > 0 ? `unknown sources ${unsourced.join(', ')}` : `${access.length} rows: ${access.map((row) => `${row.harness}/${row.provider} ${row.access}`).join(', ')}`);

  // Serving hosts (R38): every harness-host row and serving names a source that resolves, and the
  // count of servings per basis is shown so a snapshot that lost its prices is visible.
  const reg = bundledRegistry ?? core.BUNDLED_MODEL_REGISTRY;
  const servingRows = [...(reg.harnessHosts ?? []).map((row) => ({ name: `${row.harness}/${row.host}`, sourceIds: row.sourceIds })), ...(reg.servings ?? []).map((s) => ({ name: `${s.host} ${s.hostModelId}`, sourceIds: s.sourceIds }))];
  const servingUnsourced = servingRows.flatMap((row) => row.sourceIds.filter((id) => core.BUNDLED_REGISTRY_SOURCES[id] === undefined).map((id) => `${row.name}:${id}`));
  const bases = (reg.servings ?? []).reduce((acc, s) => ({ ...acc, [s.tariffBasis]: (acc[s.tariffBasis] ?? 0) + 1 }), {});
  record(
    'serving hosts: every harness-host row and serving has resolvable sources',
    servingUnsourced.length === 0,
    servingUnsourced.length > 0 ? `unknown sources ${servingUnsourced.slice(0, 8).join(', ')}` : `${(reg.harnessHosts ?? []).length} harness-host rows, ${(reg.servings ?? []).length} servings (${Object.entries(bases).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'})`,
  );

  // Model retirement: the same warnings the release gate prints (quality.model-retirement).
  const facts = gates.modelLifecycleFacts(bundledRegistry ?? core.BUNDLED_MODEL_REGISTRY);
  const retiring = gates.retiringModels(facts, nowMs);
  const window = `within ${gates.MODEL_RETIREMENT_WINDOW_DAYS} days`;
  if (retiring.length === 0) record(`bundled model registry: no recommended model retires ${window}, is due or is deprecated`, true);
  for (const item of retiring) {
    record(`bundled model registry: ${gates.describeRetiring(item)}`, true, `refresh the registry by ${MODEL_REFRESH_PROCEDURE}; the release gate warns too, and fails only on inconsistent data (a retired model shipped data still names, or an entry past its firm date that still says active or deprecated)`, true);
  }
  // R7: promotional prices near or past their announced end (a warning, like retirement).
  const promotions = core.promotionalPricesEnding(bundledRegistry ?? core.BUNDLED_MODEL_REGISTRY, nowMs, gates.MODEL_RETIREMENT_WINDOW_DAYS);
  if (promotions.length === 0) record(`bundled prices: no promotional price ends ${window}`, true);
  for (const item of promotions) {
    const name = `${item.displayName ?? item.modelId} (${item.modelId})`;
    const day = item.validUntil.slice(0, 10);
    record(item.ended ? `bundled prices: ${name}'s promotional price was announced through ${day}, which has passed; the bundled dollars may be low` : `bundled prices: ${name}'s promotional price is announced through ${day}, in ${String(item.days)} day(s)`, true, `refresh the registry by ${MODEL_REFRESH_PROCEDURE}`, true);
  }
  return results;
}

function option(argv, name) {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

async function main(argv) {
  let results;
  try {
    const model = option(argv, '--model');
    const cost = option(argv, '--cost');
    results = await registryChecks({ ...(model === undefined ? {} : { model }), ...(cost === undefined ? {} : { cost }) });
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      console.error(`registry:check: the build output is missing (${error.message.split('\n')[0]}). Run npm run build first.`);
      return 2;
    }
    throw error;
  }
  for (const item of results) console.log(`${!item.ok ? 'FAIL' : item.warn ? 'WARN' : 'ok  '} ${item.name}${item.detail === '' ? '' : `: ${item.detail}`}`);
  const failed = results.filter((item) => !item.ok).length;
  const warned = results.filter((item) => item.ok && item.warn).length;
  const warnings = warned === 0 ? '' : `, ${warned} warning(s)`;
  console.log(failed === 0 ? `registry:check: ${results.length}/${results.length} checks pass${warnings}` : `registry:check: ${failed} of ${results.length} checks failed${warnings}`);
  return failed === 0 ? 0 : 1;
}

if (isMain(import.meta.url)) process.exit(await main(process.argv.slice(2)));

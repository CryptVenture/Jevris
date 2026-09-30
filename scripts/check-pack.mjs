#!/usr/bin/env node
/**
 * Tarball check. Lists what `npm pack` would publish (dry run, scripts ignored so prepack
 * does not recurse) and fails when a required runtime path is missing or a forbidden
 * development path is present. No shell: npm runs as `node <npm-cli.js>`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMain } from './build.mjs';
import { scanForbiddenText } from './bundle.mjs';
import { HARNESS_MANIFESTS, NATIVE_MANIFESTS, PLUGIN_FILES, SIZE_BUDGET, duplicatePlugins, harnessManifestProblem, isAllowedPluginPath, manifestProblem } from './release-policy.mjs';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

export const REQUIRED = [
  'package.json',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'bin/jevris.mjs',
  'dist/cli.mjs',
  'dist/hook.mjs',
  'dist/runtime/manifest.json',
  'dist/bundle-manifest.json',
  'dist/THIRD_PARTY_NOTICES.md',
  'dist/sbom.cdx.json',
  ...PLUGIN_FILES,
  'assets/schemas/pack-manifest.schema.json',
  'assets/evaluation/frontier-corpus.json',
  'assets/evaluation/cost-registry.json',
];

/**
 * The nine skills (SKL-01): one per public command, plus the guide. The package ships their one source; install renders it
 * into each harness's tree in the target home, so no rendered tree is shipped (DRY).
 */
export const PUBLIC_SKILLS = ['checkpoint', 'configure', 'explain', 'guide', 'plan', 'recover', 'route', 'status', 'verify'];
export const SKILL_TREES = ['plugins/shared/skills'];
REQUIRED.push(...SKILL_TREES.flatMap((dir) => PUBLIC_SKILLS.map((name) => `${dir}/${name}/SKILL.md`)));

export const REQUIRED_PREFIXES = ['packs/'];

function forbiddenPath(path) {
  const parts = path.split('/');
  const base = parts[parts.length - 1] ?? '';
  // Workspace sources and dist trees are bundled into dist/ and never shipped (PKG-06).
  if (['.planning', 'ssot_docs', 'fixtures', 'node_modules', '.github', 'apps', 'packages', 'scripts', 'lint', 'coverage', 'test', 'docs'].includes(parts[0] ?? '')) return true;
  if (parts.includes('src') || parts.includes('test') || parts.includes('tests')) return true;
  if (base.endsWith('.test.js') || base.endsWith('.test.mjs') || base.endsWith('.tsbuildinfo')) return true;
  if (base.startsWith('tsconfig')) return true;
  if (base.endsWith('.ts') && !base.endsWith('.d.ts')) return true;
  if (base.endsWith('.map')) return true;
  if (base === '.env' || base.startsWith('.env.')) return true;
  // Retired: the SSOT skill templates; skills ship from plugins/shared/skills (SKL-01).
  if (path.startsWith('assets/skill-templates/')) return true;
  // Generated plugin files are rendered at install, never shipped (DRY).
  if (parts[0] === 'plugins' && !isAllowedPluginPath(path)) return true;
  if (parts[0] === 'dist' && parts[1] === 'plugins') return true;
  return false;
}

export function checkPackList(paths) {
  const normalized = paths.map((path) => path.split('\\').join('/'));
  const present = new Set(normalized);
  const missing = REQUIRED.filter((path) => !present.has(path));
  for (const prefix of REQUIRED_PREFIXES) {
    if (!normalized.some((path) => path.startsWith(prefix))) missing.push(prefix);
  }
  const forbidden = normalized.filter(forbiddenPath);
  return { missing, forbidden };
}

/** Harness manifests the tarball lacks or ships invalid; `read` returns a path's bytes. */
export function harnessManifestProblems(paths, read) {
  const shipped = new Set(paths.map((path) => path.split('\\').join('/')));
  const problems = [];
  const check = (harness, path, validate) => {
    if (!shipped.has(path)) problems.push(`${harness}: ${path} is not in the tarball`);
    else {
      const problem = validate(Buffer.from(read(path)).toString('utf8'));
      if (problem !== null) problems.push(`${harness}: ${path} ${problem}`);
    }
  };
  for (const [harness, path] of Object.entries(HARNESS_MANIFESTS)) check(harness, path, (text) => harnessManifestProblem(harness, text));
  for (const [harness, path] of Object.entries(NATIVE_MANIFESTS)) check(harness, path, manifestProblem);
  return problems;
}

/** Shipped plugin files that repeat each other (DRY); `read` returns a path's bytes. */
export function duplicatePluginProblems(paths, read) {
  const plugins = paths.map((path) => path.split('\\').join('/')).filter((path) => path.startsWith('plugins/') || path.startsWith('dist/plugins/'));
  return duplicatePlugins(plugins.map((path) => ({ path, bytes: read(path) }))).map((pair) => `${pair.a} and ${pair.b} are ${pair.kind}`);
}

/**
 * Route learning's day-1 baseline (core BUNDLED_CALIBRATION_PARTS). It is absent until the owner
 * signs the seed's baseline release; the quality gate (quality.baseline-shipped) requires it and
 * that it is the gated record's payload. When the tarball carries it, it must be a released,
 * beta-posterior calibration artifact signed by a calibration key the package itself trusts,
 * or every install would refuse it (UNKNOWN_KEY) and start from nothing.
 */
export const BUNDLED_BASELINE = 'assets/calibration/calibration-release.json';
export const TRUST_FILE = 'assets/trust/release-keys.json';

/** Problems with the shipped baseline; none when the tarball does not carry one. */
export function bundledBaselineProblems(paths, read, contracts) {
  const shipped = new Set(paths.map((path) => path.split('\\').join('/')));
  if (!shipped.has(BUNDLED_BASELINE)) return [];
  const parse = (path) => {
    try {
      return JSON.parse(Buffer.from(read(path)).toString('utf8'));
    } catch {
      return undefined;
    }
  };
  const artifact = parse(BUNDLED_BASELINE);
  if (artifact === undefined) return [`${BUNDLED_BASELINE} is not JSON`];
  const checked = contracts.CalibrationArtifactContract.validate(artifact);
  if (!checked.ok) return [`${BUNDLED_BASELINE} is not a calibration artifact: ${JSON.stringify(checked.issues.slice(0, 3))}`];
  const problems = [];
  if (artifact.uncertaintyInterval.method !== 'beta-posterior') problems.push(`${BUNDLED_BASELINE} is not a beta-posterior baseline (method ${artifact.uncertaintyInterval.method})`);
  if (artifact.releaseState !== 'released') problems.push(`${BUNDLED_BASELINE} is not released (${artifact.releaseState})`);
  const trust = shipped.has(TRUST_FILE) ? parse(TRUST_FILE) : undefined;
  const keys = Array.isArray(trust?.keys) ? trust.keys : [];
  const calibration = new Map(keys.filter((key) => key?.role === 'calibration' && typeof key.keyId === 'string' && typeof key.publicKeyPem === 'string').map((key) => [key.keyId, key.publicKeyPem]));
  const signed = contracts.verifyRecordSignature(artifact, calibration);
  if (!signed.ok) problems.push(`${BUNDLED_BASELINE} is not signed by a calibration key in ${TRUST_FILE} (${signed.reasonCode})`);
  return problems;
}

function npmCli() {
  const fromEnv = process.env.npm_execpath;
  if (typeof fromEnv === 'string' && fromEnv.endsWith('.js') && existsSync(fromEnv)) return fromEnv;
  const nodeDir = dirname(process.execPath);
  for (const candidate of [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function packedPaths(root = repoRoot) {
  const cli = npmCli();
  if (cli === null) throw new Error('npm-cli.js not found next to this node');
  const result = spawnSync(process.execPath, [cli, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`npm pack exited ${result.status}: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  return entry.files.map((file) => file.path);
}

/** The npm pack --dry-run summary: file list plus tarball and unpacked sizes. */
export function packSummary(root = repoRoot) {
  const cli = npmCli();
  if (cli === null) throw new Error('npm-cli.js not found next to this node');
  const result = spawnSync(process.execPath, [cli, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`npm pack exited ${result.status}: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  return { paths: entry.files.map((file) => file.path), size: entry.size, unpackedSize: entry.unpackedSize, name: entry.name, version: entry.version };
}

/** Size-budget problems for a pack summary (PKG-07). */
export function budgetProblems(summary, budget = SIZE_BUDGET) {
  const problems = [];
  if (summary.size > budget.tarballBytes) problems.push(`tarball ${summary.size} bytes exceeds the budget ${budget.tarballBytes}`);
  if (summary.unpackedSize > budget.unpackedBytes) problems.push(`unpacked ${summary.unpackedSize} bytes exceeds the budget ${budget.unpackedBytes}`);
  return problems;
}

/** Shipped runtime files that name a development-only tree (strict form of the bundle scan). */
export function runtimeTreeProblems(root = repoRoot, paths) {
  const problems = [];
  for (const path of paths) {
    if (!/\.(mjs|js|cjs)$/.test(path)) continue;
    for (const tree of scanForbiddenText(join(root, path))) problems.push(`${path} names a ${tree} path at runtime`);
  }
  return problems;
}

/** Strict unless --lenient: a runtime reference to a development-only tree fails the check. */
export function strictMode(argv) {
  return !argv.includes('--lenient');
}

async function main(argv) {
  // A shipped runtime file that names ssot_docs/, fixtures/ or .planning/ fails (D-A6). Strict is
  // the default; --lenient (local diagnosis only, never CI or release) reports it as a warning.
  const strict = strictMode(argv);
  const summary = packSummary();
  const paths = summary.paths;
  const { missing, forbidden } = checkPackList(paths);
  for (const path of missing) console.error(`missing: ${path}`);
  for (const path of forbidden) console.error(`forbidden: ${path}`);
  const budget = budgetProblems(summary);
  for (const problem of budget) console.error(`budget: ${problem}`);
  const duplicates = duplicatePluginProblems(paths, (path) => readFileSync(join(repoRoot, path)));
  for (const problem of duplicates) console.error(`duplicate: ${problem}`);
  const manifests = harnessManifestProblems(paths, (path) => readFileSync(join(repoRoot, path)));
  for (const problem of manifests) console.error(`harness: ${problem}`);
  const trees = runtimeTreeProblems(repoRoot, paths);
  for (const problem of trees) console.error(`runtime${strict ? '' : ' warning'}: ${problem}`);
  const contracts = await import(pathToFileURL(join(repoRoot, 'packages', 'contracts', 'dist', 'index.js')).href);
  const baseline = bundledBaselineProblems(paths, (path) => readFileSync(join(repoRoot, path)), contracts);
  for (const problem of baseline) console.error(`baseline: ${problem}`);
  if (missing.length > 0 || forbidden.length > 0 || duplicates.length > 0 || manifests.length > 0 || budget.length > 0 || baseline.length > 0 || (strict && trees.length > 0)) return 1;
  console.log(`tarball ok: ${summary.name}@${summary.version}, ${paths.length} files, ${summary.size} bytes packed, ${summary.unpackedSize} unpacked`);
  return 0;
}

if (isMain(import.meta.url)) process.exit(await main(process.argv.slice(2)));

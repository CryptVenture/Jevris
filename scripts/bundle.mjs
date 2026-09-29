#!/usr/bin/env node
/**
 * Bundles the tsc output into self-contained runtime files under dist/ (PKG-06).
 *
 *   node scripts/bundle.mjs            # after tsc -b (scripts/build.mjs runs it)
 *
 * - Every @jevris/* workspace and ajv are inlined. Only the runtime externals in
 *   scripts/release-policy.mjs stay imports, plus node builtins.
 * - The hook bundle is checked to be a closed graph: no store, SDK or keyring.
 * - Literal dynamic imports become chunks, so an optional package (the Claude agent SDK)
 *   is only loaded when a command needs it.
 * - dist/bundle-manifest.json records every output with its size and SHA-256, the
 *   externals each imports, and every third-party package inlined, with its licence.
 *   THIRD_PARTY_NOTICES and the SBOM are generated from that manifest.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './build.mjs';
import { buildNotices, buildSbom, readLock, runtimeClosure } from './release-artifacts.mjs';
import {
  BUNDLE_ENTRIES,
  FORBIDDEN_RUNTIME_TREES,
  OPTIONAL_EXTERNALS,
  RUNTIME_EXTERNALS,
  STANDALONE_SCRIPTS,
  allowedExternal,
  isBuiltin,
} from './release-policy.mjs';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/** ESM output still meets CommonJS inside ajv; give it a real require. */
const BANNER = [
  "import { createRequire as __jevrisCreateRequire } from 'node:module';",
  'const require = __jevrisCreateRequire(import.meta.url);',
].join('\n');

function posix(path) {
  return path.split(sep).join('/');
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** `node_modules/@scope/name/...` or `node_modules/name/...` -> package directory. */
export function thirdPartyDir(inputPath) {
  const parts = posix(inputPath).split('/');
  const at = parts.lastIndexOf('node_modules');
  if (at < 0) return undefined;
  const first = parts[at + 1];
  if (first === undefined) return undefined;
  const count = first.startsWith('@') ? 2 : 1;
  const nameParts = parts.slice(at + 1, at + 1 + count);
  if (nameParts.length !== count) return undefined;
  const name = nameParts.join('/');
  if (name.startsWith('@jevris/')) return undefined;
  return { name, dir: parts.slice(0, at + 1 + count).join('/') };
}

function readLicense(root, dir) {
  const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
  const license = typeof pkg.license === 'string' ? pkg.license : 'UNKNOWN';
  let text = '';
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'LICENCE']) {
    const file = join(root, dir, name);
    if (existsSync(file)) {
      text = readFileSync(file, 'utf8');
      break;
    }
  }
  return {
    name: pkg.name,
    version: pkg.version,
    license,
    ...(typeof pkg.repository === 'string'
      ? { repository: pkg.repository }
      : pkg.repository && typeof pkg.repository.url === 'string'
        ? { repository: pkg.repository.url }
        : {}),
    licenseText: text,
  };
}

/**
 * Checks one esbuild metafile against the dependency policy. Returns a list of problems;
 * an empty list means the output is acceptable.
 */
export function policyProblems(metafile, entries = BUNDLE_ENTRIES) {
  const problems = [];
  for (const [outPath, output] of Object.entries(metafile.outputs)) {
    for (const imported of output.imports ?? []) {
      if (!imported.external) continue;
      if (!allowedExternal(imported.path)) problems.push(`${outPath}: external ${imported.path} is not a runtime dependency`);
    }
    for (const input of Object.keys(output.inputs ?? {})) {
      for (const tree of FORBIDDEN_RUNTIME_TREES) {
        if (posix(input).startsWith(tree) || posix(input).includes(`/${tree}`)) {
          problems.push(`${outPath}: bundles ${input} from a development-only tree`);
        }
      }
    }
  }
  for (const entry of entries) {
    if (entry.closed.length === 0) continue;
    const graph = entryGraph(metafile, entry.name);
    for (const item of graph) {
      for (const banned of entry.closed) {
        if (item.includes(banned)) problems.push(`${entry.name}: closed graph reaches ${item}`);
      }
    }
  }
  return problems;
}

/** Every input and external reachable from one named entry output (static imports only). */
export function entryGraph(metafile, name) {
  const outputs = metafile.outputs;
  const start = Object.keys(outputs).find((path) => posix(path).endsWith(`/${name}.mjs`) || posix(path) === `${name}.mjs`);
  if (start === undefined) return [];
  const seen = new Set();
  const found = new Set();
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    const output = outputs[current];
    if (output === undefined) continue;
    for (const input of Object.keys(output.inputs ?? {})) found.add(posix(input));
    for (const imported of output.imports ?? []) {
      if (imported.external) {
        found.add(imported.path);
        continue;
      }
      // A dynamic import is a separate chunk loaded only on demand; the closed graph
      // covers what loading the entry pulls in.
      if (imported.kind === 'dynamic-import') continue;
      queue.push(imported.path);
    }
  }
  return [...found];
}

/**
 * Workspace modules that lower layers load on demand through `@jevris/cli/*` (the sidecar reads
 * the credential and the kill switch, the hook subscriber reads certification records). Each
 * must be its own chunk exporting these names, so an installed runtime can load it.
 */
export const REQUIRED_DYNAMIC_MODULES = {
  'apps/cli/dist/credential.js': ['openHostEntry', 'resolveProviderCredential'],
  'apps/cli/dist/kill-switch.js': ['readKillSwitchStopped'],
  'apps/cli/dist/certification-store.js': ['loadCertifications'],
  'apps/cli/dist/live-evidence.js': ['recordLiveEvent'],
  'apps/cli/dist/reverify.js': ['maybeReverify'],
  // The orchestrator reads what a harness has stored for an OpenCode or Kilo worker (packages/orchestrator workers.ts).
  'apps/cli/dist/harness-auth.js': ['providerCredentials', 'detectHarnessAuth'],
  // The orchestrator loads each owned-worker port on demand (packages/orchestrator workers.ts).
  'apps/cli/dist/claude-worker.js': ['claudeWorkerPort'],
  'apps/cli/dist/codex-worker.js': ['codexWorkerPort'],
  'apps/cli/dist/opencode-worker.js': ['opencodeWorkerPort'],
  'apps/cli/dist/kilo-worker.js': ['kiloWorkerPort'],
  'apps/cli/dist/antigravity-worker.js': ['antigravityWorkerPort'],
  // The sidecar's model-offer refresh lists each harness's models on demand (apps/sidecar model-offer.ts).
  'apps/cli/dist/model-offer.js': ['detectHarnessAuth', 'listOfferedModels', 'listingHarnesses', 'modelListingSetting'],
};

/** Chunks created for dynamic imports: source module, output path and exported names. */
export function dynamicModules(metafile) {
  const out = [];
  for (const [outPath, output] of Object.entries(metafile.outputs)) {
    if (typeof output.entryPoint !== 'string' || !posix(outPath).includes('/chunks/')) continue;
    out.push({ source: posix(output.entryPoint), path: posix(outPath).replace(/^.*?(dist\/chunks\/)/, '$1'), exports: [...(output.exports ?? [])].sort() });
  }
  return out.sort((a, b) => a.source.localeCompare(b.source));
}

export function requiredModuleProblems(modules, required = REQUIRED_DYNAMIC_MODULES) {
  const problems = [];
  for (const [source, names] of Object.entries(required)) {
    const found = modules.find((item) => item.source === source);
    if (found === undefined) {
      problems.push(`${source} is not a separate dynamic chunk; the sidecar could not load it from an installed runtime`);
      continue;
    }
    const missing = names.filter((name) => !found.exports.includes(name));
    if (missing.length > 0) problems.push(`${found.path} (${source}) does not export ${missing.join(', ')}`);
  }
  return problems;
}

/**
 * A dynamic import whose argument is not one plain string literal. esbuild cannot follow it,
 * so a workspace package loaded that way is missing from the installed runtime (the call only
 * fails there). Comment lines are skipped; tsc output has no type-only imports left.
 */
export function nonLiteralImports(text) {
  const out = [];
  text.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
    for (const match of line.matchAll(/(?<![\w$.])import\(/g)) {
      const rest = line.slice(match.index + match[0].length);
      if (!/^\s*(['"])[^'"`$]*\1\s*\)/.test(rest)) out.push({ line: index + 1, text: trimmed.slice(0, 160) });
    }
  });
  return out;
}

/** Non-literal dynamic imports in the workspace files esbuild read (apps/*\/dist, packages/*\/dist). */
export function workspaceImportProblems(root, metafile) {
  const problems = [];
  for (const input of Object.keys(metafile.inputs).sort()) {
    const rel = posix(input);
    if (!/^(?:apps|packages)\/[^/]+\/dist\//.test(rel)) continue;
    for (const hit of nonLiteralImports(readFileSync(join(root, input), 'utf8'))) {
      problems.push(`${rel}:${hit.line}: dynamic import with a non-literal argument (${hit.text}); use a string literal so the bundle includes it`);
    }
  }
  return problems;
}

export function scanForbiddenText(file) {
  const text = readFileSync(file, 'utf8');
  const hits = [];
  for (const tree of FORBIDDEN_RUNTIME_TREES) {
    if (text.includes(`'${tree}`) || text.includes(`"${tree}`) || text.includes(`\`${tree}`)) hits.push(tree);
  }
  return hits;
}

export async function bundle(options = {}) {
  const root = options.root ?? repoRoot;
  const outdir = join(root, 'dist');
  const { build } = await import('esbuild');
  const entries = BUNDLE_ENTRIES.filter((entry) => entry.optional !== true || existsSync(join(root, entry.from)));
  for (const entry of entries) {
    if (!existsSync(join(root, entry.from))) throw new Error(`bundle: ${entry.from} is missing; run tsc -b first`);
  }
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });
  // Split entries share chunks; a standalone entry (the hook) is one file with its own graph.
  const groups = [
    entries.filter((entry) => entry.split !== false),
    ...entries.filter((entry) => entry.split === false).map((entry) => [entry]),
  ].filter((group) => group.length > 0);
  const metafile = { inputs: {}, outputs: {} };
  for (const group of groups) {
    const one = await buildGroup(build, root, outdir, group);
    Object.assign(metafile.inputs, one.inputs);
    Object.assign(metafile.outputs, one.outputs);
  }
  const result = { metafile };
  const problems = [...policyProblems(result.metafile), ...workspaceImportProblems(root, result.metafile), ...requiredModuleProblems(dynamicModules(result.metafile))];
  const warnings = [];
  const outputs = [];
  for (const outPath of Object.keys(result.metafile.outputs).sort()) {
    const full = join(root, outPath);
    const hits = scanForbiddenText(full);
    for (const tree of hits) warnings.push(`${posix(outPath)}: names a ${tree} path at runtime`);
    const output = result.metafile.outputs[outPath];
    outputs.push({
      path: posix(relative(root, full)),
      bytes: statSync(full).size,
      sha256: sha256(full),
      externals: [...new Set((output.imports ?? []).filter((item) => item.external && !isBuiltin(item.path)).map((item) => item.path))].sort(),
    });
  }
  return finishBundle(root, outdir, result, problems, warnings, outputs);
}

async function buildGroup(build, root, outdir, group) {
  const entryPoints = Object.fromEntries(group.map((entry) => [entry.name, join(root, entry.from)]));
  const split = group.length > 1 || group[0].split !== false;
  const result = await build({
    absWorkingDir: root,
    entryPoints,
    bundle: true,
    splitting: split,
    format: 'esm',
    platform: 'node',
    target: 'node22.14',
    outdir,
    outExtension: { '.js': '.mjs' },
    entryNames: '[name]',
    chunkNames: 'chunks/[name]-[hash]',
    external: [...RUNTIME_EXTERNALS, ...OPTIONAL_EXTERNALS],
    banner: { js: BANNER },
    metafile: true,
    legalComments: 'none',
    sourcemap: false,
    minify: false,
    logLevel: 'silent',
    // Workspaces resolve through node_modules/@jevris symlinks to their dist output.
    preserveSymlinks: false,
  });
  return result.metafile;
}

function finishBundle(root, outdir, result, problems, warnings, outputs) {
  for (const script of STANDALONE_SCRIPTS) {
    const full = join(root, script);
    if (!existsSync(full)) continue;
    const text = readFileSync(full, 'utf8');
    for (const match of text.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (specifier.startsWith('.')) problems.push(`${script}: relative import ${specifier}; a standalone script must be one file`);
      else if (!isBuiltin(specifier)) problems.push(`${script}: imports ${specifier}; a standalone script uses node builtins only`);
    }
    for (const tree of scanForbiddenText(full)) warnings.push(`${script}: names a ${tree} path at runtime`);
  }
  const thirdParty = new Map();
  for (const input of Object.keys(result.metafile.inputs)) {
    const found = thirdPartyDir(input);
    if (found === undefined || thirdParty.has(found.name)) continue;
    thirdParty.set(found.name, readLicense(root, found.dir));
  }
  const bundled = [...thirdParty.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const item of bundled) {
    if (item.license === 'UNKNOWN') problems.push(`bundled ${item.name}@${item.version} has no licence field`);
  }
  const manifest = {
    schemaVersion: 1,
    outputs,
    runtimeExternals: [...RUNTIME_EXTERNALS],
    optionalExternals: [...OPTIONAL_EXTERNALS],
    bundled: bundled.map(({ licenseText, ...rest }) => ({ ...rest, licenseTextSha256: createHash('sha256').update(licenseText).digest('hex') })),
    dynamicModules: dynamicModules(result.metafile),
  };
  writeFileSync(join(outdir, 'bundle-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const closure = runtimeClosure(readLock(root), pkg.dependencies ?? {});
  for (const item of closure) {
    if (item.license === 'UNKNOWN') problems.push(`runtime dependency ${item.name}@${item.version} has no licence in the lockfile`);
  }
  writeFileSync(join(outdir, 'THIRD_PARTY_NOTICES.md'), buildNotices({ pkg, bundled, runtime: closure }));
  writeFileSync(join(outdir, 'sbom.cdx.json'), `${JSON.stringify(buildSbom({ pkg, bundled, runtime: closure, outputs }), null, 2)}\n`);
  const runtime = runtimeManifest(root);
  for (const missing of runtime.missing) problems.push(`runtime manifest: entry ${missing} is missing`);
  mkdirSync(join(outdir, 'runtime'), { recursive: true });
  writeFileSync(join(outdir, 'runtime', 'manifest.json'), `${JSON.stringify(runtime.manifest, null, 2)}\n`);
  return { manifest, problems, warnings, metafile: result.metafile, runtime: runtime.manifest };
}

/**
 * Stable package-relative entry points (ADM-03 contract with domain F). F's install copies
 * the package `files` set plus the runtime dependency closure to <data>/runtime/<version>/
 * and points every harness config at these paths inside that copy.
 */
export const RUNTIME_ENTRIES = {
  bin: 'bin/jevris.mjs',
  cli: 'dist/cli.mjs',
  mcp: 'plugins/shared/mcp.js',
  hook: 'dist/hook.mjs',
};

/** Entries that exist only once their owning domain lands them. */
export const OPTIONAL_RUNTIME_ENTRIES = {
  sidecar: 'dist/sidecar.mjs',
};

/**
 * The source a build came from, for evidence that must name its commit (certify's
 * harness-conformance and certification envelopes; the gates bind them to the release commit).
 * `dirty` is true when the working tree differs from that commit (tracked changes or untracked,
 * non-ignored files), and then no record may claim the commit: consumers treat
 * `dirty: true` as no commit. Without git, or outside a work tree, the commit is null.
 */
export function sourceStamp(root = repoRoot, git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 })) {
  try {
    const commit = git(['rev-parse', '--verify', 'HEAD']).trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) return { commit: null, dirty: false };
    const status = git(['status', '--porcelain', '--untracked-files=normal']);
    return { commit, dirty: status.trim() !== '' };
  } catch {
    return { commit: null, dirty: false };
  }
}

export function runtimeManifest(root = repoRoot, source = sourceStamp(root)) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const entries = {};
  const missing = [];
  for (const [key, path] of Object.entries(RUNTIME_ENTRIES)) {
    if (existsSync(join(root, path))) entries[key] = path;
    else missing.push(key);
  }
  for (const [key, path] of Object.entries(OPTIONAL_RUNTIME_ENTRIES)) {
    if (existsSync(join(root, path))) entries[key] = path;
  }
  const optional = {};
  for (const name of OPTIONAL_EXTERNALS) {
    const range = pkg.peerDependencies?.[name];
    if (typeof range === 'string') optional[name] = range;
  }
  return {
    missing,
    manifest: {
      schemaVersion: 1,
      name: pkg.name,
      version: pkg.version,
      engines: pkg.engines ?? {},
      entries,
      files: Array.isArray(pkg.files) ? pkg.files : [],
      runtimeDependencies: pkg.dependencies ?? {},
      optionalDependencies: optional,
      source,
    },
  };
}

export function listDist(root = repoRoot) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(posix(relative(root, full)));
    }
  };
  const dist = join(root, 'dist');
  if (existsSync(dist)) walk(dist);
  return out.sort();
}

async function main(argv) {
  // A runtime reference to a development-only tree fails (D-A6); --lenient reports it as a
  // warning for local diagnosis. `npm run build` keeps it a warning; check:pack fails on it.
  const strict = !argv.includes('--lenient');
  const { manifest, problems, warnings } = await bundle();
  for (const warning of warnings) console.error(`bundle${strict ? '' : ' warning'}: ${warning}`);
  if (strict && warnings.length > 0) return 1;
  if (problems.length > 0) {
    for (const problem of problems) console.error(`bundle: ${problem}`);
    return 1;
  }
  const total = manifest.outputs.reduce((sum, item) => sum + item.bytes, 0);
  console.log(`bundle: ${manifest.outputs.length} files, ${total} bytes, ${manifest.bundled.length} third-party packages inlined`);
  return 0;
}

if (isMain(import.meta.url)) {
  // Holding the suite lock (re-entrant under scripts/build.mjs), so a running suite never sees dist/ change.
  const { runLocked } = await import('./suite-lock.mjs');
  process.exit(await runLocked(repoRoot, () => main(process.argv.slice(2))));
}

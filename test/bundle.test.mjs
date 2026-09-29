import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_DYNAMIC_MODULES, dynamicModules, entryGraph, nonLiteralImports, policyProblems, requiredModuleProblems, runtimeManifest, sourceStamp, thirdPartyDir } from '../scripts/bundle.mjs';
import { budgetProblems } from '../scripts/check-pack.mjs';
import { buildSbom, purl, runtimeClosure, uuidFrom } from '../scripts/release-artifacts.mjs';
import {
  BUNDLE_ENTRIES,
  OPTIONAL_EXTERNALS,
  PACKAGE_NAME,
  RUNTIME_EXTERNALS,
  SIZE_BUDGET,
  allowedExternal,
} from '../scripts/release-policy.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));

test('the root manifest is the public @webventures/jevris package (PKG-09)', () => {
  assert.equal(pkg.name, PACKAGE_NAME);
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.publishConfig.access, 'public');
  // A plain `npm publish` lands on next; latest is promoted only after the gates (RLS-12).
  assert.equal(pkg.publishConfig.tag, 'next');
  assert.match(pkg.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
  assert.equal(pkg.bin.jevris, './bin/jevris.mjs');
  assert.equal(pkg.license, 'MIT');
  for (const field of ['author', 'homepage', 'description']) assert.equal(typeof pkg[field], 'string', field);
  assert.match(pkg.repository.url, /github\.com\/CryptVenture\/Jevris/);
  assert.match(pkg.bugs.url, /issues$/);
  assert.equal(Array.isArray(pkg.keywords) && pkg.keywords.length > 0, true);
  for (const workspace of pkg.workspaces) {
    assert.equal(readJson(join(workspace, 'package.json')).private, true, `${workspace} stays private`);
  }
});

test('runtime dependencies are exactly the three externals, pinned; the Agent SDK is an optional peer (PKG-06, PKG-07)', () => {
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), [...RUNTIME_EXTERNALS].sort());
  for (const [name, range] of Object.entries(pkg.dependencies)) assert.match(range, /^\d+\.\d+\.\d+$/, `${name} is an exact pin`);
  for (const name of OPTIONAL_EXTERNALS) {
    assert.equal(pkg.dependencies[name], undefined);
    assert.equal(pkg.optionalDependencies?.[name], undefined, 'optional deps are installed by default; a peer is not');
    assert.match(pkg.peerDependencies[name], /^\d+\.\d+\.\d+$/);
    assert.equal(pkg.peerDependenciesMeta[name].optional, true);
  }
});

test('the dependency policy accepts builtins and runtime externals only', () => {
  for (const ok of ['node:fs', 'fs/promises', 'better-sqlite3', '@napi-rs/keyring', '@typesafe-ai/sdk', '@anthropic-ai/claude-agent-sdk']) {
    assert.equal(allowedExternal(ok), true, ok);
  }
  for (const bad of ['ajv', '@jevris/core', 'zod', '@anthropic-ai/sdk', 'lodash']) assert.equal(allowedExternal(bad), false, bad);
});

test('policyProblems flags a foreign external, a development tree and a closed-graph breach', () => {
  const metafile = {
    inputs: {},
    outputs: {
      'dist/cli.mjs': { imports: [{ path: 'zod', kind: 'import-statement', external: true }], inputs: { 'fixtures/x.js': {} } },
      'dist/hook.mjs': {
        imports: [
          { path: 'better-sqlite3', kind: 'import-statement', external: true },
          { path: 'dist/chunks/lazy.mjs', kind: 'dynamic-import', external: false },
        ],
        inputs: { 'packages/store/dist/open.js': {} },
      },
      'dist/chunks/lazy.mjs': { imports: [{ path: '@napi-rs/keyring', kind: 'import-statement', external: true }], inputs: {} },
    },
  };
  const problems = policyProblems(metafile);
  assert.equal(problems.some((line) => line.includes('external zod')), true);
  assert.equal(problems.some((line) => line.includes('fixtures/x.js')), true);
  assert.equal(problems.some((line) => line.startsWith('hook:') && line.includes('packages/store/')), true);
  assert.equal(problems.some((line) => line.startsWith('hook:') && line.includes('better-sqlite3')), true);
  // A dynamic chunk is not part of the closed graph that loading the hook pulls in.
  assert.equal(problems.some((line) => line.startsWith('hook:') && line.includes('keyring')), false);
  assert.deepEqual(entryGraph(metafile, 'missing'), []);
});

test('thirdPartyDir names the package of a bundled node_modules input and skips workspaces', () => {
  assert.deepEqual(thirdPartyDir('node_modules/ajv/dist/core.js'), { name: 'ajv', dir: 'node_modules/ajv' });
  assert.deepEqual(thirdPartyDir('node_modules/@scope/pkg/lib/a.js'), { name: '@scope/pkg', dir: 'node_modules/@scope/pkg' });
  assert.equal(thirdPartyDir('node_modules/@jevris/core/dist/index.js'), undefined);
  assert.equal(thirdPartyDir('packages/core/dist/index.js'), undefined);
});

test('the built bundle obeys the policy: externals, closed hook graph, no workspace import (PKG-06)', () => {
  const manifest = readJson('dist/bundle-manifest.json');
  for (const entry of BUNDLE_ENTRIES) {
    // An optional entry is bundled as soon as its owning domain's tsc output exists.
    const expected = entry.optional !== true || existsSync(join(root, entry.from));
    assert.equal(existsSync(join(root, 'dist', `${entry.name}.mjs`)), expected, entry.name);
  }
  for (const output of manifest.outputs) {
    for (const external of output.externals) assert.equal(allowedExternal(external), true, `${output.path} imports ${external}`);
    const text = readFileSync(join(root, output.path), 'utf8');
    assert.equal(/from ["']@jevris\//.test(text), false, `${output.path} imports a workspace at runtime`);
    assert.equal(/from ["']ajv/.test(text), false, `${output.path} imports ajv at runtime`);
  }
  const hook = manifest.outputs.find((output) => output.path === 'dist/hook.mjs');
  assert.deepEqual(hook.externals, [], 'the hook imports no store, SDK or keyring');
  assert.equal(manifest.bundled.some((item) => item.name === 'ajv'), true);
  for (const item of manifest.bundled) assert.notEqual(item.license, 'UNKNOWN', item.name);
});

test('a non-literal dynamic import is a bundle problem; literals, comments and relative literals pass (PKG-06)', () => {
  const text = [
    "const cred = await import('@jevris/cli/credential');",
    'const mod = await import(specifier);',
    ' * CI receipt import (VER-06).',
    '// await import(name)',
    'const page = await import(`./${name}.js`);',
    'const fs = await import("node:fs");',
    'const ok = obj.import(x);',
  ].join('\n');
  assert.deepEqual(nonLiteralImports(text).map((hit) => hit.line), [2, 5]);
});

test('the sidecar and hook loaders are separate chunks with their exports, or the bundle fails (PKG-06)', () => {
  const metafile = {
    outputs: {
      'dist/sidecar.mjs': { entryPoint: 'apps/sidecar/dist/main.js', exports: [] },
      'dist/chunks/credential-A.mjs': { entryPoint: 'apps/cli/dist/credential.js', exports: ['resolveProviderCredential', 'openHostEntry'] },
      'dist/chunks/kill-switch-B.mjs': { entryPoint: 'apps/cli/dist/kill-switch.js', exports: ['readKillSwitchStopped'] },
      'dist/chunks/chunk-C.mjs': { exports: ['x'] },
    },
  };
  const modules = dynamicModules(metafile);
  assert.deepEqual(modules.map((item) => [item.source, item.path]), [
    ['apps/cli/dist/credential.js', 'dist/chunks/credential-A.mjs'],
    ['apps/cli/dist/kill-switch.js', 'dist/chunks/kill-switch-B.mjs'],
  ]);
  assert.deepEqual(
    requiredModuleProblems(modules),
    ['certification-store', 'live-evidence', 'reverify', 'harness-auth', 'claude-worker', 'codex-worker', 'opencode-worker', 'kilo-worker', 'antigravity-worker', 'model-offer'].map((stem) => `apps/cli/dist/${stem}.js is not a separate dynamic chunk; the sidecar could not load it from an installed runtime`),
  );
  const renamed = modules.map((item) => (item.source.endsWith('kill-switch.js') ? { ...item, exports: ['readKillSwitch'] } : item));
  assert.match(requiredModuleProblems(renamed, { 'apps/cli/dist/kill-switch.js': ['readKillSwitchStopped'] })[0], /does not export readKillSwitchStopped/);
});

test('the built bundle ships every required on-demand module as its own chunk (PKG-06)', () => {
  const manifest = readJson('dist/bundle-manifest.json');
  assert.deepEqual(requiredModuleProblems(manifest.dynamicModules), []);
  for (const source of Object.keys(REQUIRED_DYNAMIC_MODULES)) {
    const found = manifest.dynamicModules.find((item) => item.source === source);
    assert.equal(existsSync(join(root, found.path)), true, found.path);
  }
});

test('dist/runtime/manifest.json names stable package-relative entry points (ADM-03 contract)', () => {
  const runtime = readJson('dist/runtime/manifest.json');
  assert.equal(runtime.name, pkg.name);
  assert.equal(runtime.version, pkg.version);
  assert.deepEqual(runtime.runtimeDependencies, pkg.dependencies);
  for (const key of ['bin', 'cli', 'mcp', 'hook']) {
    const rel = runtime.entries[key];
    assert.equal(typeof rel, 'string', key);
    assert.equal(rel.includes('\\') || rel.startsWith('/') || rel.includes('..'), false, rel);
    assert.equal(existsSync(join(root, rel)), true, rel);
  }
  assert.equal(runtime.entries.bin, 'bin/jevris.mjs');
  assert.equal(runtime.entries.mcp, 'plugins/shared/mcp.js');
  // The build names its source: a full commit or null, and whether the tree was dirty.
  assert.equal(runtime.source.commit === null || /^[0-9a-f]{40}$/.test(runtime.source.commit), true, String(runtime.source.commit));
  assert.equal(typeof runtime.source.dirty, 'boolean');
});

test('the runtime manifest stamps the source commit, and a dirty tree is flagged so no record claims that commit', () => {
  const sha = 'c'.repeat(40);
  const git = (status) => (args) => (args[0] === 'rev-parse' ? `${sha}\n` : status);
  assert.deepEqual(sourceStamp(root, git('')), { commit: sha, dirty: false });
  assert.deepEqual(sourceStamp(root, git(' M apps/cli/src/cli.ts\n')), { commit: sha, dirty: true });
  assert.deepEqual(sourceStamp(root, git('?? apps/cli/src/new-file.ts\n')), { commit: sha, dirty: true });
  // No git, no work tree, or a malformed answer: no commit is claimed.
  assert.deepEqual(sourceStamp(root, () => { throw new Error('not a git repository'); }), { commit: null, dirty: false });
  assert.deepEqual(sourceStamp(root, () => 'HEAD\n'), { commit: null, dirty: false });
  assert.deepEqual(runtimeManifest(root, { commit: sha, dirty: true }).manifest.source, { commit: sha, dirty: true });
});

test('runtimeClosure walks the lockfile with nested and optional entries', () => {
  const lock = {
    packages: {
      '': {},
      'node_modules/a': { version: '1.0.0', license: 'MIT', dependencies: { b: '^1' }, optionalDependencies: { 'a-linux': '1.0.0', 'a-win': '1.0.0' } },
      'node_modules/a-linux': { version: '1.0.0', license: 'MIT', optional: true, os: ['linux'] },
      'node_modules/b': { version: '1.0.0', license: 'ISC' },
      'node_modules/a/node_modules/b': { version: '2.0.0', license: 'ISC' },
    },
  };
  const closure = runtimeClosure(lock, { a: '1.0.0' });
  assert.deepEqual(closure.map((item) => `${item.name}@${item.version}${item.optional ? '?' : ''}`), ['a@1.0.0', 'a-linux@1.0.0?', 'b@2.0.0']);
  assert.throws(() => runtimeClosure(lock, { missing: '1.0.0' }), /no entry for runtime dependency missing/);
});

test('the SBOM is CycloneDX 1.5 with purls, licences and the bundled/runtime split (PKG-10)', () => {
  const sbom = readJson('dist/sbom.cdx.json');
  assert.equal(sbom.bomFormat, 'CycloneDX');
  assert.equal(sbom.specVersion, '1.5');
  assert.match(sbom.serialNumber, /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(sbom.metadata.component.name, pkg.name);
  assert.equal(sbom.metadata.component.purl, purl(pkg.name, pkg.version));
  const byName = new Map(sbom.components.map((item) => [item.name, item]));
  for (const name of RUNTIME_EXTERNALS) {
    const item = byName.get(name);
    assert.notEqual(item, undefined, name);
    assert.equal(item.properties[0].value, 'runtime-dependency');
    assert.equal(item.hashes[0].alg, 'SHA-512');
  }
  assert.equal(byName.get('ajv').properties[0].value, 'bundled');
  assert.equal(purl('@napi-rs/keyring', '2.1.0'), 'pkg:npm/%40napi-rs/keyring@2.1.0');
  assert.equal(uuidFrom('x'), uuidFrom('x'));
  const again = buildSbom({ pkg, bundled: [], runtime: [], outputs: [] });
  assert.equal(again.metadata.timestamp, undefined, 'no timestamp unless SOURCE_DATE_EPOCH is set');
  const notices = readFileSync(join(root, 'dist', 'THIRD_PARTY_NOTICES.md'), 'utf8');
  assert.match(notices, /### ajv \d+\.\d+\.\d+ \(MIT\)/);
  for (const name of RUNTIME_EXTERNALS) assert.equal(notices.includes(`| ${name} |`), true, name);
});

test('budgetProblems enforces the recorded size budget (PKG-07)', () => {
  assert.deepEqual(budgetProblems({ size: 1, unpackedSize: 1 }), []);
  const over = budgetProblems({ size: SIZE_BUDGET.tarballBytes + 1, unpackedSize: SIZE_BUDGET.unpackedBytes + 1 });
  assert.equal(over.length, 2);
});

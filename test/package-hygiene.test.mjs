import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const SHELL_SYNTAX = ['&&', '||', ';', '|', '$(', '`', ' for ', 'for ', ' do ', 'done', ' cp ', 'rm -', '*', '>', '<'];

test('build, test and prepack are plain node scripts with no POSIX shell syntax (FIX-08)', () => {
  for (const name of ['build', 'test', 'prepack']) {
    const script = pkg.scripts[name];
    assert.equal(typeof script, 'string', name);
    assert.match(script, /^node scripts\/[a-z-]+\.mjs( --[a-z-]+)*$/, `${name}: ${script}`);
    for (const token of SHELL_SYNTAX) {
      assert.equal(script.includes(token), false, `${name} contains ${JSON.stringify(token)}`);
    }
  }
});

test('the runner collects source test/ files, contracts tests and the SSOT reference tests (FIX-08)', async () => {
  const { collectTestFiles } = await import(pathToFileURL(join(root, 'scripts', 'test.mjs')).href);
  const files = collectTestFiles(root).map((file) => file.split('\\').join('/'));
  assert.equal(files.length > 80, true);
  for (const file of files) {
    assert.equal(file.includes('/dist/'), false, file);
    assert.equal(file.endsWith('.test.mjs') || file.endsWith('fixtures/ssot/reference/tests.mjs'), true, file);
  }
  assert.equal(files.some((file) => file.endsWith('packages/contracts/test/schema-round-trip.test.mjs')), true);
  assert.equal(files.some((file) => file.endsWith('packages/contracts/test/protocol-holdout.test.mjs')), true);
  assert.equal(files.some((file) => file.endsWith('fixtures/ssot/reference/tests.mjs')), true);
  assert.equal(files.some((file) => file.endsWith('test/package-hygiene.test.mjs')), true);
});

test('an orphan dist test is neither collected nor left behind by the build (FIX-08)', async () => {
  const { collectTestFiles } = await import(pathToFileURL(join(root, 'scripts', 'test.mjs')).href);
  const { removeOrphanTests } = await import(pathToFileURL(join(root, 'scripts', 'build.mjs')).href);
  const orphan = join(root, 'packages', 'core', 'dist', 'zz-orphan.test.js');
  writeFileSync(orphan, "throw new Error('orphan dist test ran');\n");
  try {
    const files = collectTestFiles(root);
    assert.equal(files.some((file) => file.endsWith('zz-orphan.test.js')), false);
    const removed = removeOrphanTests(root);
    assert.equal(removed.some((file) => file.endsWith('zz-orphan.test.js')), true);
    assert.equal(existsSync(orphan), false);
  } finally {
    rmSync(orphan, { force: true });
  }
  for (const workspace of pkg.workspaces) {
    const dist = join(root, workspace, 'dist');
    if (!existsSync(dist)) continue;
    assert.deepEqual(
      readdirSync(dist).filter((name) => name.endsWith('.test.js')),
      [],
      `${workspace}/dist still holds copied tests`,
    );
  }
});

test('the test process runs with a temporary HOME, never the real one (FIX-11)', async () => {
  const { realHomeFromEnv } = await import(pathToFileURL(join(root, 'scripts', 'test.mjs')).href);
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  assert.equal(process.env.JEVRIS_TEST_HOME, home);
  assert.notEqual(realHomeFromEnv(), undefined);
  assert.notEqual(home, process.env.JEVRIS_TEST_REAL_HOME);
  assert.equal(process.env.USERPROFILE, home);
  assert.equal(process.env.XDG_CONFIG_HOME, join(home, '.config'));
  assert.equal(process.env.CODEX_HOME, join(home, '.codex'));
});

test('engines.node is ^22.14.0 || >=23.6.0 with no upper bound (FIX-09)', () => {
  assert.equal(pkg.engines.node, '^22.14.0 || >=23.6.0');
});

test('bin/jevris.mjs exits 2 with a plain message when N-API is below 10 (FIX-09)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-napi-'));
  try {
    const preload = join(dir, 'napi9.mjs');
    writeFileSync(preload, "Object.defineProperty(process.versions, 'napi', { value: '9' });\n");
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, join(root, 'bin', 'jevris.mjs'), '--help'], {
      encoding: 'utf8',
      shell: false,
    });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^jevris needs Node \^22\.14\.0 \|\| >=23\.6\.0/);
    assert.equal(result.stderr.includes('\n    at '), false);
    assert.equal(result.stderr.trim().split('\n').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const source = readFileSync(join(root, 'bin', 'jevris.mjs'), 'utf8');
  assert.equal(/^import\s/m.test(source), false, 'bin/jevris.mjs must not statically import the CLI before the guard');
});

// CI (macOS, Node 22.14.0): a pipe is asynchronous there, and process.exit dropped what it had not
// taken, so piped `route --help` and `doctor --json` stopped at 8192 bytes. The preload makes every
// stdout write finish later, as a slow pipe does; the whole answer must still arrive.
test('bin/jevris.mjs hands a slow pipe the whole answer before it exits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-slow-pipe-'));
  try {
    const preload = join(dir, 'slow-stdout.mjs');
    writeFileSync(preload, [
      'const write = process.stdout._write.bind(process.stdout);',
      'process.stdout._writev = undefined;',
      'process.stdout._write = (chunk, encoding, done) => setTimeout(() => write(chunk, encoding, done), 50);',
      '',
    ].join('\n'));
    const argv = [join(root, 'bin', 'jevris.mjs'), 'route', '--help'];
    const direct = spawnSync(process.execPath, argv, { encoding: 'utf8', shell: false });
    assert.equal(direct.status, 0, direct.stderr);
    assert.ok(direct.stdout.length > 8192, `route --help is ${direct.stdout.length} bytes, so it spans a small pipe buffer`);
    const slow = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, ...argv], { encoding: 'utf8', shell: false });
    assert.equal(slow.status, 0, slow.stderr);
    assert.equal(slow.stdout, direct.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the files allowlist and the tarball check keep sources out and runtime in (FIX-10, PKG-06)', async () => {
  assert.equal(Array.isArray(pkg.files), true);
  const { PUBLIC_SKILLS, SKILL_TREES, checkPackList } = await import(pathToFileURL(join(root, 'scripts', 'check-pack.mjs')).href);
  const { PLUGIN_FILES } = await import(pathToFileURL(join(root, 'scripts', 'release-policy.mjs')).href);
  const good = [
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
    'plugins/shared/skills/plan/reference.md',
    'packs/skill-advice/pack.json',
    'assets/schemas/pack-manifest.schema.json',
    'assets/evaluation/frontier-corpus.json',
    'assets/evaluation/cost-registry.json',
    ...SKILL_TREES.flatMap((dir) => PUBLIC_SKILLS.map((name) => `${dir}/${name}/SKILL.md`)),
  ];
  assert.deepEqual(checkPackList(good), { missing: [], forbidden: [] });
  for (const bad of [
    '.planning/ROADMAP.md',
    'ssot_docs/reference/tests.mjs',
    'fixtures/install/x.json',
    'apps/cli/src/cli.ts',
    'apps/cli/test/install.test.mjs',
    'packages/core/dist/zz.test.js',
    'apps/cli/tsconfig.json',
    'tsconfig.base.json',
    // Workspace output is bundled into dist/ and never shipped on its own (PKG-06).
    'apps/cli/dist/cli.js',
    'apps/cli/package.json',
    'packages/core/dist/index.js',
    'scripts/build.mjs',
    // The SSOT skill templates are retired; skills ship from plugins/shared/skills (SKL-01).
    'assets/skill-templates/route/SKILL.md',
    // Generated plugin files are rendered at install, never shipped (DRY).
    'plugins/claude/skills/plan/SKILL.md',
    'plugins/codex/plugin/skills/verify/SKILL.md',
    'plugins/claude/bin/hook.js',
    'plugins/codex/plugin/bin/mcp.js',
    'plugins/opencode/jevris.js',
    'plugins/kilocode/jevris.js',
    'dist/plugins/claude/skills/plan/SKILL.md',
  ]) {
    assert.deepEqual(checkPackList([...good, bad]).forbidden, [bad], bad);
  }
  assert.deepEqual(checkPackList(good.filter((path) => path !== 'plugins/shared/skills/verify/SKILL.md')).missing, ['plugins/shared/skills/verify/SKILL.md']);
  assert.deepEqual(checkPackList(good.filter((path) => path !== 'plugins/shared/shim.js')).missing, ['plugins/shared/shim.js']);
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'check-pack.mjs')], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('the tarball ships the nine skills once, from the shared source, and no rendered tree (SKL-01, PKG-06, DRY)', async () => {
  const { PUBLIC_SKILLS, SKILL_TREES, duplicatePluginProblems } = await import(pathToFileURL(join(root, 'scripts', 'check-pack.mjs')).href);
  assert.deepEqual([...PUBLIC_SKILLS].sort(), ['checkpoint', 'configure', 'explain', 'guide', 'plan', 'recover', 'route', 'status', 'verify']);
  assert.deepEqual(SKILL_TREES, ['plugins/shared/skills']);
  for (const name of PUBLIC_SKILLS) assert.equal(existsSync(join(root, 'plugins', 'shared', 'skills', name, 'SKILL.md')), true, name);
  for (const dir of ['plugins/claude/skills', 'plugins/codex/plugin/skills', 'plugins/opencode/skills', 'plugins/antigravity/skills', 'plugins/claude/bin', 'dist/plugins']) {
    assert.equal(existsSync(join(root, ...dir.split('/'))), false, `${dir} is rendered at install, not kept in the repository or dist`);
  }
  assert.equal(existsSync(join(root, 'assets', 'skill-templates')), false, 'the retired SSOT skill templates are not shipped');
  // A shipped copy of a shared file is a duplicate, whichever path it sits at.
  const bytes = { 'plugins/shared/skills/plan/SKILL.md': Buffer.from('# plan\n'.repeat(40)), 'plugins/claude/skills/plan/SKILL.md': Buffer.from('# plan\n'.repeat(40)), 'plugins/shared/mcp.js': Buffer.from('export {};\n') };
  assert.deepEqual(duplicatePluginProblems(Object.keys(bytes), (path) => bytes[path]), ['plugins/shared/skills/plan/SKILL.md and plugins/claude/skills/plan/SKILL.md are identical']);
  // A harness whose manifest is missing from the tarball, or invalid, fails the check.
  const { harnessManifestProblems } = await import(pathToFileURL(join(root, 'scripts', 'check-pack.mjs')).href);
  const { HARNESS_LAUNCHERS, HARNESS_MANIFESTS, NATIVE_MANIFESTS } = await import(pathToFileURL(join(root, 'scripts', 'release-policy.mjs')).href);
  const manifests = [...Object.values(HARNESS_MANIFESTS), ...Object.values(NATIVE_MANIFESTS)];
  const valid = (path) => {
    const harness = Object.keys(HARNESS_MANIFESTS).find((name) => HARNESS_MANIFESTS[name] === path);
    if (harness === undefined) return Buffer.from('{"name":"jevris","description":"d"}');
    const shim = NATIVE_MANIFESTS[harness] === undefined ? { plugin: { path: 'p', export: 'default', template: 'plugins/shared/shim.js' }, events: [], mcp: { dir: 'd', file: 'f.json', key: ['mcp', 'jevris'], schema: null, entry: {} } } : { plugin: { path: 'p' } };
    const skills = { dir: 's', namespace: '', allowedToolsPrefix: null, userInvocationField: null };
    return Buffer.from(JSON.stringify({ harness, launcher: HARNESS_LAUNCHERS[harness], displayName: harness, skills, hooks: [], features: [], unsupported: {}, ...shim }));
  };
  assert.deepEqual(harnessManifestProblems(manifests, valid), []);
  assert.deepEqual(harnessManifestProblems(manifests.filter((path) => !path.startsWith('plugins/kilocode/')), valid), [`kilocode: ${HARNESS_MANIFESTS.kilocode} is not in the tarball`]);
  assert.deepEqual(harnessManifestProblems(manifests, (path) => (path === HARNESS_MANIFESTS.opencode ? Buffer.from('{}') : valid(path))), [`opencode: ${HARNESS_MANIFESTS.opencode} names harness undefined, not opencode`]);
  assert.deepEqual(harnessManifestProblems(manifests, (path) => (path === NATIVE_MANIFESTS.codex ? Buffer.from('{"name":"x"}') : valid(path))), [`codex: ${NATIVE_MANIFESTS.codex} does not name the plugin "jevris"`]);
});

test('Gemini is retired from the workspaces, references, lockfile, build and test (FIX-13)', () => {
  const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'));
  const lock = readFileSync(join(root, 'package-lock.json'), 'utf8');
  assert.equal(pkg.workspaces.some((entry) => entry.includes('gemini')), false);
  assert.equal(tsconfig.references.some((ref) => ref.path.includes('gemini')), false);
  assert.equal(lock.includes('adapter-gemini'), false);
  assert.equal(existsSync(join(root, 'packages', 'adapter-gemini')), false);
  assert.equal(existsSync(join(root, 'plugins', 'gemini')), false);
  assert.equal(JSON.stringify(pkg.scripts).includes('gemini'), false);
});

test('no test re-runs the build or the hook emitter while other test files copy its output (FIX-08)', async () => {
  const { collectTestFiles } = await import(pathToFileURL(join(root, 'scripts', 'test.mjs')).href);
  for (const file of collectTestFiles(root)) {
    if (file === fileURLToPath(import.meta.url)) continue;
    const text = readFileSync(file, 'utf8');
    for (const script of ['emit-hook.mjs', "'build.mjs'", 'scripts/build.mjs']) {
      assert.equal(text.includes(script), false, `${file} references ${script}`);
    }
  }
});

test('check:pack is strict by default: a runtime reference to a development-only tree fails (D-A6)', async () => {
  const { strictMode, runtimeTreeProblems } = await import(pathToFileURL(join(root, 'scripts', 'check-pack.mjs')).href);
  assert.equal(strictMode([]), true);
  assert.equal(strictMode(['--strict']), true);
  assert.equal(strictMode(['--lenient']), false);
  const dir = mkdtempSync(join(tmpdir(), 'jevris-strict-'));
  try {
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'bad.mjs'), "const p = 'fixtures/gates/quality.json';\n");
    writeFileSync(join(dir, 'dist', 'good.mjs'), 'export const ok = 1;\n');
    assert.equal(runtimeTreeProblems(dir, ['dist/bad.mjs']).length, 1);
    assert.deepEqual(runtimeTreeProblems(dir, ['dist/good.mjs']), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

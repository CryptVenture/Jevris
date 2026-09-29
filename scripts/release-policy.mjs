/**
 * One source of truth for what the published package may contain and depend on
 * (PKG-06, PKG-07, PKG-08). scripts/bundle.mjs, scripts/check-pack.mjs,
 * scripts/pack-smoke.mjs and the release tests read these constants.
 */

export const PACKAGE_NAME = '@cryptventure/jevris';

/** The only runtime dependencies of the published package. Exact pins. */
export const RUNTIME_EXTERNALS = ['better-sqlite3', '@typesafe-ai/sdk', '@napi-rs/keyring'];

/**
 * Optional at runtime, never bundled and never installed by default. Loaded with a
 * dynamic import; its absence gives a plain unsupported result for owned sessions.
 */
export const OPTIONAL_EXTERNALS = ['@anthropic-ai/claude-agent-sdk'];

/**
 * The self-contained entry bundles. Each `from` is the tsc output; `closed` names module
 * paths and packages the bundle's graph must not contain.
 */
export const BUNDLE_ENTRIES = [
  { name: 'cli', from: 'apps/cli/dist/cli.js', split: true, closed: [] },
  // The sidecar daemon (domain B): `node <runtime>/dist/sidecar.mjs [--home] [--idle-ms] [--supervised]`.
  // Bundled once apps/sidecar/src/main.ts lands; required from then on (see REQUIRED_ENTRY_NAMES).
  { name: 'sidecar', from: 'apps/sidecar/dist/main.js', split: true, closed: [], optional: true },
  {
    name: 'hook',
    from: 'apps/hook/dist/bin.js',
    split: false,
    // The hook stays a closed graph: no store, no SDK, no keyring (§5.3).
    closed: ['packages/store/', 'better-sqlite3', '@napi-rs/keyring', '@typesafe-ai/sdk', '@anthropic-ai/', 'packages/provider-typesafe/'],
  },
];

/** Scripts shipped as they are: they import node builtins only. */
export const STANDALONE_SCRIPTS = ['plugins/shared/mcp.js'];

/**
 * Size budget for the default install (PKG-07). The tarball is what npm downloads; the
 * installed figure is the package plus its runtime dependency closure on one platform.
 */
export const SIZE_BUDGET = {
  tarballBytes: 4 * 1024 * 1024,
  unpackedBytes: 16 * 1024 * 1024,
  installedBytes: 48 * 1024 * 1024,
};

/** Paths a runtime file may never read or name: development-only trees. */
export const FORBIDDEN_RUNTIME_TREES = ['ssot_docs/', 'fixtures/', '.planning/'];

const BUILTINS = new Set([
  'assert', 'assert/strict', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto',
  'dgram', 'diagnostics_channel', 'dns', 'dns/promises', 'domain', 'events', 'fs', 'fs/promises', 'http', 'http2',
  'https', 'inspector', 'module', 'net', 'os', 'path', 'path/posix', 'path/win32', 'perf_hooks', 'process',
  'punycode', 'querystring', 'readline', 'readline/promises', 'repl', 'stream', 'stream/consumers',
  'stream/promises', 'stream/web', 'string_decoder', 'timers', 'timers/promises', 'tls', 'trace_events', 'tty',
  'url', 'util', 'util/types', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib', 'sqlite', 'test',
]);

export function isBuiltin(specifier) {
  if (specifier.startsWith('node:')) return true;
  return BUILTINS.has(specifier);
}

/** The package name of a bare specifier (`@scope/name/sub` -> `@scope/name`). */
export function packageOf(specifier) {
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) return parts.slice(0, 2).join('/');
  return parts[0] ?? specifier;
}

/** True when an external import is allowed in a published bundle. */
export function allowedExternal(specifier) {
  if (isBuiltin(specifier)) return true;
  const name = packageOf(specifier);
  return RUNTIME_EXTERNALS.includes(name) || OPTIONAL_EXTERNALS.includes(name);
}

/**
 * The only plugin files git tracks and the tarball ships (DRY plugin rule). Everything a
 * harness needs beyond these is rendered at install into the target home: one shared skill
 * source rendered per harness, and one Kilo/OpenCode plugin template (plugins/shared/shim.js).
 * Nothing is rendered into the repository or into dist/plugins.
 */
/**
 * Every supported harness keeps its own folder with its own manifest, `plugins/<harness>/harness.json`,
 * which the install renderer reads (launcher, skills folder, plugin file, MCP entry, hooks and
 * features). A harness missing here, in the repository or in the tarball fails the DRY lint and
 * check:pack, so a harness cannot silently disappear.
 */
export const HARNESS_LAUNCHERS = { claude: 'claude', codex: 'codex', kilocode: 'kilo', opencode: 'opencode', antigravity: 'agy' };
export const HARNESS_MANIFESTS = Object.fromEntries(Object.keys(HARNESS_LAUNCHERS).map((harness) => [harness, `plugins/${harness}/harness.json`]));

/** The harness-native plugin manifests, where the harness has one. Kilo Code and OpenCode use the rendered shim. */
export const NATIVE_MANIFESTS = {
  claude: 'plugins/claude/.claude-plugin/plugin.json',
  codex: 'plugins/codex/plugin/plugin.json',
  antigravity: 'plugins/antigravity/plugin.json',
};

export const PLUGIN_FILES = [
  'plugins/shared/mcp.js',
  'plugins/shared/shim.js',
  ...Object.values(HARNESS_MANIFESTS),
  ...Object.values(NATIVE_MANIFESTS),
  'plugins/claude/hooks/hooks.json',
  'plugins/claude/.mcp.json',
];

function parseObject(text) {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? { value } : { problem: 'is not a JSON object' };
  } catch {
    return { problem: 'is not JSON' };
  }
}

const isString = (value) => typeof value === 'string' && value.length > 0;
const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');

/** Why a harness.json is not valid for `harness`, or null. Extra keys are allowed. */
export function harnessManifestProblem(harness, text) {
  const { value, problem } = parseObject(text);
  if (problem !== undefined) return problem;
  if (value.harness !== harness) return `names harness ${JSON.stringify(value.harness)}, not ${harness}`;
  if (value.launcher !== HARNESS_LAUNCHERS[harness]) return `names launcher ${JSON.stringify(value.launcher)}, not ${HARNESS_LAUNCHERS[harness]}`;
  if (!isString(value.displayName)) return 'has no displayName';
  const skills = value.skills;
  const nullableString = (item) => item === null || typeof item === 'string';
  if (skills === null || typeof skills !== 'object' || !isString(skills.dir) || !['', 'jevris-'].includes(skills.namespace) || !nullableString(skills.allowedToolsPrefix) || !nullableString(skills.userInvocationField)) return 'has no valid skills entry (dir, namespace, allowedToolsPrefix, userInvocationField)';
  if (/^[/\\]|^[A-Za-z]:|(^|[/\\])\.\.([/\\]|$)/.test(skills.dir.replace(/^\$(CONFIG|CODEX_HOME)\//, ''))) return 'skills.dir is not home-relative';
  if (value.plugin === null || typeof value.plugin !== 'object' || !isString(value.plugin.path)) return 'has no plugin.path';
  if (!isStringArray(value.hooks)) return 'hooks is not a list of strings';
  if (!isStringArray(value.features)) return 'features is not a list of strings';
  if (value.unsupported === null || typeof value.unsupported !== 'object' || Array.isArray(value.unsupported) || !Object.values(value.unsupported).every(isString)) return 'unsupported is not a map of reasons';
  if (NATIVE_MANIFESTS[harness] === undefined) {
    if (!['default', 'named'].includes(value.plugin.export)) return 'plugin.export is not "default" or "named"';
    const mcp = value.mcp;
    if (mcp === null || typeof mcp !== 'object' || !isString(mcp.dir) || !isString(mcp.file) || !isStringArray(mcp.key) || mcp.key.length === 0 || !(mcp.schema === null || isString(mcp.schema)) || mcp.entry === null || typeof mcp.entry !== 'object') return 'has no valid mcp entry (dir, file, key, schema, entry)';
    if (value.plugin.template !== 'plugins/shared/shim.js') return 'plugin.template is not plugins/shared/shim.js';
    if (!isStringArray(value.events)) return 'events is not a list of strings';
  }
  return null;
}

/** Why a native plugin manifest is not valid, or null: a JSON object named "jevris" with a description. */
export function manifestProblem(text) {
  const { value, problem } = parseObject(text);
  if (problem !== undefined) return problem;
  if (value.name !== 'jevris') return 'does not name the plugin "jevris"';
  if (!isString(value.description)) return 'has no description';
  return null;
}

/** The shared skill source: one folder per public skill, a SKILL.md and an optional reference.md. */
export const PLUGIN_SKILL_FILE = /^plugins\/shared\/skills\/[a-z][a-z0-9-]*\/(?:SKILL|reference)\.md$/;

/** Whether a package-relative path is a plugin file the repository may track and ship. */
export function isAllowedPluginPath(path) {
  const p = path.split('\\').join('/');
  return PLUGIN_FILES.includes(p) || PLUGIN_SKILL_FILE.test(p);
}

/** Files of at least this size are also compared line by line. */
export const NEAR_DUPLICATE_MIN_BYTES = 200;
/** Share of content lines (any with a letter or digit) two files may share before they count as near-identical. */
export const NEAR_DUPLICATE_LINE_SHARE = 0.9;

function normalized(text) {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function lineShare(a, b) {
  // Lines with no letter or digit (braces, brackets, fences) say nothing about a copy.
  const lines = (text) => text.split(/\r?\n/).map((line) => line.trim()).filter((line) => /[A-Za-z0-9]/.test(line));
  const left = lines(a);
  const right = lines(b);
  if (left.length === 0 || right.length === 0) return 0;
  const counts = new Map();
  for (const line of left) counts.set(line, (counts.get(line) ?? 0) + 1);
  let common = 0;
  for (const line of right) {
    const n = counts.get(line) ?? 0;
    if (n > 0) {
      common += 1;
      counts.set(line, n - 1);
    }
  }
  return common / Math.max(left.length, right.length);
}

/**
 * Pairs of files that repeat each other: byte-identical, equal after whitespace and case are
 * normalised, or (both at least NEAR_DUPLICATE_MIN_BYTES) sharing NEAR_DUPLICATE_LINE_SHARE of
 * their non-blank lines. `files` is a list of { path, bytes } (bytes a Buffer or Uint8Array).
 */
export function duplicatePlugins(files) {
  const found = [];
  const texts = files.map((file) => ({ path: file.path, bytes: Buffer.from(file.bytes), text: Buffer.from(file.bytes).toString('utf8') }));
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      const a = texts[i];
      const b = texts[j];
      if (a.bytes.equals(b.bytes)) found.push({ a: a.path, b: b.path, kind: 'identical' });
      else if (normalized(a.text) === normalized(b.text)) found.push({ a: a.path, b: b.path, kind: 'identical-after-whitespace' });
      else if (a.bytes.length >= NEAR_DUPLICATE_MIN_BYTES && b.bytes.length >= NEAR_DUPLICATE_MIN_BYTES) {
        const share = lineShare(a.text, b.text);
        if (share >= NEAR_DUPLICATE_LINE_SHARE) found.push({ a: a.path, b: b.path, kind: `near-identical (${Math.round(share * 100)}% of lines)` });
      }
    }
  }
  return found;
}

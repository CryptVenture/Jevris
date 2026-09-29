#!/usr/bin/env node
/**
 * Installed-product smoke from the packed tarball (PKG-08) and the installed end-to-end
 * scenario (RLS-04). Nothing here touches the real HOME, the real npm cache or a real
 * harness binary.
 *
 *   node scripts/pack-smoke.mjs                 # quick: pack, global install to a temp prefix,
 *                                               #   --version, --help, doctor, install, uninstall, data delete
 *   node scripts/pack-smoke.mjs --full          # + seeded user configs, MCP handshake through the
 *                                               #   installed configs, gates, kill-switch drill,
 *                                               #   a user edit between install and uninstall,
 *                                               #   byte-identical configs after uninstall
 *   node scripts/pack-smoke.mjs --npx           # + npx from a private cache: configs never point
 *                                               #   at _npx and MCP works after `npm cache clean --force`
 *   node scripts/pack-smoke.mjs --tarball <file> --no-build --report smoke.json
 *   node scripts/pack-smoke.mjs --full --npx --evidence evidence/installed-e2e.json   # gate evidence
 *   node scripts/pack-smoke.mjs --full --drills-evidence evidence/operations-drills.json
 *
 * --full also runs B's eight operations drills (OBS-05, apps/sidecar/scripts/ops-drills.mjs)
 * against the installed package: its `jevris` shim and its dist/hook.mjs, each drill in a private
 * home. --drills-evidence writes their `operations-drills` record (ranAgainst installed-tarball).
 *
 * Every step is recorded; the report is the release evidence for PKG-08 and RLS-04.
 * Exit 0 only when every step passed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMain, runNode } from './build.mjs';
import { removeTree } from './remove-tree.mjs';
import { guardStdin } from './child-stdin.mjs';
import { OPTIONAL_EXTERNALS, PACKAGE_NAME, RUNTIME_EXTERNALS, SIZE_BUDGET } from './release-policy.mjs';
import { testEnvironment, writeHarnessStubs } from './test.mjs';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

export function npmCli() {
  const fromEnv = process.env.npm_execpath;
  if (typeof fromEnv === 'string' && fromEnv.endsWith('.js') && existsSync(fromEnv)) return fromEnv;
  const nodeDir = dirname(process.execPath);
  for (const candidate of [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('npm-cli.js not found next to this node');
}

/** Pre-existing user configs, one per harness, in the layout of the sandbox env. */
export const SEEDED_CONFIGS = [
  { rel: ['.claude', 'settings.json'], kind: 'json', text: '{\n  "theme": "dark",\n  "permissions": {\n    "allow": [\n      "Bash(ls:*)"\n    ]\n  }\n}\n' },
  { rel: ['.codex', 'config.toml'], kind: 'toml', text: 'model = "gpt-5"\n\n[profiles.work]\nmodel = "o3"\n' },
  { rel: ['.codex', 'hooks.json'], kind: 'json', text: '{\n  "hooks": {\n    "PostToolUse": [\n      {\n        "hooks": [\n          {\n            "type": "command",\n            "command": "user-post-hook"\n          }\n        ]\n      }\n    ]\n  }\n}\n' },
  { rel: ['.config', 'kilo', 'kilo.json'], kind: 'json', text: '{\n  "$schema": "https://kilo.ai/config.json",\n  "model": "user/model"\n}\n' },
  { rel: ['.config', 'opencode', 'opencode.json'], kind: 'json', text: '{\n  "$schema": "https://opencode.ai/config.json",\n  "theme": "system"\n}\n' },
  { rel: ['.gemini', 'config', 'mcp_config.json'], kind: 'json', text: '{\n  "mcpServers": {\n    "user-server": {\n      "command": "user-server"\n    }\n  }\n}\n' },
];

const USER_EDIT_JSON = '\n  "userEditAfterInstall": true,';
const USER_EDIT_TOML = '\n# user edit after install\n';

/**
 * The edit a user makes between install and uninstall. JSON: a new first key; TOML: a
 * trailing comment. Uninstall must keep it, so the expected final bytes are the seed with
 * the same edit.
 */
export function applyUserEdit(text, kind) {
  if (kind === 'toml') return `${text}${USER_EDIT_TOML}`;
  const at = text.indexOf('{');
  if (at < 0) return text;
  return `${text.slice(0, at + 1)}${USER_EDIT_JSON}${text.slice(at + 1)}`;
}

/** Every quoted string literal in a JSON, JSONC or TOML text, unescaped. */
export function quotedStrings(text) {
  const out = [];
  for (const match of text.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
    try {
      out.push(JSON.parse(`"${match[1]}"`));
    } catch {
      out.push(match[1]);
    }
  }
  for (const match of text.matchAll(/'([^'\n]*)'/g)) out.push(match[1]);
  return out;
}

/** Command-line tokens of a config string; a double-quoted token may contain spaces. */
export function commandTokens(value) {
  return (value.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) => token.replace(/^["']|["']$/g, ''));
}

/** Jevris entry points a config names: the MCP server, the CLI bin and hook launchers. */
export function referencedEntryPaths(text) {
  const found = new Set();
  for (const value of quotedStrings(text)) {
    for (const part of commandTokens(value)) {
      const cleaned = part.replace(/^["']|["']$/g, '');
      if (/(?:^|[\\/])(mcp\.m?js|jevris\.mjs|hook\.m?js|cli\.mjs)$/.test(cleaned) && /[\\/]/.test(cleaned)) found.add(cleaned);
    }
  }
  return [...found];
}

/** Problems with one installed config: repository paths, npx cache paths, temp prefixes. */
export function configProblems(file, text, { repo, forbidden = [] }) {
  const problems = [];
  const norm = (value) => value.split('\\').join('/').toLowerCase();
  const body = norm(text.split('\\\\').join('\\'));
  if (repo !== undefined && body.includes(norm(repo))) problems.push(`${file} names the repository path`);
  if (body.includes('/_npx/') || body.includes('_npx')) problems.push(`${file} names the npx cache (_npx)`);
  for (const path of forbidden) if (body.includes(norm(path))) problems.push(`${file} names ${path}`);
  return problems;
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function walkFiles(dir, out = [], depth = 0) {
  if (depth > 12 || !existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (name === 'node_modules') continue;
      walkFiles(full, out, depth + 1);
    } else out.push(full);
  }
  return out;
}

export function treeBytes(dir) {
  let total = 0;
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(full);
      else total += st.size;
    }
  };
  if (existsSync(dir)) walk(dir);
  return total;
}

/** Harness config files an install may write: every small text config under the home. */
function underDir(path, dir) {
  const norm = (value) => value.split('\\').join('/').replace(/\/+$/, '').toLowerCase();
  const p = norm(path);
  const d = norm(dir);
  return p === d || p.startsWith(`${d}/`);
}

/**
 * Harness config files an install may write: every small text config under the home, except the
 * Jevris runtime copy itself (its shipped JSON names relative entry paths by design).
 */
export function configFiles(home, runtimeDir) {
  return walkFiles(home).filter(
    (file) => /\.(json|jsonc|toml)$/.test(file) && !isInstallReceipt(file) && statSync(file).size < 1024 * 1024 && (runtimeDir === undefined || !underDir(file, runtimeDir)),
  );
}

/** A Jevris install receipt, which records what install wrote; it is not a harness config. */
export function isInstallReceipt(file) {
  return /(^|[\\/])[a-z0-9-]+-install-receipt\.json$/.test(file);
}

/** The three forms of the home a 2.1 receipt stores as tokens (ADM-06), expanded. */
export function expandHomeTokens(text, home) {
  return text
    .split('${JEVRIS_HOME_JSON}')
    .join(JSON.stringify(home).slice(1, -1))
    .split('${JEVRIS_HOME_POSIX}')
    .join(home.split('\\').join('/'))
    .split('${JEVRIS_HOME}')
    .join(home);
}

/**
 * Checks every install receipt under `home` against the files it lists: a receipt names no
 * absolute home path, every listed file exists with the recorded sha256, every listed folder
 * exists, and every edited file still contains the text Jevris inserted (tokens expanded).
 * Returns the problems and the absolute paths the receipts list, for the after-uninstall check.
 */
export function receiptCheck(home, files = walkFiles(home).filter(isInstallReceipt)) {
  const problems = [];
  const listed = { files: [], dirs: [], edits: [] };
  const abs = (path, schema) => (schema === '2.0' ? path : join(home, ...String(path).split('/')));
  const homeForms = [home, JSON.stringify(home).slice(1, -1), home.split('\\').join('/')];
  for (const file of files) {
    const name = relative(home, file);
    const text = readFileSync(file, 'utf8');
    let receipt;
    try {
      receipt = JSON.parse(text);
    } catch {
      problems.push(`${name} is not JSON`);
      continue;
    }
    const schema = receipt.schemaVersion;
    if (schema !== '2.0' && homeForms.some((form) => form.length > 1 && text.includes(form))) problems.push(`${name} names the absolute home`);
    for (const entry of receipt.files ?? []) {
      const path = abs(entry.path, schema);
      listed.files.push(path);
      if (!existsSync(path)) problems.push(`${name}: ${entry.path} is missing`);
      else if (typeof entry.sha256 === 'string' && sha256(readFileSync(path)) !== entry.sha256.replace(/^sha256:/, '')) problems.push(`${name}: ${entry.path} does not match its sha256`);
    }
    for (const dir of receipt.dirs ?? []) {
      const path = abs(dir, schema);
      listed.dirs.push(path);
      if (!existsSync(path)) problems.push(`${name}: folder ${dir} is missing`);
    }
    for (const edit of receipt.edits ?? []) {
      const path = abs(edit.file, schema);
      listed.edits.push(path);
      if (!existsSync(path)) {
        problems.push(`${name}: edited ${edit.file} is missing`);
        continue;
      }
      const body = readFileSync(path, 'utf8');
      for (const splice of edit.splices ?? []) if (typeof splice.text === 'string' && !body.includes(expandHomeTokens(splice.text, home))) problems.push(`${name}: ${edit.file} lacks the text install inserted`);
    }
  }
  return { receipts: files.length, problems, listed };
}

/**
 * What uninstall left of the paths a receipt check listed: any listed file, and any listed
 * folder that is still there and empty (uninstall keeps a folder that holds something else).
 */
export function receiptLeftovers(home, receipts) {
  if (receipts === undefined) return ['(no receipts were read after install)'];
  const files = receipts.listed.files.filter((path) => existsSync(path));
  const dirs = receipts.listed.dirs.filter((path) => existsSync(path) && readdirSync(path).length === 0);
  // Written as the receipts write them: '/' on every OS.
  return [...files, ...dirs].map((path) => relative(home, path).split(sep).join('/'));
}

/** Absolute filesystem paths named in a config (POSIX or Windows spelling). */
export function absolutePaths(text) {
  const out = new Set();
  for (const value of quotedStrings(text)) {
    for (const part of commandTokens(value)) {
      const cleaned = part.replace(/^["']|["']$/g, '');
      if (/^\/[^/]/.test(cleaned) || /^[A-Za-z]:[\\/]/.test(cleaned)) out.add(cleaned);
    }
  }
  return [...out];
}

const PLUGIN_ROOT_PREFIX = /^\$\{(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT|plugin_root)\}[\\/]?(.*)$/;

/**
 * The entry paths a plugin root registers: `${CLAUDE_PLUGIN_ROOT}/…` and `./…` script paths in
 * its hooks.json, mcp.json, .mcp.json and plugin manifests, resolved against the root, plus
 * every MCP server's command line.
 */
export function pluginRootEntries(root) {
  const scripts = new Set();
  const servers = [];
  const files = walkFiles(root).filter((file) => /(^|[\\/])(hooks\.json|mcp\.json|\.mcp\.json|plugin\.json)$/.test(file));
  const resolveRel = (value) => {
    const rooted = PLUGIN_ROOT_PREFIX.exec(value);
    if (rooted !== null) return join(root, ...rooted[1].split(/[\\/]/).filter((part) => part.length > 0));
    if (/^\.\.?[\\/]/.test(value)) return join(root, ...value.split(/[\\/]/));
    return value;
  };

  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const text = JSON.stringify(parsed);
    for (const value of quotedStrings(text)) {
      for (const part of commandTokens(value)) {
        const cleaned = part.replace(/^["']|["']$/g, '');
        if (/\.(m?js|cjs)$/.test(cleaned) && (PLUGIN_ROOT_PREFIX.test(cleaned) || /^\.\.?[\\/]/.test(cleaned))) scripts.add(resolveRel(cleaned));
      }
    }
    const mcp = parsed?.mcpServers ?? (parsed && typeof parsed === 'object' && /mcp\.json$/.test(file) ? parsed : {});
    for (const server of Object.values(mcp ?? {})) {
      if (server === null || typeof server !== 'object' || typeof server.command !== 'string') continue;
      const args = Array.isArray(server.args) ? server.args.filter((arg) => typeof arg === 'string').map(resolveRel) : [];
      servers.push({ command: server.command, args });
    }
  }
  return { scripts: [...scripts], servers };
}

/** One MCP stdio session: initialize, initialized, tools/list. Resolves with the tool names. */
export function mcpHandshake(command, args, env, timeoutMs = 20000) {
  return new Promise((resolve) => {
    // The exit handler reports a child that is gone before a write lands (guardStdin).
    const child = guardStdin(spawn(command, args, { env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }));
    let buffer = '';
    let stderr = '';
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, detail: 'timeout' }), timeoutMs);
    child.on('error', (error) => finish({ ok: false, detail: `spawn: ${error.code ?? error.message}` }));
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-2000);
    });
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (line.length === 0) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          finish({ ok: false, detail: `non-JSON stdout line: ${line.slice(0, 120)}` });
          return;
        }
        if (message.id === 1) {
          if (message.result === undefined) return finish({ ok: false, detail: 'initialize failed' });
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
        } else if (message.id === 2) {
          const tools = Array.isArray(message.result?.tools) ? message.result.tools.map((tool) => tool.name) : [];
          finish(tools.length > 0 ? { ok: true, tools, protocol: undefined } : { ok: false, detail: 'tools/list empty' });
        }
      }
    });
    child.on('exit', (code) => finish({ ok: false, detail: `exited ${code} before tools/list; ${stderr.trim().slice(0, 300)}` }));
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'jevris-pack-smoke', version: '1' } },
      })}\n`,
    );
  });
}

export function parseArgs(argv) {
  const options = { full: false, npx: false, build: true, tarball: undefined, report: undefined, evidence: undefined, drillsEvidence: undefined, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--full') options.full = true;
    else if (arg === '--npx') options.npx = true;
    else if (arg === '--no-build') options.build = false;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--tarball') options.tarball = argv[++i];
    else if (arg === '--report') options.report = argv[++i];
    else if (arg === '--evidence') options.evidence = argv[++i];
    else if (arg === '--drills-evidence') options.drillsEvidence = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.drillsEvidence !== undefined && !options.full) throw new Error('--drills-evidence needs --full: the drills run only in the full smoke');
  return options;
}

class Recorder {
  constructor() {
    this.steps = [];
  }
  record(id, ok, detail = '', started = Date.now()) {
    const step = { id, ok: ok === true, ms: Date.now() - started, detail: String(detail).slice(0, 2000) };
    this.steps.push(step);
    console.log(`${step.ok ? 'ok  ' : 'FAIL'} ${id}${step.detail.length > 0 ? `: ${step.detail.split('\n')[0]}` : ''}`);
    return step.ok;
  }
  get ok() {
    return this.steps.length > 0 && this.steps.every((step) => step.ok);
  }
}

function npm(args, options = {}) {
  const result = spawnSync(process.execPath, [npmCli(), ...args], {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeoutMs ?? 600000,
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
}

/** The installed `jevris` shim of a global prefix, per OS. */
export function shimPath(prefix, platform = process.platform) {
  return platform === 'win32' ? join(prefix, 'jevris.cmd') : join(prefix, 'bin', 'jevris');
}

export function installedPackageDir(prefix, platform = process.platform) {
  const base = platform === 'win32' ? join(prefix, 'node_modules') : join(prefix, 'lib', 'node_modules');
  return join(base, ...PACKAGE_NAME.split('/'));
}

async function runShim(shim, args, env) {
  const platformUrl = pathToFileURL(join(repoRoot, 'packages', 'platform', 'dist', 'index.js')).href;
  const { runSync } = await import(platformUrl);
  const result = runSync(shim, args, { env, spawnEnv: env, timeoutMs: 120000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, reason: result.reason };
}

function sandbox(work, name) {
  const home = join(work, name);
  mkdirSync(join(home, '.config'), { recursive: true });
  // The sandbox's own TMPDIR, inside the work dir that the smoke removes at the end; the harness
  // stubs live inside it, where the product's test tripwire accepts them.
  const temp = join(work, `${name}-t`);
  const stubs = writeHarnessStubs(join(temp, 'bin'));
  const env = testEnvironment(home, 'unused-real-home', stubs, temp);
  delete env.JEVRIS_HOME; // exercise the default home resolution from HOME / USERPROFILE
  env.npm_config_update_notifier = 'false';
  env.npm_config_fund = 'false';
  env.npm_config_audit = 'false';
  return { home, env };
}

function seed(home) {
  const seeded = [];
  for (const item of SEEDED_CONFIGS) {
    const file = join(home, ...item.rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, item.text);
    seeded.push({ ...item, file });
  }
  return seeded;
}

async function checkConfigsAndMcp(rec, prefix, home, env, { repo, forbidden, label }) {
  const started = Date.now();
  const runtimeDir = await runtimeDirFor(home, env);
  const files = configFiles(home, runtimeDir);
  const problems = [];
  const entries = new Set();
  const roots = new Set();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    problems.push(...configProblems(relative(home, file), text, { repo, forbidden }));
    for (const entry of referencedEntryPaths(text)) entries.add(entry);
    for (const path of absolutePaths(text)) if (underDir(path, runtimeDir) && existsSync(path) && statSync(path).isDirectory()) roots.add(path);
  }
  rec.record(`${label}:configs-clean`, problems.length === 0, problems.join('; ') || `${files.length} config files, ${entries.size} entry paths, ${roots.size} plugin roots`, started);
  const missing = [...entries].filter((entry) => !existsSync(entry));
  const servers = [...entries].filter((entry) => /mcp\.m?js$/.test(entry)).map((entry) => ({ command: process.execPath, args: [entry] }));
  for (const root of roots) {
    const found = pluginRootEntries(root);
    for (const script of found.scripts) if (!existsSync(script)) missing.push(script);
    for (const server of found.servers) servers.push({ command: server.command === 'node' ? process.execPath : server.command, args: server.args });
  }
  const t0 = Date.now();
  rec.record(`${label}:registered entries exist`, missing.length === 0, missing.length === 0 ? `${entries.size} direct entries, ${roots.size} plugin roots` : `missing: ${missing.map((item) => relative(home, item)).join(', ')}`, t0);
  const t1 = Date.now();
  rec.record(`${label}:mcp-registered`, servers.length > 0, servers.map((server) => server.args.map((arg) => relative(home, arg)).join(' ')).join(', '), t1);
  const seen = new Set();
  for (const server of servers) {
    const key = `${server.command} ${server.args.join(' ')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const t2 = Date.now();
    const shake = await mcpHandshake(server.command, server.args, env);
    rec.record(`${label}:mcp-handshake ${server.args.map((arg) => relative(home, arg)).join(' ')}`, shake.ok, shake.ok ? `${shake.tools.length} tools` : shake.detail, t2);
  }
  return [...entries, ...roots];
}

/**
 * Loads the on-demand modules the sidecar and the hook subscriber import through
 * `@jevris/cli/*` from an installed package directory (the global prefix, or the runtime copy
 * install made), by the chunk paths the bundle manifest records, and calls each loader
 * against the sandbox home. A module left out of the bundle fails here, not in a user's
 * sidecar.
 */
export const RUNTIME_MODULE_PROBE = `import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [dir, home] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(join(dir, 'dist', 'bundle-manifest.json'), 'utf8'));
const load = async (source) => {
  const found = (manifest.dynamicModules ?? []).find((item) => item.source === source);
  if (found === undefined) throw new Error(source + ' is not in the bundle manifest');
  return import(pathToFileURL(join(dir, found.path)).href);
};
const result = {};
const credential = await load('apps/cli/dist/credential.js');
result.credential = typeof credential.resolveProviderCredential === 'function' && typeof credential.openHostEntry === 'function';
const killSwitch = await load('apps/cli/dist/kill-switch.js');
result.killSwitch = (await killSwitch.readKillSwitchStopped(home)) === false;
const certifications = await load('apps/cli/dist/certification-store.js');
result.certifications = Array.isArray((await certifications.loadCertifications(home)).records);
process.stdout.write(JSON.stringify(result));
`;

function probeRuntimeModules(rec, label, dir, home, env, work) {
  const started = Date.now();
  const script = join(work, 'runtime-module-probe.mjs');
  writeFileSync(script, RUNTIME_MODULE_PROBE);
  const run = spawnSync(process.execPath, [script, dir, home], { cwd: work, env, encoding: 'utf8', shell: false, windowsHide: true, timeout: 60000 });
  let parsed = null;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    parsed = null;
  }
  const ok = run.status === 0 && parsed !== null && parsed.credential === true && parsed.killSwitch === true && parsed.certifications === true;
  return rec.record(`${label}: sidecar loads credential, kill-switch and certifications`, ok, ok ? relative(work, dir) || dir : `${run.status} ${run.stdout.trim().slice(0, 200)} ${run.stderr.trim().slice(-600)}`, started);
}

/** `<data>/runtime` for the sandbox home, per OS, from the shipped platform paths. */
async function runtimeDirFor(home, env) {
  const { ensurePrivateDir, jevrisPaths, writePrivateFile } = await import(pathToFileURL(join(repoRoot, 'packages', 'platform', 'dist', 'index.js')).href);
  return join(jevrisPaths({ home, env }).data, 'runtime');
}

async function quick(rec, tarball, work, options) {
  const prefix = join(work, 'prefix');
  const { home, env } = sandbox(work, 'home');
  let started = Date.now();
  const install = npm(['install', '-g', '--prefix', prefix, tarball, '--no-audit', '--no-fund', '--prefer-offline'], { env, cwd: work });
  if (!rec.record('npm-install-global', install.status === 0, install.status === 0 ? prefix : install.stderr.slice(-1500), started)) return;
  const pkgDir = installedPackageDir(prefix);
  const installedPkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  started = Date.now();
  const ls = npm(['ls', '-g', '--prefix', prefix, '--omit=dev', '--all', '--json'], { env, cwd: work });
  let lsOk = ls.status === 0;
  let lsDetail = '';
  try {
    const tree = JSON.parse(ls.stdout);
    const deps = tree.dependencies?.[PACKAGE_NAME]?.dependencies ?? {};
    // An absent optional peer shows as an empty entry; only installed packages count.
    const direct = Object.keys(deps).filter((name) => typeof deps[name]?.version === 'string').sort();
    const problems = Array.isArray(tree.problems) ? tree.problems : [];
    lsOk = lsOk && problems.length === 0 && JSON.stringify(direct) === JSON.stringify([...RUNTIME_EXTERNALS].sort());
    lsDetail = `direct: ${direct.join(', ')}${problems.length > 0 ? `; problems: ${problems.join('; ')}` : ''}`;
    const sdk = OPTIONAL_EXTERNALS.filter((name) => typeof deps[name]?.version === 'string');
    rec.record('optional Agent SDK not installed by default (PKG-07)', sdk.length === 0, sdk.join(', '));
  } catch (error) {
    lsOk = false;
    lsDetail = `npm ls output unreadable: ${error.message}`;
  }
  rec.record('npm-ls-omit-dev', lsOk, lsOk ? lsDetail : `${lsDetail} ${ls.stderr.slice(-800)}`, started);
  started = Date.now();
  const shipped = readdirSync(pkgDir);
  const leaked = shipped.filter((name) => ['apps', 'packages', 'src', 'test', 'fixtures', 'ssot_docs', '.planning'].includes(name));
  rec.record('installed-layout', leaked.length === 0, leaked.length === 0 ? shipped.sort().join(' ') : `ships ${leaked.join(', ')}`, started);
  started = Date.now();
  const installedBytes = treeBytes(prefix);
  rec.record('installed-size-budget', installedBytes <= SIZE_BUDGET.installedBytes, `${installedBytes} bytes (budget ${SIZE_BUDGET.installedBytes})`, started);
  const shim = shimPath(prefix);
  started = Date.now();
  const version = await runShim(shim, ['--version'], env);
  rec.record('jevris --version', version.status === 0 && version.stdout.includes(installedPkg.version), `${version.status} ${version.stdout.trim()} ${version.stderr.trim()}`.trim(), started);
  started = Date.now();
  const help = await runShim(shim, ['--help'], env);
  rec.record('jevris --help', help.status === 0 && /usage/i.test(help.stdout), `${help.status} ${help.stdout.split('\n')[0] ?? ''}`, started);
  probeRuntimeModules(rec, 'global package', pkgDir, home, env, work);
  if (options.full) {
    // Every public command, MCP tool and adapter hook fixture through the installed files,
    // against a real sidecar in a temporary home of its own (scripts/surface-e2e.mjs).
    const { surfaceE2E } = await import('./surface-e2e.mjs');
    const product = { bin: join(pkgDir, 'bin', 'jevris.mjs'), mcp: join(pkgDir, 'plugins', 'shared', 'mcp.js'), hook: join(pkgDir, 'dist', 'hook.mjs') };
    started = Date.now();
    const surface = await surfaceE2E(product, { env: { NODE_OPTIONS: env.NODE_OPTIONS ?? '', PATH: env.PATH ?? env.Path ?? process.env.PATH ?? '' } });
    for (const step of surface.steps) rec.record(`surface: ${step.name}`, step.ok, step.detail ?? '', started);
    rec.drills = await operationsDrills(rec, pkgDir, shim, work);
    await doctorProof(rec, shim, work);
  }
  const seeded = options.full ? seed(home) : [];
  started = Date.now();
  const doctor = await runShim(shim, ['doctor', '--home', home], env);
  rec.record('jevris doctor', doctor.status === 0, `${doctor.status} ${doctor.stdout.split('\n').slice(0, 2).join(' | ')} ${doctor.stderr.trim().slice(0, 300)}`, started);
  started = Date.now();
  const installed = await runShim(shim, ['install', '--home', home, '--yes'], env);
  rec.record('jevris install (all harnesses)', installed.status === 0, `${installed.status} ${installed.stdout.trim().slice(0, 300)} ${installed.stderr.trim().slice(0, 300)}`, started);
  let repo;
  let receipts;
  try {
    repo = realpathSync(repoRoot);
  } catch {
    repo = repoRoot;
  }
  if (options.full) {
    const entries = await checkConfigsAndMcp(rec, prefix, home, env, { repo, forbidden: [work.split(sep).join('/') + '/pkg'], label: 'global' });
    started = Date.now();
    receipts = receiptCheck(home);
    rec.record('install receipts match the files they list (ADM-06)', receipts.receipts > 0 && receipts.problems.length === 0, receipts.problems.join('; ') || `${receipts.receipts} receipts, ${receipts.listed.files.length} files, ${receipts.listed.dirs.length} folders, ${receipts.listed.edits.length} edited configs`, started);
    started = Date.now();
    const outsideHome = entries.filter((entry) => !entry.split('\\').join('/').toLowerCase().startsWith(home.split('\\').join('/').toLowerCase()));
    rec.record('configs point at the runtime copy (ADM-03)', entries.length > 0 && outsideHome.length === 0, outsideHome.join(', ') || 'all entry paths inside the Jevris runtime copy', started);
    probeRuntimeModules(rec, 'runtime copy', join(await runtimeDirFor(home, env), installedPkg.version), home, env, work);
    started = Date.now();
    const gates = await runShim(shim, ['gates', '--home', home, '--json'], env);
    let gatesOk = gates.status === 0 || gates.status === 1;
    // Every gate the evaluator judges, in its order: a literal count went stale when perf was added.
    const { GATES } = await import(pathToFileURL(join(repoRoot, 'apps', 'cli', 'dist', 'release-gates.js')).href);
    try {
      const report = JSON.parse(gates.stdout);
      gatesOk = gatesOk && Array.isArray(report.gates) && report.gates.map((gate) => gate?.gate).join(',') === GATES.join(',');
    } catch {
      gatesOk = false;
    }
    rec.record('jevris gates (report, exit 0 or 1)', gatesOk, `${gates.status} ${gates.stdout.trim().slice(0, 200)} ${gates.stderr.trim().slice(0, 200)}`, started);
    started = Date.now();
    const drill = await runShim(shim, ['kill-switch', 'drill', '--home', home], env);
    rec.record('jevris kill-switch drill', drill.status === 0, `${drill.status} ${drill.stdout.trim().slice(0, 300)} ${drill.stderr.trim().slice(0, 200)}`, started);
    for (const item of seeded) writeFileSync(item.file, applyUserEdit(readFileSync(item.file, 'utf8'), item.kind));
  }
  started = Date.now();
  const removed = await runShim(shim, ['uninstall', '--home', home, '--keep-data'], env);
  rec.record('jevris uninstall', removed.status === 0, `${removed.status} ${removed.stdout.trim().slice(0, 300)} ${removed.stderr.trim().slice(0, 300)}`, started);
  if (options.full) {
    started = Date.now();
    const drift = [];
    for (const item of seeded) {
      const expected = applyUserEdit(item.text, item.kind);
      const actual = existsSync(item.file) ? readFileSync(item.file, 'utf8') : '<deleted>';
      if (actual !== expected) drift.push(`${item.rel.join('/')}`);
    }
    rec.record('user configs byte-identical after uninstall (with a user edit)', drift.length === 0, drift.length === 0 ? `${seeded.length} files` : `changed: ${drift.join(', ')}`, started);
    started = Date.now();
    const left = receiptLeftovers(home, receipts);
    rec.record('uninstall removed every file and folder the receipts list', left.length === 0, left.join(', ') || `${(receipts?.listed.files.length ?? 0) + (receipts?.listed.dirs.length ?? 0)} paths gone`, started);
  }
  started = Date.now();
  const deleted = await runShim(shim, ['data', 'delete', '--home', home], env);
  rec.record('jevris data delete', deleted.status === 0, `${deleted.status} ${deleted.stdout.trim().slice(0, 300)} ${deleted.stderr.trim().slice(0, 300)}`, started);
  started = Date.now();
  const leftovers = walkFiles(home).filter((file) => /jevris/i.test(relative(home, file)));
  rec.record('no Jevris files left after data delete', leftovers.length === 0, leftovers.map((file) => relative(home, file)).slice(0, 10).join(', '), started);
}

/**
 * OBS-05: every operations drill against the installed package, each in a private home under
 * the smoke's work folder. Test mode stays on (the disk-full page limit and the local Jev stub
 * need it); the drills set their own home variables.
 */
async function operationsDrills(rec, pkgDir, shim, work) {
  const { DRILL_IDS, runDrill } = await import(pathToFileURL(join(repoRoot, 'apps', 'sidecar', 'scripts', 'ops-drills.mjs')).href);
  const { home, env } = sandbox(work, 'drills-home');
  const results = {};
  for (const id of DRILL_IDS) {
    const started = Date.now();
    results[id] = await runDrill(id, { packageDir: pkgDir, home, env, bin: shim });
    rec.record(`operations drill: ${id} (OBS-05)`, results[id].passed, results[id].detail, started);
  }
  return results;
}

/**
 * RLS-04, "doctor proves it works": in a sandbox home of its own, with certifiable harness
 * stand-ins first on PATH (apps/cli/test/harness-cli-stubs.mjs, inside the sandbox TMPDIR the
 * test tripwire allows) and JEVRIS_LIVE_HARNESS=1, the installed product installs into all five
 * harnesses, certifies each, and `doctor --json` must then read full / certified / passed with
 * no action or broken line and no loose private file (scripts/doctor-proof.mjs names each miss).
 */
async function doctorProof(rec, shim, work) {
  const { home, env } = sandbox(work, 'proof-home');
  const { writeCertifiableHarnessStubs } = await import(pathToFileURL(join(repoRoot, 'apps', 'cli', 'test', 'harness-cli-stubs.mjs')).href);
  const { doctorProofProblems, standInOnlyAction } = await import('./doctor-proof.mjs');
  const { ensurePrivateDir, jevrisPaths, writePrivateFile } = await import(pathToFileURL(join(repoRoot, 'packages', 'platform', 'dist', 'index.js')).href);
  const stand = await writeCertifiableHarnessStubs(join(env.TMPDIR, 'harness-bin'));
  const pathKey = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  const proofEnv = { ...env, [pathKey]: `${stand}${delimiter}${env[pathKey] ?? ''}`, JEVRIS_LIVE_HARNESS: '1' };
  let started = Date.now();
  const installed = await runShim(shim, ['install', '--home', home, '--yes'], proofEnv);
  if (!rec.record('doctor proof: install into the five stand-in harnesses', installed.status === 0, `${installed.status} ${installed.stderr.trim().slice(0, 300)}`, started)) return;
  // Kilo and OpenCode report no auth mode of their own; a user states it once (docs/harnesses).
  const config = jevrisPaths({ home, env: proofEnv }).config;
  // Owner-only, as a user following the guide would keep it (doctor flags anything looser): mode
  // 0700 and 0600 on POSIX, an owner-only ACL on Windows, where a plain mkdir and write leave
  // SYSTEM and Administrators on both.
  const privateConfig = await ensurePrivateDir(config, { repair: true });
  const workers = await writePrivateFile(join(config, 'workers.json'), `${JSON.stringify({ schemaVersion: 'jevris-workers-1', auth: { kilo: 'subscription', opencode: 'subscription' } })}\n`);
  if (!privateConfig.ok || !workers.ok) {
    rec.record('doctor proof: workers.json written owner-only', false, `${JSON.stringify(privateConfig)} ${JSON.stringify(workers)}`, started);
    return;
  }
  started = Date.now();
  const certified = await runShim(shim, ['certify', '--harness', 'all', '--home', home, '--json'], proofEnv);
  let certDetail = `${certified.status} ${certified.stderr.trim().slice(0, 300)}`;
  try {
    certDetail = JSON.parse(certified.stdout).results.map((item) => `${item.harness} ${item.ok ? 'ok' : `failed ${(item.features ?? []).filter((f) => !f.passed).map((f) => f.id ?? f.feature).join(',')}`}`).join('; ');
  } catch {
    // keep the raw status
  }
  rec.record('doctor proof: certify --harness all', certified.status === 0, certDetail, started);
  started = Date.now();
  const sidecar = await runShim(shim, ['sidecar', 'start', '--home', home], proofEnv);
  rec.record('doctor proof: sidecar start', sidecar.status === 0, `${sidecar.status} ${sidecar.stderr.trim().slice(0, 200)}`, started);
  try {
    started = Date.now();
    // The user who followed install's line and opened a new terminal: the launcher folder is on
    // PATH, first, so the proof never depends on a jevris the host's own PATH happens to hold.
    const { launcherDir } = await import(pathToFileURL(join(repoRoot, 'apps', 'cli', 'dist', 'command-launcher.js')).href);
    const launcher = launcherDir({ platform: process.platform, home, dataRoot: jevrisPaths({ home, env: proofEnv }).data });
    const doctorEnv = { ...proofEnv, [pathKey]: `${launcher}${delimiter}${proofEnv[pathKey]}` };
    const doctor = await runShim(shim, ['doctor', '--home', home, '--json'], doctorEnv);
    let json = null;
    try {
      json = JSON.parse(doctor.stdout);
    } catch {
      json = null;
    }
    const problems = doctorProofProblems(json);
    // Named in the pass line, so the stand-in limit (scripts/doctor-proof.mjs) is never silent.
    const standIn = (Array.isArray(json?.lines) ? json.lines : []).filter((line) => line?.severity === 'action' && standInOnlyAction(String(line.text ?? ''))).map((line) => String(line.text).split(':')[0].replace(/^harness /, ''));
    const limit = standIn.length === 0 ? '' : `; stub-turn features left to the live certify run on ${standIn.join(', ')}`;
    rec.record('doctor proof: doctor --json reads full, certified and passed, with nothing to fix (RLS-04)', problems.length === 0, problems.length === 0 ? `summary full/certified/passed; every installed harness certified; no action or broken line; no loose private file${limit}` : problems.slice(0, 12).join(' | '), started);
  } finally {
    await runShim(shim, ['sidecar', 'stop', '--home', home], proofEnv);
  }
}

async function npxScenario(rec, tarball, work) {
  const cache = join(work, 'npx-cache');
  const { home, env } = sandbox(work, 'npx-home');
  const npxEnv = { ...env, npm_config_cache: cache };
  let started = Date.now();
  const run = npm(['exec', '--yes', '--cache', cache, '--package', tarball, '--', 'jevris', 'install', '--home', home, '--yes'], { env: npxEnv, cwd: work });
  rec.record('npx: jevris install', run.status === 0, `${run.status} ${run.stdout.trim().slice(0, 200)} ${run.stderr.trim().slice(-400)}`, started);
  started = Date.now();
  const cleaned = npm(['cache', 'clean', '--force', '--cache', cache], { env: npxEnv, cwd: work });
  rmSync(join(cache, '_npx'), { recursive: true, force: true, maxRetries: 3 });
  rec.record('npx: npm cache clean --force (private cache)', cleaned.status === 0, cleaned.stderr.trim().slice(0, 200), started);
  await checkConfigsAndMcp(rec, undefined, home, env, { repo: realpathSync(repoRoot), forbidden: [cache.split(sep).join('/')], label: 'npx' });
}

export async function packTarball(work) {
  const packed = npm(['pack', '--ignore-scripts', '--json', '--pack-destination', work], { cwd: repoRoot });
  if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr}`);
  const parsed = JSON.parse(packed.stdout);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  return join(work, entry.filename);
}

async function main(argv) {
  const options = parseArgs(argv);
  const rec = new Recorder();
  const work = mkdtempSync(join(tmpdir(), 'jevris-smoke-'));
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  try {
    if (options.build) {
      const started = Date.now();
      if (!rec.record('build', runNode([join(repoRoot, 'scripts', 'build.mjs')]) === 0, '', started)) return await finish(rec, options, pkg);
    }
    let started = Date.now();
    let tarball = options.tarball;
    if (tarball === undefined) {
      mkdirSync(join(work, 'pkg'), { recursive: true });
      tarball = await packTarball(join(work, 'pkg'));
    }
    rec.record('pack', existsSync(tarball), `${tarball} ${existsSync(tarball) ? statSync(tarball).size : 0} bytes sha256 ${existsSync(tarball) ? sha256(readFileSync(tarball)) : ''}`, started);
    await quick(rec, tarball, work, options);
    if (options.npx) await npxScenario(rec, tarball, work);
  } catch (error) {
    rec.record('smoke', false, error instanceof Error ? error.stack ?? error.message : String(error));
  } finally {
    if (!options.keep) {
      // A process that still runs from the installed package (a sidecar a step did not stop)
      // holds its native addon on Windows: a step fails naming it, instead of the smoke crashing.
      try {
        removeTree(work);
      } catch (error) {
        rec.record('work folder removed (no process left running from it)', false, error instanceof Error ? error.message : String(error));
      }
    } else console.log(`kept ${work}`);
  }
  return finish(rec, options, pkg);
}

/** The fields every record from this run shares: id, time, version, commit, run, OS, arch, node. */
function evidenceMeta(kind, report, pkg, env) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', shell: false, windowsHide: true });
  const fromGit = head.status === 0 ? head.stdout.trim() : '';
  const commit = /^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? '') ? env.GITHUB_SHA : /^[0-9a-f]{40}$/.test(fromGit) ? fromGit : null;
  return {
    kind,
    id: `${kind}-${report.platform}-${report.arch}-${report.node.replace(/[^0-9A-Za-z.-]/g, '')}`,
    producedAt: report.at,
    version: pkg.version,
    commit,
    tool: 'pack-smoke',
    run: typeof env.GITHUB_RUN_ID === 'string' && env.GITHUB_RUN_ID.length > 0 ? `github-actions:${env.GITHUB_RUN_ID}` : null,
    os: ['darwin', 'linux', 'win32'].includes(report.platform) ? report.platform : null,
    arch: /^[A-Za-z0-9._-]+$/.test(report.arch) ? report.arch : null,
    node: report.node,
  };
}

async function contractsModule() {
  return import(pathToFileURL(join(repoRoot, 'packages', 'contracts', 'dist', 'index.js')).href);
}

/** The drills as a validated `operations-drills` record against the installed tarball (OBS-05). */
export async function drillsEvidence(report, drills, pkg, env = process.env) {
  const { releaseEvidence, ReleaseEvidenceContract } = await contractsModule();
  const { operationsPayload } = await import(pathToFileURL(join(repoRoot, 'apps', 'sidecar', 'scripts', 'ops-drills.mjs')).href);
  const os = ['darwin', 'linux', 'win32'].includes(report.platform) ? report.platform : process.platform;
  const record = releaseEvidence({ ...evidenceMeta('operations-drills', report, pkg, env), payload: operationsPayload(drills, { os, ranAgainst: 'installed-tarball' }) });
  const checked = ReleaseEvidenceContract.validate(record);
  if (!checked.ok) throw new Error(`the operations-drills record does not match its contract: ${JSON.stringify(checked).slice(0, 400)}`);
  return record;
}

/** The run as a ReleaseEvidence `installed-e2e` record for `jevris gates` (RLS-04, RLS-10). */
export async function installedEvidence(report, pkg, env = process.env) {
  const { releaseEvidence } = await contractsModule();
  return releaseEvidence({
    ...evidenceMeta('installed-e2e', report, pkg, env),
    payload: {
      ok: report.ok,
      full: report.modes.full,
      npx: report.modes.npx,
      steps: report.steps.map((step) => ({ id: step.id.slice(0, 200), ok: step.ok })),
    },
  });
}

async function finish(rec, options, pkg) {
  const report = {
    schemaVersion: 1,
    kind: options.full ? 'installed-e2e' : 'pack-smoke',
    package: `${pkg.name}@${pkg.version}`,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    at: new Date().toISOString(),
    modes: { full: options.full, npx: options.npx },
    ok: rec.ok,
    steps: rec.steps,
  };
  if (options.report !== undefined) {
    mkdirSync(dirname(options.report), { recursive: true });
    writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (options.evidence !== undefined) {
    mkdirSync(dirname(options.evidence), { recursive: true });
    writeFileSync(options.evidence, `${JSON.stringify(await installedEvidence(report, pkg), null, 2)}\n`);
  }
  if (options.drillsEvidence !== undefined) {
    // No record when the drills never ran (an earlier step failed): a missing record fails the
    // operations gate honestly, where a record of eight unrun drills would only look like one.
    if (rec.drills === undefined) console.log('no operations-drills record: the drills did not run');
    else {
      mkdirSync(dirname(options.drillsEvidence), { recursive: true });
      writeFileSync(options.drillsEvidence, `${JSON.stringify(await drillsEvidence(report, rec.drills, pkg), null, 2)}\n`);
    }
  }
  const failed = rec.steps.filter((step) => !step.ok).length;
  console.log(`pack smoke: ${rec.steps.length - failed}/${rec.steps.length} steps passed on ${process.platform} ${process.version}`);
  return rec.ok ? 0 : 1;
}

if (isMain(import.meta.url)) process.exit(await main(process.argv.slice(2)));

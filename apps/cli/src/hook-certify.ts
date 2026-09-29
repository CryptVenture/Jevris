import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageRoot } from '@jevris/platform';
import { classifyEnvironment, detectInContainer } from './platform.js';
import { scanHooks } from './hook-scan.js';
import { launchTree } from './live-harness.js';

/**
 * Live hook probe. Spawns `claude` from PATH with shell false, through live-harness.ts:
 * refused under tests unless a binary path is injected, and killed as a whole tree.
 * The product manifest uses ${CLAUDE_PLUGIN_ROOT} and does not record a
 * machine path. A fabricated pass is not an input. There is no exported writer.
 */

declare function setTimeout(callback: () => void, ms: number): number;
declare function clearTimeout(handle: number): void;

const DEFAULT_BINARY = 'claude';
const HOOK_COMMAND = 'node';
const HOOK_ARG = '${CLAUDE_PLUGIN_ROOT}/bin/hook.js';
const DELIVERY_MS = 15000;
const MISS_MS = 2000;
const OBSERVER = [
  "'use strict';",
  'const fs = require("node:fs");',
  'const marker = process.env.JEVRIS_PROBE_MARKER;',
  'if (typeof marker === "string" && marker.length > 0) {',
  '  try { fs.appendFileSync(marker, JSON.stringify({ execPath: process.execPath, argv: process.argv }) + "\\n"); } catch (error) {}',
  '}',
  '',
].join('\n');

export interface HookProcessProbe {
  readonly eventProbe: 'did-not-pass' | 'passed';
  readonly shell: false;
  readonly binary: string;
  readonly spawned: boolean;
  readonly args: readonly string[];
  readonly cwd: string | null;
  readonly stdout: string;
}

export interface ProbeHookProcessInput {
  readonly binaryPath?: string;
  readonly skipped?: boolean;
  readonly result?: unknown;
  readonly platform?: string;
  readonly nodeVersion?: string;
  readonly env?: { readonly [key: string]: string | undefined };
  readonly inContainer?: boolean;
}

interface ProbePaths {
  readonly node: string;
  readonly bin: string;
}

interface TempProbe {
  readonly root: string;
  readonly cwd: string;
  readonly pluginDir: string;
  readonly marker: string;
  readonly observer: string;
}

interface Delivery {
  readonly spawned: boolean;
  readonly started: boolean;
  readonly args: readonly string[];
  readonly stdout: string;
  readonly events: readonly string[];
}

function repoRoot(): string {
  // fileURLToPath-based package root: a drive-letter path on Windows, never /C:/ (BLD-03).
  return packageRoot();
}

function productHooksPath(): string {
  return join(repoRoot(), 'plugins', 'claude', 'hooks', 'hooks.json');
}

function productPluginPath(): string {
  return join(repoRoot(), 'plugins', 'claude', '.claude-plugin', 'plugin.json');
}

function didNotPass(
  binary: string,
  spawned: boolean,
  args: readonly string[],
  cwd: string | null,
  stdout: string,
): HookProcessProbe {
  return {
    eventProbe: 'did-not-pass',
    shell: false,
    binary,
    spawned,
    args,
    cwd,
    stdout,
  };
}

/** The host class; without an injected flag, "in a container" comes from the IPC-19 detector. */
async function hostClass(input: ProbeHookProcessInput): Promise<'local' | 'reduced' | 'unsupported'> {
  const base = {
    platform: input.platform ?? process.platform,
    nodeVersion: input.nodeVersion ?? process.version,
    env: input.env ?? process.env,
  };
  const inContainer = input.inContainer ?? (await detectInContainer({ platform: base.platform, env: base.env }));
  return classifyEnvironment({ ...base, inContainer });
}

function stringEnv(extra: { readonly [key: string]: string }): { readonly [key: string]: string } {
  const env: { [key: string]: string } = {};
  for (const key of Object.keys(process.env)) {
    const value = process.env[key];
    if (typeof value === 'string') env[key] = value;
  }
  for (const key of Object.keys(extra)) {
    const value = extra[key];
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

async function resolveProbePaths(): Promise<ProbePaths | null> {
  try {
    const node = await realpathFile(process.execPath);
    const bin = await realpathFile(join(repoRoot(), 'apps', 'hook', 'dist', 'bin.js'));
    if (node === null || bin === null) return null;
    if (node.includes('npx') || bin.includes('npx')) return null;
    return { node, bin };
  } catch {
    return null;
  }
}

async function realpathFile(path: string): Promise<string | null> {
  const { realpath } = await import('node:fs/promises');
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

async function createTempProbe(): Promise<TempProbe | null> {
  const root = join(tmpdir(), `jevris-hook-probe-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`);
  const cwd = join(root, 'empty');
  const pluginDir = join(root, 'plugin');
  const marker = join(root, 'marker');
  const observer = join(root, 'observe.cjs');
  try {
    await mkdir(cwd, { recursive: true });
    await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true });
    await mkdir(join(pluginDir, 'hooks'), { recursive: true });
    await writeFile(observer, OBSERVER);
    return { root, cwd, pluginDir, marker, observer };
  } catch {
    try {
      await rm(root, { recursive: true, force: true });
    } catch {
      // The temp tree is not the product manifest.
    }
    return null;
  }
}

function deliveryArgs(pluginDir: string): readonly string[] {
  // Every flag is printed by `claude --help`. --verbose is required: the
  // installed binary rejects --print with --output-format=stream-json without it.
  return [
    '--plugin-dir',
    pluginDir,
    '--print',
    '--verbose',
    '--output-format',
    'stream-json',
    '--include-hook-events',
    '--permission-prompts',
    'none',
    '--max-budget-usd',
    '0.01',
    'ping',
  ];
}

async function writeTempPlugin(temp: TempProbe, paths: ProbePaths): Promise<boolean> {
  const hooks = {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: paths.node,
              args: [paths.bin],
              timeout: 5,
            },
          ],
        },
      ],
    },
  };
  const plugin = {
    name: 'jevris',
    description: 'Temporary probe plugin. Not the product manifest.',
    defaultEnabled: true,
  };
  try {
    await writeFile(join(temp.pluginDir, 'hooks', 'hooks.json'), `${JSON.stringify(hooks)}\n`);
    await writeFile(join(temp.pluginDir, '.claude-plugin', 'plugin.json'), `${JSON.stringify(plugin)}\n`);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function markerShowsHook(marker: string, node: string, bin: string): Promise<boolean> {
  let text = '';
  try {
    text = await readFile(marker, 'utf8');
  } catch {
    return false;
  }
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const record = parsed as { readonly execPath?: unknown; readonly argv?: unknown };
    if (record.execPath !== node) continue;
    if (!Array.isArray(record.argv)) continue;
    if (record.argv[0] === node && record.argv[1] === bin) return true;
  }
  return false;
}

async function waitForHook(
  marker: string,
  node: string,
  bin: string,
  aborted: { value: boolean },
): Promise<boolean> {
  const steps = DELIVERY_MS / 50;
  for (let i = 0; i < steps; i += 1) {
    if (aborted.value) return markerShowsHook(marker, node, bin);
    if (await markerShowsHook(marker, node, bin)) return true;
    await delay(50);
  }
  return false;
}

async function deliver(binary: string, temp: TempProbe, paths: ProbePaths): Promise<Delivery> {
  const args = deliveryArgs(temp.pluginDir);
  const env = stringEnv({
    JEVRIS_PROBE_MARKER: temp.marker,
    NODE_OPTIONS: `--require ${temp.observer}`,
  });
  const launched = launchTree(binary, args, { cwd: temp.cwd, env });
  const aborted = { value: false };
  const timer = setTimeout(() => {
    aborted.value = true;
    launched.kill();
  }, DELIVERY_MS);
  void launched.done.then(() => {
    aborted.value = true;
  });
  const started = await Promise.race([
    waitForHook(temp.marker, paths.node, paths.bin, aborted),
    launched.done.then(() => markerShowsHook(temp.marker, paths.node, paths.bin)),
  ]);
  if (started) launched.kill();
  const { spawned } = await launched.done;
  clearTimeout(timer);
  const confirmed = started || (await markerShowsHook(temp.marker, paths.node, paths.bin));
  if (!confirmed) {
    return { spawned, started: false, args, stdout: '', events: [] };
  }
  return { spawned: true, started: true, args, stdout: '', events: ['SessionStart'] };
}

function missEnv(): { readonly [key: string]: string } {
  const env: { [key: string]: string } = { ...stringEnv({
    JEVRIS_HOOK_STARTED_AT_MS: '0',
    JEVRIS_HOOK_NOW_MS: '1000',
  }) };
  delete env.NODE_OPTIONS;
  return env;
}

async function runMiss(node: string, bin: string): Promise<{ readonly code: number; readonly stdout: string }> {
  const launched = launchTree(node, [bin], { env: missEnv(), captureStdout: true });
  const timer = setTimeout(() => {
    launched.kill();
  }, MISS_MS);
  const exit = await launched.done;
  clearTimeout(timer);
  const stdout = await launched.stdout;
  return { code: exit.spawned ? (exit.code ?? 1) : 1, stdout };
}

function manifestDocument(_paths: ProbePaths, events: readonly string[]): string {
  const groups: { [key: string]: unknown } = {};
  for (const event of events) {
    if (event === 'Stop' || event.length === 0) continue;
    groups[event] = [
      {
        hooks: [
          {
            type: 'command',
            command: HOOK_COMMAND,
            args: [HOOK_ARG],
            timeout: 5,
          },
        ],
      },
    ];
  }
  return `${JSON.stringify({ hooks: groups }, null, 2)}\n`;
}

async function removeProductFiles(): Promise<void> {
  try {
    await rm(productHooksPath(), { force: true });
  } catch {
    // Absence is the failed-probe result.
  }
  try {
    await rm(productPluginPath(), { force: true });
  } catch {
    // Absence is the failed-probe result.
  }
}

async function writeObservedManifest(paths: ProbePaths, events: readonly string[]): Promise<boolean> {
  const registered = events.filter((event) => event !== 'Stop' && event.length > 0);
  if (registered.length === 0) return false;
  const hooksPath = productHooksPath();
  const pluginPath = productPluginPath();
  try {
    await mkdir(join(repoRoot(), 'plugins', 'claude', 'hooks'), { recursive: true });
    await mkdir(join(repoRoot(), 'plugins', 'claude', '.claude-plugin'), { recursive: true });
    await writeFile(hooksPath, manifestDocument(paths, registered));
    await writeFile(
      pluginPath,
      `${JSON.stringify({
        name: 'jevris',
        description: 'Installed is not enforced.',
        defaultEnabled: false,
      })}\n`,
    );
    const scanned = await scanHooks(join(repoRoot(), 'plugins', 'claude'));
    if (!scanned.accepted) {
      await removeProductFiles();
      return false;
    }
    return true;
  } catch {
    await removeProductFiles();
    return false;
  }
}

export async function probeHookProcess(input: ProbeHookProcessInput = {}): Promise<HookProcessProbe> {
  const binary = input.binaryPath ?? DEFAULT_BINARY;
  if (input.skipped === true || (await hostClass(input)) !== 'local') {
    return didNotPass(binary, false, [], null, '');
  }
  const paths = await resolveProbePaths();
  if (paths === null) return didNotPass(binary, false, [], null, '');
  const temp = await createTempProbe();
  if (temp === null) return didNotPass(binary, false, [], null, '');
  try {
    const wrotePlugin = await writeTempPlugin(temp, paths);
    if (!wrotePlugin) return didNotPass(binary, false, [], temp.cwd, '');
    const delivery = await deliver(binary, temp, paths);
    if (!delivery.started) {
      return didNotPass(binary, delivery.spawned, delivery.args, temp.cwd, delivery.stdout);
    }
    const missed = await runMiss(paths.node, paths.bin);
    if (missed.code !== 0 || missed.stdout !== '') {
      return didNotPass(binary, delivery.spawned, delivery.args, temp.cwd, delivery.stdout);
    }
    const wrote = await writeObservedManifest(paths, delivery.events);
    if (!wrote) return didNotPass(binary, delivery.spawned, delivery.args, temp.cwd, delivery.stdout);
    return {
      eventProbe: 'passed',
      shell: false,
      binary,
      spawned: true,
      args: delivery.args,
      cwd: temp.cwd,
      stdout: delivery.stdout,
    };
  } finally {
    try {
      await rm(temp.root, { recursive: true, force: true });
    } catch {
      // A leftover temp directory is not the product manifest.
    }
  }
}

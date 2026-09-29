/// <reference path="../types/installer.d.ts" />
import { FIXTURES as CLAUDE_FIXTURES, normalize as claudeNormalize } from '@jevris/adapter-claude-code';
import { FIXTURES as CODEX_FIXTURES } from '@jevris/adapter-codex';
import { FIXTURES as KILO_FIXTURES } from '@jevris/adapter-kilocode';
import { FIXTURES as OPENCODE_FIXTURES } from '@jevris/adapter-opencode';
import { FIXTURES as AGY_FIXTURES } from '@jevris/adapter-antigravity';
import { runtimeEntry, type RuntimeManifest } from './runtime-install.js';
import { killTree, spawnPiped } from './live-harness.js';

type PipedChildProcess = NonNullable<ReturnType<typeof spawnPiped>>;

/**
 * Post-install smoke (ADM-04, SSOT §11.3 "run safe fixtures, then enable observe mode").
 *
 * Through the installed command lines, never through library calls:
 * - MCP: `node <runtime mcp>` answers initialize and tools/list, and lists jevris_status.
 * - Hooks: one recorded, non-destructive fixture per harness goes through
 *   `node <runtime hook> --harness <name>` and must exit 0 with empty stdout or exactly one
 *   JSON object. Observe mode prints no permission decision.
 * Children run with shell false, a bounded time and bounded output, and are killed on timeout.
 */

declare function setTimeout(callback: () => void, ms: number): number;
declare function clearTimeout(handle: number): void;

export interface SmokeResult {
  readonly harness: string;
  readonly check: 'mcp' | 'hook';
  readonly ok: boolean;
  readonly detail: string;
}

export interface SmokeInput {
  readonly runtimeDir: string;
  readonly manifest: RuntimeManifest;
  readonly harnesses: readonly string[];
  readonly home: string;
  readonly node?: string;
  readonly timeoutMs?: number;
}

const OUTPUT_CAP = 262144;
const FORBIDDEN = /permissionDecision|"decision"\s*:\s*"(?:allow|deny|ask|block|approve)"|"continue"\s*:\s*false/;

export interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly error: string | null;
}

/**
 * The smoke child environment. JEVRIS_HOOK_OBSERVE_ONLY keeps the hook launcher from starting
 * a sidecar during install; `extra` lets the certify runner replace that.
 */
export function childEnv(home: string, extra: { readonly [key: string]: string | undefined } = {}): { [key: string]: string } {
  const env: { [key: string]: string } = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string') env[key] = value;
  env.HOME = home;
  env.USERPROFILE = home;
  env.JEVRIS_HOME = home;
  env.JEVRIS_SMOKE = '1';
  env.JEVRIS_HOOK_OBSERVE_ONLY = '1';
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function text(chunk: Uint8Array | string): string {
  if (typeof chunk === 'string') return chunk;
  const Ctor = (globalThis as unknown as { TextDecoder?: new () => { decode(input?: Uint8Array): string } }).TextDecoder;
  return Ctor === undefined ? '' : new Ctor().decode(chunk);
}

/** Runs `node <args>` with stdin, bounded in time and output. Never throws. */
export function runNode(node: string, args: readonly string[], stdin: string, env: { readonly [key: string]: string }, timeoutMs: number): Promise<Ran> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    let timedOut = false;
    const started = spawnPiped(node, args, env);
    if (started === null) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, error: 'spawn refused or failed' });
      return;
    }
    const child: PipedChildProcess = started;
    const finish = (code: number | null, error: string | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, error });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      finish(null, 'timeout');
    }, timeoutMs);
    child.on('error', (error) => finish(null, String(error.message).slice(0, 200)));
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < OUTPUT_CAP) stdout += text(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += text(chunk);
    });
    child.on('close', (code) => finish(code, null));
    child.stdin?.on('error', () => {});
    child.stdin?.end(stdin);
  });
}

/** One MCP stdio session: initialize, initialized, tools/list. Resolves with the tool names. */
export function mcpSession(node: string, script: string, home: string, timeoutMs: number): Promise<{ ok: boolean; tools: string[]; detail: string }> {
  return new Promise((resolve) => {
    let buffer = '';
    let done = false;
    const started = spawnPiped(node, [script], childEnv(home));
    if (started === null) {
      resolve({ ok: false, tools: [], detail: 'spawn refused or failed' });
      return;
    }
    const child: PipedChildProcess = started;
    const finish = (result: { ok: boolean; tools: string[]; detail: string }): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killTree(child.pid);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, tools: [], detail: 'no answer in time' }), timeoutMs);
    const send = (message: unknown): void => {
      child.stdin?.write(`${JSON.stringify(message)}\n`);
    };
    child.on('error', (error) => finish({ ok: false, tools: [], detail: `spawn: ${String(error.message).slice(0, 120)}` }));
    child.on('close', (code) => finish({ ok: false, tools: [], detail: `exited ${String(code)} before tools/list` }));
    child.stdin?.on('error', () => {});
    child.stdout?.on('data', (chunk) => {
      buffer += text(chunk);
      if (buffer.length > OUTPUT_CAP) finish({ ok: false, tools: [], detail: 'output over cap' });
      let at: number;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (line.length === 0) continue;
        let message: { id?: unknown; result?: { tools?: Array<{ name?: unknown }> }; error?: unknown };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue;
        }
        if (message.id === 1) {
          if (message.error !== undefined) {
            finish({ ok: false, tools: [], detail: 'initialize returned an error' });
            return;
          }
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (message.id === 2) {
          const tools = (message.result?.tools ?? []).map((tool) => (typeof tool.name === 'string' ? tool.name : '')).filter((name) => name.length > 0);
          finish({ ok: tools.includes('jevris_status'), tools, detail: tools.includes('jevris_status') ? `${tools.length} tools` : 'jevris_status missing from tools/list' });
        }
      }
    });
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'jevris-install-smoke', version: '1' } },
    });
  });
}

interface HookCase {
  readonly harness: string;
  readonly launcher: string;
  readonly args: readonly string[];
  readonly native: unknown;
}

function fixture(list: ReadonlyArray<{ readonly id: string; readonly native: unknown }>, id: string): unknown {
  return list.find((item) => item.id === id)?.native ?? null;
}

function hookCases(harnesses: readonly string[]): HookCase[] {
  const cases: HookCase[] = [];
  for (const harness of harnesses) {
    if (harness === 'claude') cases.push({ harness, launcher: 'claude', args: [], native: fixture(CLAUDE_FIXTURES, 'claude.session-start') });
    if (harness === 'codex') cases.push({ harness, launcher: 'codex', args: [], native: fixture(CODEX_FIXTURES, 'codex.session-start') });
    if (harness === 'kilocode') cases.push({ harness, launcher: 'kilo', args: [], native: KILO_FIXTURES.find((item) => item.kind !== null)?.native ?? null });
    if (harness === 'opencode') cases.push({ harness, launcher: 'opencode', args: [], native: OPENCODE_FIXTURES.find((item) => item.kind !== null)?.native ?? null });
    if (harness === 'antigravity') cases.push({ harness, launcher: 'agy', args: ['--event', 'PostToolUse'], native: fixture(AGY_FIXTURES, 'antigravity.post-tool') });
  }
  return cases;
}

/** Empty, or exactly one JSON object with no permission decision. */
export function validHookOutput(stdout: string): boolean {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return true;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && !FORBIDDEN.test(trimmed);
  } catch {
    return false;
  }
}

export async function runInstallSmoke(input: SmokeInput): Promise<SmokeResult[]> {
  const node = input.node ?? process.execPath;
  const timeoutMs = input.timeoutMs ?? 20000;
  const results: SmokeResult[] = [];
  // Every harness, Claude included, registers the one runtime MCP server.
  const script = runtimeEntry(input.runtimeDir, input.manifest, 'mcp');
  if (script === null) results.push({ harness: 'all', check: 'mcp', ok: false, detail: 'no mcp entry' });
  else {
    const session = await mcpSession(node, script, input.home, timeoutMs);
    results.push({ harness: 'all', check: 'mcp', ok: session.ok, detail: session.detail });
  }
  const hook = runtimeEntry(input.runtimeDir, input.manifest, 'hook');
  for (const item of hookCases(input.harnesses)) {
    if (hook === null || item.native === null) {
      results.push({ harness: item.harness, check: 'hook', ok: false, detail: 'no hook entry or fixture' });
      continue;
    }
    if (item.harness === 'claude' && !claudeNormalize(item.native).ok) {
      results.push({ harness: item.harness, check: 'hook', ok: false, detail: 'fixture does not normalize' });
      continue;
    }
    const ran = await runNode(node, [hook, '--harness', item.launcher, ...item.args], JSON.stringify(item.native), childEnv(input.home), Math.min(timeoutMs, 10000));
    const ok = ran.error === null && ran.code === 0 && validHookOutput(ran.stdout);
    const detail = ran.error ?? (ran.code !== 0 ? `exit ${String(ran.code)}` : ok ? 'observe (no decision)' : 'output is not one JSON object or carries a decision');
    results.push({ harness: item.harness, check: 'hook', ok, detail });
  }
  return results;
}

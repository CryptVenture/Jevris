/**
 * The Jevris MCP server (§6.4, TOOL-01..10). A dependency-free stdio JSON-RPC server: it
 * imports node builtins only, and `scripts/emit-hook.mjs` bundles it into the single file
 * `plugins/shared/mcp.js` with the output schemas embedded from the shared contracts.
 *
 * Every tool runs `node <jevris bin> __surface <op>` with the arguments as JSON on stdin, so a
 * tool result is exactly the CLI result: `structuredContent` is the validated result object and
 * the text block is its JSON. Refusals, timeouts and spawn failures set `isError` with a
 * message that says what to do. The home comes from the host environment (JEVRIS_HOME), never
 * from a model argument; the workspace comes from CLAUDE_PROJECT_DIR, the client's roots or the
 * working directory.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { TOOLS, annotationsFor, type JsonSchema, type ToolSpec } from './tools.js';

export { TOOLS } from './tools.js';
export type { ToolSpec } from './tools.js';

/** Newest first. An unknown requested version is answered with the newest one. */
export const SUPPORTED_PROTOCOLS: readonly string[] = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const MESSAGE_CAP = 1_048_576;
export const CALL_TIMEOUT_MS = 20_000;
const OUTPUT_CAP = 1_048_576;
const INSTRUCTIONS =
  'Jevris tools give advice and local records for this workspace. They never switch a model, never change permissions, ' +
  'never mark a check passed and never delete anything. Settings and installs change only from the jevris CLI.';

/** Report resources the server serves, by approved id (TOOL-03). */
export const REPORTS: readonly { readonly id: string; readonly op: string; readonly title: string }[] = [
  { id: 'status', op: 'status', title: 'Jevris status report' },
  { id: 'configuration', op: 'configure', title: 'Effective Jevris settings' },
];

export type Env = { readonly [key: string]: string | undefined };

export type SurfaceCall =
  | { readonly kind: 'result'; readonly result: { readonly [key: string]: unknown } }
  | { readonly kind: 'refused'; readonly code: string; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string };

export interface ServerOptions {
  readonly env: Env;
  readonly cwd: () => string;
  readonly version: string;
  /** Output schemas by operation, embedded at emit time. */
  readonly outputSchemas?: { readonly [op: string]: JsonSchema };
  /** Runs one surface operation. The default spawns the jevris CLI. */
  readonly runSurface?: (op: string, args: unknown, workspace: string | null, signal: AbortSignalLike) => Promise<SurfaceCall>;
  /** Sends a server-initiated request to the client (roots/list). */
  readonly send?: (message: object) => void;
  /** Where the running script lives, to find the jevris bin next to it. */
  readonly scriptPath?: string | null;
}

export interface AbortSignalLike {
  readonly aborted: boolean;
  onAbort(listener: () => void): void;
}

type Json = { readonly [key: string]: unknown };

function isObject(value: unknown): value is Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function own(value: Json, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

/**
 * The first top-level argument whose schema lists an `enum` and whose value is outside it, as a
 * one-line message; null when there is none. A tool's schema is advisory to a client, so this is
 * the one schema rule the server itself enforces: it keeps jevris_advise and jevris_delivery_report
 * to their own capability ids (both reach the same capability.advise operation). Full schema
 * validation is not attempted here.
 */
function enumViolation(schema: JsonSchema, args: Json): string | null {
  const properties = schema['properties'];
  if (!isObject(properties)) return null;
  for (const [key, spec] of Object.entries(properties)) {
    if (!isObject(spec) || !Array.isArray(spec['enum']) || !Object.hasOwn(args, key)) continue;
    const allowed = spec['enum'] as readonly unknown[];
    if (!allowed.includes(args[key])) return `"${key}" must be one of ${allowed.map(String).join(', ')}.`;
  }
  return null;
}

function plain(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
}

function reply(id: unknown, result: object): object {
  return { jsonrpc: '2.0', id, result };
}

function failure(id: unknown, code: number, message: string): object {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function validId(id: unknown): boolean {
  return (typeof id === 'string' && id.length <= 256) || (typeof id === 'number' && Number.isFinite(id));
}

/** A `file://` root as a local path, or null. */
export function rootPath(uri: unknown, platform: string): string | null {
  if (typeof uri !== 'string' || !uri.startsWith('file://') || uri.length > 4096) return null;
  let path: string;
  try {
    path = decodeURIComponent(uri.slice('file://'.length).replace(/^localhost(?=\/)/, ''));
  } catch {
    return null;
  }
  if (platform === 'win32' && /^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  if (path.includes('\0') || path.length === 0) return null;
  return path;
}

/** The jevris bin: JEVRIS_BIN, else the install pointer next to this script, else a parent `bin/jevris.mjs`. */
export function resolveBin(env: Env, scriptPath: string | null): string | null {
  const fromEnv = env['JEVRIS_BIN'];
  if (plain(fromEnv) && isAbsolute(fromEnv)) return fromEnv;
  if (scriptPath === null) return null;
  const here = dirname(scriptPath);
  try {
    const pointer = JSON.parse(readFileSync(join(here, 'jevris-bin.json'), 'utf8')) as unknown;
    if (isObject(pointer) && plain(own(pointer, 'bin')) && isAbsolute(own(pointer, 'bin') as string)) return own(pointer, 'bin') as string;
  } catch {
    // No install pointer.
  }
  let dir = here;
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, 'bin', 'jevris.mjs');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // No PATH lookup (BLD-06): a PATH `jevris` may be a .cmd shim or a different program.
  return null;
}

/** The default runner: `node <bin> __surface <op>`, arguments on stdin, one JSON line out. */
export function cliRunner(env: Env, scriptPath: string | null, timeoutMs = CALL_TIMEOUT_MS) {
  return (op: string, args: unknown, workspace: string | null, signal: AbortSignalLike): Promise<SurfaceCall> => {
    const bin = resolveBin(env, scriptPath);
    if (bin === null) {
      return Promise.resolve({ kind: 'failed', message: 'The jevris CLI was not found next to this server. Reinstall Jevris with `jevris install`.' });
    }
    return new Promise<SurfaceCall>((done) => {
      let settled = false;
      const finish = (value: SurfaceCall): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        done(value);
      };
      const childEnv: { [key: string]: string } = {};
      for (const [key, value] of Object.entries(env)) if (typeof value === 'string') childEnv[key] = value;
      if (workspace !== null) childEnv['JEVRIS_WORKSPACE'] = workspace;
      else delete childEnv['JEVRIS_WORKSPACE'];
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(process.execPath, [bin, '__surface', op], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: childEnv });
      } catch {
        finish({ kind: 'failed', message: 'The jevris CLI could not be started. Run `jevris doctor` in a terminal.' });
        return;
      }
      const timer = setTimeout(() => {
        child.kill();
        finish({ kind: 'failed', message: `Jevris did not answer within ${Math.round(timeoutMs / 1000)} seconds. Run \`jevris status\` in a terminal.` });
      }, timeoutMs);
      signal.onAbort(() => {
        child.kill();
        finish({ kind: 'failed', message: 'The call was cancelled.' });
      });
      const chunks: Uint8Array[] = [];
      let size = 0;
      child.stdout?.on('data', (chunk: Uint8Array) => {
        size += chunk.byteLength;
        if (size > OUTPUT_CAP) {
          child.kill();
          finish({ kind: 'failed', message: 'The Jevris answer was larger than 1 MiB and was dropped.' });
          return;
        }
        chunks.push(chunk);
      });
      child.on('error', () => finish({ kind: 'failed', message: 'The jevris CLI could not be started. Run `jevris doctor` in a terminal.' }));
      child.on('close', () => {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        let parsed: unknown;
        try {
          parsed = JSON.parse(text.split('\n')[0] ?? '');
        } catch {
          finish({ kind: 'failed', message: 'The jevris CLI returned no readable answer. Run `jevris status` in a terminal.' });
          return;
        }
        if (isObject(parsed) && isObject(own(parsed, 'error'))) {
          const error = own(parsed, 'error') as Json;
          const code = typeof own(error, 'code') === 'string' ? (own(error, 'code') as string) : 'REFUSED';
          const message = typeof own(error, 'message') === 'string' ? (own(error, 'message') as string).slice(0, 500) : 'Refused.';
          finish({ kind: 'refused', code, message });
          return;
        }
        if (isObject(parsed) && own(parsed, 'schemaVersion') === '1.0') {
          finish({ kind: 'result', result: parsed });
          return;
        }
        finish({ kind: 'failed', message: 'The jevris CLI returned an unexpected answer. Update Jevris.' });
      });
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(JSON.stringify(args ?? {}));
    });
  };
}

/** The harness ids the installer may pass (the contracts' HARNESS_IDS; a test keeps them equal). */
export const MCP_HARNESS_IDS = ['claude', 'kilocode', 'codex', 'opencode', 'antigravity'] as const;

/**
 * The environment for the surface calls of this server. The harness this server runs inside
 * comes only from its own argv (`--harness <id>`, written by the installer into the MCP entry),
 * never from an inherited variable: JEVRIS_HARNESS is dropped from the host environment and
 * set again only for a known id. The surface sends it with handoff.import and handoff.export,
 * and the sidecar negotiates capabilities for that harness from its certification records.
 */
export function serverEnv(argv: readonly string[], env: Env): Env {
  const out: { [key: string]: string | undefined } = {};
  for (const [key, value] of Object.entries(env)) if (key !== 'JEVRIS_HARNESS') out[key] = value;
  let harness: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--harness') harness = argv[i + 1] ?? null;
    else if (typeof arg === 'string' && arg.startsWith('--harness=')) harness = arg.slice('--harness='.length);
  }
  if (harness !== null && (MCP_HARNESS_IDS as readonly string[]).includes(harness)) out['JEVRIS_HARNESS'] = harness;
  return out;
}

export interface McpServer {
  /** Handles one parsed message. Returns the response, or undefined for notifications and client responses. */
  handle(message: unknown): Promise<object | undefined>;
  listedTools(): readonly ToolSpec[];
  /** The workspace the next call is scoped to. */
  workspace(): string | null;
}

export function createServer(options: ServerOptions): McpServer {
  const env = options.env;
  const platform = process.platform;
  const runSurface = options.runSurface ?? cliRunner(env, options.scriptPath ?? null);
  // Every tool is listed. Owned mode is a per-workspace CLI setting that the sidecar enforces
  // on each task.submit; an environment variable never enables it.
  const listed = TOOLS;
  const byName = new Map(listed.map((tool) => [tool.name, tool]));
  let clientRoots = false;
  let roots: string[] = [];
  let nextRequest = 1;
  const pending = new Map<string, (result: unknown) => void>();
  const running = new Map<string, () => void>();
  const cancelledIds = new Set<string>();

  function workspace(): string | null {
    const project = env['CLAUDE_PROJECT_DIR'];
    if (plain(project)) return project;
    if (roots.length > 0) return roots[0] ?? null;
    try {
      const cwd = options.cwd();
      return plain(cwd) ? resolve(cwd) : null;
    } catch {
      return null;
    }
  }

  function askRoots(): void {
    if (!clientRoots || options.send === undefined) return;
    const id = `jevris-roots-${nextRequest}`;
    nextRequest += 1;
    pending.set(id, (result) => {
      if (!isObject(result) || !Array.isArray(own(result, 'roots'))) return;
      const found: string[] = [];
      for (const root of own(result, 'roots') as unknown[]) {
        if (!isObject(root)) continue;
        const path = rootPath(own(root, 'uri'), platform);
        if (path !== null) found.push(path);
        if (found.length >= 16) break;
      }
      roots = found;
    });
    options.send({ jsonrpc: '2.0', id, method: 'roots/list' });
  }

  function toolDefinition(tool: ToolSpec): object {
    const output = options.outputSchemas?.[tool.op];
    return {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(output !== undefined ? { outputSchema: output } : {}),
      annotations: annotationsFor(tool),
      _meta: { 'jevris/effect': tool.effect, 'jevris/operation': tool.op },
    };
  }

  function errorResult(message: string): object {
    return { content: [{ type: 'text', text: message }], isError: true };
  }

  async function callTool(id: string, params: Json): Promise<object> {
    const name = own(params, 'name');
    const tool = typeof name === 'string' ? byName.get(name) : undefined;
    if (tool === undefined) return { error: { code: -32602, message: `Unknown tool: ${typeof name === 'string' ? name.slice(0, 64) : ''}` } };
    const args = own(params, 'arguments');
    if (args !== undefined && !isObject(args)) return { result: errorResult('Refused: the arguments must be an object.') };
    const outside = isObject(args) ? enumViolation(tool.inputSchema, args) : null;
    if (outside !== null) return { result: errorResult(`Refused (REFUSED): ${outside}`) };
    let cancelled = false;
    const listeners: (() => void)[] = [];
    running.set(id, () => {
      cancelled = true;
      for (const listener of listeners) listener();
    });
    const signal: AbortSignalLike = {
      get aborted() {
        return cancelled;
      },
      onAbort(listener) {
        listeners.push(listener);
      },
    };
    try {
      const answer = await runSurface(tool.op, args ?? {}, workspace(), signal);
      if (answer.kind === 'refused') return { result: errorResult(`Refused (${answer.code}): ${answer.message}`) };
      if (answer.kind === 'failed') return { result: errorResult(answer.message) };
      return { result: { content: [{ type: 'text', text: JSON.stringify(answer.result) }], structuredContent: answer.result, isError: false } };
    } finally {
      running.delete(id);
    }
  }

  async function readResource(params: Json): Promise<object> {
    const uri = own(params, 'uri');
    const report = typeof uri === 'string' ? REPORTS.find((entry) => `jevris://report/${entry.id}` === uri) : undefined;
    if (report === undefined) return { error: { code: -32002, message: 'Resource not found. Jevris serves only its approved report ids.' } };
    const never: AbortSignalLike = { aborted: false, onAbort: () => undefined };
    const answer = await runSurface(report.op, {}, workspace(), never);
    if (answer.kind !== 'result') return { error: { code: -32603, message: answer.message } };
    return { result: { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(answer.result) }] } };
  }

  async function handle(message: unknown): Promise<object | undefined> {
    if (Array.isArray(message)) return failure(null, -32600, 'Batches are not supported.');
    if (!isObject(message)) return failure(null, -32600, 'Invalid request.');
    const method = own(message, 'method');
    const hasId = Object.hasOwn(message, 'id');
    const id = own(message, 'id');
    if (typeof method !== 'string') {
      // A response to a request this server sent (roots/list).
      if (hasId && typeof id === 'string' && pending.has(id)) {
        const resolveResult = pending.get(id);
        pending.delete(id);
        if (resolveResult !== undefined && Object.hasOwn(message, 'result')) resolveResult(own(message, 'result'));
        return undefined;
      }
      return hasId ? failure(id, -32600, 'Invalid request.') : undefined;
    }
    if (!hasId) {
      // Notifications never get a reply.
      if (method === 'notifications/initialized' || method === 'notifications/roots/list_changed') askRoots();
      if (method === 'notifications/cancelled') {
        const params = own(message, 'params');
        const target = isObject(params) ? own(params, 'requestId') : undefined;
        const cancel = running.get(String(target));
        if (cancel !== undefined) {
          cancelledIds.add(String(target));
          cancel();
        }
      }
      return undefined;
    }
    if (!validId(id)) return failure(null, -32600, 'Invalid request id.');
    const params = isObject(own(message, 'params')) ? (own(message, 'params') as Json) : {};
    switch (method) {
      case 'initialize': {
        const requested = own(params, 'protocolVersion');
        const protocolVersion = typeof requested === 'string' && SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0];
        const capabilities = own(params, 'capabilities');
        clientRoots = isObject(capabilities) && isObject(own(capabilities, 'roots'));
        return reply(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
          serverInfo: { name: 'jevris', title: 'Jevris', version: options.version },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return reply(id, {});
      case 'tools/list':
        return reply(id, { tools: listed.map(toolDefinition) });
      case 'tools/call': {
        const called = await callTool(String(id), params);
        // A cancelled request gets no response.
        if (cancelledIds.delete(String(id))) return undefined;
        return 'error' in called ? { jsonrpc: '2.0', id, ...called } : reply(id, (called as { result: object }).result);
      }
      case 'resources/list':
        return reply(id, {
          resources: REPORTS.map((report) => ({ uri: `jevris://report/${report.id}`, name: report.id, title: report.title, mimeType: 'application/json' })),
        });
      case 'resources/templates/list':
        return reply(id, { resourceTemplates: [] });
      case 'resources/read': {
        const read = await readResource(params);
        return 'error' in read ? { jsonrpc: '2.0', id, ...read } : reply(id, (read as { result: object }).result);
      }
      default:
        return failure(id, -32601, `Method not found: ${method.slice(0, 64)}`);
    }
  }

  return { handle, listedTools: () => listed, workspace };
}

/**
 * Line-delimited JSON-RPC over stdio. An oversize line is answered with an error and skipped;
 * the server keeps running. Responses are written as calls finish.
 */
export function runStdio(options: Omit<ServerOptions, 'send'>): void {
  const write = (message: object): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const server = createServer({ ...options, send: write });
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let discarding = false;
  const dispatch = (line: string): void => {
    if (line.trim().length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      write(failure(null, -32700, 'Parse error.'));
      return;
    }
    void server.handle(parsed).then(
      (response) => {
        if (response !== undefined) write(response);
      },
      () => {
        const id = isObject(parsed) ? own(parsed, 'id') : null;
        if (id !== undefined) write(failure(id, -32603, 'Internal error.'));
      },
    );
  };
  process.stdin.on('data', (chunk: Uint8Array) => {
    let start = 0;
    for (let i = 0; i < chunk.byteLength; i += 1) {
      if (chunk[i] !== 0x0a) continue;
      const piece = chunk.subarray(start, i);
      start = i + 1;
      if (discarding) {
        discarding = false;
        pending = [];
        pendingBytes = 0;
        continue;
      }
      pending.push(piece);
      pendingBytes += piece.byteLength;
      const line = Buffer.concat(pending).toString('utf8');
      pending = [];
      pendingBytes = 0;
      if (Buffer.byteLength(line, 'utf8') > MESSAGE_CAP) {
        write(failure(null, -32600, 'Message larger than 1 MiB.'));
        continue;
      }
      dispatch(line);
    }
    if (start < chunk.byteLength && !discarding) {
      const rest = chunk.subarray(start);
      pending.push(rest);
      pendingBytes += rest.byteLength;
      if (pendingBytes > MESSAGE_CAP) {
        write(failure(null, -32600, 'Message larger than 1 MiB.'));
        discarding = true;
        pending = [];
        pendingBytes = 0;
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

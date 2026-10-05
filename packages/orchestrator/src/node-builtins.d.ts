// Minimal Node declarations for @jevris/orchestrator. The package public API uses plain
// types only, so consumers never compile against these declarations.

interface ImportMeta {
  readonly url: string;
}

declare class URL {
  constructor(input: string, base?: string | URL);
  readonly href: string;
  readonly protocol: string;
  readonly hostname: string;
  readonly pathname: string;
  readonly host: string;
  readonly port: string;
  readonly username: string;
  readonly password: string;
}

declare const process: {
  readonly platform: string;
  readonly arch: string;
  readonly pid: number;
  readonly version: string;
  readonly execPath: string;
  readonly argv: readonly string[];
  readonly env: { readonly [key: string]: string | undefined };
  readonly versions: { readonly [key: string]: string | undefined };
  kill(pid: number, signal?: string | number): boolean;
  cwd(): string;
  hrtime: { bigint(): bigint };
  /** Sets the file-mode mask and returns the previous one (throws in a worker thread). */
  umask(mask: number): number;
};

declare function setTimeout(callback: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;
declare function setInterval(callback: () => void, ms: number): unknown;
declare function clearInterval(handle: unknown): void;
declare function queueMicrotask(callback: () => void): void;

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
declare class TextDecoder {
  constructor(label?: string, options?: { readonly fatal?: boolean });
  decode(input?: Uint8Array): string;
}

interface AbortSignal {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: { readonly once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}
declare class AbortController {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}

declare module 'node:os' {
  export function homedir(): string;
  export function tmpdir(): string;
  export function hostname(): string;
  export function platform(): string;
  export function arch(): string;
  export function cpus(): readonly unknown[];
  export function release(): string;
}

declare module 'node:path' {
  interface PathApi {
    readonly sep: string;
    readonly delimiter: string;
    join(...parts: string[]): string;
    resolve(...parts: string[]): string;
    relative(from: string, to: string): string;
    dirname(path: string): string;
    basename(path: string, suffix?: string): string;
    extname(path: string): string;
    isAbsolute(path: string): boolean;
    normalize(path: string): string;
  }
  export const posix: PathApi;
  export const win32: PathApi;
  export const sep: string;
  export const delimiter: string;
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function relative(from: string, to: string): string;
  export function dirname(path: string): string;
  export function basename(path: string, suffix?: string): string;
  export function extname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function normalize(path: string): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
  export function pathToFileURL(path: string): URL;
}

declare module 'node:crypto' {
  export interface Hash {
    update(data: Uint8Array | string): Hash;
    digest(encoding: 'hex'): string;
    digest(encoding: 'base64'): string;
  }
  export interface Hmac {
    update(data: Uint8Array | string): Hmac;
    digest(encoding: 'hex'): string;
  }
  export function createHash(algorithm: string): Hash;
  export function createHmac(algorithm: string, key: Uint8Array | string): Hmac;
  export function randomBytes(size: number): Uint8Array & { toString(encoding: 'hex'): string };
  export function randomUUID(): string;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}

declare module 'node:fs' {
  export interface Stats {
    readonly mode: number;
    readonly size: number;
    /** Owner and group (the managed-policy reader's ownership check, settings/managed-policy.ts). */
    readonly uid: number;
    readonly gid: number;
    readonly mtimeMs: number;
    readonly ctimeMs: number;
    readonly ino: number;
    readonly dev: number;
    isSymbolicLink(): boolean;
    isDirectory(): boolean;
    isFile(): boolean;
  }
  export interface BigIntStats {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly birthtimeNs: bigint;
    isDirectory(): boolean;
  }
  export interface Dirent {
    readonly name: string;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }
  export const constants: {
    readonly O_CREAT: number;
    readonly O_EXCL: number;
    readonly O_WRONLY: number;
    readonly O_RDONLY: number;
    readonly O_NOFOLLOW?: number;
    readonly X_OK: number;
  };
  export interface ReadStream {
    on(event: 'data', listener: (chunk: Uint8Array) => void): ReadStream;
    on(event: 'error', listener: (error: unknown) => void): ReadStream;
    on(event: 'end', listener: () => void): ReadStream;
    destroy(): void;
  }
  export function createReadStream(path: string, options?: { readonly highWaterMark?: number }): ReadStream;
  export function existsSync(path: string): boolean;
  export function statSync(path: string): Stats;
  export function statSync(path: string, options: { readonly bigint: true }): BigIntStats;
  export function lstatSync(path: string): Stats;
  export function lstatSync(path: string, options: { readonly throwIfNoEntry: false }): Stats | undefined;
  export function readFileSync(path: string): Uint8Array;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function writeFileSync(path: string, data: string | Uint8Array, options?: { readonly mode?: number; readonly flag?: string }): void;
  export function mkdirSync(path: string, options?: { readonly recursive?: boolean; readonly mode?: number }): string | undefined;
  export function rmdirSync(path: string): void;
  export function rmSync(path: string, options?: { readonly recursive?: boolean; readonly force?: boolean }): void;
  export function readdirSync(path: string): string[];
  export function readdirSync(path: string, options: { readonly withFileTypes: true }): Dirent[];
  export function renameSync(from: string, to: string): void;
  export function unlinkSync(path: string): void;
  export function linkSync(existingPath: string, newPath: string): void;
  export function openSync(path: string, flags: string | number, mode?: number): number;
  export function closeSync(fd: number): void;
  export function writeSync(fd: number, data: string | Uint8Array): number;
  export function readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number;
  export function fsyncSync(fd: number): void;
  export function accessSync(path: string, mode?: number): void;
  export function chmodSync(path: string, mode: number): void;
  export const realpathSync: {
    (path: string): string;
    native(path: string): string;
  };
}

declare module 'node:fs/promises' {
  import type { Stats } from 'node:fs';
  export function readFile(path: string): Promise<Uint8Array>;
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
  export function writeFile(path: string, data: string | Uint8Array, options?: { readonly mode?: number; readonly flag?: string }): Promise<void>;
  export function mkdir(path: string, options?: { readonly recursive?: boolean; readonly mode?: number }): Promise<string | undefined>;
  export function rm(path: string, options?: { readonly recursive?: boolean; readonly force?: boolean }): Promise<void>;
  export function readdir(path: string): Promise<string[]>;
  export function stat(path: string): Promise<Stats>;
  export function lstat(path: string): Promise<Stats>;
  export function rename(from: string, to: string): Promise<void>;
  export interface FileHandle {
    writeFile(data: string | Uint8Array): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }
  export function open(path: string, flags: string, mode?: number): Promise<FileHandle>;
  export function realpath(path: string): Promise<string>;
}

declare module 'node:child_process' {
  export interface SpawnSyncResult {
    readonly status: number | null;
    readonly signal: string | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly error?: unknown;
  }
  export interface SpawnSyncOptions {
    readonly encoding?: 'utf8';
    readonly shell: false;
    readonly windowsHide?: true;
    readonly stdio?: 'ignore' | 'pipe';
    readonly windowsVerbatimArguments?: boolean;
    readonly timeout?: number;
    readonly maxBuffer?: number;
    readonly env?: { readonly [key: string]: string | undefined };
    readonly cwd?: string;
    readonly input?: string;
  }
  export function spawnSync(command: string, args: readonly string[], options: SpawnSyncOptions): SpawnSyncResult;

  export interface Readable {
    on(event: 'data', listener: (chunk: Uint8Array) => void): this;
    on(event: 'end', listener: () => void): this;
    on(event: 'error', listener: (error: unknown) => void): this;
  }
  export interface Writable {
    write(chunk: string | Uint8Array): boolean;
    end(): void;
    on(event: 'error', listener: (error: unknown) => void): this;
  }
  export interface ChildProcess {
    readonly pid?: number;
    readonly stdout: Readable | null;
    readonly stderr: Readable | null;
    readonly stdin: Writable | null;
    kill(signal?: string | number): boolean;
    unref(): void;
    on(event: 'close', listener: (code: number | null, signal: string | null) => void): this;
    on(event: 'exit', listener: (code: number | null, signal: string | null) => void): this;
    on(event: 'error', listener: (error: unknown) => void): this;
  }
  export interface SpawnOptions {
    readonly cwd?: string;
    readonly env?: { readonly [key: string]: string | undefined };
    readonly shell: false;
    readonly windowsHide: true;
    readonly windowsVerbatimArguments?: boolean;
    readonly detached?: boolean;
    readonly stdio?: readonly ('ignore' | 'pipe' | 'inherit')[] | 'ignore' | 'pipe';
  }
  export function spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess;
}

/** P6: the check-output worker thread (decode, parse, hash and distill off the request loop). */
declare module 'node:worker_threads' {
  export const isMainThread: boolean;
  export const workerData: unknown;
  export interface MessagePort {
    postMessage(value: unknown, transfer?: readonly ArrayBuffer[]): void;
    on(event: 'message', listener: (value: unknown) => void): this;
  }
  export const parentPort: MessagePort | null;
  export class Worker {
    constructor(filename: string | URL, options?: { readonly workerData?: unknown; readonly eval?: boolean });
    on(event: 'message', listener: (value: unknown) => void): this;
    on(event: 'error', listener: (error: unknown) => void): this;
    on(event: 'exit', listener: (code: number) => void): this;
    postMessage(value: unknown, transfer?: readonly ArrayBuffer[]): void;
    terminate(): Promise<number>;
    ref(): void;
    unref(): void;
  }
}

declare module 'node:net' {
  export interface Socket {
    write(data: string, callback?: () => void): boolean;
    end(data?: string): this;
    destroy(): void;
    setEncoding(encoding: 'utf8'): this;
    on(event: 'data', listener: (chunk: string) => void): this;
    on(event: 'end', listener: () => void): this;
    on(event: 'close', listener: () => void): this;
    on(event: 'error', listener: (err: unknown) => void): this;
    on(event: 'connect', listener: () => void): this;
    setTimeout(ms: number, listener?: () => void): this;
  }
  export interface Server {
    listen(port: number, host: string, callback?: () => void): this;
    listen(path: string, callback?: () => void): this;
    address(): { readonly port: number; readonly address: string } | string | null;
    close(callback?: (err?: unknown) => void): this;
    on(event: 'error', listener: (err: unknown) => void): this;
  }
  export function createServer(listener: (socket: Socket) => void): Server;
  export function connect(options: { readonly port: number; readonly host: string }): Socket;
  export function connect(path: string): Socket;
}

declare module 'node:http' {
  export interface IncomingMessage extends AsyncIterable<Uint8Array> {
    readonly method?: string;
    readonly url?: string;
    readonly headers: { readonly authorization?: string; readonly [key: string]: string | readonly string[] | undefined };
    readonly statusCode?: number;
    on(event: 'data', listener: (chunk: Uint8Array) => void): this;
    on(event: 'end', listener: () => void): this;
    on(event: 'error', listener: (err: unknown) => void): this;
  }
  export interface ServerResponse {
    writeHead(status: number, headers: { readonly [key: string]: string | number }): this;
    end(data?: string | Uint8Array): void;
  }
  export interface ClientRequest {
    on(event: 'timeout', listener: () => void): this;
    on(event: 'error', listener: (err: unknown) => void): this;
    end(data?: string | Uint8Array): void;
    destroy(): void;
  }
  export interface Server {
    requestTimeout: number;
    headersTimeout: number;
    listen(port: number, host: string, callback?: () => void): this;
    address(): { readonly port: number; readonly address: string; readonly family: string } | string | null;
    close(callback?: (err?: unknown) => void): this;
    closeAllConnections(): void;
    once(event: 'error', listener: (err: unknown) => void): this;
    off(event: 'error', listener: (err: unknown) => void): this;
  }
  export interface RequestOptions {
    readonly protocol?: string;
    readonly hostname?: string;
    readonly port?: number;
    readonly path?: string;
    readonly method?: string;
    readonly headers?: { readonly [key: string]: string | number };
    readonly timeout?: number;
    readonly ca?: string | Uint8Array;
  }
  export function createServer(listener: (req: IncomingMessage, res: ServerResponse) => void): Server;
  export function request(options: RequestOptions, callback: (res: IncomingMessage) => void): ClientRequest;
}

declare module 'node:https' {
  import type { ClientRequest, IncomingMessage, RequestOptions, Server, ServerResponse } from 'node:http';
  export function createServer(options: { readonly key: string | Uint8Array; readonly cert: string | Uint8Array }, listener: (req: IncomingMessage, res: ServerResponse) => void): Server;
  export function request(options: RequestOptions, callback: (res: IncomingMessage) => void): ClientRequest;
}

/** F's certification loader, loaded dynamically (no build-time dependency on the CLI). */
declare module '@jevris/cli/certifications' {
  export function loadCertifications(home: string): Promise<{ readonly records: readonly { readonly record: unknown }[] }>;
}

/**
 * F's owned-worker ports (Claude Code, Codex, OpenCode, Kilo, Antigravity), loaded dynamically
 * (no build-time dependency on the CLI). The shared shapes live in the Claude module's block;
 * each port takes the same input and answers the same outcome (F f501ceb, 9534911).
 */
declare module '@jevris/cli/claude-worker' {
  import type { AccessLimitFinding, AccessSignalWire } from '@jevris/contracts';
  /**
   * Mirrors the orchestrator's WORKER_RUN_STATUSES (an ambient module cannot import it).
   * `usage-limit` stays accepted until every port reports `access-limit` or `overloaded` (R63, R65-R67).
   */
  export type OwnedWorkerStatus = 'completed' | 'failed' | 'max-turns' | 'budget-exceeded' | 'aborted' | 'timeout' | 'unsupported' | 'refused' | 'usage-limit' | 'model-unavailable' | 'access-limit' | 'overloaded';
  export type OwnedWorkerEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  export interface OwnedWorkerPortInput {
    readonly prompt: string;
    readonly model: string;
    readonly cwd: string;
    readonly allowedTools: readonly string[];
    readonly maxTurns: number;
    readonly maxBudgetUsd: number;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    readonly onStart?: (control: { readonly interrupt: () => void; readonly abort: () => void; readonly sessionId: () => string | null }) => void;
    readonly auth?: 'api-key' | 'subscription';
    /** C's effort level; absent is the model's default (nothing is passed). */
    readonly effort?: OwnedWorkerEffort;
    /** The child's environment before the port's auth shaping. */
    readonly env?: { readonly [key: string]: string | undefined };
    /** R52: the pinned serving host the run goes through, with `model` the registry id; absent is the maker's route. */
    readonly servingHost?: string;
  }
  export interface OwnedWorkerPortOutcome {
    readonly status: OwnedWorkerStatus;
    readonly reason: string;
    readonly sessionId: string | null;
    readonly requestedModel: string;
    readonly actualModel: string | null;
    readonly costUsd: number | null;
    readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadInputTokens: number; readonly cacheCreationInputTokens: number } | null;
    readonly turns: number | null;
    readonly durationMs: number;
    readonly authMode?: 'api-key' | 'subscription' | 'unknown';
    readonly resetAt?: string;
    /** The effort level the port actually passed (null: none). */
    readonly effort?: OwnedWorkerEffort | null;
    /** The first-use check of the session's first event (null: there was none). */
    readonly initCheck?: { readonly ok: boolean; readonly reasonCode: string | null } | null;
    /** Only with status `model-unavailable` (C's reason and port id). */
    readonly modelUnavailable?: { readonly reasonCode: 'MODEL_GONE' | 'MODEL_NOT_ACCESSIBLE'; readonly port: 'claude' | 'codex' | 'opencode' | 'kilocode' | 'antigravity' | 'claude-api'; readonly authMode: 'api-key' | 'subscription' | 'unknown' };
    /** What the run ended on, when it was an access limit or an overload (fields only, never text or headers). The runner classifies it again. */
    readonly accessSignal?: AccessSignalWire;
    /** The port's own reading of `accessSignal`; the runner never trusts it. */
    readonly accessLimit?: AccessLimitFinding;
  }
  /** Where a port records each run's first-use check (worker.route live evidence). */
  export interface OwnedWorkerEvidenceOptions {
    readonly home: string;
    readonly root: string;
    readonly version: () => Promise<string | null>;
  }
  export interface OwnedWorkerPortOptions {
    /** Default: the harness's own binary records its evidence in this user's Jevris home. */
    readonly evidence?: OwnedWorkerEvidenceOptions | false;
  }
  export interface OwnedWorkerPort {
    run(input: OwnedWorkerPortInput): Promise<OwnedWorkerPortOutcome>;
  }
  export function claudeWorkerPort(options?: OwnedWorkerPortOptions): OwnedWorkerPort;
}

declare module '@jevris/cli/codex-worker' {
  import type { OwnedWorkerPort, OwnedWorkerPortOptions } from '@jevris/cli/claude-worker';
  export function codexWorkerPort(options?: OwnedWorkerPortOptions): OwnedWorkerPort;
}

declare module '@jevris/cli/opencode-worker' {
  import type { OwnedWorkerPort, OwnedWorkerPortOptions } from '@jevris/cli/claude-worker';
  export function opencodeWorkerPort(options?: OwnedWorkerPortOptions): OwnedWorkerPort;
}

declare module '@jevris/cli/kilo-worker' {
  import type { OwnedWorkerPort, OwnedWorkerPortOptions } from '@jevris/cli/claude-worker';
  export function kiloWorkerPort(options?: OwnedWorkerPortOptions): OwnedWorkerPort;
}

declare module '@jevris/cli/antigravity-worker' {
  import type { OwnedWorkerPort, OwnedWorkerPortOptions } from '@jevris/cli/claude-worker';
  export function antigravityWorkerPort(options?: OwnedWorkerPortOptions): OwnedWorkerPort;
}

/** F's harness sign-in reader, loaded dynamically (865ffa1): credential types only, never a value. */
declare module '@jevris/cli/harness-auth' {
  export function providerCredentials(
    harness: 'opencode' | 'kilo' | 'kilocode',
    env?: { readonly [key: string]: string | undefined },
  ): Promise<readonly { readonly provider: string; readonly type: 'oauth' | 'api' | 'wellknown' }[] | null>;
}

/** B's source-egress resolver, loaded dynamically (a0d0b99): the host decision the egress guard enforces. */
declare module '@jevris/sidecar' {
  export function resolveSourceEgress(input: { readonly home?: string }): 'approved' | 'not-approved';
}

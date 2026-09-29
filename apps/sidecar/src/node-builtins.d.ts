// Minimal Node declarations for @jevris/sidecar (the repository ships no @types/node).
// Only what this package uses; the public API exposes plain types.

interface Buffer extends Uint8Array {
  toString(encoding?: 'utf8' | 'utf-8' | 'base64' | 'base64url' | 'hex' | 'utf16le'): string;
  subarray(start?: number, end?: number): Buffer;
}

declare class TextDecoder {
  constructor(label?: string, options?: { readonly fatal?: boolean });
  decode(input: Uint8Array): string;
}

declare const Buffer: {
  from(input: string, encoding?: 'utf8' | 'base64' | 'base64url' | 'hex' | 'utf16le'): Buffer;
  from(input: Uint8Array | readonly number[]): Buffer;
  alloc(size: number): Buffer;
  concat(list: readonly Uint8Array[], totalLength?: number): Buffer;
  byteLength(input: string | Uint8Array, encoding?: 'utf8' | 'base64'): number;
  isBuffer(value: unknown): value is Buffer;
};

declare namespace NodeJS {
  interface ProcessEnv {
    [key: string]: string | undefined;
  }
  type Signals = 'SIGTERM' | 'SIGINT' | 'SIGHUP' | 'SIGBREAK' | 'SIGKILL';
  interface Timeout {
    unref(): this;
    ref(): this;
  }
}

declare const process: {
  readonly platform: string;
  readonly pid: number;
  readonly env: NodeJS.ProcessEnv;
  readonly execPath: string;
  readonly argv: readonly string[];
  readonly version: string;
  readonly versions: { readonly [name: string]: string | undefined };
  readonly stderr: { write(text: string): boolean };
  readonly stdout: { write(text: string): boolean };
  getuid?: () => number;
  kill(pid: number, signal?: NodeJS.Signals | 0): boolean;
  on(event: NodeJS.Signals, listener: () => void): unknown;
  once(event: NodeJS.Signals, listener: () => void): unknown;
  removeListener(event: NodeJS.Signals, listener: () => void): unknown;
  exit(code?: number): never;
  cwd(): string;
  umask(mask?: number): number;
};

declare function setTimeout(callback: (...args: never[]) => void, ms?: number): NodeJS.Timeout;
declare function clearTimeout(handle: NodeJS.Timeout | undefined): void;
declare function setInterval(callback: () => void, ms?: number): NodeJS.Timeout;
declare function clearInterval(handle: NodeJS.Timeout | undefined): void;
declare function setImmediate(callback: () => void): unknown;

interface AbortSignal {
  readonly reason?: unknown;
  addEventListener(type: 'abort', listener: () => void, options?: { readonly once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

declare class AbortController {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}

interface ImportMeta {
  readonly url: string;
}

declare class URL {
  constructor(url: string, base?: string | URL);
  readonly pathname: string;
  readonly href: string;
}

declare module 'node:fs' {
  export interface Stats {
    readonly mode: number;
    readonly uid: number;
    readonly size: number;
    readonly mtimeMs: number;
    readonly dev: number;
    readonly ino: number;
    isFile(): boolean;
    isDirectory(): boolean;
    isSocket(): boolean;
    isSymbolicLink(): boolean;
  }

  export interface BigIntStats {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly birthtimeNs: bigint;
    isDirectory(): boolean;
  }

  export const constants: {
    readonly O_RDONLY: number;
    readonly O_WRONLY: number;
    readonly O_CREAT: number;
    readonly O_EXCL: number;
    readonly O_APPEND: number;
    readonly O_NOFOLLOW?: number;
  };

  export function mkdirSync(path: string, options?: { readonly recursive?: boolean; readonly mode?: number }): string | undefined;
  export function chmodSync(path: string, mode: number): void;
  export function statSync(path: string): Stats;
  export function statSync(path: string, options: { readonly bigint: true }): BigIntStats;
  export function lstatSync(path: string): Stats;
  export function lstatSync(path: string, options: { readonly throwIfNoEntry: false }): Stats | undefined;
  export function fstatSync(fd: number): Stats;
  export function unlinkSync(path: string): void;
  export function renameSync(from: string, to: string): void;
  export function readFileSync(path: string): Buffer;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function readlinkSync(path: string): string;
  export function readdirSync(path: string): readonly string[];
  export function openSync(path: string, flags: string | number, mode?: number): number;
  export function closeSync(fd: number): void;
  export function readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number;
  export function writeSync(fd: number, data: string): number;
  export function appendFileSync(path: string, data: string, options?: { readonly mode?: number }): void;
  /** P7: asynchronous appends for the log and trace writers. */
  export function appendFile(path: string, data: string, options: { readonly mode?: number }, callback: (error: Error | null) => void): void;
  export function rename(from: string, to: string, callback: (error: Error | null) => void): void;
  export function write(fd: number, data: string, callback: (error: Error | null, written?: number) => void): void;
  export function writeFileSync(path: string, data: string | Uint8Array, options?: { readonly mode?: number; readonly flag?: string }): void;
  export function existsSync(path: string): boolean;
  export function rmSync(path: string, options?: { readonly recursive?: boolean; readonly force?: boolean }): void;
  export function realpathSync(path: string): string;
}

declare module 'node:os' {
  export function homedir(): string;
  export function platform(): string;
  export function tmpdir(): string;
  export function hostname(): string;
}

declare module 'node:path' {
  export const sep: string;
  export function join(...parts: readonly string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string, suffix?: string): string;
  export function resolve(...parts: readonly string[]): string;
  export function relative(from: string, to: string): string;
  export function isAbsolute(path: string): boolean;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
  export function pathToFileURL(path: string): URL;
}

declare module 'node:crypto' {
  interface Hash {
    update(data: string | Uint8Array, encoding?: 'utf8'): Hash;
    digest(): Buffer;
    digest(encoding: 'hex' | 'base64' | 'base64url'): string;
  }
  export function createHash(algorithm: 'sha256'): Hash;
  export function createHmac(algorithm: 'sha256', key: Uint8Array | string): Hash;
  export function randomBytes(size: number): Buffer;
  export function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean;
}

declare module 'node:child_process' {
  export interface ChildProcess {
    readonly pid?: number;
    on(event: 'error', listener: (error: unknown) => void): this;
    on(event: 'exit', listener: (code: number | null) => void): this;
    unref(): void;
  }
  export interface SpawnOptions {
    readonly detached?: boolean;
    readonly stdio?: 'ignore' | 'inherit' | 'pipe';
    readonly windowsHide?: boolean;
    readonly shell?: false;
    readonly env?: NodeJS.ProcessEnv;
    readonly cwd?: string;
  }
  export function spawn(command: string, args: readonly string[], options?: SpawnOptions): ChildProcess;
  /** P8: asynchronous Windows policy reads and pipe ACL hardening. */
  export function execFile(
    file: string,
    args: readonly string[],
    options: { readonly encoding: 'utf8'; readonly shell?: false; readonly windowsHide?: boolean; readonly timeout?: number },
    callback: (error: unknown, stdout: string, stderr: string) => void,
  ): ChildProcess;
  export function spawnSync(
    command: string,
    args: readonly string[],
    options?: {
      readonly encoding?: 'utf8';
      readonly shell?: false;
      readonly windowsHide?: boolean;
      readonly timeout?: number;
      readonly env?: NodeJS.ProcessEnv;
      readonly input?: string;
    },
  ): { readonly status: number | null; readonly stdout: string | Buffer | null; readonly stderr: string | Buffer | null; readonly error?: unknown };
}

declare module 'node:net' {
  export interface Socket {
    readonly destroyed: boolean;
    readonly writable: boolean;
    write(data: string | Uint8Array, callback?: () => void): boolean;
    end(data?: string | Uint8Array, callback?: () => void): this;
    destroy(): void;
    pause(): this;
    resume(): this;
    setTimeout(ms: number, callback?: () => void): this;
    on(event: 'data', listener: (chunk: Buffer) => void): this;
    on(event: 'end' | 'close' | 'connect', listener: () => void): this;
    on(event: 'error', listener: (err: unknown) => void): this;
    once(event: 'data', listener: (chunk: Buffer) => void): this;
    once(event: 'end' | 'close' | 'connect', listener: () => void): this;
    once(event: 'error', listener: (err: unknown) => void): this;
    removeListener(event: string, listener: (...args: never[]) => void): this;
  }

  export interface PathListenOptions {
    readonly path: string;
    readonly readableAll: false;
    readonly writableAll: false;
    readonly backlog?: number;
  }

  export interface Server {
    maxConnections: number;
    listen(options: PathListenOptions, listeningListener?: () => void): this;
    address(): string | null;
    close(callback?: (err?: Error) => void): this;
    unref(): this;
    on(event: 'error', listener: (err: Error) => void): this;
    once(event: 'error', listener: (err: Error) => void): this;
    removeListener(event: 'error', listener: (err: Error) => void): this;
  }

  export interface ServerOptions {
    readonly allowHalfOpen?: boolean;
    readonly pauseOnConnect?: boolean;
  }

  export function createServer(connectionListener?: (socket: Socket) => void): Server;
  export function createServer(options: ServerOptions, connectionListener?: (socket: Socket) => void): Server;
  export function connect(path: string): Socket;
  export function createConnection(path: string): Socket;
}

/** P10: the maintenance worker thread (a second store connection off the request loop). */
declare module 'node:worker_threads' {
  export const isMainThread: boolean;
  export const workerData: unknown;
  export interface MessagePort {
    postMessage(value: unknown): void;
  }
  export const parentPort: MessagePort | null;
  export class Worker {
    constructor(filename: string | URL, options?: { readonly workerData?: unknown });
    on(event: 'message', listener: (value: unknown) => void): this;
    on(event: 'error', listener: (error: unknown) => void): this;
    on(event: 'exit', listener: (code: number) => void): this;
    terminate(): Promise<number>;
  }
}

// Minimal Node declarations for @jevris/platform. The public API of this package uses
// only plain types, so consumers never compile against these declarations.

declare module 'node:os' {
  export function homedir(): string;
  export function hostname(): string;
  export function platform(): string;
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
    parse(path: string): { readonly root: string; readonly dir: string; readonly base: string; readonly ext: string; readonly name: string };
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
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
  export function pathToFileURL(path: string): URL;
}

declare module 'node:module' {
  export function createRequire(from: string): (id: string) => unknown;
}

declare module 'node:crypto' {
  export function randomBytes(size: number): { toString(encoding: 'hex'): string };
}

declare module 'node:fs' {
  export interface Stats {
    readonly mode: number;
    readonly size: number;
    readonly uid: number;
    readonly mtimeMs: number;
    readonly dev: number;
    readonly ino: number;
    isSymbolicLink(): boolean;
    isDirectory(): boolean;
    isFile(): boolean;
  }
  export const constants: {
    readonly O_CREAT: number;
    readonly O_EXCL: number;
    readonly O_WRONLY: number;
    readonly O_RDONLY: number;
    readonly O_NOFOLLOW?: number;
    readonly O_NONBLOCK?: number;
    readonly X_OK: number;
  };
  export function openSync(path: string, flags: number): number;
  export function fstatSync(fd: number): Stats;
  export function readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number;
  export function closeSync(fd: number): void;
  export function statSync(path: string): Stats;
  export function lstatSync(path: string): Stats;
  export function accessSync(path: string, mode?: number): void;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function existsSync(path: string): boolean;
  export const realpathSync: {
    (path: string): string;
    native(path: string): string;
  };
}

declare module 'node:fs/promises' {
  import type { Stats } from 'node:fs';
  export interface FileHandle {
    writeFile(data: Uint8Array | string): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }
  export function open(path: string, flags: string | number, mode?: number): Promise<FileHandle>;
  export function rename(from: string, to: string): Promise<void>;
  export function rm(path: string, options?: { readonly force?: boolean; readonly recursive?: boolean }): Promise<void>;
  export function rmdir(path: string): Promise<void>;
  export function lstat(path: string): Promise<Stats>;
  export function stat(path: string): Promise<Stats>;
  export function readdir(path: string): Promise<string[]>;
  export function mkdir(path: string, options?: { readonly recursive?: boolean; readonly mode?: number }): Promise<string | undefined>;
  export function chmod(path: string, mode: number): Promise<void>;
  export function cp(from: string, to: string, options?: { readonly recursive?: boolean; readonly errorOnExist?: boolean; readonly force?: boolean }): Promise<void>;
  export const realpath: {
    (path: string): Promise<string>;
  };
}

declare module 'node:child_process' {
  export interface SpawnSyncResult {
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly error?: unknown;
  }
  export interface ChildProcessLike {
    readonly pid?: number;
  }
  export function spawnSync(
    command: string,
    args: readonly string[],
    options: {
      readonly encoding: 'utf8';
      readonly shell: false;
      readonly windowsHide: true;
      readonly windowsVerbatimArguments?: boolean;
      readonly timeout?: number;
      readonly env?: { readonly [key: string]: string | undefined };
      readonly cwd?: string;
      readonly stdio?: readonly ('ignore' | 'pipe')[];
    },
  ): SpawnSyncResult;
}

declare const process: {
  readonly platform: string;
  readonly pid: number;
  readonly env: { readonly [key: string]: string | undefined };
  readonly versions: { readonly [key: string]: string | undefined };
  getuid?: () => number;
  umask(mask: number): number;
};

declare const performance: { now(): number };

interface ImportMeta {
  readonly url: string;
}

declare class URL {
  constructor(input: string, base?: string | URL);
  readonly href: string;
}

declare function setTimeout(callback: () => void, ms: number): unknown;

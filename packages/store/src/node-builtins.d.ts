interface ImportMeta {
  readonly url: string;
}

declare module 'node:module' {
  export function createRequire(filename: string | URL): (id: string) => unknown;
}

declare module 'node:fs' {
  export interface StoreStats {
    readonly mode: number;
    readonly mtimeMs: number;
    readonly size: number;
    isSymbolicLink(): boolean;
    isFile(): boolean;
  }
  export function lstatSync(path: string, options: { readonly throwIfNoEntry: false }): StoreStats | undefined;
  export function openSync(path: string, flags: number, mode?: number): number;
  export function closeSync(fd: number): void;
  export function chmodSync(path: string, mode: number): void;
  export const constants: {
    readonly O_CREAT: number;
    readonly O_EXCL: number;
    readonly O_WRONLY: number;
    readonly O_NOFOLLOW?: number;
  };
}

declare const process: {
  readonly platform: string;
  readonly pid: number;
  readonly env: { readonly [key: string]: string | undefined };
  kill(pid: number, signal?: number | string): boolean;
  hrtime: { bigint(): bigint };
};

declare module 'node:path' {
  export function resolve(...paths: string[]): string;
  export const sep: string;
}

declare module 'node:crypto' {
  export interface Hash {
    update(data: Uint8Array | string): Hash;
    digest(encoding: 'hex'): string;
  }

  export function createHash(algorithm: string): Hash;
  export interface Hmac {
    update(data: Uint8Array | string): Hmac;
    digest(encoding: 'hex'): string;
  }
  export function createHmac(algorithm: string, key: Uint8Array | string): Hmac;
  export function randomBytes(size: number): { toString(encoding: 'hex'): string } & Uint8Array;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}

declare module 'node:child_process' {
  export interface SpawnSyncResult {
    readonly status: number | null;
  }

  export function spawnSync(
    command: string,
    args: readonly string[],
    options: {
      readonly shell: false;
      readonly timeout: number;
      readonly stdio: 'ignore';
      readonly env: { readonly [key: string]: string };
      readonly windowsVerbatimArguments?: boolean;
    },
  ): SpawnSyncResult;
}

interface TextEncoder {
  encode(input?: string): Uint8Array;
}

interface TextDecoder {
  decode(input?: Uint8Array): string;
}

declare const TextEncoder: {
  new (): TextEncoder;
};

declare const TextDecoder: {
  new (label: string, options: { fatal: boolean }): TextDecoder;
};

/** Timers and abort signals (P2: the hook-record flush window). */
interface StoreTimer {
  unref?(): StoreTimer;
}
declare function setTimeout(callback: () => void, ms: number): StoreTimer;
declare function clearTimeout(timer: StoreTimer | undefined): void;
interface AbortSignal {
  readonly aborted: boolean;
}

declare module 'node:fs' {
  export interface StoreStatFs {
    readonly type: number | bigint;
  }
  export interface StoreFileStats {
    readonly mode: number;
    readonly size: number;
    readonly uid: number;
    readonly mtimeMs: number;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }
  export function statfsSync(path: string): StoreStatFs;
  export function statSync(path: string): StoreFileStats;
  export function realpathSync(path: string): string;
  export function readFileSync(path: string | number): Uint8Array & { toString(encoding?: string): string };
  export function readFileSync(path: string | number, encoding: 'utf8'): string;
  export function writeFileSync(path: string | number, data: string | Uint8Array, options?: { readonly mode?: number; readonly flag?: string }): void;
  export function writeSync(fd: number, data: string): number;
  export function fsyncSync(fd: number): void;
  export function unlinkSync(path: string): void;
  export function renameSync(from: string, to: string): void;
  export function mkdirSync(path: string, options?: { readonly recursive?: boolean; readonly mode?: number }): string | undefined;
  export function readdirSync(path: string): string[];
  export function existsSync(path: string): boolean;
  export function rmSync(path: string, options?: { readonly force?: boolean; readonly recursive?: boolean }): void;
  export function copyFileSync(from: string, to: string, mode?: number): void;
}

declare module 'node:os' {
  export function hostname(): string;
}

declare module 'node:path' {
  export function dirname(path: string): string;
  export function basename(path: string, suffix?: string): string;
  export function join(...paths: string[]): string;
  export function relative(from: string, to: string): string;
  export function isAbsolute(path: string): boolean;
}

declare module 'node:child_process' {
  export interface SpawnSyncTextResult {
    readonly status: number | null;
    readonly stdout: string;
    readonly error?: unknown;
  }
  export function spawnSync(
    command: string,
    args: readonly string[],
    options: {
      readonly shell: false;
      readonly timeout: number;
      readonly encoding: 'utf8';
      readonly stdio?: readonly ['ignore', 'pipe', 'ignore'];
      readonly windowsHide?: boolean;
      readonly env?: { readonly [key: string]: string | undefined };
    },
  ): SpawnSyncTextResult;
}

declare module 'node:fs' {
  export function openSync(path: string, flags: string): number;
  export function writeSync(fd: number, data: string): number;
}

declare module 'node:tty' {
  export class ReadStream {
    constructor(fd: number);
    setRawMode(mode: boolean): void;
    resume(): void;
    pause(): void;
    on(event: 'data', listener: (chunk: Uint8Array) => void): void;
    off(event: 'data', listener: (chunk: Uint8Array) => void): void;
    destroy(): void;
  }
}

declare module 'node:fs/promises' {
  export interface Stats {
    readonly mode: number;
    readonly size: number;
    isSymbolicLink(): boolean;
    isDirectory(): boolean;
    isFile(): boolean;
  }

  export function mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void>;
  export function readFile(path: string): Promise<Uint8Array>;
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
  export function writeFile(
    path: string,
    data: Uint8Array | string,
    options?: { readonly mode?: number; readonly flag?: string },
  ): Promise<void>;
  export function rmdir(path: string): Promise<void>;
  export function rename(from: string, to: string): Promise<void>;
  export function rm(path: string, options?: { readonly recursive?: boolean; readonly force?: boolean }): Promise<void>;
  export function cp(
    source: string,
    destination: string,
    options?: { readonly recursive?: boolean; readonly dereference?: boolean },
  ): Promise<void>;
  export function lstat(path: string): Promise<Stats>;
  export function stat(path: string): Promise<Stats>;
  export function realpath(path: string): Promise<string>;
  export function readdir(path: string): Promise<readonly string[]>;

  export interface FileReadResult {
    readonly bytesRead: number;
  }

  export interface FileHandle {
    read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<FileReadResult>;
    close(): Promise<void>;
  }

  export function open(path: string, flags: string): Promise<FileHandle>;
  export function chmod(path: string, mode: number): Promise<void>;
  export function unlink(path: string): Promise<void>;
}

declare module 'node:path' {
  export function join(...parts: readonly string[]): string;
  export function resolve(...parts: readonly string[]): string;
  export function relative(from: string, to: string): string;
  export function dirname(path: string): string;
  export function basename(path: string): string;
  export const sep: string;
  export function isAbsolute(path: string): boolean;
}

declare module 'node:crypto' {
  export interface Hash {
    update(data: Uint8Array | string): Hash;
    digest(encoding: 'hex'): string;
  }

  export function createHash(algorithm: string): Hash;
}

declare module 'node:net' {
  export interface Socket {
    write(data: string, callback?: () => void): boolean;
    end(): this;
    destroy(): void;
    on(event: 'end', listener: () => void): this;
    on(event: 'error', listener: (err: unknown) => void): this;
  }

  export function connect(path: string): Socket;
}

declare module 'node:os' {
  export function homedir(): string;
  export function tmpdir(): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: URL | string): string;
  export function pathToFileURL(path: string): URL;
}

declare module 'node:util' {
  export interface ParseArgsOptions {
    readonly type: 'string' | 'boolean';
  }

  export interface ParseArgsConfig {
    readonly args?: readonly string[];
    readonly allowPositionals?: boolean;
    readonly strict?: boolean;
    readonly options?: { readonly [key: string]: ParseArgsOptions };
  }

  export interface ParseArgsResult {
    readonly values: { readonly [key: string]: string | boolean | undefined };
    readonly positionals: readonly string[];
  }

  export function parseArgs(config: ParseArgsConfig): ParseArgsResult;
}

interface ImportMeta {
  readonly url: string;
}

declare const URL: {
  new (url: string, base?: string): { readonly pathname: string };
};

declare const process: {
  readonly pid: number;
  cwd(): string;
  kill(pid: number, signal?: string | number): boolean;
  on(event: 'exit', listener: () => void): void;
  readonly execPath: string;
  readonly platform: string;
  readonly version: string;
  readonly env: { readonly [key: string]: string | undefined };
  readonly stdout: {
    write(chunk: string): boolean;
  };
  readonly stderr: {
    write(chunk: string): boolean;
  };
  readonly stdin: {
    readonly isTTY: boolean;
    setRawMode(mode: boolean): void;
    resume(): void;
    pause(): void;
    on(event: 'data', listener: (chunk: Uint8Array) => void): void;
    off(event: 'data', listener: (chunk: Uint8Array) => void): void;
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array | string>;
  };
};

declare module 'node:module' {
  export function createRequire(url: string | URL): (id: string) => unknown;
}

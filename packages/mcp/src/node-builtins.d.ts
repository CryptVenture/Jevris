// Node APIs the MCP server uses (the build has no @types/node).
declare module 'node:child_process' {
  interface Readable {
    on(event: 'data', listener: (chunk: Uint8Array) => void): this;
  }
  interface Writable {
    on(event: 'error', listener: (error: unknown) => void): this;
    end(data?: string): void;
  }
  export interface ChildProcess {
    readonly stdout: Readable | null;
    readonly stdin: Writable | null;
    kill(): boolean;
    on(event: 'error', listener: (error: unknown) => void): this;
    on(event: 'close', listener: (code: number | null) => void): this;
  }
  export function spawn(
    command: string,
    args: readonly string[],
    options: {
      readonly shell?: boolean;
      readonly windowsHide?: boolean;
      readonly stdio?: readonly ('pipe' | 'ignore' | 'inherit')[];
      readonly env?: { readonly [key: string]: string };
      readonly cwd?: string;
    },
  ): ChildProcess;
}

declare module 'node:fs' {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: 'utf8'): string;
}

declare module 'node:path' {
  export function dirname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function join(...parts: readonly string[]): string;
  export function resolve(...parts: readonly string[]): string;
}

declare const process: {
  readonly argv: readonly string[];
  readonly env: { readonly [key: string]: string | undefined };
  readonly execPath: string;
  readonly platform: string;
  cwd(): string;
  exit(code: number): never;
  readonly stdout: { write(chunk: string): boolean };
  readonly stdin: {
    on(event: 'data', listener: (chunk: Uint8Array) => void): void;
    on(event: 'end', listener: () => void): void;
  };
};

declare const Buffer: {
  concat(chunks: readonly Uint8Array[]): { toString(encoding: 'utf8'): string };
  byteLength(text: string, encoding: 'utf8'): number;
};

declare function setTimeout(callback: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;

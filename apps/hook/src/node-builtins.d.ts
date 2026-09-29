// Node globals the hook launcher uses (the build has no @types/node).
declare const process: {
  readonly argv: readonly string[];
  readonly env: { readonly [key: string]: string | undefined };
  cwd(): string;
  readonly stdout: {
    write(chunk: string, callback?: () => void): boolean;
  };
  readonly stderr: {
    write(chunk: string): boolean;
  };
  readonly stdin: {
    destroy(): void;
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array | string>;
  };
  exit(code: number): never;
};

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare class TextDecoder {
  constructor(label?: string, options?: { readonly fatal?: boolean });
  decode(input?: Uint8Array): string;
}

declare function setTimeout(callback: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;

declare module 'node:fs' {
  export function statSync(path: string): { readonly size: number; isFile(): boolean };
}

// Guard 6 (access limits R68) reads a workspace's settings on a failure event only.
declare module 'node:fs/promises' {
  export function lstat(path: string): Promise<{ readonly size: number; isFile(): boolean }>;
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function dirname(path: string): string;
}

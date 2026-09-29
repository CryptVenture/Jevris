interface AbortSignal {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: { readonly once?: boolean }): void;
}
declare const process: { readonly env: { readonly [key: string]: string | undefined } };
declare function setTimeout(callback: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;

interface AbortController {
  readonly signal: AbortSignal;
  abort(): void;
}

declare const AbortController: {
  new (): AbortController;
};

declare module 'node:fs/promises' {
  export function mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void>;
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
  export function writeFile(path: string, data: string): Promise<void>;
  export function chmod(path: string, mode: number): Promise<void>;
}

declare module 'node:path' {
  export function join(...parts: readonly string[]): string;
  export function dirname(path: string): string;
}

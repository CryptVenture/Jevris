// Minimal runtime declarations for the decision engine modules (domain C). The package compiles
// with `lib: ES2022` and no Node types, so the few host globals the engine uses are declared
// here. Public signatures use only plain types and AbortSignal (declared by @jevris/contracts).

declare global {
  interface AbortSignal {
    readonly reason?: unknown;
    addEventListener?(type: 'abort', listener: () => void, options?: { readonly once?: boolean }): void;
    removeEventListener?(type: 'abort', listener: () => void): void;
  }
  interface DecisionEngineTimerHandle {
    unref?(): void;
  }
  function setTimeout(callback: () => void, ms: number): DecisionEngineTimerHandle;
  function clearTimeout(handle: DecisionEngineTimerHandle | undefined): void;
  const performance: { now(): number };
  class TextEncoder {
    encode(input?: string): Uint8Array;
  }
  class TextDecoder {
    constructor(label?: string, options?: { readonly fatal?: boolean; readonly ignoreBOM?: boolean });
    decode(input?: Uint8Array): string;
  }
  class AbortController {
    readonly signal: AbortSignal;
    abort(reason?: unknown): void;
  }
}

declare module 'node:fs/promises' {
  export function mkdir(path: string, options: { readonly recursive: boolean; readonly mode?: number }): Promise<string | undefined>;
  export function readdir(path: string): Promise<string[]>;
  export function unlink(path: string): Promise<void>;
  export function stat(path: string): Promise<{ readonly mtimeMs: number; readonly size: number }>;
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
  export function rmdir(path: string): Promise<void>;
  export function appendFile(path: string, data: string, options?: { readonly mode?: number; readonly flush?: boolean }): Promise<void>;
}

declare module 'node:crypto' {
  export function randomUUID(): string;
}

export {};

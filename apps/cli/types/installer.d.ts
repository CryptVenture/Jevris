// Node APIs the installer, doctor and certification runner use beyond src/node-builtins.d.ts.
declare module 'node:fs/promises' {
  export interface Stats {
    readonly mtimeMs: number;
  }
  export function copyFile(from: string, to: string, mode?: number): Promise<void>;
  export function appendFile(path: string, data: string, options?: { readonly mode?: number }): Promise<void>;
  export function utimes(path: string, atime: number, mtime: number): Promise<void>;
  export function mkdtemp(prefix: string): Promise<string>;
  export function mkdir(path: string, options: { readonly recursive?: boolean; readonly mode?: number }): Promise<string | undefined>;
}

declare module 'node:child_process' {
  export interface PipedChildProcess {
    readonly pid?: number;
    readonly stdin: {
      write(chunk: string): boolean;
      end(chunk?: string): void;
      on(event: 'error', listener: (error: Error) => void): void;
    } | null;
    readonly stdout: {
      on(event: 'data', listener: (chunk: Uint8Array | string) => void): void;
      on(event: 'error', listener: (error: Error) => void): void;
    } | null;
    readonly stderr: {
      on(event: 'data', listener: (chunk: Uint8Array | string) => void): void;
      on(event: 'error', listener: (error: Error) => void): void;
    } | null;
    on(event: 'error', listener: (error: Error) => void): void;
    on(event: 'close', listener: (code: number | null) => void): void;
    kill(signal?: string): void;
  }

  export function spawn(
    file: string,
    args: readonly string[],
    options: {
      readonly shell: false;
      readonly cwd?: string;
      readonly env?: { readonly [key: string]: string };
      readonly stdio: readonly ['pipe', 'pipe', 'pipe'];
      readonly detached?: boolean;
      readonly windowsHide?: boolean;
      readonly windowsVerbatimArguments?: boolean;
    },
  ): PipedChildProcess;
}

declare module 'node:crypto' {
  export interface KeyObject {
    readonly asymmetricKeyType?: string;
    export(options: { readonly type: 'spki' | 'pkcs8'; readonly format: 'pem' }): string;
    export(options: { readonly type: 'spki'; readonly format: 'der' }): Uint8Array;
  }
  export function generateKeyPairSync(type: 'ed25519'): { readonly publicKey: KeyObject; readonly privateKey: KeyObject };
  export function createPublicKey(key: string | KeyObject): KeyObject;
  export function createPrivateKey(key: string): KeyObject;
  export function randomBytes(size: number): Uint8Array;
}

/** Global fetch (Node 18+), used only against 127.0.0.1 by the certify runner. */
declare function fetch(
  url: string,
  init?: { readonly method?: string; readonly headers?: { readonly [key: string]: string }; readonly body?: string },
): Promise<{ readonly ok: boolean; readonly status: number }>;

declare module 'node:path' {
  /** Platform-specific joins for paths of another OS (the documented agy install folders). */
  export const posix: { join(...parts: string[]): string };
  export const win32: { join(...parts: string[]): string };
}

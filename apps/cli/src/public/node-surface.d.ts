// Node APIs used by the public command surface. Ambient declarations merge with node-builtins.d.ts.
declare module 'node:fs' {
  export interface SurfaceStats {
    readonly size: number;
    readonly mtimeMs: number;
    isFile(): boolean;
    isDirectory(): boolean;
  }
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string): Uint8Array;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function readdirSync(path: string): string[];
  export function statSync(path: string): SurfaceStats;
  export interface SurfaceBigIntStats {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly birthtimeNs: bigint;
    isDirectory(): boolean;
  }
  export function statSync(path: string, options: { readonly bigint: true }): SurfaceBigIntStats;
  export const realpathSync: {
    (path: string): string;
    native(path: string): string;
  };
}

declare module 'node:crypto' {
  export function randomBytes(size: number): { toString(encoding: 'hex'): string };
}

declare class TextDecoder {
  constructor(label?: string, options?: { readonly fatal?: boolean });
  decode(input?: Uint8Array): string;
}

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

interface SurfaceTimer {
  unref(): SurfaceTimer;
}
declare function setTimeout(callback: () => void, ms: number): SurfaceTimer;
declare function clearTimeout(timer: SurfaceTimer | undefined): void;

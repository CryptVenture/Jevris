// Minimal Node declarations for @jevris/languages. Public types stay plain.

declare const process: {
  readonly platform: string;
  readonly env: { readonly [key: string]: string | undefined };
};

declare module 'node:fs' {
  export interface Stats {
    readonly size: number;
    isDirectory(): boolean;
    isFile(): boolean;
  }
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function readdirSync(path: string): string[];
  export function statSync(path: string): Stats;
}

declare module 'node:path' {
  interface PathApi {
    join(...parts: string[]): string;
    relative(from: string, to: string): string;
    basename(path: string): string;
  }
  export const posix: PathApi;
  export function join(...parts: string[]): string;
  export function relative(from: string, to: string): string;
  export function basename(path: string): string;
}

declare module 'node:fs/promises' {
  export function mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void>;
  export function writeFile(path: string, data: string): Promise<void>;
  export function mkdtemp(prefix: string): Promise<string>;
  export function rm(path: string, options?: { readonly recursive?: boolean; readonly force?: boolean }): Promise<void>;
  export function cp(source: string, destination: string, options?: { readonly recursive?: boolean; readonly errorOnExist?: boolean; readonly force?: boolean }): Promise<void>;
}

declare module 'node:path' {
  export function join(...paths: readonly string[]): string;
}

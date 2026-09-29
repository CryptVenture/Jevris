declare module 'node:fs/promises' {
  export interface FileHandle {
    writeFile(data: Uint8Array, options?: { readonly flush?: boolean }): Promise<void>;
    close(): Promise<void>;
  }

  export function open(path: string, flags: string, mode?: number): Promise<FileHandle>;
  export function readFile(path: string): Promise<Uint8Array>;
  export function rename(from: string, to: string): Promise<void>;
  export function rm(path: string): Promise<void>;
}

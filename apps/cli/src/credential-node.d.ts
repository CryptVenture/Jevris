// The Node surface the opt-in credential source uses (GOV-07). Additive to the other shims.
declare module 'node:fs/promises' {
  export interface Stats {
    readonly uid: number;
    readonly dev: number;
    readonly ino: number;
  }

  export interface FileHandle {
    stat(): Promise<Stats>;
  }

  export function open(path: string, flags: number): Promise<FileHandle>;
}

declare module 'node:fs' {
  export const constants: {
    readonly O_RDONLY: number;
    readonly O_NOFOLLOW?: number;
    readonly O_NONBLOCK?: number;
  };
}

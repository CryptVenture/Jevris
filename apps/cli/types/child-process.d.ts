declare module 'node:child_process' {
  export interface ChildProcess {
    readonly pid?: number;
    readonly stdout: AsyncIterable<Uint8Array | string> | null;
    readonly stderr: AsyncIterable<Uint8Array | string> | null;
    on(event: 'error', listener: (error: Error) => void): void;
    on(event: 'exit', listener: (code: number | null) => void): void;
    kill(signal?: string): void;
    unref(): void;
  }

  export function execFile(
    file: string,
    args: readonly string[],
    options: {
      readonly shell: false;
      readonly timeout: number;
      readonly encoding: 'utf8';
      readonly cwd?: string;
      readonly env?: { readonly [key: string]: string };
    },
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ): void;

  export function spawn(
    file: string,
    args: readonly string[],
    options: {
      readonly shell: false;
      readonly cwd?: string;
      readonly env?: { readonly [key: string]: string };
      readonly stdio?: 'ignore' | 'pipe' | readonly ['ignore', 'pipe', 'pipe'] | readonly ['ignore', 'pipe', 'ignore'];
      readonly detached?: boolean;
      readonly windowsHide?: boolean;
      readonly windowsVerbatimArguments?: boolean;
    },
  ): ChildProcess;
}

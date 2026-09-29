// Node builtins used by the managed-policy reader (enterprise-policy.ts). Ambient declarations
// merge with node-builtins.d.ts and public/node-surface.d.ts.
declare module 'node:fs' {
  export interface EnterpriseStats {
    readonly mode: number;
    readonly uid: number;
    readonly gid: number;
    readonly size: number;
    isSymbolicLink(): boolean;
    isFile(): boolean;
    isDirectory(): boolean;
  }
  export function lstatSync(path: string): EnterpriseStats;
}

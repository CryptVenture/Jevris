// Ambient declaration of the node:path functions the decision journal uses (domain C). The
// package compiles without Node types.
declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function dirname(path: string): string;
}

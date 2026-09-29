// Node builtins used by the verify administration commands (merged into the declarations in
// node-builtins.d.ts; createPublicKey is declared in types/installer.d.ts).
declare module 'node:os' {
  export function userInfo(): { readonly username: string };
}

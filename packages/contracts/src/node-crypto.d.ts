declare module 'node:crypto' {
  export interface Hash {
    update(data: Uint8Array | string): Hash;
    digest(encoding: 'hex'): string;
  }
  export interface KeyObject {
    readonly type: 'secret' | 'public' | 'private';
    readonly asymmetricKeyType?: string;
  }
  export function createHash(algorithm: string): Hash;
  export function createPublicKey(key: string | KeyObject): KeyObject;
  export function createPrivateKey(key: string): KeyObject;
  export function sign(algorithm: null, data: Uint8Array, key: KeyObject): Uint8Array;
  export function verify(algorithm: null, data: Uint8Array, key: KeyObject, signature: Uint8Array): boolean;
}

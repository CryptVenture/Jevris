declare module 'node:crypto' {
  export interface Hash {
    update(data: Uint8Array | string): Hash;
    digest(encoding: 'hex'): string;
  }

  export function createHash(algorithm: string): Hash;
  export function randomBytes(size: number): Uint8Array;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}

import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import { driverFor, type OpenStoreResult, type StoreRefusalReason } from './open.js';

declare module 'node:path' {
  export function basename(path: string, suffix?: string): string;
  export function join(...paths: string[]): string;
}

const require = createRequire(import.meta.url);

function existsSync(path: string): boolean {
  const loaded = require('node:fs');
  if (loaded === null || typeof loaded !== 'object') return false;
  const candidate = (loaded as { readonly existsSync?: unknown }).existsSync;
  if (typeof candidate !== 'function') return false;
  return candidate(path) === true;
}

export type CopyAssessment = 'inconsistent' | 'consistent';

const SIDECARS = ['-wal', '-shm'] as const;

export async function exportConsistent(
  store: OpenStoreResult,
  destination: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: StoreRefusalReason }> {
  if (!store.ok) return { ok: false, reason: store.reason };
  if (typeof destination !== 'string' || destination.length === 0) {
    return { ok: false, reason: 'invalid-input' };
  }
  const driver = driverFor(store);
  if (driver === undefined) return { ok: false, reason: 'store-unavailable' };
  try {
    await driver.backup(destination);
  } catch {
    return { ok: false, reason: 'store-unavailable' };
  }
  return { ok: true };
}

export function assessCopy(sourcePath: string, copyDirectory: string): CopyAssessment {
  const sourceName = basename(sourcePath);
  for (const suffix of SIDECARS) {
    if (!existsSync(sourcePath + suffix)) continue;
    if (!existsSync(join(copyDirectory, sourceName + suffix))) return 'inconsistent';
  }
  return 'consistent';
}

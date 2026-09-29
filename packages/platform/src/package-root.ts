import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The installed package root and its shipped assets (BLD-03, BLD-04). Every runtime file
 * URL goes through fileURLToPath; nothing does URL.pathname math. Product code reads its
 * runtime assets from `<package root>/assets`, never from ssot_docs/ or fixtures/.
 */

export const PACKAGE_NAMES: readonly string[] = ['jevris', '@cryptventure/jevris'];

export interface PackageRootOptions {
  readonly names?: readonly string[];
  readonly readText?: (path: string) => string;
}

function packageName(path: string, readText: (path: string) => string): string | undefined {
  try {
    const parsed = JSON.parse(readText(path)) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const name = (parsed as { readonly name?: unknown }).name;
    return typeof name === 'string' ? name : undefined;
  } catch {
    return undefined;
  }
}

/** Walks up from a module file URL (or path) to the Jevris package root. */
export function findPackageRoot(from: string, options: PackageRootOptions = {}): string | null {
  const names = options.names ?? PACKAGE_NAMES;
  const readText = options.readText ?? ((path: string) => readFileSync(path, 'utf8'));
  let dir = dirname(from.startsWith('file:') ? fileURLToPath(from) : from);
  for (let depth = 0; depth < 12; depth += 1) {
    const name = packageName(join(dir, 'package.json'), readText);
    if (name !== undefined && names.includes(name)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** The package root this module ships in. Throws when the package is broken. */
export function packageRoot(): string {
  const root = findPackageRoot(import.meta.url);
  if (root === null) throw new Error('jevris package root not found');
  return root;
}

export function assetPath(...parts: string[]): string {
  return join(packageRoot(), 'assets', ...parts);
}

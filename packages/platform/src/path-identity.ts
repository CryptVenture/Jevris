import { realpathSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { pathApiFor } from './paths.js';

/**
 * Path identity and absoluteness (BLD-07).
 *
 * - Absolute checks use the platform's path.isAbsolute: on win32 that covers drive
 *   letters (`C:\`), UNC (`\\server\share`) and verbatim (`\\?\C:\`) paths.
 * - Identity normalises through realpath.native, then case-folds on win32 and darwin,
 *   whose default file systems are case-insensitive.
 * - A check that must refuse any absolute path (a relative id or citation) uses
 *   `isAbsoluteOnAnyPlatform`, so a Windows path is refused on POSIX and the reverse.
 */

export function isAbsoluteFor(path: string, platform: string = process.platform): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) return false;
  return pathApiFor(platform).isAbsolute(path);
}

export function isAbsoluteOnAnyPlatform(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0) return false;
  return posix.isAbsolute(path) || win32.isAbsolute(path);
}

/** True when the path has a `..` segment under either separator. */
export function hasParentSegment(path: string): boolean {
  return path.split(/[\\/]/).includes('..');
}

export function caseInsensitiveFs(platform: string = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

/** A comparison key: normalised, trailing separator removed, case-folded where the OS folds. */
export function pathKey(path: string, platform: string = process.platform): string {
  const api = pathApiFor(platform);
  let out = api.normalize(path);
  const root = api.parse(out).root;
  while (out.length > root.length && (out.endsWith('/') || (platform === 'win32' && out.endsWith('\\')))) {
    out = out.slice(0, -1);
  }
  return caseInsensitiveFs(platform) ? out.toLowerCase() : out;
}

export function samePath(left: string, right: string, platform: string = process.platform): boolean {
  return pathKey(left, platform) === pathKey(right, platform);
}

/** True when `candidate` is `root` or inside it, compared by key. */
export function isInsideOrSame(root: string, candidate: string, platform: string = process.platform): boolean {
  const api = pathApiFor(platform);
  const rel = api.relative(pathKey(root, platform), pathKey(candidate, platform));
  if (rel.length === 0) return true;
  // A child named `..x` is inside; only a `..` segment leaves the root.
  return rel !== '..' && !rel.startsWith(`..${api.sep}`) && !api.isAbsolute(rel);
}

export function isStrictlyInside(root: string, candidate: string, platform: string = process.platform): boolean {
  return !samePath(root, candidate, platform) && isInsideOrSame(root, candidate, platform);
}

export interface CanonicalOptions {
  readonly platform?: string;
  readonly realpath?: (path: string) => string;
}

/** realpath.native, or null when the path does not resolve. */
export function canonicalPath(path: string, options: CanonicalOptions = {}): string | null {
  const real = options.realpath ?? ((value: string) => realpathSync.native(value));
  try {
    return real(path);
  } catch {
    return null;
  }
}

/** Identity of two existing paths after realpath.native and case folding. */
export function sameFile(left: string, right: string, options: CanonicalOptions = {}): boolean {
  const platform = options.platform ?? process.platform;
  const a = canonicalPath(left, options);
  const b = canonicalPath(right, options);
  if (a === null || b === null) return false;
  return samePath(a, b, platform);
}

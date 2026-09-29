/**
 * Reading a pack directory safely (PAK-01, PAK-03): no link, no special file, bounded counts
 * and sizes, file names that are plain relative paths, and every file hashed. When the manifest
 * pins its files, the directory must match the pins exactly: nothing missing, nothing extra,
 * nothing changed.
 */
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Hex, type ContractIssue } from '@jevris/contracts';
import { PackManifestContract, type PackManifest } from './manifest.js';

export const PACK_MANIFEST_FILE = 'pack.json';
const MAX_FILES = 256;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 8;
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

export interface PackFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

export type PackDirRefusal =
  | 'PACK_DIR_MISSING'
  | 'PACK_LINK'
  | 'PACK_FILE_TYPE'
  | 'PACK_FILE_NAME'
  | 'PACK_TOO_LARGE'
  | 'MANIFEST_MISSING'
  | 'MANIFEST_INVALID'
  | 'FILE_UNLISTED'
  | 'FILE_MISSING'
  | 'FILE_CHANGED';

export type PackDir =
  | { readonly ok: true; readonly manifest: PackManifest; readonly manifestBytes: Uint8Array; readonly files: ReadonlyMap<string, PackFile> }
  | { readonly ok: false; readonly reasonCode: PackDirRefusal; readonly detail: string; readonly issues?: readonly ContractIssue[] };

function refuse(reasonCode: PackDirRefusal, detail: string, issues?: readonly ContractIssue[]): PackDir {
  return issues === undefined ? { ok: false, reasonCode, detail } : { ok: false, reasonCode, detail, issues };
}

/** The on-disk path of a manifest-relative path (`a/b.json`). */
export function packPath(dir: string, relative: string): string {
  return join(dir, ...relative.split('/'));
}

/** Reads and validates a pack directory. Nothing is executed and nothing is written. */
export async function readPackDir(dir: string): Promise<PackDir> {
  try {
    const top = await lstat(dir);
    if (top.isSymbolicLink()) return refuse('PACK_LINK', '.');
    if (!top.isDirectory()) return refuse('PACK_DIR_MISSING', dir);
  } catch {
    return refuse('PACK_DIR_MISSING', dir);
  }
  const files = new Map<string, PackFile>();
  let total = 0;
  const walk = async (relative: readonly string[]): Promise<PackDir | null> => {
    if (relative.length > MAX_DEPTH) return refuse('PACK_TOO_LARGE', relative.join('/'));
    const names = [...(await readdir(join(dir, ...relative)))].sort();
    for (const name of names) {
      const parts = [...relative, name];
      const shown = parts.join('/');
      if (!SEGMENT.test(name)) return refuse('PACK_FILE_NAME', shown);
      const st = await lstat(join(dir, ...parts));
      if (st.isSymbolicLink()) return refuse('PACK_LINK', shown);
      if (st.isDirectory()) {
        const inner = await walk(parts);
        if (inner !== null) return inner;
        continue;
      }
      if (!st.isFile()) return refuse('PACK_FILE_TYPE', shown);
      if (files.size >= MAX_FILES || st.size > MAX_FILE_BYTES || total + st.size > MAX_TOTAL_BYTES) return refuse('PACK_TOO_LARGE', shown);
      const bytes = await readFile(join(dir, ...parts));
      total += bytes.byteLength;
      files.set(shown, { path: shown, sha256: sha256Hex(bytes), bytes });
    }
    return null;
  };
  try {
    const walked = await walk([]);
    if (walked !== null) return walked;
  } catch {
    return refuse('PACK_DIR_MISSING', dir);
  }
  const manifestFile = files.get(PACK_MANIFEST_FILE);
  if (manifestFile === undefined) return refuse('MANIFEST_MISSING', PACK_MANIFEST_FILE);
  const parsed = PackManifestContract.parse(manifestFile.bytes, 1_048_576);
  if (!parsed.ok) return refuse('MANIFEST_INVALID', parsed.issues.map((issue) => `${issue.path || '/'} ${issue.code}`).slice(0, 8).join('; '), parsed.issues);
  const manifest = parsed.value;
  if (manifest.files !== undefined) {
    const pins = new Map(manifest.files.map((item) => [item.path, item.sha256]));
    for (const [path, file] of files) {
      if (path === PACK_MANIFEST_FILE) continue;
      const pin = pins.get(path);
      if (pin === undefined) return refuse('FILE_UNLISTED', path);
      if (pin !== file.sha256) return refuse('FILE_CHANGED', path);
    }
    for (const path of pins.keys()) if (!files.has(path)) return refuse('FILE_MISSING', path);
  } else {
    for (const exec of manifest.executables ?? []) {
      const file = files.get(exec.path);
      if (file === undefined) return refuse('FILE_MISSING', exec.path);
      if (file.sha256 !== exec.sha256) return refuse('FILE_CHANGED', exec.path);
    }
  }
  return { ok: true, manifest, manifestBytes: manifestFile.bytes, files };
}

/// <reference path="../types/installer.d.ts" />
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';

/**
 * The versioned runtime copy (ADM-03, SSOT §5.3 and §11.3).
 *
 * Install copies the shipped package (the runtime manifest's `files`, plus the
 * runtimeDependencies closure from node_modules) into `<data>/runtime/<version>/`, and
 * every harness registration points there. Nothing a harness runs lives in the npm
 * prefix, the npx cache or a repository checkout, so `npm cache clean --force` or
 * deleting the checkout never breaks an installed harness.
 *
 * The copy is staged next to its final place and renamed in, so a failed or interrupted
 * copy never leaves a half-written runtime under the version directory. A marker file
 * records the tree hash; an identical tree is reused, a different one is replaced (and
 * put back on rollback).
 */

export const RUNTIME_MARKER = '.jevris-runtime.json';
const MANIFEST_REL = ['dist', 'runtime', 'manifest.json'];
const MANIFEST_CAP = 262144;
const MAX_FILES = 40000;
const MAX_DEPTH = 24;
const SAFE_SEGMENT = /^[A-Za-z0-9@._+-][A-Za-z0-9@._+ -]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export interface RuntimeManifest {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly version: string;
  readonly engines: { readonly node?: string };
  readonly entries: { readonly [key: string]: string };
  readonly files: readonly string[];
  readonly runtimeDependencies: { readonly [name: string]: string };
  readonly optionalDependencies: { readonly [name: string]: string };
  /**
   * What the build was made from (A's build, d449a54): the git commit, or null without git,
   * and whether the tree was dirty. Absent in a manifest from an older build, or when the
   * field is malformed.
   */
  readonly source?: { readonly commit: string | null; readonly dirty: boolean };
}

/** The manifest's `source`, only as a 40-hex commit (or null) and a boolean dirty flag. */
function manifestSource(value: unknown): { readonly commit: string | null; readonly dirty: boolean } | undefined {
  if (!isRecord(value) || typeof value.dirty !== 'boolean') return undefined;
  if (value.commit !== null && (typeof value.commit !== 'string' || !/^[0-9a-f]{40}$/.test(value.commit))) return undefined;
  return { commit: value.commit, dirty: value.dirty };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A relative, forward-slash path with no `..`, no empty segment and no absolute root. */
export function safeRelative(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > 512) return false;
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false; // path-hygiene: allow package-relative forward-slash path
  return path.split('/').every((part) => part !== '..' && part !== '.' && part.length > 0 && SAFE_SEGMENT.test(part));
}

function stringMap(value: unknown, keyOk: (key: string) => boolean): Record<string, string> | null {
  if (value === undefined) return {};
  if (!isRecord(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!keyOk(key) || typeof item !== 'string' || item.length === 0 || item.length > 256) return null;
    out[key] = item;
  }
  return out;
}

export function parseRuntimeManifest(text: string): RuntimeManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) return null;
  if (typeof parsed.name !== 'string' || !PACKAGE_NAME.test(parsed.name)) return null;
  if (typeof parsed.version !== 'string' || !VERSION.test(parsed.version)) return null;
  const entries = stringMap(parsed.entries, (key) => /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(key));
  if (entries === null || !Object.values(entries).every(safeRelative)) return null;
  for (const required of ['mcp', 'hook', 'cli']) if (entries[required] === undefined) return null;
  if (!Array.isArray(parsed.files) || parsed.files.length === 0 || parsed.files.length > 256) return null;
  const files: string[] = [];
  for (const item of parsed.files) {
    if (typeof item !== 'string') return null;
    const body = item.startsWith('!') ? item.slice(1) : item;
    if (body.length === 0 || body.length > 256 || body.includes('\\') || body.startsWith('/') || body.split('/').includes('..')) return null; // path-hygiene: allow package-relative forward-slash path
    files.push(item);
  }
  const runtimeDependencies = stringMap(parsed.runtimeDependencies, (key) => PACKAGE_NAME.test(key));
  const optionalDependencies = stringMap(parsed.optionalDependencies, (key) => PACKAGE_NAME.test(key));
  if (runtimeDependencies === null || optionalDependencies === null) return null;
  const engines = isRecord(parsed.engines) && typeof parsed.engines.node === 'string' ? { node: parsed.engines.node } : {};
  const source = manifestSource(parsed.source);
  return { schemaVersion: 1, name: parsed.name, version: parsed.version, engines, entries, files, runtimeDependencies, optionalDependencies, ...(source === undefined ? {} : { source }) };
}

async function readCapped(path: string, cap: number): Promise<string | null> {
  try {
    const st = await lstat(path);
    if (!st.isFile() || st.size > cap) return null;
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export async function readRuntimeManifest(packageRoot: string): Promise<RuntimeManifest | null> {
  const text = await readCapped(join(packageRoot, ...MANIFEST_REL), MANIFEST_CAP);
  return text === null ? null : parseRuntimeManifest(text);
}

/** npm-style `files` globs: `*` within a segment, `**` across segments. */
export function globRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i] ?? '';
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i += 1;
        if (pattern[i + 1] === '/') {
          i += 1;
          out += '(?:.*/)?';
        } else out += '.*';
      } else out += '[^/]*';
    } else if ('\\^$+?.()|{}[]'.includes(ch)) out += `\\${ch}`;
    else out += ch;
  }
  return new RegExp(`^${out}$`);
}

interface FileEntry {
  readonly rel: string;
  readonly abs: string;
}

async function walkTree(root: string, rel: string, out: FileEntry[], depth: number, skipNested: boolean): Promise<boolean> {
  if (depth > MAX_DEPTH || out.length > MAX_FILES) return false;
  let names: readonly string[];
  try {
    names = await readdir(join(root, ...rel.split('/').filter(Boolean)));
  } catch {
    return false;
  }
  for (const name of [...names].sort()) {
    const childRel = rel.length === 0 ? name : `${rel}/${name}`; // path-hygiene: allow package-relative forward-slash path
    const abs = join(root, ...childRel.split('/'));
    let st;
    try {
      st = await lstat(abs);
    } catch {
      return false;
    }
    if (st.isSymbolicLink()) {
      // A symlinked package directory (a workspace link) is copied by its target.
      let real: string;
      try {
        real = await realpath(abs);
        st = await lstat(real);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        const nested: FileEntry[] = [];
        if (!(await walkTree(real, '', nested, depth + 1, skipNested))) return false;
        for (const item of nested) out.push({ rel: `${childRel}/${item.rel}`, abs: item.abs }); // path-hygiene: allow package-relative forward-slash path
        continue;
      }
      if (st.isFile()) out.push({ rel: childRel, abs: real });
      continue;
    }
    if (st.isDirectory()) {
      if (skipNested && name === 'node_modules') continue;
      if (!(await walkTree(root, childRel, out, depth + 1, skipNested))) return false;
    } else if (st.isFile()) out.push({ rel: childRel, abs });
  }
  return true;
}

/** Every package file the manifest ships, as relative forward-slash paths (npm `files` rules). */
export async function shippedFiles(packageRoot: string, manifest: RuntimeManifest): Promise<FileEntry[] | null> {
  const excludes = manifest.files.filter((item) => item.startsWith('!')).map((item) => globRegExp(item.slice(1)));
  const out = new Map<string, FileEntry>();
  const includes = [...manifest.files.filter((item) => !item.startsWith('!')), 'package.json'];
  for (const include of includes) {
    const rel = include.replace(/\/+$/, '');
    if (!safeRelative(rel)) return null;
    const abs = join(packageRoot, ...rel.split('/'));
    let st;
    try {
      st = await lstat(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const found: FileEntry[] = [];
      if (!(await walkTree(packageRoot, rel, found, 0, true))) return null;
      for (const item of found) out.set(item.rel, item);
    } else if (st.isFile()) out.set(rel, { rel, abs });
  }
  const kept = [...out.values()].filter((item) => !excludes.some((pattern) => pattern.test(item.rel)));
  return kept.sort((left, right) => (left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0));
}

async function packageJson(dir: string): Promise<Record<string, unknown> | null> {
  const text = await readCapped(join(dir, 'package.json'), MANIFEST_CAP);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Node's lookup: `<dir>/node_modules/<name>` for `dir` and each ancestor. */
async function findModuleDir(fromDir: string, name: string): Promise<string | null> {
  let dir = fromDir;
  for (let depth = 0; depth < 32; depth += 1) {
    const candidate = join(dir, 'node_modules', ...name.split('/'));
    try {
      const st = await lstat(join(candidate, 'package.json'));
      if (st.isFile() || st.isSymbolicLink()) return await realpath(candidate);
    } catch {
      // Keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export interface DependencyCopy {
  readonly name: string;
  readonly from: string;
  /** Relative to the runtime root, forward slashes. */
  readonly to: string;
}

/**
 * The closure of runtime and installed optional dependencies, laid out flat under
 * `node_modules/`. A name already taken by a different directory nests under its
 * dependent, as npm would. A missing required dependency refuses the copy.
 */
export async function dependencyClosure(packageRoot: string, manifest: RuntimeManifest): Promise<DependencyCopy[] | null> {
  const placed = new Map<string, string>();
  const out: DependencyCopy[] = [];
  const queue: Array<{ name: string; fromDir: string; optional: boolean; parentTo: string | null }> = [];
  for (const name of Object.keys(manifest.runtimeDependencies)) queue.push({ name, fromDir: packageRoot, optional: false, parentTo: null });
  // Optional dependencies are optional: the test suite (JEVRIS_TEST=1) skips them so each
  // test install does not copy a 200 MB SDK binary.
  if (process.env.JEVRIS_TEST !== '1') {
    for (const name of Object.keys(manifest.optionalDependencies)) queue.push({ name, fromDir: packageRoot, optional: true, parentTo: null });
  }
  const seen = new Set<string>();
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    if (!PACKAGE_NAME.test(next.name)) return null;
    const dir = await findModuleDir(next.fromDir, next.name);
    if (dir === null) {
      if (next.optional) continue;
      return null;
    }
    if (seen.has(dir)) continue;
    seen.add(dir);
    const flat = `node_modules/${next.name}`;
    let to = flat;
    const taken = placed.get(flat);
    if (taken !== undefined && taken !== dir) {
      if (next.parentTo === null) return null;
      to = `${next.parentTo}/node_modules/${next.name}`; // path-hygiene: allow package-relative forward-slash path
    }
    placed.set(to, dir);
    out.push({ name: next.name, from: dir, to });
    const pkg = await packageJson(dir);
    if (pkg === null) return null;
    const deps = isRecord(pkg.dependencies) ? Object.keys(pkg.dependencies) : [];
    const optional = isRecord(pkg.optionalDependencies) ? Object.keys(pkg.optionalDependencies) : [];
    for (const name of deps) if (!optional.includes(name)) queue.push({ name, fromDir: dir, optional: false, parentTo: to });
    for (const name of optional) queue.push({ name, fromDir: dir, optional: true, parentTo: to });
    if (out.length > 2000) return null;
  }
  return out;
}

function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface RuntimePlanFile {
  readonly rel: string;
  readonly abs: string;
}

/**
 * Dependency files the runtime never loads: better-sqlite3's C sources and the prebuilt
 * binaries for other platforms. Everything else of a dependency is copied as installed.
 */
export function prunedDependencyFile(name: string, rel: string, platform: string = process.platform, arch: string = String(Reflect.get(process, 'arch') ?? '')): boolean {
  if (name !== 'better-sqlite3') return false;
  if (rel.startsWith('deps/') || rel.startsWith('src/')) return true;
  if (!rel.startsWith('prebuilds/')) return false;
  const file = rel.slice('prebuilds/'.length);
  const prefix = file.startsWith(`${platform}musl-`) ? `${platform}musl-` : `${platform}-`;
  return !(file.startsWith(prefix) && file === `${prefix}${arch}.node`);
}

export interface RuntimePlan {
  readonly manifest: RuntimeManifest;
  readonly files: readonly RuntimePlanFile[];
  readonly treeHash: string;
}

/** Lists and hashes everything the runtime copy will hold. */
export async function planRuntime(packageRoot: string, manifest: RuntimeManifest): Promise<RuntimePlan | { error: string }> {
  const shipped = await shippedFiles(packageRoot, manifest);
  if (shipped === null) return { error: 'the package files could not be listed' };
  for (const key of Object.keys(manifest.entries)) {
    const entry = manifest.entries[key];
    if (entry !== undefined && ['mcp', 'hook', 'cli'].includes(key) && !shipped.some((item) => item.rel === entry)) {
      return { error: `the package does not contain its ${key} entry (${entry}); rebuild with npm run build` };
    }
  }
  const deps = await dependencyClosure(packageRoot, manifest);
  if (deps === null) return { error: 'a runtime dependency is not installed next to the package; reinstall the package' };
  const files: RuntimePlanFile[] = [...shipped];
  const hash = createHash('sha256');
  // Package files by content; installed dependency files by size and time, which is enough to
  // tell whether an existing runtime copy can be reused.
  for (const file of shipped) {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(file.abs);
    } catch {
      return { error: `${file.rel} could not be read` };
    }
    hash.update(`${file.rel}\0${sha256(bytes)}\n`);
  }
  for (const dep of deps) {
    const found: FileEntry[] = [];
    if (!(await walkTree(dep.from, '', found, 0, true))) return { error: `dependency ${dep.name} could not be listed` };
    for (const item of found) {
      if (prunedDependencyFile(dep.name, item.rel)) continue;
      const rel = `${dep.to}/${item.rel}`; // path-hygiene: allow package-relative forward-slash path
      files.push({ rel, abs: item.abs });
      try {
        const st = await lstat(item.abs);
        hash.update(`${rel}\0${st.size}\0${Math.trunc(st.mtimeMs)}\n`);
      } catch {
        return { error: `${rel} could not be read` };
      }
    }
    if (files.length > MAX_FILES) return { error: 'the runtime has too many files' };
  }
  return { manifest, files, treeHash: hash.digest('hex') };
}

export interface RuntimeMarker {
  readonly name: string;
  readonly version: string;
  readonly treeHash: string;
  readonly files: number;
}

export async function readMarker(dir: string): Promise<RuntimeMarker | null> {
  const text = await readCapped(join(dir, RUNTIME_MARKER), 4096);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) return null;
    const { name, version, treeHash, files } = parsed;
    if (typeof name !== 'string' || typeof version !== 'string' || typeof treeHash !== 'string' || typeof files !== 'number') return null;
    return { name, version, treeHash, files };
  } catch {
    return null;
  }
}

export interface RuntimeCopy {
  readonly dir: string;
  readonly version: string;
  readonly treeHash: string;
  /** false when an identical runtime was already in place. */
  readonly created: boolean;
  /** A different runtime that stood at `dir`, moved aside until the install commits. */
  readonly displaced: string | null;
}

let seq = 0;
/** fs.constants.COPYFILE_FICLONE: try a clone, fall back to a plain copy. */
const COPYFILE_FICLONE = 2;

function nonce(): string {
  seq += 1;
  return sha256(`${Date.now()}\0${seq}\0${Math.random()}`).slice(0, 10);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

export function runtimeRoot(dataRoot: string): string {
  return join(dataRoot, 'runtime');
}

export function runtimeDir(dataRoot: string, version: string): string {
  return join(runtimeRoot(dataRoot), version);
}

/** Copies the planned runtime into `<data>/runtime/<version>/` (staged, then renamed in). */
export async function copyRuntime(dataRoot: string, plan: RuntimePlan): Promise<{ ok: true; copy: RuntimeCopy } | { ok: false; error: string }> {
  const version = plan.manifest.version;
  const dir = runtimeDir(dataRoot, version);
  const existing = await readMarker(dir);
  if (existing !== null && existing.treeHash === plan.treeHash && existing.version === version) {
    return { ok: true, copy: { dir, version, treeHash: plan.treeHash, created: false, displaced: null } };
  }
  const staging = join(runtimeRoot(dataRoot), `.staging-${nonce()}`);
  try {
    await mkdir(staging, { recursive: true });
    const made = new Set<string>();
    for (const file of plan.files) {
      const target = join(staging, ...file.rel.split('/'));
      const parent = dirname(target);
      if (!made.has(parent)) {
        await mkdir(parent, { recursive: true });
        made.add(parent);
      }
      // Copy-on-write clone where the file system supports it (APFS, Btrfs, ReFS), else a copy.
      await copyFile(file.abs, target, COPYFILE_FICLONE);
    }
    const marker: RuntimeMarker = { name: plan.manifest.name, version, treeHash: plan.treeHash, files: plan.files.length };
    await writeFile(join(staging, RUNTIME_MARKER), `${JSON.stringify(marker, null, 2)}\n`);
    let displaced: string | null = null;
    if (await exists(dir)) {
      displaced = join(runtimeRoot(dataRoot), `.displaced-${nonce()}`);
      await rename(dir, displaced);
    }
    try {
      await rename(staging, dir);
    } catch (error) {
      if (displaced !== null) await rename(displaced, dir);
      throw error;
    }
    return { ok: true, copy: { dir, version, treeHash: plan.treeHash, created: true, displaced } };
  } catch {
    try {
      await rm(staging, { recursive: true, force: true });
    } catch {
      // Left for the next install to clear.
    }
    return { ok: false, error: `the runtime could not be copied to ${dir}; check free space and permissions` };
  }
}

/** Undoes copyRuntime: removes a runtime it created and puts a displaced one back. */
export async function rollbackRuntime(copy: RuntimeCopy): Promise<void> {
  if (!copy.created) return;
  try {
    const marker = await readMarker(copy.dir);
    if (marker !== null && marker.treeHash === copy.treeHash) await rm(copy.dir, { recursive: true, force: true });
    if (copy.displaced !== null) await rename(copy.displaced, copy.dir);
  } catch {
    // The backup manifest still names the displaced runtime.
  }
}

/** Commits copyRuntime: drops a displaced runtime and any stale staging directory. */
export async function commitRuntime(dataRoot: string, copy: RuntimeCopy): Promise<void> {
  if (copy.displaced !== null) {
    try {
      await rm(copy.displaced, { recursive: true, force: true });
    } catch {
      // Removed by pruneRuntimes later.
    }
  }
  await pruneRuntimes(dataRoot, new Set([copy.version]), true);
}

/**
 * Removes runtime directories under `<data>/runtime` that carry the Jevris marker and are
 * not in `keep`, plus leftover staging directories. Anything without the marker stays.
 */
export async function pruneRuntimes(dataRoot: string, keep: ReadonlySet<string>, onlyLeftovers = false): Promise<boolean> {
  const root = runtimeRoot(dataRoot);
  let names: readonly string[];
  try {
    names = await readdir(root);
  } catch {
    return true;
  }
  let ok = true;
  for (const name of names) {
    const dir = join(root, name);
    const leftover = name.startsWith('.staging-') || name.startsWith('.displaced-');
    if (!leftover && (onlyLeftovers || keep.has(name))) continue;
    if (!leftover && (await readMarker(dir)) === null) continue;
    try {
      const st = await lstat(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) continue;
      await rm(dir, { recursive: true, force: true });
    } catch {
      ok = false;
    }
  }
  try {
    if ((await readdir(root)).length === 0) await rm(root, { recursive: true, force: true });
  } catch {
    // Not empty or already gone.
  }
  return ok;
}

/** Absolute path of a runtime entry (`mcp`, `hook`, `cli`, `claudeHook`, ...), or null. */
export function runtimeEntry(dir: string, manifest: RuntimeManifest, key: string): string | null {
  const rel = manifest.entries[key];
  if (rel === undefined || !safeRelative(rel)) return null;
  const abs = join(dir, ...rel.split('/'));
  const back = relative(dir, abs);
  if (back.startsWith('..') || isAbsolute(back)) return null;
  return abs;
}

/** Verifies an installed runtime against its marker (doctor). */
export async function verifyRuntime(dir: string): Promise<{ ok: boolean; detail: string }> {
  const marker = await readMarker(dir);
  if (marker === null) return { ok: false, detail: `no runtime at ${dir}; run jevris install` };
  const manifest = await readRuntimeManifest(dir);
  if (manifest === null) return { ok: false, detail: `the runtime at ${dir} has no manifest; run jevris install` };
  for (const key of ['mcp', 'hook', 'cli']) {
    const entry = runtimeEntry(dir, manifest, key);
    if (entry === null || !(await exists(entry))) return { ok: false, detail: `the runtime at ${dir} is missing its ${key} entry; run jevris install` };
  }
  return { ok: true, detail: `${manifest.name} ${manifest.version}` };
}

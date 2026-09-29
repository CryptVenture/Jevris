import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ensurePrivateDir, jevrisPaths, renameWithRetry, writePrivateFile } from '@jevris/platform';
import { scanHooks } from './hook-scan.js';
import { insertProperty, removePath } from './jsonc-edit.js';
import { casDelete } from './owned-install.js';

const PLUGIN_ID = 'jevris@skills-dir';
const BYTE_CAP = 131072;
export interface InstallInput {
  readonly home: string;
  readonly source: string;
  readonly enable?: boolean;
  readonly platform?: string;
  readonly afterSettingsRead?: () => void | Promise<void>;
}

export interface InstallResult {
  readonly ok: boolean;
  readonly installStatus: 'reduced' | 'unsupported' | 'refused';
  readonly changedPaths: readonly string[];
}

function refused(): InstallResult {
  return { ok: false, installStatus: 'refused', changedPaths: [] };
}

function copyStatus(_platform: string | undefined): 'reduced' {
  return 'reduced';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function hasDangerousKey(value: object): boolean {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || key === '__proto__' || key === 'prototype' || key === 'constructor') {
      return true;
    }
  }
  return false;
}

function treeUnsafe(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (treeUnsafe(item)) return true;
    }
    return false;
  }
  if (!isPlainObject(value) || hasDangerousKey(value)) return true;
  for (const key of Object.keys(value)) {
    if (treeUnsafe(value[key])) return true;
  }
  return false;
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  const Ctor = (globalThis as unknown as {
    TextDecoder?: new (label: string, options: { fatal: boolean }) => { decode(input?: Uint8Array): string };
  }).TextDecoder;
  if (Ctor === undefined) return undefined;
  try {
    return new Ctor('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function enabledDocument(parsed: Record<string, unknown>): Record<string, unknown> | null {
  if (treeUnsafe(parsed)) return null;
  const existing = parsed.enabledPlugins;
  const plugins: Record<string, unknown> = {};
  if (existing !== undefined) {
    if (!isPlainObject(existing) || hasDangerousKey(existing)) return null;
    for (const key of Object.keys(existing)) {
      plugins[key] = existing[key];
    }
  }
  plugins[PLUGIN_ID] = true;
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(parsed)) {
    if (key === 'enabledPlugins') continue;
    next[key] = parsed[key];
  }
  next.enabledPlugins = plugins;
  return next;
}

/**
 * Sets enabledPlugins["jevris@skills-dir"] = true through the JSONC editor, so the
 * user's formatting, key order and unrelated bytes stay as they are.
 */
function enabledText(decoded: string, parsed: Record<string, unknown>): string | null {
  const existing = parsed.enabledPlugins;
  if (isPlainObject(existing) && existing[PLUGIN_ID] === true) return decoded;
  let base = decoded;
  if (isPlainObject(existing) && Object.hasOwn(existing, PLUGIN_ID)) {
    const removed = removePath(base, ['enabledPlugins', PLUGIN_ID]);
    if (removed === null) return null;
    base = removed;
  }
  const inserted = insertProperty(base, ['enabledPlugins', PLUGIN_ID], true);
  return inserted === null ? null : inserted.text;
}

interface PreparedSettings {
  readonly path: string;
  readonly text: string;
  readonly priorHash: string | null;
}

async function readSettingsBytes(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

async function prepareEnable(
  settingsPath: string,
  afterSettingsRead: (() => void | Promise<void>) | undefined,
): Promise<PreparedSettings | null> {
  const prior = await readSettingsBytes(settingsPath);
  let priorHash: string | null = null;
  let text: string;
  if (prior !== null) {
    if (prior.byteLength > BYTE_CAP) return null;
    priorHash = sha256(prior);
    const decoded = decodeUtf8(prior);
    if (decoded === undefined) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded) as unknown;
    } catch {
      return null;
    }
    if (!isPlainObject(parsed)) return null;
    const next = enabledDocument(parsed);
    if (next === null) return null;
    const edited = enabledText(decoded, parsed);
    if (edited === null) return null;
    text = edited;
  } else {
    text = JSON.stringify({ enabledPlugins: { [PLUGIN_ID]: true } });
  }

  if (afterSettingsRead !== undefined) await afterSettingsRead();

  if (priorHash === null) {
    if ((await readSettingsBytes(settingsPath)) !== null) return null;
  } else {
    const again = await readSettingsBytes(settingsPath);
    if (again === null || sha256(again) !== priorHash) return null;
  }
  return { path: settingsPath, text, priorHash };
}

async function settingsUnchanged(prepared: PreparedSettings): Promise<boolean> {
  if (prepared.priorHash === null) {
    return (await readSettingsBytes(prepared.path)) === null;
  }
  const again = await readSettingsBytes(prepared.path);
  return again !== null && sha256(again) === prepared.priorHash;
}

async function writeSettings(prepared: PreparedSettings): Promise<boolean> {
  if (!(await settingsUnchanged(prepared))) return false;
  const temp = join(dirname(prepared.path), 'settings.json.jevris.tmp');
  try {
    await writeFile(temp, prepared.text);
    if (!(await settingsUnchanged(prepared))) {
      await rm(temp, { force: true });
      return false;
    }
    if (!(await renameWithRetry(temp, prepared.path)).ok) throw new Error('rename refused');
    return true;
  } catch {
    try {
      await rm(temp, { force: true });
    } catch {
      return false;
    }
    return false;
  }
}

interface CopiedTree {
  readonly files: Array<{ readonly path: string; readonly sha256: string }>;
  readonly dirs: string[];
}

/** Hashes exactly the files this install copied (source-relative), never other files in the folder. */
async function copiedTree(sourceRoot: string, destination: string, extra: readonly string[]): Promise<CopiedTree> {
  const out: CopiedTree = { files: [], dirs: [] };
  async function walk(rel: readonly string[]): Promise<void> {
    const names = await readdir(join(sourceRoot, ...rel));
    for (const name of [...names].sort()) {
      const st = await lstat(join(sourceRoot, ...rel, name));
      if (st.isSymbolicLink()) continue;
      const target = join(destination, ...rel, name);
      if (st.isDirectory()) {
        out.dirs.push(target);
        await walk([...rel, name]);
        continue;
      }
      if (st.isFile()) out.files.push({ path: target, sha256: sha256(await readFile(target)) });
    }
  }
  await walk([]);
  for (const path of extra) out.files.push({ path, sha256: sha256(await readFile(path)) });
  return out;
}

async function rollbackCopy(
  created: boolean,
  destination: string,
  receiptPath: string,
  copied: CopiedTree | null,
): Promise<void> {
  if (copied !== null) {
    for (const file of [...copied.files].reverse()) await casDelete(file.path, file.sha256);
    const dirs = created ? [...copied.dirs, destination] : [...copied.dirs];
    for (const dir of dirs.sort((left, right) => right.length - left.length)) {
      try {
        await rmdir(dir);
      } catch {
        continue;
      }
    }
  } else if (created) {
    try {
      await rm(destination, { recursive: true, force: true });
    } catch {
      return;
    }
  }
  try {
    await rm(receiptPath, { force: true });
  } catch {
    return;
  }
}

function staysInside(rootReal: string, candidateReal: string, expectedRel: string): boolean {
  const rel = relative(rootReal, candidateReal);
  if (rel.startsWith('..') || isAbsolute(rel)) return false;
  return rel === expectedRel;
}

async function boundedPath(resolvedHome: string, homeReal: string, expectedRel: string): Promise<string | null> {
  const expected = resolve(resolvedHome, expectedRel);
  if (relative(resolvedHome, expected) !== expectedRel) return null;
  const parts = expectedRel.split(/[/\\]/).filter((part) => part.length > 0);
  let current = resolvedHome;
  for (const part of parts) {
    current = join(current, part);
    let st;
    try {
      st = await lstat(current);
    } catch {
      return expected;
    }
    if (!st.isSymbolicLink()) continue;
    let real: string;
    try {
      real = await realpath(current);
    } catch {
      return null;
    }
    const rel = relative(homeReal, real);
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
  }
  try {
    const real = await realpath(expected);
    if (!staysInside(homeReal, real, expectedRel)) return null;
  } catch {
    return expected;
  }
  return expected;
}

export async function installPlugin(input: InstallInput): Promise<InstallResult> {
  try {
    if (typeof input.home !== 'string' || input.home.length === 0) return refused();
    if (typeof input.source !== 'string' || input.source.length === 0) return refused();
    const scanned = await scanHooks(input.source);
    if (!scanned.accepted) return refused();

    const resolvedHome = resolve(input.home);
    let homeReal: string;
    try {
      homeReal = await realpath(resolvedHome);
    } catch {
      return refused();
    }
    const destination = await boundedPath(resolvedHome, homeReal, join('.claude', 'skills', 'jevris'));
    const dataRoot = await boundedPath(resolvedHome, homeReal, relative(resolvedHome, jevrisPaths({ home: resolvedHome }).data));
    if (destination === null || dataRoot === null) return refused();

    let prepared: PreparedSettings | null = null;
    if (input.enable === true) {
      const settingsPath = await boundedPath(resolvedHome, homeReal, join('.claude', 'settings.json'));
      if (settingsPath === null) return refused();
      prepared = await prepareEnable(settingsPath, input.afterSettingsRead);
      if (prepared === null) return refused();
    }

    const sourceRoot = await realpath(input.source);
    let created = false;
    try {
      await lstat(destination);
    } catch {
      created = true;
    }
    const receiptPath = join(dataRoot, 'install-receipt.json');
    let copied: CopiedTree | null = null;
    const parentDirs: string[] = [];
    for (const rel of ['.claude', '.claude/skills']) {
      try {
        await lstat(join(resolvedHome, ...rel.split('/')));
      } catch {
        parentDirs.push(rel);
      }
    }
    try {
      await mkdir(resolve(destination, '..'), { recursive: true });
      await cp(sourceRoot, destination, { recursive: true, dereference: false });
      const extra: string[] = [];
      if (sourceRoot.endsWith(`${sep}plugins${sep}claude`)) {
        const bin = join(sourceRoot, '..', '..', 'bin', 'jevris.mjs');
        try {
          await lstat(bin);
          await mkdir(join(destination, 'bin'), { recursive: true });
          const pointer = join(destination, 'bin', 'jevris-bin.json');
          await writeFile(pointer, JSON.stringify({ bin }));
          extra.push(pointer);
        } catch {
          // Missing package bin. The copy still stands.
        }
      }
      copied = await copiedTree(sourceRoot, destination, extra);
      if (!(await ensurePrivateDir(dataRoot)).ok) throw new Error('data directory refused');
      // Home-relative, forward-slash paths: the uninstall rebases them on the real home,
      // so a symlinked home (macOS /var -> /private/var) still matches.
      const receipt = {
        schemaVersion: '1.0',
        pluginId: PLUGIN_ID,
        ownedPaths: [destination],
        files: copied.files.map((file) => ({
          path: relative(resolvedHome, file.path).split(sep).join('/'),
          sha256: file.sha256,
        })),
        dirs: parentDirs,
      };
      if (!(await writePrivateFile(receiptPath, JSON.stringify(receipt))).ok) throw new Error('receipt refused');
      if (prepared !== null) {
        const wrote = await writeSettings(prepared);
        if (!wrote) {
          await rollbackCopy(created, destination, receiptPath, copied);
          return refused();
        }
      }
      const installStatus = copyStatus(input.platform);
      const changedPaths = prepared === null ? [destination, receiptPath] : [destination, receiptPath, prepared.path];
      return {
        ok: true,
        installStatus,
        changedPaths,
      };
    } catch {
      await rollbackCopy(created, destination, receiptPath, copied);
      return refused();
    }
  } catch {
    return refused();
  }
}

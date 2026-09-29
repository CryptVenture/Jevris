import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { removePath } from './jsonc-edit.js';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { installReceiptPath, jevrisPaths, renameWithRetry } from '@jevris/platform';

const PLUGIN_ID = 'jevris@skills-dir';
const BYTE_CAP = 131072;
const SKILL_PARTS = ['.claude', 'skills', 'jevris'] as const;

export interface UninstallInput {
  readonly home: string;
  readonly afterSettingsRead?: () => void | Promise<void>;
}

export interface UninstallResult {
  readonly ok: boolean;
}

export interface DataDeleteInput {
  readonly home: string;
}

export interface DataDeleteResult {
  readonly ok: boolean;
}

function refused(): UninstallResult {
  return { ok: false };
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

function isEnoent(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return (error as { readonly code?: unknown }).code === 'ENOENT';
}

function escapes(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel.startsWith('..') || isAbsolute(rel);
}

async function readBytes(path: string): Promise<Uint8Array | null | 'error'> {
  try {
    return await readFile(path);
  } catch (error) {
    if (isEnoent(error)) return null;
    return 'error';
  }
}

function removedDocument(parsed: Record<string, unknown>): Record<string, unknown> | null {
  if (treeUnsafe(parsed)) return null;
  const existing = parsed.enabledPlugins;
  if (existing === undefined) return null;
  if (!isPlainObject(existing) || hasDangerousKey(existing)) return null;
  if (!Object.hasOwn(existing, PLUGIN_ID)) return null;
  const plugins: Record<string, unknown> = {};
  for (const key of Object.keys(existing)) {
    if (key === PLUGIN_ID) continue;
    plugins[key] = existing[key];
  }
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(parsed)) {
    if (key === 'enabledPlugins') continue;
    next[key] = parsed[key];
  }
  if (Object.keys(plugins).length > 0) {
    next.enabledPlugins = plugins;
  }
  return next;
}

/** Removes the Jevris key (and an enabledPlugins object it leaves empty) without reformatting. */
function removedText(decoded: string, next: Record<string, unknown>): string | null {
  const removed = removePath(decoded, ['enabledPlugins', PLUGIN_ID]);
  if (removed === null) return null;
  if (Object.hasOwn(next, 'enabledPlugins')) return removed;
  return removePath(removed, ['enabledPlugins']);
}

interface PreparedSettings {
  readonly path: string;
  readonly text: string;
  readonly priorHash: string;
}

async function settingsUnchanged(prepared: PreparedSettings): Promise<boolean> {
  const again = await readBytes(prepared.path);
  return again !== null && again !== 'error' && sha256(again) === prepared.priorHash;
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

async function regularFile(path: string): Promise<boolean> {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink() || !st.isFile()) return false;
    return (await realpath(path)) === path;
  } catch {
    return false;
  }
}

async function patchSettings(
  settingsPath: string,
  afterSettingsRead: (() => void | Promise<void>) | undefined,
): Promise<boolean> {
  const prior = await readBytes(settingsPath);
  if (prior === 'error') return false;
  let priorHash: string | null = null;
  let nextText: string | null = null;
  if (prior !== null) {
    priorHash = sha256(prior);
    if (prior.byteLength <= BYTE_CAP) {
      const decoded = decodeUtf8(prior);
      if (decoded !== undefined) {
        try {
          const parsed = JSON.parse(decoded) as unknown;
          if (isPlainObject(parsed)) {
            const next = removedDocument(parsed);
            if (next !== null) nextText = removedText(decoded, next);
          }
        } catch {
          nextText = null;
        }
      }
    }
  }

  if (afterSettingsRead !== undefined) await afterSettingsRead();

  if (priorHash === null) {
    if ((await readBytes(settingsPath)) !== null) return false;
  } else {
    const again = await readBytes(settingsPath);
    if (again === null || again === 'error' || sha256(again) !== priorHash) return false;
  }

  if (nextText === null || priorHash === null) return true;
  if (!(await regularFile(settingsPath))) return false;
  return writeSettings({ path: settingsPath, text: nextText, priorHash });
}

async function canonicalSkillDir(homeReal: string): Promise<string | null> {
  let current = homeReal;
  for (const part of SKILL_PARTS) {
    current = join(current, part);
    let st;
    try {
      st = await lstat(current);
    } catch {
      return null;
    }
    if (st.isSymbolicLink()) return null;
  }
  const claude = join(homeReal, '.claude');
  const dataRoot = jevrisPaths({ home: homeReal }).data;
  if (current === homeReal || current === claude || current === dataRoot) return null;
  let real: string;
  try {
    real = await realpath(current);
  } catch {
    return null;
  }
  if (real !== current || escapes(homeReal, real)) return null;
  return current;
}

interface OwnedFile {
  readonly path: string;
  readonly sha256: string;
}

interface Receipt {
  readonly ownedPaths: readonly string[];
  readonly files?: readonly OwnedFile[];
  readonly dirs?: readonly string[];
}

async function readReceipt(path: string): Promise<Receipt | null | 'invalid'> {
  const bytes = await readBytes(path);
  if (bytes === null) return null;
  if (bytes === 'error' || bytes.byteLength > BYTE_CAP) return 'invalid';
  const decoded = decodeUtf8(bytes);
  if (decoded === undefined) return 'invalid';
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    return 'invalid';
  }
  if (!isPlainObject(parsed) || hasDangerousKey(parsed) || !Array.isArray(parsed.ownedPaths)) return 'invalid';
  const ownedPaths: string[] = [];
  for (const item of parsed.ownedPaths) {
    if (typeof item === 'string') ownedPaths.push(item);
  }
  if (parsed.files === undefined) return { ownedPaths };
  if (!Array.isArray(parsed.files)) return 'invalid';
  const files: OwnedFile[] = [];
  for (const item of parsed.files) {
    if (!isPlainObject(item) || typeof item.path !== 'string' || typeof item.sha256 !== 'string') return 'invalid';
    if (!/^[0-9a-f]{64}$/.test(item.sha256)) return 'invalid';
    files.push({ path: item.path, sha256: item.sha256 });
  }
  const dirs: string[] = [];
  if (parsed.dirs !== undefined) {
    if (!Array.isArray(parsed.dirs)) return 'invalid';
    for (const dir of parsed.dirs) {
      if (dir !== '.claude' && dir !== '.claude/skills') return 'invalid';
      dirs.push(dir);
    }
  }
  return { ownedPaths, files, dirs };
}

async function pathIsUnderSkill(skillDir: string, homeReal: string, listed: string): Promise<boolean> {
  if (listed.length === 0) return false;
  const resolved = isAbsolute(listed) ? resolve(listed) : resolve(homeReal, listed);
  let real: string;
  try {
    real = await realpath(resolved);
  } catch {
    return false;
  }
  const dataRoot = jevrisPaths({ home: homeReal }).data;
  if (real === homeReal || real === join(homeReal, '.claude') || real === dataRoot) return false;
  if (!escapes(dataRoot, real)) return false;
  if (escapes(skillDir, real)) return false;
  return true;
}

async function pluginNameIsJevris(skillDir: string): Promise<boolean> {
  const bytes = await readBytes(join(skillDir, '.claude-plugin', 'plugin.json'));
  if (bytes === null || bytes === 'error' || bytes.byteLength > BYTE_CAP) return false;
  const decoded = decodeUtf8(bytes);
  if (decoded === undefined) return false;
  try {
    const parsed = JSON.parse(decoded) as unknown;
    return isPlainObject(parsed) && !hasDangerousKey(parsed) && parsed.name === 'jevris';
  } catch {
    return false;
  }
}

async function removeOwnedSkill(homeReal: string, receipt: Receipt | null): Promise<boolean> {
  const skillDir = await canonicalSkillDir(homeReal);
  if (skillDir === null) return true;
  let owned = false;
  if (receipt === null) {
    owned = await pluginNameIsJevris(skillDir);
  } else {
    for (const listed of receipt.ownedPaths) {
      if (await pathIsUnderSkill(skillDir, homeReal, listed)) {
        owned = true;
        break;
      }
    }
  }
  if (!owned) return true;
  if (skillDir !== join(homeReal, '.claude', 'skills', 'jevris')) return false;
  if (receipt !== null && receipt.files !== undefined) {
    await removeHashedFiles(homeReal, skillDir, receipt.files);
    // Parent folders this install created, removed only when empty, deepest first.
    for (const dir of [...(receipt.dirs ?? [])].sort((left, right) => right.length - left.length)) {
      try {
        await rmdir(join(homeReal, ...dir.split('/')));
      } catch {
        continue;
      }
    }
    return true;
  }
  await rm(skillDir, { recursive: true, force: true });
  return true;
}

/**
 * Receipt-bound removal (FIX-16): a listed file under the skill folder is removed only
 * when its bytes still hash to the receipt; then empty folders are removed bottom-up.
 * Files the receipt does not list, or that changed, stay.
 */
async function removeHashedFiles(homeReal: string, skillDir: string, files: readonly OwnedFile[]): Promise<boolean> {
  const dirs = new Set<string>();
  for (const listed of files) {
    const parts = listed.path.split(/[/\\]/);
    if (isAbsolute(listed.path) || parts.some((part) => part === '..' || part === '')) continue;
    const file = { path: join(homeReal, ...parts), sha256: listed.sha256 };
    const rel = relative(skillDir, file.path);
    if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) continue;
    let st;
    try {
      st = await lstat(file.path);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const bytes = await readBytes(file.path);
    if (bytes === null || bytes === 'error' || sha256(bytes) !== file.sha256) continue;
    await rm(file.path, { force: true });
    let dir = dirname(file.path);
    while (dir.length > skillDir.length && !escapes(skillDir, dir)) {
      dirs.add(dir);
      dir = dirname(dir);
    }
  }
  for (const dir of [...dirs, skillDir].sort((left, right) => right.length - left.length)) {
    try {
      await rmdir(dir);
    } catch {
      continue;
    }
  }
  return true;
}

export async function uninstallPlugin(input: UninstallInput): Promise<UninstallResult> {
  try {
    if (typeof input.home !== 'string' || input.home.length === 0) return refused();
    const resolvedHome = resolve(input.home);
    let homeReal: string;
    try {
      homeReal = await realpath(resolvedHome);
    } catch {
      return refused();
    }
    const receiptPath = installReceiptPath(jevrisPaths({ home: homeReal }));
    const receipt = await readReceipt(receiptPath);
    if (receipt === 'invalid') return refused();

    const settingsPath = join(homeReal, '.claude', 'settings.json');
    const patched = await patchSettings(settingsPath, input.afterSettingsRead);
    if (!patched) return refused();

    const removed = await removeOwnedSkill(homeReal, receipt);
    if (!removed) return refused();
    return { ok: true };
  } catch {
    return refused();
  }
}

function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Removes one Jevris data root: never a symlink, never the home, never under ~/.claude. */
async function removeDataRoot(homeReal: string, root: string): Promise<boolean> {
  const claude = join(homeReal, '.claude');
  if (root === homeReal || root === claude || escapes(homeReal, root)) return false;
  let st;
  try {
    st = await lstat(root);
  } catch (error) {
    return isEnoent(error);
  }
  if (st.isSymbolicLink()) return false;
  let real: string;
  try {
    real = await realpath(root);
  } catch {
    return false;
  }
  if (real !== root || real === homeReal || isInside(claude, real) || escapes(homeReal, real)) return false;
  await rm(root, { recursive: true, force: true });
  return true;
}

export async function deleteJevrisData(input: DataDeleteInput): Promise<DataDeleteResult> {
  try {
    if (typeof input.home !== 'string' || input.home.length === 0) return { ok: false };
    const resolvedHome = resolve(input.home);
    let homeReal: string;
    try {
      homeReal = await realpath(resolvedHome);
    } catch {
      return { ok: false };
    }
    const paths = jevrisPaths({ home: homeReal });
    // data holds state and run on darwin and win32; linux keeps state (and run) apart.
    const roots = isInside(paths.data, paths.state) ? [paths.data] : [paths.data, paths.state];
    // A pre-migration ~/.jevris on linux or win32 is Jevris data too (BLD-02).
    if (paths.legacyData !== paths.data && !isInside(paths.data, paths.legacyData)) roots.push(paths.legacyData);
    for (const root of roots) {
      if (!(await removeDataRoot(homeReal, root))) return { ok: false };
    }
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

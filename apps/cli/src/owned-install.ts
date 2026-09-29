import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { jevrisPaths, renameWithRetry, writePrivateFile } from '@jevris/platform';
import {
  appendItem,
  findNode,
  insertProperty,
  nodeValue,
  parseJsoncTree,
  removePath,
  toPointer,
  undoSplices,
  type JsonPath,
  type Splice,
} from './jsonc-edit.js';
import { removeTomlTables, scanToml } from './toml-edit.js';

/**
 * Install transactions for harness surfaces (phase 25, FIX-01..04, FIX-15, FIX-16).
 *
 * Owned files: files this install created, recorded as {path, sha256}. Removal (uninstall
 * or rollback) deletes a file only when its path is in the receipt and its bytes still
 * hash to the recorded value, then removes directories this install created, only when
 * they are empty.
 *
 * Shared-file edits: recorded as {file, pointer | table, preHash, postHash, splices}. The
 * splices hold only the text Jevris inserted. When the file still hashes to postHash,
 * uninstall removes exactly those splices, so the file is byte-identical to its
 * pre-install state. When the user changed the file, uninstall removes only the Jevris
 * key, table or handlers. A shared file is never deleted unless Jevris created it and it
 * is still byte-identical to what Jevris wrote.
 *
 * Every shared-file write is compare-and-swap: the bytes must still hash to what was
 * read, checked before a temp write and again before the rename.
 */

export const BYTE_CAP = 131072;
export const RECEIPT_SCHEMA = '2.0';

export interface HomePair {
  readonly resolvedHome: string;
  readonly homeReal: string;
}

export interface TxnHooks {
  readonly afterConfigRead?: (path: string) => void | Promise<void>;
}

export type StripSpec =
  | { readonly kind: 'json-key'; readonly path: readonly string[]; readonly keep?: number }
  /** Several keys in one file, set and removed as one edit (Claude settings: a marketplace and its enable key). */
  | { readonly kind: 'json-keys'; readonly keys: ReadonlyArray<{ readonly path: readonly string[]; readonly keep?: number }> }
  | { readonly kind: 'codex-hooks' }
  | { readonly kind: 'json-array-name'; readonly path: readonly string[]; readonly name: string }
  | { readonly kind: 'toml-table'; readonly table: readonly string[] };

export interface EditRecord {
  readonly file: string;
  readonly format: 'json' | 'toml';
  readonly pointer?: string;
  readonly table?: string;
  readonly strip: StripSpec;
  readonly preHash: string | null;
  readonly postHash: string;
  readonly splices: readonly Splice[];
  readonly created: boolean;
  readonly blank?: string;
}

export interface OwnedFileRecord {
  readonly path: string;
  readonly sha256: string;
}

export interface ReceiptV2 {
  readonly schemaVersion: '2.0';
  readonly pluginId: string;
  readonly files: readonly OwnedFileRecord[];
  readonly dirs: readonly string[];
  readonly edits: readonly EditRecord[];
}

function partsOf(rel: string): string[] {
  return rel.split(/[/\\]/).filter((part) => part.length > 0);
}

function sameRel(root: string, candidate: string, expectedRel: string): boolean {
  const rel = relative(root, candidate);
  if (rel.startsWith('..') || isAbsolute(rel)) return false;
  return partsOf(rel).join('/') === partsOf(expectedRel).join('/');
}

export async function homePair(home: string): Promise<HomePair | null> {
  if (typeof home !== 'string' || home.length === 0) return null;
  const resolvedHome = resolve(home);
  try {
    return { resolvedHome, homeReal: await realpath(resolvedHome) };
  } catch {
    return null;
  }
}

/** Resolves `expectedRel` under home. Refuses a path whose symlinked components leave home. */
export async function boundedPath(pair: HomePair, expectedRel: string): Promise<string | null> {
  const expected = resolve(pair.resolvedHome, ...partsOf(expectedRel));
  if (!sameRel(pair.resolvedHome, expected, expectedRel)) return null;
  let current = pair.resolvedHome;
  for (const part of partsOf(expectedRel)) {
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
    const rel = relative(pair.homeReal, real);
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
  }
  try {
    const real = await realpath(expected);
    if (!sameRel(pair.homeReal, real, expectedRel)) return null;
  } catch {
    return expected;
  }
  return expected;
}

/** The Jevris data directory relative to the home, for boundedPath (BLD-02). */
export function dataRel(pair: HomePair): string {
  return relative(pair.resolvedHome, jevrisPaths({ home: pair.resolvedHome }).data);
}

export function insideHome(pair: HomePair, abs: string): boolean {
  if (typeof abs !== 'string' || abs.length === 0 || !isAbsolute(abs)) return false;
  const rel = relative(pair.resolvedHome, abs);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

export function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
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

export function decodeText(bytes: Uint8Array): string | undefined {
  return decodeUtf8(bytes);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
}

/** Bytes, null when absent, 'error' on any other failure. */
export async function readBytes(path: string): Promise<Uint8Array | null | 'error'> {
  try {
    const st = await lstat(path);
    if (!st.isFile()) return 'error';
    return await readFile(path);
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? null : 'error';
  }
}

function matches(bytes: Uint8Array | null | 'error', hash: string | null): boolean {
  if (bytes === 'error') return false;
  if (hash === null) return bytes === null;
  return bytes !== null && sha256(bytes) === hash;
}

let counter = 0;
function nonce(path: string): string {
  counter += 1;
  return sha256(`${path}\0${Date.now()}\0${counter}\0${Math.random()}`).slice(0, 12);
}

async function fileMode(path: string): Promise<number | undefined> {
  try {
    return (await lstat(path)).mode & 0o777;
  } catch {
    return undefined;
  }
}

/** Compare-and-swap write. `expected` is the hash the file must still have (null: must be absent). */
export async function casWrite(path: string, expected: string | null, data: Uint8Array | string): Promise<boolean> {
  if (!matches(await readBytes(path), expected)) return false;
  if (!(await journalBefore(path))) return false;
  const mode = await fileMode(path);
  const temp = join(dirname(path), `.${basename(path)}.jevris-${nonce(path)}.tmp`);
  try {
    await writeFile(temp, data, mode === undefined ? { flag: 'wx' } : { flag: 'wx', mode });
    if (!matches(await readBytes(path), expected)) {
      await rm(temp, { force: true });
      return false;
    }
    if (!(await renameWithRetry(temp, path)).ok) throw new Error('rename refused');
    journalAfter(path, sha256(data));
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

export async function casDelete(path: string, expected: string): Promise<boolean> {
  if (!matches(await readBytes(path), expected)) return false;
  if (!(await journalBefore(path))) return false;
  try {
    await unlink(path);
    journalAfter(path, null);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Jevris entry recognition and key-scoped strip.

const CODEX_MARKERS = ['/.codex/jevris/hook.js', '.codex/hooks/jevris.js'];

export function isJevrisCodexHandler(handler: unknown): boolean {
  if (handler === null || typeof handler !== 'object' || Array.isArray(handler)) return false;
  for (const field of ['command', 'commandWindows', 'command_windows']) {
    const value = Reflect.get(handler, field);
    if (typeof value !== 'string') continue;
    const normalized = value.split('\\').join('/');
    if (CODEX_MARKERS.some((marker) => normalized.includes(marker))) return true;
  }
  return false;
}

function objectAt(text: string, path: JsonPath): unknown {
  const root = parseJsoncTree(text);
  if (root === null) return undefined;
  const node = findNode(root, path);
  return node === undefined ? undefined : nodeValue(node);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Removes `path`, then each parent object that this removal left empty (never the root).
 * Parents at depth `keep` or shallower existed before the install and always stay.
 */
function removeKeyAndEmptiedParents(text: string, path: readonly string[], keep = 0): string | null {
  let out = removePath(text, path);
  if (out === null) return null;
  if (out === text) return text;
  for (let depth = path.length - 1; depth > Math.max(0, keep); depth -= 1) {
    const parentPath = path.slice(0, depth);
    const parent = objectAt(out, parentPath);
    if (!isPlainRecord(parent) || Object.keys(parent).length > 0) break;
    const next = removePath(out, parentPath);
    if (next === null) return null;
    out = next;
  }
  return out;
}

function stripCodexHooks(text: string): string | null {
  let out = text;
  for (let guard = 0; guard < 10000; guard += 1) {
    const root = parseJsoncTree(out);
    if (root === null) return null;
    const hooksNode = findNode(root, ['hooks']);
    if (hooksNode === undefined || hooksNode.type !== 'object') return out;
    let changed = false;
    for (const member of hooksNode.members ?? []) {
      if (member.value.type !== 'array') continue;
      const groups = nodeValue(member.value);
      if (!Array.isArray(groups)) continue;
      for (let gi = 0; gi < groups.length && !changed; gi += 1) {
        const group: unknown = groups[gi];
        if (!isPlainRecord(group) || !Array.isArray(group.hooks)) continue;
        const handlers: unknown[] = group.hooks;
        const ours = handlers.map(isJevrisCodexHandler);
        if (!ours.some(Boolean)) continue;
        let next: string | null;
        if (ours.every(Boolean)) {
          next = removePath(out, ['hooks', member.key, gi]);
          if (next !== null && groups.length === 1) {
            const emptied = objectAt(next, ['hooks', member.key]);
            if (Array.isArray(emptied) && emptied.length === 0) next = removePath(next, ['hooks', member.key]);
          }
        } else {
          next = removePath(out, ['hooks', member.key, gi, 'hooks', ours.indexOf(true)]);
        }
        if (next === null) return null;
        out = next;
        changed = true;
      }
      if (changed) break;
    }
    if (!changed) {
      const hooks = objectAt(out, ['hooks']);
      if (isPlainRecord(hooks) && Object.keys(hooks).length === 0 && out !== text) {
        const next = removePath(out, ['hooks']);
        if (next === null) return null;
        return next;
      }
      return out;
    }
  }
  return null;
}

function stripArrayByName(text: string, path: readonly string[], name: string): string | null {
  let out = text;
  for (let guard = 0; guard < 1000; guard += 1) {
    const items = objectAt(out, path);
    if (items === undefined) {
      return parseJsoncTree(out) === null ? null : out;
    }
    if (!Array.isArray(items)) return out;
    const index = items.findIndex((item) => isPlainRecord(item) && item.name === name);
    if (index === -1) return out;
    const next = removePath(out, [...path, index]);
    if (next === null) return null;
    out = next;
  }
  return null;
}

/** Removes only Jevris entries. Returns null when the file cannot be read as its format. */
export function stripText(text: string, spec: StripSpec): string | null {
  if (text.trim().length === 0) return text;
  if (spec.kind === 'toml-table') return removeTomlTables(text, spec.table);
  const root = parseJsoncTree(text);
  if (root === null) return null;
  if (spec.kind === 'json-key') return removeKeyAndEmptiedParents(text, spec.path, spec.keep ?? 0);
  if (spec.kind === 'json-keys') {
    let current: string | null = text;
    for (const key of spec.keys) {
      if (current === null) return null;
      current = removeKeyAndEmptiedParents(current, key.path, key.keep ?? 0);
    }
    return current;
  }
  if (spec.kind === 'codex-hooks') return stripCodexHooks(text);
  return stripArrayByName(text, spec.path, spec.name);
}

/** Records how much of a json-key path already existed, so uninstall never removes it. */
function keepExisting(spec: StripSpec, base: string): StripSpec {
  const keepOf = (path: readonly string[]): number => {
    let keep = 0;
    for (let depth = 1; depth < path.length; depth += 1) {
      if (!isPlainRecord(objectAt(base, path.slice(0, depth)))) break;
      keep = depth;
    }
    return keep;
  };
  if (spec.kind === 'json-keys') return { kind: 'json-keys', keys: spec.keys.map((key) => ({ path: key.path, keep: keepOf(key.path) })) };
  if (spec.kind !== 'json-key') return spec;
  return { kind: 'json-key', path: spec.path, keep: keepOf(spec.path) };
}

/** Inserts several keys in order; the splices undo in reverse (see undoSplices). */
export function applyJsonKeys(base: string, entries: ReadonlyArray<readonly [readonly string[], unknown]>): Applied | null {
  let text = base;
  const splices: Splice[] = [];
  for (const [path, value] of entries) {
    const applied = applyJsonKey(text, path, value);
    if (applied === null) return null;
    text = applied.text;
    splices.push(...applied.splices);
  }
  return { text, splices };
}

export function validFormat(text: string, format: 'json' | 'toml'): boolean {
  if (text.trim().length === 0) return true;
  if (format === 'toml') return scanToml(text) !== null;
  const root = parseJsoncTree(text);
  return root !== null && root.type === 'object';
}

// ---------------------------------------------------------------------------
// Insertions used by the harness installers.

export interface Applied {
  readonly text: string;
  readonly splices: readonly Splice[];
}

/** Inserts `value` at `path` in a JSON(C) object document as one splice. */
export function applyJsonKey(base: string, path: readonly string[], value: unknown): Applied | null {
  const edited = insertProperty(base, path, value);
  return edited === null ? null : { text: edited.text, splices: [edited.splice] };
}

/** Appends a group per event to `hooks.<event>`, creating missing arrays or the hooks object. */
export function applyCodexHooks(base: string, groups: Readonly<Record<string, unknown>>): Applied | null {
  let text = base;
  const splices: Splice[] = [];
  const root = parseJsoncTree(text);
  if (root === null || root.type !== 'object') return null;
  const hooks = findNode(root, ['hooks']);
  if (hooks === undefined) {
    const arrays: Record<string, unknown> = {};
    for (const [event, group] of Object.entries(groups)) arrays[event] = [group];
    const added = insertProperty(text, ['hooks'], arrays);
    return added === null ? null : { text: added.text, splices: [added.splice] };
  }
  if (hooks.type !== 'object') return null;
  for (const [event, group] of Object.entries(groups)) {
    const current = findNode(parseJsoncTree(text) ?? root, ['hooks', event]);
    const edited =
      current === undefined
        ? insertProperty(text, ['hooks', event], [group])
        : current.type === 'array'
          ? appendItem(text, ['hooks', event], group)
          : null;
    if (edited === null) return null;
    text = edited.text;
    splices.push(edited.splice);
  }
  return { text, splices };
}

/** Appends `entry` to the array at `path`, creating the array when it is missing. */
export function applyArrayEntry(base: string, path: readonly string[], entry: unknown): Applied | null {
  const root = parseJsoncTree(base);
  if (root === null || root.type !== 'object') return null;
  const node = findNode(root, path);
  const edited =
    node === undefined ? insertProperty(base, path, [entry]) : node.type === 'array' ? appendItem(base, path, entry) : null;
  return edited === null ? null : { text: edited.text, splices: [edited.splice] };
}

// ---------------------------------------------------------------------------
// The transaction.

interface Planned {
  readonly file: string;
  readonly readHash: string | null;
  readonly original: Uint8Array | null;
  readonly postText: string;
  readonly record: EditRecord;
}

export interface EditPlan {
  readonly format: 'json' | 'toml';
  readonly strip: StripSpec;
  readonly template: string;
  readonly apply: (base: string) => Applied | null;
  readonly pointer?: string;
  readonly table?: string;
}

export class InstallTxn {
  private readonly files = new Map<string, string>();
  private readonly dirs: string[] = [];
  private readonly planned: Planned[] = [];
  private readonly written: Planned[] = [];

  /** Dry run: files are listed, never written; edits are planned, never committed. */
  readonly plannedFiles: Array<{ readonly path: string; readonly exists: boolean }> = [];

  constructor(
    readonly pair: HomePair,
    readonly hooks: TxnHooks = {},
    readonly dryRun = false,
  ) {}

  /** The shared-file edits this transaction planned (dry run and apply). */
  plannedEdits(): readonly EditRecord[] {
    return this.planned.map((planned) => planned.record);
  }

  /** Creates each missing directory from home down to `abs`, recording the ones it created. */
  async ensureDir(abs: string): Promise<boolean> {
    if (!insideHome(this.pair, abs)) return false;
    if (this.dryRun) return true;
    let current = this.pair.resolvedHome;
    for (const part of partsOf(relative(this.pair.resolvedHome, abs))) {
      current = join(current, part);
      try {
        const st = await lstat(current);
        if (st.isSymbolicLink()) {
          const real = await realpath(current);
          const rel = relative(this.pair.homeReal, real);
          if (rel.startsWith('..') || isAbsolute(rel)) return false;
          if (!(await lstat(real)).isDirectory()) return false;
          continue;
        }
        if (!st.isDirectory()) return false;
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') return false;
        try {
          await mkdir(current);
        } catch {
          return false;
        }
        journalDirCreated(current);
        this.dirs.push(current);
      }
    }
    return true;
  }

  /**
   * Writes an owned file. A file this transaction did not write is never overwritten:
   * identical bytes are accepted and left unrecorded (not ours), different bytes refuse.
   */
  async writeOwned(abs: string, data: Uint8Array | string): Promise<boolean> {
    if (!insideHome(this.pair, abs)) return false;
    if (this.dryRun) {
      const existing = await readBytes(abs);
      if (existing === 'error') return false;
      if (!this.plannedFiles.some((file) => file.path === abs)) this.plannedFiles.push({ path: abs, exists: existing !== null });
      return true;
    }
    if (!(await this.ensureDir(dirname(abs)))) return false;
    const bytes = typeof data === 'string' ? encodeUtf8(data) : data;
    if (bytes === undefined) return false;
    if (this.files.has(abs)) {
      const ok = await casWrite(abs, this.files.get(abs) ?? null, bytes);
      if (ok) this.files.set(abs, sha256(bytes));
      return ok;
    }
    const existing = await readBytes(abs);
    if (existing === 'error') return false;
    if (existing !== null) return sameBytes(existing, bytes);
    if (!(await journalBefore(abs))) return false;
    try {
      await writeFile(abs, bytes, { flag: 'wx' });
    } catch {
      return false;
    }
    journalAfter(abs, sha256(bytes));
    this.files.set(abs, sha256(bytes));
    return true;
  }

  async copyOwned(source: string, abs: string): Promise<boolean> {
    let bytes: Uint8Array;
    try {
      const st = await lstat(source);
      if (!st.isFile()) return false;
      bytes = await readFile(source);
    } catch {
      return false;
    }
    return this.writeOwned(abs, bytes);
  }

  async copyTreeOwned(sourceDir: string, absDir: string): Promise<boolean> {
    let names: readonly string[];
    try {
      const st = await lstat(sourceDir);
      if (!st.isDirectory()) return false;
      names = await readdir(sourceDir);
    } catch {
      return false;
    }
    if (!(await this.ensureDir(absDir))) return false;
    for (const name of [...names].sort()) {
      const from = join(sourceDir, name);
      const to = join(absDir, name);
      let st;
      try {
        st = await lstat(from);
      } catch {
        return false;
      }
      if (st.isSymbolicLink()) return false;
      const ok = st.isDirectory() ? await this.copyTreeOwned(from, to) : await this.copyOwned(from, to);
      if (!ok) return false;
    }
    return true;
  }

  /** Reads a shared file, cleans stale Jevris entries, applies the insertion, and plans a CAS write. */
  async planEdit(abs: string, plan: EditPlan): Promise<boolean> {
    if (!insideHome(this.pair, abs)) return false;
    const bytes = await readBytes(abs);
    if (bytes === 'error') return false;
    if (bytes !== null && bytes.byteLength > BYTE_CAP) return false;
    const text = bytes === null ? null : decodeUtf8(bytes);
    if (text === undefined) return false;
    if (this.hooks.afterConfigRead !== undefined) await this.hooks.afterConfigRead(abs);
    const created = text === null;
    const blank = text !== null && text.trim().length === 0 ? text : undefined;
    let base: string;
    if (created || blank !== undefined) {
      base = plan.template;
    } else {
      if (!validFormat(text, plan.format)) return false;
      const cleaned = stripText(text, plan.strip);
      if (cleaned === null) return false;
      base = cleaned;
    }
    const strip = keepExisting(plan.strip, base);
    const applied = plan.apply(base);
    if (applied === null) return false;
    if (undoSplices(applied.text, applied.splices) !== base) return false;
    if (!validFormat(applied.text, plan.format)) return false;
    const record: EditRecord = {
      file: abs,
      format: plan.format,
      ...(plan.pointer === undefined ? {} : { pointer: plan.pointer }),
      ...(plan.table === undefined ? {} : { table: plan.table }),
      strip,
      preHash: created ? null : sha256(blank ?? base),
      postHash: sha256(applied.text),
      splices: applied.splices,
      created,
      ...(blank === undefined ? {} : { blank }),
    };
    this.planned.push({
      file: abs,
      readHash: bytes === null ? null : sha256(bytes),
      original: bytes,
      postText: applied.text,
      record,
    });
    return true;
  }

  /** Writes every planned edit with CAS. Stops at the first refusal. */
  async commitEdits(): Promise<boolean> {
    if (this.dryRun) return true;
    for (const planned of this.planned) {
      if (!(await this.ensureDir(dirname(planned.file)))) return false;
      const ok = await casWrite(planned.file, planned.readHash, planned.postText);
      if (!ok) return false;
      this.written.push(planned);
    }
    return true;
  }

  /** Undoes this transaction. Only bytes that still match what it wrote are touched. */
  async rollback(): Promise<void> {
    for (const planned of [...this.written].reverse()) {
      const postHash = planned.record.postHash;
      if (planned.original === null) {
        await casDelete(planned.file, postHash);
      } else {
        await casWrite(planned.file, postHash, planned.original);
      }
    }
    for (const [path, hash] of [...this.files.entries()].reverse()) {
      await casDelete(path, hash);
    }
    for (const dir of [...this.dirs].reverse()) {
      try {
        await rmdir(dir);
      } catch {
        continue;
      }
    }
  }

  receipt(pluginId: string): ReceiptV2 {
    return {
      schemaVersion: RECEIPT_SCHEMA,
      pluginId,
      files: [...this.files.entries()].map(([path, hash]) => ({ path, sha256: hash })),
      dirs: [...this.dirs],
      edits: this.planned.map((planned) => planned.record),
    };
  }

  /** Writes the home-relative receipt (owner-only where the OS honours modes). */
  async writeReceipt(path: string, pluginId: string, extra: Readonly<Record<string, unknown>> = {}): Promise<boolean> {
    const text = serializeReceipt(this.pair, this.receipt(pluginId), extra);
    return text !== null && journaledPrivateWrite(path, text);
  }
}

function encodeUtf8(text: string): Uint8Array | undefined {
  const Ctor = (globalThis as unknown as { TextEncoder?: new () => { encode(input?: string): Uint8Array } }).TextEncoder;
  return Ctor === undefined ? undefined : new Ctor().encode(text);
}

// ---------------------------------------------------------------------------
// Uninstall by receipt.

function isStripSpec(value: unknown): value is StripSpec {
  if (!isPlainRecord(value)) return false;
  const stringList = (list: unknown): boolean => Array.isArray(list) && list.every((part) => typeof part === 'string');
  if (value.kind === 'json-keys') {
    return (
      Array.isArray(value.keys) &&
      value.keys.length > 0 &&
      value.keys.every((key: unknown) => isPlainRecord(key) && stringList(key.path) && (key.keep === undefined || (Number.isInteger(key.keep) && (key.keep as number) >= 0)))
    );
  }
  if (value.kind === 'json-key') {
    return stringList(value.path) && (value.keep === undefined || (Number.isInteger(value.keep) && (value.keep as number) >= 0));
  }
  if (value.kind === 'codex-hooks') return true;
  if (value.kind === 'json-array-name') return stringList(value.path) && typeof value.name === 'string';
  if (value.kind === 'toml-table') return stringList(value.table);
  return false;
}

function isSplice(value: unknown): value is Splice {
  return isPlainRecord(value) && Number.isInteger(value.at) && typeof value.text === 'string';
}

const HEX = /^[0-9a-f]{64}$/;

export function parseReceiptV2(text: string, pluginId: string): ReceiptV2 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainRecord(parsed) || parsed.schemaVersion !== RECEIPT_SCHEMA || parsed.pluginId !== pluginId) return null;
  const { files, dirs, edits } = parsed;
  if (!Array.isArray(files) || !Array.isArray(dirs) || !Array.isArray(edits)) return null;
  for (const file of files) {
    if (!isPlainRecord(file) || typeof file.path !== 'string' || typeof file.sha256 !== 'string' || !HEX.test(file.sha256)) return null;
  }
  if (!dirs.every((dir) => typeof dir === 'string')) return null;
  for (const edit of edits) {
    if (!isPlainRecord(edit) || typeof edit.file !== 'string') return null;
    if (edit.format !== 'json' && edit.format !== 'toml') return null;
    if (!isStripSpec(edit.strip)) return null;
    if (!(edit.preHash === null || (typeof edit.preHash === 'string' && HEX.test(edit.preHash)))) return null;
    if (typeof edit.postHash !== 'string' || !HEX.test(edit.postHash)) return null;
    if (!Array.isArray(edit.splices) || !edit.splices.every(isSplice)) return null;
    if (typeof edit.created !== 'boolean') return null;
    if (edit.blank !== undefined && (typeof edit.blank !== 'string' || edit.blank.trim().length > 0)) return null;
  }
  return parsed as unknown as ReceiptV2;
}

type Action = { readonly kind: 'none' } | { readonly kind: 'delete' } | { readonly kind: 'write'; readonly text: string };

async function planRemoval(edit: EditRecord, hooks: TxnHooks): Promise<{ readHash: string; action: Action } | null | 'absent'> {
  const bytes = await readBytes(edit.file);
  if (bytes === null) return 'absent';
  if (bytes === 'error' || bytes.byteLength > BYTE_CAP) return null;
  const text = decodeUtf8(bytes);
  if (text === undefined) return null;
  if (hooks.afterConfigRead !== undefined) await hooks.afterConfigRead(edit.file);
  const readHash = sha256(bytes);
  if (readHash === edit.postHash) {
    if (edit.created) return { readHash, action: { kind: 'delete' } };
    if (edit.blank !== undefined) return { readHash, action: { kind: 'write', text: edit.blank } };
    const undone = undoSplices(text, edit.splices);
    if (undone !== null && sha256(undone) === edit.preHash) return { readHash, action: { kind: 'write', text: undone } };
  }
  // The user edited the file after install: take out exactly the text Jevris inserted, so
  // every other byte (their edit, comments, key order, the final newline) stays as it is.
  const unspliced = removeInsertedText(text, edit);
  if (unspliced !== null) return { readHash, action: { kind: 'write', text: unspliced } };
  const stripped = stripText(text, edit.strip);
  if (stripped === null) return null;
  if (stripped === text) return { readHash, action: { kind: 'none' } };
  return { readHash, action: { kind: 'write', text: stripped } };
}

/**
 * Removes each inserted splice by its text: at its recorded offset, else where it occurs
 * exactly once. Null when a splice is gone or ambiguous, or when the result still holds a
 * Jevris entry (then the caller strips by key instead).
 */
export function removeInsertedText(text: string, edit: Pick<EditRecord, 'splices' | 'strip' | 'format'>): string | null {
  if (edit.splices.length === 0) return null;
  let current = text;
  for (let i = edit.splices.length - 1; i >= 0; i -= 1) {
    const splice = edit.splices[i];
    if (splice === undefined || splice.text.length === 0) return null;
    let at = current.slice(splice.at, splice.at + splice.text.length) === splice.text ? splice.at : -1;
    if (at < 0) {
      const first = current.indexOf(splice.text);
      if (first < 0 || current.indexOf(splice.text, first + 1) >= 0) return null;
      at = first;
    }
    current = `${current.slice(0, at)}${current.slice(at + splice.text.length)}`;
  }
  if (!validFormat(current, edit.format)) return null;
  const residue = stripText(current, edit.strip);
  return residue === current ? current : null;
}

/** Removes each directory that is empty, deepest first. Returns the ones still present. */
async function removeEmptyDirs(dirs: readonly string[]): Promise<string[]> {
  const kept: string[] = [];
  const ordered = [...new Set(dirs)].sort((left, right) => right.length - left.length);
  for (const dir of ordered) {
    try {
      await rmdir(dir);
      journalDirRemoved(dir);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') kept.push(dir);
    }
  }
  return kept;
}

async function removeOwnedFiles(files: readonly OwnedFileRecord[], dirs: readonly string[], kept: string[] = []): Promise<string[]> {
  for (const file of [...files].reverse()) {
    if (await casDelete(file.path, file.sha256)) continue;
    // A file the user changed after install is reported and left in place (ADM-06).
    const bytes = await readBytes(file.path);
    if (bytes !== null) kept.push(file.path);
  }
  return removeEmptyDirs(dirs);
}

export const LEFTOVER_DIRS = 'leftover-dirs.json';

/**
 * A directory one harness created can still hold another harness's files when the first
 * is uninstalled (for example `~/.config` shared by Kilo and OpenCode). Such directories
 * are handed over in `~/.jevris/leftover-dirs.json` and retried on every later uninstall,
 * and removed only once empty. The file goes away when nothing is left.
 */
export async function settleLeftoverDirs(pair: HomePair, dataRoot: string, add: readonly string[]): Promise<boolean> {
  const path = join(dataRoot, LEFTOVER_DIRS);
  const bytes = await readBytes(path);
  if (bytes === 'error') return false;
  let listed: string[] = [];
  if (bytes !== null) {
    const text = decodeText(bytes);
    let parsed: unknown;
    try {
      parsed = text === undefined ? undefined : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (Array.isArray(parsed)) listed = parsed.filter((dir): dir is string => typeof dir === 'string');
  }
  const candidates = [...listed, ...add].filter((dir) => insideHome(pair, dir));
  const kept = await removeEmptyDirs(candidates);
  try {
    if (kept.length === 0) {
      await rm(path, { force: true });
      return true;
    }
    return (await writePrivateFile(path, `${JSON.stringify(kept.sort(), null, 2)}\n`)).ok;
  } catch {
    return false;
  }
}

/**
 * Uninstalls by a v2 receipt. Every shared edit is planned and re-verified before the
 * first write; a concurrent change refuses with every file unchanged.
 */
export async function uninstallV2(
  pair: HomePair,
  receipt: ReceiptV2,
  hooks: TxnHooks = {},
  leftover: string[] = [],
  kept: string[] = [],
): Promise<boolean> {
  const paths = [...receipt.files.map((file) => file.path), ...receipt.dirs, ...receipt.edits.map((edit) => edit.file)];
  if (!paths.every((path) => insideHome(pair, path))) return false;
  const plans: Array<{ edit: EditRecord; readHash: string; action: Action }> = [];
  for (const edit of receipt.edits) {
    const planned = await planRemoval(edit, hooks);
    if (planned === null) return false;
    if (planned === 'absent') continue;
    plans.push({ edit, ...planned });
  }
  for (const plan of plans) {
    if (!matches(await readBytes(plan.edit.file), plan.readHash)) return false;
  }
  for (const plan of plans) {
    if (plan.action.kind === 'none') continue;
    const ok =
      plan.action.kind === 'delete'
        ? await casDelete(plan.edit.file, plan.readHash)
        : await casWrite(plan.edit.file, plan.readHash, plan.action.text);
    if (!ok) return false;
  }
  leftover.push(...(await removeOwnedFiles(receipt.files, receipt.dirs, kept)));
  return true;
}

// ---------------------------------------------------------------------------
// Legacy v1 receipts: whole-file `ownedPaths`, written before phase 25.

export const LEGACY_SHARED: Readonly<Record<string, StripSpec>> = {
  'hooks.json': { kind: 'codex-hooks' },
  'config.toml': { kind: 'toml-table', table: ['mcp_servers', 'jevris'] },
  'kilo.json': { kind: 'json-key', path: ['mcp', 'jevris'] },
  'kilo.jsonc': { kind: 'json-key', path: ['mcp', 'jevris'] },
  'opencode.json': { kind: 'json-key', path: ['mcp', 'jevris'] },
  'opencode.jsonc': { kind: 'json-key', path: ['mcp', 'jevris'] },
  'marketplace.json': { kind: 'json-array-name', path: ['plugins'], name: 'jevris' },
  'mcp_config.json': { kind: 'json-key', path: ['mcpServers', 'jevris'] },
};

const LEGACY_NEVER_TOUCH = new Set(['settings.json', 'package.json']);

async function stripShared(path: string, spec: StripSpec, hooks: TxnHooks): Promise<boolean> {
  const bytes = await readBytes(path);
  if (bytes === null) return true;
  if (bytes === 'error' || bytes.byteLength > BYTE_CAP) return false;
  const text = decodeUtf8(bytes);
  if (text === undefined) return false;
  if (hooks.afterConfigRead !== undefined) await hooks.afterConfigRead(path);
  const stripped = stripText(text, spec);
  if (stripped === null) return false;
  if (stripped === text) return matches(await readBytes(path), sha256(bytes));
  return casWrite(path, sha256(bytes), stripped);
}

/**
 * Conservative removal for a v1 receipt: shared config files are only stripped of Jevris
 * entries (never deleted); a path whose last segment is `jevris` or `jevris.js` is
 * removed; everything else stays in place.
 */
export async function uninstallLegacy(pair: HomePair, ownedPaths: readonly string[], hooks: TxnHooks = {}): Promise<boolean> {
  if (!ownedPaths.every((path) => insideHome(pair, path))) return false;
  for (const path of ownedPaths) {
    const name = basename(path);
    if (LEGACY_NEVER_TOUCH.has(name)) continue;
    const spec = LEGACY_SHARED[name];
    if (spec !== undefined) {
      if (!(await stripShared(path, spec, hooks))) return false;
      continue;
    }
    if (name !== 'jevris' && name !== 'jevris.js') continue;
    try {
      const st = await lstat(path);
      if (st.isSymbolicLink()) await unlink(path);
      else await rm(path, { recursive: true, force: true });
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') return false;
    }
  }
  return true;
}

export function legacyOwnedPaths(text: string, pluginId: string): readonly string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainRecord(parsed) || parsed.pluginId !== pluginId || !Array.isArray(parsed.ownedPaths)) return null;
  if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== '1.0') return null;
  const out: string[] = [];
  for (const item of parsed.ownedPaths) {
    if (typeof item !== 'string' || item.length === 0) return null;
    out.push(item);
  }
  return out;
}

export { toPointer };

// ---------------------------------------------------------------------------
// Home-relative receipts (ADM-06). Schema 2.1 stores every path relative to the home with
// forward slashes, so a receipt survives a renamed or symlinked home and never names the
// user's absolute home in a file that may be shared in a bug report.

export const RECEIPT_SCHEMA_REL = '2.1';

function toRel(pair: HomePair, abs: string): string {
  return relative(pair.resolvedHome, abs).split(/[/\\]/).join('/');
}

function fromRel(pair: HomePair, rel: string): string | null {
  if (typeof rel !== 'string' || rel.length === 0 || isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return null;
  const parts = rel.split('/');
  if (parts.some((part) => part.length === 0 || part === '..' || part === '.')) return null;
  return join(pair.resolvedHome, ...parts);
}

/** Serializes a receipt with home-relative paths (schema 2.1). */
export function serializeReceipt(pair: HomePair, receipt: ReceiptV2, extra: Readonly<Record<string, unknown>> = {}): string | null {
  const all = [...receipt.files.map((file) => file.path), ...receipt.dirs, ...receipt.edits.map((edit) => edit.file)];
  if (!all.every((path) => insideHome(pair, path))) return null;
  const body = {
    schemaVersion: RECEIPT_SCHEMA_REL,
    pluginId: receipt.pluginId,
    ...extra,
    files: receipt.files.map((file) => ({ path: toRel(pair, file.path), sha256: file.sha256 })),
    dirs: receipt.dirs.map((dir) => toRel(pair, dir)),
    edits: receipt.edits.map((edit) => ({ ...edit, file: toRel(pair, edit.file), splices: edit.splices.map((splice) => ({ ...splice, text: homeToToken(pair, splice.text) })) })),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/**
 * Inserted text can name the home (a runtime path, the Claude marketplace folder). A 2.1
 * receipt stores it as a token so the receipt holds no absolute path (ADM-06).
 */
const HOME_TOKENS = ['${JEVRIS_HOME_JSON}', '${JEVRIS_HOME}', '${JEVRIS_HOME_POSIX}'] as const;

/** The home as JSON-escaped text, as written, and with forward slashes (Windows). Longest first. */
function homeForms(pair: HomePair): readonly [string, string, string] {
  const raw = pair.resolvedHome;
  return [JSON.stringify(raw).slice(1, -1), raw, raw.split('\\').join('/')];
}

function homeToToken(pair: HomePair, text: string): string {
  const forms = homeForms(pair);
  let out = text;
  const seen = new Set<string>();
  forms.forEach((form, index) => {
    if (seen.has(form)) return;
    seen.add(form);
    out = out.split(form).join(HOME_TOKENS[index] ?? '');
  });
  return out;
}

function tokenToHome(pair: HomePair, text: string): string {
  const forms = homeForms(pair);
  return HOME_TOKENS.reduce((out, token, index) => out.split(token).join(forms[index] ?? ''), text);
}

/**
 * Parses a 2.0 (absolute) or 2.1 (home-relative) receipt into absolute paths under this
 * home. A path that would leave the home refuses the whole receipt.
 */
export function parseReceipt(text: string, pluginId: string, pair: HomePair): ReceiptV2 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainRecord(parsed)) return null;
  if (parsed.schemaVersion === RECEIPT_SCHEMA) {
    const receipt = parseReceiptV2(text, pluginId);
    if (receipt === null) return null;
    const all = [...receipt.files.map((file) => file.path), ...receipt.dirs, ...receipt.edits.map((edit) => edit.file)];
    return all.every((path) => insideHome(pair, path)) ? receipt : null;
  }
  if (parsed.schemaVersion !== RECEIPT_SCHEMA_REL) return null;
  const asV2 = parseReceiptV2(JSON.stringify({ ...parsed, schemaVersion: RECEIPT_SCHEMA }), pluginId);
  if (asV2 === null) return null;
  const files: OwnedFileRecord[] = [];
  for (const file of asV2.files) {
    const abs = fromRel(pair, file.path);
    if (abs === null) return null;
    files.push({ path: abs, sha256: file.sha256 });
  }
  const dirs: string[] = [];
  for (const dir of asV2.dirs) {
    const abs = fromRel(pair, dir);
    if (abs === null) return null;
    dirs.push(abs);
  }
  const edits: EditRecord[] = [];
  for (const edit of asV2.edits) {
    const abs = fromRel(pair, edit.file);
    if (abs === null) return null;
    edits.push({ ...edit, file: abs, splices: edit.splices.map((splice) => ({ ...splice, text: tokenToHome(pair, splice.text) })) });
  }
  return { schemaVersion: RECEIPT_SCHEMA, pluginId: asV2.pluginId, files, dirs, edits };
}

/** Extra top-level fields of a receipt (for example the runtime version it points at). */
export function receiptExtra(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isPlainRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// The operation journal (ADM-04, SSOT §11.3: "back up changed entries").
//
// Every file an install, upgrade or uninstall touches is backed up to
// `<data>/backups/<id>/` before its first change, with a manifest of home-relative paths
// and hashes. On any failure the journal restores each file, but only when the file still
// holds exactly what this operation wrote: a file the user changed in the meantime is
// reported as a conflict and left alone, never overwritten with an old backup.

interface JournalFile {
  readonly path: string;
  readonly originalHash: string | null;
  readonly backup: string | null;
  last: string | null | undefined;
}

export interface RestoreReport {
  readonly restored: readonly string[];
  readonly conflicts: readonly string[];
}

export class InstallJournal {
  private readonly files = new Map<string, JournalFile>();
  private readonly createdDirs: string[] = [];
  private readonly removedDirs: string[] = [];
  private counter = 0;
  private failed = false;

  constructor(
    readonly pair: HomePair,
    readonly dir: string,
    readonly operation: string,
  ) {}

  get touched(): readonly string[] {
    return [...this.files.keys()];
  }

  /** Captures the pre-operation bytes of `path` once. False when the backup cannot be made. */
  async before(path: string): Promise<boolean> {
    if (this.files.has(path)) return true;
    const bytes = await readBytes(path);
    if (bytes === 'error') {
      this.failed = true;
      return false;
    }
    let backup: string | null = null;
    if (bytes !== null) {
      this.counter += 1;
      backup = `${String(this.counter).padStart(5, '0')}.bak`;
      try {
        await mkdir(join(this.dir, 'files'), { recursive: true });
        await writeFile(join(this.dir, 'files', backup), bytes, { flag: 'wx', mode: 0o600 });
      } catch {
        this.failed = true;
        return false;
      }
    }
    this.files.set(path, { path, originalHash: bytes === null ? null : sha256(bytes), backup, last: undefined });
    return this.writeManifest();
  }

  after(path: string, hash: string | null): void {
    const entry = this.files.get(path);
    if (entry !== undefined) entry.last = hash;
  }

  dirCreated(path: string): void {
    this.createdDirs.push(path);
  }

  dirRemoved(path: string): void {
    this.removedDirs.push(path);
  }

  async writeManifest(): Promise<boolean> {
    const manifest = {
      schemaVersion: 1,
      operation: this.operation,
      files: [...this.files.values()].map((entry) => ({
        path: toRel(this.pair, entry.path),
        sha256: entry.originalHash,
        backup: entry.backup,
      })),
    };
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(join(this.dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      return true;
    } catch {
      this.failed = true;
      return false;
    }
  }

  /** Puts every touched file back, newest first. Changed files are conflicts, never overwritten. */
  async restore(): Promise<RestoreReport> {
    const restored: string[] = [];
    const conflicts: string[] = [];
    for (const dir of [...this.removedDirs].reverse()) {
      try {
        await mkdir(dir, { recursive: true });
      } catch {
        conflicts.push(dir);
      }
    }
    for (const entry of [...this.files.values()].reverse()) {
      if (entry.last === undefined) continue;
      const current = await readBytes(entry.path);
      if (current === 'error' || !matches(current, entry.last)) {
        conflicts.push(entry.path);
        continue;
      }
      try {
        if (entry.backup === null) {
          if (current !== null) await unlink(entry.path);
        } else {
          const original = await readFile(join(this.dir, 'files', entry.backup));
          await mkdir(dirname(entry.path), { recursive: true });
          const temp = join(dirname(entry.path), `.${basename(entry.path)}.jevris-restore-${nonce(entry.path)}.tmp`);
          await writeFile(temp, original, { flag: 'wx' });
          if (!(await renameWithRetry(temp, entry.path)).ok) {
            await rm(temp, { force: true });
            conflicts.push(entry.path);
            continue;
          }
        }
        restored.push(entry.path);
      } catch {
        conflicts.push(entry.path);
      }
    }
    for (const dir of [...this.createdDirs].sort((left, right) => right.length - left.length)) {
      try {
        await rmdir(dir);
      } catch {
        continue;
      }
    }
    return { restored, conflicts };
  }

  /** After a successful operation: keep the backup set only if it holds something. */
  async finish(): Promise<void> {
    if (this.files.size > 0 && !this.failed) return;
    try {
      await rm(this.dir, { recursive: true, force: true });
    } catch {
      // A leftover empty backup set is harmless.
    }
  }
}

let activeJournal: InstallJournal | null = null;

export function setActiveJournal(journal: InstallJournal | null): void {
  activeJournal = journal;
}

export function currentJournal(): InstallJournal | null {
  return activeJournal;
}

async function journalBefore(path: string): Promise<boolean> {
  return activeJournal === null ? true : activeJournal.before(path);
}

function journalAfter(path: string, hash: string | null): void {
  activeJournal?.after(path, hash);
}

function journalDirCreated(path: string): void {
  activeJournal?.dirCreated(path);
}

function journalDirRemoved(path: string): void {
  activeJournal?.dirRemoved(path);
}

/** A journaled write of a Jevris-owned private file (receipts). */
export async function journaledPrivateWrite(path: string, text: string): Promise<boolean> {
  if (!(await journalBefore(path))) return false;
  const ok = (await writePrivateFile(path, text)).ok;
  if (ok) journalAfter(path, sha256(text));
  return ok;
}

/** A journaled delete of a Jevris-owned file (receipts). Absent is fine. */
export async function journaledRemove(path: string): Promise<boolean> {
  const bytes = await readBytes(path);
  if (bytes === null) return true;
  if (bytes === 'error') return false;
  if (!(await journalBefore(path))) return false;
  try {
    await unlink(path);
    journalAfter(path, null);
    return true;
  } catch {
    return false;
  }
}

/** Keeps the newest `keep` backup sets under `<data>/backups`. */
export async function pruneBackups(dataRoot: string, keep = 5): Promise<void> {
  const root = join(dataRoot, 'backups');
  let names: readonly string[];
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  const sets = [...names].filter((name) => /^\d{8}T\d{6}Z-[0-9a-f]{6}$/.test(name)).sort();
  for (const name of sets.slice(0, Math.max(0, sets.length - keep))) {
    try {
      await rm(join(root, name), { recursive: true, force: true });
    } catch {
      continue;
    }
  }
}

export function backupSetName(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${stamp}-${sha256(`${stamp}\0${Math.random()}\0${counter}`).slice(0, 6)}`;
}

/**
 * Per-workspace orchestration state under the Jevris data directory (never in the repository):
 *   <data>/orchestration/<workspaceId>/state     record ledger (reminders, capsules, snapshots …)
 *   <data>/evidence                              content-addressed raw evidence
 * Tasks and verification receipts live in B's store (DATA-03): the sidecar's single open
 * store, scoped to this workspace. Without a store (outside the sidecar) task and receipt
 * reads are empty and writes are refused.
 */
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { jevrisPaths, pathKey } from '@jevris/platform';
import { openEvidenceStore, type EvidenceStore } from './evidence-store.js';
import { openLedger, type RecordLedger } from './ledger.js';
import { workspaceView, type OpenStoreResult, type OpenedStore } from '@jevris/store';
import { storeReceiptLedger, type WritableReceiptLedger } from './verify/receipts.js';
import { hookState } from './hook-state.js';
import { isId, sha256 } from './util.js';

export interface WorkspaceServices {
  readonly home: string;
  readonly dataDir: string;
  readonly configDir: string;
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  /**
   * The workspace ledger. With a store, the hook-path collections (hook-state.ts) are read from
   * and written to B's hook records; everything else is the file ledger under the data directory.
   */
  readonly state: RecordLedger;
  /**
   * The hook-path collections only (P2): with a store, a transaction here takes no directory lock
   * and commits within a second. Without a store it is the file ledger, the same as `state`.
   */
  readonly hook: RecordLedger;
  /** B's store scoped to this workspace, or undefined when unavailable. */
  readonly store: OpenStoreResult | undefined;
  readonly receipts: WritableReceiptLedger;
  readonly evidence: EvidenceStore;
  /** Host-level (not per-workspace) ledger: pack registry, approvals, project memory. */
  readonly host: RecordLedger;
}

/**
 * The identity of a workspace root directory (IPC-09), shared with the sidecar: device, inode
 * and birth time, read as bigints (a large Windows file index stays exact). Birth time matters
 * on Linux, which hands a freed inode to the next directory at once; where a filesystem has no
 * birth time it is 0 and the id stays stable. Undefined when the root is unreadable or not a
 * directory.
 */
export function rootIdentityId(root: string): string | undefined {
  try {
    const real = realpathSync(root);
    const st = statSync(real, { bigint: true });
    if (!st.isDirectory()) return undefined;
    return `w${sha256(`${String(st.dev)}:${String(st.ino)}:${String(st.birthtimeNs)}`).slice(0, 24)}`;
  } catch {
    return undefined;
  }
}

/**
 * Workspace identity, the same as the sidecar's (IPC-09): `rootIdentityId`, so a moved or
 * renamed path keeps its id and two spellings of one directory share it. When the root cannot
 * be read, a path-derived id is used (case-folded where the OS is case-insensitive).
 */
export function workspaceIdFor(root: string, platform: string = process.platform): string {
  return rootIdentityId(root) ?? `ws-${sha256(pathKey(root, platform)).slice(0, 20)}`;
}

export interface OpenWorkspaceInput {
  readonly home?: string;
  readonly workspaceRoot: string;
  readonly workspaceId?: string;
  readonly env?: { readonly [key: string]: string | undefined };
  readonly platform?: string;
  /** The sidecar's open store (or a view of it); a test opens one with role 'in-process-test'. */
  readonly store?: unknown;
}

type BaseServices = Omit<WorkspaceServices, 'store' | 'receipts' | 'hook'>;

const cache = new Map<string, { readonly base: BaseServices; readonly none: WorkspaceServices; readonly byStore: WeakMap<object, WorkspaceServices> }>();

function isOpenedStore(value: unknown): value is OpenedStore {
  return value !== null && typeof value === 'object' && Reflect.get(value, 'ok') === true && typeof Reflect.get(value, 'resolvedPath') === 'string' && typeof Reflect.get(value, 'workspaceId') === 'string';
}

/** The store scoped to `workspaceId`: the handle itself when it already is, else a view. */
function scopedStore(store: unknown, workspaceId: string): OpenedStore | undefined {
  if (!isOpenedStore(store)) return undefined;
  if (store.workspaceId === workspaceId) return store;
  return workspaceView(store, workspaceId);
}

/** How each workspace was opened (home, env, platform and the store handle), for workspaceWithId. */
const openedWith = new WeakMap<WorkspaceServices, OpenWorkspaceInput>();

/**
 * The same root opened as another workspace id, with the same home, environment and store: an
 * owned worker's worktree, which the sidecar resolves as a workspace of its own, read as its
 * task's workspace (the inverse of taskWorkspace).
 */
export function workspaceWithId(ws: WorkspaceServices, workspaceId: string): WorkspaceServices {
  if (workspaceId === ws.workspaceId) return ws;
  const input = openedWith.get(ws) ?? { home: ws.home, workspaceRoot: ws.workspaceRoot };
  return openWorkspace({ ...input, workspaceRoot: ws.workspaceRoot, workspaceId });
}

export function openWorkspace(input: OpenWorkspaceInput): WorkspaceServices {
  const services = openServices(input);
  if (!openedWith.has(services)) openedWith.set(services, input);
  return services;
}

function openServices(input: OpenWorkspaceInput): WorkspaceServices {
  const paths = jevrisPaths({
    ...(input.home === undefined ? {} : { home: input.home }),
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.platform === undefined ? {} : { platform: input.platform }),
  });
  let root = input.workspaceRoot;
  try {
    root = realpathSync.native(root);
  } catch {
    // keep as given; the runner refuses a missing cwd later
  }
  const workspaceId = input.workspaceId !== undefined && isId(input.workspaceId) ? input.workspaceId : workspaceIdFor(root, paths.platform);
  const key = `${paths.data}\0${workspaceId}\0${root}`;
  let entry = cache.get(key);
  if (entry === undefined) {
    const base = join(paths.data, 'orchestration', workspaceId);
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const services: BaseServices = {
      home: paths.home,
      dataDir: paths.data,
      configDir: paths.config,
      workspaceRoot: root,
      workspaceId,
      state: openLedger(join(base, 'state')),
      evidence: openEvidenceStore(join(paths.data, 'evidence')),
      host: openLedger(join(paths.data, 'orchestration', 'host')),
    };
    entry = { base: services, none: { ...services, hook: services.state, store: undefined, receipts: storeReceiptLedger(undefined, services.state) }, byStore: new WeakMap() };
    cache.set(key, entry);
  }
  const store = scopedStore(input.store, workspaceId);
  if (store === undefined) return entry.none;
  const known = entry.byStore.get(store);
  if (known !== undefined) return known;
  const ledgers = hookState(entry.base.state, store);
  const services: WorkspaceServices = { ...entry.base, state: ledgers.state, hook: ledgers.hook, store, receipts: storeReceiptLedger(store, entry.base.state) };
  entry.byStore.set(store, services);
  return services;
}

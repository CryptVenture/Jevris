/**
 * File content hashes for revision snapshots, off the event loop (sidecar concurrency audit P5,
 * owner decisions DOMAINS ededdba).
 *
 * A snapshot used to read and hash every dirty or untracked file synchronously (up to 64 MiB each,
 * no total cap), twice per check, on Stop, PreCompact and SessionStart: an 80 MB untracked tree
 * stalled the sidecar for about a second and made `jevris verify` miss the CLI's deadline.
 *
 * - Files are read with streams (libuv I/O) and hashed chunk by chunk, so no single step holds
 *   the loop for more than one chunk; at most HASH_CONCURRENCY files are read at once.
 * - Hashes are cached by (device, inode, path, size, mtime, ctime). A file whose mtime is within
 *   RACY_WINDOW_MS of the hash is not cached (it could change again within the clock's
 *   resolution), the rule git uses for its index; any later write also moves the ctime.
 * - One snapshot hashes at most SNAPSHOT_HASH_BYTES of uncached content. Past that, a file is
 *   recorded as `unhashed:<size>:<mtime>` (its size and time still change the revision), and a
 *   file over MAX_HASH_BYTES is `size:<n>` as before. Both are deterministic for an unchanged file.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

/** One file larger than this is identified by its size alone (unchanged from before). */
export const MAX_HASH_BYTES = 64 * 1024 * 1024;
/** Uncached bytes one snapshot reads; past this a file is identified by size and mtime. */
export const SNAPSHOT_HASH_BYTES = 256 * 1024 * 1024;
/** Files read at once. */
export const HASH_CONCURRENCY = 4;
/** A file modified this recently is hashed but not cached. */
export const RACY_WINDOW_MS = 2_000;
/** Cached hashes kept (the oldest are dropped first). */
export const HASH_CACHE_MAX = 50_000;
const CHUNK_BYTES = 1024 * 1024;

interface CacheEntry {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly hash: string;
}

const cache = new Map<string, CacheEntry>();
let hits = 0;
let misses = 0;

/** Cache counters (tests and diagnostics). */
export function fileHashStats(): { readonly entries: number; readonly hits: number; readonly misses: number } {
  return { entries: cache.size, hits, misses };
}

/** Test seam: forgets every cached hash and the counters. */
export function resetFileHashCache(): void {
  cache.clear();
  hits = 0;
  misses = 0;
}

function remember(key: string, entry: CacheEntry): void {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > HASH_CACHE_MAX) {
    const first = cache.keys().next();
    if (first.done === true) break;
    cache.delete(first.value);
  }
}

function streamHash(path: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path, { highWaterMark: CHUNK_BYTES });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** A budget of uncached bytes shared by one snapshot's files. */
export interface HashBudget {
  remaining: number;
}

export function snapshotBudget(): HashBudget {
  return { remaining: SNAPSHOT_HASH_BYTES };
}

/** The content hash of one file: `missing`, `size:<n>`, `unhashed:<size>:<mtime>` or the sha256 hex. Never throws. */
export async function hashFileAsync(path: string, budget: HashBudget = snapshotBudget(), nowMs: number = Date.now()): Promise<string> {
  let st;
  try {
    st = await stat(path);
  } catch {
    return 'missing';
  }
  if (!st.isFile()) return 'missing';
  if (st.size > MAX_HASH_BYTES) return `size:${String(st.size)}`;
  const key = `${String(st.dev)}:${String(st.ino)}:${path}`;
  const known = cache.get(key);
  if (known !== undefined && known.size === st.size && known.mtimeMs === st.mtimeMs && known.ctimeMs === st.ctimeMs) {
    hits += 1;
    return known.hash;
  }
  if (st.size > budget.remaining) return `unhashed:${String(st.size)}:${String(Math.trunc(st.mtimeMs))}`;
  budget.remaining -= st.size;
  misses += 1;
  let hash: string;
  try {
    hash = await streamHash(path);
  } catch {
    return 'missing';
  }
  // A file still being written within the clock's resolution may change without a new mtime.
  // A change that keeps the mtime still moves the ctime, which the cache also compares.
  if (nowMs - st.mtimeMs >= RACY_WINDOW_MS) remember(key, { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, hash });
  return hash;
}

/** Hashes files with at most HASH_CONCURRENCY reads at once; answers in input order. */
export async function hashFilesAsync(paths: readonly string[], budget: HashBudget = snapshotBudget()): Promise<readonly string[]> {
  const out = new Array<string>(paths.length);
  let next = 0;
  const nowMs = Date.now();
  const worker = async (): Promise<void> => {
    for (;;) {
      const at = next;
      next += 1;
      if (at >= paths.length) return;
      out[at] = await hashFileAsync(paths[at] as string, budget, nowMs);
    }
  };
  await Promise.all(Array.from({ length: Math.min(HASH_CONCURRENCY, paths.length) }, () => worker()));
  return out;
}

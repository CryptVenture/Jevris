/**
 * Content-addressed raw evidence (SSOT §9.4, C22, US15, E23).
 *
 * Tool and runner output is kept as the raw record under a handle `ev:<sha256>`, next to a
 * small metadata file (workspace, kind, byte count, truncation, retention class, created time).
 * The model-visible view is derived elsewhere; `get` always returns the original bytes.
 * Blobs are private files under the Jevris data directory, never inside the repository.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openLedger, type RecordLedger } from './ledger.js';
import { isId, recordKey, sha256 } from './util.js';

export const HANDLE_PATTERN = /^ev:[a-f0-9]{64}$/;
const DAY_MS = 86_400_000;

export type RetentionClass = 'raw' | 'pinned';

export interface EvidenceMeta {
  readonly handle: string;
  readonly workspaceId: string;
  readonly kind: string;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly createdAtMs: number;
  readonly retention: RetentionClass;
  readonly contentType: 'text' | 'binary';
}

export interface PutEvidenceInput {
  readonly workspaceId: string;
  readonly kind: string;
  readonly bytes: Uint8Array;
  readonly truncated?: boolean;
  readonly retention?: RetentionClass;
  readonly nowMs?: number;
  /**
   * The sha256 of `bytes` (hex) when Jevris's own output worker already computed it off the
   * event loop (P6); otherwise the store hashes the bytes itself, a chunk per turn.
   */
  readonly sha256?: string;
}

export interface EvidenceStore {
  readonly root: string;
  put(input: PutEvidenceInput): Promise<EvidenceMeta>;
  meta(handle: string): EvidenceMeta | undefined;
  /** The metadata of a handle as the given workspace recorded it. */
  metaIn(handle: string, workspaceId: string): EvidenceMeta | undefined;
  /** Original bytes, or undefined when unknown, expired or from another workspace. */
  get(handle: string, workspaceId: string): Uint8Array | undefined;
  /** Removes raw evidence older than `rawDays`; pinned evidence is kept. */
  sweep(rawDays: number, nowMs?: number): Promise<number>;
}

/** Bytes hashed between two turns of the event loop when evidence is stored (P6). */
export const EVIDENCE_HASH_CHUNK_BYTES = 1024 * 1024;

/**
 * The sha256 of `bytes`, one chunk per turn of the event loop, so storing a check's 16 MiB of
 * output never holds the sidecar for the whole hash (sidecar concurrency audit P6).
 */
async function sha256Chunked(bytes: Uint8Array): Promise<string> {
  const hash = createHash('sha256');
  for (let at = 0; at < bytes.length; at += EVIDENCE_HASH_CHUNK_BYTES) {
    hash.update(bytes.subarray(at, Math.min(bytes.length, at + EVIDENCE_HASH_CHUNK_BYTES)));
    if (at + EVIDENCE_HASH_CHUNK_BYTES < bytes.length) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return hash.digest('hex');
}

function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8000);
  for (let i = 0; i < limit; i += 1) if (bytes[i] === 0) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, limit));
  } catch {
    return limit === bytes.length;
  }
  return false;
}

export function isHandle(value: unknown): value is string {
  return typeof value === 'string' && HANDLE_PATTERN.test(value);
}

export function openEvidenceStore(root: string): EvidenceStore {
  const blobs = join(root, 'blobs');
  mkdirSync(blobs, { recursive: true, mode: 0o700 });
  const ledger: RecordLedger = openLedger(join(root, 'index'));
  const blobPath = (hex: string) => join(blobs, hex.slice(0, 2), hex);

  return {
    root,
    async put(input: PutEvidenceInput): Promise<EvidenceMeta> {
      if (!isId(input.workspaceId)) throw new Error('evidence: bad workspace id');
      if (!/^[a-z][a-z0-9.-]{0,63}$/.test(input.kind)) throw new Error('evidence: bad kind');
      const hex = input.sha256 !== undefined && /^[a-f0-9]{64}$/.test(input.sha256) ? input.sha256 : await sha256Chunked(input.bytes);
      const handle = `ev:${hex}`;
      const dir = join(blobs, hex.slice(0, 2));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = blobPath(hex);
      let exists = false;
      try {
        exists = statSync(path).size === input.bytes.length;
      } catch {
        exists = false;
      }
      if (!exists) {
        // Written off the loop (libuv), then renamed into place: a reader sees the whole blob or none.
        const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
        try {
          await writeFile(temp, input.bytes, { mode: 0o600 });
          await rename(temp, path);
        } catch (error) {
          await rm(temp, { force: true }).catch(() => undefined);
          throw error;
        }
      }
      const meta: EvidenceMeta = {
        handle,
        workspaceId: input.workspaceId,
        kind: input.kind,
        bytes: input.bytes.length,
        truncated: input.truncated === true,
        createdAtMs: input.nowMs ?? Date.now(),
        retention: input.retention ?? 'raw',
        contentType: looksBinary(input.bytes) ? 'binary' : 'text',
      };
      await ledger.transact((tx) => {
        const key = recordKey(input.workspaceId, handle);
        const prior = tx.get<EvidenceMeta>('meta', key);
        const retention: RetentionClass = prior?.retention === 'pinned' ? 'pinned' : meta.retention;
        tx.put('meta', key, { ...meta, retention });
      });
      return meta;
    },
    meta(handle: string): EvidenceMeta | undefined {
      if (!isHandle(handle)) return undefined;
      for (const row of ledger.list<EvidenceMeta>('meta')) if (row.handle === handle) return row;
      return undefined;
    },
    metaIn(handle: string, workspaceId: string): EvidenceMeta | undefined {
      if (!isHandle(handle) || !isId(workspaceId)) return undefined;
      return ledger.get<EvidenceMeta>('meta', recordKey(workspaceId, handle));
    },
    get(handle: string, workspaceId: string): Uint8Array | undefined {
      if (!isHandle(handle) || !isId(workspaceId)) return undefined;
      const meta = ledger.get<EvidenceMeta>('meta', recordKey(workspaceId, handle));
      if (meta === undefined) return undefined;
      try {
        const bytes = readFileSync(blobPath(handle.slice(3)));
        if (sha256(bytes) !== handle.slice(3)) return undefined;
        return bytes;
      } catch {
        return undefined;
      }
    },
    async sweep(rawDays: number, nowMs = Date.now()): Promise<number> {
      const cutoff = nowMs - Math.max(0, rawDays) * DAY_MS;
      let removed = 0;
      const live = new Set<string>();
      await ledger.transact((tx) => {
        for (const row of tx.list<EvidenceMeta>('meta')) {
          if (row.retention === 'raw' && row.createdAtMs < cutoff) {
            tx.delete('meta', recordKey(row.workspaceId, row.handle));
            removed += 1;
          } else {
            live.add(row.handle.slice(3));
          }
        }
      });
      for (const prefix of safeList(blobs)) {
        for (const name of safeList(join(blobs, prefix))) {
          if (!/^[a-f0-9]{64}$/.test(name)) continue;
          if (!live.has(name)) rmSync(join(blobs, prefix, name), { force: true });
        }
      }
      return removed;
    },
  };
}

function safeList(dir: string): readonly string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

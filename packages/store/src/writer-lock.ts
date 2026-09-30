/**
 * Cross-process single-writer lock (DATA-09, SSOT §17.1). One process at a time holds the
 * writer role for a store file: the lock file `<db>.writer` is created exclusively and
 * owner-only and names the holder's pid, host and a random nonce. A lock whose holder is
 * gone (same host, pid not alive) is taken over; a live holder refuses the open with
 * `writer-busy`. The holder removes the file when it closes the store.
 */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { machineIdentity, readSharedFileSync } from '@jevris/platform';

/**
 * The host a lock names: a hash of the stable machine id, so a host-name change (macOS renames
 * the host with the network) never makes this machine's own stale lock look foreign. When the
 * machine id cannot be read it is the host name, as before.
 */
function hostToken(): string {
  const identity = machineIdentity();
  return identity.ok ? `m${createHash('sha256').update(`jevris-lock-host\0${identity.machineId}`).digest('hex').slice(0, 24)}` : hostname();
}

/** True when a lock's host is this machine: its stable token, or a lock written by name. */
function thisHost(host: string): boolean {
  return host === hostToken() || host === hostname();
}

export interface WriterLockHolder {
  readonly pid: number;
  readonly host: string;
  readonly nonce: string;
  readonly role: string;
  readonly acquiredAtMs: number;
}

export interface HeldWriterLock {
  readonly path: string;
  readonly nonce: string;
}

export type WriterLockResult =
  | { readonly ok: true; readonly lock: HeldWriterLock; readonly tookOver: boolean }
  | { readonly ok: false; readonly reason: 'writer-busy' | 'path-refused'; readonly holder?: { readonly pid: number; readonly role: string } };

export interface WriterLockDeps {
  readonly pid?: number;
  readonly host?: string;
  readonly isAlive?: (pid: number) => boolean;
  readonly nowMs?: () => number;
}

export function writerLockPath(dbPath: string): string {
  return `${dbPath}.writer`;
}

function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'EPERM';
  }
}

function readHolder(path: string): WriterLockHolder | 'unreadable' | 'missing' {
  let text: string;
  try {
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (st === undefined) return 'missing';
    if (!st.isFile()) return 'unreadable';
    text = readSharedFileSync(path, 'utf8');
  } catch (error) {
    return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT' ? 'missing' : 'unreadable';
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unreadable';
    const pid = Reflect.get(parsed, 'pid');
    const host = Reflect.get(parsed, 'host');
    const nonce = Reflect.get(parsed, 'nonce');
    const role = Reflect.get(parsed, 'role');
    const acquiredAtMs = Reflect.get(parsed, 'acquiredAtMs');
    if (typeof pid !== 'number' || typeof host !== 'string' || typeof nonce !== 'string' || typeof role !== 'string' || typeof acquiredAtMs !== 'number') return 'unreadable';
    return { pid, host, nonce, role, acquiredAtMs };
  } catch {
    return 'unreadable';
  }
}

function createExclusive(path: string, holder: WriterLockHolder): boolean {
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
  let fd: number;
  try {
    fd = openSync(path, flags, 0o600);
  } catch (error) {
    if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'EEXIST') return false;
    throw error;
  }
  try {
    writeSync(fd, JSON.stringify(holder));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Takes the writer lock for `dbPath`, taking over a lock whose holder is gone. */
export function acquireWriterLock(dbPath: string, role: string, deps: WriterLockDeps = {}): WriterLockResult {
  const path = writerLockPath(dbPath);
  const holder: WriterLockHolder = {
    pid: deps.pid ?? process.pid,
    host: deps.host ?? hostToken(),
    nonce: randomBytes(16).toString('hex'),
    role,
    acquiredAtMs: (deps.nowMs ?? Date.now)(),
  };
  const isAlive = deps.isAlive ?? alive;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (createExclusive(path, holder)) return { ok: true, lock: { path, nonce: holder.nonce }, tookOver: attempt > 0 };
    } catch {
      return { ok: false, reason: 'path-refused' };
    }
    const current = readHolder(path);
    if (current === 'missing') continue;
    if (current !== 'unreadable') {
      // Another host's lock cannot be checked: the store refuses a shared file anyway.
      if (current.host !== holder.host && (deps.host !== undefined || !thisHost(current.host))) return { ok: false, reason: 'writer-busy', holder: { pid: current.pid, role: current.role } };
      if (current.pid !== holder.pid && isAlive(current.pid)) return { ok: false, reason: 'writer-busy', holder: { pid: current.pid, role: current.role } };
      if (current.pid === holder.pid && current.nonce !== holder.nonce) {
        // This process already holds it through another open; the in-process map refuses that.
        return { ok: false, reason: 'writer-busy', holder: { pid: current.pid, role: current.role } };
      }
    }
    // The holder is gone (or the file is not a lock we wrote): remove it and retry.
    try {
      const st = lstatSync(path, { throwIfNoEntry: false });
      if (st !== undefined && !st.isFile()) return { ok: false, reason: 'path-refused' };
      unlinkSync(path);
    } catch {
      // raced with another taker; retry
    }
  }
  return { ok: false, reason: 'writer-busy' };
}

/** Releases the lock if this holder still owns it. */
export function releaseWriterLock(lock: HeldWriterLock): void {
  const current = readHolder(lock.path);
  if (current === 'missing' || current === 'unreadable' || current.nonce !== lock.nonce) return;
  try {
    unlinkSync(lock.path);
  } catch {
    // already gone
  }
}

/** The current holder, for health and diagnostics. */
export function writerLockHolder(dbPath: string): { readonly pid: number; readonly role: string; readonly alive: boolean } | undefined {
  const current = readHolder(writerLockPath(dbPath));
  if (current === 'missing' || current === 'unreadable') return undefined;
  return { pid: current.pid, role: current.role, alive: thisHost(current.host) && alive(current.pid) };
}

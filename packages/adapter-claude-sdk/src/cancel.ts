import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { jevrisPaths, writePrivateFile } from '@jevris/platform';

/**
 * Cancel an owned session. Abort, then close. Interrupt only a streaming
 * prompt, and only after those two calls. Never delete the worktree path.
 * External effects stay needs-reconciliation.
 */

const FILE_NAME = 'scheduling-stopped.json';
const BODY = '{"stopped":true}\n';
const MAX_BYTES = 4096;

export interface WorktreeRef {
  readonly path: string;
  readonly status: 'dirty' | 'unknown' | 'unreadable' | 'clean';
}

export interface CancelPort {
  abort(): void;
  close(): void;
  interrupt(): void;
}

export interface CancelOwnedSessionInput {
  readonly home: string;
  readonly sessionId: string;
  readonly ownedSessionIds: readonly string[];
  readonly promptKind: 'string' | 'stream';
  readonly worktree: WorktreeRef;
  readonly port: CancelPort;
}

export interface CancelOwnedSessionResult {
  readonly deleted: false;
  readonly signalled: boolean;
  readonly path: string;
  readonly schedulingStopped: boolean;
  readonly effect: 'needs-reconciliation';
  readonly report: string;
}

export function schedulingStoppedPath(home: string): string {
  return join(jevrisPaths({ home }).config, FILE_NAME);
}

function safeHome(home: string): boolean {
  return typeof home === 'string' && home.length > 0 && !home.includes('\0');
}

function isPlain(value: unknown): value is { readonly [key: string]: unknown } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

export async function markSchedulingStopped(home: string): Promise<boolean> {
  if (!safeHome(home)) return false;
  const path = schedulingStoppedPath(home);
  return (await writePrivateFile(path, BODY)).ok;
}

export async function readSchedulingStopped(home: string): Promise<boolean> {
  if (!safeHome(home)) return false;
  let text: string;
  try {
    text = await readFile(schedulingStoppedPath(home), 'utf8');
  } catch {
    return false;
  }
  if (text.length > MAX_BYTES) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return false;
  }
  if (!isPlain(parsed)) return false;
  if (Object.keys(parsed).length !== 1) return false;
  return parsed['stopped'] === true;
}

export async function cancelOwnedSession(input: CancelOwnedSessionInput): Promise<CancelOwnedSessionResult> {
  const path = input.worktree.path;
  const owned = input.ownedSessionIds.includes(input.sessionId);
  const stopped = await markSchedulingStopped(input.home);
  if (owned) {
    input.port.abort();
    input.port.close();
    if (input.promptKind === 'stream') input.port.interrupt();
  }
  return {
    deleted: false,
    signalled: owned,
    path,
    schedulingStopped: stopped,
    effect: 'needs-reconciliation',
    report: path,
  };
}

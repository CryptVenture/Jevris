/**
 * Which receipts a verification root owns (VER-03, ORC-05, W01).
 *
 * An owned task verifies in its own worktree, so one workspace id has several roots: the main
 * checkout and each live task worktree. Freshness compares a receipt with the root it ran in,
 * never with another one: a task worktree owns the receipts of its task, and the main checkout
 * owns every other receipt. Each root keeps its own revision snapshot, so verifying one task
 * never makes another task's receipts stale.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WorkspaceServices } from '../workspace.js';
import { listWorktrees } from '../worktree.js';
import { pathKey } from '@jevris/platform';
import { recordKey } from '../util.js';
import type { StoredReceipt } from './receipts.js';

export interface ReceiptScope {
  /** The key of this root's revision snapshot. */
  readonly key: string;
  /** The task whose worktree this is, or null for the main checkout. */
  readonly taskId: string | null;
  readonly includes: (row: StoredReceipt) => boolean;
}

function keyOf(path: string): string {
  let real = resolve(path);
  try {
    real = realpathSync(path);
  } catch {
    // keep the resolved path
  }
  return pathKey(real, process.platform);
}

export function receiptScopeOf(ws: WorkspaceServices): ReceiptScope {
  const live = listWorktrees(ws).filter((t) => t.state !== 'removed');
  const here = keyOf(ws.workspaceRoot);
  const mine = live.find((t) => keyOf(t.path) === here);
  if (mine !== undefined) {
    const taskId = mine.taskId;
    return { key: recordKey(ws.workspaceId, 'task', taskId), taskId, includes: (row) => row.receipt.taskId === taskId };
  }
  const worktreeTasks = new Set(live.map((t) => t.taskId));
  return { key: ws.workspaceId, taskId: null, includes: (row) => row.receipt.taskId === null || !worktreeTasks.has(row.receipt.taskId) };
}

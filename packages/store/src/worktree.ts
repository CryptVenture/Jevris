import type { SqlDriver } from './schema.js';

/**
 * Ownership row only. Git stays in the orchestrator. better-sqlite3 stays
 * behind the store driver and is not imported here.
 */

export interface WorktreeRow {
  readonly worktreeId: string;
  readonly directory: string;
  readonly state: string;
}

function own(row: object, key: string): unknown {
  if (!Object.hasOwn(row, key)) return undefined;
  return (row as Record<string, unknown>)[key];
}

export function insertWorktree(
  driver: SqlDriver,
  workspaceId: string,
  worktreeId: string,
  directory: string,
  state: string,
): void {
  driver
    .prepare(
      `INSERT INTO worktree_row (workspace_id, worktree_id, directory, state)
       VALUES (?, ?, ?, ?)`,
    )
    .run(workspaceId, worktreeId, directory, state);
}

export function readWorktree(
  driver: SqlDriver,
  workspaceId: string,
  worktreeId: string,
): WorktreeRow | undefined {
  const row = driver
    .prepare(
      `SELECT worktree_id, directory, state
       FROM worktree_row
       WHERE workspace_id = ? AND worktree_id = ?`,
    )
    .get(workspaceId, worktreeId);
  if (row === undefined || row === null || typeof row !== 'object') return undefined;
  const id = own(row, 'worktree_id');
  const directory = own(row, 'directory');
  const state = own(row, 'state');
  if (typeof id !== 'string' || typeof directory !== 'string' || typeof state !== 'string') return undefined;
  return { worktreeId: id, directory, state };
}

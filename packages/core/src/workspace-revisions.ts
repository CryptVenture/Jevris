/**
 * The workspace revision as the sidecar sees it (DEC-12, US31, §7.1).
 *
 * A revision reported by the caller (an event's `revision`) resets it; each write-tool completion
 * after that moves it on (`<reported>.w<n>`). A decision records the revision it started on and
 * passes `current()` as the engine's `currentRevision`, so a result that arrives after a write
 * or a new reported revision is stale: kept for analysis, never acted on.
 *
 * One process-wide instance (`WORKSPACE_REVISIONS`) is shared by the sidecar's event subscriber
 * and its ops, so a CLI decision in flight also goes stale when a hook reports a write.
 */
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class WorkspaceRevisions {
  readonly #entries = new Map<string, { base: string; writes: number }>();
  readonly #max: number;

  constructor(maxTracked = 1024) {
    this.#max = Math.max(1, maxTracked);
  }

  /** The current revision of a workspace; `fallback` when nothing was reported yet. */
  current(workspaceId: string, fallback = 'r0'): string {
    const entry = this.#entries.get(workspaceId);
    if (entry === undefined) return fallback;
    return entry.writes === 0 ? entry.base : `${entry.base.slice(0, 100)}.w${entry.writes}`;
  }

  /** Records what one event says: its reported revision (if any) and whether it wrote files. */
  observe(workspaceId: string, input: { readonly revision?: string | null; readonly wrote: boolean }): string {
    const known = this.#entries.get(workspaceId);
    const reported = typeof input.revision === 'string' && REVISION.test(input.revision) ? input.revision : null;
    const next = known === undefined ? { base: reported ?? 'r0', writes: 0 } : reported !== null && reported !== known.base ? { base: reported, writes: 0 } : known;
    if (input.wrote) next.writes += 1;
    this.#entries.delete(workspaceId);
    this.#entries.set(workspaceId, next);
    if (this.#entries.size > this.#max) {
      const first = this.#entries.keys().next();
      if (first.done !== true) this.#entries.delete(first.value);
    }
    return this.current(workspaceId);
  }
}

/** The sidecar process's shared tracker. */
export const WORKSPACE_REVISIONS = new WorkspaceRevisions();

/**
 * The link between an interactive harness session and its task (owner decision 29423b6; B, D and
 * E). A Kilo or OpenCode main session may be switched per turn only while it is linked to a task;
 * D's approvedScopeFor reads the link through `sessionLinkFor`, and an unlinked session gets
 * advice only.
 *
 * - One link per session (workspace, session id). It names the harness, the task, when it was
 *   made and how (`route` from the CLI, `plan` or `handoff` by the sidecar itself).
 * - The session's own record decides whether it is live: a link on an ended session reads as
 *   unlinked, and recordSession drops it when the session ends.
 * - Every link and unlink writes its audit row in the same transaction (`session.link`,
 *   `session.unlink`). The caller (the sidecar's admin op) checks the channel, the kill switch and
 *   the task; this module keeps the record.
 * - `session.last_seen_at_ms` (added here) is the time of the session's latest recorded event, so
 *   the op can tell which sessions were seen recently.
 */
import { field, isKey, isMs, num, read, refuse, str, write } from './access.js';
import { AUDIT_CHANNELS, appendAuditRow, type AuditChannel } from './governance.js';
import type { SqlDriver } from './schema.js';
import type { OpenStoreResult, StoreRefusal } from './open.js';

/** v10: session links, and the session's last-seen time (added by `ensureSessionLastSeen`). */
export const SESSION_LINK_SQL = `
CREATE TABLE IF NOT EXISTS session_link (
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  harness TEXT NOT NULL CHECK (length(harness) BETWEEN 1 AND 64),
  task_id TEXT NOT NULL CHECK (length(task_id) BETWEEN 1 AND 128),
  via TEXT NOT NULL CHECK (via IN ('route', 'plan', 'handoff')),
  linked_at_ms INTEGER NOT NULL CHECK (linked_at_ms >= 0),
  PRIMARY KEY (workspace_id, session_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS session_link_task ON session_link (workspace_id, task_id);
`;

/** The idempotent column addition of v10, for the session table of every older store. */
export function ensureSessionLastSeen(driver: SqlDriver): void {
  const columns = (driver.prepare('PRAGMA table_info(session)').all() as readonly unknown[]).map((row) => str(field(row, 'name')));
  if (!columns.includes('last_seen_at_ms')) {
    driver.exec('ALTER TABLE session ADD COLUMN last_seen_at_ms INTEGER');
    driver.exec('UPDATE session SET last_seen_at_ms = COALESCE(ended_at_ms, started_at_ms) WHERE last_seen_at_ms IS NULL');
  }
  driver.exec('CREATE INDEX IF NOT EXISTS session_seen ON session (workspace_id, harness, state, last_seen_at_ms)');
}

export const SESSION_LINK_VIA = ['route', 'plan', 'handoff'] as const;
export type SessionLinkVia = (typeof SESSION_LINK_VIA)[number];

/** The most sessions `listActiveSessions` returns. */
export const ACTIVE_SESSIONS_MAX = 64;

const HARNESS = /^[a-z][a-z0-9-]{0,63}$/;
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/;

export interface SessionLink {
  readonly sessionId: string;
  readonly harness: string;
  readonly taskId: string;
  readonly linkedAtMs: number;
  readonly via: SessionLinkVia;
}

export interface ActiveSession {
  readonly sessionId: string;
  readonly harness: string;
  readonly lastSeenAtMs: number;
}

export interface SessionLinkChange {
  readonly actor: string;
  readonly channel: AuditChannel;
  readonly atMs: number;
}

/** Why a link or unlink did not happen (the op maps these to its reason codes). */
export type SessionLinkRefusal = 'unknown-session' | 'session-ended' | 'harness-mismatch' | 'session-already-linked';

function checkChange(change: SessionLinkChange): boolean {
  return typeof change.actor === 'string' && ACTOR.test(change.actor) && (AUDIT_CHANNELS as readonly string[]).includes(change.channel) && isMs(change.atMs);
}

function viaOf(value: unknown): SessionLinkVia | undefined {
  return typeof value === 'string' && (SESSION_LINK_VIA as readonly string[]).includes(value) ? (value as SessionLinkVia) : undefined;
}

function linkOf(row: unknown): SessionLink | undefined {
  const sessionId = str(field(row, 'session_id'));
  const harness = str(field(row, 'harness'));
  const taskId = str(field(row, 'task_id'));
  const linkedAtMs = num(field(row, 'linked_at_ms'));
  const via = viaOf(field(row, 'via'));
  if (sessionId === undefined || harness === undefined || taskId === undefined || linkedAtMs === undefined || via === undefined) return undefined;
  return { sessionId, harness, taskId, linkedAtMs, via };
}

/**
 * The live link of a session in this workspace, or undefined: no link, a session that is not
 * recorded or not active, or an unreadable store. D's approvedScopeFor reads this.
 */
export function sessionLinkFor(store: OpenStoreResult | undefined, sessionId: string): SessionLink | undefined {
  if (store === undefined || !isKey(sessionId)) return undefined;
  try {
    const result = read(store, ({ driver, workspaceId }) =>
      linkOf(
        driver
          .prepare(
            `SELECT l.session_id, l.harness, l.task_id, l.linked_at_ms, l.via FROM session_link AS l
             JOIN session AS s ON s.workspace_id = l.workspace_id AND s.session_id = l.session_id
             WHERE l.workspace_id = ? AND l.session_id = ? AND s.state = 'active' AND s.harness = l.harness`,
          )
          .get(workspaceId, sessionId),
      ),
    );
    return result !== undefined && !Object.hasOwn(result, 'ok') ? (result as SessionLink) : undefined;
  } catch {
    return undefined;
  }
}

/** The most links `listSessionLinks` returns (status shows at most 16). */
export const SESSION_LINKS_MAX = 16;

/** The live links in this workspace (active sessions on the linked harness), newest first. */
export function listSessionLinks(store: OpenStoreResult, limit: number = SESSION_LINKS_MAX): readonly SessionLink[] | StoreRefusal {
  const cap = Math.max(1, Math.min(SESSION_LINKS_MAX, Math.trunc(limit)));
  return read(store, ({ driver, workspaceId }) => {
    const rows = driver
      .prepare(
        `SELECT l.session_id, l.harness, l.task_id, l.linked_at_ms, l.via FROM session_link AS l
         JOIN session AS s ON s.workspace_id = l.workspace_id AND s.session_id = l.session_id
         WHERE l.workspace_id = ? AND s.state = 'active' AND s.harness = l.harness
         ORDER BY l.linked_at_ms DESC, l.session_id LIMIT ?`,
      )
      .all(workspaceId, cap) as readonly unknown[];
    return rows.map(linkOf).filter((link): link is SessionLink => link !== undefined);
  });
}

/** The active sessions of a harness in this workspace seen at or after `sinceMs`, newest first. */
export function listActiveSessions(store: OpenStoreResult, input: { readonly harness?: string; readonly sinceMs: number; readonly limit?: number }): readonly ActiveSession[] | StoreRefusal {
  if (!isMs(input.sinceMs) || (input.harness !== undefined && !HARNESS.test(input.harness))) return refuse('invalid-input');
  const limit = Math.max(1, Math.min(ACTIVE_SESSIONS_MAX, Math.trunc(input.limit ?? ACTIVE_SESSIONS_MAX)));
  return read(store, ({ driver, workspaceId }) => {
    const rows = (
      input.harness === undefined
        ? driver.prepare(`SELECT session_id, harness, last_seen_at_ms FROM session WHERE workspace_id = ? AND state = 'active' AND last_seen_at_ms >= ? ORDER BY last_seen_at_ms DESC, session_id LIMIT ?`).all(workspaceId, input.sinceMs, limit)
        : driver.prepare(`SELECT session_id, harness, last_seen_at_ms FROM session WHERE workspace_id = ? AND harness = ? AND state = 'active' AND last_seen_at_ms >= ? ORDER BY last_seen_at_ms DESC, session_id LIMIT ?`).all(workspaceId, input.harness, input.sinceMs, limit)
    ) as readonly unknown[];
    const out: ActiveSession[] = [];
    for (const row of rows) {
      const sessionId = str(field(row, 'session_id'));
      const harness = str(field(row, 'harness'));
      const lastSeenAtMs = num(field(row, 'last_seen_at_ms'));
      if (sessionId !== undefined && harness !== undefined && lastSeenAtMs !== undefined) out.push({ sessionId, harness, lastSeenAtMs });
    }
    return out;
  });
}

/**
 * Links a recorded, active session of `harness` to `taskId`. A session already linked to the same
 * task answers `already-linked`; linked to another task, it is refused unless `replace` is set.
 */
export function linkSession(
  store: OpenStoreResult,
  input: { readonly sessionId: string; readonly harness: string; readonly taskId: string; readonly via: SessionLinkVia; readonly replace?: boolean } & SessionLinkChange,
):
  | { readonly ok: true; readonly result: 'linked' | 'already-linked'; readonly link: SessionLink; readonly lastSeenAtMs: number; readonly auditSeq: number | null }
  | { readonly ok: false; readonly refusal: SessionLinkRefusal }
  | StoreRefusal {
  if (!isKey(input.sessionId) || !HARNESS.test(input.harness) || !isKey(input.taskId) || viaOf(input.via) === undefined || !checkChange(input)) return refuse('invalid-input');
  return write(store, ({ driver, workspaceId }) => {
    const session = driver.prepare('SELECT harness, state, last_seen_at_ms, started_at_ms FROM session WHERE workspace_id = ? AND session_id = ?').get(workspaceId, input.sessionId);
    if (session === undefined) return { ok: false as const, refusal: 'unknown-session' as const };
    if (str(field(session, 'harness')) !== input.harness) return { ok: false as const, refusal: 'harness-mismatch' as const };
    if (str(field(session, 'state')) !== 'active') return { ok: false as const, refusal: 'session-ended' as const };
    const lastSeenAtMs = num(field(session, 'last_seen_at_ms')) ?? num(field(session, 'started_at_ms')) ?? 0;
    const before = linkOf(driver.prepare('SELECT session_id, harness, task_id, linked_at_ms, via FROM session_link WHERE workspace_id = ? AND session_id = ?').get(workspaceId, input.sessionId));
    if (before !== undefined && before.taskId === input.taskId && before.harness === input.harness) {
      return { ok: true as const, result: 'already-linked' as const, link: before, lastSeenAtMs, auditSeq: null };
    }
    if (before !== undefined && input.replace !== true) return { ok: false as const, refusal: 'session-already-linked' as const };
    driver
      .prepare(
        `INSERT INTO session_link (workspace_id, session_id, harness, task_id, via, linked_at_ms) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, session_id) DO UPDATE SET harness = excluded.harness, task_id = excluded.task_id, via = excluded.via, linked_at_ms = excluded.linked_at_ms`,
      )
      .run(workspaceId, input.sessionId, input.harness, input.taskId, input.via, input.atMs);
    const audit = appendAuditRow(
      driver,
      { kind: 'session.link', actor: input.actor, channel: input.channel, atMs: input.atMs },
      { workspace: workspaceId, harness: input.harness, session: input.sessionId, task: input.taskId, via: input.via, replaced: before === undefined ? null : before.taskId },
    );
    return { ok: true as const, result: 'linked' as const, link: { sessionId: input.sessionId, harness: input.harness, taskId: input.taskId, linkedAtMs: input.atMs, via: input.via }, lastSeenAtMs, auditSeq: audit.seq };
  });
}

/** Removes a session's link. Only tightens, so it works while owned automation is stopped. */
export function unlinkSession(
  store: OpenStoreResult,
  input: { readonly sessionId: string } & SessionLinkChange,
): { readonly ok: true; readonly result: 'unlinked' | 'not-linked'; readonly link: SessionLink | null; readonly auditSeq: number | null } | StoreRefusal {
  if (!isKey(input.sessionId) || !checkChange(input)) return refuse('invalid-input');
  return write(
    store,
    ({ driver, workspaceId }) => {
      const link = dropLink(driver, workspaceId, input.sessionId, input);
      return link === undefined
        ? { ok: true as const, result: 'not-linked' as const, link: null, auditSeq: null }
        : { ok: true as const, result: 'unlinked' as const, link: link.link, auditSeq: link.seq };
    },
    { ignoreAutomationRefusal: true },
  );
}

/**
 * Deletes a session's link inside the caller's transaction and audits it; undefined when there was
 * none. recordSession calls this when a session ends (channel `system`).
 */
export function dropLink(driver: SqlDriver, workspaceId: string, sessionId: string, change: SessionLinkChange): { readonly link: SessionLink; readonly seq: number } | undefined {
  const link = linkOf(driver.prepare('SELECT session_id, harness, task_id, linked_at_ms, via FROM session_link WHERE workspace_id = ? AND session_id = ?').get(workspaceId, sessionId));
  if (link === undefined) return undefined;
  driver.prepare('DELETE FROM session_link WHERE workspace_id = ? AND session_id = ?').run(workspaceId, sessionId);
  const audit = appendAuditRow(driver, { kind: 'session.unlink', actor: change.actor, channel: change.channel, atMs: change.atMs }, { workspace: workspaceId, harness: link.harness, session: sessionId, task: link.taskId });
  return { link, seq: audit.seq };
}

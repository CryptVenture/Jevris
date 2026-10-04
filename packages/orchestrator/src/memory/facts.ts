/**
 * Contradiction and stale-memory triage (MEM-11; SSOT §9.1, C23, US16) and long-horizon
 * project memory (MEM-12; SSOT §12.3, C24).
 *
 * Facts are keyed by subject and revision. Two facts about the same subject with different
 * values are a contradiction; triage surfaces both with their evidence so the originals can be
 * retrieved. An accepted requirement is never overwritten by a newer, unaccepted claim: the
 * newer claim is kept beside it as a contradiction until a person resolves it. Jev (Noul, C23)
 * may flag semantic conflicts between differently worded facts; it never resolves one.
 *
 * Project memory is a decision log in the host ledger with access scopes. Only verified facts
 * (backed by a current passing receipt) or approved facts (a named human authority) are
 * admitted permanently; unverified agent claims are refused. Retrieval filters by the
 * caller's scopes first, then ranks lexically, or with a Jev Score (C24) when available.
 */
import type { WorkspaceServices } from '../workspace.js';
import { consultNoul, consultScore } from '../capabilities/consult.js';
import { isId, recordKey, safeText, sha256, tokens } from '../util.js';

// ------------------------------------------------------------------------ facts (MEM-11)

export type FactStatus = 'accepted-requirement' | 'verified' | 'observed' | 'hypothesis';

export interface FactRecord {
  readonly id: string;
  readonly workspaceId: string;
  /** What the fact is about, e.g. `api.timeout-ms` or `requirement:R3`. */
  readonly subject: string;
  readonly value: string;
  readonly revision: string;
  readonly status: FactStatus;
  readonly source: string;
  readonly evidenceRefs: readonly string[];
  readonly recordedAtMs: number;
  /** Set when a newer claim conflicts with an accepted requirement and was not applied. */
  readonly heldBack: boolean;
}

const RANK: { readonly [S in FactStatus]: number } = { 'accepted-requirement': 3, verified: 2, observed: 1, hypothesis: 0 };

export interface RecordFactInput {
  readonly subject: string;
  readonly value: string;
  readonly revision: string;
  readonly status: FactStatus;
  readonly source: string;
  readonly evidenceRefs?: readonly string[];
  readonly nowMs?: number;
}

export interface RecordFactResult {
  readonly fact: FactRecord;
  /** The fact now in force for the subject. */
  readonly current: FactRecord;
  readonly contradicts: readonly FactRecord[];
}

function subjectKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200);
}

/** Records a fact; an accepted requirement is never replaced by a lower-status claim. */
export async function recordFact(ws: WorkspaceServices, input: RecordFactInput): Promise<RecordFactResult> {
  const nowMs = input.nowMs ?? Date.now();
  const subject = subjectKey(input.subject);
  return ws.state.transact((tx) => {
    const all = tx.list<FactRecord>('facts').filter((f) => f.workspaceId === ws.workspaceId && f.subject === subject);
    const current = currentOf(all);
    const conflicting = all.filter((f) => f.value !== input.value && !f.heldBack);
    const heldBack = current !== undefined && current.status === 'accepted-requirement' && input.status !== 'accepted-requirement' && current.value !== input.value;
    const fact: FactRecord = {
      id: `F-${sha256(`${subject}\n${input.value}\n${input.revision}\n${String(nowMs)}`).slice(0, 16)}`,
      workspaceId: ws.workspaceId,
      subject,
      value: safeText(input.value, 2000),
      revision: input.revision.slice(0, 128),
      status: input.status,
      source: input.source.slice(0, 128),
      evidenceRefs: [...(input.evidenceRefs ?? [])].slice(0, 16),
      recordedAtMs: nowMs,
      heldBack,
    };
    tx.put('facts', recordKey(ws.workspaceId, fact.id), fact);
    const after = currentOf([...all, fact]) ?? fact;
    return { fact, current: after, contradicts: conflicting };
  });
}

/** The fact in force: highest status, then newest; held-back claims never win. */
function currentOf(list: readonly FactRecord[]): FactRecord | undefined {
  return [...list].filter((f) => !f.heldBack).sort((a, b) => RANK[b.status] - RANK[a.status] || b.recordedAtMs - a.recordedAtMs)[0];
}

export interface Contradiction {
  readonly subject: string;
  readonly current: FactRecord;
  readonly conflicting: readonly FactRecord[];
  /** Evidence handles and receipt ids to retrieve the originals. */
  readonly originals: readonly string[];
  readonly kind: 'value' | 'semantic';
  /** A newer claim that differs from an accepted requirement. */
  readonly requirementProtected: boolean;
  /** The Jev decision that found a semantic conflict (C23), for `jevris explain`; absent for a value conflict. */
  readonly decisionId?: string | null;
}

export interface TriageInput {
  readonly engine?: unknown;
  readonly remainingMs?: number;
  /** Also look for semantic conflicts between differently keyed facts (Jev, C23). */
  readonly semantic?: readonly { readonly a: string; readonly b: string }[];
}

/** The most constraint pairs one checkpoint puts to Jev (C23); each is one bounded question, asked side by side. */
export const MAX_CONSTRAINT_PAIRS = 8;

export interface ConstraintConflict {
  readonly a: string;
  readonly b: string;
  readonly decisionId: string | null;
}

/**
 * C23 at the place constraints are declared (the checkpoint op): each newly declared constraint is recorded as an
 * accepted requirement fact (a person's own words, subject `constraint:<id>`) and put against the constraints already
 * held, at most MAX_CONSTRAINT_PAIRS pairs, to Jev ("do these two facts contradict each other?"). A pair Jev finds
 * contradictory comes back by id; nothing is overwritten and nothing is resolved, and the person decides which holds.
 *
 * The two facts are a person's text, so this asks only with the engine present AND source egress approved; otherwise it
 * does nothing at all (no fact is recorded for a triage that cannot run). A constraint is never read from a capsule
 * line, a handoff or a tool output: only from what the person declared.
 */
export async function checkConstraintConflicts(
  ws: WorkspaceServices,
  input: { readonly constraints: readonly { readonly id: string; readonly text: string }[]; readonly newIds: readonly string[]; readonly engine?: unknown; readonly egressApproved?: boolean; readonly remainingMs?: number },
): Promise<readonly ConstraintConflict[]> {
  if (input.engine === undefined || input.egressApproved !== true || input.newIds.length === 0) return [];
  // Both halves of source egress: the person's preference (above) and the administrator's, which the engine reads.
  try {
    if ((input.engine as { sourceEgress?: () => unknown }).sourceEgress?.() !== 'approved') return [];
  } catch {
    return [];
  }
  const subjectOf = (id: string): string => `constraint:${id}`;
  const known = new Set(ws.state.list<FactRecord>('facts').filter((f) => f.workspaceId === ws.workspaceId).map((f) => f.subject));
  for (const c of input.constraints) {
    if (!known.has(subjectKey(subjectOf(c.id)))) await recordFact(ws, { subject: subjectOf(c.id), value: c.text, revision: 'declared', status: 'accepted-requirement', source: 'user' });
  }
  const pairs: { readonly a: string; readonly b: string }[] = [];
  for (const id of input.newIds) {
    for (const other of input.constraints) {
      if (other.id === id || pairs.length >= MAX_CONSTRAINT_PAIRS) continue;
      // A pair is asked once, whichever of the two is the new one.
      if (pairs.some((p) => (p.a === subjectOf(other.id) && p.b === subjectOf(id)) || (p.a === subjectOf(id) && p.b === subjectOf(other.id)))) continue;
      pairs.push({ a: subjectOf(id), b: subjectOf(other.id) });
    }
  }
  if (pairs.length === 0) return [];
  const found = await triageContradictions(ws, { engine: input.engine, semantic: pairs, ...(input.remainingMs === undefined ? {} : { remainingMs: input.remainingMs }) });
  // A subject is stored lower-cased: its constraint id is found again by that form.
  const idOf = new Map(input.constraints.map((c) => [subjectKey(subjectOf(c.id)), c.id] as const));
  return found
    .filter((c) => c.kind === 'semantic')
    .flatMap((c) => {
      const [subjectA, subjectB] = c.subject.split(' / ');
      const a = subjectA === undefined ? undefined : idOf.get(subjectA);
      const b = subjectB === undefined ? undefined : idOf.get(subjectB);
      return a === undefined || b === undefined ? [] : [{ a, b, decisionId: c.decisionId ?? null }];
    });
}

export async function triageContradictions(ws: WorkspaceServices, input: TriageInput = {}): Promise<readonly Contradiction[]> {
  const bySubject = new Map<string, FactRecord[]>();
  for (const f of ws.state.list<FactRecord>('facts')) {
    if (f.workspaceId !== ws.workspaceId) continue;
    const list = bySubject.get(f.subject) ?? [];
    list.push(f);
    bySubject.set(f.subject, list);
  }
  const out: Contradiction[] = [];
  for (const [subject, list] of bySubject) {
    const current = currentOf(list);
    if (current === undefined) continue;
    const conflicting = list.filter((f) => f.value !== current.value);
    if (conflicting.length === 0) continue;
    out.push({
      subject,
      current,
      conflicting,
      originals: [...new Set([...current.evidenceRefs, ...conflicting.flatMap((f) => f.evidenceRefs)])].slice(0, 32),
      kind: 'value',
      requirementProtected: current.status === 'accepted-requirement' && conflicting.some((f) => f.heldBack),
    });
  }
  // The semantic pairs (at most 8) are judged side by side: the wait is one request, not eight. Two facts are workspace
  // text, so they go only with the administrator's approval (`sendsWorkspaceText`): with it denied the rules stand.
  const facts = ws.state.list<FactRecord>('facts').filter((f) => f.workspaceId === ws.workspaceId);
  const judged = await Promise.all(
    (input.semantic ?? []).slice(0, 8).map(async (pair) => {
      const fa = currentOf(facts.filter((f) => f.subject === subjectKey(pair.a)));
      const fb = currentOf(facts.filter((f) => f.subject === subjectKey(pair.b)));
      if (fa === undefined || fb === undefined) return null;
      const r = await consultNoul(input.engine, {
        capabilityId: 'C23',
        specVersion: '1',
        sendsWorkspaceText: true,
        objective: 'Surface contradictions between remembered facts.',
        instructions: 'Do these two facts contradict each other?',
        whenTrue: 'They cannot both be true for the same revision.',
        whenFalse: 'They are compatible.',
        evidence: [
          { id: 'a', text: `${fa.subject}: ${fa.value} (revision ${fa.revision})`, sourceKind: 'tool', priority: 'high' },
          { id: 'b', text: `${fb.subject}: ${fb.value} (revision ${fb.revision})`, sourceKind: 'tool', priority: 'high' },
        ],
        workspaceId: ws.workspaceId,
        evidenceRevision: `${fa.revision.slice(0, 60)}-${fb.revision.slice(0, 60)}`.replace(/[^A-Za-z0-9._-]/g, '-'),
        ...(input.remainingMs === undefined ? {} : { remainingMs: input.remainingMs }),
        rules: () => ({ value: false, reasonCode: 'RULES_NO_SEMANTIC_CHECK' }),
      });
      return { fa, fb, r };
    }),
  );
  for (const found of judged) {
    if (found === null || !found.r.value) continue;
    const { fa, fb, r } = found;
    const [first, second] = RANK[fa.status] >= RANK[fb.status] ? [fa, fb] : [fb, fa];
    out.push({ subject: `${fa.subject} / ${fb.subject}`, current: first, conflicting: [second], originals: [...first.evidenceRefs, ...second.evidenceRefs], kind: 'semantic', requirementProtected: first.status === 'accepted-requirement', decisionId: r.decisionId });
  }
  return out;
}

/** A person resolves a contradiction: the chosen fact becomes an accepted requirement. */
export async function resolveContradiction(ws: WorkspaceServices, subject: string, value: string, authority: string, nowMs = Date.now()): Promise<FactRecord> {
  const result = await recordFact(ws, { subject, value, revision: 'resolved', status: 'accepted-requirement', source: `resolved-by:${authority.slice(0, 64)}`, nowMs });
  return result.fact;
}

// ---------------------------------------------------------------- project memory (MEM-12)

export type MemoryKind = 'decision' | 'ownership' | 'artifact' | 'convention';

export interface ProjectMemoryEntry {
  readonly id: string;
  /** `workspace:<id>`, `module:<path>` or `org`. */
  readonly scope: string;
  readonly kind: MemoryKind;
  readonly text: string;
  readonly basis: { readonly kind: 'verified'; readonly receiptIds: readonly string[] } | { readonly kind: 'approved'; readonly authority: string };
  readonly revision: string;
  readonly admittedAtMs: number;
  readonly supersedes: string | null;
}

export type AdmitResult =
  | { readonly ok: true; readonly entry: ProjectMemoryEntry }
  | { readonly ok: false; readonly reasonCode: 'UNVERIFIED' | 'RECEIPT_NOT_PASSING' | 'BAD_SCOPE' | 'EMPTY' };

const SCOPE = /^(org|workspace:[A-Za-z0-9._-]{1,128}|module:[A-Za-z0-9._/-]{1,256})$/;

export interface AdmitInput {
  readonly scope: string;
  readonly kind: MemoryKind;
  readonly text: string;
  readonly revision: string;
  /** Receipts that verify the fact (all must be current and passing), or an approving authority. */
  readonly receiptIds?: readonly string[];
  readonly approvedBy?: string | null;
  readonly supersedes?: string | null;
  readonly nowMs?: number;
}

/** Admits a fact permanently only when it is verified by receipts or approved by a person. */
export async function admitProjectMemory(ws: WorkspaceServices, input: AdmitInput): Promise<AdmitResult> {
  if (!SCOPE.test(input.scope)) return { ok: false, reasonCode: 'BAD_SCOPE' };
  const text = safeText(input.text, 2000);
  if (text.trim().length === 0) return { ok: false, reasonCode: 'EMPTY' };
  let basis: ProjectMemoryEntry['basis'];
  const receipts = (input.receiptIds ?? []).filter((r) => isId(r));
  if (receipts.length > 0) {
    for (const id of receipts) {
      const row = ws.receipts.get(ws.workspaceId, id);
      if (row === undefined || row.validity !== 'current' || row.receipt.outcome !== 'passed') return { ok: false, reasonCode: 'RECEIPT_NOT_PASSING' };
    }
    basis = { kind: 'verified', receiptIds: receipts };
  } else if (typeof input.approvedBy === 'string' && input.approvedBy.trim().length > 0) {
    basis = { kind: 'approved', authority: input.approvedBy.slice(0, 128) };
  } else {
    // Unverified agent claims are never remembered permanently.
    return { ok: false, reasonCode: 'UNVERIFIED' };
  }
  const nowMs = input.nowMs ?? Date.now();
  const entry: ProjectMemoryEntry = {
    id: `PM-${sha256(`${input.scope}\n${text}\n${String(nowMs)}`).slice(0, 16)}`,
    scope: input.scope,
    kind: input.kind,
    text,
    basis,
    revision: input.revision.slice(0, 128),
    admittedAtMs: nowMs,
    supersedes: input.supersedes ?? null,
  };
  await ws.host.transact((tx) => tx.put('project-memory', entry.id, entry));
  return { ok: true, entry };
}

export interface RetrieveInput {
  /** Scopes the caller may read. Entries outside them are never returned. */
  readonly scopes: readonly string[];
  readonly query: string;
  readonly limit?: number;
  readonly engine?: unknown;
  readonly egressApproved?: boolean;
  readonly remainingMs?: number;
  /** Told the id of each Jev decision that rescored an entry (C24), for `jevris explain`. */
  readonly onDecision?: (decisionId: string) => void;
}

function inScope(entry: ProjectMemoryEntry, scopes: readonly string[]): boolean {
  return scopes.some((s) => s === entry.scope || (s.startsWith('module:') && entry.scope.startsWith(`${s}/`)));
}

export async function retrieveProjectMemory(ws: WorkspaceServices, input: RetrieveInput): Promise<readonly (ProjectMemoryEntry & { readonly score: number })[]> {
  const all = ws.host.list<ProjectMemoryEntry>('project-memory');
  const superseded = new Set(all.map((e) => e.supersedes).filter((s): s is string => s !== null));
  const visible = all.filter((e) => !superseded.has(e.id) && inScope(e, input.scopes));
  const q = new Set(tokens(input.query.toLowerCase()));
  const lexical = (e: ProjectMemoryEntry) => {
    const t = tokens(e.text.toLowerCase());
    return t.filter((x) => q.has(x)).length / Math.max(1, q.size);
  };
  const scored = visible.map((e) => ({ ...e, score: lexical(e) })).filter((e) => e.score > 0 || q.size === 0);
  scored.sort((a, b) => b.score - a.score || b.admittedAtMs - a.admittedAtMs);
  const limit = Math.max(1, Math.min(input.limit ?? 8, 32));
  if (input.engine === undefined || input.egressApproved !== true || scored.length <= limit) return scored.slice(0, limit);
  const pool = scored.slice(0, limit * 2);
  // Each entry is rescored side by side (at most 64): the wait is one request. The question and the entry are workspace
  // text, so they go only with the administrator's approval too (`sendsWorkspaceText`); with it denied the lexical score stands.
  const rescored = await Promise.all(
    pool.map(async (e) => {
      const r = await consultScore(input.engine, {
        capabilityId: 'C24',
        specVersion: '1',
        sendsWorkspaceText: true,
        objective: 'Retrieve relevant project knowledge.',
        instructions: 'How relevant is this remembered project fact to the current question?',
        anchors: ['Unrelated to the question', 'Only tangentially related to the question', 'Relevant to the question', 'Directly answers the question'],
        evidence: [
          { id: 'question', text: input.query, sourceKind: 'user', priority: 'mandatory' },
          { id: e.id, text: e.text, sourceKind: 'policy', priority: 'high' },
        ],
        workspaceId: ws.workspaceId,
        evidenceRevision: e.revision.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 100) || 'rev',
        ...(input.remainingMs === undefined ? {} : { remainingMs: input.remainingMs }),
        rules: () => ({ score: Math.round(e.score * 3), reasonCode: 'RULES_LEXICAL' }),
      });
      if (r.decisionId !== null) input.onDecision?.(r.decisionId);
      return { ...e, score: r.value };
    }),
  );
  return rescored.sort((a, b) => b.score - a.score || b.admittedAtMs - a.admittedAtMs).slice(0, limit);
}

/** The most project-memory entries a restore puts in front of the session. */
export const RESTORE_MEMORY_LIMIT = 5;

/**
 * C24 at a restore: the project knowledge this workspace holds that bears on the capsule's objective, as plain advice lines. Only entries
 * admitted by a current passing receipt or a named person are ever there (`admitProjectMemory`), read by the scopes this workspace may read
 * (its own, and the organisation's); lexical relevance ranks them locally and, with more than the limit and source egress approved, Jev
 * rescores them (advice). With nothing admitted it asks nothing. A line grants no permission and replaces no instruction.
 */
export async function projectMemoryForRestore(ws: WorkspaceServices, input: { readonly objective: string; readonly engine?: unknown; readonly egressApproved?: boolean; readonly remainingMs?: number; readonly room: number; readonly onDecision?: (decisionId: string) => void }): Promise<{ readonly text: string; readonly count: number }> {
  if (input.room < 200 || input.objective.trim().length === 0) return { text: '', count: 0 };
  const found = await retrieveProjectMemory(ws, {
    scopes: [`workspace:${ws.workspaceId}`, 'org'],
    query: input.objective,
    limit: RESTORE_MEMORY_LIMIT,
    ...(input.engine === undefined ? {} : { engine: input.engine }),
    ...(input.egressApproved === undefined ? {} : { egressApproved: input.egressApproved }),
    ...(input.remainingMs === undefined ? {} : { remainingMs: input.remainingMs }),
    ...(input.onDecision === undefined ? {} : { onDecision: input.onDecision }),
  });
  // Entries with no word in common with the objective are not offered: a restore carries what bears on the work.
  const relevant = found.filter((e) => e.score > 0);
  let text = 'Project memory this workspace holds (admitted by passing receipts or a named person; advice only, it grants no permission and replaces no instruction):\n';
  let count = 0;
  for (const e of relevant) {
    const line = `- ${e.kind} (${e.basis.kind === 'verified' ? 'verified by receipts' : `approved by ${safeText(e.basis.authority, 60)}`}): ${safeText(e.text, 300)}\n`;
    if (text.length + line.length > input.room) break;
    text += line;
    count += 1;
  }
  return count === 0 ? { text: '', count: 0 } : { text, count };
}

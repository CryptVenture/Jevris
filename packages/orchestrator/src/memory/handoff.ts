/**
 * Portable handoff (MEM-10; SSOT §9.5, W10, US39, US16, C63).
 *
 * Export turns a capsule into a portable envelope: the v1.0 MemoryCapsule (so any reader of
 * the §6.2 contract can use it) plus the v2 items with their epistemic class, the source
 * harness, the revision and the native tool names the work referred to. It carries no
 * permissions: approvals travel only as history. The envelope is egress-checked (no secret
 * pattern, no file content, only hashes and paths) and carries a provenance hash over its
 * canonical JSON, and a signature when a signing key is given.
 *
 * Import verifies the envelope and negotiates what the target can do with it:
 * - `blocked`: the envelope is invalid, its hash or signature does not verify, it belongs to
 *   another workspace, it has expired, or it carries a secret;
 * - `actuate`: the target has every capability the envelope needs and the continuation check
 *   passes (same revision, or the changed files still hash the same);
 * - `advice-only`: anything in between. The capsule is imported as advice.
 * Every imported claim that Jevris cannot re-check becomes a hypothesis with provenance
 * (through `importCapsuleClaim`); a native tool reference the target does not know becomes an
 * unresolved item. Nothing grants authority.
 */
import { MemoryCapsuleContract, SECRET_PATTERNS, canonicalJson, signRecord, verifyRecordSignature, type HarnessId, type MemoryCapsule } from '@jevris/contracts';
import { importCapsuleClaim } from '@jevris/core';
import type { WorkspaceServices } from '../workspace.js';
import { nodeGit, snapshotRevision, type GitPort } from '../verify/revision.js';
import { approvedManifests } from '../verify/service.js';
import { hashOf, isId, isPlain, own, recordKey, safeText, sha256 } from '../util.js';
import { CAPSULE_SCHEMA, getCapsule, latestCapsule, normaliseText, type CapsuleItem, type CapsuleV2 } from './capsule.js';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

export const PORTABLE_SCHEMA = 'jevris-portable-capsule-2';

/** OpenCode's tool names; the Kilo CLI (built on OpenCode) reports the same ones (harness parity audit G10). */
const OPENCODE_TOOLS = ['bash', 'edit', 'write', 'read', 'grep', 'glob', 'list', 'patch', 'todowrite', 'todoread', 'webfetch', 'task'] as const;

/**
 * Native tool names per harness (naming facts, not capability claims). Kilo's are OpenCode's,
 * not the legacy VS Code extension's (`read_file`, `execute_command`). Antigravity's are the ones
 * its hook payloads name, as in the adapter's fixtures and tool classes (G10).
 */
export const NATIVE_TOOLS: { readonly [H in HarnessId]: readonly string[] } = {
  claude: ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Grep', 'Glob', 'LS', 'Task', 'TodoWrite', 'NotebookEdit', 'WebFetch', 'WebSearch'],
  codex: ['shell', 'apply_patch', 'update_plan', 'view_image', 'web_search'],
  opencode: OPENCODE_TOOLS,
  kilocode: OPENCODE_TOOLS,
  antigravity: [
    'run_command',
    'write_to_file',
    'replace_file_content',
    'multi_replace_file_content',
    'view_file',
    'view_file_outline',
    'view_code_item',
    'grep_search',
    'find_by_name',
    'list_dir',
    'codebase_search',
    'read_url_content',
    'search_web',
    'read_browser_page',
  ],
};

/** Capabilities an envelope may need, and how Jevris names them. */
export const PORTABLE_CAPABILITIES = ['context-injection', 'verify-runner', 'task-ledger', 'owned-workers'] as const;
export type PortableCapability = (typeof PORTABLE_CAPABILITIES)[number];

export interface PortableItem {
  readonly id: string;
  readonly kind: CapsuleItem['kind'];
  readonly text: string;
  readonly epistemic: CapsuleItem['epistemic'];
  readonly refs: readonly string[];
}

export interface PortableEnvelope {
  readonly schemaVersion: typeof PORTABLE_SCHEMA;
  readonly capsule: MemoryCapsule;
  readonly items: readonly PortableItem[];
  readonly source: {
    readonly harness: HarnessId | null;
    readonly workspaceId: string;
    readonly head: string;
    readonly branch: string | null;
    readonly lockfileHash: string;
    readonly changedFiles: readonly { readonly path: string; readonly hash: string }[];
    readonly exportedAt: string;
  };
  readonly toolRefs: readonly { readonly harness: HarnessId; readonly tool: string }[];
  readonly requiredCapabilities: readonly PortableCapability[];
  readonly openChecks: readonly string[];
  readonly signature?: { readonly algorithm: 'ed25519'; readonly keyId: string; readonly value: string };
}

// --------------------------------------------------------------------------------- export

export interface ExportInput {
  readonly capsuleId: string | null;
  readonly taskId: string | null;
  readonly sourceHarness?: HarnessId | null;
  readonly toolRefs?: readonly string[];
  readonly validForMs?: number;
  readonly signing?: { readonly privateKeyPem: string; readonly keyId: string };
  readonly nowMs?: number;
}

export type ExportResult =
  | { readonly ok: true; readonly envelope: PortableEnvelope; readonly contentHash: string; readonly capsuleId: string }
  | { readonly ok: false; readonly reasonCode: 'NOT_FOUND' | 'EGRESS_BLOCKED' | 'CONTRACT_INVALID' };

function hashRef(hex: string): string {
  return `sha256:${/^[0-9a-f]{64}$/.test(hex) ? hex : sha256(hex)}`;
}

function toV1(c: CapsuleV2, validUntil: string): MemoryCapsule {
  const observedAt = c.createdAt;
  const revision = isId(c.revision.head.slice(0, 40)) ? c.revision.head.slice(0, 40) : 'unknown';
  const ref = (item: CapsuleItem, trust: 'human-input' | 'verified-policy' | 'untrusted-content') => ({
    id: item.id.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 128) || 'item',
    workspaceId: c.workspaceId,
    contentHash: `sha256:${sha256(item.text)}`,
    sourceKind: item.source === 'user' ? ('user' as const) : item.source === 'receipt' ? ('receipt' as const) : item.source === 'git' ? ('file' as const) : ('tool' as const),
    trust,
    observedAt,
    revision,
  });
  const pinned = c.items.filter((i) => i.mandatory && i.epistemic !== 'hypothesis').slice(0, 256);
  const optional = c.items.filter((i) => !i.mandatory && i.epistemic !== 'hypothesis').slice(0, 1024);
  return {
    id: c.id,
    schemaVersion: '1.0',
    workspaceId: c.workspaceId,
    revision,
    objective: c.objective.slice(0, 4000),
    pinnedEvidence: pinned.map((i) => ref(i, i.source === 'user' ? 'human-input' : 'untrusted-content')),
    optionalEvidence: optional.map((i) => ref(i, 'untrusted-content')),
    taskIds: c.taskId === null ? [] : [c.taskId],
    unresolvedItems: c.items.filter((i) => i.kind === 'unresolved' || i.kind === 'open-check').map((i) => i.text.slice(0, 1000)).slice(0, 256),
    hypotheses: c.items.filter((i) => i.epistemic === 'hypothesis').map((i) => i.text.slice(0, 1000)).slice(0, 256),
    authorizationHistoryRefs: c.approvals.map((a) => a.id).filter((id) => isId(id)).slice(0, 256),
    validUntil,
  };
}

/** True when any secret pattern matches the serialized value. */
export function containsSecret(value: unknown): boolean {
  const text = JSON.stringify(value);
  return SECRET_PATTERNS.some((p) => new RegExp(p, 'u').test(text));
}

export function envelopeHash(envelope: PortableEnvelope): string {
  const rest: { [k: string]: unknown } = {};
  for (const [k, v] of Object.entries(envelope)) if (k !== 'signature') rest[k] = v;
  return `sha256:${sha256(canonicalJson(rest))}`;
}

/**
 * The newest capsule for a task. A task with no capsule of its own falls back to the workspace-wide
 * capsule only when that capsule's task graph names the task; an unknown task id is not found
 * (it never exports an unrelated capsule).
 */
function capsuleForTask(ws: WorkspaceServices, taskId: string | null): CapsuleV2 | undefined {
  const own = latestCapsule(ws, taskId);
  if (own !== undefined || taskId === null) return own;
  const global = latestCapsule(ws, null);
  return global !== undefined && global.taskGraph.some((t) => t.id === taskId) ? global : undefined;
}

export function exportPortable(ws: WorkspaceServices, input: ExportInput): ExportResult {
  const nowMs = input.nowMs ?? Date.now();
  const capsule = input.capsuleId !== null ? getCapsule(ws, input.capsuleId) : capsuleForTask(ws, input.taskId);
  if (capsule === undefined) return { ok: false, reasonCode: 'NOT_FOUND' };
  const validUntil = new Date(nowMs + Math.max(60_000, Math.min(input.validForMs ?? 7 * 86_400_000, 90 * 86_400_000))).toISOString();
  const v1 = toV1(capsule, validUntil);
  if (!MemoryCapsuleContract.validate(v1).ok) return { ok: false, reasonCode: 'CONTRACT_INVALID' };
  const harness = input.sourceHarness ?? null;
  const toolRefs = harness === null ? [] : [...new Set(input.toolRefs ?? [])].filter((t) => /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(t)).slice(0, 64).map((tool) => ({ harness, tool }));
  const needs = new Set<PortableCapability>(['context-injection']);
  if (capsule.items.some((i) => i.kind === 'open-check')) needs.add('verify-runner');
  if (capsule.taskGraph.length > 0) needs.add('task-ledger');
  if (capsule.taskGraph.some((t) => ['leased', 'running'].includes(t.state))) needs.add('owned-workers');
  const unsigned: PortableEnvelope = {
    schemaVersion: PORTABLE_SCHEMA,
    capsule: v1,
    // Approvals never travel as items: an import grants nothing.
    items: capsule.items
      .filter((i) => i.kind !== 'approval')
      .map((i) => ({ id: i.id, kind: i.kind, text: safeText(i.text, 1000), epistemic: i.epistemic, refs: i.refs.filter((r) => /^(ev:|sha256:|[0-9a-f]{16,64}$|[A-Za-z0-9._-]{1,128}$)/.test(r)).slice(0, 16) })),
    source: {
      harness,
      workspaceId: capsule.workspaceId,
      head: capsule.revision.head,
      branch: capsule.revision.branch,
      lockfileHash: capsule.revision.lockfileHash,
      changedFiles: capsule.items
        .filter((i) => i.kind === 'changed-file')
        .map((i) => ({ path: i.text.split(' (')[0] ?? '', hash: i.refs[0] ?? '' }))
        .filter((f) => f.path.length > 0 && /^[0-9a-f]{64}$|^missing$|^size:\d+$/.test(f.hash))
        .slice(0, 200),
      exportedAt: new Date(nowMs).toISOString(),
    },
    toolRefs,
    requiredCapabilities: PORTABLE_CAPABILITIES.filter((c) => needs.has(c)),
    openChecks: capsule.items.filter((i) => i.kind === 'open-check').map((i) => i.id.replace(/^check-/, '')).slice(0, 64),
  };
  if (containsSecret(unsigned)) return { ok: false, reasonCode: 'EGRESS_BLOCKED' };
  const envelope = input.signing === undefined ? unsigned : (signRecord(unsigned as unknown as { readonly [k: string]: unknown }, input.signing.privateKeyPem, input.signing.keyId) as unknown as PortableEnvelope);
  return { ok: true, envelope, contentHash: envelopeHash(envelope), capsuleId: capsule.id };
}

// --------------------------------------------------------------------------------- import

export type ImportMode = 'actuate' | 'advice-only' | 'blocked';

export interface ImportTarget {
  readonly harness: HarnessId | null;
  /** Capabilities the target has here and now (from certification records). */
  readonly capabilities: readonly PortableCapability[];
}

export interface ImportInput {
  readonly envelope: unknown;
  /** Expected provenance hash, when the sender gave one out of band. */
  readonly contentHash?: string | null;
  readonly trustedKeys?: ReadonlyMap<string, string>;
  readonly target: ImportTarget;
  readonly git?: GitPort;
  readonly nowMs?: number;
}

export interface ContinuationCheck {
  readonly sameHead: boolean;
  readonly changedFilesMatch: number;
  readonly changedFilesDiffer: readonly string[];
  readonly unknownChecks: readonly string[];
  readonly ok: boolean;
}

export interface ImportResult {
  readonly mode: ImportMode;
  readonly reasonCode: string;
  readonly capsuleId: string | null;
  readonly facts: number;
  readonly hypotheses: number;
  readonly unresolved: readonly string[];
  readonly missingCapabilities: readonly PortableCapability[];
  readonly continuation: ContinuationCheck | null;
  readonly authorityGranted: false;
}

function blocked(reasonCode: string): ImportResult {
  return { mode: 'blocked', reasonCode, capsuleId: null, facts: 0, hypotheses: 0, unresolved: [], missingCapabilities: [], continuation: null, authorityGranted: false };
}

function hashFile(root: string, rel: string): string {
  try {
    return sha256(readFileSync(join(root, ...rel.split('/'))));
  } catch {
    return 'missing';
  }
}

function asEnvelope(value: unknown): PortableEnvelope | MemoryCapsule | null {
  if (!isPlain(value)) return null;
  if (own(value, 'schemaVersion') === PORTABLE_SCHEMA) {
    const capsule = own(value, 'capsule');
    const items = own(value, 'items');
    const source = own(value, 'source');
    if (!MemoryCapsuleContract.validate(capsule).ok || !Array.isArray(items) || !isPlain(source)) return null;
    for (const it of items) {
      if (!isPlain(it) || typeof own(it, 'text') !== 'string' || typeof own(it, 'kind') !== 'string' || !['fact', 'hypothesis', 'preference'].includes(own(it, 'epistemic') as string)) return null;
    }
    return value as unknown as PortableEnvelope;
  }
  const v1 = MemoryCapsuleContract.validate(value);
  return v1.ok ? v1.value : null;
}

const KNOWN_KINDS: readonly CapsuleItem['kind'][] = ['objective', 'constraint', 'decision', 'changed-file', 'open-check', 'unresolved', 'rejected-approach', 'hypothesis', 'next-action', 'running-work', 'source-handle'];

export async function importPortable(ws: WorkspaceServices, input: ImportInput): Promise<ImportResult> {
  const nowMs = input.nowMs ?? Date.now();
  const parsed = asEnvelope(input.envelope);
  if (parsed === null) return blocked('CAPSULE_INVALID');
  // The signature value is base64 key material by design; everything else is scanned.
  const { signature: _signature, ...unsignedPart } = parsed as { readonly signature?: unknown };
  if (containsSecret(unsignedPart)) return blocked('SECRET_IN_CAPSULE');
  const isV2 = (parsed as PortableEnvelope).schemaVersion === PORTABLE_SCHEMA;
  const env = isV2 ? (parsed as PortableEnvelope) : null;
  const v1 = env === null ? (parsed as MemoryCapsule) : env.capsule;
  if (env !== null) {
    const actual = envelopeHash(env);
    if (input.contentHash !== undefined && input.contentHash !== null && input.contentHash !== actual) return blocked('HASH_MISMATCH');
    if (env.signature !== undefined) {
      const check = verifyRecordSignature(env as unknown as { readonly [k: string]: unknown }, input.trustedKeys ?? new Map());
      if (!check.ok) return blocked(`SIGNATURE_${check.reasonCode}`);
    }
  } else if (input.contentHash !== undefined && input.contentHash !== null && input.contentHash !== `sha256:${sha256(canonicalJson(v1))}`) {
    return blocked('HASH_MISMATCH');
  }
  if (v1.workspaceId !== ws.workspaceId) return blocked('WORKSPACE_MISMATCH');
  if (Date.parse(v1.validUntil) <= nowMs) return blocked('CAPSULE_EXPIRED');

  // Continuation check against the current workspace.
  const git = input.git ?? nodeGit();
  const snap = await snapshotRevision(ws.workspaceRoot, git);
  const changed = env?.source.changedFiles ?? [];
  const differ = changed.filter((f) => hashFile(ws.workspaceRoot, f.path) !== f.hash).map((f) => f.path);
  const known = new Set(approvedManifests(ws).map((m) => m.id));
  const unknownChecks = (env?.openChecks ?? []).filter((c) => !known.has(c));
  const sameHead = env !== null && env.source.head === snap.head;
  const continuation: ContinuationCheck = {
    sameHead,
    changedFilesMatch: changed.length - differ.length,
    changedFilesDiffer: differ.slice(0, 32),
    unknownChecks: unknownChecks.slice(0, 32),
    ok: env !== null && (sameHead || differ.length === 0) && differ.length === 0 && unknownChecks.length === 0,
  };

  // Capability negotiation.
  const required = env?.requiredCapabilities ?? ['context-injection'];
  const missing = required.filter((c) => !input.target.capabilities.includes(c));

  // Items: facts stay facts only when Jevris can re-check them here; the rest are hypotheses.
  const provenanceId = `import-${sha256(env === null ? canonicalJson(v1) : envelopeHash(env)).slice(0, 16)}`;
  const items: CapsuleItem[] = [];
  const unresolved: string[] = [];
  const add = (kind: CapsuleItem['kind'], id: string, text: string, epistemic: CapsuleItem['epistemic'], mandatory: boolean, refs: readonly string[] = []) => {
    const clean = safeText(text, 1000);
    items.push({ id: id.slice(0, 128), kind, text: clean, epistemic, mandatory, refs: [...refs, provenanceId].slice(0, 16), source: 'import', textHash: sha256(normaliseText(clean)).slice(0, 32) });
  };
  if (env !== null) {
    for (const it of env.items) {
      const kind = KNOWN_KINDS.includes(it.kind) ? it.kind : 'unresolved';
      if (it.epistemic === 'hypothesis') {
        const claim = importCapsuleClaim({ provenanceId });
        add('hypothesis', it.id, it.text, claim.status === 'hypothesis' ? 'hypothesis' : 'hypothesis', false, it.refs);
      } else if (kind === 'changed-file') {
        const path = it.text.split(' (')[0] ?? '';
        if (differ.includes(path)) {
          add('unresolved', it.id, `${path} changed since the handoff; re-read it before relying on the earlier state.`, 'fact', true);
          unresolved.push(`${path} changed since the handoff.`);
        } else add('changed-file', it.id, it.text, 'fact', false, it.refs);
      } else if (kind === 'constraint' || kind === 'objective') {
        // Constraints stay mandatory; they came from the user in the source session.
        add(kind, it.id, it.text, it.epistemic, true, it.refs);
      } else {
        // Decisions, rejected approaches and next actions from another harness are advice.
        add(kind, it.id, it.text, kind === 'decision' || kind === 'rejected-approach' ? it.epistemic : 'hypothesis', kind === 'unresolved' || kind === 'open-check' || kind === 'rejected-approach', it.refs);
        if (kind === 'unresolved' || kind === 'open-check') unresolved.push(it.text);
      }
    }
    const targetTools = input.target.harness === null ? [] : NATIVE_TOOLS[input.target.harness];
    for (const ref of env.toolRefs) {
      if (input.target.harness !== null && ref.harness === input.target.harness) continue;
      if (targetTools.includes(ref.tool)) continue;
      const text = `The source session used the ${ref.harness} tool "${ref.tool}", which ${input.target.harness ?? 'this harness'} does not have. Treat its results as unverified evidence.`;
      add('unresolved', `tool-${ref.harness}-${ref.tool}`.replace(/[^A-Za-z0-9._-]/g, '-'), text, 'fact', false);
      unresolved.push(text);
    }
  } else {
    add('objective', 'objective', v1.objective, 'fact', true);
    for (const [i, u] of v1.unresolvedItems.entries()) {
      add('unresolved', `u-${String(i)}`, u, 'fact', true);
      unresolved.push(u);
    }
    for (const [i, h] of v1.hypotheses.entries()) add('hypothesis', `h-${String(i)}`, h, 'hypothesis', false);
  }
  for (const c of unknownChecks) unresolved.push(`Check ${c} from the handoff is not approved here.`);

  const mode: ImportMode = missing.length === 0 && continuation.ok ? 'actuate' : 'advice-only';
  const id = `cap-${randomBytes(8).toString('hex')}`;
  const body: Omit<CapsuleV2, 'contentHash'> = {
    schemaVersion: CAPSULE_SCHEMA,
    id,
    workspaceId: ws.workspaceId,
    taskId: v1.taskIds[0] ?? null,
    objective: safeText(v1.objective, 4000),
    revision: { head: env?.source.head ?? 'unknown', branch: env?.source.branch ?? null, revision: v1.revision, lockfileHash: env?.source.lockfileHash ?? 'unknown' },
    environmentHash: 'imported',
    policyVersion: 'imported',
    items,
    taskGraph: v1.taskIds.map((t) => ({ id: t, state: 'unknown', dependencyIds: [] })),
    // Expired or not, imported approvals are history only.
    approvals: v1.authorizationHistoryRefs.map((a) => ({ id: a, scope: 'imported approval reference (history only)', grantedAt: 'unknown', expiresAt: null, status: 'historical' as const })),
    referenceIndex: null,
    budgetTokens: 0,
    usedTokens: 0,
    truncated: false,
    droppedOptional: 0,
    ranking: 'none',
    createdAt: new Date(nowMs).toISOString(),
    supersedes: null,
  };
  const capsule: CapsuleV2 = { ...body, contentHash: `sha256:${hashOf(body)}` };
  await ws.state.transact((tx) => {
    tx.put('capsules', capsule.id, capsule);
    tx.put('capsule-imports', recordKey(ws.workspaceId, capsule.id), { provenanceId, mode, sourceCapsuleId: v1.id, sourceHarness: env?.source.harness ?? null, atMs: nowMs });
    tx.put('capsule-latest', recordKey(ws.workspaceId, capsule.taskId ?? '-'), capsule.id);
  });
  return {
    mode,
    reasonCode: mode === 'actuate' ? 'IMPORTED_ACTUATE' : missing.length > 0 ? 'IMPORTED_ADVICE_ONLY_CAPABILITY' : 'IMPORTED_ADVICE_ONLY_CONTINUATION',
    capsuleId: capsule.id,
    facts: items.filter((i) => i.epistemic === 'fact').length,
    hypotheses: items.filter((i) => i.epistemic === 'hypothesis').length,
    unresolved: unresolved.slice(0, 64).map((u) => safeText(u, 500)),
    missingCapabilities: missing,
    continuation,
    authorityGranted: false,
  };
}

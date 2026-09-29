/**
 * CI receipt import (VER-06, SSOT §10.5, W08, C58, E30).
 *
 * A CI bundle is a signed record from an allowlisted issuer:
 *   { schemaVersion:'jevris-ci-receipts-1', issuerId, jobId, repository, revision, createdAt,
 *     checks:[{ checkId, outcome, results?, rawOutputHash, artifact:{ name, sha256 } }], signature }
 * Import checks, in order: issuer allowlist, Ed25519 signature by a key the issuer owns,
 * artifact access (each named artifact is fetched and its hash matches), and revision binding
 * (a bundle for another revision is recorded as historical, never current). A forged or
 * unlisted issuer is refused and writes nothing.
 *
 * `requiredCheckReport` lists every required check as passed, failed, missing or waived, and
 * names the waiver authority. Waivers come only from the CLI (a trusted channel); nothing here
 * changes CI secrets or required checks.
 */
import { verifyRecordSignature } from '@jevris/contracts';
import type { WorkspaceServices } from '../workspace.js';
import { randomBytes } from 'node:crypto';
import { recordRunnerReceipt, type ReceiptOutcome, type RunnerReceipt, type StoredReceipt } from './receipts.js';
import { nodeGit, scopedRevision, snapshotRevision, type GitPort, type RevisionSnapshot } from './revision.js';
import { approvedManifests } from './service.js';
import { manifestHash } from './manifest.js';
import { isId, isPlain, own, recordKey, sha256, type Rec } from '../util.js';
import type { StructuredResults } from './results.js';
import { receiptScopeOf } from './receipt-scope.js';

export interface TrustedIssuer {
  readonly issuerId: string;
  /** keyId -> PEM SPKI Ed25519 public key. */
  readonly keys: { readonly [keyId: string]: string };
  /** When set, only bundles for this repository are accepted. */
  readonly repository: string | null;
  readonly addedAt: string;
}

export interface ArtifactPort {
  /** The artifact bytes, or null when the importer has no access. */
  fetch(issuerId: string, jobId: string, name: string): Promise<Uint8Array | null>;
}

export type CiImportRefusal =
  | 'INVALID_BUNDLE'
  | 'UNKNOWN_ISSUER'
  | 'REPOSITORY_MISMATCH'
  | 'MISSING_SIGNATURE'
  | 'UNKNOWN_KEY'
  | 'INVALID_KEY'
  | 'BAD_SIGNATURE'
  | 'ARTIFACT_UNAVAILABLE'
  | 'ARTIFACT_MISMATCH';

export type CiImportResult =
  | {
      readonly ok: true;
      readonly binding: 'current' | 'historical';
      readonly receiptIds: readonly string[];
      readonly issuerId: string;
      readonly revision: string;
    }
  | { readonly ok: false; readonly reasonCode: CiImportRefusal; readonly detail: string };

const OUTCOMES: readonly ReceiptOutcome[] = ['passed', 'failed', 'unknown', 'not-run'];

export async function addTrustedIssuer(ws: WorkspaceServices, issuer: Omit<TrustedIssuer, 'addedAt'>, nowMs = Date.now()): Promise<void> {
  if (!isId(issuer.issuerId)) throw new Error('ci: bad issuer id');
  await ws.host.transact((tx) => tx.put('ci-issuers', issuer.issuerId, { ...issuer, addedAt: new Date(nowMs).toISOString() }));
}

export async function removeTrustedIssuer(ws: WorkspaceServices, issuerId: string): Promise<void> {
  await ws.host.transact((tx) => tx.delete('ci-issuers', issuerId));
}

export function trustedIssuers(ws: WorkspaceServices): readonly TrustedIssuer[] {
  return ws.host.list<TrustedIssuer>('ci-issuers');
}

function refuse(reasonCode: CiImportRefusal, detail: string): CiImportResult {
  return { ok: false, reasonCode, detail };
}

interface BundleCheck {
  readonly checkId: string;
  readonly outcome: ReceiptOutcome;
  readonly results: StructuredResults | null;
  readonly rawOutputHash: string;
  readonly artifact: { readonly name: string; readonly sha256: string };
}

function parseChecks(value: unknown): readonly BundleCheck[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) return undefined;
  const out: BundleCheck[] = [];
  for (const raw of value) {
    if (!isPlain(raw)) return undefined;
    const checkId = own(raw, 'checkId');
    const outcome = own(raw, 'outcome');
    const rawOutputHash = own(raw, 'rawOutputHash');
    const artifact = own(raw, 'artifact');
    if (!isId(checkId) || typeof outcome !== 'string' || !OUTCOMES.includes(outcome as ReceiptOutcome)) return undefined;
    if (typeof rawOutputHash !== 'string' || !/^[a-f0-9]{64}$/.test(rawOutputHash)) return undefined;
    if (!isPlain(artifact)) return undefined;
    const name = own(artifact, 'name');
    const hash = own(artifact, 'sha256');
    if (typeof name !== 'string' || !/^[A-Za-z0-9._/-]{1,200}$/.test(name) || name.includes('..')) return undefined;
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) return undefined;
    const results = own(raw, 'results');
    out.push({
      checkId,
      outcome: outcome as ReceiptOutcome,
      results: isPlain(results) ? (results as unknown as StructuredResults) : null,
      rawOutputHash,
      artifact: { name, sha256: hash },
    });
  }
  return out;
}

export interface ImportCiInput {
  readonly bundle: unknown;
  readonly artifacts: ArtifactPort;
  readonly git?: GitPort;
  readonly nowMs?: number;
}

export async function importCiBundle(ws: WorkspaceServices, input: ImportCiInput): Promise<CiImportResult> {
  const bundle = input.bundle;
  if (!isPlain(bundle) || own(bundle, 'schemaVersion') !== 'jevris-ci-receipts-1') return refuse('INVALID_BUNDLE', 'schemaVersion');
  const issuerId = own(bundle, 'issuerId');
  const jobId = own(bundle, 'jobId');
  const repository = own(bundle, 'repository');
  const revision = own(bundle, 'revision');
  if (!isId(issuerId) || !isId(jobId) || typeof repository !== 'string' || repository.length > 300) return refuse('INVALID_BUNDLE', 'identity');
  if (typeof revision !== 'string' || !/^[a-f0-9]{40,64}$/.test(revision)) return refuse('INVALID_BUNDLE', 'revision');
  const checks = parseChecks(own(bundle, 'checks'));
  if (checks === undefined) return refuse('INVALID_BUNDLE', 'checks');
  const issuer = ws.host.get<TrustedIssuer>('ci-issuers', issuerId);
  if (issuer === undefined) return refuse('UNKNOWN_ISSUER', issuerId);
  if (issuer.repository !== null && issuer.repository !== repository) return refuse('REPOSITORY_MISMATCH', repository);
  const signature = verifyRecordSignature(bundle as Rec, new Map(Object.entries(issuer.keys)));
  if (!signature.ok) return refuse(signature.reasonCode, issuerId);
  for (const check of checks) {
    const bytes = await input.artifacts.fetch(issuerId, jobId, check.artifact.name);
    if (bytes === null) return refuse('ARTIFACT_UNAVAILABLE', check.artifact.name);
    if (sha256(bytes) !== check.artifact.sha256) return refuse('ARTIFACT_MISMATCH', check.artifact.name);
  }
  const git = input.git ?? nodeGit();
  const current = await snapshotRevision(ws.workspaceRoot, git);
  const binding: 'current' | 'historical' = current.kind === 'git' && current.head === revision ? 'current' : 'historical';
  // The CI run saw the committed tree at `revision`, with no local edits.
  const clean: RevisionSnapshot = { ...current, head: revision, dirty: [], dirtyHash: sha256('[]'), revision: `g-${revision.slice(0, 16)}` };
  const manifests = new Map(approvedManifests(ws).map((m) => [m.id, m]));
  const nowMs = input.nowMs ?? Date.now();
  const createdRaw = own(bundle, 'createdAt');
  const createdAt = typeof createdRaw === 'string' && !Number.isNaN(Date.parse(createdRaw)) ? new Date(Date.parse(createdRaw)).toISOString() : new Date(nowMs).toISOString();
  const ids: string[] = [];
  for (const check of checks) {
    const manifest = manifests.get(check.checkId);
    const scopes = manifest?.inputScopes ?? [];
    const receipt: RunnerReceipt = {
      schemaVersion: 'jevris-receipt-1',
      id: `rcpt-ci-${randomBytes(8).toString('hex')}`,
      checkId: check.checkId,
      workspaceId: ws.workspaceId,
      taskId: null,
      manifestHash: manifest === undefined ? 'unapproved' : manifestHash(manifest),
      runnerId: issuerId,
      issuer: 'ci-import',
      startedAt: createdAt,
      endedAt: createdAt,
      durationMs: 0,
      executable: null,
      argv: [],
      cwd: '.',
      inputRevision: {
        head: revision,
        dirtyHash: clean.dirtyHash,
        revision: clean.revision,
        scopeRevision: binding === 'current' ? await scopedRevision(ws.workspaceRoot, clean, scopes, git) : `historical-${revision.slice(0, 16)}`,
        branch: null,
        lockfileHash: current.lockfileHash,
      },
      exitCode: null,
      signal: null,
      timedOut: false,
      outcome: check.outcome,
      outcomeReason: `ci:${issuerId}:${jobId}`,
      results: check.results,
      rawOutputHash: check.rawOutputHash,
      rawOutputHandle: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      truncated: false,
      environmentHash: sha256(`ci:${issuerId}`),
      environment: { platform: 'ci', arch: 'ci', node: 'ci', variables: {}, toolchains: {} },
      mandatory: manifest?.mandatory ?? false,
      requirementIds: manifest?.requirementIds ?? [],
      inputScopes: [...scopes],
      ci: { issuerId, keyId: signature.keyId, jobId, artifactHash: check.artifact.sha256 },
    };
    await recordRunnerReceipt(ws.receipts, receipt, nowMs);
    if (binding === 'historical') await ws.receipts.invalidate(ws.workspaceId, [receipt.id], 'other-revision');
    ids.push(receipt.id);
  }
  return { ok: true, binding, receiptIds: ids, issuerId, revision };
}

export interface Waiver {
  readonly checkId: string;
  readonly authority: string;
  readonly reason: string;
  readonly channel: 'cli';
  readonly at: string;
}

/** A waiver is recorded only from the CLI with a named authority; it never counts as a pass. */
export async function waiveCheck(ws: WorkspaceServices, checkId: string, authority: string, reason: string, nowMs = Date.now()): Promise<Waiver> {
  if (!isId(checkId) || authority.trim().length === 0 || authority.length > 120) throw new Error('waiver: check id and authority are required');
  const waiver: Waiver = { checkId, authority: authority.trim(), reason: reason.slice(0, 500), channel: 'cli', at: new Date(nowMs).toISOString() };
  await ws.state.transact((tx) => tx.put('check-waivers', recordKey(ws.workspaceId, checkId), waiver));
  return waiver;
}

export interface RequiredCheckLine {
  readonly checkId: string;
  readonly status: 'passed' | 'failed' | 'missing' | 'waived';
  readonly receiptId: string | null;
  readonly issuer: string | null;
  readonly waiverAuthority: string | null;
  /**
   * True when the check has no current receipt but an earlier one was invalidated (its inputs,
   * branch or lockfile moved): the check must run again on this revision (US17).
   */
  readonly stale: boolean;
}

/** The W08 readiness report: every required check as passed, failed, missing or explicitly waived. */
export function requiredCheckReport(ws: WorkspaceServices, requiredCheckIds: readonly string[]): readonly RequiredCheckLine[] {
  // The newest *current* receipt per check decides: a historical (invalidated) receipt, such as
  // a CI bundle for another revision, never masks or replaces the current state (W04, W08).
  const latest = new Map<string, StoredReceipt>();
  const invalidated = new Set<string>();
  const scope = receiptScopeOf(ws);
  for (const row of ws.receipts.list(ws.workspaceId)) {
    if (!scope.includes(row)) continue;
    if (row.validity !== 'current') {
      invalidated.add(row.receipt.checkId);
      continue;
    }
    const prior = latest.get(row.receipt.checkId);
    if (prior === undefined || prior.receipt.endedAt < row.receipt.endedAt || (prior.receipt.endedAt === row.receipt.endedAt && prior.recordedAtMs < row.recordedAtMs)) latest.set(row.receipt.checkId, row);
  }
  // One line per requested check, in the order asked (duplicates dropped).
  return [...new Set(requiredCheckIds)].map((checkId) => {
    const row = latest.get(checkId);
    const waiver = ws.state.get<Waiver>('check-waivers', recordKey(ws.workspaceId, checkId));
    if (row !== undefined && row.validity === 'current' && row.receipt.outcome === 'passed') {
      return { checkId, status: 'passed', receiptId: row.receipt.id, issuer: row.receipt.ci?.issuerId ?? 'local-runner', waiverAuthority: null, stale: false };
    }
    const stale = row === undefined && invalidated.has(checkId);
    if (waiver !== undefined) return { checkId, status: 'waived', receiptId: row?.receipt.id ?? null, issuer: null, waiverAuthority: waiver.authority, stale };
    if (row !== undefined && row.validity === 'current' && row.receipt.outcome === 'failed') {
      return { checkId, status: 'failed', receiptId: row.receipt.id, issuer: row.receipt.ci?.issuerId ?? 'local-runner', waiverAuthority: null, stale: false };
    }
    return { checkId, status: 'missing', receiptId: row?.receipt.id ?? null, issuer: null, waiverAuthority: null, stale };
  });
}

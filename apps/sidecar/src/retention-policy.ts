import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { copyHostDocument } from '@jevris/contracts';
import { readEffectiveConfig } from '@jevris/orchestrator';
import { jevrisPaths, readAuthorityFile, type AuthorityFileRefusal } from '@jevris/platform';
import { readManagedPolicy } from '@jevris/cli/enterprise-policy';
import { sidecarManagedOptions } from './managed-exec.js';
import { DEFAULT_RETENTION, effectiveRetention, type RetentionPolicy } from '@jevris/store';

/**
 * The retention the sweeper applies (DATA-11, SSOT §16.3, §23.1). One shape everywhere, the
 * SSOT names `rawArtifactRetentionDays` and `decisionRetentionDays`:
 *
 * - the user's choice is `privacy.*RetentionDays` in `jevris.config.json`, read and already
 *   narrowed by the organization policy through D's `readEffectiveConfig`;
 * - `organization.json` and the administrator's `host.json` are HostDocuments (validated by
 *   the contracts' `copyHostDocument`, unknown keys refused) whose `retention.*` values are
 *   maximums: they can only shorten retention;
 * - a policy file that fails validation is reported with its reason code, and the stricter of
 *   the user's value and the default holds for it, so a broken file never lengthens retention.
 */

export type PolicyFileState = 'absent' | 'ok' | 'invalid';

export interface ResolvedRetention {
  readonly policy: RetentionPolicy;
  readonly host: PolicyFileState;
  readonly organization: PolicyFileState;
  /** Reason codes for the files that failed validation (`HOST_POLICY_INVALID`, ...). */
  readonly issues: readonly string[];
}

export type FileRead = { readonly kind: 'missing' } | { readonly kind: 'invalid' } | { readonly kind: 'ok'; readonly value: unknown };

const MAX_POLICY_BYTES = 262_144;

/** Reads a small policy JSON file: missing, invalid (unreadable, oversize, not UTF-8 or JSON) or its value. */
export function readPolicyJson(path: string): FileRead {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    const code = error !== null && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
    return code === 'ENOENT' ? { kind: 'missing' } : { kind: 'invalid' };
  }
  return policyValue(bytes);
}

function policyValue(bytes: Uint8Array): FileRead {
  if (bytes.byteLength > MAX_POLICY_BYTES) return { kind: 'invalid' };
  try {
    return { kind: 'ok', value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown };
  } catch {
    return { kind: 'invalid' };
  }
}

export type AuthorityPolicyRead = FileRead | { readonly kind: 'refused'; readonly reasonCode: AuthorityFileRefusal };

/**
 * SR-4: a policy file that can approve egress (host.json, organization.json), read under the
 * authority-file rules of `@jevris/platform`: a regular file, not a link, owned by this user and
 * writable by nobody else (macOS and Linux), with neither it nor the Jevris home inside a git
 * work tree. A file that breaks a rule is `refused` with its reason code and approves nothing.
 */
export function readAuthorityPolicyJson(path: string, home: string): AuthorityPolicyRead {
  const read = readAuthorityFile(path, { home }, MAX_POLICY_BYTES);
  return read.kind === 'ok' ? policyValue(read.bytes) : read;
}

function policyCap(path: string): { readonly state: PolicyFileState; readonly cap: Partial<RetentionPolicy> | undefined } {
  const read = readPolicyJson(path);
  if (read.kind === 'missing') return { state: 'absent', cap: undefined };
  const doc = read.kind === 'ok' ? copyHostDocument(read.value) : undefined;
  if (doc === undefined) return { state: 'invalid', cap: DEFAULT_RETENTION };
  return { state: 'ok', cap: doc.retention };
}

function minCap(a: Partial<RetentionPolicy> | undefined, b: Partial<RetentionPolicy> | undefined): Partial<RetentionPolicy> | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const pick = (x: number | undefined, y: number | undefined): number | undefined => (x === undefined ? y : y === undefined ? x : Math.min(x, y));
  const raw = pick(a.rawArtifactRetentionDays, b.rawArtifactRetentionDays);
  const decision = pick(a.decisionRetentionDays, b.decisionRetentionDays);
  return { ...(raw !== undefined ? { rawArtifactRetentionDays: raw } : {}), ...(decision !== undefined ? { decisionRetentionDays: decision } : {}) };
}

export function resolveRetention(input: { readonly home?: string; readonly env?: { readonly [key: string]: string | undefined } }): ResolvedRetention {
  const location = { ...(input.home !== undefined ? { home: input.home } : {}), ...(input.env !== undefined ? { env: input.env } : {}) };
  const config = jevrisPaths(location).config;
  let user: Partial<RetentionPolicy> | undefined;
  try {
    const privacy = readEffectiveConfig(location).config.privacy;
    user = { rawArtifactRetentionDays: privacy.rawArtifactRetentionDays, decisionRetentionDays: privacy.decisionRetentionDays };
  } catch {
    user = undefined;
  }
  const host = policyCap(join(config, 'host.json'));
  const organization = policyCap(join(config, 'organization.json'));
  const issues: string[] = [];
  if (host.state === 'invalid') issues.push('HOST_POLICY_INVALID');
  if (organization.state === 'invalid') issues.push('ORGANIZATION_POLICY_INVALID');
  // GOV-05: the managed policy caps retention too; a refused one caps it at the defaults.
  const managed = readManagedPolicy(sidecarManagedOptions());
  if (managed.state === 'refused') issues.push('MANAGED_POLICY_REFUSED');
  const managedCap = managed.state === 'ok' ? managed.document.retention : managed.state === 'refused' ? DEFAULT_RETENTION : undefined;
  return { policy: effectiveRetention(user, organization.cap, minCap(host.cap, managedCap)), host: host.state, organization: organization.state, issues };
}

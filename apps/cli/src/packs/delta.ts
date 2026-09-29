/**
 * The privilege delta of a pack install or upgrade (PAK-02, W11, US28, §11.1): what the candidate
 * version adds over the active one in executable code, egress, tool access and retention,
 * computed against the active host policy.
 *
 * Every item carries a reason code. An item beyond the host policy's ceiling (a privilege that
 * `packPrivileges` does not list, a destination while egress is `deny-until-approved`, or a
 * retention longer than the host allows) is marked `ceiling`: approving the pack cannot lift an
 * administrator's constraint, so such a delta is refused until host policy changes (§16.2).
 * The delta hash binds the pack, both versions, the candidate manifest and the items, so an
 * approval applies to exactly what was shown.
 */
import { contentHash, type ContentHash, type HostDocument } from '@jevris/contracts';
import { manifestHash, type PackManifest } from './manifest.js';

export const DELTA_CATEGORIES = ['executable', 'egress', 'tool-access', 'retention'] as const;
export type DeltaCategory = (typeof DELTA_CATEGORIES)[number];

export const DELTA_REASON_CODES = [
  'EXECUTABLE_ADDED',
  'EXECUTABLE_CHANGED',
  'EGRESS_DESTINATION_ADDED',
  'DATA_SCOPE_ADDED',
  'TOOL_ACCESS_ADDED',
  'ACTION_ADDED',
  'CAPABILITY_ADDED',
  'EFFECT_ADDED',
  'RETENTION_INCREASED',
  'STORAGE_MIGRATION_IRREVERSIBLE',
] as const;
export type DeltaReasonCode = (typeof DELTA_REASON_CODES)[number];

export interface DeltaItem {
  readonly category: DeltaCategory;
  readonly reasonCode: DeltaReasonCode;
  readonly value: string;
  /** `within`: the host policy allows it (or there is no host policy); `ceiling`: it does not. */
  readonly policy: 'within' | 'ceiling';
}

export interface PackDelta {
  readonly packId: string;
  readonly fromVersion: string | null;
  readonly toVersion: string;
  readonly manifestHash: ContentHash;
  readonly items: readonly DeltaItem[];
  readonly hash: ContentHash;
}

function added(next: readonly string[], before: readonly string[]): readonly string[] {
  const seen = new Set(before);
  return [...new Set(next)].filter((item) => !seen.has(item)).sort();
}

/** The delta of `candidate` over `active` (null for a first install) under `host` (null when no host policy is active). */
export function computeDelta(candidate: PackManifest, active: PackManifest | null, host: HostDocument | null): PackDelta {
  const items: DeltaItem[] = [];
  const privileges = host === null ? null : new Set(host.packPrivileges);
  const privilege = (value: string): DeltaItem['policy'] => (privileges === null || privileges.has(value) ? 'within' : 'ceiling');
  const push = (category: DeltaCategory, reasonCode: DeltaReasonCode, value: string, policy: DeltaItem['policy'] = 'within'): void => {
    items.push({ category, reasonCode, value, policy });
  };

  const before = new Map((active?.executables ?? []).map((item) => [item.id, item.sha256]));
  for (const exec of [...(candidate.executables ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const previous = before.get(exec.id);
    if (previous === undefined) push('executable', 'EXECUTABLE_ADDED', `${exec.id} (${exec.path}, sha256 ${exec.sha256.slice(0, 12)})`);
    else if (previous !== exec.sha256) push('executable', 'EXECUTABLE_CHANGED', `${exec.id} (${exec.path}, sha256 ${exec.sha256.slice(0, 12)})`);
  }

  const egressDenied = host !== null && host.egress === 'deny-until-approved';
  for (const host_ of added((candidate.network ?? []).map((item) => item.host), (active?.network ?? []).map((item) => item.host))) {
    push('egress', 'EGRESS_DESTINATION_ADDED', host_, egressDenied ? 'ceiling' : 'within');
  }
  for (const scope of added(candidate.dataScopes, active?.dataScopes ?? [])) push('egress', 'DATA_SCOPE_ADDED', scope, privilege(scope));

  for (const action of added(candidate.actions, active?.actions ?? [])) push('tool-access', 'ACTION_ADDED', action, privilege(action));
  for (const capability of added(candidate.requiresCapabilities, active?.requiresCapabilities ?? [])) push('tool-access', 'CAPABILITY_ADDED', capability, privilege(capability));
  for (const tool of added(candidate.tools ?? [], active?.tools ?? [])) push('tool-access', 'TOOL_ACCESS_ADDED', tool);
  for (const effect of added(candidate.effects ?? [], active?.effects ?? [])) push('tool-access', 'EFFECT_ADDED', effect);

  const nextDays = candidate.storage?.retentionDays ?? 0;
  const previousDays = active?.storage?.retentionDays ?? 0;
  if (nextDays > previousDays) {
    push('retention', 'RETENTION_INCREASED', `${previousDays} to ${nextDays} days`, host !== null && nextDays > host.retention.rawArtifactRetentionDays ? 'ceiling' : 'within');
  }
  for (const migration of candidate.storage?.migrations ?? []) {
    if (migration.reversible || migration.toVersion !== candidate.version) continue;
    if (active !== null && migration.fromVersion !== active.version) continue;
    push('retention', 'STORAGE_MIGRATION_IRREVERSIBLE', `${migration.id} (${migration.fromVersion} to ${migration.toVersion})`);
  }

  const body = {
    packId: candidate.id,
    fromVersion: active?.version ?? null,
    toVersion: candidate.version,
    manifestHash: manifestHash(candidate),
    items,
  };
  return { ...body, hash: contentHash(body) };
}

/** The irreversible migration this activation runs, if any (PAK-05). */
export function irreversibleMigration(delta: PackDelta): DeltaItem | undefined {
  return delta.items.find((item) => item.reasonCode === 'STORAGE_MIGRATION_IRREVERSIBLE');
}

/** Plain-text lines for a delta, one per item, grouped by category. */
export function formatDelta(delta: PackDelta): readonly string[] {
  const lines = [`delta ${delta.packId} ${delta.fromVersion ?? '(none)'} -> ${delta.toVersion}: ${delta.hash}`];
  if (delta.items.length === 0) lines.push('  no new executable code, egress, tool access or retention');
  for (const category of DELTA_CATEGORIES) {
    for (const item of delta.items.filter((entry) => entry.category === category)) {
      lines.push(`  ${category.padEnd(11)} ${item.reasonCode} ${item.value}${item.policy === 'ceiling' ? ' (beyond host policy: POLICY_CEILING)' : ''}`);
    }
  }
  return lines;
}

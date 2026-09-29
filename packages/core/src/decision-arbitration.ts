/**
 * Policy arbitration (DEC-13, §7.7).
 *
 * Resolution order (a Jevris action order, not native harness precedence):
 *   1. organization and security constraints
 *   2. explicit human instruction and approved scope
 *   3. existing budget and lease invariants
 *   4. mandatory verification
 *   5. eligible optimization policies
 *   6. advisory preferences
 *
 * Each decision domain (for example `model-routing` or `context-checkpoint`) has one owner among
 * the optimization packs. Two packs claiming one domain are rejected at install unless a
 * priority is configured. Proposals in different domains coexist; within one domain the higher
 * tier wins, and an `abstain` from a constraint tier vetoes lower tiers in that domain (or in
 * every domain when it names `*`).
 */
import type { Action } from '@jevris/contracts';

export const ARBITRATION_TIERS = [
  'organization-security',
  'human-instruction',
  'budget-lease',
  'mandatory-verification',
  'optimization',
  'advisory',
] as const;
export type ArbitrationTier = (typeof ARBITRATION_TIERS)[number];

const RANK: Readonly<Record<ArbitrationTier, number>> = Object.fromEntries(ARBITRATION_TIERS.map((tier, index) => [tier, index])) as Record<ArbitrationTier, number>;
const CONSTRAINT_TIERS: ReadonlySet<ArbitrationTier> = new Set(['organization-security', 'human-instruction', 'budget-lease', 'mandatory-verification']);

export interface ActionProposal {
  readonly packId: string;
  /** The decision domain, or `*` for a constraint that applies to every domain. */
  readonly domain: string;
  readonly tier: ArbitrationTier;
  readonly action: Action;
}

export interface ArbitrationResult {
  readonly accepted: readonly ActionProposal[];
  readonly rejected: readonly { readonly proposal: ActionProposal; readonly reasonCode: string }[];
}

export interface PackClaim {
  readonly packId: string;
  /** Decision domains this pack's optimization policies act in. */
  readonly owns: readonly string[];
}

export type OwnershipResult =
  | { readonly ok: true; readonly owners: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly conflicts: readonly { readonly domain: string; readonly packs: readonly string[] }[] };

/**
 * Install-time ownership check. `priority` maps a domain to the pack configured to own it; any
 * other unresolved double claim refuses the install.
 */
export function checkPackOwnership(packs: readonly PackClaim[], priority: Readonly<Record<string, string>> = {}): OwnershipResult {
  const claims = new Map<string, string[]>();
  for (const pack of packs) {
    for (const domain of new Set(pack.owns)) {
      const list = claims.get(domain) ?? [];
      list.push(pack.packId);
      claims.set(domain, list);
    }
  }
  const owners: Record<string, string> = {};
  const conflicts: { domain: string; packs: string[] }[] = [];
  for (const [domain, list] of [...claims.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (list.length === 1) {
      owners[domain] = list[0] as string;
      continue;
    }
    const chosen = priority[domain];
    if (chosen !== undefined && list.includes(chosen)) owners[domain] = chosen;
    else conflicts.push({ domain, packs: [...list].sort() });
  }
  return conflicts.length > 0 ? { ok: false, conflicts } : { ok: true, owners };
}

/** Resolves one round of proposals. Deterministic for any input order. */
export function arbitrate(proposals: readonly ActionProposal[], owners: Readonly<Record<string, string>>): ArbitrationResult {
  const rejected: { proposal: ActionProposal; reasonCode: string }[] = [];
  const ordered = [...proposals].sort(
    (a, b) => RANK[a.tier] - RANK[b.tier] || (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0) || (a.packId < b.packId ? -1 : a.packId > b.packId ? 1 : 0),
  );
  const vetoes = new Map<string, ArbitrationTier>();
  const winners = new Map<string, ActionProposal>();
  for (const proposal of ordered) {
    if (!(proposal.tier in RANK)) {
      rejected.push({ proposal, reasonCode: 'UNKNOWN_TIER' });
      continue;
    }
    const veto = vetoes.get(proposal.domain) ?? vetoes.get('*');
    if (veto !== undefined && RANK[veto] < RANK[proposal.tier]) {
      rejected.push({ proposal, reasonCode: `VETOED_BY_${veto.toUpperCase().replace(/-/g, '_')}` });
      continue;
    }
    if (proposal.tier === 'optimization' && owners[proposal.domain] !== proposal.packId) {
      rejected.push({ proposal, reasonCode: 'NOT_DOMAIN_OWNER' });
      continue;
    }
    if (CONSTRAINT_TIERS.has(proposal.tier) && proposal.action.kind === 'abstain') {
      if (!vetoes.has(proposal.domain)) vetoes.set(proposal.domain, proposal.tier);
      if (proposal.domain === '*') {
        winners.set(`*:${proposal.packId}`, proposal);
        continue;
      }
    }
    const current = winners.get(proposal.domain);
    if (current !== undefined) {
      rejected.push({ proposal, reasonCode: RANK[current.tier] < RANK[proposal.tier] ? 'OVERRIDDEN_BY_HIGHER_TIER' : 'DOMAIN_CONFLICT' });
      continue;
    }
    winners.set(proposal.domain, proposal);
  }
  return { accepted: [...winners.values()], rejected };
}

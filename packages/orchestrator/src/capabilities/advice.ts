/**
 * The capability advice envelope for D's capabilities (C17-C48, C57-C72; SSOT §12).
 *
 * Every capability answers with the same shape: a verb (rank, ask, pause, report, abstain), a
 * bounded ranked list, at most one question, the items that stay mandatory (`kept`), the checks
 * that would validate the advice (`validation`), and guard flags that are always false. The
 * advice grants nothing, applies nothing, runs nothing and certifies nothing. Deterministic
 * evidence comes from Jevris state (store tasks and receipts, git, workspace files); the
 * decision engine (C's) is consulted where the catalogue names a Jev primitive, and the rules
 * answer when it abstains, is absent or the deadline is short.
 */
import type { WorkspaceServices } from '../workspace.js';
import type { GitPort } from '../verify/revision.js';
import { safeText, type Rec } from '../util.js';
import type { ConsultResult, ConsultSource } from './consult.js';

export const CAPABILITY_ADVICE_SCHEMA = 'jevris-capability-advice-1' as const;

export type AdviceVerb = 'rank' | 'ask' | 'pause' | 'report' | 'abstain';
export type Primitive = 'Choice' | 'Score' | 'Noul' | 'Rules' | 'Rules+Noul' | 'Rules+Score' | 'Rules+Choice' | 'Offline';

export interface RankedItem {
  readonly id: string;
  readonly label: string;
  /** A rank score in [0, 1] (rules) or the ordinal anchor index (Jev); null when unranked. */
  readonly score: number | null;
  readonly reason: string;
}

/** Guard flags: advice never acts. Each is the literal false. */
export interface CapabilityGuards {
  readonly applied: false;
  readonly authorityGranted: false;
  readonly verified: false;
  readonly permissionChanged: false;
  readonly executed: false;
  readonly allowlistExpanded: false;
  readonly certified: false;
}

export const GUARDS: CapabilityGuards = Object.freeze({
  applied: false,
  authorityGranted: false,
  verified: false,
  permissionChanged: false,
  executed: false,
  allowlistExpanded: false,
  certified: false,
});

export interface CapabilityAdvice {
  readonly schemaVersion: typeof CAPABILITY_ADVICE_SCHEMA;
  readonly capabilityId: string;
  readonly title: string;
  readonly primitive: Primitive;
  readonly verb: AdviceVerb;
  readonly source: ConsultSource;
  readonly reasonCode: string;
  readonly decisionId: string | null;
  readonly summary: string;
  /** The single recommended option (an item id, a label such as `none`, or a route). */
  readonly recommendation: string | null;
  readonly ranked: readonly RankedItem[];
  /** At most one bounded, consequence-focused question. */
  readonly question: string | null;
  /** Items that stay mandatory whatever the ranking says (checks, reviewers, exceptions). */
  readonly kept: readonly string[];
  /** Checks or steps that would validate this advice; advice itself validates nothing. */
  readonly validation: readonly string[];
  /** True when acting on the advice needs an explicit user or organization approval. */
  readonly requiresApproval: boolean;
  readonly notes: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly guards: CapabilityGuards;
}

export interface CapabilityContext {
  readonly ws: WorkspaceServices;
  readonly engine: unknown;
  /** Host source egress approved (config `privacy.sourceEgress`); without it no free text reaches Jev. */
  readonly egressApproved: boolean;
  /** Time left for this request, in ms. It counts down while the capability runs (see registry.ts). */
  readonly remainingMs?: number | undefined;
  readonly nowMs: number;
  readonly git: GitPort;
  readonly platform: string;
  readonly taskId: string | null;
  readonly home: string;
  readonly env: { readonly [key: string]: string | undefined };
}

export type CapabilityHandler = (cx: CapabilityContext, input: Rec) => Promise<CapabilityAdvice>;

export interface CapabilityDefinition {
  readonly id: string;
  readonly title: string;
  readonly primitive: Primitive;
  readonly handle: CapabilityHandler;
}

const LIST_MAX = 64;

function clean(list: readonly string[] | undefined, max = LIST_MAX, len = 300): string[] {
  return [...new Set((list ?? []).map((s) => safeText(s, len)))].slice(0, max);
}

export interface AdviceFields {
  readonly verb: AdviceVerb;
  readonly summary: string;
  readonly recommendation?: string | null;
  readonly ranked?: readonly RankedItem[];
  readonly question?: string | null;
  readonly kept?: readonly string[];
  readonly validation?: readonly string[];
  readonly requiresApproval?: boolean;
  readonly notes?: readonly string[];
  readonly evidenceIds?: readonly string[];
  readonly reasonCode?: string;
}

/** Builds a sanitised envelope; free text is redacted and bounded, lists are capped. */
export function advice(def: Pick<CapabilityDefinition, 'id' | 'title' | 'primitive'>, fields: AdviceFields, consult?: Pick<ConsultResult<unknown>, 'source' | 'reasonCode' | 'decisionId'>): CapabilityAdvice {
  const reason = fields.reasonCode ?? consult?.reasonCode ?? 'RULES';
  return {
    schemaVersion: CAPABILITY_ADVICE_SCHEMA,
    capabilityId: def.id,
    title: def.title,
    primitive: def.primitive,
    verb: fields.verb,
    source: consult?.source ?? 'rules',
    reasonCode: /^[A-Z][A-Z0-9_]{0,63}$/.test(reason) ? reason : 'RULES',
    decisionId: consult?.decisionId ?? null,
    summary: safeText(fields.summary, 1000),
    recommendation: fields.recommendation === undefined || fields.recommendation === null ? null : safeText(fields.recommendation, 200),
    ranked: (fields.ranked ?? []).slice(0, LIST_MAX).map((r) => ({
      id: safeText(r.id, 200),
      label: safeText(r.label, 300),
      score: r.score === null || !Number.isFinite(r.score) ? null : Math.round(r.score * 1000) / 1000,
      reason: safeText(r.reason, 300),
    })),
    question: fields.question === undefined || fields.question === null ? null : safeText(fields.question, 300),
    kept: clean(fields.kept),
    validation: clean(fields.validation),
    requiresApproval: fields.requiresApproval ?? false,
    notes: clean(fields.notes, 16, 500),
    evidenceIds: clean(fields.evidenceIds, LIST_MAX, 140),
    guards: GUARDS,
  };
}

export function abstainAdvice(def: Pick<CapabilityDefinition, 'id' | 'title' | 'primitive'>, reasonCode: string, summary: string): CapabilityAdvice {
  return advice(def, { verb: 'abstain', summary, reasonCode });
}

/** Rank by descending score, then by id, so equal scores are deterministic. */
export function byScore<T extends { readonly score: number | null; readonly id: string }>(a: T, b: T): number {
  return (b.score ?? -1) - (a.score ?? -1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

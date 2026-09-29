/**
 * The chapter 22 release-gate evaluator (§22.2, RLS-01, QA-02).
 *
 * Every gate is a list of named predicates over schema-validated evidence records
 * (`ReleaseEvidence`, packages/contracts/src/release-evidence.ts). Predicates check ranges,
 * freshness, provenance (payload hash, candidate version and commit) and coverage (every
 * harness, every OS, every story). There is no equality to one historic run: any valid
 * evidence that meets the predicates passes, and missing, stale, unsigned, foreign-version or
 * invalid evidence fails with a reason. The evaluator is pure: the CLI loads files and keys.
 */
import {
  CONFORMANCE_CASES,
  CalibrationArtifactContract,
  ACCESS_USAGE_ISOLATION_UNAVAILABLE,
  CertificationRecordContract,
  ECONOMICS_COMPONENTS,
  OPERATING_SYSTEMS,
  OPERATIONS_DRILLS,
  P0_QUESTIONS,
  SECURITY_SCOPE,
  THREAT_CASES,
  contentHash,
  timestampMs,
  verifyRecordSignature,
  type CertificationFeature,
  type EvidenceKind,
  type ReleaseEvidence,
  type RuntimeGate,
} from '@jevris/contracts';

export const GATES = ['api', 'harness', 'security', 'quality', 'economics', 'operations', 'portability', 'perf'] as const;
export type GateId = (typeof GATES)[number];
export type SectionId = GateId | 'acceptance';

export const STORY_IDS: readonly string[] = Array.from({ length: 40 }, (_, i) => `US${String(i + 1).padStart(2, '0')}`);
export const WORKFLOW_IDS: readonly string[] = Array.from({ length: 12 }, (_, i) => `W${String(i + 1).padStart(2, '0')}`);

export type KeyRole = 'owner' | 'security-reviewer' | 'certification' | 'calibration';

export interface TrustedKey {
  readonly keyId: string;
  readonly role: KeyRole;
  readonly publicKeyPem: string;
}

export interface SupportMatrixEntry {
  readonly harness: string;
  readonly os: readonly string[];
  /**
   * The harness is advertised with owned-worker routing: its `plugins/<harness>/harness.json`
   * lists `worker.route`. The harness and portability gates then also require the
   * `<harness>.worker` actuator (owner approval, DOMAINS 72ff950).
   */
  readonly routing?: boolean;
}

export interface LoadedEvidence {
  readonly file: string;
  readonly record: ReleaseEvidence;
}

export interface GateContext {
  /** The release candidate: the running package version. */
  readonly version: string;
  /** The candidate commit; CI-produced evidence must match it when set. */
  readonly commit: string | null;
  readonly nowMs: number;
  readonly evidence: readonly LoadedEvidence[];
  readonly trust: readonly TrustedKey[];
  /** Advertised harness and OS combinations (assets/support-matrix.json). */
  readonly matrix: readonly SupportMatrixEntry[];
  /** Pack ids the package ships; each needs an independent disable drill. */
  readonly packs: readonly string[];
  /**
   * The package's own day-1 baseline, `assets/calibration/calibration-release.json`, parsed;
   * null (or absent) when the package does not ship one. It must be the baseline-release record's payload.
   */
  readonly bundledBaseline?: unknown;
  /**
   * The bundled model registry's lifecycle facts at `nowMs` (modelLifecycleFacts in
   * gate-records.ts). `jevris gates` always supplies them; without them the quality gate has no
   * model-retirement check.
   */
  readonly models?: readonly ModelLifecycleFact[];
}

/** One bundled model as the release sees it: its lifecycle facts, and whether shipped data names it. */
export interface ModelLifecycleFact {
  readonly modelId: string;
  readonly displayName: string;
  /** lifecycle.status in the registry (null when the registry has no lifecycle facts). */
  readonly status: string | null;
  /** The vendor's "not sooner than" date: a warning when near or passed, never a stop (9d1e7eb). */
  readonly notBefore: string | null;
  /** A firm, announced retirement date: from it the router stops recommending the model. */
  readonly retiresOn: string | null;
  /** Shipped data names it: the registry's baseline model, a bundled prior, a default or an allowlist. */
  readonly referenced: boolean;
}

/** An upcoming date or a passed "not sooner than" date within this many days is a warning. */
export const MODEL_RETIREMENT_WINDOW_DAYS = 30;
/**
 * How the gate names the fix. The runtime never names a development-only tree, so it points at
 * RELEASING.md's model-retirement rule, which links the procedure
 * (docs/model-refresh.md in the repository; registry:check names it).
 */
export const MODEL_REFRESH_POINTER = 'the model refresh procedure (RELEASING.md, model retirement)';

/** A model the release warns about, soonest first. */
export interface RetiringModel {
  readonly modelId: string;
  readonly displayName: string;
  /** The date the warning is about: the firm date, else the "not sooner than" date. */
  readonly retirementFrom: string;
  /** Whole days from `nowMs` to that date, rounded down; negative once it has passed. */
  readonly daysLeft: number;
  /** MODEL_RETIREMENT_DUE (a passed "not sooner than" date), MODEL_DEPRECATED, or null for an upcoming date. */
  readonly warning: 'MODEL_RETIREMENT_DUE' | 'MODEL_DEPRECATED' | null;
}

const passed = (date: string | null, nowMs: number): boolean => date !== null && timestampMs(date) <= nowMs;

/**
 * Retired at `nowMs` (owner decision 9d1e7eb): status retired, or a firm retiresOn that has passed.
 * The evaluator reads plain facts, so it states the rule itself; a test holds it equal to core's
 * lifecycleStatus (retired and stale) for every bundled model, so the two cannot drift.
 */
export function retiredAt(model: ModelLifecycleFact, nowMs: number): boolean {
  return model.status === 'retired' || passed(model.retiresOn, nowMs);
}

/** Stale at `nowMs`: the entry is past its firm retiresOn yet does not say retired (core's lifecycleStatus.stale). */
export function staleAt(model: ModelLifecycleFact, nowMs: number): boolean {
  return model.status !== 'retired' && passed(model.retiresOn, nowMs);
}

/**
 * The models the router still recommends at `nowMs` that deserve a warning, soonest first: a firm
 * or "not sooner than" date within `days`, a passed "not sooner than" date (MODEL_RETIREMENT_DUE)
 * or a deprecated status (MODEL_DEPRECATED). None of these fails a release (3ff4c0f, 9d1e7eb).
 */
export function retiringModels(models: readonly ModelLifecycleFact[], nowMs: number, days = MODEL_RETIREMENT_WINDOW_DAYS): readonly RetiringModel[] {
  const out: RetiringModel[] = [];
  for (const model of models) {
    if (retiredAt(model, nowMs)) continue;
    const date = model.retiresOn ?? model.notBefore;
    const at = date === null ? Number.NaN : timestampMs(date);
    const due = model.retiresOn === null && passed(model.notBefore, nowMs);
    const near = Number.isFinite(at) && at > nowMs && at - nowMs <= days * DAY_MS;
    const deprecated = model.status === 'deprecated';
    if (!due && !near && !deprecated) continue;
    out.push({
      modelId: model.modelId,
      displayName: model.displayName,
      retirementFrom: date ?? '',
      daysLeft: Number.isFinite(at) ? Math.floor((at - nowMs) / DAY_MS) : Number.MAX_SAFE_INTEGER,
      warning: due ? 'MODEL_RETIREMENT_DUE' : deprecated ? 'MODEL_DEPRECATED' : null,
    });
  }
  return out.sort((x, y) => x.daysLeft - y.daysLeft || (x.modelId < y.modelId ? -1 : 1));
}

/**
 * Release data that contradicts itself at `nowMs` (the gate fails): (a) a model shipped data
 * names (the baseline, a prior, a default or an allowlist) is retired; (b) a registry entry is
 * stale: its firm retiresOn has passed, yet it still says active or deprecated. The shipped
 * baseline's own priors, (c), are
 * checked by the gate against `ctx.bundledBaseline`.
 */
export function inconsistentModels(models: readonly ModelLifecycleFact[], nowMs: number): readonly { readonly model: ModelLifecycleFact; readonly why: string }[] {
  const out: { model: ModelLifecycleFact; why: string }[] = [];
  for (const model of models) {
    if (model.referenced && retiredAt(model, nowMs)) out.push({ model, why: model.status === 'retired' ? 'is retired, yet shipped data still names it' : `retired on ${String(model.retiresOn).slice(0, 10)}, yet shipped data still names it` });
    else if (staleAt(model, nowMs)) out.push({ model, why: `still says ${model.status ?? 'nothing'} although its retirement date ${String(model.retiresOn).slice(0, 10)} has passed` });
  }
  return out;
}

/** One line per warned model: "Haiku 4.5 (id) may retire from 2026-10-15, in 14 day(s)". */
export function describeRetiring(model: RetiringModel): string {
  const name = `${model.displayName} (${model.modelId})`;
  if (model.warning === 'MODEL_RETIREMENT_DUE') return `${name} may be retired any day: its "not sooner than" date ${model.retirementFrom.slice(0, 10)} has passed (MODEL_RETIREMENT_DUE)`;
  if (model.warning === 'MODEL_DEPRECATED') return `${name} is deprecated (MODEL_DEPRECATED)${model.retirementFrom === '' ? '' : `, may retire from ${model.retirementFrom.slice(0, 10)}`}`;
  return `${name} may retire from ${model.retirementFrom.slice(0, 10)}, in ${model.daysLeft} day(s)`;
}

export interface PredicateResult {
  readonly id: string;
  readonly ok: boolean;
  /** A passing predicate that still needs attention: printed WARN, never fails its gate. */
  readonly warning?: true;
  readonly detail: string;
  readonly evidence: readonly string[];
}

export interface GateResult {
  readonly gate: SectionId;
  readonly verdict: 'pass' | 'fail';
  readonly predicates: readonly PredicateResult[];
}

export interface GatesReport {
  readonly schemaVersion: 'jevris.gates/1';
  readonly version: string;
  readonly commit: string | null;
  readonly evaluatedAt: string;
  readonly verdict: 'pass' | 'fail';
  readonly gates: readonly GateResult[];
  readonly acceptance: GateResult;
  readonly evidence: { readonly accepted: number; readonly rejected: readonly { readonly file: string; readonly reasonCode: string }[] };
}

const DAY_MS = 24 * 60 * 60 * 1000;

type VersionPolicy = 'exact' | 'minor' | 'any';

interface KindPolicy {
  readonly version: VersionPolicy;
  /** Maximum age in days; null when the record carries its own expiry or never expires. */
  readonly maxAgeDays: number | null;
  /** The signer role an envelope signature must verify against; null for machine evidence. */
  readonly signer: KeyRole | null;
}

/**
 * Freshness, version binding and signing per evidence kind. CI-produced evidence is bound to
 * the exact candidate version (and commit); expensive trials and reviews to its major.minor;
 * owner decisions to no version.
 */
export const KIND_POLICY: Readonly<Record<EvidenceKind, KindPolicy>> = {
  'api-live-suite': { version: 'exact', maxAgeDays: 30, signer: null },
  'harness-conformance': { version: 'exact', maxAgeDays: 30, signer: null },
  'certification-record': { version: 'any', maxAgeDays: null, signer: null },
  'installed-e2e': { version: 'exact', maxAgeDays: 14, signer: null },
  'p0-register': { version: 'any', maxAgeDays: 365, signer: 'owner' },
  'security-review': { version: 'minor', maxAgeDays: 180, signer: 'security-reviewer' },
  'threat-model-suite': { version: 'exact', maxAgeDays: 14, signer: null },
  'pre-registration': { version: 'any', maxAgeDays: null, signer: 'owner' },
  'quality-trial': { version: 'minor', maxAgeDays: 180, signer: null },
  // From the owner's seed run (DOMAINS 2d1c6a0): the owner signs it.
  'economics-report': { version: 'minor', maxAgeDays: 180, signer: 'owner' },
  'operations-drills': { version: 'exact', maxAgeDays: 14, signer: null },
  'story-report': { version: 'exact', maxAgeDays: 14, signer: null },
  'workflow-report': { version: 'exact', maxAgeDays: 14, signer: null },
  // The payload is the calibration-signed artifact itself; it carries its own expiry.
  'baseline-release': { version: 'minor', maxAgeDays: null, signer: null },
  // The release run's own test results, like the story and workflow reports.
  'runtime-gate-report': { version: 'exact', maxAgeDays: 14, signer: null },
  // The load run on the reference machine, for this exact candidate.
  'sidecar-load': { version: 'exact', maxAgeDays: 14, signer: null },
};

function majorMinor(version: string): string {
  const [major, minor] = version.split(/[.-]/);
  return `${major}.${minor}`;
}

function trustedFor(trust: readonly TrustedKey[], role: KeyRole): ReadonlyMap<string, string> {
  return new Map(trust.filter((key) => key.role === role).map((key) => [key.keyId, key.publicKeyPem]));
}

/** Why a record does not count for this candidate, or null when it is accepted. */
export function exclusionReason(record: ReleaseEvidence, ctx: GateContext): string | null {
  const policy = KIND_POLICY[record.kind];
  if (contentHash(record.payload) !== record.payloadHash) return 'PAYLOAD_HASH_MISMATCH';
  if (policy.version === 'exact' && record.subject.version !== ctx.version) return 'VERSION_MISMATCH';
  if (policy.version === 'minor' && majorMinor(record.subject.version) !== majorMinor(ctx.version)) return 'VERSION_MISMATCH';
  if (policy.version === 'exact' && ctx.commit !== null && record.subject.commit !== ctx.commit) return 'COMMIT_MISMATCH';
  const produced = timestampMs(record.producedAt);
  if (!Number.isFinite(produced) || produced > ctx.nowMs + 5 * 60 * 1000) return 'FROM_THE_FUTURE';
  if (policy.maxAgeDays !== null && ctx.nowMs - produced > policy.maxAgeDays * DAY_MS) return 'STALE';
  if (policy.signer !== null) {
    const check = verifyRecordSignature(record as unknown as { readonly [key: string]: unknown }, trustedFor(ctx.trust, policy.signer));
    if (!check.ok) return `SIGNATURE_${check.reasonCode}`;
  }
  if (record.kind === 'certification-record') {
    const cert = CertificationRecordContract.validate(record.payload);
    if (!cert.ok) return 'CERTIFICATION_INVALID';
    const signed = verifyRecordSignature(record.payload, trustedFor(ctx.trust, 'certification'));
    if (!signed.ok) return `CERTIFICATION_SIGNATURE_${signed.reasonCode}`;
    const expires = timestampMs(String(record.payload['expiresAt']));
    if (!(ctx.nowMs < expires)) return 'CERTIFICATION_EXPIRED';
  }
  if (record.kind === 'baseline-release') {
    const artifact = CalibrationArtifactContract.validate(record.payload);
    if (!artifact.ok) return 'BASELINE_INVALID';
    const signed = verifyRecordSignature(record.payload, trustedFor(ctx.trust, 'calibration'));
    if (!signed.ok) return `BASELINE_SIGNATURE_${signed.reasonCode}`;
    if (record.payload['releaseState'] !== 'released') return 'BASELINE_DRAFT';
    if (!(ctx.nowMs < timestampMs(String(record.payload['expiresAt'])))) return 'BASELINE_EXPIRED';
  }
  return null;
}

interface Selection {
  readonly accepted: readonly ReleaseEvidence[];
  readonly excluded: readonly string[];
}

function select(ctx: GateContext, kind: EvidenceKind, where: (record: ReleaseEvidence) => boolean = () => true): Selection {
  const accepted: ReleaseEvidence[] = [];
  const excluded: string[] = [];
  for (const { record } of ctx.evidence) {
    if (record.kind !== kind || !where(record)) continue;
    const reason = exclusionReason(record, ctx);
    if (reason === null) accepted.push(record);
    else excluded.push(`${record.id}:${reason}`);
  }
  accepted.sort((a, b) => timestampMs(b.producedAt) - timestampMs(a.producedAt));
  return { accepted, excluded };
}

function none(kind: string, selection: Selection, scope = ''): string {
  const suffix = selection.excluded.length > 0 ? `; excluded ${selection.excluded.slice(0, 6).join(', ')}` : '';
  return `no accepted ${kind} record${scope}${suffix}`;
}

function predicate(id: string, ok: boolean, detail: string, evidence: readonly ReleaseEvidence[] = []): PredicateResult {
  return { id, ok, detail, evidence: evidence.map((record) => record.id) };
}

function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function list(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.map((item) => obj(item)) : [];
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
}

// ---------------------------------------------------------------- api (RLS-06)

export const MIN_API_CALLS = 30;
export const REQUIRED_ERROR_PROBES = 3;
/** SSOT §17.4 engineering targets for a semantic hot-path decision: unmeasured, not SLOs. */
export const HOT_PATH_BUDGET_MS = 900;
export const HOT_PATH_P95_TARGET_MS = 800;
/** Below this share of calls inside the hot budget, the envelope is printed WARN. */
export const WITHIN_BUDGET_WARN_FRACTION = 0.95;
/** A probe that timed out or was cancelled never reached the provider's answer, so it shows no taxonomy. */
const NO_TAXONOMY = new Set(['DEADLINE', 'CANCELLED']);

/**
 * The latency envelope of a live record (SSOT §17.4, P0 exit "knows the latency envelope"). It is
 * a known-or-unknown judgement: an unmeasured envelope fails, a measured one outside the targets is
 * WARN and stays visible, because the targets are engineering targets to benchmark, not SLOs
 * (AGENTS.md). Calls over the budget fall back in the product; the release owner decides.
 */
function latencyEnvelope(latency: Record<string, unknown>, ev: readonly ReleaseEvidence[]): PredicateResult {
  const calls = num(latency['calls']);
  const okCalls = num(latency['okCalls']);
  const p95 = num(latency['p95Ms']);
  const budget = Number.isFinite(num(latency['budgetMs'])) ? num(latency['budgetMs']) : HOT_PATH_BUDGET_MS;
  const within = num(latency['withinBudget']);
  if (!(calls >= MIN_API_CALLS) || okCalls !== calls || !Number.isFinite(p95) || !Number.isFinite(within)) {
    return predicate('api.latency-envelope', false, `unknown: ${String(latency['okCalls'])} of ${String(latency['calls'])} calls measured (need all of at least ${MIN_API_CALLS}), p95 ${String(latency['p95Ms'])} ms`, ev);
  }
  const fraction = within / calls;
  const p95Ok = p95 <= HOT_PATH_P95_TARGET_MS;
  const budgetOk = fraction >= WITHIN_BUDGET_WARN_FRACTION;
  const measure = Number.isFinite(num(latency['measureTimeoutMs'])) ? `, measured with a ${num(latency['measureTimeoutMs'])} ms timeout` : ', censored at the suite deadline (no measureTimeoutMs)';
  const detail = `p95 ${p95} ms ${p95Ok ? 'within' : 'over'} the ${HOT_PATH_P95_TARGET_MS} ms target; ${within} of ${calls} calls (${Math.round(fraction * 1000) / 10}%) within the ${budget} ms budget${measure}`;
  if (p95Ok && budgetOk) return predicate('api.latency-envelope', true, detail, ev);
  return {
    ...predicate('api.latency-envelope', true, `warning: ${detail}. These are unmeasured engineering targets, not SLOs (SSOT §17.4): a call over the budget falls back; the release owner decides whether this envelope ships`, ev),
    warning: true,
  };
}

function apiGate(ctx: GateContext): GateResult {
  const selection = select(ctx, 'api-live-suite', (record) => obj(record.payload)['mode'] === 'live');
  const latest = selection.accepted[0];
  if (latest === undefined) {
    const mocks = ctx.evidence.filter((item) => item.record.kind === 'api-live-suite' && obj(item.record.payload)['mode'] === 'mock').length;
    return result('api', [
      predicate('api.live-suite', false, `${none('live api-live-suite', selection)}${mocks > 0 ? `; ${mocks} mock-mode record(s) do not count` : ''}`),
    ]);
  }
  const p = obj(latest.payload);
  const primitives = obj(p['primitives']);
  const latency = obj(p['latency']);
  const caps = obj(p['caps']);
  const usage = obj(p['usage']);
  const errors = list(p['errors']);
  // A probe counts when the provider's answer mapped to its expected code: not a timeout, not a mismatch.
  const shown = errors.filter((item) => typeof item['reasonCode'] === 'string' && !NO_TAXONOMY.has(String(item['reasonCode'])) && item['matched'] !== false);
  const probes = new Set(shown.map((item) => String(item['probe'])));
  const probeDetail = errors.map((item) => `${String(item['probe'])} ${String(item['reasonCode'])}${typeof item['status'] === 'number' ? ` (${String(item['status'])})` : ''}${item['matched'] === false ? ', not the expected code' : ''}`).join(', ');
  const latencyCalls = num(latency['calls']);
  const latencyOk = num(latency['okCalls']);
  const reasonCounts = Object.entries(obj(latency['reasonCounts'])).map(([code, count]) => `${code} ${String(count)}`).join(', ');
  const ev = [latest];
  return result('api', [
    predicate('api.live-suite', true, `live record ${latest.id} from ${latest.producedAt}`, ev),
    predicate('api.suite-passed', p['passed'] === true, `passed ${String(p['passed'])}`, ev),
    predicate('api.primitives', primitives['choice'] === true && primitives['score'] === true && primitives['noul'] === true, `choice ${String(primitives['choice'])}, score ${String(primitives['score'])}, noul ${String(primitives['noul'])}`, ev),
    predicate('api.cancellation', obj(p['cancellation'])['cancelled'] === true, `cancelled ${String(obj(p['cancellation'])['cancelled'])}`, ev),
    predicate('api.error-taxonomy', probes.size >= REQUIRED_ERROR_PROBES, `${probes.size} error probes answered with their expected code (need ${REQUIRED_ERROR_PROBES}): ${probeDetail === '' ? 'none' : probeDetail}`, ev),
    predicate('api.budget-caps', caps['underCapSent'] === true && caps['overTokenCapRefused'] === true && caps['overTokenCapSent'] === false, `under-cap sent ${String(caps['underCapSent'])}, over-cap refused ${String(caps['overTokenCapRefused'])}, over-cap sent ${String(caps['overTokenCapSent'])}`, ev),
    predicate('api.usage-reconciled', usage['estimateAlwaysConservative'] === true && num(usage['calls']) >= MIN_API_CALLS, `conservative ${String(usage['estimateAlwaysConservative'])}, ${String(usage['calls'])} calls`, ev),
    predicate(
      'api.latency-sample',
      latencyCalls >= MIN_API_CALLS && latencyOk === latencyCalls && latency['p95Ms'] !== null && Number.isFinite(num(latency['p95Ms'])),
      `${String(latency['okCalls'])} of ${String(latency['calls'])} calls measured (need every call, at least ${MIN_API_CALLS}); p50 ${String(latency['p50Ms'])}, p95 ${String(latency['p95Ms'])}, p99 ${String(latency['p99Ms'])}, max ${String(latency['maxMs'])} ms${reasonCounts === '' ? '' : `; failed: ${reasonCounts}`}`,
      ev,
    ),
    latencyEnvelope(latency, ev),
  ]);
}

// ---------------------------------------------------------------- matrix helpers

function advertised(ctx: GateContext): readonly { readonly harness: string; readonly os: string; readonly routing: boolean }[] {
  const out: { harness: string; os: string; routing: boolean }[] = [];
  for (const entry of ctx.matrix) for (const os of entry.os) out.push({ harness: entry.harness, os, routing: entry.routing === true });
  return out;
}

/** The §15.4 cases a list does not show passing. */
function missingCases(value: unknown): readonly string[] {
  const cases = list(value);
  return CONFORMANCE_CASES.filter((name) => !cases.some((item) => item['id'] === name && item['passed'] === true));
}

/** The worker.route certification feature (packages/contracts CERTIFICATION_FEATURES). */
export const WORKER_ROUTE_FEATURE: CertificationFeature = 'worker.route';

/**
 * The route actuators a harness advertised with routing needs certified in its published record,
 * beyond worker.route (routing design R33, cases K1-K4 and K8; owner decisions OD-8 and OD-9).
 * Each is certified with no model call against the loopback stub provider (stub-provider.ts,
 * stub-profile.ts); Antigravity has no custom endpoint, so none applies to it. The ids are plain
 * strings: `worker.actual-model` and `session.route` join CERTIFICATION_FEATURES when the first
 * certify case that emits them lands, and until then the predicate says to certify again.
 */
export const ROUTED_FEATURES: readonly {
  readonly featureId: string;
  readonly slug: string;
  readonly harnesses: readonly string[];
  readonly proves: string;
  /** Reason codes that pass as `unsupported`: a documented gap in the harness, not a failed case. Every other reason blocks. */
  readonly acceptsUnsupported?: readonly string[];
  /** When set, `acceptsUnsupported` holds only on these operating systems; elsewhere the feature must be certified. */
  readonly unsupportedOnlyOn?: readonly string[];
}[] = [
  // 1.2 does not require Codex subagent routing for release; Codex routes subagents only where K2
  // certifies on the installed version, otherwise it advises (coordinator's decision, delegated by
  // the owner, after K2 failed SHELL_NOT_SEEN on Codex 0.157.1 in the RC5 run). Codex's record
  // still carries hooks.route, and the sidecar actuates only on a certified one.
  { featureId: 'hooks.route', slug: 'hooks-route', harnesses: ['claude', 'kilocode', 'opencode'], proves: 'a subagent spawn takes the routed model' },
  { featureId: 'worker.actual-model', slug: 'worker-actual-model', harnesses: ['codex', 'kilocode', 'opencode'], proves: "an owned run's own hooks report the model it used" },
  { featureId: 'session.route', slug: 'session-route', harnesses: ['kilocode', 'opencode'], proves: 'the main session switches model per turn' },
  { featureId: 'models.list-hosts', slug: 'models-list-hosts', harnesses: ['kilocode', 'opencode'], proves: "the model listing keeps each pinned host's spellings on that host" },
  { featureId: 'route.host', slug: 'route-host', harnesses: ['kilocode', 'opencode'], proves: 'a route through a serving host reaches that host, and a project config that redefines the host refuses it (with session.route)' },
  { featureId: 'access.detect', slug: 'access-detect', harnesses: ['claude', 'codex', 'kilocode', 'opencode'], proves: "a rate limit, an exhausted credit and a refused sign-in in the API's own shape reach the port's parser as the right class, with no remote text" },
  {
    featureId: 'access.session',
    slug: 'access-session',
    harnesses: ['claude', 'kilocode', 'opencode'],
    proves: 'a session turn that fails on an access limit reaches the hooks, normalized, with no remote text',
    acceptsUnsupported: ['ACCESS_SESSION_EVENT_ABSENT'],
  },
  {
    featureId: 'access.usage-read',
    slug: 'access-usage-read',
    harnesses: ['codex'],
    proves: "the Codex usage read (account/rateLimits/read) runs against the loopback stub under OS network isolation and reaches nothing else",
    // Windows has no OS network isolation for the case, so it reports unsupported there and a
    // reading stays uncertified; on macOS and Linux only a certified isolated run passes.
    acceptsUnsupported: [ACCESS_USAGE_ISOLATION_UNAVAILABLE],
    unsupportedOnlyOn: ['win32'],
  },
];

/** One predicate: the record carries `featureId` certified. */
function featurePredicate(
  id: string,
  featureId: string,
  combo: { readonly harness: string; readonly os: string },
  latest: ReleaseEvidence | undefined,
  missing: string,
  acceptsUnsupported: readonly string[] = [],
): PredicateResult {
  const features = latest === undefined ? [] : list(obj(latest.payload)['features']);
  const entry = features.find((item) => item['featureId'] === featureId);
  const accepted = entry?.['status'] === 'unsupported' && typeof entry['reasonCode'] === 'string' && acceptsUnsupported.includes(entry['reasonCode']);
  return predicate(
    id,
    entry?.['status'] === 'certified' || accepted,
    latest === undefined
      ? missing
      : entry === undefined
        ? `the record does not carry ${featureId}; run jevris certify --harness ${combo.harness} on ${combo.os} again`
        : entry['status'] === 'certified'
          ? `${featureId} certified until ${String(obj(latest.payload)['expiresAt'])}`
          : accepted
            ? `${featureId} unsupported (${String(entry['reasonCode'])}): a documented gap in this harness version, accepted`
            : `${featureId} ${String(entry['status'])} (${String(entry['reasonCode'])})`,
    latest === undefined ? [] : [latest],
  );
}

function advertisedOses(ctx: GateContext): readonly string[] {
  return [...new Set(advertised(ctx).map((item) => item.os))].sort();
}

// ---------------------------------------------------------------- harness (HCF-01/02)

function harnessGate(ctx: GateContext): GateResult {
  const combos = advertised(ctx);
  const predicates: PredicateResult[] = [];
  if (combos.length === 0) predicates.push(predicate('harness.matrix', false, 'the support matrix advertises nothing'));
  for (const combo of combos) {
    const selection = select(
      ctx,
      'harness-conformance',
      (record) => obj(record.payload)['harness'] === combo.harness && obj(record.payload)['os'] === combo.os && obj(record.payload)['realBinary'] === true,
    );
    const latest = selection.accepted[0];
    const id = `harness.${combo.harness}.${combo.os}`;
    // worker.route: the same nine cases under the `<harness>.worker` actuator, from the same run.
    const workerId = `harness.${combo.harness}.worker.${combo.os}`;
    if (latest === undefined) {
      predicates.push(predicate(id, false, none('real-binary harness-conformance', selection, ` for ${combo.harness} on ${combo.os}`)));
      if (combo.routing) predicates.push(predicate(workerId, false, none('real-binary harness-conformance', selection, ` for ${combo.harness}.worker on ${combo.os}`)));
      continue;
    }
    const payload = obj(latest.payload);
    const missing = missingCases(payload['cases']);
    const version = payload['harnessVersion'];
    predicates.push(
      predicate(
        id,
        missing.length === 0 && typeof version === 'string',
        missing.length === 0 ? `${combo.harness} ${String(version)} passed all ${CONFORMANCE_CASES.length} §15.4 cases` : `failed or missing: ${missing.join(', ')}`,
        [latest],
      ),
    );
    if (!combo.routing) continue;
    const workerMissing = Array.isArray(payload['workerCases']) ? missingCases(payload['workerCases']) : null;
    predicates.push(
      predicate(
        workerId,
        workerMissing !== null && workerMissing.length === 0 && typeof version === 'string',
        workerMissing === null
          ? `${latest.id} has no ${combo.harness}.worker cases; run jevris certify --harness ${combo.harness} on ${combo.os} again`
          : workerMissing.length === 0
            ? `${combo.harness}.worker on ${combo.harness} ${String(version)} passed all ${CONFORMANCE_CASES.length} §15.4 cases`
            : `${combo.harness}.worker failed or missing: ${workerMissing.join(', ')}`,
        [latest],
      ),
    );
  }
  return result('harness', predicates);
}

// ---------------------------------------------------------------- security (RLS-05, RLS-07, GOV-14)

function securityGate(ctx: GateContext): GateResult {
  const predicates: PredicateResult[] = [];
  const register = select(ctx, 'p0-register');
  const reg = register.accepted[0];
  if (reg === undefined) {
    predicates.push(predicate('security.p0-register', false, `${none('owner-signed p0-register', register)}`));
  } else {
    const questions = list(obj(reg.payload)['questions']);
    const unanswered = P0_QUESTIONS.filter((id) => !questions.some((item) => item['id'] === id && typeof item['answer'] === 'string'));
    predicates.push(predicate('security.p0-register', unanswered.length === 0, unanswered.length === 0 ? `all ${P0_QUESTIONS.length} chapter 21 questions answered and signed` : `unanswered: ${unanswered.join(', ')}`, [reg]));
    const status = obj(obj(reg.payload)['procurement'])['status'];
    predicates.push(predicate('security.procurement-closed', status === 'approved', `procurement ${String(status)}; the security gate fails while procurement is open`, [reg]));
  }
  const review = select(ctx, 'security-review');
  const rev = review.accepted[0];
  if (rev === undefined) {
    predicates.push(predicate('security.independent-review', false, none('reviewer-signed security-review', review)));
  } else {
    const p = obj(rev.payload);
    const scope = Array.isArray(p['scope']) ? (p['scope'] as unknown[]) : [];
    const uncovered = SECURITY_SCOPE.filter((item) => !scope.includes(item));
    const open = list(p['findings']).filter((item) => item['status'] === 'open' && (item['severity'] === 'critical' || item['severity'] === 'high'));
    predicates.push(predicate('security.independent-review', obj(p['reviewer'])['independent'] === true, `reviewer independent ${String(obj(p['reviewer'])['independent'])}, report ${String(p['reportSha256'])}`, [rev]));
    predicates.push(predicate('security.review-scope', uncovered.length === 0, uncovered.length === 0 ? 'covers leakage, authority, IPC, evidence access and pack updates' : `not reviewed: ${uncovered.join(', ')}`, [rev]));
    predicates.push(predicate('security.findings-closed', open.length === 0, open.length === 0 ? 'no open critical or high finding' : `open: ${open.map((item) => String(item['id'])).join(', ')}`, [rev]));
  }
  for (const os of OPERATING_SYSTEMS) {
    const suite = select(ctx, 'threat-model-suite', (record) => obj(record.payload)['os'] === os);
    const latest = suite.accepted[0];
    const id = `security.threat-model.${os}`;
    if (latest === undefined) {
      predicates.push(predicate(id, false, none('threat-model-suite', suite, ` on ${os}`)));
      continue;
    }
    const cases = list(obj(latest.payload)['cases']);
    const failing = THREAT_CASES.filter((name) => {
      const item = cases.find((candidate) => candidate['id'] === name);
      if (item === undefined) return true;
      if (item['notApplicable'] === true) return !(name === 'pipe-squat' && os !== 'win32');
      return item['passed'] !== true;
    });
    predicates.push(predicate(id, failing.length === 0, failing.length === 0 ? `all threat cases pass on ${os}` : `failed or missing: ${failing.join(', ')}`, [latest]));
  }
  return result('security', predicates);
}

// ---------------------------------------------------------------- quality (RLS-08, §18.3, §22.2)

/**
 * The owner's seed: at least this many recorded runs back a baseline release (the 12 tasks on
 * both arms, quality-trial plan §3). The large offline trial was rejected (6d7222a).
 */
export const MIN_SEED_RUNS = 24;

/** The seed sources of a baseline release, and the one selection and run-record hash they share. */
function seedOf(payload: Record<string, unknown>): { readonly trials: number; readonly selectionHash: string | null; readonly runsHash: string | null; readonly consistent: boolean } {
  const seeds = list(payload['baselineSources']).filter((item) => item['kind'] === 'seed');
  const trials = seeds.reduce((sum, item) => sum + (Number.isFinite(num(item['trials'])) ? num(item['trials']) : 0), 0);
  const selections = new Set(seeds.map((item) => String(item['selectionHash'])));
  const runs = new Set(seeds.map((item) => String(item['runsHash'])));
  const consistent = seeds.length > 0 && selections.size === 1 && runs.size === 1;
  return { trials, selectionHash: consistent ? [...selections][0] ?? null : null, runsHash: consistent ? [...runs][0] ?? null : null, consistent };
}

/**
 * §22.2 as amended (6d7222a): the quality evidence is the signed baseline release, published
 * priors plus the owner's seed, whose model qualities are Beta priors. The per-workspace
 * posterior criterion of §18.5 is enforced at run time by route learning, never on a release.
 */
/** The package path route learning reads its day-1 baseline from (core BUNDLED_CALIBRATION_PARTS). */
export const BUNDLED_BASELINE_PATH = 'assets/calibration/calibration-release.json';

/** The package ships the gated baseline itself, so a normal install starts from it (C ba96731). */
function shippedBaseline(ctx: GateContext, record: ReleaseEvidence): PredicateResult {
  const bundled = ctx.bundledBaseline;
  if (bundled === undefined || bundled === null) return predicate('quality.baseline-shipped', false, `the package does not ship ${BUNDLED_BASELINE_PATH}`, [record]);
  const shipped = contentHash(bundled);
  const ok = shipped === record.payloadHash;
  return predicate(
    'quality.baseline-shipped',
    ok,
    ok ? `${BUNDLED_BASELINE_PATH} is the baseline record's payload (${shipped})` : `${BUNDLED_BASELINE_PATH} (${shipped}) is not the baseline record's payload (${record.payloadHash})`,
    [record],
  );
}

/**
 * A named test of a run-time gate that the release run must pass (runtime-gate-report). The
 * check is the predicate it feeds. A renamed or skipped test fails the gate, never passes it.
 */
export interface RuntimeGateTest {
  readonly gate: RuntimeGate;
  readonly check: 'quality.learning-gate' | 'economics.in-use' | 'economics.pack-disable';
  readonly file: string;
  readonly name: string;
}

const LEARNING = 'packages/core/test/route-learning.test.mjs';
const MACHINE = 'packages/core/test/route-learning-machine.test.mjs';
const EVALUATION = 'packages/provider-typesafe/test/route-evaluation.test.mjs';
const NO_BASELINE_PRODUCT_PATH = 'C16 no baseline (1.2): a fresh workspace with no release still learns from its first route; explain shows cost and time per verified task against the default';

/**
 * §18.5 and §22.2 as amended (827fc87): with no seed, every workspace starts on the approved
 * default (Opus 5.5 at medium) and route learning moves it only through the owner-locked gate.
 * These tests prove that gate: the locked thresholds, fast automatic demotion, pins, learning
 * off and capped exploration. Economics in use: cost and time per verified task against the
 * default, reported by explain and status, and reversion when a candidate does not improve.
 */
export const RUNTIME_GATE_TESTS: readonly RuntimeGateTest[] = [
  { gate: 'quality', check: 'quality.learning-gate', file: LEARNING, name: 'C16: the posterior thresholds are owner-locked; the readiness check is satisfied' },
  { gate: 'quality', check: 'quality.learning-gate', file: LEARNING, name: 'C16: settings are clamped to the hard limits; the defaults are the locked thresholds' },
  { gate: 'quality', check: 'quality.learning-gate', file: LEARNING, name: 'C52: demotion is fast and automatic: a failing candidate returns the slice to the baseline within a few outcomes' },
  { gate: 'quality', check: 'quality.learning-gate', file: LEARNING, name: 'C52: a sudden drop after a long good history demotes on the recent window even while the posterior is still fine' },
  { gate: 'quality', check: 'quality.learning-gate', file: LEARNING, name: 'C16: a human pin always wins; pinned to advice never launches; unpin returns the slice to the baseline and posterior' },
  { gate: 'quality', check: 'quality.learning-gate', file: LEARNING, name: 'C16: learning off stops every switch and all exploration in the workspace; outcomes are still counted' },
  { gate: 'quality', check: 'quality.learning-gate', file: LEARNING, name: 'C16: exploration only in bounded-auto at low risk, capped at 10%, weighted by the posterior, with exact propensities' },
  { gate: 'quality', check: 'quality.learning-gate', file: LEARNING, name: 'C16 no baseline: every arm starts from Beta(1/2, 1/2), nothing activates, and the default serves every route that does not explore' },
  { gate: 'quality', check: 'quality.learning-gate', file: LEARNING, name: 'C16: every local outcome moves the posterior; enough good outcomes activate a slice the baseline did not support' },
  { gate: 'quality', check: 'quality.learning-gate', file: LEARNING, name: 'C16 product path: without a release an advise slice does not launch, but a low-risk route may explore and says so' },
  { gate: 'quality', check: 'quality.learning-gate', file: EVALUATION, name: NO_BASELINE_PRODUCT_PATH },
  // The local-evidence guard (DOMAINS 223a21f): no switch before both arms hold the locked minimum
  // of this workspace's own randomized outcomes, and explain and status say how many are still needed.
  { gate: 'quality', check: 'quality.learning-gate', file: LEARNING, name: 'C16 guard: a signed baseline alone never switches a slice; it switches once both arms have the locked minimum of local randomized outcomes; an unsupported one stays advise' },
  { gate: 'quality', check: 'quality.learning-gate', file: LEARNING, name: 'C16 guard: explain and status name the local-evidence guard: how many more local outcomes each arm needs before any switch' },
  { gate: 'quality', check: 'quality.learning-gate', file: 'apps/cli/test/route-learning-economics.test.mjs', name: 'route learning status names the local-evidence guard: how many more local outcomes each arm needs before any switch' },
  // §18.5 as amended (5c29643): the machine-wide prior pooled across this machine's workspaces.
  { gate: 'quality', check: 'quality.learning-gate', file: MACHINE, name: "C16 machine: two workspaces learn faster together than apart: a new workspace starts from the others' outcomes, capped at the prior weight" },
  { gate: 'quality', check: 'quality.learning-gate', file: MACHINE, name: 'C16 machine: 100 outcomes in other workspaces count as 12 per arm (the locked machine prior weight), fewer count as they are, no setting raises it, and a signed baseline of 100 still counts as 30' },
  { gate: 'quality', check: 'quality.learning-gate', file: MACHINE, name: 'C16 machine: a workspace never reads its own contribution file' },
  { gate: 'quality', check: 'quality.learning-gate', file: MACHINE, name: 'C16 machine: reset --machine starts a new generation; a contribution from an older one starts again from zero; a plain reset leaves the layer' },
  { gate: 'quality', check: 'quality.learning-gate', file: MACHINE, name: 'C16 machine: no slice outside the shared vocabulary or priorSlices, no workspace id and no text reaches the machine layer' },
  { gate: 'quality', check: 'quality.learning-gate', file: MACHINE, name: 'C16 machine: learning off neither contributes nor reads; a pin still wins; demotion stays per workspace' },
  { gate: 'quality', check: 'quality.learning-gate', file: MACHINE, name: 'C16 machine: concurrent outcomes from several workspaces are never lost, and a usage limit is shared by model' },
  // C 6750120: economics measured in use, per workspace against the default.
  { gate: 'economics', check: 'economics.in-use', file: LEARNING, name: 'C16 economics: cost and wall time per verified task are recorded per arm, the default included; retries count, and a subscription route counts its API-equivalent estimate' },
  { gate: 'economics', check: 'economics.in-use', file: LEARNING, name: 'C16 economics: explain shows cost and wall time per verified task for each arm against the default, as lines and as numbers' },
  { gate: 'economics', check: 'economics.in-use', file: LEARNING, name: 'C16 economics: a cheaper arm that is not cheaper per verified task in practice returns to the default; the same arm at a lower realized cost stays' },
  { gate: 'economics', check: 'economics.in-use', file: LEARNING, name: 'C16 economics: the realized economics need enough verified tasks on both arms, and are deterministic' },
  { gate: 'economics', check: 'economics.in-use', file: LEARNING, name: 'C16 economics: an upgrade arm is never reverted for costing more per verified task; it stays on the strict rule' },
  { gate: 'economics', check: 'economics.in-use', file: EVALUATION, name: NO_BASELINE_PRODUCT_PATH },
  { gate: 'economics', check: 'economics.in-use', file: 'apps/cli/test/route-learning-economics.test.mjs', name: 'route learning status reports cost and wall time per verified task for each arm against the default (§22.2 in use)' },
  { gate: 'economics', check: 'economics.pack-disable', file: 'test/pack-disable-drill.test.mjs', name: 'every shipped pack disables on its own: the others stay active in the workspace, and it comes back when enabled (§22.2 economics, RLS-09)' },
];

/** The named tests behind `check`, judged on the latest accepted runtime-gate-report. */
function runtimeTests(ctx: GateContext, check: RuntimeGateTest['check'], what: string): PredicateResult {
  const required = RUNTIME_GATE_TESTS.filter((test) => test.check === check);
  const selection = select(ctx, 'runtime-gate-report');
  const latest = selection.accepted[0];
  if (latest === undefined) return predicate(check, false, none('runtime-gate-report', selection));
  const rows = list(obj(latest.payload)['tests']);
  const failing = required.filter((test) => !rows.some((row) => row['file'] === test.file && row['name'] === test.name && row['passed'] === true));
  return predicate(
    check,
    required.length > 0 && failing.length === 0,
    failing.length === 0
      ? `${required.length} named test(s) of ${what} pass in the release run`
      : `failed, skipped or missing: ${failing.map((test) => `${test.file}: ${test.name}`).join('; ')}`,
    [latest],
  );
}

/** Whether the package ships a day-1 baseline; with none, every workspace starts on the default. */
function shipsBaseline(ctx: GateContext): boolean {
  return ctx.bundledBaseline !== undefined && ctx.bundledBaseline !== null;
}

/** Model ids a shipped baseline or calibration release uses as priors (its model qualities). */
function baselineModelIds(baseline: unknown): readonly string[] {
  return list(obj(baseline)['modelQualities']).map((item) => item['modelId']).filter((id): id is string => typeof id === 'string');
}

/**
 * Model retirement at the release time (owner decisions 3ff4c0f and 9d1e7eb: a model stays
 * recommended until it is actually retired). Fails only on release data that contradicts itself:
 * a retired model that shipped data still names, a stale entry past its firm date, or a shipped
 * baseline whose priors name a retired model. Upcoming dates, a passed "not sooner than" date and
 * a deprecated model are warnings and a reason to run the model refresh (MODEL_REFRESH_POINTER).
 */
function modelRetirement(ctx: GateContext): readonly PredicateResult[] {
  if (ctx.models === undefined) return [];
  const refresh = `Refresh the bundled registry by ${MODEL_REFRESH_POINTER}, then npm run registry:check`;
  const byId = new Map(ctx.models.map((model) => [model.modelId, model]));
  const bad = inconsistentModels(ctx.models, ctx.nowMs).map(({ model, why }) => `${model.displayName} (${model.modelId}) ${why}`);
  if (shipsBaseline(ctx)) {
    for (const id of baselineModelIds(ctx.bundledBaseline)) {
      const model = byId.get(id);
      if (model !== undefined && retiredAt(model, ctx.nowMs)) bad.push(`the shipped baseline ${BUNDLED_BASELINE_PATH} uses the retired ${model.displayName} (${id}) as a prior`);
    }
  }
  if (bad.length > 0) return [predicate('quality.model-retirement', false, `the release data is inconsistent: ${bad.join('; ')}. ${refresh}`)];
  const warned = retiringModels(ctx.models, ctx.nowMs);
  if (warned.length > 0) return [{ ...predicate('quality.model-retirement', true, `warning: ${warned.map(describeRetiring).join('; ')}; the router recommends ${warned.length === 1 ? 'it' : 'them'} until retired. ${refresh}`), warning: true }];
  const live = ctx.models.filter((model) => !retiredAt(model, ctx.nowMs));
  const next = retiringModels(live, ctx.nowMs, Number.MAX_SAFE_INTEGER / DAY_MS)[0];
  return [predicate('quality.model-retirement', true, `no recommended model may retire within ${MODEL_RETIREMENT_WINDOW_DAYS} days (${live.length} recommended${next === undefined ? '' : `; next: ${describeRetiring(next)}`})`)];
}

function qualityGate(ctx: GateContext): GateResult {
  const learning = runtimeTests(ctx, 'quality.learning-gate', 'the run-time learning gate (§18.5)');
  const retirement = modelRetirement(ctx);
  // No seed (827fc87): nothing is shipped, and the learning gate is the quality evidence.
  if (!shipsBaseline(ctx)) {
    return result('quality', [
      predicate('quality.default-start', true, `no ${BUNDLED_BASELINE_PATH} in the package: every workspace starts on the approved default and learns in use`),
      learning,
      ...retirement,
    ]);
  }
  // A shipped baseline must be the signed, seed-backed release the gate accepts.
  const selection = select(ctx, 'baseline-release');
  const latest = selection.accepted[0];
  if (latest === undefined) return result('quality', [predicate('quality.baseline-release', false, none('calibration-signed, released, unexpired baseline-release', selection)), learning, ...retirement]);
  const p = obj(latest.payload);
  const method = obj(p['uncertaintyInterval'])['method'];
  const sources = list(p['baselineSources']);
  const seed = seedOf(p);
  const qualities = list(p['modelQualities']);
  const ev = [latest];
  return result('quality', [
    predicate('quality.baseline-release', true, `baseline ${String(p['id'])} signed by ${String(obj(p['signature'])['keyId'])}, released, expires ${String(p['expiresAt'])}`, ev),
    predicate(
      'quality.baseline-method',
      method === 'beta-posterior' && sources.length > 0 && qualities.length > 0,
      `method ${String(method)}, ${sources.length} source(s), ${qualities.length} model qualit${qualities.length === 1 ? 'y' : 'ies'}`,
      ev,
    ),
    shippedBaseline(ctx, latest),
    predicate(
      'quality.baseline-seed',
      seed.consistent && seed.trials >= MIN_SEED_RUNS,
      !seed.consistent
        ? 'the seed sources are missing or do not share one selectionHash and runsHash'
        : `${seed.trials} seed runs (need ${MIN_SEED_RUNS}), selection ${String(seed.selectionHash)}, runs ${String(seed.runsHash)}`,
      ev,
    ),
    learning,
    ...retirement,
  ]);
}

// ---------------------------------------------------------------- economics (RLS-09)

/** The seed's paired tasks: the baseline and the candidate each ran all 12 (quality-trial plan §3). */
export const MIN_ECONOMICS_TASKS = 12;

function intervalOk(value: Record<string, unknown>): boolean {
  const lower = num(value['lower']);
  const point = num(value['point']);
  const upper = num(value['upper']);
  return lower <= point && point <= upper && lower >= 0;
}

function economicsGate(ctx: GateContext): GateResult {
  const selection = select(ctx, 'economics-report');
  const latest = selection.accepted[0];
  // No seed (827fc87): the criterion is met in use, per workspace against the default.
  if (latest === undefined) {
    return result('economics', [
      // A seed record that is present but not accepted (unsigned, tampered, stale) is still named.
      ...(selection.excluded.length > 0 ? [predicate('economics.report', false, none('economics-report', selection))] : []),
      runtimeTests(ctx, 'economics.in-use', 'in-use economics (§22.2): cost and time per verified task against the default, reported, with reversion'),
      runtimeTests(ctx, 'economics.pack-disable', 'independent pack disable'),
    ]);
  }
  const p = obj(latest.payload);
  const cost = obj(obj(p['costPerVerifiedTask'])['ratio']);
  const time = obj(obj(p['timePerVerifiedTask'])['ratio']);
  const includes = Array.isArray(p['includes']) ? (p['includes'] as unknown[]) : [];
  const missing = ECONOMICS_COMPONENTS.filter((item) => !includes.includes(item));
  const drills = list(p['packDisableDrills']);
  const undrilled = ctx.packs.filter((pack) => !drills.some((item) => item['packId'] === pack && item['disabled'] === true && item['independent'] === true && item['passed'] === true));
  const ev = [latest];
  const sample = obj(p['sample']);
  // The same seed feeds the baseline release: its selection and run records must match.
  const baseline = select(ctx, 'baseline-release').accepted[0];
  const seed = baseline === undefined ? null : seedOf(obj(baseline.payload));
  const bound = seed !== null && seed.consistent && sample['selectionHash'] === seed.selectionHash && sample['runsHash'] === seed.runsHash;
  return result('economics', [
    predicate(
      'economics.sample-size',
      sample['source'] === 'seed-run' && num(sample['tasks']) >= MIN_ECONOMICS_TASKS && num(sample['runs']) >= MIN_SEED_RUNS,
      sample['source'] !== 'seed-run'
        ? 'the record does not name the seed run it was measured on'
        : `${String(sample['tasks'])} paired tasks (need ${MIN_ECONOMICS_TASKS}), ${String(sample['runs'])} runs (need ${MIN_SEED_RUNS}), ${String(num(sample['confidence']) * 100)}% intervals`,
      ev,
    ),
    predicate(
      'economics.seed-bound',
      bound,
      baseline === undefined
        ? 'no accepted baseline-release to bind the seed to'
        : bound
          ? `the seed of baseline ${String(obj(baseline.payload)['id'])}`
          : `selection ${String(sample['selectionHash'])} and runs ${String(sample['runsHash'])} are not the baseline's seed`,
      baseline === undefined ? ev : [latest, baseline],
    ),
    predicate('economics.intervals', intervalOk(cost) && intervalOk(time), `cost ratio [${String(cost['lower'])}, ${String(cost['upper'])}], time ratio [${String(time['lower'])}, ${String(time['upper'])}]`, ev),
    predicate('economics.full-cost', missing.length === 0, missing.length === 0 ? 'retries, cache, verification and human minutes included' : `not included: ${missing.join(', ')}`, ev),
    predicate('economics.improvement', num(cost['upper']) < 1 || num(time['upper']) < 1, `cost ratio upper ${String(cost['upper'])}, time ratio upper ${String(time['upper'])}; an improvement must survive the interval`, ev),
    predicate('economics.no-regression', num(cost['point']) <= 1 && num(time['point']) <= 1, `cost ratio ${String(cost['point'])}, time ratio ${String(time['point'])}`, ev),
    predicate('economics.pack-disable', undrilled.length === 0, undrilled.length === 0 ? `${ctx.packs.length} pack(s) disabled independently` : `no passing disable drill: ${undrilled.join(', ')}`, ev),
  ]);
}

// ---------------------------------------------------------------- operations (OBS-05)

function operationsGate(ctx: GateContext): GateResult {
  const predicates: PredicateResult[] = [];
  for (const os of OPERATING_SYSTEMS) {
    const selection = select(ctx, 'operations-drills', (record) => obj(record.payload)['os'] === os && obj(record.payload)['ranAgainst'] === 'installed-tarball');
    const latest = selection.accepted[0];
    const id = `operations.drills.${os}`;
    if (latest === undefined) {
      predicates.push(predicate(id, false, none('installed-tarball operations-drills', selection, ` on ${os}`)));
      continue;
    }
    const drills = list(obj(latest.payload)['drills']);
    const failing = OPERATIONS_DRILLS.filter((name) => !drills.some((item) => item['id'] === name && item['passed'] === true));
    predicates.push(predicate(id, failing.length === 0, failing.length === 0 ? `all ${OPERATIONS_DRILLS.length} drills pass on ${os}` : `failed or missing: ${failing.join(', ')}`, [latest]));
  }
  return result('operations', predicates);
}

// ---------------------------------------------------------------- portability (RLS-10, RLS-04)

function portabilityGate(ctx: GateContext): GateResult {
  const predicates: PredicateResult[] = [];
  const combos = advertised(ctx);
  if (combos.length === 0) predicates.push(predicate('portability.matrix', false, 'the support matrix advertises nothing'));
  for (const combo of combos) {
    const selection = select(ctx, 'certification-record', (record) => {
      const p = obj(record.payload);
      return p['harness'] === combo.harness && Array.isArray(p['operatingSystems']) && (p['operatingSystems'] as unknown[]).includes(combo.os);
    });
    const latest = selection.accepted[0];
    const features = latest === undefined ? [] : list(obj(latest.payload)['features']);
    const certified = features.some((item) => item['status'] === 'certified');
    predicates.push(
      predicate(
        `portability.certified.${combo.harness}.${combo.os}`,
        certified,
        latest === undefined ? none('signed, unexpired certification-record', selection, ` for ${combo.harness} on ${combo.os}`) : certified ? `certified until ${String(obj(latest.payload)['expiresAt'])}` : 'no certified feature',
        latest === undefined ? [] : [latest],
      ),
    );
    if (!combo.routing) continue;
    // A harness advertised with routing needs worker.route certified in its published record,
    // and each route actuator that applies to it (ROUTED_FEATURES).
    const missing = none('signed, unexpired certification-record', selection, ` for ${combo.harness} on ${combo.os}`);
    predicates.push(featurePredicate(`portability.worker-route.${combo.harness}.${combo.os}`, WORKER_ROUTE_FEATURE, combo, latest, missing));
    for (const routed of ROUTED_FEATURES) {
      if (!routed.harnesses.includes(combo.harness)) continue;
      const accepts = routed.unsupportedOnlyOn === undefined || routed.unsupportedOnlyOn.includes(combo.os) ? routed.acceptsUnsupported : [];
      predicates.push(featurePredicate(`portability.${routed.slug}.${combo.harness}.${combo.os}`, routed.featureId, combo, latest, missing, accepts));
    }
  }
  for (const os of advertisedOses(ctx)) {
    const selection = select(ctx, 'installed-e2e', (record) => record.environment.os === os);
    const latest = selection.accepted[0];
    const p = latest === undefined ? {} : obj(latest.payload);
    predicates.push(
      predicate(
        `portability.installed-e2e.${os}`,
        latest !== undefined && p['ok'] === true && p['full'] === true && p['npx'] === true,
        latest === undefined ? none('installed-e2e', selection, ` on ${os}`) : `ok ${String(p['ok'])}, full ${String(p['full'])}, npx ${String(p['npx'])}, node ${String(latest.environment.node)}`,
        latest === undefined ? [] : [latest],
      ),
    );
  }
  return result('portability', predicates);
}

// ---------------------------------------------------------------- perf (owner decision DOMAINS ededdba)

/** A machine a load run names: no host name, only what decides its speed. */
export interface LoadMachine {
  readonly os: string;
  readonly arch: string;
  readonly cpuModel: string;
  readonly cores: number;
  readonly memoryGb: number;
}

/**
 * The reference machine for the sidecar load targets: the owner's Mac (owner decision DOMAINS
 * ededdba, "this Mac as the reference machine"). The gate accepts only a run on this machine; a run
 * elsewhere is reported but never judged against the absolute targets.
 */
export const SIDECAR_LOAD_REFERENCE: LoadMachine = { os: 'darwin', arch: 'arm64', cpuModel: 'Apple M4 Max', cores: 16, memoryGb: 64 };

export interface SidecarLoadTarget {
  readonly id: string;
  /** The value must be at most this. */
  readonly limit: number;
  readonly unit: 'ms' | 'ratio' | 'count';
  readonly criterion: string;
}

/** The locked targets (owner decision DOMAINS ededdba; audit .planning/research/sidecar-concurrency-audit.md §6). */
export const SIDECAR_LOAD_TARGETS: readonly SidecarLoadTarget[] = [
  { id: 'load.subagents20.hook-p99-ms', limit: 250, unit: 'ms', criterion: '20 concurrent subagents for 60 s: hook p99' },
  { id: 'load.subagents20.unanswered', limit: 0, unit: 'count', criterion: '20 concurrent subagents for 60 s: hooks not answered (DEADLINE, TIMEOUT, BUSY or any other error)' },
  { id: 'load.verify8.hook-p99-ms', limit: 400, unit: 'ms', criterion: 'the same during an 8-check verify: hook p99' },
  { id: 'load.verify8.cli-status-p99-ms', limit: 1000, unit: 'ms', criterion: 'the same during an 8-check verify: jevris status p99' },
  { id: 'load.verify8.ping-p99-ms', limit: 100, unit: 'ms', criterion: 'the same during an 8-check verify: ping p99' },
  { id: 'load.loop.window-p99-ms', limit: 50, unit: 'ms', criterion: 'event-loop delay p99 in the worst 1 s window of both runs' },
  { id: 'load.loop.worst-stall-ms', limit: 200, unit: 'ms', criterion: 'the longest event-loop stall in both runs' },
  { id: 'load.subagents50.deadline-rate', limit: 0.01, unit: 'ratio', criterion: '50 concurrent subagents: share of hooks past their deadline' },
  { id: 'load.subagents50.busy-max-ms', limit: 50, unit: 'ms', criterion: '50 concurrent subagents: the slowest BUSY answer' },
  { id: 'load.subagents50.unanswered', limit: 0, unit: 'count', criterion: '50 concurrent subagents: hooks neither answered, BUSY nor past their deadline' },
  { id: 'load.history.p50-ratio', limit: 1.5, unit: 'ratio', criterion: 'one session: p50 of events 2401 to 2600 over events 1 to 200' },
  { id: 'load.lifecycle.queued', limit: 0, unit: 'count', criterion: 'compact restores and Stop reminders during 20 subagents: queued or past their deadline' },
  // Owner decision DOMAINS 684ff82 (D's K3; B's answer lane 63a0a31).
  { id: 'load.lifecycle50.busy', limit: 0, unit: 'count', criterion: 'PreCompact, compact restores and Stop during 50 concurrent subagents: answered BUSY' },
];

export interface SidecarLoadVerdict {
  readonly target: SidecarLoadTarget;
  readonly value: number | null;
  readonly ok: boolean;
}

/** Each target against the measures a load run recorded; a missing or null measure fails. */
export function judgeSidecarLoad(measures: readonly { readonly id: string; readonly value: number | null }[]): readonly SidecarLoadVerdict[] {
  return SIDECAR_LOAD_TARGETS.map((target) => {
    const value = measures.find((item) => item.id === target.id)?.value ?? null;
    return { target, value, ok: value !== null && Number.isFinite(value) && value <= target.limit };
  });
}

export function describeLoadMachine(machine: LoadMachine): string {
  return `${machine.os} ${machine.arch}, ${machine.cpuModel}, ${machine.cores} cores, ${machine.memoryGb} GB`;
}

function sameMachine(value: unknown, reference: LoadMachine): boolean {
  const machine = obj(value);
  return (['os', 'arch', 'cpuModel', 'cores', 'memoryGb'] as const).every((key) => machine[key] === reference[key]);
}

function perfGate(ctx: GateContext): GateResult {
  const reference = describeLoadMachine(SIDECAR_LOAD_REFERENCE);
  const selection = select(ctx, 'sidecar-load', (record) => sameMachine(obj(record.payload)['machine'], SIDECAR_LOAD_REFERENCE));
  const elsewhere = select(ctx, 'sidecar-load', (record) => !sameMachine(obj(record.payload)['machine'], SIDECAR_LOAD_REFERENCE)).accepted.length;
  const latest = selection.accepted[0];
  const id = 'perf.sidecar-concurrency';
  if (latest === undefined) {
    const others = elsewhere > 0 ? `; ${elsewhere} run(s) on other machines are not judged` : '';
    return result('perf', [predicate(id, false, `${none('sidecar-load', selection, ` from the reference machine (${reference})`)}${others}; run npm run bench:load -- --evidence <file> there`)]);
  }
  const payload = obj(latest.payload);
  if (payload['quick'] === true) return result('perf', [predicate(id, false, `the latest run on the reference machine (${reference}) was a --quick run, which is not a measurement`, [latest])]);
  const measures = list(payload['measures']).map((item) => ({ id: String(item['id']), value: typeof item['value'] === 'number' ? item['value'] : null }));
  const failing = judgeSidecarLoad(measures).filter((item) => !item.ok);
  const detail =
    failing.length === 0
      ? `all ${SIDECAR_LOAD_TARGETS.length} load targets met on the reference machine (${reference})`
      : `on the reference machine (${reference}): ${failing.map((item) => `${item.target.id} ${item.value === null ? 'not measured' : String(item.value)} > ${String(item.target.limit)}`).join(', ')}`;
  return result('perf', [predicate(id, failing.length === 0, detail, [latest])]);
}

// ---------------------------------------------------------------- acceptance (RLS-02, RLS-03)

function acceptanceSection(ctx: GateContext): GateResult {
  const predicates: PredicateResult[] = [];
  const stories = select(ctx, 'story-report');
  const story = stories.accepted[0];
  if (story === undefined) predicates.push(predicate('acceptance.stories', false, none('story-report', stories)));
  else {
    const rows = list(obj(story.payload)['stories']);
    const failing = STORY_IDS.filter((id) => !rows.some((row) => row['id'] === id && row['passed'] === true && num(row['thenClauses']) >= 1));
    predicates.push(predicate('acceptance.stories', failing.length === 0, failing.length === 0 ? `US01 to US40 pass` : `failing or missing: ${failing.join(', ')}`, [story]));
  }
  const flows = select(ctx, 'workflow-report');
  const flow = flows.accepted[0];
  if (flow === undefined) predicates.push(predicate('acceptance.workflows', false, none('workflow-report', flows)));
  else {
    const rows = list(obj(flow.payload)['workflows']);
    const failing = WORKFLOW_IDS.filter((id) => !rows.some((row) => row['id'] === id && row['passed'] === true));
    predicates.push(predicate('acceptance.workflows', failing.length === 0, failing.length === 0 ? 'W01 to W12 pass' : `failing or missing: ${failing.join(', ')}`, [flow]));
  }
  return result('acceptance', predicates);
}

function result(gate: SectionId, predicates: readonly PredicateResult[]): GateResult {
  const verdict = predicates.length > 0 && predicates.every((item) => item.ok) ? 'pass' : 'fail';
  return { gate, verdict, predicates };
}

const EVALUATORS: Readonly<Record<GateId, (ctx: GateContext) => GateResult>> = {
  api: apiGate,
  harness: harnessGate,
  security: securityGate,
  quality: qualityGate,
  economics: economicsGate,
  operations: operationsGate,
  portability: portabilityGate,
  perf: perfGate,
};

export function evaluateGates(ctx: GateContext, rejected: readonly { readonly file: string; readonly reasonCode: string }[] = []): GatesReport {
  const gates = GATES.map((gate) => EVALUATORS[gate](ctx));
  const acceptance = acceptanceSection(ctx);
  const verdict = gates.every((gate) => gate.verdict === 'pass') && acceptance.verdict === 'pass' ? 'pass' : 'fail';
  return {
    schemaVersion: 'jevris.gates/1',
    version: ctx.version,
    commit: ctx.commit,
    evaluatedAt: new Date(ctx.nowMs).toISOString(),
    verdict,
    gates,
    acceptance,
    evidence: { accepted: ctx.evidence.length, rejected },
  };
}

export function formatGatesReport(report: GatesReport): string {
  const lines = [
    `JEVRIS_GATES ${report.verdict === 'pass' ? 'pass' : 'not-a-pass'} version ${report.version}${report.commit === null ? '' : ` commit ${report.commit.slice(0, 12)}`}`,
    `evidence: ${report.evidence.accepted} valid record(s), ${report.evidence.rejected.length} rejected`,
  ];
  for (const item of report.evidence.rejected.slice(0, 20)) lines.push(`  rejected ${item.file}: ${item.reasonCode}`);
  for (const gate of [...report.gates, report.acceptance]) {
    lines.push(`${gate.gate} ${gate.verdict}`);
    for (const item of gate.predicates) lines.push(`  ${!item.ok ? 'FAIL' : item.warning === true ? 'WARN' : 'pass'} ${item.id}: ${item.detail}`);
  }
  if (report.verdict !== 'pass') {
    lines.push('Not a release pass. Collect the missing evidence (RELEASING.md, "Evidence and the gates", names the command for each record) and run jevris gates again.');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Release evidence (§22.2, RLS-01): the schema-validated records `jevris gates` judges.
 *
 * Every record is one envelope: what produced it, for which package version and commit, on which
 * OS, when, and a payload whose canonical hash is recorded (provenance). Human decisions (the P0
 * register, the independent security review, the trial pre-registration) are additionally signed
 * with Ed25519 over the canonical record (signing.ts). The gate evaluator applies named predicates
 * (ranges, freshness, provenance, coverage) to these records; it never compares against one
 * historic run.
 *
 * Producers: the Jev API suite (C, PRV-10), the harness conformance runner and certification
 * records (F, HCF-01/02), the threat-model suite (B, GOV-14), operations drills (B, OBS-05), the
 * trial runner and economics (C, EVL-05/09), the installed end-to-end smoke, story and workflow
 * suites (A, RLS-02/03/04), the sidecar load run (A, owner decision DOMAINS ededdba), and signed
 * owner or reviewer documents.
 */
import { contentHash } from './hash.js';
import { CorpusSummarySchema, EvaluationProtocolSchema, HoldoutManifestSchema, QualityMeasurementSchema } from './evaluation.js';
import { defineContract } from './contract.js';
import {
  Hash,
  HarnessIdSchema,
  Id,
  ModelId,
  NonNegativeInteger,
  OperatingSystemSchema,
  PositiveInteger,
  ReasonCode,
  SECRET_PATTERNS,
  SemVer,
  SignatureSchema,
  Timestamp,
  URL_PATTERNS,
  text,
} from './primitives.js';
import { CalibrationArtifactSchema, QUALITY_EFFORT_LEVELS } from './calibration.js';
import { CertificationRecordSchema } from './certification.js';
import * as S from './schema.js';

export const EVIDENCE_SCHEMA_VERSION = 'jevris.evidence/1' as const;
export const RELEASE_PACKAGE = '@cryptventure/jevris' as const;

export const EVIDENCE_KINDS = [
  'api-live-suite',
  'harness-conformance',
  'certification-record',
  'installed-e2e',
  'p0-register',
  'security-review',
  'threat-model-suite',
  'pre-registration',
  'quality-trial',
  'economics-report',
  'operations-drills',
  'story-report',
  'workflow-report',
  'baseline-release',
  'runtime-gate-report',
  'sidecar-load',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** §15.4 conformance cases every adapter must pass (HCF-01). */
export const CONFORMANCE_CASES = [
  'event-validation',
  'duplicate-delivery',
  'cancellation',
  'stale-revision',
  'output-shape',
  'permission-preservation',
  'user-pin',
  'offline-fallback',
  'unsupported-capability',
] as const;

/** GOV-14 threat-model cases. `pipe-squat` is the Windows named-pipe case. */
export const THREAT_CASES = [
  'cross-user-ipc',
  'replay',
  'oversize',
  'slow-read',
  'pipe-squat',
  'symlink-race',
  'forged-provenance',
  'egress-canary',
] as const;

/** OBS-05 operations drills. */
export const OPERATIONS_DRILLS = [
  'crash',
  'read-only-store',
  'corrupt-store',
  'disk-full',
  'interrupted-update',
  'stale-result',
  'rollback',
  'offline',
] as const;

/** The seven chapter 21 questions to settle before P0 exits (RLS-05). */
export const P0_QUESTIONS = [
  'billing-mode-and-privacy-classes',
  'certified-claude-versions-and-os',
  'source-bearing-access',
  'regional-p95-latency',
  'automation-eligible-slices',
  'approval-authority',
  'advisory-only-actions',
] as const;

/** The §22.2 security review scope. */
export const SECURITY_SCOPE = [
  'credential-leakage',
  'source-leakage',
  'model-created-authority',
  'scoped-ipc',
  'evidence-access',
  'pack-updates',
] as const;

/** What a full cost per verified task must include (§19.4, RLS-09). */
export const ECONOMICS_COMPONENTS = ['retries', 'cache', 'verification', 'human-minutes'] as const;

const CommitSha = S.string({ pattern: '^[0-9a-f]{40}$' });
const Location = S.string({ minLength: 1, maxLength: 500 });
const NodeVersion = S.string({ pattern: '^v\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$' });

const Subject = S.object({
  package: S.literal(RELEASE_PACKAGE),
  version: SemVer,
  commit: S.nullable(CommitSha),
});

const Producer = S.object({
  tool: Id,
  run: S.nullable(S.string({ minLength: 1, maxLength: 300 })),
});

const Environment = S.object({
  os: S.nullable(OperatingSystemSchema),
  arch: S.nullable(Id),
  node: S.nullable(NodeVersion),
});

const Interval = S.object({ point: S.number(), lower: S.number(), upper: S.number() });

/** The Jev API suite record (C's LiveSuiteRecord). Open: the gate reads only these fields. */
const ApiLiveSuitePayload = S.custom<Record<string, unknown>>({
  type: 'object',
  required: ['mode', 'passed', 'primitives', 'cancellation', 'errors', 'caps', 'usage', 'latency', 'applied'],
  properties: {
    mode: { type: 'string', enum: ['live', 'mock'] },
    passed: { type: 'boolean' },
    applied: { const: false },
    primitives: {
      type: 'object',
      required: ['choice', 'score', 'noul'],
      properties: { choice: { type: 'boolean' }, score: { type: 'boolean' }, noul: { type: 'boolean' } },
    },
    cancellation: { type: 'object', required: ['cancelled'], properties: { cancelled: { type: 'boolean' } } },
    errors: {
      type: 'array',
      maxItems: 64,
      items: {
        type: 'object',
        required: ['probe', 'reasonCode'],
        properties: {
          probe: { type: 'string', maxLength: 64 },
          reasonCode: { anyOf: [{ type: 'string', maxLength: 64 }, { type: 'null' }] },
          elapsedMs: { type: 'integer', minimum: 0 },
          expected: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,63}$' },
          matched: { type: 'boolean' },
        },
      },
    },
    caps: {
      type: 'object',
      required: ['underCapSent', 'overTokenCapRefused', 'overTokenCapSent'],
      properties: {
        underCapSent: { type: 'boolean' },
        overTokenCapRefused: { type: 'boolean' },
        overTokenCapSent: { type: 'boolean' },
      },
    },
    usage: {
      type: 'object',
      required: ['calls', 'estimateAlwaysConservative'],
      properties: { calls: { type: 'integer', minimum: 0 }, estimateAlwaysConservative: { type: 'boolean' } },
    },
    latency: {
      type: 'object',
      required: ['calls', 'okCalls', 'p95Ms', 'budgetMs', 'measureTimeoutMs', 'reasonCounts', 'samples'],
      properties: {
        calls: { type: 'integer', minimum: 0 },
        okCalls: { type: 'integer', minimum: 0 },
        p95Ms: { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }] },
        // The hot-path budget the sample is compared with; the calls ran under measureTimeoutMs.
        budgetMs: { type: 'number', minimum: 0 },
        measureTimeoutMs: { type: 'integer', minimum: 1 },
        withinBudget: { type: 'integer', minimum: 0 },
        withinBudgetFraction: { anyOf: [{ type: 'number', minimum: 0, maximum: 1 }, { type: 'null' }] },
        p95TargetMs: { type: 'number', minimum: 0 },
        p95WithinTarget: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
        // Failed latency calls per reason code: codes and counts only.
        reasonCounts: {
          type: 'object',
          maxProperties: 32,
          propertyNames: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,63}$' },
          additionalProperties: { type: 'integer', minimum: 0 },
        },
        // Every latency call: closed rows of numbers and codes, so no body or text can ride along.
        samples: {
          type: 'array',
          maxItems: 1000,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['elapsedMs', 'ok', 'failure', 'status', 'reasonCode'],
            properties: {
              elapsedMs: { type: 'integer', minimum: 0 },
              ok: { type: 'boolean' },
              failure: { anyOf: [{ type: 'string', pattern: '^[a-z][a-z-]{0,63}$' }, { type: 'null' }] },
              status: { anyOf: [{ type: 'integer', minimum: 100, maximum: 599 }, { type: 'null' }] },
              reasonCode: { anyOf: [{ type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,63}$' }, { type: 'null' }] },
            },
          },
        },
      },
    },
  },
});

const ConformanceCaseRow = S.object({ id: S.enumOf(CONFORMANCE_CASES), passed: S.boolean(), reasonCode: S.nullable(ReasonCode) });

/**
 * The models.list certify case of one run (F; owner decisions DOMAINS 0a9dc8c): its reason code
 * (null when it passed) and the paths its checked run touched, relative to the throwaway profile,
 * so a listing failure can be read without a paste. At most 64 paths of 200 characters; never a
 * file's contents. A path that could carry a secret, a URL or an email address is not recorded as
 * written.
 */
export const LISTING_EVIDENCE_PATHS_MAX = 64;
export const LISTING_EVIDENCE_PATH_CHARS = 200;
/**
 * Text that looks like an email address: no signed evidence may hold one (the owner's rule, A's
 * review note on the listing row).
 */
export const EMAIL_PATTERN = '[^\\s@/\\\\]+@[^\\s@/\\\\]+\\.[A-Za-z]{2,}';
/**
 * A path relative to the profile, enforced (A's review): no leading slash, backslash or `~`, no drive
 * letter, no `..` segment and no control character, so no home path or user name can appear.
 */
export const LISTING_EVIDENCE_PATH_PATTERN = '^(?![\\\\/~])(?![A-Za-z]:)(?!(?:.*[\\\\/])?\\.\\.(?:[\\\\/]|$))[^\\u0000-\\u001f]+$';
const ListingCheckRow = S.object({
  reasonCode: S.nullable(ReasonCode),
  touched: S.array(
    S.string({ minLength: 1, maxLength: LISTING_EVIDENCE_PATH_CHARS, pattern: LISTING_EVIDENCE_PATH_PATTERN, notPatterns: [...SECRET_PATTERNS, ...URL_PATTERNS, EMAIL_PATTERN] }),
    { maxItems: LISTING_EVIDENCE_PATHS_MAX, uniqueItems: true },
  ),
});

/**
 * The stub cases of one certify run (R33, K1-K21; F, at the coordinator's request after the
 * owner's run of 28 September 2026): each case's id, whether it passed and its reason code, so a
 * failed route or access case can be read without a paste. Never the case's detail text.
 */
export const STUB_CASE_EVIDENCE_MAX = 64;
/**
 * A case's trace (K2 first; coordinator's decision after the owner's RC5 run): what the harness
 * and the case said, as names only, so a failed case can be read without a paste. `from` is who
 * spoke (the harness's server, the case's client, the probe hook, the stub provider); `name` is a
 * method, event, item type or tool name, never content; `thread` is a role (`parent`,
 * `child-<n>` or `none`), never a thread id. Consecutive repeats are counted, not repeated.
 */
export const STUB_TRACE_MAX = 256;
export const STUB_TRACE_NAME_PATTERN = '^[A-Za-z0-9_./:-]{1,96}$';
const StubTraceRow = S.object({
  from: S.enumOf(['server', 'client', 'hook', 'stub'] as const),
  name: S.string({ pattern: STUB_TRACE_NAME_PATTERN, notPatterns: [...SECRET_PATTERNS, ...URL_PATTERNS, EMAIL_PATTERN] }),
  thread: S.string({ pattern: '^(?:parent|child-[0-9]{1,2}|none)$' }),
  count: S.integer({ minimum: 1, maximum: 1_000_000 }),
});
const StubCaseRow = S.object({ id: Id, passed: S.boolean(), reasonCode: S.nullable(ReasonCode) }, { trace: S.array(StubTraceRow, { maxItems: STUB_TRACE_MAX }) });

/**
 * One certify run of a harness: the §15.4 cases against its hooks, and (from worker.route,
 * DOMAINS 72ff950) the same nine cases against its owned-worker port, the `<harness>.worker`
 * actuator. The harness gate requires both for a harness advertised with routing. `listing` is
 * the models.list case's reason and touched paths, when the harness has a listing. `stubCases`
 * is the reason code of each stub case, when the harness has any.
 */
const HarnessConformancePayload = S.object(
  {
    harness: HarnessIdSchema,
    os: OperatingSystemSchema,
    harnessVersion: S.nullable(SemVer),
    realBinary: S.boolean(),
    fixtureSuiteHash: Hash,
    cases: S.array(ConformanceCaseRow, { minItems: 1, maxItems: 64 }),
  },
  {
    workerCases: S.array(ConformanceCaseRow, { minItems: 1, maxItems: 64 }),
    listing: ListingCheckRow,
    stubCases: S.array(StubCaseRow, { maxItems: STUB_CASE_EVIDENCE_MAX }),
  },
);

const InstalledE2ePayload = S.object({
  ok: S.boolean(),
  full: S.boolean(),
  npx: S.boolean(),
  // The full smoke on one OS ran 257 steps on 28 September 2026 (243 a day earlier), past the old
  // 256 cap, so its record was refused (INVALID_MAXITEMS). 1024 leaves room and still bounds it.
  steps: S.array(S.object({ id: S.string({ minLength: 1, maxLength: 200 }), ok: S.boolean() }), { minItems: 1, maxItems: 1024 }),
});

const P0RegisterPayload = S.object({
  questions: S.array(
    S.object({ id: S.enumOf(P0_QUESTIONS), answer: text(4000), decidedBy: Id, decidedAt: Timestamp }),
    { minItems: 1, maxItems: 16 },
  ),
  procurement: S.object({
    status: S.enumOf(['open', 'approved', 'rejected'] as const),
    retention: text(1000),
    trainingUse: text(1000),
    region: text(500),
    subprocessors: text(2000),
  }),
});

const SecurityReviewPayload = S.object({
  reviewer: S.object({ name: text(200), organization: text(200), independent: S.boolean() }),
  reportSha256: Hash,
  reportLocation: Location,
  reviewedVersion: SemVer,
  scope: S.array(S.enumOf(SECURITY_SCOPE), { minItems: 1, maxItems: 16, uniqueItems: true }),
  findings: S.array(
    S.object({
      id: Id,
      severity: S.enumOf(['critical', 'high', 'medium', 'low', 'info'] as const),
      status: S.enumOf(['open', 'fixed', 'accepted'] as const),
    }),
    { maxItems: 512 },
  ),
});

const ThreatModelPayload = S.object({
  os: OperatingSystemSchema,
  cases: S.array(
    S.object({ id: S.enumOf(THREAT_CASES), passed: S.boolean(), notApplicable: S.boolean() }),
    { minItems: 1, maxItems: 64 },
  ),
});

const PreRegistrationPayload = S.object({
  primaryMetric: Id,
  primaryCostMetric: Id,
  statisticalTest: Id,
  margin: S.number({ exclusiveMinimum: 0, maximum: 1 }),
  alpha: S.number({ exclusiveMinimum: 0, maximum: 0.5 }),
  power: S.number({ exclusiveMinimum: 0, maximum: 1 }),
  minTasks: PositiveInteger,
  latencyTail: S.object({ percentile: S.number({ minimum: 50, maximum: 100 }), maxMs: PositiveInteger }),
  holdoutHash: Hash,
  lockedAt: Timestamp,
});

const QualityTrialPayload = S.object({
  preRegistrationHash: Hash,
  holdoutHash: Hash,
  tasks: NonNegativeInteger,
  arms: S.array(Id, { minItems: 2, maxItems: 16, uniqueItems: true }),
  comparison: S.object({
    treatment: Id,
    baseline: Id,
    difference: S.number(),
    lowerBound: S.number(),
    upperBound: S.number(),
  }),
  mandatoryChecksChanged: S.boolean(),
  startedAt: Timestamp,
  finishedAt: Timestamp,
  /** The inputs of the EVL-01 quality-gate evaluator (evaluateQualityGate), which the gate re-runs. */
  evaluation: S.object({
    protocol: EvaluationProtocolSchema,
    holdout: HoldoutManifestSchema,
    corpus: CorpusSummarySchema,
    measurement: QualityMeasurementSchema,
  }),
});

/** Where an economics sample's cost figures come from, per run (the seed's costBasis). */
export const ECONOMICS_COST_BASES = ['reported', 'list-price-estimate'] as const;

/**
 * The measured sample an economics record was computed from. The owner's decision (DOMAINS
 * 2d1c6a0): the release economics come from the 24-run seed, the baseline and the candidate on
 * the same tasks, so the record names the seed's plan, task selection and run records by hash.
 */
const EconomicsSample = S.object({
  source: S.literal('seed-run'),
  planId: S.string({ pattern: '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$' }),
  selectionHash: Hash,
  runsHash: Hash,
  /** Paired tasks: both arms ran each one. */
  tasks: NonNegativeInteger,
  /** Recorded runs across both arms (intent-to-treat). */
  runs: NonNegativeInteger,
  baseline: S.object({ modelId: ModelId, effort: S.enumOf(QUALITY_EFFORT_LEVELS) }),
  candidate: S.object({ modelId: ModelId, effort: S.enumOf(QUALITY_EFFORT_LEVELS) }),
  costBases: S.array(S.enumOf(ECONOMICS_COST_BASES), { maxItems: ECONOMICS_COST_BASES.length, uniqueItems: true }),
  confidence: S.number({ exclusiveMinimum: 0, maximum: 0.9999 }),
});

const EconomicsPayload = S.object(
  {
    tasks: NonNegativeInteger,
    costPerVerifiedTask: S.object({ treatment: Interval, baseline: Interval, ratio: Interval }),
    timePerVerifiedTask: S.object({ ratio: Interval }),
    includes: S.array(S.enumOf(ECONOMICS_COMPONENTS), { maxItems: 8, uniqueItems: true }),
    packDisableDrills: S.array(
      S.object({ packId: Id, disabled: S.boolean(), independent: S.boolean(), passed: S.boolean() }),
      { maxItems: 256 },
    ),
  },
  { sample: EconomicsSample },
);

const OperationsPayload = S.object({
  os: OperatingSystemSchema,
  ranAgainst: S.enumOf(['installed-tarball', 'source-tree'] as const),
  drills: S.array(S.object({ id: S.enumOf(OPERATIONS_DRILLS), passed: S.boolean(), recordHash: S.nullable(Hash) }), {
    minItems: 1,
    maxItems: 64,
  }),
});

const StoryReportPayload = S.object({
  stories: S.array(
    S.object({
      id: S.string({ pattern: '^US[0-9]{2}$' }),
      passed: S.boolean(),
      thenClauses: NonNegativeInteger,
      failures: S.array(S.string({ minLength: 1, maxLength: 500 }), { maxItems: 64 }),
    }),
    { minItems: 1, maxItems: 128 },
  ),
});

const WorkflowReportPayload = S.object({
  workflows: S.array(
    S.object({ id: S.string({ pattern: '^W[0-9]{2}$' }), passed: S.boolean(), evidence: S.array(Hash, { maxItems: 64 }) }),
    { minItems: 1, maxItems: 64 },
  ),
});

/**
 * The run-time gates a release proves by their named tests in the release run (§18.5 learning,
 * §22.2 economics in use, as amended at 827fc87): quality and economics.
 */
export const RUNTIME_GATES = ['quality', 'economics'] as const;
export type RuntimeGate = (typeof RUNTIME_GATES)[number];

const RuntimeGateReportPayload = S.object({
  tests: S.array(
    S.object({
      gate: S.enumOf(RUNTIME_GATES),
      file: S.string({ minLength: 1, maxLength: 300 }),
      name: S.string({ minLength: 1, maxLength: 500 }),
      passed: S.boolean(),
    }),
    { minItems: 1, maxItems: 256 },
  ),
});

/**
 * The sidecar concurrency load run (`npm run bench:load`, apps/sidecar/scripts/load.mjs; owner
 * decision DOMAINS ededdba). The machine it ran on, with no host name; whether it was a shortened
 * `--quick` run; the one-minute load average when it started; and each measure by id. A value is
 * null when that scenario did not produce it. The gate judges the values against its own targets.
 */
const SidecarLoadPayload = S.object({
  machine: S.object({
    os: OperatingSystemSchema,
    arch: S.string({ minLength: 1, maxLength: 32 }),
    cpuModel: S.string({ minLength: 1, maxLength: 200 }),
    cores: PositiveInteger,
    memoryGb: PositiveInteger,
  }),
  quick: S.boolean(),
  loadAverage: S.number({ minimum: 0 }),
  measures: S.array(
    S.object({
      id: S.string({ pattern: '^[a-z0-9]+(?:[.-][a-z0-9]+)*$', minLength: 1, maxLength: 100 }),
      value: S.nullable(S.number({ minimum: 0 })),
    }),
    { minItems: 1, maxItems: 64 },
  ),
});

const PAYLOADS = {
  'api-live-suite': ApiLiveSuitePayload,
  'harness-conformance': HarnessConformancePayload,
  'certification-record': CertificationRecordSchema,
  'installed-e2e': InstalledE2ePayload,
  'p0-register': P0RegisterPayload,
  'security-review': SecurityReviewPayload,
  'threat-model-suite': ThreatModelPayload,
  'pre-registration': PreRegistrationPayload,
  'quality-trial': QualityTrialPayload,
  'economics-report': EconomicsPayload,
  'operations-drills': OperationsPayload,
  'story-report': StoryReportPayload,
  'workflow-report': WorkflowReportPayload,
  // The signed baseline release (§18.3, §22.2 as amended at 6d7222a): the CalibrationArtifact
  // whose method is beta-posterior, carried as evidence so the quality gate can judge it.
  'baseline-release': CalibrationArtifactSchema,
  'runtime-gate-report': RuntimeGateReportPayload,
  'sidecar-load': SidecarLoadPayload,
} as const satisfies Record<EvidenceKind, S.TSchema>;

function envelope(kind: EvidenceKind): S.TSchema {
  return S.object(
    {
      schemaVersion: S.literal(EVIDENCE_SCHEMA_VERSION),
      kind: S.literal(kind),
      id: Id,
      producedAt: Timestamp,
      subject: Subject,
      producer: Producer,
      environment: Environment,
      payload: PAYLOADS[kind],
      payloadHash: Hash,
    },
    { signature: SignatureSchema },
  );
}

export const ReleaseEvidenceSchema = S.discriminatedUnion(
  'kind',
  EVIDENCE_KINDS.map((kind) => envelope(kind)) as unknown as readonly S.TSchema[],
) as unknown as S.TSchema<ReleaseEvidence>;

export interface ReleaseEvidence {
  readonly schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  readonly kind: EvidenceKind;
  readonly id: string;
  readonly producedAt: string;
  readonly subject: { readonly package: typeof RELEASE_PACKAGE; readonly version: string; readonly commit: string | null };
  readonly producer: { readonly tool: string; readonly run: string | null };
  readonly environment: { readonly os: 'darwin' | 'linux' | 'win32' | null; readonly arch: string | null; readonly node: string | null };
  readonly payload: { readonly [key: string]: unknown };
  readonly payloadHash: string;
  readonly signature?: { readonly algorithm: 'ed25519'; readonly keyId: string; readonly value: string };
}

export const ReleaseEvidenceContract = defineContract<ReleaseEvidence>({
  name: 'ReleaseEvidence',
  description: 'A §22.2 release-gate evidence record: provenance envelope plus a kind-specific payload.',
  schema: ReleaseEvidenceSchema,
  refine: (value, issue) => {
    if (contentHash(value.payload) !== value.payloadHash) issue('/payloadHash', 'PAYLOAD_HASH_MISMATCH');
  },
});

export interface EvidenceInput {
  readonly kind: EvidenceKind;
  readonly id: string;
  readonly producedAt: string;
  readonly version: string;
  readonly commit?: string | null;
  readonly tool: string;
  readonly run?: string | null;
  readonly os?: 'darwin' | 'linux' | 'win32' | null;
  readonly arch?: string | null;
  readonly node?: string | null;
  readonly payload: { readonly [key: string]: unknown };
}

/** Builds an unsigned evidence envelope with its payload hash. Producers call this. */
export function releaseEvidence(input: EvidenceInput): ReleaseEvidence {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    kind: input.kind,
    id: input.id,
    producedAt: input.producedAt,
    subject: { package: RELEASE_PACKAGE, version: input.version, commit: input.commit ?? null },
    producer: { tool: input.tool, run: input.run ?? null },
    environment: { os: input.os ?? null, arch: input.arch ?? null, node: input.node ?? null },
    payload: input.payload,
    payloadHash: contentHash(input.payload),
  };
}

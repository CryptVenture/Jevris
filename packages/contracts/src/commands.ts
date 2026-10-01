/**
 * Public command and MCP tool result contracts (SSOT §11.2, §6.4, §4.4; CMD-04, TOOL-01).
 *
 * One source for three consumers:
 * - the CLI `--json` output of each public command (`jevris <command> --json`),
 * - the MCP `structuredContent` and per-tool `outputSchema`,
 * - the body a sidecar op returns (the "payload" part; the CLI adds the envelope).
 *
 * A result is an envelope plus a command payload. The envelope says where the answer came
 * from (`mode: full` from the sidecar, `reduced` from local state) and why it degraded.
 * Nothing here can carry a permission grant, a credential or a raw source span.
 */
import { QUALITY_EFFORT_LEVELS } from './calibration.js';
import { defineContract, type Contract } from './contract.js';
import { MODES, MODE_SOURCES } from './domain.js';
import { WorkerModelSchema } from './decision-record.js';
import { FirstTrySliceViewSchema, FirstTryStatusSchema } from './first-try-view.js';
import { ACCESS_SERVING_HOSTS, AccessLimitsStatusSchema, AccessUsageStatusSchema } from './access-limits.js';
import { AUTH_MODES, HARNESS_MODEL_ID_PATTERN, Hash, HarnessIdSchema, Id, ModelId, NonNegativeInteger, PROVIDER_SECRET_PATTERNS, REASON_CODE_PATTERN, SECRET_PATTERNS, Timestamp, text, type AuthMode } from './primitives.js';
import { MAIN_SESSION_MODES, TURN_HARNESSES } from './route-turn.js';
import { PROVIDER_CONSENT_STATES } from './provider-consent.js';
import { SERVING_HOST_KINDS } from './serving-hosts.js';
import { SessionLinkViewSchema } from './session-link.js';
import * as S from './schema.js';

export const PUBLIC_COMMAND_NAMES = ['status', 'plan', 'route', 'checkpoint', 'recover', 'verify', 'explain', 'configure'] as const;
export type PublicCommandName = (typeof PUBLIC_COMMAND_NAMES)[number];

/** Operations reachable through MCP that are not public CLI commands. */
export const TOOL_OPERATION_NAMES = [
  'task.get',
  'evidence.select',
  'evidence.get',
  'verification.record',
  'task.submit',
  'handoff.export',
  'handoff.import',
  'capability.advise',
] as const;
export type ToolOperationName = (typeof TOOL_OPERATION_NAMES)[number];

export type SurfaceOperation = PublicCommandName | ToolOperationName;

/** Documented exit codes for every public command (CMD-04). */
/** Where the model registry routing reads comes from (B's model-registry-status). */
export const MODEL_REGISTRY_SOURCES = ['bundled', 'override', 'refused'] as const;
/** Why an administrator's model-registry.json was refused: routing is then unavailable. */
export const MODEL_REGISTRY_REFUSALS = ['MODEL_REGISTRY_TOO_LARGE', 'MODEL_REGISTRY_NOT_JSON', 'MODEL_REGISTRY_INVALID', 'MODEL_REGISTRY_UNREADABLE'] as const;

export const COMMAND_EXIT_CODES = Object.freeze({
  /** The command answered (full or reduced). */
  ok: 0,
  /** The command answered with a negative result: not found, not verified, invalid plan, refused import. */
  negative: 1,
  /** Usage error or refused input. Nothing ran. */
  usage: 2,
} as const);

/** Where a workspace's Jev decision cap comes from (owner decision 2026-09-29). */
export const JEV_WORKSPACE_CAP_SOURCES = ['cap', 'repository', 'unreadable'] as const;
export type JevWorkspaceCapSource = (typeof JEV_WORKSPACE_CAP_SOURCES)[number];

export const SIDECAR_STATES = ['running', 'not-running', 'starting', 'refused', 'timeout', 'rejected'] as const;
export type SidecarState = (typeof SIDECAR_STATES)[number];

const ShortText = text(500);
const LongText = text(4000);
const Code = S.string({ pattern: REASON_CODE_PATTERN, notPatterns: SECRET_PATTERNS });
/**
 * A filesystem path. It refuses the known credential formats but not the high-entropy heuristic:
 * OS temporary folders carry long mixed-case names (a 32-character run is normal there), and a
 * path is not a credential channel. Anything that leaves the machine is redacted separately
 * (`redactSecrets`, which keeps the heuristic).
 */
const PathText = S.string({ minLength: 1, maxLength: 4096, notPatterns: PROVIDER_SECRET_PATTERNS });
const Ids = (maxItems = 256) => S.array(Id, { maxItems });
const Count = NonNegativeInteger;
/** A verification evidence handle: `ev:` and the 64-hex digest of the kept output (`jevris evidence get`). */
export const EVIDENCE_HANDLE_PATTERN = '^ev:[0-9a-f]{64}$';
const PlanItemId = S.string({ minLength: 1, maxLength: 130, pattern: '^[#A-Za-z0-9][A-Za-z0-9._-]{0,129}$' });

export const SurfaceSidecarSchema = S.object({
  state: S.enumOf(SIDECAR_STATES),
  reasonCode: S.nullable(Code),
  /** One line that tells the user what to do. */
  message: S.nullable(ShortText),
});

export const SurfaceWorkspaceSchema = S.object({
  id: Id,
  root: S.nullable(PathText),
});

function envelope<N extends string, P extends S.TSchema>(command: N, payload: P) {
  return S.object({
    schemaVersion: S.literal('1.0'),
    command: S.literal(command),
    mode: S.enumOf(['full', 'reduced'] as const),
    sidecar: SurfaceSidecarSchema,
    workspace: SurfaceWorkspaceSchema,
    /** One plain-text sentence; the same sentence starts the human output. */
    summary: ShortText,
    result: payload,
  });
}

// ------------------------------------------------------------------------------------ status

/**
 * The last stop report the orchestrator stored for the work (VER-05, US23): a stop that ended
 * with verification evidence missing is reported as unverified, never as done.
 */
export const StopReportSchema = S.object({
  outcome: S.enumOf(['unverified'] as const),
  text: text(1000),
  at: Timestamp,
  missingEvidence: Ids(512),
  uncoveredRequirements: Ids(512),
});
export type StopReport = S.Static<typeof StopReportSchema>;

/** A sidecar subscriber's name, as the sidecar reports it (letters, digits, `.`, `_`, `:`, `-`). */
const SubscriberName = S.string({ pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$' });

export const StatusLatencySchema = S.object({
  days: S.integer({ minimum: 1, maximum: 90 }),
  /** The semantic hot-path target the counts are read against (900 ms). */
  targetMs: Count,
  /** Hook deliveries that answered "no decision" because the deadline passed (DEADLINE, HOOK_DEADLINE, HOOK_WATCHDOG) or the wait for the sidecar ran out (TIMEOUT, HANDSHAKE_TIMEOUT, CONNECT_TIMEOUT). */
  hookDeadlineMisses: Count,
  /** Hook deliveries the sidecar could not answer (SIDECAR_*, BUSY, ECONNREFUSED, CLOSED, CONNECT_*; not autostart turned off). */
  hookSidecarMisses: Count,
  /** Of those, the hooks that found no sidecar running and started one (SIDECAR_STARTING): expected after an idle exit or a reinstall. */
  hookSidecarStarting: Count,
  /** Sidecar answers that arrived after the asking client's own deadline (LATE_ANSWER). */
  lateSidecarAnswers: Count,
  /** Subscribers that missed their slice of a hook's deadline, most misses first. */
  slowSubscribers: S.array(S.object({ name: SubscriberName, count: Count, maxMs: Count }), { maxItems: 8 }),
  /** Times a circuit breaker opened. */
  breakerOpens: Count,
});
export type StatusLatency = S.Static<typeof StatusLatencySchema>;

/**
 * One harness's main-session mode and turn switching, as status shows it (OD-8). Serving hosts
 * R54 (design 8): `sessionHost` is the serving host of the harness's newest active session here
 * (its recorded model resolved through today's registry), and `tariff` whether that host's tariff
 * for the model is known; both null when no such session is seen or the model does not resolve.
 */
export const MainSessionStatusSchema = S.object(
  {
    harness: HarnessIdSchema,
    mode: S.enumOf(MAIN_SESSION_MODES),
    turnSwitching: S.enumOf(['possible', 'advice-only'] as const),
    reasonCode: S.nullable(Code),
  },
  {
    sessionHost: S.nullable(S.object({ id: S.enumOf(ACCESS_SERVING_HOSTS), kind: S.enumOf(SERVING_HOST_KINDS) })),
    tariff: S.nullable(S.enumOf(['known', 'unknown'] as const)),
  },
);
export type MainSessionStatus = S.Static<typeof MainSessionStatusSchema>;

/**
 * A.R77 (decision ea2af91a): Jev disabled after a 402 (billing) or a 403/401 (account, key), as
 * status shows it (B fills it from C2's circuit snapshot): the fixed reason code and class, since
 * when, and the one command that clears it: `jevris credential reenable` after billing or the
 * account is fixed, `jevris credential set` for a key that no longer works (AUTH). Never a key,
 * a fingerprint or the breaker key.
 */
export const JEV_CIRCUIT_COMMANDS = ['jevris credential reenable', 'jevris credential set'] as const;
const JevCircuitBase = S.object({
  state: S.literal('disabled'),
  reasonCode: S.enumOf(['PROVIDER_BILLING', 'PROVIDER_DISABLED'] as const),
  reasonClass: S.enumOf(['BILLING', 'ACCOUNT', 'AUTH'] as const),
  since: S.nullable(Timestamp),
  command: S.enumOf(JEV_CIRCUIT_COMMANDS),
});
/** The pairs are fixed: billing is PROVIDER_BILLING, the others PROVIDER_DISABLED; only AUTH needs a new key. */
export const JevCircuitStatusSchema = S.withCondition(
  S.withCondition(JevCircuitBase, {
    if: { properties: { reasonClass: { const: 'BILLING' } } },
    then: { properties: { reasonCode: { const: 'PROVIDER_BILLING' } } },
    else: { properties: { reasonCode: { const: 'PROVIDER_DISABLED' } } },
  }),
  {
    if: { properties: { reasonClass: { const: 'AUTH' } } },
    then: { properties: { command: { const: 'jevris credential set' } } },
    else: { properties: { command: { const: 'jevris credential reenable' } } },
  },
);
export type JevCircuitStatus = S.Static<typeof JevCircuitStatusSchema>;

/** Status's Jev decision budget: the month's spend against the machine-wide limit and this workspace's cap. */
export const StatusBudgetSchema = S.object(
  {
    state: S.enumOf(['unknown', 'within', 'bound', 'exhausted'] as const),
    reservedMicroUsd: S.nullable(Count),
    limitMicroUsd: S.nullable(Count),
  },
  {
    /** The budget period (UTC calendar month, `YYYY-MM`) the amounts are for. */
    period: S.string({ pattern: '^[0-9]{4}-[0-9]{2}$' }),
    /** Settled Jev spend this period, machine-wide, integer micro-USD. */
    spentMicroUsd: Count,
    /** When the period ends and both limits start again (UTC). */
    resetsAt: Timestamp,
    /**
     * This workspace's own monthly cap inside the machine-wide limit, and its spend; null when
     * the workspace has no cap (owner decision 2026-09-29).
     */
    workspace: S.nullable(
      S.object({
        limitMicroUsd: Count,
        spentMicroUsd: Count,
        reservedMicroUsd: Count,
        availableMicroUsd: Count,
        /** Where the cap comes from: `jevris configure workspace-budget`, the repository file's lowering, or an unreadable cap record (0). */
        source: S.enumOf(JEV_WORKSPACE_CAP_SOURCES),
      }),
    ),
    /** Which cap ran out when `state` is exhausted: the machine-wide limit or this workspace's cap. */
    exhaustedBy: S.nullable(S.enumOf(['machine', 'workspace'] as const)),
  },
);
export type StatusBudget = S.Static<typeof StatusBudgetSchema>;

export const StatusPayloadSchema = S.object(
  {
    jevrisMode: S.enumOf(MODES),
    killSwitch: S.enumOf(['clear', 'stopped'] as const),
    decisionHealth: S.enumOf(['healthy', 'degraded', 'off', 'unknown'] as const),
    degradedReason: S.nullable(ShortText),
    routing: S.object({ modelPin: S.nullable(ModelId), pinned: S.boolean() }),
    activeWorkers: Ids(64),
    budget: StatusBudgetSchema,
    recentDecisions: S.array(
      S.object({
        decisionId: Id,
        outcome: S.string({ pattern: '^[a-z][a-z-]{0,31}$' }),
        reasonCode: Code,
        resolvedModel: S.nullable(ModelId),
        at: S.nullable(Timestamp),
      }),
      { maxItems: 20 },
    ),
    unknownSlices: Ids(64),
    store: S.object({
      state: S.enumOf(['ok', 'absent', 'unavailable'] as const),
      diagnostic: S.nullable(ShortText),
    }),
  },
  {
    /**
     * Where `jevrisMode` comes from: the defaults, the user's jevris.config.json, or the ceiling
     * that lowered it (the workspace's .jevris/config.json, organization.json, host.json or the
     * managed policy), as `jevris configure` shows it.
     */
    modeSource: S.enumOf(MODE_SOURCES),
    /**
     * Problems with the settings layers that narrow the mode: a policy file refused as an
     * authority (SR-4, it still caps), unreadable or invalid (it caps at the defaults), or a
     * refused managed policy. Layer (`workspace:`, `organization:`, `host:`, `managed:`) and code only.
     */
    settingsIssues: S.array(S.object({ path: S.string({ maxLength: 256 }), code: S.string({ maxLength: 64 }) }), { maxItems: 16 }),
    /**
     * A one-time notice after the 1.2 upgrade moved the mode from observe (the old default) to
     * bounded-auto: shown until the person runs `jevris configure set mode`, or for 30 days.
     */
    modeNotice: S.string({ minLength: 1, maxLength: 300 }),
    /**
     * The test worker port (JEVRIS_TEST_WORKER_SCRIPT), only when a script is named: ACTIVE, or
     * refused with the reason. Absent or null otherwise; owned workers then use the Agent SDK.
     */
    testWorkerPort: S.nullable(ShortText),
    /** The last unverified stop report for the workspace; absent or null when there is none. */
    stopReport: S.nullable(StopReportSchema),
    /**
     * W09: native harness sessions outside Jevris ownership in the last 24 hours. Their spend is
     * an advisory estimate only (null when no harness reported usage) and is never under the
     * owned budget's hard cap.
     */
    nativeSpend: S.nullable(
      S.object({
        sessions: Count,
        estimateMicroUsd: S.nullable(Count),
        coverage: S.enumOf(['advisory-estimate'] as const),
      }),
    ),
    /**
     * P8: the persisted latency and deadline counters of the last `days` days (B's
     * `latency.counters`), against the semantic target. Counts and milliseconds only, never
     * event content. Absent or null when the sidecar or its store cannot answer.
     */
    latency: S.nullable(StatusLatencySchema),
    /**
     * P6 (D 4368eb4 reminderSummary): the Stop reminders for this workspace, and what followed
     * them. Counts only. Absent or null when the sidecar cannot answer.
     */
    reminders: S.nullable(
      S.object({ fired: Count, ledToCheck: Count, ledToVerification: Count, endedUnverified: Count }),
    ),
    /**
     * P4 concurrency (B; owner ededdba "queue depth visible in status"): the sidecar's admission
     * pools (hot and background requests in flight), requests answered past their deadline whose
     * work still runs, and the background executor (running, held past its slice, waiting in
     * memory, spilled to `<data>/spool/`). Counts only. Absent or null when the sidecar cannot answer.
     */
    queue: S.nullable(
      S.object({ hotInFlight: Count, backgroundInFlight: Count, overrun: Count, running: Count, held: Count, queued: Count, spooled: Count }),
    ),
    /**
     * B's model registry status (owner decision 9d6a66d, fail-closed): the bundled snapshot, an
     * administrator's override, or an override that was refused, which makes routing unavailable
     * and never falls back to the bundled registry. Absent or null when the sidecar cannot answer.
     */
    modelRegistry: S.nullable(
      S.object({
        source: S.enumOf(MODEL_REGISTRY_SOURCES),
        snapshotId: S.nullable(Id),
        reasonCode: S.nullable(S.enumOf(MODEL_REGISTRY_REFUSALS)),
      }),
    ),
    /**
     * Owner decision 29423b6: the sessions linked to a task in this workspace (B's session_link
     * records). Only a linked Kilo or OpenCode main session may be switched per turn. Absent or
     * null when the sidecar cannot answer.
     */
    sessionLinks: S.nullable(S.array(SessionLinkViewSchema, { maxItems: 16 })),
    /**
     * OD-8: per harness, the main-session mode `routing.mainSession` gives it and whether its
     * turns can be switched at all (D's mainSessionView): `possible` only for plugin-bounded-auto
     * on Kilo or OpenCode with the kill switch clear and the session.route certification current.
     * `reasonCode` says why a harness is advice only (the turn gate's codes). A link, the task's
     * risk and the budget are per turn and not shown here. Absent or null when not known.
     */
    mainSessions: S.nullable(S.array(MainSessionStatusSchema, { maxItems: 5 })),
    /**
     * Owner decision 2026-09-30: the effective `verification.backgroundAtStop` (off unless a person
     * turned it on): whether a main-session Stop queues the missing approved checks. Absent when unknown.
     */
    backgroundVerifyAtStop: S.enumOf(['off', 'on'] as const),
    /**
     * Owner decision 2026-09-30 (Sonnet-first routing): the effective `routing.firstTry`. `auto` starts a
     * low-risk owned task on a cheaper first-try model with one hand-off to a stronger one. Absent when unknown.
     */
    firstTryRouting: S.enumOf(['auto', 'baseline'] as const),
    /**
     * Sonnet-first routing where people look: per harness the first-try and baseline models and how
     * many of this workspace's slices start on the first try, start on the baseline or are still
     * learning (counts and ids only; see first-try-view.ts). Absent when the sidecar cannot answer.
     */
    firstTry: FirstTryStatusSchema,
    /**
     * Owner decision 2026-10-01 (Jev as an active decision aid): the effective `jev.assist`. `classify`
     * lets Jevris ask Jev bounded classification questions (a route request's task slice) from
     * structured features, with a rules fallback; `off` keeps those decisions rules-only. Absent when unknown.
     */
    jevAssist: S.enumOf(['off', 'classify'] as const),
    /**
     * Access limits R79 (design 11): the machine's access pauses in force (B's view of core's
     * record), shown in every workspace. Absent or null when the sidecar cannot read it.
     */
    accessLimits: S.nullable(AccessLimitsStatusSchema),
    /** A.R77: Jev disabled for billing, the account or the key; null when it is not disabled. */
    jevCircuit: S.nullable(JevCircuitStatusSchema),
    /**
     * OP-6: the last Codex usage reading per sign-in (bands, weekly flags, resets and whether usage
     * is allowed; never the percentage or payload). Absent or null when the sidecar cannot read it.
     */
    accessUsage: S.nullable(AccessUsageStatusSchema),
  },
);
export type StatusPayload = S.Static<typeof StatusPayloadSchema>;

// ----------------------------------------------------------------------------------- explain

/** A probability or rate, 0..1. */
const Probability = S.number({ minimum: 0, maximum: 1 });
/** A non-negative weight such as a pseudo-count or a Beta parameter. */
const Weight = S.number({ minimum: 0, maximum: 1_000_000_000 });
/** A non-negative ratio of one arm's figure over the default's (below 1 is better). */
const Ratio = S.number({ minimum: 0, maximum: 1_000_000_000 });
/** C16 effort arms (C 1fc41b9): an effort level; null is the model's default effort. */
const LearningEffort = S.nullable(S.enumOf(QUALITY_EFFORT_LEVELS));
/** An arm key: the model id at its default effort, `model@effort` at any other level. */
const ArmId = S.string({ pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?:@(?:low|medium|high|xhigh|max))?$', notPatterns: SECRET_PATTERNS });

/** A model as a harness spells it (`openrouter/moonshotai/kimi-k3`, `claude-opus-5-5[1m]`). */
const HarnessModelSpelling = S.string({ pattern: HARNESS_MODEL_ID_PATTERN, notPatterns: SECRET_PATTERNS });
/** A maker or a pinned serving host. */
const ServingPartyId = S.enumOf(ACCESS_SERVING_HOSTS);

/**
 * Serving hosts R55 (design 8; C fills it from R50's spellTarget): which host a route goes
 * through. `spelling`, `provider`, `modelId`, `servingHost` and `via` describe the session's
 * model; `targetSpelling`, `targetProvider`, `targetModelId`, `targetServingHost` and `targetVia`
 * the one the route wrote or recommends (all null without a target). `hostDecision` says whether the route kept the session's
 * host (`kept`), moved it (`changed`) or refused (`not-switched`, with `hostReasonCode`); null when
 * no route was asked. `seenHosts` are the hosts Jevris has seen serve the target here, sorted.
 * `tariffBasis` `host` is a known price (the maker's own tariff on a direct route, `tariffSource`
 * null; a pinned host's tariff with its source); `maker-price-estimate` is the maker's list price
 * as an estimate. `consent` is each party's state (host null on a direct route); no text version.
 * `tariff*` and `consent` describe the target when there is one, else the session's model.
 */
export const RouteServingSchema = S.object({
  spelling: HarnessModelSpelling,
  provider: Id,
  modelId: ModelId,
  servingHost: ServingPartyId,
  via: S.enumOf(['maker', 'host'] as const),
  targetSpelling: S.nullable(HarnessModelSpelling),
  targetProvider: S.nullable(Id),
  targetModelId: S.nullable(ModelId),
  targetServingHost: S.nullable(ServingPartyId),
  targetVia: S.nullable(S.enumOf(['maker', 'host'] as const)),
  hostDecision: S.nullable(S.enumOf(['kept', 'changed', 'not-switched'] as const)),
  hostReasonCode: S.nullable(Code),
  seenHosts: S.array(ServingPartyId, { maxItems: 16, uniqueItems: true }),
  tariffBasis: S.enumOf(['host', 'maker-price-estimate'] as const),
  tariffSource: S.nullable(S.object({ sourceId: Id, fetchedOn: S.string({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' }) })),
  consent: S.object({ host: S.nullable(S.enumOf(PROVIDER_CONSENT_STATES)), maker: S.enumOf(PROVIDER_CONSENT_STATES) }),
});
export type RouteServing = S.Static<typeof RouteServingSchema>;

export const ExplainPayloadSchema = S.object({
  decisionId: Id,
  found: S.boolean(),
  trace: S.nullable(
    S.object({
      outcome: S.string({ pattern: '^[a-z][a-z-]{0,31}$' }),
      reasonCodes: S.array(Code, { maxItems: 16 }),
      resolvedModel: S.nullable(ModelId),
      usage: S.object({ known: S.boolean(), inputTokens: S.nullable(Count), outputTokens: S.nullable(Count) }),
      uncertainty: ShortText,
      policyVersion: S.nullable(S.string({ minLength: 1, maxLength: 64, notPatterns: SECRET_PATTERNS })),
      applied: S.boolean(),
      /** The factual template trace. No secret, no raw source. */
      rendered: LongText,
    }, {
      /**
       * US12: requested versus observed worker model, kept apart. `observed: null` with
       * `source: 'unknown'` and `costPrecision: 'unknown'` when nothing observed it.
       */
      models: WorkerModelSchema,
      /**
       * Sonnet-first routing for the slice named with `--slice`: the verdict (first try, baseline
       * first or still learning), the counts and the break-even numbers it used, and its reason
       * code, per baseline and first-try model with a ledger row. Absent without a slice.
       */
      firstTry: FirstTrySliceViewSchema,
      /**
       * Owner decision 29423b6: for a main-session turn decision, the session's link to its task
       * as the sidecar read it when it decided (null: the session was not linked, so the turn got
       * advice only). Absent for any other decision.
       */
      sessionLink: S.nullable(SessionLinkViewSchema),
      /**
       * OD-8: for a main-session turn decision (C's route-turn record), the harness, the mode it
       * ran under, whether the turn's model was switched or only advised, and the gate's reason
       * code (null when it switched). Absent for any other decision.
       */
      mainSession: S.nullable(
        S.object({
          harness: S.enumOf(TURN_HARNESSES),
          mode: S.enumOf(MAIN_SESSION_MODES),
          switched: S.boolean(),
          reasonCode: S.nullable(Code),
        }),
      ),
      /** Serving hosts R55: for a main-session turn decision, the hosts as route.turn saw them. Absent otherwise. */
      serving: S.nullable(RouteServingSchema),
      /**
       * C16: how route learning stands for the decision's slice (C's explainSliceLearning): the
       * mode (`auto` is shown as "active"), the policy version, and its lines (the version that
       * set it, the signed baseline prior, the local outcomes, the posterior, the public priors,
       * a pending proposal, the settings). Absent when the decision has no slice.
       * `baseline` and `posteriors` carry the same facts as numbers, the baseline prior kept apart
       * from the local evidence: `baseline` is null when no signed baseline release covers the
       * slice; `harmVsBaseline` is P(worse than the baseline model by more than the margin).
       * An arm is a model at an effort (C 1fc41b9): `effort` null or absent is the model's default,
       * and a posterior's `armId` tells two efforts of one model apart. A posterior's `machine` is
       * the part the other workspaces on this machine contribute; `economics` is each arm's cost
       * and wall time per verified task against the default.
       */
      learning: S.object(
        {
          sliceId: Id,
          mode: S.enumOf(['advise', 'auto', 'pinned'] as const),
          version: Count,
          lines: S.array(text(1000), { maxItems: 64 }),
        },
        {
          baseline: S.nullable(
            S.object({
              releaseId: text(200),
              priors: S.array(
                S.object({ modelId: ModelId, rate: Probability, pseudoCount: Weight, sampleSize: Count, sourceId: text(200) }, { effort: LearningEffort }),
                { maxItems: 16 },
              ),
            }),
          ),
          posteriors: S.array(
            S.object({
              modelId: ModelId,
              alpha: Weight,
              beta: Weight,
              mean: Probability,
              prior: S.object({ rate: S.nullable(Probability), pseudoCount: Weight, sourceId: S.nullable(text(200)) }),
              local: S.object({ successes: Count, failures: Count }),
              harmVsBaseline: S.nullable(Probability),
            }, {
              armId: ArmId,
              effort: LearningEffort,
              /**
               * The machine-wide prior's part (C 7bea448): the other workspaces' outcomes on this
               * machine for this arm, the rate, the pseudo-count it adds (at most the prior weight)
               * and how many workspaces contributed. Null or absent when they have none.
               */
              machine: S.nullable(S.object({ successes: Count, failures: Count, rate: Probability, pseudoCount: Weight, contributors: Count })),
            }),
            { maxItems: 16 },
          ),
          /**
           * §22.2 in use (C 6750120): each arm's realized economics per verified task against the
           * approved default arm (listed first). Money is integer micro-USD. A figure is null
           * when the arm has no verified task or nothing measured it; a ratio (below 1 is better)
           * is null when either side is unknown.
           */
          economics: S.object({
            defaultArmId: ArmId,
            /** Verified tasks each arm needs before its realized economics can revert a cheaper arm. */
            minVerified: Count,
            arms: S.array(
              S.object({
                armId: ArmId,
                modelId: ModelId,
                effort: LearningEffort,
                isDefault: S.boolean(),
                routes: Count,
                verified: Count,
                /** Billed dollars per verified task (API key); null when no route of the arm was billed. */
                costPerVerifiedMicroUsd: S.nullable(Count),
                /** Billed dollars, with the API-equivalent estimate for unbilled (subscription) routes. */
                apiEquivalentPerVerifiedMicroUsd: S.nullable(Count),
                tokensPerVerified: S.nullable(Count),
                /** Quota-weighted tokens per verified task: the usage-limit consumption on a subscription. */
                usagePerVerified: S.nullable(Count),
                wallMsPerVerified: S.nullable(Count),
                costRatioVsDefault: S.nullable(Ratio),
                usageRatioVsDefault: S.nullable(Ratio),
                wallRatioVsDefault: S.nullable(Ratio),
              }),
              { maxItems: 16 },
            ),
          }),
        },
      ),
    }),
  ),
});
export type ExplainPayload = S.Static<typeof ExplainPayloadSchema>;

// ------------------------------------------------------------------------------------- route

/** How the harness (or worker) pays for model use: defined in primitives.ts (see there). */
export { AUTH_MODES, type AuthMode };

export const RoutePayloadSchema = S.object({
  main: S.object({
    currentModel: S.nullable(ModelId),
    modelPin: S.nullable(ModelId),
    pinState: S.enumOf(['pinned', 'unpinned'] as const),
    outcome: S.enumOf(['keep', 'recommend', 'abstain'] as const),
    recommendedModel: S.nullable(ModelId),
    reasonCode: Code,
    costBasis: ShortText,
    text: text(1000),
    adviceKey: S.nullable(Hash),
  }, {
    /** The session's auth mode when F's detection knows it; absent means unknown. */
    authMode: S.enumOf(AUTH_MODES),
    /** G20 (R26): the harness the advice was scoped to; absent when the request named none. */
    harness: HarnessIdSchema,
    /**
     * Security review MEDIUM 9 (with C): the model providers the advice was limited to, after
     * provider consent. A recommendation never names a model of another provider. Absent when the
     * answer does not say.
     */
    consentedProviders: S.array(S.string({ pattern: '^[a-z][a-z0-9-]{0,31}$' }), { maxItems: 64 }),
    /** Serving hosts R55: the host the session's model and the route's target go through. Absent or null when not known. */
    serving: S.nullable(RouteServingSchema),
  }),
  worker: S.object({
    outcome: S.enumOf(['recommend', 'abstain'] as const),
    recommendedModel: S.nullable(ModelId),
    reasonCode: Code,
    text: text(1000),
  }),
  /** Advice never switches a model (C10). */
  applied: S.literal(false),
}, {
  /**
   * Owner decision 2026-10-01: what the caller can supply to get a reasoned answer, present when
   * the answer is a keep because the request gave too little (no slice, no warm prefix).
   */
  needs: S.array(text(300), { maxItems: 4 }),
  /**
   * Owner decision 2026-10-01: present when the request named no slice but described its task, so
   * the slice was classified (Jev from structured features, else rules). Advice only; never a
   * learned arm. `sliceId` null means none was used and the baseline stays.
   */
  slice: S.object({
    sliceId: S.nullable(S.string({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$' })),
    source: S.enumOf(['rules', 'jev', 'none'] as const),
    risk: S.enumOf(['low', 'medium', 'high', 'unknown'] as const),
    confidencePercent: S.nullable(S.integer({ minimum: 0, maximum: 100 })),
    reasonCode: Code,
    decisionId: S.nullable(Id),
    asked: S.boolean(),
    cacheHit: S.nullable(S.boolean()),
    latencyMs: S.nullable(Count),
    text: ShortText,
  }),
});
export type RoutePayload = S.Static<typeof RoutePayloadSchema>;

// -------------------------------------------------------------------------------------- plan

export const PLAN_ISSUE_CODES = [
  'DUPLICATE_TASK',
  'UNKNOWN_DEPENDENCY',
  'SELF_DEPENDENCY',
  'CYCLE',
  'WORKSPACE_SCOPE',
  'INVALID_TASK',
  'NO_ACCEPTANCE_CHECK',
  'NO_REQUIREMENT',
  'WRITE_OVERLAP',
] as const;

export const PlanPayloadSchema = S.object({
  valid: S.boolean(),
  taskCount: Count,
  order: Ids(1024),
  waves: S.array(Ids(1024), { maxItems: 1024 }),
  criticalPath: Ids(1024),
  ready: Ids(1024),
  issues: S.array(
    S.object({ taskId: S.string({ minLength: 1, maxLength: 130, pattern: '^[#A-Za-z0-9][A-Za-z0-9._-]{0,129}$' }), code: S.enumOf(PLAN_ISSUE_CODES) }),
    { maxItems: 1024 },
  ),
  advice: S.array(ShortText, { maxItems: 32 }),
}, {
  /**
   * INT-02, INT-07 (C03, C07): present only when the request supplied requirements or plan
   * candidates. Review scores are review aids, never feasibility verdicts.
   */
  review: S.object({
    decomposition: S.nullable(
      S.object({
        label: S.literal('decomposition-review-score'),
        isFeasibility: S.literal(false),
        issues: S.array(S.object({ id: PlanItemId, code: Code }), { maxItems: 1024 }),
        coverage: S.array(S.object({ requirementId: PlanItemId, score: S.integer({ minimum: 0, maximum: 4 }) }), { maxItems: 64 }),
        reasonCode: Code,
        decisionId: S.nullable(Id),
      }),
    ),
    plans: S.nullable(
      S.object({
        label: S.literal('plan-review-score'),
        isFeasibility: S.literal(false),
        reviewRequired: S.literal(true),
        ranking: S.array(S.object({ planId: PlanItemId, rank: S.integer({ minimum: 1, maximum: 64 }), score: S.nullable(S.integer({ minimum: 0, maximum: 4 })) }), { maxItems: 64 }),
        note: ShortText,
        reasonCode: Code,
        decisionId: S.nullable(Id),
      }),
    ),
  }),
});
export type PlanPayload = S.Static<typeof PlanPayloadSchema>;

// -------------------------------------------------------------------------------- checkpoint

export const CAPSULE_ITEM_KINDS = [
  'objective',
  'constraint',
  'decision',
  'changed-file',
  'open-check',
  'unresolved',
  'rejected-approach',
  'hypothesis',
  'next-action',
] as const;

export const CheckpointPayloadSchema = S.object(
  {
    capsuleId: Id,
    handle: S.string({ pattern: '^capsule:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' }),
    written: S.boolean(),
    retained: S.object({
      constraints: Count,
      changedFiles: Count,
      openChecks: Count,
      unresolved: Count,
      hypotheses: Count,
    }),
    items: S.array(S.object({ kind: S.enumOf(CAPSULE_ITEM_KINDS), text: text(1000) }), { maxItems: 128 }),
    /** An explicit checkpoint never triggers native compaction (§11.2). */
    compactionTriggered: S.literal(false),
  },
  {
    /** The decision this checkpoint was recorded as, for `jevris explain`; absent or null when none was. */
    decisionId: S.nullable(Id),
  },
);
export type CheckpointPayload = S.Static<typeof CheckpointPayloadSchema>;

// ----------------------------------------------------------------------------------- recover

/** The §10.4 recovery allowlist. */
export const RECOVERY_ACTIONS = [
  'continue',
  'retrieve-missing-artifact',
  'rerun-check-once',
  'ask-focused-question',
  'route-stronger-worker',
  'restore-checkpoint-with-approval',
  'stop-and-report',
] as const;

export const RecoverPayloadSchema = S.object(
  {
    classification: S.enumOf([
      'no-signal',
      'progress',
      'repeated-failure',
      'environment-failure',
      'flaky-suspected',
      'no-progress',
      'patch-oscillation',
    ] as const),
    action: S.enumOf(RECOVERY_ACTIONS),
    advice: text(1000),
    signals: S.object({
      failures: Count,
      distinctFingerprints: Count,
      maxRepeat: Count,
      environmentFailures: Count,
    }),
    rejectedApproaches: S.array(text(500), { maxItems: 32 }),
  },
  {
    /** The decision this recovery advice was recorded as, for `jevris explain`; absent or null when none was. */
    decisionId: S.nullable(Id),
  },
);
export type RecoverPayload = S.Static<typeof RecoverPayloadSchema>;

// ------------------------------------------------------------------------------------ verify

export const VerifyPayloadSchema = S.object(
  {
    ran: S.boolean(),
    /**
     * `needs-environment`: every software check has a current pass and each remaining mandatory
     * check only needs another environment (hardware or a runner). It is not verified.
     */
    readiness: S.enumOf(['verified', 'not-verified', 'needs-environment', 'no-checks'] as const),
    checks: S.array(
      S.object(
        {
          checkId: Id,
          mandatory: S.boolean(),
          outcome: S.enumOf(['passed', 'failed', 'unknown', 'not-run'] as const),
          receiptId: S.nullable(Id),
          fresh: S.boolean(),
        },
        {
          /** Why the check did not pass, e.g. HARDWARE_UNAVAILABLE, TIMEOUT, EXIT_NONZERO, NO_RECEIPT, STALE. */
          reasonCode: S.nullable(Code),
          /** The hardware or runner a not-run check needs, e.g. `bench-1`. */
          environment: S.nullable(Id),
          /**
           * Why a failed or unknown receipt did not pass (D 837da7e): up to 20 failing tests the
           * runner parsed (id and name, secret-redacted, never message or output text), the total
           * failing count, and the evidence handle `jevris evidence get` prints.
           */
          failure: S.object({
            failedTests: S.array(
              S.object({
                id: S.string({ minLength: 1, maxLength: 128, notPatterns: SECRET_PATTERNS }),
                name: S.string({ maxLength: 200, notPatterns: SECRET_PATTERNS }),
              }),
              { maxItems: 20 },
            ),
            failedTestCount: Count,
            evidenceHandle: S.nullable(S.string({ pattern: EVIDENCE_HANDLE_PATTERN })),
          }),
        },
      ),
      { maxItems: 512 },
    ),
    missing: Ids(512),
  },
  {
    /** The mandatory checks that only need another environment. */
    needsEnvironment: Ids(512),
    /** The last unverified stop report for this work; absent or null when there is none. */
    stopReport: S.nullable(StopReportSchema),
    /**
     * Owner decision 2026-10-01 (Jev as an active decision aid): the order this run took the approved
     * checks in, when it ranked them and the order says something (a change is known, or a check
     * failed last time). Advice about sequence only: every approved check still runs, and receipts
     * alone decide done. `source` says whether the rules or Jev ordered them; `ids` is the order the
     * checks ran in; `text` is the one plain sentence that says so; `decisionId` is the recorded
     * `check-relevance` decision (null when none was recorded).
     */
    checkOrder: S.object({
      source: S.enumOf(['rules', 'jev'] as const),
      reasonCode: Code,
      ids: Ids(512),
      text: ShortText,
      decisionId: S.nullable(Id),
      asked: Count,
      used: Count,
    }),
  },
);
export type VerifyPayload = S.Static<typeof VerifyPayloadSchema>;

// --------------------------------------------------------------------------------- configure

const SOURCE_EGRESS_VALUES = ['deny-until-approved', 'approved-scoped'] as const;

export const ConfigurePayloadSchema = S.object({
  source: S.enumOf(['defaults', 'file'] as const),
  path: S.nullable(PathText),
  valid: S.boolean(),
  issues: S.array(S.object({ path: S.string({ maxLength: 256 }), code: S.string({ maxLength: 64 }) }), { maxItems: 64 }),
  effective: S.object(
    {
      mode: S.enumOf(MODES),
      /**
       * The host decision the egress guard enforces (`jevris egress status`), never the
       * jevris.config.json preference: only administrator host policy approves source egress.
       */
      sourceEgress: S.enumOf(SOURCE_EGRESS_VALUES),
      remoteTelemetry: S.enumOf(['off', 'approved-aggregates'] as const),
      mainSession: S.enumOf(MAIN_SESSION_MODES),
      managedWorkers: S.enumOf(MODES),
      orchestrationEnabled: S.boolean(),
    },
    {
      /**
       * Where `mode` comes from: the defaults, your jevris.config.json, or the ceiling that lowered
       * it (the workspace's .jevris/config.json, organization.json, host.json or the managed policy).
       */
      modeSource: S.enumOf(MODE_SOURCES),
      /** Where `sourceEgress` comes from: always host policy (host.json, organization.json, a managed policy). */
      sourceEgressSource: S.literal('host-policy'),
      /** The `privacy.sourceEgress` value in jevris.config.json, a preference only; null when no valid file sets it. */
      sourceEgressPreference: S.nullable(S.enumOf(SOURCE_EGRESS_VALUES)),
      /** The effective machine-wide monthly Jev decision budget, integer micro-USD; 0 means rules-only. */
      monthlyBudgetMicroUsd: Count,
      /** verification.backgroundAtStop (owner decision 2026-09-30): whether a main-session Stop queues missing approved checks. */
      backgroundVerifyAtStop: S.enumOf(['off', 'on'] as const),
      /** routing.firstTry (owner decision 2026-09-30): `auto` starts a low-risk owned task on a cheaper first-try model. */
      firstTryRouting: S.enumOf(['auto', 'baseline'] as const),
      /** jev.assist (owner decision 2026-10-01): `classify` lets Jev classify a route request's task slice from features; `off` is rules-only. */
      jevAssist: S.enumOf(['off', 'classify'] as const),
    },
  ),
  changed: S.array(S.object({ key: S.string({ maxLength: 128 }), from: S.string({ maxLength: 128 }), to: S.string({ maxLength: 128 }) }), {
    maxItems: 32,
  }),
  /** configure never changes native harness permissions. */
  nativePermissionsChanged: S.literal(false),
},
{
  /** True when `--dry-run` was asked: `changed` is what would change, and nothing was written (JEV-0010). Absent otherwise. */
  dryRun: S.boolean(),
});
export type ConfigurePayload = S.Static<typeof ConfigurePayloadSchema>;

// ------------------------------------------------------------------------ MCP-only operations

const TaskSchema = S.object({
  id: Id,
  state: S.string({ pattern: '^[a-z][a-z-]{0,31}$' }),
  revision: Id,
  requirementIds: Ids(),
  dependencyIds: Ids(),
  acceptanceCheckIds: Ids(),
},
{
  /** Why a blocked task waits, as a reason code (for example DEPENDENCY_CANCELLED); absent when none is recorded (JEV-0035). */
  stateReason: S.string({ pattern: '^[A-Z][A-Z0-9_]{0,63}$' }),
});

/**
 * How a managed worker run ended (the orchestrator's worker-runs record). `access-limit` and
 * `overloaded` (access limits R59) carry an AccessLimitFinding in the run record; a stored
 * `usage-limit` run reads as `access-limit`.
 */
export const WORKER_RUN_STATUSES = ['completed', 'failed', 'max-turns', 'budget-exceeded', 'aborted', 'timeout', 'unsupported', 'refused', 'usage-limit', 'model-unavailable', 'access-limit', 'overloaded'] as const;

/**
 * The task's latest managed-worker run for the final report (W01, RTE-11, US12): the model that
 * was asked for and the one that did the work, kept apart; the cost only when the worker
 * reported it (micro-USD, 1 USD = 1000000), otherwise unknown and null.
 */
export const TaskWorkerRunSchema = S.object({
  requestedModel: S.nullable(ModelId),
  actualModel: S.nullable(ModelId),
  status: S.enumOf(WORKER_RUN_STATUSES),
  costMicroUsd: S.nullable(Count),
  costBasis: S.enumOf(['reported', 'unknown'] as const),
  durationMs: S.nullable(Count),
}, {
  /** How the worker's harness paid (D's run record); absent means unknown. */
  authMode: S.enumOf(AUTH_MODES),
});
export type TaskWorkerRun = S.Static<typeof TaskWorkerRunSchema>;

export const TaskGetPayloadSchema = S.object(
  {
    taskId: Id,
    found: S.boolean(),
    task: S.nullable(TaskSchema),
    receipts: S.array(
      S.object({ receiptId: Id, checkId: Id, outcome: S.enumOf(['passed', 'failed', 'unknown', 'not-run'] as const), fresh: S.boolean() }),
      { maxItems: 512 },
    ),
  },
  {
    /** The latest managed-worker run of this task; absent or null when none ran. */
    worker: S.nullable(TaskWorkerRunSchema),
    /** Worker runs that ended after a newer lease owned the task; kept as history, they changed nothing. */
    lateResults: Count,
    /**
     * A cancel was delivered to a running owned task, which has not yet published its end:
     * present, and true, only while the task is not yet cancelled. Absent otherwise.
     */
    cancelRequested: S.boolean(),
  },
);
export type TaskGetPayload = S.Static<typeof TaskGetPayloadSchema>;

export const EvidenceSelectPayloadSchema = S.object(
  {
    intent: text(500),
    items: S.array(
      S.object({ id: Id, kind: S.enumOf(['skill', 'evidence', 'receipt', 'capsule'] as const), label: text(300), reason: text(300) }),
      { maxItems: 64 },
    ),
    missing: S.array(text(300), { maxItems: 32 }),
    truncated: S.boolean(),
  },
  {
    /**
     * P10 (D): the id of this selection, when the sidecar recorded it. A client passes it back as
     * `selectionId` on evidence.get so the read is joined to the selection that ranked it.
     */
    selectionId: Id,
  },
);
export type EvidenceSelectPayload = S.Static<typeof EvidenceSelectPayloadSchema>;

/**
 * How a stored tool or check output was shown to the model (MEM-08, C22, US15): the original's
 * exit code and error state, where its stderr starts, and which byte and line spans of the
 * original the extractive view kept. Offsets are 0-based and end-exclusive, in the stored
 * original's coordinates; the original's hash is the one in its `ev:<sha256>` handle.
 */
export const EvidenceOutputSchema = S.object({
  exitCode: S.nullable(S.integer({ minimum: -2147483648, maximum: 4294967295 })),
  errorState: S.enumOf(['failed', 'succeeded', 'unknown'] as const),
  stderrOffset: S.nullable(Count),
  mode: S.enumOf(['distilled', 'passthrough'] as const),
  passthroughReason: S.nullable(S.enumOf(['binary', 'sensitive', 'unknown-type', 'small'] as const)),
  keptSpans: S.array(S.object({ startByte: Count, endByte: Count, startLine: Count, endLine: Count }), { maxItems: 256 }),
  omittedLines: Count,
  /** The model-visible view; empty for binary or sensitive output. */
  view: S.string({ maxLength: 16384, notPatterns: SECRET_PATTERNS }),
});
export type EvidenceOutput = S.Static<typeof EvidenceOutputSchema>;

export const EvidenceGetPayloadSchema = S.object(
  {
    handle: S.string({ minLength: 1, maxLength: 140, pattern: '^[a-z]+:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' }),
    found: S.boolean(),
    mediaType: S.nullable(S.enumOf(['text/plain', 'application/json'] as const)),
    byteLength: S.nullable(Count),
    /** Model-visible view; the raw bytes stay local behind the handle. */
    text: S.nullable(S.string({ maxLength: 65536, notPatterns: SECRET_PATTERNS })),
    truncated: S.boolean(),
  },
  {
    /** How the output was shown to the model, when Jevris recorded it; absent or null otherwise. */
    output: S.nullable(EvidenceOutputSchema),
  },
);
export type EvidenceGetPayload = S.Static<typeof EvidenceGetPayloadSchema>;

export const VerificationRecordPayloadSchema = S.object({
  receiptId: Id,
  accepted: S.boolean(),
  reasonCode: Code,
  /** The runner's outcome when the pointer names a real receipt; never set by the caller. */
  outcome: S.nullable(S.enumOf(['passed', 'failed', 'unknown', 'not-run'] as const)),
  /** A model call can point at a receipt; it never creates one (§6.4, US24). */
  receiptCreated: S.literal(false),
});
export type VerificationRecordPayload = S.Static<typeof VerificationRecordPayloadSchema>;

export const TaskSubmitPayloadSchema = S.object({
  accepted: S.boolean(),
  taskId: S.nullable(Id),
  leaseIds: Ids(64),
  reasonCode: Code,
},
{
  /** Why a task was refused, when it can be said: the field and the rule it broke, or the check or scope involved (JEV-0040). Absent otherwise. */
  detail: ShortText,
});
export type TaskSubmitPayload = S.Static<typeof TaskSubmitPayloadSchema>;

export const HandoffExportPayloadSchema = S.object({
  capsuleId: S.nullable(Id),
  found: S.boolean(),
  capsule: S.nullable(S.json<unknown>('A portable MemoryCapsule (§9.5).')),
  contentHash: S.nullable(S.string({ pattern: '^sha256:[0-9a-f]{64}$' })),
});
export type HandoffExportPayload = S.Static<typeof HandoffExportPayloadSchema>;

/** What a handoff can need from the importing harness (MEM-10). */
export const HANDOFF_CAPABILITIES = ['context-injection', 'verify-runner', 'task-ledger', 'owned-workers'] as const;

export const HandoffImportPayloadSchema = S.object(
  {
    accepted: S.boolean(),
    reasonCode: Code,
    capsuleId: S.nullable(Id),
    facts: Count,
    unresolved: S.array(text(500), { maxItems: 64 }),
    /** Expired approvals stay history; an import never grants authority (§9.5). */
    authorityGranted: S.literal(false),
  },
  {
    /** The negotiated result for the importing harness: act on it, advice only, or refused. */
    mode: S.enumOf(['actuate', 'advice-only', 'blocked'] as const),
    /** What the capsule needs that the importing harness is not certified for here. */
    missingCapabilities: S.array(S.enumOf(HANDOFF_CAPABILITIES), { maxItems: 8, uniqueItems: true }),
  },
);
export type HandoffImportPayload = S.Static<typeof HandoffImportPayloadSchema>;

// ------------------------------------------------------------------------ result envelopes

// ------------------------------------------------------------------------ capability.advise

/**
 * The delivery reports (SSOT §12.8, DLV-01..06) the CLI and MCP offer, by name, and the
 * capability each one asks D's `capability.advise` op for. Every one reports; none acts.
 */
export const DELIVERY_REPORTS = Object.freeze({
  'pr-readiness': 'C57',
  'ci-triage': 'C58',
  'upgrades': 'C59',
  'migrations': 'C60',
  'docs-drift': 'C61',
  'team-policy': 'C64',
} as const);
export type DeliveryReport = keyof typeof DELIVERY_REPORTS;
export const DELIVERY_REPORT_NAMES = Object.freeze(Object.keys(DELIVERY_REPORTS) as DeliveryReport[]);

/**
 * D's orchestration and verification capabilities the CLI (`jevris advise <id>`) and MCP
 * (`jevris_advise`) offer through the same op, with the input keys each one reads. Every one is
 * advice with the same guards; nothing is started, run, changed or approved.
 */
export const ADVISE_CAPABILITIES = Object.freeze({
  C25: { title: 'DAG dependency suggestions', inputs: ['planId'] },
  C26: { title: 'Worker-role allocation', inputs: ['phase', 'requiredTools', 'intent'] },
  C28: { title: 'Duplicate-work detection', inputs: [] },
  C30: { title: 'Worker handoff readiness', inputs: ['taskId', 'sourceRefs', 'diffHandle'] },
  C41: { title: 'Test-impact prioritization', inputs: ['base'] },
  C42: { title: 'Failure-cluster ranking', inputs: ['base'] },
  C43: { title: 'Patch-candidate ranking', inputs: ['patches', 'taskIds', 'requirement'] },
  C44: { title: 'Review-area prioritization', inputs: ['base', 'protectedPaths'] },
  C45: { title: 'Requirements-to-evidence audit', inputs: ['requirementIds', 'requirementTexts'] },
  C46: { title: 'Flaky-test investigation', inputs: ['checkId'] },
  C47: { title: 'Security-review escalation', inputs: ['base'] },
} as const satisfies { readonly [id: string]: { readonly title: string; readonly inputs: readonly string[] } });
export type AdviseCapabilityId = keyof typeof ADVISE_CAPABILITIES;
export const ADVISE_CAPABILITY_IDS = Object.freeze(Object.keys(ADVISE_CAPABILITIES) as AdviseCapabilityId[]);

export const CAPABILITY_ADVICE_VERBS = ['rank', 'ask', 'pause', 'report', 'abstain'] as const;
export const CAPABILITY_PRIMITIVES = ['Choice', 'Score', 'Noul', 'Rules', 'Rules+Noul', 'Rules+Score', 'Rules+Choice', 'Offline'] as const;
const AdviceItem = (maxLength: number) => text(maxLength);

/**
 * D's capability advice envelope (jevris-capability-advice-1). The guard flags are the literal
 * false: advice applies nothing, grants nothing, runs nothing and certifies nothing, so creating
 * or merging a pull request, changing CI or installing a package is never in it.
 */
export const CapabilityAdvicePayloadSchema = S.object({
  schemaVersion: S.literal('jevris-capability-advice-1'),
  capabilityId: S.string({ pattern: '^C[0-9]{2}$' }),
  title: text(200),
  primitive: S.enumOf(CAPABILITY_PRIMITIVES),
  verb: S.enumOf(CAPABILITY_ADVICE_VERBS),
  source: S.enumOf(['jev', 'rules'] as const),
  reasonCode: Code,
  decisionId: S.nullable(Id),
  summary: text(1000),
  recommendation: S.nullable(text(200)),
  ranked: S.array(
    S.object({ id: text(200), label: text(300), score: S.nullable(S.number({ minimum: -1000, maximum: 1000 })), reason: text(300) }),
    { maxItems: 64 },
  ),
  question: S.nullable(text(300)),
  kept: S.array(AdviceItem(300), { maxItems: 64 }),
  validation: S.array(AdviceItem(300), { maxItems: 64 }),
  requiresApproval: S.boolean(),
  notes: S.array(AdviceItem(500), { maxItems: 16 }),
  evidenceIds: S.array(AdviceItem(140), { maxItems: 64 }),
  guards: S.object({
    applied: S.literal(false),
    authorityGranted: S.literal(false),
    verified: S.literal(false),
    permissionChanged: S.literal(false),
    executed: S.literal(false),
    allowlistExpanded: S.literal(false),
    certified: S.literal(false),
  }),
});
export type CapabilityAdvicePayload = S.Static<typeof CapabilityAdvicePayloadSchema>;

export const PAYLOAD_SCHEMAS = {
  status: StatusPayloadSchema,
  plan: PlanPayloadSchema,
  route: RoutePayloadSchema,
  checkpoint: CheckpointPayloadSchema,
  recover: RecoverPayloadSchema,
  verify: VerifyPayloadSchema,
  explain: ExplainPayloadSchema,
  configure: ConfigurePayloadSchema,
  'task.get': TaskGetPayloadSchema,
  'evidence.select': EvidenceSelectPayloadSchema,
  'evidence.get': EvidenceGetPayloadSchema,
  'verification.record': VerificationRecordPayloadSchema,
  'task.submit': TaskSubmitPayloadSchema,
  'handoff.export': HandoffExportPayloadSchema,
  'handoff.import': HandoffImportPayloadSchema,
  'capability.advise': CapabilityAdvicePayloadSchema,
} as const;

export type SurfacePayloads = { readonly [K in SurfaceOperation]: S.Static<(typeof PAYLOAD_SCHEMAS)[K]> };

export interface SurfaceResult<K extends SurfaceOperation = SurfaceOperation> {
  readonly schemaVersion: '1.0';
  readonly command: K;
  readonly mode: 'full' | 'reduced';
  readonly sidecar: { readonly state: SidecarState; readonly reasonCode: string | null; readonly message: string | null };
  readonly workspace: { readonly id: string; readonly root: string | null };
  readonly summary: string;
  readonly result: SurfacePayloads[K];
}

function contractPair<K extends SurfaceOperation>(op: K) {
  const payloadSchema = PAYLOAD_SCHEMAS[op] as unknown as S.TSchema<SurfacePayloads[K]>;
  const title = op.replace(/(^|[.-])([a-z])/g, (_all, _sep: string, ch: string) => ch.toUpperCase());
  return {
    payload: defineContract<SurfacePayloads[K]>({
      name: `${title}Payload`,
      description: `The ${op} payload a sidecar op returns and the CLI wraps (§11.2, §6.4).`,
      schema: payloadSchema,
    }),
    result: defineContract<SurfaceResult<K>>({
      name: `${title}Result`,
      description: `The ${op} result printed by --json and mirrored in MCP structuredContent.`,
      schema: envelope(op, payloadSchema) as unknown as S.TSchema<SurfaceResult<K>>,
    }),
  };
}

const PAIRS = Object.fromEntries(
  (Object.keys(PAYLOAD_SCHEMAS) as SurfaceOperation[]).map((op) => [op, contractPair(op)]),
) as { readonly [K in SurfaceOperation]: { readonly payload: Contract<SurfacePayloads[K]>; readonly result: Contract<SurfaceResult<K>> } };

/** The contract a sidecar op body must satisfy. */
export function surfacePayloadContract<K extends SurfaceOperation>(op: K): Contract<SurfacePayloads[K]> {
  return PAIRS[op].payload;
}

/** The contract of the full CLI and MCP result. */
export function surfaceResultContract<K extends SurfaceOperation>(op: K): Contract<SurfaceResult<K>> {
  return PAIRS[op].result;
}

export const SURFACE_OPERATIONS: readonly SurfaceOperation[] = Object.freeze(Object.keys(PAYLOAD_SCHEMAS) as SurfaceOperation[]);

export function isSurfaceOperation(value: unknown): value is SurfaceOperation {
  return typeof value === 'string' && (SURFACE_OPERATIONS as readonly string[]).includes(value);
}

export function isPublicCommandName(value: unknown): value is PublicCommandName {
  return typeof value === 'string' && (PUBLIC_COMMAND_NAMES as readonly string[]).includes(value);
}

// ------------------------------------------------------------------ route learning gone (C f5b19ab)

/**
 * One model found gone (or not accessible from one harness and sign-in) on this machine, as C's
 * `loadModelAvailability` reads it from `<data>/route-learning/model-availability.json`: never an
 * error body, message, workspace, path or account.
 */
export const ModelAvailabilityEntrySchema = S.object({
  modelId: ModelId,
  /** MODEL_GONE (every harness) or MODEL_NOT_ACCESSIBLE (its own harness and sign-in only). */
  reasonCode: Code,
  /** The port that saw it: a harness id, `claude-api` or `typesafe`. */
  port: S.string({ pattern: '^[a-z][a-z-]{0,31}$' }),
  authMode: S.enumOf(AUTH_MODES),
  source: S.enumOf(['launch', 'provider-call'] as const),
  firstSeenAt: Timestamp,
  lastSeenAt: Timestamp,
  count: Count,
  /** The registry snapshot it was recorded under; it counts only while that snapshot is in force. */
  registrySnapshotId: Id,
});

/** `jevris route learning gone list | clear <model-id> | clear --all` with `--json`: one line. */
export const RouteLearningGoneOutputSchema = S.discriminatedUnion('command', [
  S.object({
    schemaVersion: S.literal('1.0'),
    command: S.literal('route learning gone list'),
    /** The registry snapshot in force; entries recorded under another are not listed. */
    registrySnapshotId: Id,
    entries: S.array(ModelAvailabilityEntrySchema, { maxItems: 64 }),
    /** C's modelAvailabilityLines: one plain line per entry. */
    lines: S.array(text(1000), { maxItems: 64 }),
  }),
  S.object({
    schemaVersion: S.literal('1.0'),
    command: S.literal('route learning gone clear'),
    /** The model cleared, or `all`. */
    target: ModelId,
    changed: S.boolean(),
    reasonCode: S.enumOf(['CHANGED', 'NOTHING_TO_CLEAR', 'WRITE_FAILED'] as const),
    removed: Count,
  }),
] as const);
export type RouteLearningGoneOutput = S.Static<typeof RouteLearningGoneOutputSchema>;

export const RouteLearningGoneContract: Contract<RouteLearningGoneOutput> = defineContract<RouteLearningGoneOutput>({
  name: 'RouteLearningGoneOutput',
  description: 'The --json line of jevris route learning gone list and clear (models found gone on this machine).',
  schema: RouteLearningGoneOutputSchema,
});

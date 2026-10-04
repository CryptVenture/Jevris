/**
 * The sidecar's single decision engine (DEC-11, §2.5, §7.6, §23.1).
 *
 * The sidecar resolves the Jev credential itself (only the sidecar reads it) and calls this
 * once at boot. With a credential the engine uses the production SDK port; without one it is
 * rules-only and logs exactly one diagnostic. The key never reaches a log line, argv or a
 * record: the circuit breaker keys a 401 on a short fingerprint of it.
 *
 * State lives under the Jevris home: `<data>/decisions` (journal), `<data>/decision-budget.json`
 * (budget, shared across processes) and `<state>/jev-circuit.json` (breaker). Decisions a crash
 * left in flight are settled before the engine is returned.
 *
 * `JEVRIS_TEST_PROVIDER_URL` (loopback http only) with `JEVRIS_TEST_PROVIDER_KEY` points the
 * engine at a mock Jev for installed-product tests; see provider-override.ts.
 */
import { join } from 'node:path';
import { CircuitBreaker, DecisionBudget, WORKSPACE_REVISIONS, createDecisionEngine, credentialFingerprint, routeManagedWorker, type BudgetPeriod, type DecisionEngine, type ManagedRouteRequest } from '@jevris/core';
import { JEV_BUDGET_DEFAULT_MICRO_USD } from '@jevris/contracts';
import { jevrisPaths } from '@jevris/platform';
import { createSdkTransport, type FetchLike } from './sdk-transport.js';
import { bundledCalibrationPath, trustedCalibrationKeys } from './calibration-trust.js';
import { readProviderOverride } from './provider-override.js';

export const RULES_ONLY_DIAGNOSTIC = 'provider key not configured: run jevris credential set';

/**
 * Default decision-call budget: 5 USD per calendar month (Jev input is 0.042 USD per million
 * tokens). The setting `decisions.monthlyBudgetMicroUsd` changes it (owner decision 2026-09-29).
 */
export const DEFAULT_DECISION_BUDGET_MICRO_USD = JEV_BUDGET_DEFAULT_MICRO_USD;

export interface SidecarEngineOptions {
  readonly home?: string;
  /** The Jev API key the sidecar resolved, or null for rules-only. */
  readonly credential: string | null;
  /** Wall clock (ms). */
  readonly clock?: { now(): number };
  readonly log?: (line: string) => void;
  /** The fixed limit, and the fallback when `budgetLimit` cannot answer (default 5 USD). */
  readonly budgetLimitMicroUsd?: number;
  /**
   * The machine-wide limit now (the effective `decisions.monthlyBudgetMicroUsd`), read at every
   * reservation, so a settings change applies without a restart and keeps the month's spend.
   */
  readonly budgetLimit?: () => number;
  /** A workspace's own cap inside the limit, or null for none; read at every reservation. */
  readonly workspaceBudgetLimit?: (workspaceId: string) => number | null;
  readonly budgetPeriod?: BudgetPeriod;
  /**
   * How long a reservation or settlement waits for the budget file's lock before the call falls back to
   * rules with `BUDGET_LOCKED`, in ms (default 2000). A test seam: a test that has many calls at once
   * on a slow disk gives it a long wait so the lock is not what the test races; the sidecar never sets it.
   */
  readonly budgetLockTimeoutMs?: number;
  /** Test seam: the fetch the SDK transport uses. */
  readonly fetch?: FetchLike;
  readonly baseURL?: string;
  /** Environment for the test provider override; defaults to the process environment. */
  readonly env?: { readonly [key: string]: string | undefined };
  /**
   * The administrator's source-egress setting, `{ provenance: 'administrator', sourceEgress:
   * 'approved-scoped' | 'deny-until-approved' }`, read per decision (core `decideEgress`).
   * Absent or not approved: no evidence text leaves; the packet carries structured features.
   */
  readonly sourceEgress?: () => unknown;
  /**
   * B's point read of stored per-provider consent (R30, OD-4). The owned-worker route applies it
   * with the signed-in default from D's candidateScopes; absent, only the signed-in default applies.
   */
  readonly providerConsent?: (provider: string) => unknown;
}

export async function createSidecarEngine(options: SidecarEngineOptions): Promise<DecisionEngine> {
  const paths = jevrisPaths(options.home === undefined ? {} : { home: options.home });
  const clock = options.clock ?? { now: () => Date.now() };
  const budget = DecisionBudget.open(join(paths.data, 'decision-budget.json'), {
    limitMicroUsd: options.budgetLimitMicroUsd ?? DEFAULT_DECISION_BUDGET_MICRO_USD,
    period: options.budgetPeriod ?? 'month',
    now: () => clock.now(),
    ...(options.budgetLockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.budgetLockTimeoutMs }),
    ...(options.budgetLimit === undefined ? {} : { currentLimit: options.budgetLimit }),
    ...(options.workspaceBudgetLimit === undefined ? {} : { workspaceLimit: options.workspaceBudgetLimit }),
  });
  const override = readProviderOverride(options.env);
  if (override.active) options.log?.(override.diagnostic);
  // An override replaces the stored credential entirely: the keychain key never goes to it.
  // A refused override is rules-only, never production.
  const stored = typeof options.credential === 'string' && options.credential.trim().length > 0 ? options.credential : null;
  const credential = override.active ? (override.ok ? override.apiKey : null) : stored;
  const baseURL = override.active && override.ok ? override.baseURL : options.baseURL;
  if (credential === null) {
    if (!override.active) options.log?.(RULES_ONLY_DIAGNOSTIC);
    const engine = createDecisionEngine({ transport: null, journalDir: join(paths.data, 'decisions'), budget, clock, ...(options.sourceEgress === undefined ? {} : { sourceEgress: options.sourceEgress }) });
    await engine.recover();
    return withManagedRoute(engine, paths.home, clock, options.providerConsent);
  }
  const breaker = await CircuitBreaker.load(join(paths.state, 'jev-circuit.json'), { now: () => clock.now() });
  const transport = createSdkTransport({
    apiKey: credential,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(baseURL === undefined ? {} : { baseURL }),
  });
  const engine = createDecisionEngine({
    transport,
    journalDir: join(paths.data, 'decisions'),
    budget,
    breaker,
    clock,
    credentialFingerprint: credentialFingerprint(credential),
    ...(options.sourceEgress === undefined ? {} : { sourceEgress: options.sourceEgress }),
  });
  const { recovered } = await engine.recover();
  if (recovered > 0) options.log?.(`recovered ${recovered} interrupted decision(s)`);
  return withManagedRoute(engine, paths.home, clock, options.providerConsent);
}

/**
 * RTE-12: D's owned-worker launch calls `engine.routeManagedWorker`. The route is built from this
 * home (registry, routing policy, trusted calibration keys, the generation envelope) and the
 * selection is recorded on this engine as advice (observe, advise) or launched (bounded-auto).
 * The route runs on the engine's clock, the same one its decisions and budget use.
 */
function withManagedRoute(engine: DecisionEngine, home: string, clock: { now(): number }, providerConsent?: (provider: string) => unknown): DecisionEngine {
  const route = async (request: ManagedRouteRequest) =>
    routeManagedWorker(request, {
      home,
      trustedKeys: await trustedCalibrationKeys(home),
      bundledCalibration: bundledCalibrationPath(home),
      nowMs: () => clock.now(),
      ...(providerConsent === undefined ? {} : { providerConsent }),
      record: async ({ action, reasonCodes, mode }) => {
        const recorded = await engine.recordAdvice?.({
          specId: 'worker-route',
          workspaceId: request.workspaceId,
          evidenceRevision: WORKSPACE_REVISIONS.current(request.workspaceId),
          taskId: request.taskId,
          mode,
          action,
          reasonCodes,
        });
        return recorded?.ok === true ? recorded.decisionId : null;
      },
    });
  Object.defineProperty(engine, 'routeManagedWorker', { value: route, enumerable: false, configurable: true, writable: false });
  // route.turn reads the same consent reader the worker route uses (R30, OD-4).
  if (providerConsent !== undefined) Object.defineProperty(engine, 'providerConsent', { value: providerConsent, enumerable: false, configurable: true, writable: false });
  Object.defineProperty(engine, 'calibrationKeys', { value: async () => trustedCalibrationKeys(home), enumerable: false, configurable: true, writable: false });
  return engine;
}

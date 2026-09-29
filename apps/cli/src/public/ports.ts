/**
 * The ports the public surface calls (domain E). Each port is the agreed contract of the
 * owning domain; the defaults load the real implementation and report `missing` when a
 * domain has not landed it, so the surface degrades to its reduced local answer instead of
 * failing. Tests inject fakes.
 *
 * - B: `ensureSidecar` and `sidecarRequest` from `@jevris/sidecar` (the client).
 * - C: `adviseMainRoute`, `lookupDecision` and `explainDecision` from `@jevris/core`.
 * - D: `loadEffectiveConfig` and `setConfigValue` from `@jevris/orchestrator`.
 */
import type {
  DecisionRecord,
  JevrisConfig,
  ModelRegistry,
  RouteAdvice,
  RoutePins,
  SessionSnapshot,
} from '@jevris/contracts';
import * as core from '@jevris/core';
import type { HostEgressDecision } from '../host-policy.js';
import { autostartAllowed } from './context.js';

/**
 * B's client results, restated structurally so the surface does not depend on the client's
 * module being present (it is loaded optionally and degrades to reduced mode without it).
 */
export type SidecarClientKind = 'cli' | 'mcp' | 'hook';
export type SidecarBudgetClass = 'hot' | 'background';
export type EnsureSidecarResult =
  | { readonly ok: true; readonly endpoint: string; readonly started: boolean }
  | { readonly ok: false; readonly reason: 'starting' | 'unavailable' | 'refused'; readonly message: string };
export type SidecarRequestResult =
  | { readonly ok: true; readonly result: unknown }
  | {
      readonly ok: false;
      readonly reason: 'unavailable' | 'refused' | 'timeout' | 'rejected';
      readonly reasonCode?: string;
      readonly message: string;
    };

export interface SidecarPort {
  ensure(input: { readonly home: string; readonly waitMs: number }): Promise<EnsureSidecarResult>;
  request(input: {
    readonly home: string;
    readonly op: string;
    readonly workspace: string;
    readonly body: unknown;
    readonly scope: SidecarClientKind;
    readonly timeoutMs: number;
    readonly budget: SidecarBudgetClass;
  }): Promise<SidecarRequestResult>;
}

export interface EnginePort {
  readonly adviseMainRoute?: (snapshot: SessionSnapshot, registry: ModelRegistry, pins: RoutePins) => RouteAdvice;
  readonly loadRegistry?: (options: { readonly home: string }) => Promise<ModelRegistry | null> | ModelRegistry | null;
  readonly lookupDecision?: (decisionId: string, options?: { readonly home?: string }) => Promise<DecisionRecord | null>;
  readonly explainDecision?: (record: DecisionRecord) => string;
}

export interface EffectiveConfigView {
  readonly config: JevrisConfig;
  readonly source: 'defaults' | 'file';
  readonly path: string | null;
  readonly issues: readonly { readonly path: string; readonly code: string }[];
}

export interface ConfigPort {
  readonly loadEffectiveConfig?: (input: { readonly home: string; readonly workspaceRoot: string | null }) => Promise<unknown>;
  readonly setConfigValue?: (input: {
    readonly home: string;
    readonly key: string;
    readonly value: string;
    readonly dryRun: boolean;
    /** A person at an interactive terminal confirmed a raise (SR-19, B's personAtTerminal; never --yes). */
    readonly confirmed?: boolean;
  }) => Promise<unknown>;
  /**
   * The host source-egress decision for the local configure answer (test seam). Default: the
   * egress guard's resolver (`resolveHostSourceEgress`), which fails closed.
   */
  readonly sourceEgress?: (home: string) => Promise<HostEgressDecision>;
}

export interface SurfacePorts {
  readonly sidecar: SidecarPort;
  readonly engine: EnginePort;
  readonly config: ConfigPort;
}

const MISSING_CLIENT = 'The Jevris sidecar client is not installed. Reinstall Jevris; local results are shown meanwhile.';

function missingSidecar(): SidecarPort {
  return {
    async ensure() {
      return { ok: false, reason: 'unavailable', message: MISSING_CLIENT };
    },
    async request() {
      return { ok: false, reason: 'unavailable', reasonCode: 'SIDECAR_CLIENT_MISSING', message: MISSING_CLIENT };
    },
  };
}

type SidecarModule = {
  readonly ensureSidecar?: (input: { readonly home?: string; readonly waitMs?: number }) => Promise<EnsureSidecarResult>;
  /** B's autostart wait (the test override included), so the outer deadline matches the client's wait. */
  readonly sidecarWaitMs?: (requested: number) => number;
  /** Whether a sidecar answers, without starting one (B's client). */
  readonly probeSidecar?: (home?: string) => Promise<{ readonly running: boolean; readonly endpoint: { readonly endpoint: string } | undefined; readonly foreign?: true }>;
  readonly sidecarRequest?: (input: {
    readonly home?: string;
    readonly op: string;
    readonly workspace?: string;
    readonly body?: unknown;
    readonly scope: SidecarClientKind;
    readonly timeoutMs?: number;
    readonly budget?: SidecarBudgetClass;
  }) => Promise<SidecarRequestResult>;
};

let sidecarModule: Promise<SidecarModule | null> | undefined;

/**
 * Bounds a client call and keeps the process alive while it runs: the timer is referenced, so
 * a client that only waits on unreferenced timers cannot let a CLI exit with no answer.
 */
function withDeadline<T>(work: Promise<T>, ms: number, late: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(late()), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(late());
      },
    );
  });
}

async function loadSidecarModule(): Promise<SidecarModule | null> {
  try {
    // B's client, declared in sidecar-module.d.ts (no project reference: the sidecar depends on the CLI).
    return (await import('@jevris/sidecar')) as unknown as SidecarModule;
  } catch {
    return null;
  }
}

export const AUTOSTART_OFF_MESSAGE =
  'The Jevris sidecar is not running, and JEVRIS_SIDECAR_AUTOSTART=0 keeps it from starting, so this answer is rules-only. Run `jevris sidecar start`, or unset the variable.';

/**
 * The real client when `@jevris/sidecar` exports it; a port that reports `unavailable` otherwise.
 * With JEVRIS_SIDECAR_AUTOSTART=0, `ensure` never starts the sidecar: ok when one is running,
 * else `unavailable` with a message naming the variable.
 */
export async function defaultSidecarPort(): Promise<SidecarPort> {
  sidecarModule ??= loadSidecarModule();
  const loaded = await sidecarModule;
  const ensure = loaded?.ensureSidecar;
  const request = loaded?.sidecarRequest;
  const probe = loaded?.probeSidecar;
  if (typeof ensure !== 'function' || typeof request !== 'function') return missingSidecar();
  return {
    async ensure(input) {
      if (!autostartAllowed(process.env)) {
        const off = (): EnsureSidecarResult => ({ ok: false, reason: 'unavailable', message: AUTOSTART_OFF_MESSAGE });
        if (typeof probe !== 'function') return off();
        return withDeadline(
          Promise.resolve()
            .then(() => probe(input.home))
            .then((found): EnsureSidecarResult => (found.running && found.endpoint !== undefined && found.foreign !== true ? { ok: true, endpoint: found.endpoint.endpoint, started: false } : off())),
          1500,
          off,
        );
      }
      const failed = (): EnsureSidecarResult => ({
        ok: false,
        reason: 'unavailable',
        message: 'The sidecar could not be started. Run jevris sidecar start to see why.',
      });
      const waitMs = typeof loaded?.sidecarWaitMs === 'function' ? loaded.sidecarWaitMs(input.waitMs) : input.waitMs;
      return withDeadline(
        Promise.resolve().then(() => ensure({ home: input.home, waitMs: input.waitMs })),
        waitMs + 1000,
        failed,
      );
    },
    async request(input) {
      const call = Promise.resolve().then(() =>
        request({
          home: input.home,
          op: input.op,
          workspace: input.workspace,
          body: input.body,
          scope: input.scope,
          timeoutMs: input.timeoutMs,
          budget: input.budget,
        }),
      );
      return withDeadline(call, input.timeoutMs + 500, () => ({
        ok: false,
        reason: 'timeout',
        reasonCode: 'SIDECAR_CLIENT_TIMEOUT',
        message: 'The sidecar did not answer in time. Run jevris sidecar status.',
      }));
    },
  };
}

function exported<T>(module: object, name: string): NonNullable<T> | undefined {
  const value = (module as Record<string, unknown>)[name];
  return typeof value === 'function' ? (value as unknown as NonNullable<T>) : undefined;
}

/** C's engine exports, when they are present in `@jevris/core`. */
export function defaultEnginePort(): EnginePort {
  const port: {
    adviseMainRoute?: NonNullable<EnginePort['adviseMainRoute']>;
    loadRegistry?: NonNullable<EnginePort['loadRegistry']>;
    lookupDecision?: NonNullable<EnginePort['lookupDecision']>;
    explainDecision?: NonNullable<EnginePort['explainDecision']>;
  } = {};
  const advise = exported<EnginePort['adviseMainRoute']>(core, 'adviseMainRoute');
  if (advise !== undefined) port.adviseMainRoute = advise;
  const registry = exported<EnginePort['loadRegistry']>(core, 'loadModelRegistry');
  if (registry !== undefined) port.loadRegistry = registry;
  const lookup = exported<EnginePort['lookupDecision']>(core, 'lookupDecision');
  if (lookup !== undefined) port.lookupDecision = lookup;
  const explain = exported<EnginePort['explainDecision']>(core, 'explainDecision');
  if (explain !== undefined) port.explainDecision = explain;
  return port;
}

let orchestrationModule: Promise<object | null> | undefined;

async function loadOrchestration(): Promise<object | null> {
  try {
    // @ts-ignore -- D adds the project reference; until then the module may have no types.
    return (await import('@jevris/orchestrator')) as object;
  } catch {
    return null;
  }
}

/** D's configuration API, when `@jevris/orchestrator` exports it. */
export async function defaultConfigPort(): Promise<ConfigPort> {
  orchestrationModule ??= loadOrchestration();
  const loaded = await orchestrationModule;
  if (loaded === null) return {};
  const port: { loadEffectiveConfig?: NonNullable<ConfigPort['loadEffectiveConfig']>; setConfigValue?: NonNullable<ConfigPort['setConfigValue']> } = {};
  const load = exported<ConfigPort['loadEffectiveConfig']>(loaded, 'loadEffectiveConfig');
  if (load !== undefined) port.loadEffectiveConfig = load;
  const set = exported<ConfigPort['setConfigValue']>(loaded, 'setConfigValue');
  if (set !== undefined) port.setConfigValue = set;
  return port;
}

export async function defaultPorts(): Promise<SurfacePorts> {
  const [sidecar, config] = await Promise.all([defaultSidecarPort(), defaultConfigPort()]);
  return { sidecar, engine: defaultEnginePort(), config };
}

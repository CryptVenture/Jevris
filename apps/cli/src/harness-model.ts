/**
 * A model as each owned-worker harness spells it, and C's effort level as that harness takes it
 * (routing design R6, R13 and R18's ports; C's core id map in packages/core/src/harness-model-id.ts).
 *
 * The registry decides, not a family regex:
 * - a model's own `harnessModels` row for the harness wins (Antigravity's `gemini-3.8-flash-medium`);
 * - else the access row's `idTemplate` derives it (`{id}` on Codex, `{provider}/{id}` on OpenCode
 *   and Kilo, with the row's first provider id);
 * - else the harness names no id for the model, and the run is refused. A user's own
 *   `provider/model` pin for OpenCode or Kilo still passes as given.
 *
 * The effort goes as the harness takes it: the nearest level at or below C's that the harness
 * lists for the model (the model's row, else the access row, else the model's own levels), as
 * the harness's token for it. On Antigravity the token is the model slug itself. A model the
 * registry does not know keeps the port's own level list.
 *
 * Ids only: nothing here reads text or a file.
 */
import type { HarnessId, ModelRegistry } from '@jevris/contracts';
import { BUNDLED_MODEL_REGISTRY, harnessEffortToken, harnessModelId, providerOfSegment, registryModel, registryModelOf, resolveSpelling, spellOnHost } from '@jevris/core';
import { nearestEffort, WORKER_EFFORTS, type WorkerEffort } from './owned-session.js';

/** The harnesses an owned worker runs on besides Claude Code (Claude takes registry ids as they are). */
export type WorkerModelHarness = Extract<HarnessId, 'codex' | 'opencode' | 'kilocode' | 'antigravity'>;

export interface RegistryRef {
  readonly provider: string;
  readonly modelId: string;
}

export interface HarnessModelChoice {
  /** The id the harness is started with (`--model`, or `-m` for OpenCode and Kilo). */
  readonly id: string;
  /** The registry model it names, or null for an id the registry does not know. */
  readonly model: RegistryRef | null;
  /** The effort level used (one of C's levels), or null when none is passed. */
  readonly level: WorkerEffort | null;
  /** The harness's token for that level, or null. On Antigravity it is the model slug, already in `id`. */
  readonly effortToken: string | null;
  /** True when the effort is carried by the model id itself (Antigravity's slug), so no effort flag is passed. */
  readonly effortInModel: boolean;
  /**
   * Serving hosts R52: the model and the host the started `id` reaches, from core's one resolver
   * (resolveSpelling). A maker spelling (`moonshotai/kimi-k3`, `gpt-6-sol`) reaches the maker
   * (`via: 'maker'`); a pinned gateway spelling (`openrouter/moonshotai/kimi-k3`) reaches that host
   * (`via: 'host'`); core's ResolvedSpelling names, less `raw`. Null when the id resolves to neither (an unpinned host, a free or routing
   * suffix, an id the registry does not know).
   *
   * It is information only: `id`, `model`, `level`, `effortToken` and `effortInModel` are what they
   * were before it, and nothing reads it until D's workers.ts and the parked task-ops.ts wiring
   * (owner) do.
   */
  readonly serving: WorkerServing | null;
}

/** Where an owned run's model id goes (serving hosts R52). */
export interface WorkerServing {
  /** The registry maker and model the id names. */
  readonly provider: string;
  readonly modelId: string;
  /** The host that receives the request: the maker's own id, or a pinned host (`openrouter`, `kilo`, `nvidia`). */
  readonly servingHost: string;
  readonly via: 'maker' | 'host';
}

function servingOf(registry: ModelRegistry, harness: WorkerModelHarness, id: string): WorkerServing | null {
  const resolved = resolveSpelling(registry, harness, id);
  return resolved === null ? null : { provider: resolved.provider, modelId: resolved.modelId, servingHost: resolved.servingHost, via: resolved.via };
}

export interface HarnessModelOptions {
  /** The loaded registry. Default: the bundled snapshot. */
  readonly registry?: ModelRegistry;
  /** The port's levels for a model the registry does not know. */
  readonly fallbackLevels: readonly string[];
  /**
   * What an id the registry does not know runs as: the id, or null to refuse it. OpenCode and
   * Kilo take only a `provider/model` pin; Codex and Antigravity take the id as given.
   */
  readonly unregistered: (model: string) => string | null;
  /**
   * Serving hosts R52 (agreed with D): a pinned serving host to run the registry model through
   * (`openrouter`, `kilo`, `nvidia`; never a maker id). The id is then the one spelling core's
   * spellOnHost gives for (harness, host, model), and a model the harness cannot reach there is
   * null, never the maker's spelling. Absent: the maker route, exactly as before R52. Nothing
   * passes it until the parked task-ops wiring (owner) does.
   */
  readonly servingHost?: string;
}

/**
 * The registry model an owned run's model names: the harness's own id (`openai/gpt-6-sol`,
 * `gemini-3.8-flash-low`), a registry id (`gpt-6-sol`), or a registry id with the registry's or
 * a harness's provider segment (`openai/gpt-6-sol`, `moonshotai/kimi-k3`). Null when none is one.
 */
export function registryRefOf(registry: ModelRegistry, harness: WorkerModelHarness, model: string): RegistryRef | null {
  const own = registryModelOf(registry, harness, model);
  if (own !== null) return own;
  const slash = model.indexOf('/');
  const entry = slash < 0 ? registryModel(registry, model) : model.indexOf('/', slash + 1) < 0 ? registryModel(registry, model.slice(slash + 1), providerOfSegment(registry, model.slice(0, slash))) : null;
  return entry === null ? null : { provider: entry.provider, modelId: entry.modelId };
}

function effortVia(registry: ModelRegistry, harness: WorkerModelHarness, ref: RegistryRef): string | undefined {
  const entry = registryModel(registry, ref.modelId, ref.provider);
  const own = (entry?.harnessModels ?? []).find((row) => row.harness === harness);
  const row = (registry.harnessAccess ?? []).find((access) => access.harness === harness && access.provider === ref.provider);
  return own?.effortVia ?? row?.effortVia;
}

/**
 * R52: a registry model through a pinned serving host. Only a model the registry knows, only the
 * one spelling that resolves back to (model, host), and the maker's effort tokens for it (the
 * registry records no per-host levels). Null when there is no such spelling.
 */
function hostChoice(registry: ModelRegistry, harness: WorkerModelHarness, ref: RegistryRef | null, effort: WorkerEffort | undefined, servingHost: string): HarnessModelChoice | null {
  if (ref === null || servingHost === ref.provider) return null;
  const id = spellOnHost(registry, harness, servingHost, ref.provider, ref.modelId);
  if (id === null) return null;
  const levels = WORKER_EFFORTS.filter((level) => harnessEffortToken(registry, harness, ref.modelId, level, ref.provider) !== null);
  const level = nearestEffort(effort, levels);
  const token = level === null ? null : harnessEffortToken(registry, harness, ref.modelId, level, ref.provider);
  return { id, model: ref, level: token === null ? null : level, effortToken: token, effortInModel: false, serving: servingOf(registry, harness, id) };
}

/** How `harness` runs `model` at C's `effort`, or null when it names no id for the model. */
export function harnessModelChoice(harness: WorkerModelHarness, model: string, effort: WorkerEffort | undefined, options: HarnessModelOptions): HarnessModelChoice | null {
  const registry = options.registry ?? BUNDLED_MODEL_REGISTRY;
  const ref = registryRefOf(registry, harness, model);
  if (options.servingHost !== undefined) return hostChoice(registry, harness, ref, effort, options.servingHost);
  if (ref === null) {
    const id = options.unregistered(model);
    if (id === null) return null;
    const level = nearestEffort(effort, options.fallbackLevels) as WorkerEffort | null;
    return { id, model: null, level, effortToken: level, effortInModel: false, serving: servingOf(registry, harness, id) };
  }
  // The harness's own id for this model as given (a pinned Antigravity slug) is kept; otherwise
  // the registry spells it. A `provider/model` pin the registry cannot spell here passes as given.
  const ownId = registryModelOf(registry, harness, model) !== null ? model : null;
  const id = ownId ?? harnessModelId(registry, harness, ref.modelId, ref.provider) ?? (model.includes('/') ? options.unregistered(model) : null);
  if (id === null) return null;
  const levels = WORKER_EFFORTS.filter((level) => harnessEffortToken(registry, harness, ref.modelId, level, ref.provider) !== null);
  const level = nearestEffort(effort, levels);
  const token = level === null ? null : harnessEffortToken(registry, harness, ref.modelId, level, ref.provider);
  const inModel = effortVia(registry, harness, ref) === 'model-name';
  const started = inModel && token !== null ? token : id;
  return { id: started, model: ref, level: token === null ? null : level, effortToken: token, effortInModel: inModel, serving: servingOf(registry, harness, started) };
}

/**
 * The registry id a harness listing line names, or null when the line is not for a provider the
 * harness's access rows name (R13: every R2 provider id, not only the worker's family provider).
 * `provider/model` lines (OpenCode, Kilo): the segment must be the row's provider or one of its
 * `providerIds`; the id kept is the registry's when it knows the model, else the bare model id.
 * Plain lines (Codex, Antigravity): the registry id when the harness's own id names one, else the line.
 */
export function listedModelId(registry: ModelRegistry, harness: WorkerModelHarness, line: string): string | null {
  const own = registryModelOf(registry, harness, line);
  if (harness === 'codex' || harness === 'antigravity') return own?.modelId ?? line;
  const slash = line.indexOf('/');
  if (slash <= 0) return null;
  const segment = line.slice(0, slash);
  const named = (registry.harnessAccess ?? []).some((row) => row.harness === harness && (row.provider === segment || (row.providerIds ?? []).includes(segment)));
  if (!named) return null;
  return own?.modelId ?? line.slice(slash + 1);
}

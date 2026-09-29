/**
 * R42 (serving hosts, phase 2; design 8ceaa01 section 4.2): how D's local evidence names a model
 * a harness ran. Every writer (a session's reported model, a subagent's, an owned run's end)
 * records the raw spelling the harness used and the host that served it, from one resolver, so a
 * route can later keep the session's host (section 4.3).
 *
 * The resolver is C's `resolveSpelling` (R39, bfea1f90): a maker's own spelling is served by that
 * maker (`via: 'maker'`); a pinned host's segment resolves only through an exact registry serving
 * (`via: 'host'`); anything else is unregistered and recorded nowhere.
 *
 * Ids only: nothing here reads text or a file.
 */
import { harnessModelId, registryModel, resolveSpelling, HARNESS_MODEL_ID } from '@jevris/core';
import type { HarnessId, ModelRegistry } from '@jevris/contracts';

/** A raw harness spelling resolved to its registry model and serving host. */
export interface RunSpelling {
  /** The spelling exactly as the harness used or reported it. */
  readonly raw: string;
  readonly provider: string;
  readonly modelId: string;
  /** The host that served it: the maker's id when `via` is `maker`. */
  readonly servingHost: string;
  readonly via: 'maker' | 'host';
}

/** The registry model and host a harness's raw spelling names, or null (unregistered, unpinned host, ambiguous). */
export function resolveRunSpelling(registry: ModelRegistry, harness: HarnessId, raw: string): RunSpelling | null {
  const run = resolveSpelling(registry, harness, raw);
  return run === null ? null : { raw: run.raw, provider: run.provider, modelId: run.modelId, servingHost: run.servingHost, via: run.via };
}

/** The spelling without a context suffix or provider segments. */
function bare(raw: string): string {
  const id = raw.replace(/\[1m\]$/, '');
  return id.slice(id.lastIndexOf('/') + 1);
}

/**
 * C's clean-run rule (C STATUS "RAN_HERE for a clean run"; coordinator, 2026-09-28): the spelling
 * an owned run that completed cleanly with no reported model counts as having run, or null. The
 * requested model is spelled as the harness port spells it (its own id as given, else the
 * registry's spelling for the harness through its maker), and counts only when:
 * - it resolves to exactly one registry entry, served by its maker (`via: 'maker'`);
 * - its model segment is that entry's exact id, not an alias or an effort token;
 * - the harness reaches the maker natively or through provider config, never a gateway (a
 *   gateway can fall back to another model).
 */
export function cleanRunSpelling(registry: ModelRegistry, harness: HarnessId, requested: string): RunSpelling | null {
  if (!HARNESS_MODEL_ID.test(requested)) return null;
  let spelled: string | null = requested;
  if (resolveSpelling(registry, harness, requested) === null) {
    const entry = requested.includes('/') ? null : registryModel(registry, requested);
    spelled = entry === null ? null : harnessModelId(registry, harness, entry.modelId, entry.provider);
  }
  if (spelled === null) return null;
  const run = resolveRunSpelling(registry, harness, spelled);
  if (run === null || run.via !== 'maker' || run.servingHost !== run.provider) return null;
  if (bare(spelled) !== run.modelId) return null;
  const access = (registry.harnessAccess ?? []).find((row) => row.harness === harness && row.provider === run.provider);
  if (access === undefined || access.access === 'gateway') return null;
  return run;
}

/**
 * Models found gone on this machine (C's model-availability, f5b19ab; owner 9d1e7eb), as the CLI
 * shows them: `jevris route learning gone`, `route learning status` and `jevris doctor` read the
 * same entries through this one function, under the registry the router uses.
 */
import { BUNDLED_MODEL_REGISTRY, loadModelAvailability, loadModelRegistry, modelAvailabilityLines, type ModelAvailabilityEntry } from '@jevris/core';

export interface ModelAvailabilityView {
  /** The registry snapshot in force: the refreshed registry file, else the bundled one. */
  readonly registrySnapshotId: string;
  readonly entries: readonly ModelAvailabilityEntry[];
  /** C's modelAvailabilityLines, one per entry, in the same order. */
  readonly lines: readonly string[];
}

/** The entries in force on this machine. An unreadable record or registry file reads as none found. */
export async function modelAvailabilityView(home: string): Promise<ModelAvailabilityView> {
  const registry = (await loadModelRegistry({ home }).catch(() => null)) ?? BUNDLED_MODEL_REGISTRY;
  const entries = await loadModelAvailability(home, registry).catch((): readonly ModelAvailabilityEntry[] => []);
  return { registrySnapshotId: registry.snapshotId, entries, lines: modelAvailabilityLines(entries) };
}

/**
 * Doctor lines (F's doctor, added by E with the coordinator's go-ahead): `modelAvailability <id>:`
 * and C's line. A model found gone names the clear command for once it is back; a model not
 * accessible from one harness and sign-in is a fact about that harness only.
 */
export function modelAvailabilityDoctorLines(view: ModelAvailabilityView): string[] {
  return view.entries.map((entry, i) => {
    const text = view.lines[i] ?? '';
    const fix = entry.reasonCode === 'MODEL_GONE' ? ` Fix, once the model is back: jevris route learning gone clear ${entry.modelId} --yes` : '';
    return `modelAvailability ${entry.modelId}: ${text}${fix}`;
  });
}

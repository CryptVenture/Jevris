/**
 * Which model registry this home uses, for status (owner decision DOMAINS 9d6a66d: an unsigned
 * administrator override at `<config>/model-registry.json` stays supported; `doctor` and status
 * say when it is active; it is validated against the registry schema).
 *
 * The override is not signed. Anyone who can write the user's config folder can write it, so it
 * carries no more trust than the rest of that folder. Its bytes are checked by C's
 * checkModelRegistryBytes (586a520), the same check the router's loader makes, so status and
 * routing always agree.
 *
 * - `bundled`: no override file; the bundled snapshot is in use.
 * - `override`: a valid override is in use; `snapshotId` names it.
 * - `refused`: an override is present but was refused, with a reason code. The router's loader
 *   refuses the same file.
 *
 * Status is a hot request, so the file is read again only when its size or mtime changed.
 */
import { readFileSync, statSync } from 'node:fs';
import { BUNDLED_MODEL_REGISTRY, MODEL_REGISTRY_MAX_BYTES, checkModelRegistryBytes as coreCheck, modelRegistryFile, type ModelRegistryRefusal } from '@jevris/core';

export { MODEL_REGISTRY_MAX_BYTES, type ModelRegistryRefusal };

export type ModelRegistryStatus =
  | { readonly source: 'bundled'; readonly snapshotId: string; readonly reasonCode: null }
  | { readonly source: 'override'; readonly snapshotId: string; readonly reasonCode: null }
  | { readonly source: 'refused'; readonly snapshotId: null; readonly reasonCode: ModelRegistryRefusal };

/** Checks the override's bytes with the router's own check (core checkModelRegistryBytes). */
export function checkModelRegistryBytes(bytes: Uint8Array): ModelRegistryStatus {
  const checked = coreCheck(bytes);
  return checked.registry !== null ? { source: 'override', snapshotId: checked.registry.snapshotId, reasonCode: null } : { source: 'refused', snapshotId: null, reasonCode: checked.reasonCode };
}

/** A reader for one home, cached on the file's size and mtime. */
export function modelRegistryStatusReader(home: string): () => ModelRegistryStatus {
  const path = modelRegistryFile(home);
  const bundled: ModelRegistryStatus = { source: 'bundled', snapshotId: BUNDLED_MODEL_REGISTRY.snapshotId, reasonCode: null };
  let cached: { readonly key: string; readonly status: ModelRegistryStatus } | undefined;
  return () => {
    let st;
    try {
      st = statSync(path);
    } catch {
      cached = undefined;
      return bundled;
    }
    const key = `${String(st.size)}:${String(st.mtimeMs)}`;
    if (cached?.key === key) return cached.status;
    let status: ModelRegistryStatus;
    if (!st.isFile()) status = { source: 'refused', snapshotId: null, reasonCode: 'MODEL_REGISTRY_UNREADABLE' };
    else if (st.size > MODEL_REGISTRY_MAX_BYTES) status = { source: 'refused', snapshotId: null, reasonCode: 'MODEL_REGISTRY_TOO_LARGE' };
    else {
      try {
        status = checkModelRegistryBytes(readFileSync(path));
      } catch {
        status = { source: 'refused', snapshotId: null, reasonCode: 'MODEL_REGISTRY_UNREADABLE' };
      }
    }
    cached = { key, status };
    return status;
  };
}

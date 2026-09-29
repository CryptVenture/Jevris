import { readLeases, type LeaseRow } from './lease.js';
import { openStore, type OpenStoreInput, type OpenStoreResult } from './open.js';

export const COPIED_HOST_SCOPE_IS_NOT_NFS_DETECTION =
  'a copied hostScope string is not NFS detection';

export function openGuardedStore(input: OpenStoreInput): OpenStoreResult {
  return openStore(input);
}

export function readWorkspaceLeases(store: OpenStoreResult, workspaceId: string): readonly LeaseRow[] {
  if (!store.ok) return [];
  if (workspaceId !== store.workspaceId) return [];
  return readLeases(store);
}

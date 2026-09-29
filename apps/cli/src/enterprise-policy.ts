/**
 * Managed (enterprise) policy and the enterprise kill switch (GOV-05). The reader lives in
 * @jevris/orchestrator (settings/managed-policy.ts) so the effective settings apply the managed
 * `mode` ceiling; this module re-exports it, so `@jevris/cli/enterprise-policy` keeps working.
 */
export {
  MANAGED_KILL_SWITCH_FILE,
  MANAGED_POLICY_FILE,
  MANAGED_REGISTRY_KEY,
  aclAdminOnlyWrite,
  layerPolicy,
  managedPolicyDefaults,
  managedPolicyDir,
  parseRegQuery,
  readManagedKillSwitch,
  readManagedPolicy,
  setManagedPolicyDefaults,
  type LayeredPolicy,
  type ManagedKillSwitch,
  type ManagedOptions,
  type ManagedPolicyState,
  type ManagedRefusal,
} from '@jevris/orchestrator';

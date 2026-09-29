/** Chapter 6.1 HarnessAdapter port, and a guard that validates every value crossing it. */
import {
  ActionIntentContract,
  ActionReceiptContract,
  CapabilityContract,
  type ActionIntent,
  type ActionReceipt,
  type Capability,
} from './actions.js';
import { ContractError } from './contract.js';
import { SessionSnapshotContract, type SessionSnapshot } from './domain.js';

export interface HarnessAdapter {
  capabilities(): Promise<readonly Capability[]>;
  snapshot(sessionId: string): Promise<SessionSnapshot>;
  apply(intent: ActionIntent, signal: AbortSignal): Promise<ActionReceipt>;
}

/**
 * Wraps an adapter so that nothing unvalidated crosses the port:
 * - `apply` refuses an intent that fails the ActionIntent contract before the adapter sees it;
 * - every capability, snapshot and receipt the adapter returns is validated, and a receipt must
 *   name the intent it answers; a snapshot must be for the requested session.
 * A failure throws ContractError; it is never repaired or defaulted.
 */
export function guardHarnessAdapter(adapter: HarnessAdapter): HarnessAdapter {
  return Object.freeze({
    async capabilities(): Promise<readonly Capability[]> {
      const list = await adapter.capabilities();
      if (!Array.isArray(list)) throw new ContractError('Capability', [{ path: '', code: 'type' }]);
      return Object.freeze(list.map((capability: unknown) => CapabilityContract.assert(capability)));
    },
    async snapshot(sessionId: string): Promise<SessionSnapshot> {
      const snapshot = SessionSnapshotContract.assert(await adapter.snapshot(sessionId));
      if (snapshot.sessionId !== sessionId) throw new ContractError('SessionSnapshot', [{ path: '/sessionId', code: 'SESSION_MISMATCH' }]);
      return snapshot;
    },
    async apply(intent: ActionIntent, signal: AbortSignal): Promise<ActionReceipt> {
      const checked = ActionIntentContract.assert(intent);
      const receipt = ActionReceiptContract.assert(await adapter.apply(checked, signal));
      if (receipt.intentId !== checked.id) throw new ContractError('ActionReceipt', [{ path: '/intentId', code: 'INTENT_MISMATCH' }]);
      return receipt;
    },
  });
}

/**
 * The decision path, warmed before the first request (`createSidecarEngine` calls it once, at start).
 *
 * The first decision of a process took about 110 ms of its own work where the next took 22 (measured on the engine
 * with an instant stub Jev, so none of it is network): each contract compiles its Ajv validator the first time it
 * validates something (the decision record 33 ms, the Jev request 14 ms, the decision result 8 ms), and the SDK, the
 * response validator and the packet builder run their first lines of code. Done at start, before the sidecar answers
 * anything, the cost moves from the first request, which has a 900 ms budget, to the start, which has none.
 *
 * It validates empty values (each answers with an issue and compiles its validator), builds a packet, and runs one whole
 * round trip through the SDK transport and the response validator on the in-memory conformance mock. It opens no socket,
 * reads no credential, touches no file and changes no state; the key it hands the transport is not one. Never throws.
 */
import { buildPacket, compileDecisionSpec, DEFAULT_PACKET_LIMITS, estimateRequest, lintQuestions, validateJevRequest, validateJevResponse } from '@jevris/core';
import { ActionContract, ActionReceiptContract, DecisionRecordContract, DecisionResultContract, DecisionSpecContract } from '@jevris/contracts';
import { CONFORMANCE_REQUEST } from './conformance.js';
import { createMockFetch } from './conformance-mock.js';
import { createSdkTransport } from './sdk-transport.js';

export async function warmDecisionPath(): Promise<void> {
  try {
    for (const contract of [DecisionSpecContract, DecisionRecordContract, DecisionResultContract, ActionContract, ActionReceiptContract]) contract.validate({});
    const questions = CONFORMANCE_REQUEST.questions;
    lintQuestions(questions);
    compileDecisionSpec({ id: 'warm-up', version: 'v1', questions, evidenceRequirements: [], deadlineMs: 900, fallback: 'rules-only' });
    buildPacket({ objective: 'Warm up.', trustedPolicy: {}, facts: { warm: true }, evidence: [], missingEvidence: [] }, DEFAULT_PACKET_LIMITS, { sourceEgress: 'denied' });
    validateJevRequest(CONFORMANCE_REQUEST);
    estimateRequest(CONFORMANCE_REQUEST);
    const transport = createSdkTransport({ apiKey: 'warm-up-not-a-key', fetch: createMockFetch({ scenario: 'valid' }) });
    const answered = await transport.call(CONFORMANCE_REQUEST, { timeoutMs: 5000 });
    if (answered.ok) validateJevResponse(answered.body, questions);
  } catch {
    // A warm-up that fails changes nothing: the first request compiles what it needs, as it did before.
  }
}

import { MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, PINNED_MODEL, } from '../contracts/index.js';
import { applyRules } from './rules.js';
import { encodeUtf8, validateChoiceBody, validateChoiceSpec } from './validate-choice.js';
export async function evaluateChoice(spec, input, deps) {
    const parsed = validateChoiceSpec(spec);
    if (!parsed.ok)
        return refuse('INVALID_REQUEST', 0, null);
    const hit = applyRules(input);
    if (hit !== null)
        return fromHit(hit);
    if (deps.signal.aborted)
        return refuse('CANCELLED', 0, null);
    const requestBytes = encodeUtf8(JSON.stringify({
        model: PINNED_MODEL,
        questions: {
            [parsed.spec.id]: {
                type: 'choice',
                instructions: parsed.spec.instructions,
                criteria: parsed.spec.criteria,
            },
        },
    }));
    if (requestBytes.byteLength > MAX_REQUEST_BYTES)
        return refuse('REQUEST_TOO_LARGE', 0, null);
    const delivery = await deps.port.evaluate(requestBytes, deps.signal, deps.deadlineAtMs);
    const calls = deps.port.calls;
    const body = delivery.body;
    if (deps.signal.aborted)
        return refuse('CANCELLED', calls, body);
    if (!Number.isFinite(delivery.receivedAtMs) || delivery.receivedAtMs >= deps.deadlineAtMs) {
        return refuse('DEADLINE', calls, body);
    }
    if (body === null)
        return refuse('INVALID_RESPONSE', calls, null);
    if (body.byteLength > MAX_RESPONSE_BYTES)
        return refuse('RESPONSE_TOO_LARGE', calls, body);
    const validated = validateChoiceBody(body, parsed.spec);
    if (!validated.ok)
        return refuse(validated.reasonCode, calls, body);
    return buildRecord({
        disposition: 'abstained',
        reasonCode: 'CHOICE_RECORDED',
        classification: validated.classification,
        count: null,
        providerCalls: calls,
        retainedBody: body,
        resolvedModel: validated.resolvedModel,
        providerConfidence: validated.providerConfidence,
    });
}
function fromHit(hit) {
    return buildRecord({
        disposition: hit.disposition,
        reasonCode: hit.reasonCode,
        classification: hit.classification,
        count: hit.count,
        providerCalls: 0,
        retainedBody: null,
    });
}
function refuse(reasonCode, providerCalls, retainedBody) {
    return buildRecord({
        disposition: 'refused',
        reasonCode,
        classification: null,
        count: null,
        providerCalls,
        retainedBody,
    });
}
function buildRecord(parts) {
    const record = {
        disposition: parts.disposition,
        reasonCode: parts.reasonCode,
        classification: parts.classification,
        count: parts.count,
        plannedAction: { kind: 'abstain', reasonCode: parts.reasonCode },
        appliedAction: null,
        authorityGranted: false,
        consentFabricated: false,
        verified: false,
        persisted: false,
        providerCalls: parts.providerCalls,
        retainedBody: copyBytes(parts.retainedBody),
    };
    if (parts.resolvedModel === undefined || parts.providerConfidence === undefined)
        return record;
    return {
        ...record,
        resolvedModel: parts.resolvedModel,
        providerConfidence: parts.providerConfidence,
    };
}
function copyBytes(body) {
    if (body === null)
        return null;
    return new Uint8Array(body);
}

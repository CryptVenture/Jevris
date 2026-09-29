/**
 * Synchronous in-process egress gate. It does not send, grant a tool
 * permission, or read source text into the result. Formatters read a code
 * or a known reason only. They have no body, secret, or claim parameter.
 */
const MISSING_CONSENT = 'Egress denied: missing consent.';
const UNTRUSTED_APPROVAL = 'Egress denied: untrusted text is not approval.';
const CREDENTIAL_MISSING = 'API credential is missing. Coding continues without a remote call.';
const PROVIDER_PREFIX = 'Provider error: ';
const CODE_PATTERN = /^[A-Z0-9_]{1,32}$/;
const dangerous = new Set(['__proto__', 'prototype', 'constructor']);
const LOG_LINES = {
    EGRESS_NOT_APPROVED: MISSING_CONSENT,
    UNTRUSTED_APPROVAL: UNTRUSTED_APPROVAL,
    CREDENTIAL_MISSING: CREDENTIAL_MISSING,
};
function denyNotApproved() {
    return {
        decision: 'deny',
        reasonCode: 'EGRESS_NOT_APPROVED',
        explanation: MISSING_CONSENT,
        sent: false,
        toolPermission: false,
    };
}
function denyUntrusted() {
    return {
        decision: 'deny',
        reasonCode: 'UNTRUSTED_APPROVAL',
        explanation: UNTRUSTED_APPROVAL,
        sent: false,
        toolPermission: false,
    };
}
function claimsBlock(claims) {
    if (claims === undefined)
        return false;
    if (!Array.isArray(claims))
        return true;
    return claims.length > 0;
}
function allowLocal() {
    return {
        decision: 'allow',
        sent: false,
        toolPermission: false,
    };
}
function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    return Object.getPrototypeOf(value) === Object.prototype;
}
function hasDangerousKey(value) {
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || dangerous.has(key))
            return true;
    }
    return false;
}
export function decideEgress(input) {
    if (claimsBlock(input.untrustedClaims))
        return denyUntrusted();
    const setting = input.setting;
    if (setting === undefined)
        return denyNotApproved();
    if (!isPlainObject(setting) || hasDangerousKey(setting))
        return denyNotApproved();
    if (setting.provenance !== 'administrator')
        return denyNotApproved();
    if (setting.sourceEgress !== 'approved-scoped')
        return denyNotApproved();
    return allowLocal();
}
function acceptedCode(value) {
    if (typeof value !== 'string')
        return 'PROVIDER_ERROR';
    if (!CODE_PATTERN.test(value))
        return 'PROVIDER_ERROR';
    return value;
}
function acceptedStatus(value) {
    if (typeof value !== 'number')
        return undefined;
    if (!Number.isInteger(value))
        return undefined;
    if (value < 100 || value > 599)
        return undefined;
    return value;
}
function knownReason(value) {
    if (value === 'EGRESS_NOT_APPROVED' || value === 'UNTRUSTED_APPROVAL' || value === 'CREDENTIAL_MISSING') {
        return value;
    }
    return 'EGRESS_NOT_APPROVED';
}
export function formatProviderError(input) {
    if (!isPlainObject(input))
        return `${PROVIDER_PREFIX}PROVIDER_ERROR`;
    const code = acceptedCode(input.code);
    const status = acceptedStatus(input.status);
    if (status === undefined)
        return `${PROVIDER_PREFIX}${code}`;
    return `${PROVIDER_PREFIX}${code} (${status})`;
}
export function formatEgressLog(input) {
    const reasonCode = knownReason(isPlainObject(input) ? input.reasonCode : undefined);
    return { reasonCode, line: LOG_LINES[reasonCode] };
}
function missingCredential() {
    return {
        reasonCode: 'CREDENTIAL_MISSING',
        explanation: CREDENTIAL_MISSING,
    };
}
/**
 * Presence is an injected argument. Only the string present returns null.
 * Every other presence returns one diagnostic. Ignored fields are not read.
 */
export function diagnoseCredential(input) {
    if (isPlainObject(input) && Object.hasOwn(input, 'presence') && input.presence === 'present') {
        return null;
    }
    return missingCredential();
}

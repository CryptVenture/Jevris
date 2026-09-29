/**
 * Pure rules gate. It never issues permission, reserves money, or executes an action.
 * A hit is not authorization. Null means the input is ambiguous-failure and may continue.
 */
const dangerous = new Set(['__proto__', 'prototype', 'constructor']);
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
function refused() {
    return {
        disposition: 'refused',
        reasonCode: 'INVALID_REQUEST',
        classification: null,
        count: null,
    };
}
function rulesHit(reasonCode, classification, count) {
    return {
        disposition: 'rules',
        reasonCode,
        classification,
        count,
    };
}
const knownFamilies = new Set(['type_error', 'assertion', 'environment']);
const authorityAsks = new Set(['permission', 'consent', 'verified']);
function knownFailure(input) {
    const family = input.family;
    if (typeof family !== 'string' || !knownFamilies.has(family))
        return refused();
    return rulesHit('KNOWN_FAILURE', family, null);
}
function integerCount(input) {
    if (!Array.isArray(input.items))
        return refused();
    return rulesHit('INTEGER_COUNT', null, input.items.length);
}
function authorityRequest(input) {
    const asked = input.asked;
    if (typeof asked !== 'string' || !authorityAsks.has(asked))
        return refused();
    return {
        disposition: 'refused',
        reasonCode: 'INELIGIBLE',
        classification: null,
        count: null,
    };
}
export function applyRules(input) {
    if (!isPlainObject(input) || hasDangerousKey(input))
        return refused();
    if (input.kind === 'ambiguous-failure')
        return null;
    if (input.kind === 'known-failure')
        return knownFailure(input);
    if (input.kind === 'count')
        return integerCount(input);
    if (input.kind === 'authority-request')
        return authorityRequest(input);
    return refused();
}

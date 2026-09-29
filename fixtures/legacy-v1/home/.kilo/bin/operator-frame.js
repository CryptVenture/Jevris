/**
 * Outbound operator frame for the existing hook socket.
 * This module does not open a store, read a credential, or emit a decision.
 */
const CAPSULE_FIELDS = [
    'destination',
    'capsuleId',
    'workspaceId',
    'taskId',
    'policyVersion',
    'evidenceRevision',
    'userConstraints',
    'taskIds',
    'approvals',
    'sourceHashes',
    'openChecks',
];
const STATUS_FIELDS = ['source', 'mode', 'health', 'pinnedModel', 'reasonCode'];
const ROUTE_FIELDS = [
    'to_model',
    'mode',
    'policyVersion',
    'evidenceRevision',
    'predictedModel',
    'family',
    'priorRecords',
];
const SKILL_FIELDS = ['requestedIds', 'intent', 'family'];
const EVIDENCE_FIELDS = ['ids', 'family'];
const ENVIRONMENT_FIELDS = [
    'diagnostic',
    'sourceEvidence',
    'fingerprint',
    'sameFingerprintCount',
    'commandHashRepeated',
    'relevantDiff',
    'rejectedApproaches',
    'proposedCause',
    'maxRepairAttempts',
    'repairAttemptsUsed',
    'family',
];
const COMPLETION_FIELDS = ['uncovered', 'family'];
const ADVICE_KINDS = ['route', 'skills', 'evidence', 'environment', 'completion'];
const RESTORE_FIELDS = ['destination', 'workspaceId', 'taskId', 'scope', 'source', 'evidenceRevision'];
export function operatorFrame(stdin, caller) {
    const text = decodeUtf8Fatal(stdin);
    if (text === undefined)
        return undefined;
    const parsed = parseText(text);
    if (parsed === undefined)
        return undefined;
    const event = own(parsed, 'hook_event_name');
    if (event === 'PreCompact')
        return checkpointFrame(parsed, caller, event);
    if (event === 'PostCompact')
        return restoreFrame(parsed, caller, event, text);
    if (event === 'SessionStart') {
        const source = own(parsed, 'source');
        if (source === 'startup' || source === 'clear') {
            return namedFrame(parsed, caller, { op: 'status', hook_event_name: event }, STATUS_FIELDS);
        }
        if (source === 'compact' || source === 'resume')
            return restoreFrame(parsed, caller, event, text);
        return undefined;
    }
    if (event === 'PreModelSwitch') {
        return namedFrame(parsed, caller, { op: 'advice', kind: 'route', hook_event_name: event }, ROUTE_FIELDS);
    }
    if (event === 'UserPromptSubmit') {
        const kind = own(parsed, 'jevris_kind');
        if (isAdviceKind(kind)) {
            return namedFrame(parsed, caller, { op: 'advice', kind, hook_event_name: event }, fieldsFor(kind));
        }
        return restoreFrame(parsed, caller, event, text);
    }
    return undefined;
}
function restoreFrame(parsed, caller, event, stdinText) {
    const frame = {
        op: 'checkpoint',
        hook_event_name: event,
        stdin: stdinText,
    };
    copyCaller(caller, frame);
    copyFields(parsed, frame, RESTORE_FIELDS);
    return JSON.stringify(frame);
}
function checkpointFrame(parsed, caller, event) {
    const frame = {
        op: 'checkpoint',
        hook_event_name: event,
    };
    copyCaller(caller, frame);
    copyFields(parsed, frame, CAPSULE_FIELDS);
    return JSON.stringify(frame);
}
function namedFrame(parsed, caller, base, fields) {
    const frame = { ...base };
    copyCaller(caller, frame);
    copyFields(parsed, frame, fields);
    return JSON.stringify(frame);
}
function fieldsFor(kind) {
    if (kind === 'route')
        return ROUTE_FIELDS;
    if (kind === 'skills')
        return SKILL_FIELDS;
    if (kind === 'evidence')
        return EVIDENCE_FIELDS;
    if (kind === 'environment')
        return ENVIRONMENT_FIELDS;
    return COMPLETION_FIELDS;
}
function isAdviceKind(value) {
    return value === 'route' || value === 'skills' || value === 'evidence' || value === 'environment' || value === 'completion';
}
function copyCaller(caller, frame) {
    if (caller.user !== undefined)
        frame['user'] = caller.user;
    if (caller.pid !== undefined)
        frame['pid'] = caller.pid;
    if (caller.token !== undefined)
        frame['token'] = caller.token;
}
function copyFields(parsed, frame, fields) {
    for (const key of fields) {
        if (key === 'compact_summary' || key === 'permissionDecision' || key === 'updatedInput' || key === 'summary') {
            continue;
        }
        if (!Object.hasOwn(parsed, key))
            continue;
        frame[key] = parsed[key];
    }
}
function parseText(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return undefined;
    }
    if (!isPlainObject(parsed))
        return undefined;
    return parsed;
}
function own(value, key) {
    if (!Object.hasOwn(value, key))
        return undefined;
    return Reflect.get(value, key);
}
function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    return Object.getPrototypeOf(value) === Object.prototype;
}
function decodeUtf8Fatal(bytes) {
    const Ctor = globalThis.TextDecoder;
    if (Ctor === undefined)
        return undefined;
    try {
        return new Ctor('utf-8', { fatal: true }).decode(bytes);
    }
    catch {
        return undefined;
    }
}

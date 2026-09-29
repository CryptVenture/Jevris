import { MAX_REQUEST_BYTES, PINNED_MODEL } from './vendor/contracts/index.js';
import { HOOK_BUDGET_MS, createAntiReplayStore, handleHookEvent, hookDeadlineMissed, runLocalRuntime, } from './vendor/core/index.js';
import { createConnection } from 'node:net';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { operatorFrame } from './operator-frame.js';
/**
 * Unregistered command-hook process. A miss, a down sidecar, a reject, or
 * invalid stdin returns the library result. A sidecar timeout, overload, or
 * prohibited label selects the library rules-only fallback. That result is not
 * stdout. This module does not open a store, read a provider credential, or
 * copy a sidecar body to stdout.
 */
const DECLARED_ROUTE = 'providerDirect';
const DECLARED_POLICY = 'policyV1';
const SAFE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const PIPE_PREFIX = '\\\\.\\pipe\\jevris-';
function defaultIpcPath() {
    const dir = join(homedir(), '.jevris', 'run');
    if (platform() === 'win32')
        return `${PIPE_PREFIX}${pipeToken(dir)}`;
    return join(dir, 's');
}
function pipeToken(dir) {
    let hash = 2166136261;
    for (let i = 0; i < dir.length; i += 1) {
        hash ^= dir.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}
export function runHookProcess(input) {
    if (hookDeadlineMissed(input.nowMs, input.startedAtMs)) {
        return libraryResult(input);
    }
    if (!stdinIsPlainObject(input.stdin)) {
        return libraryResult(input);
    }
    if (revisionsDiffer(input)) {
        return handoffAnalysis(input, 'revision');
    }
    return exchange(input);
}
function revisionsDiffer(input) {
    if (input.expectedRevision === undefined && input.currentRevision === undefined)
        return false;
    return input.expectedRevision !== input.currentRevision;
}
function analysisText(reason) {
    return JSON.stringify({ op: 'analysis', reason, applied: false });
}
function handoffAnalysis(input, reason) {
    const path = input.socketPath ?? defaultIpcPath();
    return new Promise((resolve) => {
        let settled = false;
        let flushed = false;
        let peerDone = false;
        const socket = createConnection(path);
        const finish = () => {
            if (settled)
                return;
            settled = true;
            socket.setTimeout(0);
            socket.destroy();
            resolve(libraryResult(input));
        };
        const finishMissed = (nowMs) => {
            if (settled)
                return;
            settled = true;
            socket.setTimeout(0);
            socket.destroy();
            resolve(libraryResult(withNow(input, nowMs)));
        };
        const maybeFinish = () => {
            if (flushed && peerDone)
                finish();
        };
        const onBudget = () => {
            if (settled)
                return;
            const now = observedNow(input);
            if (hookDeadlineMissed(now, input.startedAtMs)) {
                finishMissed(now);
                return;
            }
            if (!input.clockFrozen && remainingDelay(input) >= 1) {
                arm();
                return;
            }
            finish();
        };
        const arm = () => {
            if (settled)
                return;
            const delay = remainingDelay(input);
            // setTimeout(0) disables the idle timer. A sub-millisecond remainder is
            // the same budget window, not a wait for peer end.
            if (delay < 1) {
                onBudget();
                return;
            }
            socket.setTimeout(delay, () => {
                onBudget();
            });
        };
        socket.on('error', () => {
            finish();
        });
        socket.on('data', () => {
            // The ack is not a permission decision and is not stdout.
        });
        socket.on('end', () => {
            peerDone = true;
            maybeFinish();
        });
        arm();
        socket.write(analysisText(reason), () => {
            if (settled)
                return;
            flushed = true;
            socket.end();
            maybeFinish();
        });
    });
}
function libraryResult(input) {
    return handleHookEvent({
        launcher: 'present',
        nowMs: input.nowMs,
        startedAtMs: input.startedAtMs,
        stdin: input.stdin,
    });
}
function stdinIsPlainObject(bytes) {
    if (bytes.byteLength > MAX_REQUEST_BYTES)
        return false;
    const text = decodeUtf8Fatal(bytes);
    if (text === undefined)
        return false;
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return false;
    }
    return isPlainObject(parsed);
}
function exchange(input) {
    const path = input.socketPath ?? defaultIpcPath();
    return new Promise((resolve) => {
        let settled = false;
        let runtimeStarted = false;
        let failed = false;
        let analysisSent = false;
        let handoffStarted = false;
        let writable = true;
        const socket = createConnection(path);
        const finish = (nowMs) => {
            if (settled)
                return;
            settled = true;
            socket.destroy();
            resolve(libraryResult(withNow(input, nowMs)));
        };
        const writeAnalysis = (reason, done) => {
            if (analysisSent || failed || !writable) {
                done();
                return;
            }
            analysisSent = true;
            writable = false;
            socket.write(analysisText(reason), () => {
                socket.end();
                afterPeerRead(done);
            });
        };
        const applyChoice = (nowMs, parsed, missed) => {
            if (settled || runtimeStarted)
                return;
            const labeled = parsed === undefined ? 'none' : classify(parsed);
            const selected = labeled !== 'none' ? labeled : missed ? 'timeout' : 'none';
            if (selected === 'none' || runtimeIdentity(input) === undefined) {
                finish(nowMs);
                return;
            }
            runtimeStarted = true;
            void callRuntime(input, nowMs, selected)
                .then(() => {
                finish(nowMs);
            })
                .catch(() => {
                finish(nowMs);
            });
        };
        const settle = (nowMs, parsed) => {
            if (settled || runtimeStarted || handoffStarted)
                return;
            const missed = hookDeadlineMissed(nowMs, input.startedAtMs);
            if (missed) {
                handoffStarted = true;
                writeAnalysis('deadline', () => {
                    applyChoice(nowMs, undefined, true);
                });
                return;
            }
            if (isStale(parsed)) {
                handoffStarted = true;
                writeAnalysis('revision', () => {
                    finish(nowMs);
                });
                return;
            }
            applyChoice(nowMs, parsed, false);
        };
        const arm = () => {
            if (settled)
                return;
            socket.setTimeout(remainingDelay(input), () => {
                const now = observedNow(input);
                if (hookDeadlineMissed(now, input.startedAtMs)) {
                    if (operatorSent) {
                        finishOperator(now);
                        return;
                    }
                    settle(now, undefined);
                    return;
                }
                if (!input.clockFrozen)
                    arm();
            });
        };
        const chunks = [];
        const operatorText = operatorOutbound(input);
        const operatorSent = operatorText !== undefined;
        const finishOperator = (nowMs, parsed) => {
            if (settled)
                return;
            settled = true;
            socket.destroy();
            if (hookDeadlineMissed(nowMs, input.startedAtMs) || own(parsed ?? {}, 'decision') === 'reject') {
                resolve(libraryResult(withNow(input, nowMs)));
                return;
            }
            const stdout = restoreStdout(parsed);
            if (stdout === undefined) {
                resolve(libraryResult(withNow(input, nowMs)));
                return;
            }
            resolve({ exitCode: 0, stdout });
        };
        socket.on('error', () => {
            failed = true;
            if (operatorSent) {
                finishOperator(observedNow(input));
                return;
            }
            settle(observedNow(input), undefined);
        });
        socket.on('data', (chunk) => {
            if (settled)
                return;
            const now = observedNow(input);
            if (operatorSent) {
                if (hookDeadlineMissed(now, input.startedAtMs)) {
                    finishOperator(now);
                    return;
                }
                chunks.push(chunk);
                const parsed = parseOneObject(chunks);
                if (parsed === undefined)
                    return;
                finishOperator(now, parsed);
                return;
            }
            if (hookDeadlineMissed(now, input.startedAtMs)) {
                settle(now, undefined);
                return;
            }
            chunks.push(chunk);
            const parsed = parseOneObject(chunks);
            if (parsed === undefined)
                return;
            settle(now, parsed);
        });
        socket.on('end', () => {
            if (settled)
                return;
            const now = observedNow(input);
            if (operatorSent) {
                finishOperator(now, parseOneObject(chunks));
                return;
            }
            if (hookDeadlineMissed(now, input.startedAtMs)) {
                settle(now, undefined);
                return;
            }
            settle(now, parseOneObject(chunks));
        });
        arm();
        const outbound = operatorText ?? credentialText(input);
        if (outbound === undefined)
            arm();
        else if (operatorSent) {
            socket.write(outbound, () => {
                if (settled)
                    return;
                socket.end();
                arm();
            });
        }
        else {
            socket.write(outbound, () => {
                if (settled)
                    return;
                arm();
            });
        }
    });
}
function restoreStdout(parsed) {
    if (parsed === undefined || !Object.hasOwn(parsed, 'hookStdout'))
        return undefined;
    const hookStdout = own(parsed, 'hookStdout');
    if (typeof hookStdout !== 'string')
        return undefined;
    if (hookStdout === '')
        return '';
    if (!isRestoreStdout(hookStdout))
        return undefined;
    return hookStdout;
}
function isRestoreStdout(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return false;
    }
    if (!isPlainObject(parsed))
        return false;
    const keys = Object.keys(parsed);
    if (keys.length !== 1 || keys[0] !== 'hookSpecificOutput')
        return false;
    const output = own(parsed, 'hookSpecificOutput');
    if (!isPlainObject(output))
        return false;
    if (typeof own(output, 'hookEventName') !== 'string')
        return false;
    if (typeof own(output, 'additionalContext') !== 'string')
        return false;
    if (hasForbiddenOutput(parsed) || hasForbiddenOutput(output))
        return false;
    return true;
}
function hasForbiddenOutput(value) {
    return (Object.hasOwn(value, 'permissionDecision') ||
        Object.hasOwn(value, 'updatedInput') ||
        Object.hasOwn(value, 'decision') ||
        Object.hasOwn(value, 'compact_summary'));
}
function operatorOutbound(input) {
    if (hookDeadlineMissed(observedNow(input), input.startedAtMs))
        return undefined;
    return operatorFrame(input.stdin, {
        user: input.user,
        pid: input.pid,
        token: input.token,
    });
}
function afterPeerRead(done) {
    const host = globalThis;
    const schedule = host.setImmediate;
    if (schedule === undefined) {
        done();
        return;
    }
    schedule(() => {
        schedule(done);
    });
}
function isStale(parsed) {
    return parsed !== undefined && own(parsed, 'reasonCode') === 'STALE';
}
function credentialText(input) {
    const frame = {};
    if (input.user !== undefined)
        frame['user'] = input.user;
    if (input.pid !== undefined)
        frame['pid'] = input.pid;
    if (input.token !== undefined)
        frame['token'] = input.token;
    if (Object.keys(frame).length === 0)
        return undefined;
    return JSON.stringify(frame);
}
function observedNow(input) {
    return input.clockFrozen ? input.nowMs : Date.now();
}
function remainingDelay(input) {
    const now = observedNow(input);
    const elapsed = now - input.startedAtMs;
    const delay = HOOK_BUDGET_MS - elapsed;
    if (!Number.isFinite(delay) || delay < 0)
        return 0;
    return delay;
}
function withNow(input, nowMs) {
    const next = {
        nowMs,
        startedAtMs: input.startedAtMs,
        stdin: input.stdin,
        clockFrozen: input.clockFrozen,
    };
    if (input.socketPath !== undefined)
        next.socketPath = input.socketPath;
    if (input.user !== undefined)
        next.user = input.user;
    if (input.pid !== undefined)
        next.pid = input.pid;
    if (input.token !== undefined)
        next.token = input.token;
    if (input.expiresAtMs !== undefined)
        next.expiresAtMs = input.expiresAtMs;
    if (input.credential !== undefined)
        next.credential = input.credential;
    if (input.providerRoute !== undefined)
        next.providerRoute = input.providerRoute;
    if (input.policyVersion !== undefined)
        next.policyVersion = input.policyVersion;
    if (input.onRuntime !== undefined)
        next.onRuntime = input.onRuntime;
    if (input.probe !== undefined)
        next.probe = input.probe;
    if (input.probes !== undefined)
        next.probes = input.probes;
    if (input.outages !== undefined)
        next.outages = input.outages;
    if (input.expectedRevision !== undefined)
        next.expectedRevision = input.expectedRevision;
    if (input.currentRevision !== undefined)
        next.currentRevision = input.currentRevision;
    if (input.stillUseful !== undefined)
        next.stillUseful = input.stillUseful;
    if (input.affordable !== undefined)
        next.affordable = input.affordable;
    return next;
}
function runtimeIdentity(input) {
    if (typeof input.expiresAtMs !== 'number' || !Number.isFinite(input.expiresAtMs))
        return undefined;
    const credential = input.credential;
    if (credential === undefined)
        return undefined;
    if (typeof credential.user !== 'string' || credential.user.length === 0)
        return undefined;
    if (typeof credential.pid !== 'number' || !Number.isSafeInteger(credential.pid) || credential.pid < 0) {
        return undefined;
    }
    if (!(credential.token instanceof Uint8Array) || credential.token.byteLength !== 32)
        return undefined;
    if (typeof credential.expiresAtMs !== 'number' || !Number.isFinite(credential.expiresAtMs))
        return undefined;
    return credential;
}
function classify(value) {
    if (own(value, 'networkPolicy') === 'prohibited')
        return 'prohibited';
    if (own(value, 'availability') === 'timeout')
        return 'timeout';
    if (own(value, 'status') === 529)
        return 'overload';
    if (own(value, 'connectivity') === 'returned' &&
        own(value, 'circuit') === 'open' &&
        own(value, 'availability') === 'available' &&
        own(value, 'status') !== 529) {
        return 'probe';
    }
    return 'none';
}
async function callRuntime(input, nowMs, kind) {
    const identity = runtimeIdentity(input);
    if (identity === undefined)
        return;
    const providerRoute = declaredRoute(input.providerRoute);
    const policyVersion = declaredPolicy(input.policyVersion);
    const shared = {
        mode: 'ready',
        caller: {
            user: identity.user,
            pid: identity.pid,
            token: identity.token,
        },
        expectedUser: identity.user,
        expectedPid: identity.pid,
        credential: {
            user: identity.user,
            pid: identity.pid,
            token: identity.token,
            expiresAtMs: identity.expiresAtMs,
        },
        nowMs,
        replay: createAntiReplayStore(),
        approvedModel: PINNED_MODEL,
        providerRoute,
        policyVersion,
        networkPolicy: kind === 'prohibited' ? 'prohibited' : 'allowed',
        availability: kind === 'timeout' ? 'timeout' : 'available',
        outages: outagesOf(input),
        probes: probesOf(input),
    };
    const result = kind === 'overload'
        ? await runLocalRuntime({ ...shared, status: 529 })
        : kind === 'probe'
            ? await runProbe(shared, input.probe)
            : await runLocalRuntime(shared);
    if (input.onRuntime !== undefined)
        input.onRuntime(result);
}
async function runProbe(shared, probe) {
    if (typeof probe !== 'function') {
        return runLocalRuntime({ ...shared, connectivity: 'returned', circuit: 'open' });
    }
    return runLocalRuntime({ ...shared, connectivity: 'returned', circuit: 'open', probe });
}
function declaredRoute(value) {
    if (typeof value === 'string' && SAFE_ID.test(value))
        return value;
    return DECLARED_ROUTE;
}
function declaredPolicy(value) {
    if (typeof value === 'string' && value.length > 0 && value.length <= 64 && !value.includes('://')) {
        return value;
    }
    return DECLARED_POLICY;
}
function outagesOf(input) {
    const given = input.outages;
    if (given !== undefined && typeof given.seen === 'function' && typeof given.mark === 'function') {
        return {
            seen(errorClass, providerRoute, policyVersion) {
                return given.seen(errorClass, providerRoute, policyVersion) === true;
            },
            mark(errorClass, providerRoute, policyVersion) {
                given.mark(errorClass, providerRoute, policyVersion);
            },
        };
    }
    return {
        seen() {
            return false;
        },
        mark() { },
    };
}
function probesOf(input) {
    const given = input.probes;
    if (given !== undefined && typeof given.probed === 'function' && typeof given.mark === 'function') {
        return {
            probed() {
                return given.probed() === true;
            },
            mark() {
                given.mark();
            },
        };
    }
    let marked = false;
    return {
        probed() {
            return marked;
        },
        mark() {
            marked = true;
        },
    };
}
function parseOneObject(chunks) {
    const text = decodeUtf8Fatal(concat(chunks));
    if (text === undefined)
        return undefined;
    try {
        const parsed = JSON.parse(text);
        if (!isPlainObject(parsed))
            return undefined;
        return parsed;
    }
    catch {
        return undefined;
    }
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
function concat(chunks) {
    let total = 0;
    for (const chunk of chunks)
        total += chunk.byteLength;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
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

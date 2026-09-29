import { MAX_REQUEST_BYTES } from './vendor/contracts/index.js';
import { runHookProcess } from './run.js';
/**
 * Stdin entry. Writes only the library stdout and exits with that code.
 * Does not log stdin. Does not emit a permission decision.
 */
const startedAtProcess = Date.now();
function envText(name) {
    const value = process.env[name];
    if (typeof value !== 'string' || value.length === 0)
        return undefined;
    return value;
}
function finiteEnv(name) {
    const raw = envText(name);
    if (raw === undefined)
        return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value))
        return undefined;
    return value;
}
function asBytes(chunk) {
    if (typeof chunk !== 'string')
        return chunk;
    const Ctor = globalThis.TextEncoder;
    if (Ctor === undefined)
        return new Uint8Array();
    return new Ctor().encode(chunk);
}
function concat(chunks, total) {
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}
async function readStdin() {
    const chunks = [];
    let total = 0;
    try {
        for await (const chunk of process.stdin) {
            const bytes = asBytes(chunk);
            if (bytes.byteLength > MAX_REQUEST_BYTES - total) {
                return new Uint8Array(MAX_REQUEST_BYTES + 1);
            }
            chunks.push(bytes);
            total += bytes.byteLength;
        }
    }
    catch {
        return new Uint8Array(MAX_REQUEST_BYTES + 1);
    }
    return concat(chunks, total);
}
function decodedCallerToken(value) {
    if (value === undefined)
        return undefined;
    const bytes = Buffer.from(value, 'base64');
    if (bytes.byteLength !== 32)
        return undefined;
    return bytes;
}
function numericPid(value) {
    if (value === undefined || !/^\d+$/.test(value))
        return undefined;
    const pid = Number(value);
    if (!Number.isSafeInteger(pid) || pid < 0)
        return undefined;
    return pid;
}
function withCallerCredential(input) {
    const tokenText = envText('JEVRIS_HOOK_TOKEN');
    const expiresAtMs = finiteEnv('JEVRIS_HOOK_EXPIRES_AT_MS');
    if (tokenText === undefined || expiresAtMs === undefined)
        return input;
    const token = decodedCallerToken(tokenText);
    const user = envText('JEVRIS_HOOK_USER');
    const pid = numericPid(envText('JEVRIS_HOOK_PID'));
    if (token === undefined || user === undefined || pid === undefined)
        return input;
    return {
        ...input,
        expiresAtMs,
        credential: { user, pid, token, expiresAtMs },
    };
}
function withOptional(input, key, value) {
    if (value === undefined)
        return input;
    if (key === 'socketPath')
        return { ...input, socketPath: value };
    if (key === 'user')
        return { ...input, user: value };
    if (key === 'pid')
        return { ...input, pid: value };
    if (key === 'token')
        return { ...input, token: value };
    if (key === 'expectedRevision')
        return { ...input, expectedRevision: value };
    return { ...input, currentRevision: value };
}
async function main() {
    const stdin = await readStdin();
    const startedAtMs = finiteEnv('JEVRIS_HOOK_STARTED_AT_MS') ?? startedAtProcess;
    const frozenNow = finiteEnv('JEVRIS_HOOK_NOW_MS');
    const nowMs = frozenNow ?? Date.now();
    let input = {
        nowMs,
        startedAtMs,
        stdin,
        clockFrozen: frozenNow !== undefined,
    };
    input = withOptional(input, 'socketPath', envText('JEVRIS_HOOK_SOCKET'));
    input = withOptional(input, 'user', envText('JEVRIS_HOOK_USER'));
    input = withOptional(input, 'pid', envText('JEVRIS_HOOK_PID'));
    input = withOptional(input, 'token', envText('JEVRIS_HOOK_TOKEN'));
    input = withOptional(input, 'expectedRevision', envText('JEVRIS_HOOK_EXPECTED_REVISION'));
    input = withOptional(input, 'currentRevision', envText('JEVRIS_HOOK_CURRENT_REVISION'));
    input = withCallerCredential(input);
    const result = await runHookProcess(input);
    process.stdout.write(result.stdout);
    process.exit(result.exitCode);
}
void main();

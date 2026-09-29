// R68 (access limits, design 6.1 and 5.5): an interactive turn that ended on an error carries an
// access signal of codes and a pattern id, never text, unless its endpoint is redirected (guard 6).
// Claude Code's StopFailure is turn.failed; Kilo's and OpenCode's session.error is turn.failed and
// a failed assistant message is message.completed with the fixed flag errored (B's MEDIUM 25).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runLauncher } = await import('../dist/launcher.js');
const { sessionAccessOf } = await import('../dist/session-access.js');
const { endpointRedirected } = await import('../dist/endpoint-redirect.js');
const [antigravity, claude, codex, kilocode, opencode] = await Promise.all([
  import('@jevris/adapter-antigravity'),
  import('@jevris/adapter-claude-code'),
  import('@jevris/adapter-codex'),
  import('@jevris/adapter-kilocode'),
  import('@jevris/adapter-opencode'),
]);
const ADAPTERS = { claude, kilo: kilocode, codex, opencode, agy: antigravity };
const CANARY = 'JEVRIS-CANARY-7f3a';

function box(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-session-access-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeSidecar() {
  const calls = [];
  return { calls, sidecar: { async ensure() { return { ok: true, endpoint: 'fake', started: false }; }, async request(input) { calls.push(input); return { ok: true, result: { recorded: true, duplicate: false, results: {} } }; } } };
}

const deps = (sidecar, workspace, redirected) => ({
  adapters: ADAPTERS,
  sidecar,
  env: { JEVRIS_HOME: join(workspace, 'home') },
  cwd: () => workspace,
  nowMs: () => Date.now(),
  ...(redirected === undefined ? {} : { endpointRedirected: async () => redirected }),
});

const stopFailure = (over = {}) => ({ hook_event_name: 'StopFailure', session_id: 'ses_1', transcript_path: '/nowhere/ses_1.jsonl', cwd: '/work', error_type: 'billing_error', error_message: `Credit balance is too low ${CANARY}`, ...over });
const failedMessage = (error, over = {}) => ({ event: { type: 'message.updated', properties: { info: { id: 'msg_9', sessionID: 'ses_1', role: 'assistant', providerID: 'anthropic', modelID: 'claude-sonnet-4-5', error, ...over } } } });
const apiError = (statusCode, extra = {}) => ({ name: 'APIError', data: { message: `${CANARY} Insufficient balance`, statusCode, isRetryable: false, responseHeaders: { 'x-canary': CANARY }, ...extra } });

test('Claude Code: StopFailure is turn.failed; its error code and pinned pattern become the signal, never its text', () => {
  const normalized = claude.normalize(stopFailure());
  assert.equal(normalized.ok, true);
  assert.equal(normalized.event.kind, 'turn.failed');
  assert.doesNotMatch(JSON.stringify(normalized.event), new RegExp(CANARY), 'the adapter keeps no error text');
  const access = sessionAccessOf('claude', normalized.event, stopFailure(), Date.now());
  assert.equal(access.provider, 'anthropic');
  assert.deepEqual(access.signal, { port: 'claude', channel: 'structured', errorType: 'billing_error', text: { pattern: 'C5', weekly: false, family: null, resetAtMs: null, resetForm: null } });
  const sub = claude.normalize(stopFailure({ agent_id: 'a1', agent_type: 'Explore' }));
  assert.equal(sub.event.kind, 'worker.failed', "a subagent's failure is its worker's");
  assert.equal(sessionAccessOf('claude', sub.event, stopFailure({ agent_id: 'a1' }), Date.now()).signal.errorType, 'billing_error');
  const textOnly = stopFailure({ error_type: undefined, error_message: "You've hit your weekly limit" });
  assert.deepEqual(sessionAccessOf('claude', claude.normalize(textOnly).event, textOnly, Date.now()).signal.text.pattern, 'C1');
  const nothing = stopFailure({ error_type: 'not a code!', error_message: 'something else' });
  assert.equal(sessionAccessOf('claude', claude.normalize(nothing).event, nothing, Date.now()), null);
  const stop = { hook_event_name: 'Stop', session_id: 'ses_1', transcript_path: '/nowhere/ses_1.jsonl', cwd: '/work', error_type: 'billing_error' };
  assert.equal(sessionAccessOf('claude', claude.normalize(stop).event, stop, Date.now()), null, 'only StopFailure carries one');
});

test('Claude Code 2.1.283: StopFailure in its documented shape (error, error_details, last_assistant_message) gives the error code and a pinned pattern, never text', () => {
  // The hooks reference (code.claude.com/docs/en/hooks#stopfailure); the owner's certify run on 2.1.283 sent no error_type.
  const documented = (over = {}) => ({ hook_event_name: 'StopFailure', session_id: 'ses_1', transcript_path: '/nowhere/ses_1.jsonl', cwd: '/work', permission_mode: 'default', error: 'rate_limit', error_details: `429 Too Many Requests ${CANARY}`, last_assistant_message: `API Error: Rate limit reached ${CANARY}`, ...over });
  const rate = documented();
  const access = sessionAccessOf('claude', claude.normalize(rate).event, rate, Date.now());
  assert.equal(access.signal.errorType, 'rate_limit');
  assert.doesNotMatch(JSON.stringify(access), new RegExp(CANARY));
  const billing = documented({ error: 'billing_error', error_details: undefined, last_assistant_message: `API Error: Credit balance is too low ${CANARY}` });
  const credit = sessionAccessOf('claude', claude.normalize(billing).event, billing, Date.now());
  assert.deepEqual([credit.signal.errorType, credit.signal.text?.pattern], ['billing_error', 'C5'], 'the API error string in last_assistant_message is matched when there are no details');
  const both = documented({ error: 'billing_error', error_type: 'rate_limit' });
  assert.equal(sessionAccessOf('claude', claude.normalize(both).event, both, Date.now()).signal.errorType, 'billing_error', 'the documented error wins over the older error_type');
});

for (const [harness, adapter, port] of [['kilo', kilocode, 'kilocode'], ['opencode', opencode, 'opencode']]) {
  test(`${harness}: a failed assistant message is message.completed with errored:true and its structured signal; session.error is turn.failed`, () => {
    const native = failedMessage(apiError(429, { responseBody: `{"error":{"code":"1113","message":"${CANARY}"}}` }));
    const normalized = adapter.normalize(native, { hookKey: 'event' });
    assert.equal(normalized.ok, true);
    assert.equal(normalized.event.kind, 'message.completed');
    assert.equal(normalized.event.payload.errored, true);
    assert.doesNotMatch(JSON.stringify(normalized.event), /JEVRIS-CANARY|APIError|Insufficient/, 'the flag carries no name or text');
    const access = sessionAccessOf(harness, normalized.event, native, Date.now());
    assert.equal(access.provider, 'anthropic');
    assert.deepEqual(access.signal, { port, channel: 'structured', errorType: 'APIError', status: 429, errorCode: '1113', text: { pattern: 'X2', weekly: false, family: null, resetAtMs: null, resetForm: null } }, 'the message counts only as a pattern id, beside the structured code');
    const ok = { event: { type: 'message.updated', properties: { info: { id: 'msg_8', sessionID: 'ses_1', role: 'assistant', providerID: 'anthropic', modelID: 'claude-sonnet-4-5', time: { created: 1, completed: 2 } } } } };
    const done = adapter.normalize(ok, { hookKey: 'event' });
    assert.equal(done.event.payload.errored, undefined, 'a finished message with no error is a success');
    assert.equal(sessionAccessOf(harness, done.event, ok, Date.now()), null);

    const busError = { event: { type: 'session.error', properties: { sessionID: 'ses_1', error: apiError(402) } } };
    const failed = adapter.normalize(busError, { hookKey: 'event' });
    assert.equal(failed.event.kind, 'turn.failed');
    assert.equal(sessionAccessOf(harness, failed.event, busError, Date.now()), null, 'an APIError is sent once, from its failed message');
    const auth = { event: { type: 'session.error', properties: { sessionID: 'ses_1', error: { name: 'ProviderAuthError', data: { providerID: 'xai', message: CANARY } } } } };
    const authAccess = sessionAccessOf(harness, adapter.normalize(auth, { hookKey: 'event' }).event, auth, Date.now());
    assert.deepEqual(authAccess, { signal: { port, channel: 'structured', errorType: 'ProviderAuthError' }, provider: 'xai' });
    const child = { event: { type: 'session.error', properties: { sessionID: 'ses_child', error: apiError(402) } }, parentSessionID: 'ses_1' };
    assert.equal(adapter.normalize(child, { hookKey: 'event' }).event.kind, 'worker.failed', "a child session's error is its worker's");
    const noProvider = failedMessage(apiError(402), { providerID: undefined });
    assert.equal(sessionAccessOf(harness, adapter.normalize(noProvider, { hookKey: 'event' }).event, noProvider, Date.now()), null, 'no provider, no signal');
  });
}

test('launcher: the signal rides in the envelope only when the endpoint is not redirected', async (t) => {
  const workspace = box(t);
  const send = async (harness, native, redirected) => {
    const fake = fakeSidecar();
    await runLauncher({ harness, event: null }, JSON.stringify(native), deps(fake.sidecar, workspace, redirected), Date.now());
    const envelope = fake.calls.find((call) => call.op === 'event')?.body.envelope;
    assert.ok(envelope, 'the event reaches the sidecar');
    assert.doesNotMatch(JSON.stringify(fake.calls), new RegExp(CANARY), 'no error text crosses to the sidecar');
    return envelope;
  };
  assert.deepEqual((await send('claude', stopFailure(), false)).payload.accessSignal, { port: 'claude', channel: 'structured', errorType: 'billing_error', text: { pattern: 'C5', weekly: false, family: null, resetAtMs: null, resetForm: null } });
  assert.equal((await send('claude', stopFailure(), true)).payload.accessSignal, undefined, 'guard 6');
  assert.equal((await send('claude', stopFailure(), undefined)).payload.accessSignal, undefined, 'no redirect check, no signal');
  const message = await send('kilo', failedMessage(apiError(402)), false);
  assert.deepEqual([message.kind, message.payload.errored, message.payload.accessSignal.status], ['message.completed', true, 402]);
});

test('guard 6: a redirected Claude endpoint or a project config that defines the provider sends nothing', async (t) => {
  const workspace = box(t);
  assert.equal(await endpointRedirected('claude', 'anthropic', workspace, {}), false);
  assert.equal(await endpointRedirected('claude', 'anthropic', workspace, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' }), true);
  for (const name of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_BEDROCK_MANTLE_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL', 'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_RESOURCE', 'ANTHROPIC_AWS_BASE_URL', 'ANTHROPIC_AWS_WORKSPACE_ID']) {
    assert.equal(await endpointRedirected('claude', 'anthropic', workspace, { [name]: '1' }), true, name);
  }
  assert.equal(await endpointRedirected('claude', 'anthropic', workspace, { CLAUDE_CODE_USE_POWERSHELL_TOOL: '1', ANTHROPIC_MODEL: 'x' }), false, 'a switch that picks no provider is not a redirect');
  mkdirSync(join(workspace, '.claude'));
  writeFileSync(join(workspace, '.claude', 'settings.local.json'), JSON.stringify({ apiKeyHelper: 'echo k' }));
  assert.equal(await endpointRedirected('claude', 'anthropic', workspace, {}), true, 'a workspace apiKeyHelper');
  writeFileSync(join(workspace, '.claude', 'settings.local.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } }));
  assert.equal(await endpointRedirected('claude', 'anthropic', workspace, {}), true, 'a workspace env base URL');
  writeFileSync(join(workspace, '.claude', 'settings.local.json'), JSON.stringify({ env: { CLAUDE_CODE_USE_VERTEX: '1' } }));
  assert.equal(await endpointRedirected('claude', 'anthropic', workspace, {}), true, 'a workspace provider switch');
  writeFileSync(join(workspace, '.claude', 'settings.local.json'), '{not json');
  assert.equal(await endpointRedirected('claude', 'anthropic', workspace, {}), true, 'doubt counts as redirected');
  assert.equal(await endpointRedirected('claude', 'anthropic', undefined, {}), true, 'no workspace');

  const project = join(workspace, 'project');
  mkdirSync(join(project, '.git'), { recursive: true });
  for (const harness of ['kilo', 'opencode']) assert.equal(await endpointRedirected(harness, 'anthropic', project, {}), false, harness);
  writeFileSync(join(project, 'opencode.json'), JSON.stringify({ provider: { anthropic: { options: { baseURL: 'http://127.0.0.1:9/v1' } } } }));
  for (const harness of ['kilo', 'opencode']) {
    assert.equal(await endpointRedirected(harness, 'anthropic', project, {}), true, `${harness}: the project redefines the provider`);
    assert.equal(await endpointRedirected(harness, 'xai', project, {}), false, `${harness}: another provider is untouched`);
  }
});

test('a StopFailure with the canary in its message and every free field classifies as credit-exhausted and keeps no canary (B, R69 follow-up)', async () => {
  const { classifyAccessSignal } = await import('@jevris/core');
  const native = {
    hook_event_name: 'StopFailure',
    session_id: 'ses_1',
    transcript_path: '/nowhere/ses_1.jsonl',
    cwd: '/work',
    error_type: 'billing_error',
    error_message: `Your credit balance is too low to access the Anthropic API. ${CANARY}`,
    last_assistant_message: `API Error: 402 ${CANARY}`,
    permission_mode: `${CANARY} mode`,
    model: `${CANARY} model`,
    agent_type: `${CANARY} agent`,
    extra_field: CANARY,
  };
  const normalized = claude.normalize(native);
  assert.equal(normalized.ok, true);
  const access = sessionAccessOf('claude', normalized.event, native, Date.now());
  const found = classifyAccessSignal({ ...access.signal, certified: true }, 'api-key', Date.now());
  assert.equal(found.class, 'credit-exhausted');
  assert.doesNotMatch(JSON.stringify({ event: normalized.event, access, found }), new RegExp(CANARY));
});

test('Kilo and OpenCode: a 429 carries the reset its response headers give, and no header value', () => {
  const now = Date.now();
  for (const [harness, adapter] of [['kilo', kilocode], ['opencode', opencode]]) {
    const native = failedMessage(apiError(429, { responseHeaders: { 'retry-after': '30', 'x-canary': CANARY } }));
    const access = sessionAccessOf(harness, adapter.normalize(native, { hookKey: 'event' }).event, native, now);
    assert.equal(access.signal.resetAtMs, now + 30_000, `${harness}: retry-after is read as a time`);
    assert.doesNotMatch(JSON.stringify(access), new RegExp(CANARY));
    const past = failedMessage(apiError(429, { responseHeaders: { 'retry-after': '0' } }));
    assert.equal(sessionAccessOf(harness, adapter.normalize(past, { hookKey: 'event' }).event, past, now).signal.resetAtMs, undefined, 'a reset that is not ahead is not sent');
  }
});

test('Antigravity: a Stop that ended on an error carries the pinned G pattern of its error, never the text; any other Stop carries nothing', async () => {
  const stop = (over = {}) => ({ conversationId: 'conv-1', modelName: 'gemini-3-pro', workspacePaths: ['/work'], executionNum: 1, fullyIdle: true, terminationReason: 'error', error: `Quota exceeded for this account; resets in 3h 10m ${CANARY}`, ...over });
  const now = Date.now();
  const native = stop();
  const normalized = antigravity.normalize(native);
  assert.equal(normalized.ok, true);
  assert.equal(normalized.event.kind, 'turn.stopped', 'the Stop stays turn.stopped');
  assert.equal(normalized.event.payload.errored, true, 'an error Stop carries the fixed errored flag');
  assert.doesNotMatch(JSON.stringify(normalized.event), new RegExp(CANARY), 'the adapter keeps no error text');
  const access = sessionAccessOf('agy', normalized.event, native, now);
  assert.equal(access.provider, 'google');
  assert.deepEqual([access.signal.port, access.signal.channel, access.signal.text.pattern], ['antigravity', 'error-text', 'G1']);
  assert.doesNotMatch(JSON.stringify(access), new RegExp(CANARY));
  for (const other of [stop({ terminationReason: 'model_stop' }), stop({ terminationReason: 'max_steps_exceeded' }), stop({ error: 'disk quota exceeded' }), stop({ error: undefined })]) {
    assert.equal(sessionAccessOf('agy', antigravity.normalize(other).event, other, now), null);
  }
  // The errored flag follows terminationReason alone: an error Stop with no readable error still has it.
  for (const [over, errored] of [[{ error: undefined }, true], [{ error: 'disk quota exceeded' }, true], [{ terminationReason: 'model_stop' }, undefined], [{ terminationReason: 'max_steps_exceeded' }, undefined]]) {
    assert.equal(antigravity.normalize(stop(over)).event.payload.errored, errored, JSON.stringify(over));
  }
  assert.equal(await endpointRedirected('agy', 'google', undefined, {}), false, 'Antigravity has no custom endpoint');
  assert.equal(await endpointRedirected('agy', 'anthropic', undefined, {}), true);
});

test('launcher: an Antigravity error Stop reaches the sidecar as turn.stopped with its signal, and no error text', async (t) => {
  const workspace = box(t);
  const fake = fakeSidecar();
  const native = { conversationId: 'conv-1', modelName: 'gemini-3-pro', workspacePaths: [workspace], executionNum: 1, fullyIdle: true, terminationReason: 'error', error: `Quota exceeded for this account ${CANARY}` };
  await runLauncher({ harness: 'agy', event: 'Stop' }, JSON.stringify(native), { ...deps(fake.sidecar, workspace, undefined), endpointRedirected: (harness, provider, where) => endpointRedirected(harness, provider, where, {}) }, Date.now());
  const envelope = fake.calls.find((call) => call.op === 'event')?.body.envelope;
  assert.ok(envelope, 'the event reaches the sidecar');
  assert.deepEqual([envelope.kind, envelope.payload.errored, envelope.payload.accessSignal.port, envelope.payload.accessSignal.text.pattern], ['turn.stopped', true, 'antigravity', 'G1']);
  assert.doesNotMatch(JSON.stringify(fake.calls), new RegExp(CANARY));
});

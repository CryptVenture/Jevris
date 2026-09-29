// Found-gone signals in the owned-worker streams (C's MODEL_UNAVAILABLE_SIGNALS and
// classifyModelUnavailable; F's harness classification and certify capture). Every run is a stub
// stream: no real harness binary is started, and the capture runs only with an injected runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const signals = await import('../dist/model-signals.js');
const capture = await import('../dist/model-signal-capture.js');
const { runClaudeWorker, claudeWorkerPort } = await import('../dist/claude-worker.js');
const { runCodexWorker } = await import('../dist/codex-worker.js');
const { runOpencodeWorker } = await import('../dist/opencode-worker.js');
const { runKiloWorker } = await import('../dist/kilo-worker.js');
const { runAntigravityWorker } = await import('../dist/antigravity-worker.js');
const { runAdminCommand } = await import('../dist/admin-cli.js');
const { formatCertify } = await import('../dist/certification.js');
const { MODEL_UNAVAILABLE_SIGNALS } = await import('@jevris/core');

// A stand-in harness: prints the scripted JSON lines ("$CWD" becomes its cwd), then stderr and the exit code.
const STUB = `
import { readFileSync } from 'node:fs';
const script = JSON.parse(readFileSync(process.env.MS_STUB_SCRIPT, 'utf8'));
process.stdin.resume();
process.stdin.on('end', () => {
  for (const line of script.lines ?? []) process.stdout.write(JSON.stringify(line).replaceAll('"$CWD"', JSON.stringify(process.cwd())) + '\\n');
  if (script.stderr) process.stderr.write(script.stderr);
  process.exitCode = script.exitCode ?? 0;
});
`;

function box(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-model-signals-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stub = join(dir, 'stub.mjs');
  writeFileSync(stub, STUB);
  const work = join(dir, 'work');
  mkdirSync(work);
  return { dir, stub, work, home: join(dir, 'home') };
}

function stubbed(b, script) {
  const file = join(b.dir, `script-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(script));
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string' && !/API_KEY|AUTH_TOKEN|OAUTH_TOKEN|^OPENCODE_|^KILO_|BASE_URL|CLAUDE_CODE_USE_/.test(key)) env[key] = value;
  // The Codex home is the sandbox's: the Codex port reads its config.toml for a custom provider (OP-12).
  return { command: { file: process.execPath, args: [b.stub] }, env: { ...env, CODEX_HOME: join(b.dir, 'codex-home'), MS_STUB_SCRIPT: file } };
}

const input = (b, model, extra = {}) => ({ prompt: 'Reply with OK.', model, cwd: b.work, allowedTools: [], maxTurns: 1, maxBudgetUsd: 0.05, timeoutMs: 20_000, ...extra });

const CLAUDE_TEXT = "There's an issue with the selected model (claude-nonexistent-0). It may not exist or you may not have access to it. Run /model to pick a different model.";
const claudeLines = (text, apiKeySource = 'none') => [
  { type: 'system', subtype: 'init', session_id: 's-1', cwd: '$CWD', model: 'claude-nonexistent-0', permissionMode: 'default', tools: [], apiKeySource },
  { type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text }] }, session_id: 's-1' },
  { type: 'result', subtype: 'success', is_error: true, result: text, session_id: 's-1', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } },
];
const CODEX_404 = 'unexpected status 404 Not Found: {"error":{"message":"The model `gpt-nonexistent-0` does not exist or you do not have access to it.","type":"invalid_request_error","code":"model_not_found"}}';
const CODEX_ACCOUNT = "{\"detail\":\"The 'gpt-5.9-pro' model is not supported when using Codex with a ChatGPT account.\"}";
const codexLines = (message) => [
  { type: 'thread.started', thread_id: 't-1' },
  { type: 'turn.started' },
  { type: 'error', message },
  { type: 'turn.failed', error: { message } },
];
const ocNotFound = { type: 'error', timestamp: 1, sessionID: 'ses_1', error: { name: 'ProviderModelNotFoundError', data: { providerID: 'openai', modelID: 'gpt-nonexistent-0', suggestions: [] } } };

test('C row table: every F detector returns a signal id C knows for that port', () => {
  const known = (port, id) => MODEL_UNAVAILABLE_SIGNALS.some((row) => row.port === port && row.signal === id);
  assert.ok(known('claude', signals.claudeModelSignal(true, CLAUDE_TEXT)));
  assert.ok(known('codex', signals.codexModelSignal(CODEX_404)));
  assert.ok(known('codex', signals.codexModelSignal(CODEX_ACCOUNT)));
  assert.ok(known('opencode', signals.opencodeEventModelSignal(ocNotFound.error)));
  assert.ok(known('kilocode', signals.opencodeStderrModelSignal('Error: ProviderModelNotFoundError', 'openai/x')));
  assert.ok(known('antigravity', signals.antigravityModelSignal('unknown model: gemini-nonexistent-0')));
});

test('detectors: only the found-gone message matches; an ordinary failure, a limit or a success does not', () => {
  assert.equal(signals.claudeModelSignal(false, CLAUDE_TEXT), null, 'not an error result');
  assert.equal(signals.claudeModelSignal(true, 'API Error: 500 overloaded'), null);
  assert.equal(signals.claudeModelSignal(true, "There's an issue with the selected model."), null, 'both halves of the message are needed');
  assert.equal(signals.codexModelSignal("You've hit your usage limit."), null);
  assert.equal(signals.codexModelSignal(CODEX_ACCOUNT), 'model-not-supported-for-account');
  assert.equal(signals.opencodeEventModelSignal({ name: 'ProviderAuthError', data: {} }), null);
  assert.equal(signals.opencodeEventModelSignal('ProviderModelNotFoundError'), null, 'a bare string is not the structured error');
  assert.equal(signals.opencodeStderrModelSignal('Error: Model not found: openai/gpt-nonexistent-0', 'openai/gpt-nonexistent-0'), 'provider-model-not-found');
  assert.equal(signals.opencodeStderrModelSignal('Error: Model not found: openai/other', 'openai/gpt-nonexistent-0'), null, 'another model on stderr is not this run');
  assert.equal(signals.antigravityModelSignal('quota exhausted'), null);
});

test('eventShape keeps key names only, three levels deep, and never a value', () => {
  const shape = signals.eventShape({ type: 'result', is_error: true, result: 'secret text about account@example', usage: { input_tokens: 1, nested: { deeper: { deepest: 1 } } }, 'a key with spaces': 1 });
  assert.deepEqual(shape, ['is_error', 'result', 'type', 'usage', 'usage.input_tokens', 'usage.nested', 'usage.nested.deeper']);
  assert.ok(!JSON.stringify(shape).includes('secret'));
});

test('claude: the text-matched signal is reported but unused until certified; certified, the run is model-unavailable with C reason, port and auth', async (t) => {
  const b = box(t);
  const plain = await runClaudeWorker({ ...input(b, 'claude-nonexistent-0'), ...stubbed(b, { lines: claudeLines(CLAUDE_TEXT) }) });
  assert.equal(plain.status, 'failed');
  assert.equal(plain.modelSignal?.id, 'selected-model-issue');
  assert.equal(plain.modelSignal?.channel, 'event');
  assert.ok(plain.modelSignal?.shape.includes('is_error'));
  assert.equal(plain.modelUnavailable, undefined);

  const certified = await runClaudeWorker({ ...input(b, 'claude-nonexistent-0', { certifiedModelSignals: ['selected-model-issue'] }), ...stubbed(b, { lines: claudeLines(CLAUDE_TEXT) }) });
  assert.equal(certified.status, 'model-unavailable');
  assert.deepEqual(certified.modelUnavailable, { reasonCode: 'MODEL_NOT_ACCESSIBLE', port: 'claude', authMode: 'subscription' });
  assert.match(certified.reason, /claude-nonexistent-0 is not available here \(MODEL_NOT_ACCESSIBLE via claude\)/);
  assert.ok(!certified.reason.includes('/model'), "the harness's own text is never the reason");

  const apiKey = await runClaudeWorker({ ...input(b, 'claude-nonexistent-0', { certifiedModelSignals: ['selected-model-issue'] }), ...stubbed(b, { lines: claudeLines(CLAUDE_TEXT, 'ANTHROPIC_API_KEY') }) });
  assert.equal(apiKey.modelUnavailable?.authMode, 'api-key');

  const other = await runClaudeWorker({ ...input(b, 'claude-nonexistent-0', { certifiedModelSignals: ['selected-model-issue'] }), ...stubbed(b, { lines: claudeLines('API Error: 500') }) });
  assert.equal(other.status, 'failed');
  assert.equal(other.modelSignal, null);
});

test('codex: model_not_found and the ChatGPT-account refusal count only when certified; a usage limit still wins', async (t) => {
  const b = box(t);
  const plain = await runCodexWorker({ ...input(b, 'gpt-nonexistent-0'), ...stubbed(b, { lines: codexLines(CODEX_404), exitCode: 1 }) });
  assert.equal(plain.status, 'failed');
  assert.equal(plain.modelSignal?.id, 'model-not-found');
  assert.equal(plain.modelUnavailable, undefined);

  const certified = await runCodexWorker({ ...input(b, 'gpt-nonexistent-0', { certifiedModelSignals: ['model-not-found'], auth: undefined }), ...stubbed(b, { lines: codexLines(CODEX_404), exitCode: 1 }) });
  assert.equal(certified.status, 'model-unavailable');
  assert.deepEqual(certified.modelUnavailable, { reasonCode: 'MODEL_NOT_ACCESSIBLE', port: 'codex', authMode: 'unknown' });

  const account = await runCodexWorker({ ...input(b, 'gpt-5.9-pro', { certifiedModelSignals: ['model-not-supported-for-account'] }), ...stubbed(b, { lines: codexLines(CODEX_ACCOUNT), exitCode: 1 }) });
  assert.equal(account.status, 'model-unavailable');
  assert.equal(account.modelSignal?.id, 'model-not-supported-for-account');

  const wrongCert = await runCodexWorker({ ...input(b, 'gpt-5.9-pro', { certifiedModelSignals: ['model-not-found'] }), ...stubbed(b, { lines: codexLines(CODEX_ACCOUNT), exitCode: 1 }) });
  assert.equal(wrongCert.status, 'failed', 'a capture certifies the exact signal it saw, not every row of the port');

  const limit = await runCodexWorker({ ...input(b, 'gpt-nonexistent-0', { certifiedModelSignals: ['model-not-found'] }), ...stubbed(b, { lines: codexLines("You've hit your usage limit. model_not_found"), exitCode: 1 }) });
  assert.equal(limit.status, 'access-limit', 'an access limit ranks before model availability');
});

test('opencode and kilo: ProviderModelNotFoundError is structured, MODEL_NOT_ACCESSIBLE (scoped to the harness and sign-in) with no capture, from the error event or from stderr', async (t) => {
  const b = box(t);
  const event = await runOpencodeWorker({ ...input(b, 'openai/gpt-nonexistent-0'), ...stubbed(b, { lines: [ocNotFound], exitCode: 1 }) });
  assert.equal(event.status, 'model-unavailable');
  assert.deepEqual(event.modelUnavailable, { reasonCode: 'MODEL_NOT_ACCESSIBLE', port: 'opencode', authMode: 'unknown' });
  assert.equal(event.modelSignal?.channel, 'event');
  assert.ok(event.modelSignal?.shape.includes('error.name'));

  const kilo = await runKiloWorker({ ...input(b, 'openai/gpt-nonexistent-0', { auth: 'subscription' }), ...stubbed(b, { lines: [ocNotFound], exitCode: 1 }) });
  assert.equal(kilo.status, 'model-unavailable');
  assert.deepEqual(kilo.modelUnavailable, { reasonCode: 'MODEL_NOT_ACCESSIBLE', port: 'kilocode', authMode: 'subscription' }, "C's port id for Kilo is kilocode");

  const stderr = await runOpencodeWorker({ ...input(b, 'openai/gpt-nonexistent-0'), ...stubbed(b, { lines: [], stderr: 'Error: Model not found: openai/gpt-nonexistent-0\nTry: `opencode models`\n', exitCode: 1 }) });
  assert.equal(stderr.status, 'model-unavailable');
  assert.deepEqual(stderr.modelSignal, { id: 'provider-model-not-found', channel: 'stderr', shape: [] });

  const named = await runKiloWorker({ ...input(b, 'openai/gpt-nonexistent-0'), ...stubbed(b, { lines: [], stderr: 'ProviderModelNotFoundError: gpt-nonexistent-0\n', exitCode: 1 }) });
  assert.equal(named.status, 'model-unavailable');
  assert.equal(named.modelUnavailable?.port, 'kilocode');

  const completed = await runOpencodeWorker({
    ...input(b, 'openai/gpt-5.5'),
    ...stubbed(b, { lines: [{ type: 'step_start', sessionID: 'ses_1', part: { type: 'step-start', id: 'p1' } }, { type: 'step_finish', sessionID: 'ses_1', part: { type: 'step-finish', id: 'p2', cost: 0 } }], stderr: 'warning: ProviderModelNotFoundError for another provider\n' }),
  });
  assert.equal(completed.status, 'completed', 'a completed run is never re-read from stderr');
  assert.equal(completed.modelSignal, null);
});

test('antigravity: an unknown-model ERROR result counts only from a binary whose capture saw it, as MODEL_NOT_ACCESSIBLE (G12)', async (t) => {
  const b = box(t);
  const lines = [
    { event: 'init', conversation_id: 'c-1', init: { model: 'gemini-nonexistent-0', permission_mode: 'request-review', cwd: '$CWD' } },
    { event: 'result', result: { status: 'ERROR', error: 'unknown model: gemini-nonexistent-0', conversation_id: 'c-1' } },
  ];
  const out = await runAntigravityWorker({ ...input(b, 'gemini-nonexistent-0', { certifiedModelSignals: ['unknown-model'] }), ...stubbed(b, { lines, exitCode: 1 }) });
  assert.equal(out.status, 'model-unavailable');
  assert.equal(out.modelSignal?.id, 'unknown-model');
  assert.equal(out.modelUnavailable?.reasonCode, 'MODEL_NOT_ACCESSIBLE');
  // Paired: without a capture it is reported, never recorded.
  const uncertified = await runAntigravityWorker({ ...input(b, 'gemini-nonexistent-0'), ...stubbed(b, { lines, exitCode: 1 }) });
  assert.equal(uncertified.status, 'failed');
  assert.equal(uncertified.modelSignal?.id, 'unknown-model');
  assert.equal(uncertified.modelUnavailable, undefined);
});

test('the port reads certified signals from the capture for the probed version only', async (t) => {
  const b = box(t);
  const writeCapture = (version) => {
    const file = signals.modelSignalsFile(b.home, 'claude');
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify({ schema: signals.MODEL_SIGNALS_SCHEMA, harness: 'claude', version, capturedAt: '2026-09-27T00:00:00.000Z', probeModel: 'claude-nonexistent-0', status: 'failed', signal: { id: 'selected-model-issue', channel: 'event', shape: ['is_error'] } }));
  };
  assert.deepEqual(await signals.certifiedModelSignals(b.home, 'claude', '2.1.300'), [], 'no capture');
  writeCapture('2.1.300');
  assert.deepEqual(await signals.certifiedModelSignals(b.home, 'claude', '2.1.300'), ['selected-model-issue']);
  assert.deepEqual(await signals.certifiedModelSignals(b.home, 'claude', '2.1.301'), [], 'another version is not certified');
  assert.deepEqual(await signals.certifiedModelSignals(b.home, 'claude', null), []);

  const port = (version) => claudeWorkerPort({ ...stubbed(b, { lines: claudeLines(CLAUDE_TEXT) }), evidence: { home: b.home, root: b.dir, version: async () => version, reverify: async () => undefined } });
  assert.equal((await port('2.1.300').run(input(b, 'claude-nonexistent-0'))).status, 'model-unavailable');
  assert.equal((await port('2.1.301').run(input(b, 'claude-nonexistent-0'))).status, 'failed');
  const stub = claudeWorkerPort(stubbed(b, { lines: claudeLines(CLAUDE_TEXT) }));
  assert.equal((await stub.run(input(b, 'claude-nonexistent-0'))).status, 'failed', 'an injected binary reads no capture');
});

test('certify rows: the text-matched rows stay unused and the OpenCode/Kilo channel unverified until a capture at this version', () => {
  assert.match(capture.modelSignalRows('claude', null, '2.1.300').join('\n'), /selected-model-issue: MODEL_NOT_ACCESSIBLE, text-matched: unused until a capture/);
  assert.match(capture.modelSignalRows('opencode', null, '1.4.0').join('\n'), /provider-model-not-found: MODEL_NOT_ACCESSIBLE, structured; unverified: accepted as a stream error event and on stderr/);
  assert.match(capture.modelSignalRows('kilocode', null, '7.7.9').join('\n'), /provider-model-not-found: MODEL_NOT_ACCESSIBLE, structured; unverified/);
  assert.match(capture.modelSignalRows('antigravity', null, '1.0.0').join('\n'), /unknown-model: MODEL_NOT_ACCESSIBLE, text-matched: unused until a capture at this version confirms it/);
  const seen = { schema: signals.MODEL_SIGNALS_SCHEMA, harness: 'codex', version: '0.160.0', capturedAt: 'x', probeModel: 'gpt-nonexistent-0', status: 'failed', signal: { id: 'model-not-found', channel: 'event', shape: [] } };
  const rows = capture.modelSignalRows('codex', seen, '0.160.0').join('\n');
  assert.match(rows, /model-not-found: MODEL_NOT_ACCESSIBLE, confirmed by the capture at 0\.160\.0 \(stream event\)/);
  assert.match(rows, /model-not-supported-for-account: not seen by the capture at 0\.160\.0 \(status failed\); stays unused/);
  assert.match(capture.modelSignalRows('codex', seen, '0.161.0').join('\n'), /model-not-found: MODEL_NOT_ACCESSIBLE, text-matched: unused/, 'a capture at another version counts for nothing');
  const text = formatCertify({ ok: true, harness: 'claude', harnessVersion: '2.1.300', features: [], cases: [], record: null, evidence: [], error: null, modelSignals: ['model signal selected-model-issue: x', 'model-signal capture: not run by certify; launches: claude -p'] });
  assert.match(text, /\n {2}model-signal capture: not run by certify/);
});

test('capture cases: each names the exact argv from its port, a nonexistent model, no bypass, one turn and a small cap', () => {
  for (const [harness, item] of Object.entries(capture.MODEL_SIGNAL_CASES)) {
    assert.match(item.probeModel, /nonexistent-0$/, harness);
    assert.ok(item.launches.includes(item.probeModel), harness);
    assert.match(item.launches, /your own sign-in and settings, in <empty temporary folder>/, harness);
    assert.doesNotMatch(item.launches, /dangerously|bypass|--yolo/i, harness);
  }
  const claudeArgv = capture.probeArgv('claude', 'claude-nonexistent-0');
  assert.deepEqual(claudeArgv.slice(0, 2), ['claude', '-p']);
  assert.ok(claudeArgv.join(' ').includes('--max-turns 1 --max-budget-usd 0.05'));
  assert.ok(capture.probeArgv('codex', 'gpt-nonexistent-0').join(' ').includes('--sandbox read-only'));
  assert.equal(capture.probeArgv('kilocode', 'openai/gpt-nonexistent-0')[0], 'kilo');
});

test('capture: an injected runner is recorded (signal, channel, key names; never text); a refused probe records nothing', async (t) => {
  const b = box(t);
  let seen = null;
  const runner = async (probe) => {
    seen = probe;
    return { status: 'failed', modelSignal: { id: 'selected-model-issue', channel: 'event', shape: ['is_error', 'result', 'type'] }, reason: CLAUDE_TEXT };
  };
  const result = await capture.captureModelSignals({ home: b.home, harness: 'claude', runner, version: async () => '2.1.300', nowMs: Date.UTC(2026, 8, 27) });
  assert.equal(result.error, null);
  assert.deepEqual({ model: seen.model, tools: seen.allowedTools, turns: seen.maxTurns, budget: seen.maxBudgetUsd }, { model: 'claude-nonexistent-0', tools: [], turns: 1, budget: 0.05 });
  assert.ok(!existsSync(seen.cwd), 'the temporary folder is removed');
  const record = JSON.parse(readFileSync(result.record, 'utf8'));
  assert.deepEqual(record, { schema: 'jevris-model-signals-1', harness: 'claude', version: '2.1.300', capturedAt: '2026-09-27T00:00:00.000Z', probeModel: 'claude-nonexistent-0', status: 'failed', signal: { id: 'selected-model-issue', channel: 'event', shape: ['is_error', 'result', 'type'] } });
  assert.ok(!readFileSync(result.record, 'utf8').includes('/model'), 'no message text is kept');
  assert.deepEqual(await signals.certifiedModelSignals(b.home, 'claude', '2.1.300'), ['selected-model-issue']);
  const text = capture.formatCapture(result);
  assert.match(text, /captured \(version 2\.1\.300\)/);
  assert.match(text, /launches: claude -p /);
  assert.match(text, /selected-model-issue: MODEL_NOT_ACCESSIBLE, confirmed by the capture at 2\.1\.300/);

  const refused = await capture.captureModelSignals({ home: b.home, harness: 'claude', runner: async () => ({ status: 'refused', modelSignal: null }), version: async () => '2.1.300' });
  assert.equal(refused.record, null);
  assert.match(refused.error, /nothing recorded: the probe ended refused/);
  assert.deepEqual(await signals.certifiedModelSignals(b.home, 'claude', '2.1.300'), ['selected-model-issue'], 'the earlier capture stays');
});

test('jevris certify --model-signals never starts a real harness in a test run, and says what it would launch', async (t) => {
  const b = box(t);
  const cli = { available: (bin) => bin === 'claude', run: async () => ({ spawned: false, code: null, stdout: '', stderr: '' }) };
  let out = '';
  const code = await runAdminCommand(['certify', '--harness', 'all', '--model-signals', '--home', b.home], (chunk) => (out += chunk), { isTTY: false, harnessCli: cli });
  assert.equal(code, 1);
  assert.match(out, /jevris certify --model-signals claude: starting claude -p .*--model claude-nonexistent-0/);
  assert.match(out, /disabled in a test run/);
  assert.doesNotMatch(out, /codex|opencode/, 'only a harness on PATH is a target');
  assert.ok(!existsSync(signals.modelSignalsFile(b.home, 'claude')));

  let help = '';
  await runAdminCommand(['certify', '--help'], (chunk) => (help += chunk), { isTTY: false });
  assert.match(help, /--model-signals/);
  assert.match(help, /A harness should refuse an unknown model before any billed work,\s+but that is not guaranteed/);
});

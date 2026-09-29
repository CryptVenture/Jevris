// Harness parity audit G19: quality trials on Codex, Antigravity, Kilo and OpenCode run on the
// owned-worker ports, so a trial run is held to the owned worker's tool denial and credential
// stripping. The ports are faked or run against a stub script; never a real harness binary, no
// model call, no real HOME.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runners = await import('../dist/trial-runners.js');
const { ARM_PLANS, TRIAL_HARNESSES, parseTrialConfig } = await import('../dist/trial-driver.js');
const { BUNDLED_MODEL_REGISTRY } = await import('@jevris/core');
const { registryRefOf } = await import('../dist/harness-model.js');

const OWNED = ['codex', 'antigravity', 'kilocode', 'opencode'];

function runInput(cwd, env, extra = {}) {
  return { prompt: 'fix it', model: 'm', cwd, home: cwd, env, allowedTools: ['Read', 'Edit'], maxTurns: 3, maxBudgetUsd: 1, timeoutMs: 20_000, extraArgs: [], signal: new AbortController().signal, plugin: null, shellTool: null, ...extra };
}

function fakePort(outcome) {
  const seen = [];
  const run = async (input) => {
    seen.push(input);
    return { status: 'completed', reason: 'ok', costUsd: 0.5, usage: { inputTokens: 40, outputTokens: 8, cacheReadInputTokens: 5, cacheCreationInputTokens: 2 }, actualModel: 'm', authMode: 'api-key', ...outcome };
  };
  return { run, seen };
}

test('a trial config names codex and antigravity as harnesses; runnerFor puts the four on owned ports and keeps claude on the CLI runner', () => {
  for (const harness of OWNED) {
    assert.ok(TRIAL_HARNESSES.includes(harness));
    assert.equal(runners.runnerFor(harness, {}).harness, harness);
  }
  assert.equal(runners.runnerFor('claude', {}).harness, 'claude');
  const parsed = parseTrialConfig({ schema: 'jevris.trial-config/1', harness: 'codex', tasks: [] });
  assert.ok(!(parsed.problems ?? []).some((p) => p.startsWith('harness must be')), JSON.stringify(parsed));
});

test('an owned trial runner refuses log reduction, and without a test seam needs the live flag', () => {
  for (const harness of OWNED) {
    const live = runners.ownedRunner(harness, { env: {} });
    assert.match(live.unsupported(ARM_PLANS.native), /JEVRIS_LIVE_HARNESS=1/);
    assert.equal(runners.ownedRunner(harness, { env: { JEVRIS_LIVE_HARNESS: '1' } }).unsupported(ARM_PLANS.native), null);
    const seam = runners.ownedRunner(harness, { command: { file: '/nonexistent/stub' }, env: {} });
    assert.equal(seam.unsupported(ARM_PLANS.native), null);
    assert.match(seam.unsupported(ARM_PLANS['log-reduction-only']), /log reduction runs with the claude-sdk runner/);
  }
});

test('an owned trial run passes the trial bounds, the tools and the registry to the port, and maps its outcome', async () => {
  const port = fakePort({});
  const registry = BUNDLED_MODEL_REGISTRY;
  const runner = runners.ownedRunner('codex', { run: port.run, command: { file: '/stub/codex' }, registry });
  const report = await runner.run(runInput('/work', { OPENAI_API_KEY: 'test-key' }));
  const input = port.seen[0];
  assert.equal(input.prompt, 'fix it');
  assert.deepEqual(input.allowedTools, ['Read', 'Edit']);
  assert.equal(input.maxTurns, 3);
  assert.equal(input.maxBudgetUsd, 1);
  assert.equal(input.timeoutMs, 20_000);
  assert.equal(input.auth, 'api-key', 'a vendor key in the run environment means api-key');
  assert.deepEqual(input.command, { file: '/stub/codex' });
  assert.equal(input.registry, registry);
  assert.deepEqual(report, { status: 'completed', reason: 'ok', inputTokens: 40, outputTokens: 8, cacheTokens: 7, costUsd: 0.5, retries: null, actualModel: 'm', authMode: 'api-key' });

  const codexLogin = fakePort({ authMode: 'subscription' });
  const onLogin = await runners.ownedRunner('codex', { run: codexLogin.run }).run(runInput('/work', {}));
  assert.equal(codexLogin.seen[0].auth, 'subscription');
  assert.equal(onLogin.costUsd, null, 'a subscription run leaves the dollar estimate to the driver');
  assert.equal(onLogin.authMode, 'subscription');

  const agy = fakePort({ status: 'usage-limit', reason: 'WORKER_USAGE_LIMIT', usage: null, authMode: 'unknown', costUsd: null });
  const limited = await runners.ownedRunner('antigravity', { run: agy.run }).run(runInput('/work', { GEMINI_API_KEY: 'test-key' }));
  assert.equal(agy.seen[0].auth, 'subscription', 'Antigravity runs on its Google login only');
  assert.equal(limited.status, 'failed');
  assert.equal(limited.reason, 'usage-limit: WORKER_USAGE_LIMIT');
  assert.equal(limited.inputTokens, 0);
  assert.equal('authMode' in limited, false);
});

test('OpenCode and Kilo trials take the auth mode from the model provider key', async () => {
  const model = BUNDLED_MODEL_REGISTRY.entries.map((e) => e.modelId).find((id) => registryRefOf(BUNDLED_MODEL_REGISTRY, 'opencode', id)?.provider === 'xai');
  assert.ok(model, 'the bundled registry places an xAI model on OpenCode');
  for (const harness of ['opencode', 'kilocode']) {
    const port = fakePort({});
    const runner = runners.ownedRunner(harness, { run: port.run });
    await runner.run(runInput('/work', { XAI_API_KEY: 'test-key' }, { model }));
    await runner.run(runInput('/work', { OPENAI_API_KEY: 'test-key' }, { model }));
    await runner.run(runInput('/work', { XAI_API_KEY: 'test-key' }, { model: 'not-a-registry-model' }));
    const expected = registryRefOf(BUNDLED_MODEL_REGISTRY, harness, model) === null ? 'subscription' : 'api-key';
    assert.deepEqual(port.seen.map((i) => i.auth), [expected, 'subscription', 'subscription'], harness);
  }
});

// A stand-in for `opencode run --format json`: logs argv and which key variables it can see
// (names only), then prints one completed step.
const STUB = `
import { appendFileSync } from 'node:fs';
const KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (stdin += c));
process.stdin.on('end', () => {
  appendFileSync(process.env.OC_STUB_LOG, JSON.stringify({ argv: process.argv.slice(2), stdin, seen: KEYS.filter((k) => (process.env[k] ?? '') !== '') }) + '\\n');
  const sid = 'ses_0123';
  process.stdout.write(JSON.stringify({ type: 'step_start', timestamp: 1, sessionID: sid, part: { type: 'step-start' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'text', timestamp: 2, sessionID: sid, part: { type: 'text', text: 'Fixed.' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'step_finish', timestamp: 3, sessionID: sid, part: { type: 'step-finish', reason: 'stop', cost: 0.01, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 7, write: 3 } } } }) + '\\n');
});
`;

test('an OpenCode trial runs on the owned port against a stub: the prompt on stdin, the Jevris agent, provider keys only on an api-key run', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-trial-owned-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stub = join(dir, 'oc-stub.mjs');
  writeFileSync(stub, STUB);
  const work = join(dir, 'work');
  mkdirSync(work);
  const log = join(dir, 'calls.log');
  const model = BUNDLED_MODEL_REGISTRY.entries.map((e) => e.modelId).find((id) => registryRefOf(BUNDLED_MODEL_REGISTRY, 'opencode', id)?.provider === 'xai');
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string' && !/API_KEY|AUTH_TOKEN|OAUTH_TOKEN|^OPENCODE_|^KILO_/.test(key)) env[key] = value;
  const runner = runners.ownedRunner('opencode', { command: { file: process.execPath, args: [stub] } });
  const report = await runner.run(runInput(work, { ...env, OC_STUB_LOG: log, XAI_API_KEY: 'test-key', ANTHROPIC_API_KEY: 'other-key' }, { model }));
  assert.equal(report.status, 'completed', report.reason);
  assert.equal(report.inputTokens, 100);
  assert.equal(report.outputTokens, 25, 'reasoning tokens count as output');
  assert.equal(report.cacheTokens, 10);
  assert.equal(report.authMode, 'api-key');
  assert.ok(existsSync(log));
  const call = JSON.parse(readFileSync(log, 'utf8').trim().split('\n')[0]);
  assert.match(call.stdin, /fix it/);
  assert.ok(call.argv.includes('jevris-worker'), JSON.stringify(call.argv));
  assert.ok(call.seen.includes('XAI_API_KEY'));

  // No key for the model's provider: the run is on the OpenCode login and every provider key is stripped.
  const onLogin = await runner.run(runInput(work, { ...env, OC_STUB_LOG: log, ANTHROPIC_API_KEY: 'other-key', OPENAI_API_KEY: 'other-key' }, { model }));
  assert.equal(onLogin.status, 'completed', onLogin.reason);
  assert.equal(onLogin.authMode, 'subscription');
  assert.equal(onLogin.costUsd, null);
  const second = JSON.parse(readFileSync(log, 'utf8').trim().split('\n')[1]);
  assert.deepEqual(second.seen, [], 'a login run sees no provider key');
});

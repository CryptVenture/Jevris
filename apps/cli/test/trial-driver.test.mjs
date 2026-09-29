// The product HarnessDriver for C's runTrial (EVL-05, RLS-08, RLS-09). Every harness here is a
// stub: the Agent SDK query is a fake message stream through D's real runOwnedWorker, the CLI
// harness is a stub script, and Jevris calls are injected. Checks run real commands (node) in the
// sandbox. No harness binary, no model call, no real HOME.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const driverMod = await import('../dist/trial-driver.js');
const runners = await import('../dist/trial-runners.js');
const { productJevris, productTrialDriver, trialEnv } = await import('../dist/trial-jevris.js');
const worker = await import('@jevris/adapter-claude-sdk');
const evals = await import('../../../packages/evals/dist/index.js');

const { ARM_PLANS, createTrialDriver, parseTrialConfig, unsupportedArms, missingTaskSpecs } = driverMod;
const REQUIRED = ['native', 'static', 'rules-only', 'jev-routed', 'routing-only', 'memory-only', 'log-reduction-only', 'combined'];
const LIVE_ENV = { JEVRIS_LIVE_HARNESS: '1', JEVRIS_LIVE_JEV: '1', ANTHROPIC_API_KEY: 'test-key' };

function config(overrides = {}) {
  const parsed = parseTrialConfig({
    schema: 'jevris.trial-config/1',
    harness: 'claude-sdk',
    defaultModel: 'claude-sonnet-5',
    staticModels: { easy: 'claude-haiku-5', medium: 'claude-sonnet-5', hard: 'claude-opus-5' },
    allowedTools: ['Read', 'Edit', 'Bash'],
    maxTurns: 20,
    maxBudgetUsd: 2,
    runTimeoutMs: 60_000,
    checkTimeoutMs: 30_000,
    prices: { 'claude-sonnet-5': { inputPerMTokUsd: 3, outputPerMTokUsd: 15 }, 'claude-opus-5': { inputPerMTokUsd: 5, outputPerMTokUsd: 25 } },
    tasks: [
      {
        taskId: 'fix-sum',
        prompt: 'Make sum.mjs add its arguments.',
        constraints: ['Do not edit the test'],
        checks: [
          { id: 'test', argv: [process.execPath, 'check.mjs'] },
          { id: 'syntax', argv: [process.execPath, '--check', 'sum.mjs'] },
        ],
      },
    ],
    ...overrides,
  });
  assert.equal(parsed.ok, true, JSON.stringify(parsed.problems));
  return parsed.config;
}

const TASK = { taskId: 'fix-sum', repository: 'fixture', sliceId: 'js', difficulty: 'hard' };

async function sandboxes(base) {
  return {
    async create() {
      const path = await mkdtemp(join(base, 'sandbox-'));
      await writeFile(join(path, 'sum.mjs'), 'export const sum = (a, b) => a - b;\n');
      await writeFile(join(path, 'check.mjs'), "import { sum } from './sum.mjs';\nprocess.exit(sum(2, 3) === 5 ? 0 : 1);\n");
      return { path, dispose: () => rm(path, { recursive: true, force: true }) };
    },
  };
}

/** A fake Agent SDK query: fixes the file (unless told not to), then reports usage and cost. */
function fakeQuery(calls, options = {}) {
  return (args) => {
    calls.push(args);
    const controller = args.options.abortController;
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'sess-1', model: args.options.model };
        if (options.retry) yield { type: 'system', subtype: 'api_retry', session_id: 'sess-1' };
        if (options.hang) {
          const aborted = new Promise((resolve) => controller.signal.addEventListener('abort', resolve, { once: true }));
          // The session is under way (the retry is counted): the caller may abort now, whatever the load.
          options.onHang?.();
          await aborted;
          throw new Error('aborted');
        }
        if (options.fix !== false) writeFileSync(join(args.options.cwd, 'sum.mjs'), 'export const sum = (a, b) => a + b;\n');
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'sess-1',
          total_cost_usd: 0.0123,
          num_turns: 3,
          usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 },
          modelUsage: { [args.options.model]: { costUSD: 0.0123, inputTokens: 1200, outputTokens: 300 } },
        };
      },
      close() {},
    };
  };
}

function stubJevris(seedRoot, log) {
  return {
    async prepare(input) {
      log.push(['prepare', input.product, input.decisions]);
      const seed = await mkdtemp(join(seedRoot, 'seed-'));
      if (input.product) await mkdir(join(seed, 'plugin'), { recursive: true });
      return { ok: true, prepared: { seed, pluginRel: input.product ? 'plugin' : null } };
    },
    env: (home, decisions) => ({ PATH: process.env.PATH ?? '', HOME: home, DECISIONS: decisions }),
    async route(input) {
      log.push(['route', input.decisions, input.currentModel]);
      return 'claude-opus-5';
    },
    async capsule(input) {
      log.push(['capsule', input.taskId, input.constraints.join('|')]);
      return 'Jevris memory capsule for this task:\n- constraint: Do not edit the test';
    },
    shellTool() {
      return { run: async (command) => `distilled: ${command}` };
    },
  };
}

test('parseTrialConfig lists every problem and accepts a complete config', () => {
  const bad = parseTrialConfig({ schema: 'x', harness: 'vim', tasks: [{ taskId: 'a', prompt: '', checks: [] }] });
  assert.equal(bad.ok, false);
  for (const needle of ['schema', 'harness', 'defaultModel', 'staticModels', 'allowedTools', 'maxTurns', 'prices', 'tasks[0].prompt', 'tasks[0].checks']) {
    assert.ok(bad.problems.some((p) => p.includes(needle)), `a problem names ${needle}: ${bad.problems.join('; ')}`);
  }
  const dup = parseTrialConfig({ ...config(), tasks: [...config().tasks, ...config().tasks] });
  assert.equal(dup.ok, false);
  assert.ok(dup.problems.some((p) => p.includes('listed twice')));
  assert.equal(config().tasks[0].checks.length, 2);
  assert.deepEqual(missingTaskSpecs([TASK, { taskId: 'other' }], config()), ['other']);
});

test('arm plans: native and static carry no Jevris, the ablations one component each, combined all three', () => {
  assert.deepEqual(ARM_PLANS.native, { product: false, decisions: 'none', model: 'default', components: [] });
  assert.equal(ARM_PLANS.static.model, 'static');
  assert.equal(ARM_PLANS['rules-only'].product, true);
  assert.equal(ARM_PLANS['rules-only'].decisions, 'rules');
  assert.equal(ARM_PLANS['jev-routed'].decisions, 'jev');
  assert.deepEqual(ARM_PLANS['routing-only'].components, ['routing']);
  assert.deepEqual(ARM_PLANS['memory-only'].components, ['memory']);
  assert.deepEqual(ARM_PLANS['log-reduction-only'].components, ['log-reduction']);
  assert.deepEqual(ARM_PLANS.combined.components, ['routing', 'memory', 'log-reduction']);
  assert.equal(ARM_PLANS.generative, null);
});

test('unsupported arms are refused before a trial: generative, Jev without JEVRIS_LIVE_JEV, a live run without JEVRIS_LIVE_HARNESS, log reduction on a CLI harness', () => {
  const sdk = runners.sdkRunner({ env: LIVE_ENV });
  assert.deepEqual(unsupportedArms(REQUIRED, sdk, LIVE_ENV), []);
  assert.deepEqual(unsupportedArms(['generative'], sdk, LIVE_ENV).map((u) => u.arm), ['generative']);
  const noJev = unsupportedArms(REQUIRED, sdk, { JEVRIS_LIVE_HARNESS: '1', ANTHROPIC_API_KEY: 'k' });
  assert.deepEqual(noJev.map((u) => u.arm), ['jev-routed', 'routing-only', 'memory-only', 'log-reduction-only', 'combined']);
  assert.match(noJev[0].reason, /JEVRIS_LIVE_JEV=1/);
  const notLive = unsupportedArms(['native'], runners.sdkRunner({ env: {} }), {});
  assert.match(notLive[0].reason, /JEVRIS_LIVE_HARNESS=1/);
  const noKey = unsupportedArms(['native'], runners.sdkRunner({ env: { JEVRIS_LIVE_HARNESS: '1' } }), {});
  assert.match(noKey[0].reason, /ANTHROPIC_API_KEY/);
  const cli = runners.cliRunner('claude', { env: LIVE_ENV });
  assert.deepEqual(unsupportedArms(REQUIRED, cli, LIVE_ENV).map((u) => u.arm), ['log-reduction-only', 'combined']);
});

test('each arm applies only its own components, and a passing check is the only way to be verified', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'jevris-trial-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const calls = [];
  const log = [];
  const notes = [];
  const driver = createTrialDriver({
    config: config(),
    runner: runners.sdkRunner({ worker, query: fakeQuery(calls), toolkit: fakeToolkit(), env: LIVE_ENV }),
    jevris: stubJevris(base, log),
    onRun: (note) => notes.push(note),
    tempRoot: base,
  });
  const boxes = await sandboxes(base);
  const outcomes = {};
  for (const arm of REQUIRED) {
    const box = await boxes.create();
    outcomes[arm] = await driver.run({ task: TASK, arm, sandbox: box, signal: new AbortController().signal });
    await box.dispose();
  }
  const byArm = Object.fromEntries(notes.map((n) => [n.arm, n]));
  assert.equal(byArm.native.model, 'claude-sonnet-5');
  assert.deepEqual(byArm.native.components, []);
  assert.equal(byArm.static.model, 'claude-opus-5', 'static uses the pre-registered table (hard), not Jevris');
  assert.equal(byArm['routing-only'].model, 'claude-opus-5');
  assert.deepEqual(byArm['routing-only'].components, ['routing']);
  assert.equal(byArm['memory-only'].model, 'claude-sonnet-5');
  assert.deepEqual(byArm['memory-only'].components, ['memory']);
  assert.deepEqual(byArm['log-reduction-only'].components, ['log-reduction']);
  assert.deepEqual(byArm.combined.components, ['routing', 'memory', 'log-reduction']);
  assert.equal(byArm['rules-only'].product, true);
  assert.equal(byArm['rules-only'].decisions, 'rules');

  const promptOf = (i) => calls[i].prompt;
  const armIndex = (arm) => REQUIRED.indexOf(arm);
  assert.equal(promptOf(armIndex('native')), 'Make sum.mjs add its arguments.');
  assert.match(promptOf(armIndex('memory-only')), /^Jevris memory capsule for this task:\n- constraint: Do not edit the test\n\nMake sum\.mjs/);
  assert.equal(calls[armIndex('native')].options.plugins, undefined, 'native loads no Jevris plugin');
  assert.deepEqual(calls[armIndex('native')].options.settingSources, [], 'no user settings are loaded');
  assert.match(calls[armIndex('rules-only')].options.plugins[0].path, /plugin$/);
  const logOpts = calls[armIndex('log-reduction-only')].options;
  assert.ok(logOpts.disallowedTools.includes('Bash'));
  assert.ok(logOpts.allowedTools.includes(runners.TRIAL_SHELL_TOOL));
  assert.ok(!logOpts.allowedTools.includes('Bash'));
  assert.equal(calls[armIndex('memory-only')].options.mcpServers, undefined, 'only the log-reduction arms get the shell tool');
  assert.equal(calls[armIndex('native')].options.permissionMode, 'default', 'native permissions stay authoritative');

  for (const arm of REQUIRED) {
    const outcome = outcomes[arm];
    assert.deepEqual(evals.validateRunOutcome?.(outcome) ?? [], [], `${arm} outcome meets the contract`);
    assert.equal(outcome.completed, true);
    assert.deepEqual(outcome.receipts.map((r) => [r.id, r.passed]), [[`fix-sum:${arm}:test`, true], [`fix-sum:${arm}:syntax`, true]]);
    assert.equal(outcome.costSource, 'provider-reported');
    assert.equal(outcome.costMicroUsd, 12_300);
    assert.equal(outcome.inputTokens, 1200);
    assert.equal(outcome.outputTokens, 300);
    assert.equal(outcome.humanMinutes, 0);
    assert.ok(!outcome.measuredComponents.includes('human-minutes'));
  }
  // prepare runs once per (product, decisions) pair, never per run.
  const prepares = log.filter((entry) => entry[0] === 'prepare').map((entry) => `${entry[1]}:${entry[2]}`);
  assert.deepEqual(prepares.sort(), ['false:jev', 'false:none', 'true:jev', 'true:rules'].sort());
});

test('a run that does not fix the task is completed but not verified; a failing check is a failed receipt', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'jevris-trial-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const driver = createTrialDriver({ config: config(), runner: runners.sdkRunner({ worker, query: fakeQuery([], { fix: false }), env: LIVE_ENV }), jevris: stubJevris(base, []), tempRoot: base });
  const box = await (await sandboxes(base)).create();
  const outcome = await driver.run({ task: TASK, arm: 'native', sandbox: box, signal: new AbortController().signal });
  assert.equal(outcome.completed, true);
  assert.deepEqual(outcome.receipts.map((r) => r.passed), [false, true]);
});

test('an aborted run stops the harness, runs no checks and is abandoned; retries are counted', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'jevris-trial-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const controller = new AbortController();
  // Abort once the harness session is running, not after a fixed delay: on a loaded host the
  // setup before the session can take longer than any delay, and the run is then aborted before
  // start with no retry reported.
  const driver = createTrialDriver({ config: config(), runner: runners.sdkRunner({ worker, query: fakeQuery([], { hang: true, retry: true, onHang: () => controller.abort() }), env: LIVE_ENV }), jevris: stubJevris(base, []), tempRoot: base });
  const box = await (await sandboxes(base)).create();
  const outcome = await driver.run({ task: TASK, arm: 'native', sandbox: box, signal: controller.signal });
  assert.equal(outcome.completed, false);
  assert.equal(outcome.abandoned, true);
  assert.deepEqual(outcome.receipts, []);
  assert.equal(outcome.retries, 1);
  const pre = new AbortController();
  pre.abort();
  const early = await driver.run({ task: TASK, arm: 'native', sandbox: box, signal: pre.signal });
  assert.equal(early.completed, false);
  assert.equal(early.abandoned, true);
});

test('a harness that reports no cost is an estimate from the price table, at the top listed rate for an unlisted model', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'jevris-trial-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const runner = {
    harness: 'claude',
    unsupported: () => null,
    async run() {
      return { status: 'completed', reason: 'exit 0', inputTokens: 1_000_000, outputTokens: 100_000, cacheTokens: 0, costUsd: null, retries: null, actualModel: 'unlisted-model' };
    },
  };
  const driver = createTrialDriver({ config: config(), runner, jevris: stubJevris(base, []), tempRoot: base });
  const box = await (await sandboxes(base)).create();
  const outcome = await driver.run({ task: TASK, arm: 'native', sandbox: box, signal: new AbortController().signal });
  assert.equal(outcome.costSource, 'estimate');
  assert.equal(outcome.costMicroUsd, outcome.estimatedCostMicroUsd);
  assert.equal(outcome.costMicroUsd, 7_500_000, '1M input at $5 plus 100k output at $25');
  assert.deepEqual(outcome.measuredComponents, ['retries']);
});

test('runTrial runs the whole required arm set end to end through the product driver', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'jevris-trial-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const driver = createTrialDriver({ config: config(), runner: runners.sdkRunner({ worker, query: fakeQuery([]), toolkit: fakeToolkit(), env: LIVE_ENV }), jevris: stubJevris(base, []), tempRoot: base });
  let clock = Date.parse('2026-09-26T00:00:00Z');
  const trial = await evals.runTrial({ tasks: [TASK], arms: REQUIRED, driver, sandboxes: await sandboxes(base), preRegistrationLockedAt: '2026-09-25T00:00:00Z', seed: 7, now: () => (clock += 10) });
  assert.equal(trial.ok, true);
  assert.equal(trial.rows.length, REQUIRED.length);
  for (const row of trial.rows) {
    assert.equal(row.errorCode, null, `${row.arm}: ${row.errorCode}`);
    assert.equal(row.verified, true);
  }
});

test('driverConformance (C) passes for the product driver with stub runners', { skip: typeof evals.driverConformance !== 'function' && 'driverConformance is not exported yet' }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'jevris-trial-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const driver = createTrialDriver({ config: config(), runner: runners.sdkRunner({ worker, query: fakeQuery([]), toolkit: fakeToolkit(), env: LIVE_ENV }), jevris: stubJevris(base, []), tempRoot: base });
  const result = await evals.driverConformance({ driver, sandboxes: await sandboxes(base), task: TASK, arms: REQUIRED, cancelWithinMs: 5_000 });
  assert.equal(result.passed, true, JSON.stringify(result.checks.filter((c) => !c.passed)));
});

function fakeToolkit() {
  return {
    createSdkMcpServer: (options) => ({ type: 'sdk', name: options.name, tools: options.tools }),
    tool: (name, description, shape, handler) => ({ name, description, shape, handler }),
    stringSchema: () => ({ type: 'string' }),
  };
}

test('the log-reduction shell tool is an in-process MCP tool that returns the distilled view', async () => {
  const server = runners.shellToolServer(fakeToolkit(), { run: async (command) => `view of ${command}` }, new AbortController().signal);
  assert.equal(server.name, 'jevris-trial');
  const [tool] = server.tools;
  assert.equal(tool.name, 'shell');
  assert.deepEqual(await tool.handler({ command: 'npm test' }, {}), { content: [{ type: 'text', text: 'view of npm test' }] });
});

test('CLI runners: argv and output parsing for claude -p, kilo run and opencode run', () => {
  const input = { prompt: 'do it', model: 'm', allowedTools: ['Read', 'Bash'], maxBudgetUsd: 2, extraArgs: ['--x'] };
  assert.deepEqual(runners.cliArgs('claude', input), ['-p', 'do it', '--output-format', 'json', '--model', 'm', '--max-budget-usd', '2', '--allowedTools', 'Read,Bash', '--x']);
  assert.deepEqual(runners.cliArgs('opencode', input), ['run', '--format', 'json', '--model', 'm', '--x', 'do it']);
  const claude = runners.parseClaudeResult(
    `noise\n${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.5, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 }, modelUsage: { big: { outputTokens: 5 }, small: { outputTokens: 1 } } })}\n`,
    0,
  );
  assert.deepEqual([claude.inputTokens, claude.outputTokens, claude.cacheTokens, claude.costUsd, claude.actualModel, claude.subtype, claude.isError], [10, 5, 2, 0.5, 'big', 'success', false]);
  assert.equal(runners.parseClaudeResult('not json', 1).isError, true);
  const events = [
    { type: 'step_finish', part: { tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 7, write: 1 } }, cost: 0.01, modelID: 'anthropic/claude-sonnet-5' } },
    { type: 'step_finish', part: { tokens: { input: 50, output: 10 }, cost: 0.02 } },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n');
  const oc = runners.parseOpencodeEvents(events);
  assert.deepEqual([oc.inputTokens, oc.outputTokens, oc.cacheTokens, oc.actualModel], [150, 35, 8, 'anthropic/claude-sonnet-5']);
  assert.ok(Math.abs(oc.costUsd - 0.03) < 1e-9);
  assert.equal(runners.parseOpencodeEvents('{"type":"text"}').costUsd, null);
});

test('the claude CLI runner runs a stub harness in the sandbox and reads its JSON result', { skip: process.platform === 'win32' && 'the stub harness is a POSIX script' }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'jevris-trial-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const stub = join(base, 'claude-stub');
  writeFileSync(
    stub,
    `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));\nconsole.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.25, usage: { input_tokens: 40, output_tokens: 8 } }));\n`,
  );
  chmodSync(stub, 0o755);
  const runner = runners.cliRunner('claude', { binary: stub, env: {} });
  assert.equal(runner.unsupported(ARM_PLANS.native), null, 'an injected binary path needs no live flag');
  const cwd = await mkdtemp(join(base, 'box-'));
  const report = await runner.run({ prompt: 'fix it', model: 'claude-sonnet-5', cwd, home: base, env: { PATH: process.env.PATH ?? '' }, allowedTools: ['Read'], maxTurns: 3, maxBudgetUsd: 1, timeoutMs: 20_000, extraArgs: [], signal: new AbortController().signal, plugin: null, shellTool: null });
  assert.equal(report.status, 'completed');
  assert.equal(report.costUsd, 0.25);
  assert.equal(report.inputTokens, 40);
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, 'argv.json'), 'utf8')).slice(0, 2), ['-p', 'fix it']);
});

test('the claude CLI runner runs on a subscription token or an API key, from the environment only', { skip: process.platform === 'win32' && 'the stub harness is a POSIX script' }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'jevris-trial-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const stub = join(base, 'claude-stub');
  writeFileSync(
    stub,
    `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync('seen.json', JSON.stringify(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY'].filter((k) => (process.env[k] ?? '') !== '')));\nconsole.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.25, usage: { input_tokens: 40, output_tokens: 8 } }));\n`,
  );
  chmodSync(stub, 0o755);
  const runner = runners.cliRunner('claude', { binary: stub, env: {} });
  const run = async (env) => {
    const cwd = await mkdtemp(join(base, 'box-'));
    const report = await runner.run({ prompt: 'fix it', model: 'claude-sonnet-5', cwd, home: base, env: { PATH: process.env.PATH ?? '', ...env }, allowedTools: ['Read'], maxTurns: 3, maxBudgetUsd: 1, timeoutMs: 20_000, extraArgs: [], signal: new AbortController().signal, plugin: null, shellTool: null });
    return { report, seen: JSON.parse(readFileSync(join(cwd, 'seen.json'), 'utf8')) };
  };
  const sub = await run({ CLAUDE_CODE_OAUTH_TOKEN: 't', OPENAI_API_KEY: 'o' });
  assert.deepEqual([sub.report.status, sub.report.authMode, sub.seen], ['completed', 'subscription', ['CLAUDE_CODE_OAUTH_TOKEN']]);
  assert.equal(sub.report.costUsd, null, 'a subscription figure is an API-equivalent estimate, so the driver estimates it');
  const key = await run({ ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't' });
  assert.deepEqual([key.report.status, key.report.authMode, key.seen, key.report.costUsd], ['completed', 'api-key', ['ANTHROPIC_API_KEY'], 0.25]);
  // A live run with neither credential is refused before it starts; the profile has no login.
  const live = runners.cliRunner('claude', { env: { JEVRIS_LIVE_HARNESS: '1' } });
  assert.match(live.unsupported(ARM_PLANS.native), /ANTHROPIC_API_KEY \(an API key\) or CLAUDE_CODE_OAUTH_TOKEN \(a subscription/);
  assert.equal(runners.cliRunner('claude', { env: { JEVRIS_LIVE_HARNESS: '1', CLAUDE_CODE_OAUTH_TOKEN: 't' } }).unsupported(ARM_PLANS.native), null);
  assert.match(runners.sdkRunner({ env: { JEVRIS_LIVE_HARNESS: '1', CLAUDE_CODE_OAUTH_TOKEN: 't' } }).unsupported(ARM_PLANS.native), /only with an API key .*use the claude harness/);
});

test('product Jevris: route and capsule read the product JSON; rules-only never starts a sidecar; hooks may act in a run', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'jevris-trial-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const seen = [];
  const answers = {
    route: { main: { outcome: 'recommend', recommendedModel: 'claude-opus-5' } },
    checkpoint: { items: [{ kind: 'constraint', text: 'Do not edit the test' }, { kind: 'open-check', text: 'test' }] },
    status: { decisionHealth: 'degraded' },
  };
  const port = productJevris({
    root: base,
    harness: 'claude-sdk',
    tempRoot: base,
    certify: async () => ({ ok: true, error: null }),
    jevris: async (args, run) => {
      seen.push({ args, env: run.env });
      return { code: 0, stdout: `${JSON.stringify(answers[args[0]])}\n` };
    },
  });
  assert.equal(await port.route({ home: base, cwd: base, taskId: 't1', currentModel: 'claude-sonnet-5', decisions: 'rules' }), 'claude-opus-5');
  assert.deepEqual(seen[0].args.slice(0, 5), ['route', '--json', '--model', 'claude-sonnet-5', '--task']);
  assert.equal(seen[0].env.JEVRIS_SIDECAR_AUTOSTART, '0');
  assert.equal(await port.capsule({ home: base, cwd: base, taskId: 't1', objective: 'o', constraints: ['c1'], decisions: 'jev' }), 'Jevris memory capsule for this task:\n- constraint: Do not edit the test\n- open-check: test');
  assert.ok(seen[1].args.includes('--constraint'));
  assert.equal(seen[1].env.JEVRIS_SIDECAR_AUTOSTART, undefined);
  answers.route = { main: { outcome: 'keep', recommendedModel: null } };
  assert.equal(await port.route({ home: base, cwd: base, taskId: 't1', currentModel: 'm', decisions: 'rules' }), null);
  const refused = await port.prepare({ product: false, decisions: 'jev' });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /decisionHealth degraded/);
  const env = trialEnv(join(base, 'home'), 'rules', { PATH: '/bin', CLAUDE_CONFIG_DIR: '/elsewhere', JEVRIS_HOOK_OBSERVE_ONLY: '1' });
  assert.equal(env.HOME, join(base, 'home'));
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(env.JEVRIS_HOOK_OBSERVE_ONLY, undefined);
  assert.equal(env.JEVRIS_SIDECAR_AUTOSTART, '0');
});

test('product Jevris: the log-reduction shell tool distills long output and keeps the original behind a handle', { skip: process.platform === 'win32' && 'the tool runs /bin/sh here' }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'jevris-trial-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const cwd = join(base, 'repo');
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const env = trialEnv(home, 'rules', { PATH: process.env.PATH ?? '' });
  const port = productJevris({ root: base, harness: 'claude-sdk', tempRoot: base });
  const tool = port.shellTool({ home, cwd, env });
  const script = join(cwd, 'noisy.mjs');
  writeFileSync(script, "for (let i = 0; i < 4000; i += 1) console.log('ok line ' + i + ' passing quietly');\nconsole.log('FAIL: expected 5, received -1');\nprocess.exitCode = 1;\n");
  const view = await tool.run(`"${process.execPath}" noisy.mjs`, new AbortController().signal);
  assert.match(view, /FAIL: expected 5, received -1/);
  assert.match(view, /exit code: 1/);
  const handle = view.match(/jevris evidence get (ev:[0-9a-f]+)/)?.[1];
  assert.ok(handle !== undefined, 'the view names the full-output handle');
  assert.ok(view.length < 40_000, 'the model sees far less than the raw output');
  assert.equal(existsSync(join(home, '.jevris')) || existsSync(join(home, '.local')) || existsSync(join(home, 'AppData')), true, 'the evidence is stored in the run profile');
  const small = await tool.run('echo hi', new AbortController().signal);
  assert.equal(small.trim(), 'hi');
});

test('the release entry refuses, before anything starts, a trial it cannot run for real', () => {
  const refused = productTrialDriver({ config: config(), tasks: [TASK, { taskId: 'ghost' }], arms: [...REQUIRED, 'generative'], root: tmpdir(), env: {} });
  assert.equal(refused.ok, false);
  assert.ok(refused.problems.some((p) => /^arm native: .*JEVRIS_LIVE_HARNESS=1/.test(p)));
  assert.ok(refused.problems.some((p) => /^arm jev-routed: .*JEVRIS_LIVE_JEV=1/.test(p)));
  assert.ok(refused.problems.some((p) => /^arm generative: /.test(p)));
  assert.ok(refused.problems.includes('task ghost has no entry in the trial config'));
  const ready = productTrialDriver({ config: config(), tasks: [TASK], arms: REQUIRED, root: tmpdir(), env: LIVE_ENV });
  assert.equal(ready.ok, true);
  assert.equal(typeof ready.driver.run, 'function');
});

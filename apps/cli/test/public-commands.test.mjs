// The eight public commands and the MCP surface entry (CMD-01..08, CMD-04, ADM-01, TOOL-02).
// Every test injects fake ports: no sidecar process is started and the real home is never used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';

process.env.JEVRIS_SIDECAR_AUTOSTART = '0';

const { runPublicCommand, runSurfaceCall, parseCommandFlags } = await import('../dist/public-commands.js');
const { main } = await import('../dist/cli.js');
const { workspaceIdFor } = await import('@jevris/orchestrator');
const { surfaceResultContract, surfacePayloadContract, PUBLIC_COMMAND_NAMES } = await import('../../../packages/contracts/dist/index.js');

const NOT_RUNNING = { ok: false, reason: 'unavailable', reasonCode: 'NOT_RUNNING', message: 'The Jevris sidecar is not running.' };

function sandbox(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-public-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const workspace = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(join(workspace, '.git'), { recursive: true });
  return { dir, home, workspace, env: { JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0' } };
}

function fakePorts({ answers = {}, ensure = { ok: true, endpoint: 'fake', started: false }, engine = {}, config = {} } = {}) {
  const calls = [];
  return {
    calls,
    ports: {
      sidecar: {
        async ensure(input) {
          calls.push({ kind: 'ensure', ...input });
          return ensure;
        },
        async request(input) {
          calls.push({ kind: 'request', ...input });
          const answer = answers[input.op];
          if (answer === undefined) return NOT_RUNNING;
          return typeof answer === 'function' ? answer(input) : { ok: true, result: answer };
        },
      },
      engine,
      config,
    },
  };
}

async function run(name, argv, box, ports = fakePorts().ports, env = box.env) {
  let text = '';
  const code = await runPublicCommand(name, argv, (chunk) => (text += chunk), { ports, env, cwd: box.workspace, nowMs: () => Date.UTC(2026, 8, 25) });
  return { code, text };
}

/** A person at an interactive terminal (SR-19): the terminal check and the y/N answer are injected. */
async function runAtTerminal(name, argv, box, answer = true, asked = [], ports = fakePorts().ports) {
  let text = '';
  const confirm = async (question) => {
    asked.push(question);
    return answer;
  };
  const code = await runPublicCommand(name, argv, (chunk) => (text += chunk), { ports, env: box.env, cwd: box.workspace, nowMs: () => Date.UTC(2026, 8, 25), interactive: () => true, confirm });
  return { code, text };
}
async function runJson(name, argv, box, ports, env) {
  const { code, text } = await run(name, [...argv, '--json'], box, ports, env);
  const lines = text.trimEnd().split('\n');
  assert.equal(lines.length, 1, `one JSON line for ${name}`);
  const value = JSON.parse(lines[0]);
  return { code, value };
}

function task(id, extra = {}) {
  return {
    id,
    schemaVersion: '1.0',
    workspaceId: 'ws1',
    revision: 'r1',
    state: 'proposed',
    requirementIds: ['REQ-1'],
    dependencyIds: [],
    writeScopes: [`src/${id}`],
    acceptanceCheckIds: ['check-1'],
    rootBudgetId: 'b1',
    ...extra,
  };
}

test('every public command answers in reduced mode with a valid result when the sidecar is absent', async (t) => {
  const box = sandbox(t);
  const graph = join(box.dir, 'graph.json');
  writeFileSync(graph, JSON.stringify([task('a'), task('b', { dependencyIds: ['a'] })]));
  const cases = {
    status: [[], 0],
    plan: [['--graph', graph], 0],
    route: [[], 0],
    checkpoint: [['--objective', 'Ship the parser', '--constraint', 'No new dependencies'], 0],
    recover: [['--failure', 'f1'], 0],
    verify: [['--check', 'unit'], 1],
    explain: [['d-missing'], 1],
    configure: [[], 0],
  };
  assert.deepEqual(Object.keys(cases).sort(), [...PUBLIC_COMMAND_NAMES].sort());
  for (const [name, [argv, exit]] of Object.entries(cases)) {
    const { code, value } = await runJson(name, argv, box);
    assert.equal(code, exit, name);
    const checked = surfaceResultContract(name).validate(value);
    assert.equal(checked.ok, true, `${name}: ${JSON.stringify(checked.issues ?? [])}`);
    assert.equal(value.command, name);
    assert.equal(value.mode, 'reduced', name);
    if (name !== 'configure') {
      assert.equal(value.sidecar.state, 'not-running', name);
      assert.equal(value.sidecar.reasonCode, 'NOT_RUNNING', name);
    }
    assert.equal(value.workspace.root, box.workspace);
    // One canonical id (IPC-09): the root's identity, the same as the sidecar and orchestrator.
    assert.equal(value.workspace.id, workspaceIdFor(box.workspace));
  }
});

test('human output leads with one summary sentence and says what to do', { skip: managedHostSkip() }, async (t) => {
  const box = sandbox(t);
  const { code, text } = await run('status', [], box);
  assert.equal(code, 0);
  const lines = text.trimEnd().split('\n');
  assert.match(lines[0], /^Jevris is in (off|observe|advise|bounded-auto) mode; decision health is \w+ \(reduced mode\)\.$/);
  assert.equal(lines.includes('sidecar: not-running'), true);
  assert.equal(lines.some((line) => line.startsWith('what to do: ')), true);
  assert.equal(text.includes('{'), false, 'no JSON in human output');
});

test('a running sidecar answers in full mode through the right op, scope and workspace', async (t) => {
  const box = sandbox(t);
  const reducedStatus = (await runJson('status', [], box)).value.result;
  const { calls, ports } = fakePorts({ answers: { status: reducedStatus } });
  const { code, value } = await runJson('status', [], box, ports, { ...box.env, JEVRIS_SIDECAR_AUTOSTART: '1' });
  assert.equal(code, 0);
  assert.equal(value.mode, 'full');
  assert.deepEqual(value.sidecar, { state: 'running', reasonCode: null, message: null });
  const ensure = calls.find((c) => c.kind === 'ensure');
  assert.equal(ensure.home, box.home);
  assert.equal(ensure.waitMs > 0, true);
  const request = calls.find((c) => c.kind === 'request');
  assert.equal(request.op, 'status');
  assert.equal(request.scope, 'cli');
  assert.equal(request.workspace, box.workspace);
  assert.equal(request.home, box.home);
  assert.equal(request.timeoutMs > 0, true);
});

test('autostart off never starts the sidecar; a starting sidecar is reported as starting', async (t) => {
  const box = sandbox(t);
  const off = fakePorts();
  await run('status', [], box, off.ports);
  assert.equal(off.calls.some((c) => c.kind === 'ensure'), false);

  const starting = fakePorts({ ensure: { ok: false, reason: 'starting', message: 'The sidecar is starting.' } });
  const { value } = await runJson('route', [], box, starting.ports, { ...box.env, JEVRIS_SIDECAR_AUTOSTART: '1' });
  assert.equal(value.mode, 'reduced');
  assert.equal(value.sidecar.state, 'starting');
  assert.equal(starting.calls.some((c) => c.kind === 'request'), false);
});

test('a sidecar answer that breaks its contract degrades to reduced mode', async (t) => {
  const box = sandbox(t);
  const { ports } = fakePorts({ answers: { route: { main: 'switch now' } } });
  const { code, value } = await runJson('route', [], box, ports);
  assert.equal(code, 0);
  assert.equal(value.mode, 'reduced');
  assert.equal(value.sidecar.reasonCode, 'SIDECAR_INVALID_RESULT');
  assert.equal(value.result.applied, false);
});

test('route keeps a pinned model even when the engine recommends another (C10)', async (t) => {
  const box = sandbox(t);
  const { BUNDLED_MODEL_REGISTRY } = await import('@jevris/core');
  let recommended = 'claude-sonnet-5';
  const engine = {
    loadRegistry: async () => BUNDLED_MODEL_REGISTRY,
    adviseMainRoute: () => ({
      outcome: 'recommend',
      recommendedModelId: recommended,
      reasonCode: 'CHEAPER_SUFFICIENT',
      costBasis: 'api-list-price',
      pinState: 'unpinned',
      adviceKey: `sha256:${'a'.repeat(64)}`,
      text: 'Switch to the smaller model.',
    }),
  };
  const { ports } = fakePorts({ engine });
  // Serving hosts (owner 8c1f85d): a gateway session is not on the maker's model, so the router is
  // not asked; a pin on a gateway id is still kept.
  const gateway = await runJson('route', ['--model', 'openrouter/claude-opus-5'], box, ports);
  assert.equal(gateway.value.result.main.outcome, 'abstain');
  assert.equal(gateway.value.result.main.recommendedModel, null);
  assert.equal(gateway.value.result.main.reasonCode, 'ROUTER_UNAVAILABLE');
  const gatewayPin = await runJson('route', ['--model', 'claude-opus-5', '--pin', 'openrouter/claude-opus-5'], box, ports);
  assert.equal(gatewayPin.value.result.main.outcome, 'keep');
  assert.equal(gatewayPin.value.result.main.reasonCode, 'PIN_RESPECTED');
  assert.equal(gatewayPin.value.result.main.recommendedModel, null);
  // C 21d49e9: with the session's harness, only that harness's spellings resolve, so a model the
  // harness does not run is not asked about.
  const offHarness = await runJson('route', ['--harness', 'codex', '--model', 'claude-opus-5'], box, ports);
  assert.equal(offHarness.value.result.main.outcome, 'abstain');
  assert.equal(offHarness.value.result.main.reasonCode, 'ROUTER_UNAVAILABLE');
  const pinned = await runJson('route', ['--model', 'claude-opus-5', '--pin', 'claude-opus-5'], box, ports);
  assert.equal(pinned.value.result.main.outcome, 'keep');
  assert.equal(pinned.value.result.main.pinState, 'pinned');
  assert.equal(pinned.value.result.main.recommendedModel, null);
  assert.equal(pinned.value.result.main.reasonCode, 'PIN_RESPECTED');
  assert.equal(pinned.value.result.applied, false);

  // Security review MEDIUM 9 and owner decision c065d52: offline, consent cannot be read and every
  // bundled provider (Anthropic too) has consent text, so local advice suggests no model.
  const free = await runJson('route', ['--model', 'claude-opus-5'], box, ports);
  assert.equal(free.value.result.main.outcome, 'keep');
  assert.equal(free.value.result.main.recommendedModel, null);
  assert.deepEqual(free.value.result.main.consentedProviders, []);
  assert.equal(free.value.result.applied, false);
  // Owner rules (177c6fe, 8703ab6): with no auth mode detected, the basis is unknown and the
  // figure is named as at API list price; a subscription is never assumed.
  const human = await run('route', ['--model', 'claude-opus-5'], box, ports);
  assert.match(human.text, /^cost basis: at API list price; the billing basis is unknown \(API key or subscription not detected\)$/m);
  assert.match(human.text, /^providers considered: none \(others need consent: jevris consent provider\)$/m);

  for (const model of ['claude-sonnet-5', 'deepseek-v4-pro', 'gpt-6-sol', 'not-in-the-registry']) {
    recommended = model;
    const gated = await runJson('route', ['--model', 'claude-opus-5'], box, ports);
    assert.equal(gated.value.result.main.outcome, 'keep', model);
    assert.equal(gated.value.result.main.recommendedModel, null, model);
    assert.equal(gated.value.result.main.reasonCode, 'PROVIDER_CONSENT_REQUIRED', model);
    assert.match(gated.value.result.main.text, /cannot read your provider consent/);
  }
});

test('plan reports waves for a valid graph and exits 1 with issues for an invalid one', async (t) => {
  const box = sandbox(t);
  const good = join(box.dir, 'good.json');
  writeFileSync(good, JSON.stringify({ tasks: [task('a'), task('b', { dependencyIds: ['a'] }), task('c')] }));
  const ok = await runJson('plan', ['--graph', good], box);
  assert.equal(ok.code, 0);
  assert.equal(ok.value.result.valid, true);
  assert.deepEqual(ok.value.result.waves, [['a', 'c'], ['b']]);
  assert.deepEqual(ok.value.result.ready.sort(), ['a', 'c']);

  const bad = join(box.dir, 'bad.json');
  writeFileSync(
    bad,
    JSON.stringify([
      task('c', { acceptanceCheckIds: [], writeScopes: ['src/shared'] }),
      task('d', { writeScopes: ['src/shared/parser'] }),
    ]),
  );
  const invalid = await runJson('plan', ['--graph', bad], box);
  assert.equal(invalid.code, 1);
  assert.equal(invalid.value.result.valid, false);
  const codes = invalid.value.result.issues.map((i) => i.code);
  assert.equal(codes.includes('NO_ACCEPTANCE_CHECK'), true);
  assert.equal(codes.includes('WRITE_OVERLAP'), true);

  const cyclic = join(box.dir, 'cyclic.json');
  writeFileSync(cyclic, JSON.stringify([task('a', { dependencyIds: ['b'] }), task('b', { dependencyIds: ['a'] })]));
  const cycle = await runJson('plan', ['--graph', cyclic], box);
  assert.equal(cycle.code, 1);
  assert.equal(cycle.value.result.issues.some((i) => i.code === 'CYCLE'), true);

  const missing = await run('plan', [], box);
  assert.equal(missing.code, 2);
  assert.match(missing.text, /--graph/);
});

test('checkpoint writes a private capsule under the Jevris home and never compacts', async (t) => {
  const box = sandbox(t);
  const { code, value } = await runJson('checkpoint', ['--objective', 'Finish the parser', '--constraint', 'Keep the API stable'], box);
  assert.equal(code, 0);
  assert.equal(value.result.written, true);
  assert.equal(value.result.compactionTriggered, false);
  assert.equal(value.result.retained.constraints, 1);
  const texts = value.result.items.map((i) => i.text);
  assert.equal(texts.includes('Keep the API stable'), true);
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, name.name);
      if (name.isDirectory()) walk(full);
      else if (name.name.endsWith('.json')) found.push(full);
    }
  };
  walk(box.home);
  assert.equal(found.length, 1, 'one capsule file inside the Jevris home');
  assert.equal(readFileSync(found[0], 'utf8').includes('Finish the parser'), true);
  assert.equal(existsSync(join(box.workspace, 'jevris')), false, 'nothing written into the workspace');
});

test('recover keeps the command-line order of failures and classifies repeats', async (t) => {
  const box = sandbox(t);
  const { calls, ports } = fakePorts();
  await run('recover', ['--env-failure', 'net', '--failure', 'type-error', '--env-failure', 'net', '--rejected', 'retry blindly'], box, ports);
  const request = calls.find((c) => c.kind === 'request');
  assert.equal(request.op, 'recover');
  assert.deepEqual(request.body.signals.fingerprints, ['net', 'type-error', 'net']);
  assert.deepEqual(request.body.signals.environment, [true, false, true]);
  assert.deepEqual(request.body.rejectedApproaches, ['retry blindly']);

  const repeated = await runJson('recover', ['--failure', 'x', '--failure', 'x', '--failure', 'x', '--failure', 'x'], box);
  assert.equal(repeated.value.result.action, 'stop-and-report');
  const oscillating = await runJson('recover', ['--failure', 'a', '--failure', 'b', '--failure', 'a', '--failure', 'b'], box);
  assert.equal(oscillating.value.result.classification, 'patch-oscillation');
});

test('verify in reduced mode never claims a pass and never runs a process', async (t) => {
  const box = sandbox(t);
  const { code, value } = await runJson('verify', ['--check', 'unit', '--check', 'lint'], box);
  assert.equal(code, 1);
  assert.equal(value.result.ran, false);
  assert.notEqual(value.result.readiness, 'verified');
  assert.deepEqual([...value.result.missing].sort(), ['lint', 'unit']);
});

test('explain returns a decision trace from the engine and not-found otherwise', async (t) => {
  const box = sandbox(t);
  const record = {
    decisionId: 'd-1',
    specId: 'route-main',
    modelResolved: 'claude-sonnet-4-6',
    mode: 'advise',
    evidenceRevision: 'r1',
    outcome: 'proposed',
    reasonCodes: ['CHEAPER_SUFFICIENT'],
    proposedAction: null,
    appliedAction: null,
    usage: { inputTokens: 1200, outputTokens: 80 },
    billingBasis: 'api-list-price',
    actualTaskOutcome: null,
    policyVersion: 'p1',
    calibration: null,
  };
  const engine = { lookupDecision: async (id) => (id === 'd-1' ? record : null), explainDecision: () => 'Proposed a smaller model; nothing was applied.' };
  const { ports } = fakePorts({ engine });
  const found = await runJson('explain', ['d-1'], box, ports);
  assert.equal(found.code, 0);
  assert.equal(found.value.result.found, true);
  assert.equal(found.value.result.trace.resolvedModel, 'claude-sonnet-4-6');
  assert.deepEqual(found.value.result.trace.usage, { known: true, inputTokens: 1200, outputTokens: 80 });
  assert.equal(found.value.result.trace.applied, false);
  assert.match(found.value.result.trace.uncertainty, /No calibration/);
  // US12: nothing observed the worker model, so it is unknown, with no cost precision claimed.
  assert.deepEqual(found.value.result.trace.models, { requested: null, observed: null, source: 'unknown', substituted: null, costPrecision: 'unknown' });
  const plain = await run('explain', ['d-1'], box, ports);
  assert.match(plain.text, /^requested model: unknown$/m);
  assert.match(plain.text, /^observed model: unknown \(nothing reported it\)$/m);
  assert.match(plain.text, /^cost precision: unknown$/m);

  // A substituted worker: requested and observed are kept apart and the substitution is named.
  const substituted = { ...record, decisionId: 'd-3', workerModel: { requested: 'claude-opus-4-7', observed: 'claude-sonnet-4-6', source: 'harness', substituted: true, costPrecision: 'estimate' } };
  const subPorts = fakePorts({ engine: { ...engine, lookupDecision: async (id) => (id === 'd-3' ? substituted : null) } }).ports;
  const sub = await runJson('explain', ['d-3'], box, subPorts);
  assert.equal(sub.code, 0);
  assert.deepEqual(sub.value.result.trace.models, substituted.workerModel);
  const subText = await run('explain', ['d-3'], box, subPorts);
  assert.match(subText.text, /^requested model: claude-opus-4-7$/m);
  assert.match(subText.text, /^observed model: claude-sonnet-4-6 \(reported by the harness\)$/m);
  assert.match(subText.text, /^substituted: yes: claude-opus-4-7 was requested, claude-sonnet-4-6 did the work$/m);
  assert.match(subText.text, /^cost precision: estimate$/m);

  const missing = await run('explain', ['d-2'], box, ports);
  assert.equal(missing.code, 1);
  assert.match(missing.text, /No decision d-2 was found/);
  const noId = await run('explain', [], box, ports);
  assert.equal(noId.code, 2);
});

test('configure shows settings, changes product keys only, and refuses administrator keys', async (t) => {
  const box = sandbox(t);
  const shown = await runJson('configure', [], box);
  assert.equal(shown.value.result.valid, true);
  assert.equal(shown.value.result.nativePermissionsChanged, false);

  const dry = await runJson('configure', ['set', 'mode', 'advise', '--dry-run'], box);
  assert.equal(dry.code, 0);
  assert.deepEqual(dry.value.result.changed.map((c) => c.key), ['mode']);
  assert.equal(dry.value.result.effective.mode, 'advise');
  const after = await runJson('configure', ['show'], box);
  assert.equal(after.value.result.effective.mode, shown.value.result.effective.mode, 'dry run writes nothing');

  const set = await runJson('configure', ['set', 'mode', 'advise'], box);
  assert.equal(set.value.result.effective.mode, 'advise');
  const reread = await runJson('configure', [], box);
  assert.equal(reread.value.result.effective.mode, 'advise');

  const admin = await run('configure', ['set', 'privacy.sourceEgress', 'allowed'], box);
  assert.equal(admin.code, 2);
  assert.match(admin.text, /administrator/);
  const unknown = await run('configure', ['set', 'nope', 'x'], box);
  assert.equal(unknown.code, 2);
});

test('configure\'s local fallback accepts and refuses the same keys and values as D\'s setter, with typed values (SET-03)', async (t) => {
  const box = sandbox(t);
  const { SETTABLE_KEYS } = await import('@jevris/orchestrator');
  // fakePorts has no D setter: every answer below is the local fallback.
  const number = await runJson('configure', ['set', 'orchestration.maxConcurrentWorkers', '4'], box);
  assert.equal(number.code, 0);
  assert.deepEqual(number.value.result.changed, [{ key: 'orchestration.maxConcurrentWorkers', from: '2', to: '4' }]);
  const file = JSON.parse(readFileSync(number.value.result.path, 'utf8'));
  assert.equal(file.orchestration.maxConcurrentWorkers, 4, 'stored as a number');
  assert.equal((await runJson('configure', ['set', 'orchestration.enabled', 'true'], box)).value.result.effective.orchestrationEnabled, true);
  assert.equal((await runJson('configure', ['set', 'privacy.rawArtifactRetentionDays', '3', '--dry-run'], box)).code, 0);
  for (const key of Object.keys(SETTABLE_KEYS)) assert.notEqual(SETTABLE_KEYS[key], undefined, key);
  // Refusals: a value D's parser refuses, an administrator key (D's reason), an unknown key.
  const badValue = await run('configure', ['set', 'orchestration.maxConcurrentWorkers', '99'], box);
  assert.equal(badValue.code, 2);
  assert.match(badValue.text, /"99" is not a valid value for orchestration\.maxConcurrentWorkers/);
  // OD-8: routing.mainSession takes advice-only and plugin-bounded-auto; owned-sdk-approved stays an administrator's value.
  const admin = await run('configure', ['set', 'routing.mainSession', 'owned-sdk-approved'], box);
  assert.equal(admin.code, 2);
  assert.match(admin.text, /owned-sdk-approved|administrator/);
  const { ADMIN_VALUES } = await import('@jevris/orchestrator');
  assert.ok(admin.text.includes(ADMIN_VALUES['routing.mainSession'].message), 'the fallback gives D\'s administrator-value message');
  assert.equal((await run('configure', ['set', 'routing.mainSession', 'advice-only'], box)).code, 0);
  // plugin-bounded-auto raises it again: a person at a terminal (SR-19).
  assert.equal((await runAtTerminal('configure', ['set', 'routing.mainSession', 'plugin-bounded-auto'], box)).code, 0);
  const unknown = await run('configure', ['set', 'nope', 'x'], box);
  assert.match(unknown.text, new RegExp(`Settable: ${Object.keys(SETTABLE_KEYS).join(', ').replace(/\./g, '\\.')}\\.`));
});

test('SR-19: a configure set that raises mode, routing.managedWorkers or routing.mainSession needs a person at a terminal; --yes, --json and a pipe are refused (owner decision 2e13b6fe)', async (t) => {
  const box = sandbox(t);
  const { DEFAULT_CONFIG } = await import('@jevris/orchestrator');
  const refusal = (key, value) => `Nothing was changed (CHANNEL_REFUSED): raising ${key} to ${value} widens what Jevris may do, so it needs a person at an interactive terminal who answers y (never --yes, --json, MCP, a hook, a script, a pipe or a model's shell).\n`;
  const effective = async () => (await runJson('configure', [], box)).value.result.effective;
  // The install defaults, with no file; the same value is free.
  assert.equal((await effective()).managedWorkers, DEFAULT_CONFIG.routing.managedWorkers);
  assert.equal((await run('configure', ['set', 'routing.managedWorkers', 'bounded-auto'], box)).code, 0, 'unchanged');
  // Lowering is always free: no question, not even under --yes or --json.
  const never = [];
  assert.equal((await run('configure', ['set', 'routing.managedWorkers', 'observe', '--yes'], box)).code, 0);
  assert.equal((await runJson('configure', ['set', 'routing.mainSession', 'advice-only'], box)).code, 0);
  assert.equal((await runAtTerminal('configure', ['set', 'mode', 'off'], box, false, never)).code, 0);
  // Compared with the effective value: under mode off, managedWorkers is off, so observe is a raise.
  assert.equal((await run('configure', ['set', 'routing.managedWorkers', 'observe'], box)).code, 2);
  assert.deepEqual(never, []);
  assert.deepEqual([(await effective()).mode, (await effective()).managedWorkers, (await effective()).mainSession], ['off', 'off', 'advice-only']);
  for (const [key, value] of [['mode', 'advise'], ['mode', 'bounded-auto'], ['routing.mainSession', 'plugin-bounded-auto']]) {
    // A pipe (no terminal), --yes (even at a terminal) and --json: refused with B's line, nothing asked, nothing written.
    const pipe = await run('configure', ['set', key, value], box);
    assert.deepEqual([pipe.code, pipe.text], [2, refusal(key, value)], `${key} ${value} from a pipe`);
    const asked = [];
    const yes = await runAtTerminal('configure', ['set', key, value, '--yes'], box, true, asked);
    assert.deepEqual([yes.code, yes.text], [2, refusal(key, value)], `${key} ${value} --yes`);
    const json = await runAtTerminal('configure', ['set', key, value, '--json'], box, true, asked);
    assert.equal(json.code, 2);
    assert.deepEqual(JSON.parse(json.text), { error: { code: 'CHANNEL_REFUSED', message: refusal(key, value).trim() } });
    const testRun = await runPublicCommand('configure', ['set', key, value], () => {}, { ports: fakePorts().ports, env: { ...box.env, JEVRIS_TEST: '1' }, cwd: box.workspace, interactive: () => true, confirm: async () => true });
    assert.equal(testRun, 2, 'JEVRIS_TEST=1 is refused');
    assert.deepEqual(asked, [], 'nothing was asked');
    // A dry run shows the change and asks nothing.
    assert.equal((await run('configure', ['set', key, value, '--dry-run'], box)).code, 0);
  }
  assert.deepEqual([(await effective()).mode, (await effective()).mainSession], ['off', 'advice-only'], 'nothing was written');
  // A person at a terminal: "no" changes nothing, "y" writes it.
  const asked = [];
  const no = await runAtTerminal('configure', ['set', 'mode', 'bounded-auto'], box, false, asked);
  assert.deepEqual([no.code, no.text], [2, 'Nothing was changed.\n']);
  assert.equal(asked[0], 'Raise mode to bounded-auto? It widens what Jevris may do. [y/N] ');
  assert.equal((await effective()).mode, 'off');
  assert.equal((await runAtTerminal('configure', ['set', 'mode', 'bounded-auto'], box)).code, 0);
  assert.equal((await runAtTerminal('configure', ['set', 'routing.managedWorkers', 'bounded-auto'], box)).code, 0);
  assert.equal((await runAtTerminal('configure', ['set', 'routing.mainSession', 'plugin-bounded-auto'], box)).code, 0);
  assert.deepEqual([(await effective()).mode, (await effective()).managedWorkers, (await effective()).mainSession], ['bounded-auto', 'bounded-auto', 'plugin-bounded-auto']);
  // D's setter gets confirmed: true only from a terminal y; --yes never confirms.
  assert.equal((await run('configure', ['set', 'mode', 'off'], box)).code, 0);
  const seen = [];
  const setter = async (input) => {
    seen.push(input.confirmed);
    return { ok: false, reasonCode: 'CHANNEL_REFUSED', message: 'refused in the fake' };
  };
  const port = fakePorts({ config: { setConfigValue: setter } }).ports;
  await runAtTerminal('configure', ['set', 'mode', 'advise'], box, true, [], port);
  await run('configure', ['set', 'mode', 'off'], box, port);
  assert.deepEqual(seen, [true, false]);
  assert.equal((await run('configure', ['show', '--yes'], box)).code, 2, '--yes applies to set');
});

test('SR-20: a present but unusable jevris.config.json caps the mode at observe, names the file and the fix, and configure set mode off replaces it', async (t) => {
  const box = sandbox(t);
  const { loadEffectiveConfig, setConfigValue } = await import('@jevris/orchestrator');
  const d = fakePorts({ config: { loadEffectiveConfig, setConfigValue } }).ports;
  const first = await runJson('configure', ['set', 'orchestration.maxConcurrentWorkers', '3'], box, d);
  const file = first.value.result.path;
  writeFileSync(file, '{ not json');
  const shown = await runJson('configure', [], box, d);
  assert.equal(shown.value.result.effective.mode, 'observe');
  assert.ok(shown.value.result.issues.some((issue) => issue.path === 'user:'), JSON.stringify(shown.value.result.issues));
  // Every other set is refused, naming the file and the fix; the local fallback names the file too.
  for (const ports of [d, fakePorts().ports]) {
    const other = await run('configure', ['set', 'orchestration.maxConcurrentWorkers', '4'], box, ports);
    assert.equal(other.code, 2);
    assert.ok(other.text.includes(file) && other.text.includes('capped at observe'), other.text);
  }
  // A raise is still a raise: the pipe is refused before the file is looked at.
  assert.equal((await run('configure', ['set', 'mode', 'advise'], box, d)).code, 2);
  // configure set mode off moves the bad file aside and writes a fresh one with that mode.
  const off = await run('configure', ['set', 'mode', 'off'], box, d);
  assert.equal(off.code, 0, off.text);
  assert.equal(readFileSync(`${file}.invalid`, 'utf8'), '{ not json');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).mode, 'off');
  assert.equal((await runJson('configure', [], box, d)).value.result.effective.mode, 'off');
});

test('configure reports source egress as the host decision, never approved from the user file alone (SET-02, GOV-01)', async (t) => {
  const box = sandbox(t);
  // No file yet: the preference is not set.
  const none = await runJson('configure', [], box);
  assert.equal(none.value.result.effective.sourceEgressSource, 'host-policy');
  assert.equal(none.value.result.effective.sourceEgressPreference, null);
  assert.match((await run('configure', [], box)).text, /^source egress: deny-until-approved \(host policy; see jevris egress status\); your jevris\.config\.json preference: not set$/m);

  // The user file prefers approved-scoped; host policy has not approved.
  const written = await runJson('configure', ['set', 'mode', 'advise'], box);
  const file = written.value.result.path;
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, privacy: { ...config.privacy, sourceEgress: 'approved-scoped' } }));
  const withResolver = (sourceEgress, extra = {}) => fakePorts({ config: { sourceEgress, ...extra } }).ports;
  const cases = [
    ['the resolver says not approved', withResolver(async () => 'not-approved'), 'deny-until-approved'],
    ['the resolver throws', withResolver(async () => { throw new Error('no sidecar module'); }), 'deny-until-approved'],
    ['the resolver answers something else', withResolver(async () => 'approved-scoped'), 'deny-until-approved'],
    ['host policy approved', withResolver(async () => 'approved'), 'approved-scoped'],
  ];
  if (!managedHostSkip()) cases.push(['the guard resolver over the temporary home (no host.json)', fakePorts().ports, 'deny-until-approved']);
  for (const [why, ports, expected] of cases) {
    const shown = await runJson('configure', [], box, ports);
    assert.equal(shown.value.result.effective.sourceEgress, expected, why);
    assert.equal(shown.value.result.effective.sourceEgressSource, 'host-policy', why);
    assert.equal(shown.value.result.effective.sourceEgressPreference, 'approved-scoped', why);
    const human = await run('configure', [], box, ports);
    assert.ok(human.text.includes(`source egress: ${expected} (host policy; see jevris egress status); your jevris.config.json preference: approved-scoped\n`), `${why}: ${human.text}`);
  }
  // A set answers with the same host decision.
  const set = await runJson('configure', ['set', 'mode', 'observe'], box, withResolver(async () => 'not-approved'));
  assert.equal(set.value.result.effective.sourceEgress, 'deny-until-approved');

  // D's loader or setter reporting the file's value is corrected to the host decision.
  const fromFile = { ...none.value.result, source: 'file', path: file, effective: { ...none.value.result.effective, sourceEgress: 'approved-scoped' } };
  delete fromFile.effective.sourceEgressSource;
  delete fromFile.effective.sourceEgressPreference;
  const d = withResolver(async () => 'not-approved', { loadEffectiveConfig: async () => fromFile, setConfigValue: async () => fromFile });
  for (const argv of [[], ['set', 'mode', 'off']]) {
    const answer = (await runJson('configure', argv, box, d)).value.result.effective;
    assert.deepEqual([answer.sourceEgress, answer.sourceEgressSource, answer.sourceEgressPreference], ['deny-until-approved', 'host-policy', 'approved-scoped'], argv.join(' '));
  }
  // D's answer that already names host policy is kept as it is.
  const dHost = { ...fromFile, effective: { ...fromFile.effective, sourceEgressSource: 'host-policy', sourceEgressPreference: null } };
  const kept = (await runJson('configure', [], box, withResolver(async () => 'not-approved', { loadEffectiveConfig: async () => dHost }))).value.result.effective;
  assert.deepEqual([kept.sourceEgress, kept.sourceEgressPreference], ['approved-scoped', null]);
});

test('usage errors exit 2, and --json prints a JSON error', async (t) => {
  const box = sandbox(t);
  const flag = await run('status', ['--bogus'], box);
  assert.equal(flag.code, 2);
  assert.match(flag.text, /Unknown option --bogus\.\nRun jevris status --help for usage\./);
  const json = await run('route', ['--model', '--json'], box);
  assert.equal(json.code, 2);
  const extra = await run('route', ['--json', 'surplus'], box);
  assert.equal(extra.code, 2);
  assert.deepEqual(Object.keys(JSON.parse(extra.text).error), ['code', 'message']);
  const twice = parseCommandFlags(['--task', 'a', '--task', 'b'], { value: ['--task'], repeat: [], boolean: [] });
  assert.equal(twice.ok, false);
});

test('help, version and bare usage (ADM-01)', async () => {
  const call = async (argv) => {
    let text = '';
    const code = await main(argv, (chunk) => (text += chunk));
    return { code, text };
  };
  for (const argv of [[], ['--help'], ['-h'], ['help']]) {
    const { code, text } = await call(argv);
    assert.equal(code, 0, argv.join(' '));
    assert.match(text, /^Usage: jevris <command>/);
    for (const name of PUBLIC_COMMAND_NAMES) assert.match(text, new RegExp(`\\n  ${name} `));
  }
  const version = await call(['--version']);
  assert.equal(version.code, 0);
  assert.match(version.text, /^jevris \d+\.\d+\.\d+/);
  for (const name of PUBLIC_COMMAND_NAMES) {
    const viaHelp = await call(['help', name]);
    assert.equal(viaHelp.code, 0);
    assert.match(viaHelp.text, new RegExp(`^Usage: jevris ${name}`));
    const viaFlag = await call([name, '--help']);
    assert.equal(viaFlag.text, viaHelp.text);
  }
  const admin = await call(['help', 'doctor']);
  assert.equal(admin.code, 0);
  assert.match(admin.text, /Usage: jevris doctor/);
  const unknown = await call(['help', 'nope']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.text, /Unknown command "nope"/);
});

test('__surface reads JSON arguments from stdin and prints one contract line (TOOL-02)', async (t) => {
  const box = sandbox(t);
  const surface = async (argv, input, env = box.env, ports = fakePorts().ports) => {
    let text = '';
    const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    const code = await runSurfaceCall(argv, (chunk) => (text += chunk), async () => bytes, { ports, env, cwd: box.workspace });
    const lines = text.trimEnd().split('\n');
    assert.equal(lines.length, 1);
    return { code, value: JSON.parse(lines[0]) };
  };
  const status = await surface(['status'], '');
  assert.equal(status.code, 0);
  assert.equal(surfaceResultContract('status').validate(status.value).ok, true);

  const graph = await surface(['plan'], JSON.stringify({ tasks: [task('a')] }));
  assert.equal(graph.value.result.valid, true);

  const { calls, ports } = fakePorts();
  await surface(['verify'], JSON.stringify({ checkIds: ['unit'] }), box.env, ports);
  assert.equal(calls.find((c) => c.kind === 'request').op, 'verify.status', 'MCP never asks the sidecar to run checks');
  assert.equal(calls.find((c) => c.kind === 'request').scope, 'mcp');

  const homeArg = await surface(['status'], JSON.stringify({ home: '/tmp/elsewhere' }));
  assert.equal(homeArg.code, 2, 'home never comes from the model');
  assert.equal(homeArg.value.error.code, 'REFUSED');

  const settings = await surface(['configure'], JSON.stringify({ key: 'mode', value: 'advise' }));
  assert.equal(settings.code, 2);
  assert.match(settings.value.error.message, /never from a model tool call/);
  // SR-19: no raise through MCP either, whatever the key.
  for (const [key, value] of [['mode', 'bounded-auto'], ['routing.managedWorkers', 'bounded-auto'], ['routing.mainSession', 'plugin-bounded-auto']]) {
    const raise = await surface(['configure'], JSON.stringify({ key, value }));
    assert.equal(raise.code, 2, key);
    assert.match(raise.value.error.message, /never from a model tool call/, key);
  }

  assert.equal((await surface(['rm-rf'], '')).value.error.code, 'UNKNOWN_OPERATION');
  assert.equal((await surface(['status', 'extra'], '')).value.error.code, 'UNKNOWN_OPERATION');
  assert.equal((await surface(['status'], '{nope')).value.error.code, 'INVALID_JSON');
  assert.equal((await surface(['status'], new Uint8Array(1_048_577))).value.error.code, 'OVERSIZE');
  assert.equal((await surface(['status'], '{"__proto__":{"x":1}}')).code, 2);
});

test('each payload contract accepts the reduced answer the surface builds', async (t) => {
  const box = sandbox(t);
  const { value } = await runJson('status', [], box);
  assert.equal(surfacePayloadContract('status').validate(value.result).ok, true);
});

test('a reduced handoff import accepts a bare v1 capsule and unwraps a portable v2 envelope', async (t) => {
  const box = sandbox(t);
  const surface = async (op, args) => {
    let text = '';
    const bytes = new TextEncoder().encode(JSON.stringify(args));
    const code = await runSurfaceCall([op], (chunk) => (text += chunk), async () => bytes, {
      ports: fakePorts().ports,
      env: box.env,
      cwd: box.workspace,
      nowMs: () => Date.UTC(2026, 8, 25),
    });
    return { code, value: JSON.parse(text.trimEnd()) };
  };
  await surface('checkpoint', { objective: 'Ship the handoff', constraints: ['Keep the pin'] });
  const exported = await surface('handoff.export', {});
  assert.equal(exported.value.result.found, true);
  const capsule = exported.value.result.capsule;

  const bare = await surface('handoff.import', { capsule });
  assert.equal(bare.value.mode, 'reduced');
  assert.equal(bare.value.result.accepted, true);
  assert.equal(bare.value.result.capsuleId, capsule.id);

  const envelope = { schemaVersion: 'jevris-portable-capsule-2', capsule, items: [], toolRefs: [], requiredCapabilities: [], openChecks: [] };
  const wrapped = await surface('handoff.import', { capsule: envelope });
  assert.equal(wrapped.value.result.accepted, true);
  assert.equal(wrapped.value.result.capsuleId, capsule.id);
  assert.equal(wrapped.value.result.authorityGranted, false);

  const hollow = await surface('handoff.import', { capsule: { schemaVersion: 'jevris-portable-capsule-2', items: [] } });
  assert.equal(hollow.value.result.accepted, false);
  assert.equal(hollow.value.result.reasonCode, 'CAPSULE_INVALID');
});

test('verify says in words when a check is still running or queued, never only "nothing ran", and refuses an unapproved check with the sidecar\'s reason (D 21e3481)', async (t) => {
  const box = sandbox(t);
  const check = (checkId, reasonCode) => ({ checkId, mandatory: true, outcome: 'not-run', receiptId: null, fresh: false, reasonCode, environment: null });
  const payload = { ran: false, readiness: 'not-verified', checks: [check('test', 'RUNNING'), check('lint', 'QUEUED'), check('docs', 'NO_RECEIPT')], missing: ['test', 'lint', 'docs'] };
  const { ports } = fakePorts({ answers: { verify: payload } });
  const json = await runJson('verify', ['--check', 'test', '--check', 'lint', '--check', 'docs'], box, ports);
  assert.equal(json.code, 1);
  assert.equal(json.value.summary, 'Not verified: 3 checks without a current passing receipt; 1 still running, 1 queued.');
  const plain = (await run('verify', ['--check', 'test', '--check', 'lint', '--check', 'docs'], box, ports)).text;
  assert.match(plain, /^test: still running in the background$/m);
  assert.match(plain, /^lint: queued behind the run under way$/m);
  assert.doesNotMatch(plain, /^docs: /m, 'a check nothing is running gets no waiting line');
  assert.match(plain, /^Run jevris verify again later to read the result\.$/m);
  assert.doesNotMatch(plain, /nothing ran/);

  // Only running: the summary says so; nothing running or queued: "nothing ran" as before.
  const runningOnly = { ...payload, checks: [check('test', 'RUNNING')], missing: ['test'] };
  assert.equal((await runJson('verify', ['--check', 'test'], box, fakePorts({ answers: { verify: runningOnly } }).ports)).value.summary, 'Not verified: 1 check without a current passing receipt; 1 still running.');
  const idle = { ...payload, checks: [check('docs', 'NO_RECEIPT')], missing: ['docs'] };
  const idleText = (await run('verify', ['--check', 'docs'], box, fakePorts({ answers: { verify: idle } }).ports)).text;
  assert.match(idleText, /^Not verified: 1 check without a current passing receipt; nothing ran\.$/m);
  assert.doesNotMatch(idleText, /again later/);

  // An unapproved check id: the sidecar's reason, exit 2, and no local "not verified" answer.
  const message = 'no approved check is named nope; jevris verify profile lists the checks';
  const refusing = fakePorts({ answers: { verify: () => ({ ok: false, reason: 'rejected', reasonCode: 'UNKNOWN_CHECK', message }) } }).ports;
  const refused = await run('verify', ['--check', 'nope'], box, refusing);
  assert.equal(refused.code, 2);
  assert.match(refused.text, /^Refused \(UNKNOWN_CHECK\): No approved check is named nope; jevris verify profile lists the checks\. Nothing ran\.$/m);
  assert.doesNotMatch(refused.text, /Not verified/);
  const refusedJson = await run('verify', ['--check', 'nope', '--json'], box, refusing);
  assert.equal(refusedJson.code, 2);
  assert.match(JSON.parse(refusedJson.text).error.message, /^Refused \(UNKNOWN_CHECK\): No approved check is named nope/);
  // Any other rejection still falls back to the local reduced answer.
  const other = await runJson('verify', ['--check', 'unit'], box, fakePorts({ answers: { verify: () => ({ ok: false, reason: 'rejected', reasonCode: 'INVALID_REQUEST', message: 'bad' }) } }).ports);
  assert.equal(other.value.mode, 'reduced');
});

test('verify names a failed check\'s failing tests, at most three and "and N more", and the evidence command to read more (D 837da7e)', async (t) => {
  const box = sandbox(t);
  const handle = `ev:${'0123456789abcdef'.repeat(4)}`;
  const failed = (checkId, failure, outcome = 'failed') => ({ checkId, mandatory: true, outcome, receiptId: `r-${checkId}`, fresh: true, reasonCode: 'EXIT_NONZERO', environment: null, failure });
  const tests = Array.from({ length: 5 }, (_, i) => ({ id: `test/t${i}.test.mjs`, name: `case ${i}` }));
  const payload = {
    ran: true,
    readiness: 'not-verified',
    checks: [
      failed('test', { failedTests: [{ id: 'packages/adapter-codex/test/conformance.test.mjs', name: 'stale revision is refused' }], failedTestCount: 1, evidenceHandle: handle }),
      failed('unit', { failedTests: tests, failedTestCount: 12, evidenceHandle: handle }),
      failed('lint', { failedTests: [], failedTestCount: 0, evidenceHandle: null }, 'unknown'),
      { checkId: 'docs', mandatory: true, outcome: 'passed', receiptId: 'r-docs', fresh: true },
    ],
    missing: ['test', 'unit', 'lint'],
  };
  const ports = fakePorts({ answers: { verify: payload } }).ports;
  const json = await runJson('verify', ['--check', 'test'], box, ports);
  assert.deepEqual(json.value.result.checks[0].failure.failedTests[0], payload.checks[0].failure.failedTests[0]);
  const text = (await run('verify', ['--check', 'test'], box, ports)).text;
  assert.match(text, new RegExp(`^test failed: 1 failing test \\(packages/adapter-codex/test/conformance\\.test\\.mjs: stale revision is refused\\); details: jevris evidence get ${handle}$`, 'm'));
  assert.match(text, new RegExp(`^unit failed: 12 failing tests \\(test/t0\\.test\\.mjs: case 0; test/t1\\.test\\.mjs: case 1; test/t2\\.test\\.mjs: case 2; and 9 more\\); details: jevris evidence get ${handle}$`, 'm'));
  assert.doesNotMatch(text, /t3\.test\.mjs/, 'at most three names');
  assert.match(text, /^lint did not pass: no failing test was parsed from its output$/m, 'no handle, no details');
  assert.doesNotMatch(text, /^docs (failed|did not pass)/m, 'a passed check has no failure line');

  // The evidence command's error names the real handle form.
  const { runEvidenceCommand } = await import('../dist/public-commands.js');
  let bad = '';
  const code = await runEvidenceCommand(['get', 'not-a-handle'], (chunk) => (bad += chunk), { ports, env: box.env, cwd: box.workspace });
  assert.equal(code, 2);
  assert.match(bad, /ev:<64 hex>/);
  assert.doesNotMatch(bad, /output:abc123/);
});

test('evidence get accepts only the ev:<64 hex> handle Jevris issues, in the CLI parser and the MCP schema (JEV-0015)', async (t) => {
  const box = sandbox(t);
  const { calls, ports } = fakePorts({ answers: { 'evidence.get': { handle: `ev:${'a'.repeat(64)}`, found: false, mediaType: null, byteLength: null, truncated: false, text: null } } });
  const env = { ...box.env, JEVRIS_SIDECAR_AUTOSTART: '1' };
  const ask = async (handle) => {
    let text = '';
    const bytes = new TextEncoder().encode(JSON.stringify({ handle }));
    const code = await runSurfaceCall(['evidence.get'], (chunk) => (text += chunk), async () => bytes, { ports, env, cwd: box.workspace });
    return { code, text };
  };
  for (const bad of ['foo:bar', 'output:build-17', `ev:${'a'.repeat(63)}`, `ev:${'A'.repeat(64)}`, `ev:${'a'.repeat(65)}`, 'ev:missing']) {
    const out = await ask(bad);
    assert.equal(out.code, 2, `${bad}: ${out.text}`);
    assert.match(out.text, /ev:<64 hex>/, bad);
  }
  assert.equal(calls.filter((c) => c.kind === 'request' && c.op === 'evidence.get').length, 0, 'a refused handle reached the sidecar');
  assert.notEqual((await ask(`ev:${'a'.repeat(64)}`)).code, 2);
  const { TOOLS } = await import('../../../packages/mcp/dist/tools.js');
  const schema = TOOLS.find((tool) => tool.name === 'jevris_evidence_get').inputSchema.properties.handle;
  assert.equal(schema.pattern, '^ev:[0-9a-f]{64}$');
  assert.equal(new RegExp(schema.pattern).test('foo:bar'), false);
});

test('verify names checks that need another environment, and that is never verified (W12)', async (t) => {
  const box = sandbox(t);
  const payload = {
    ran: true,
    readiness: 'needs-environment',
    checks: [
      { checkId: 'unit', mandatory: true, outcome: 'passed', receiptId: 'r-1', fresh: true, reasonCode: null, environment: null },
      { checkId: 'device', mandatory: true, outcome: 'not-run', receiptId: null, fresh: false, reasonCode: 'HARDWARE_UNAVAILABLE', environment: 'bench-1' },
    ],
    missing: ['device'],
    needsEnvironment: ['device'],
  };
  const { ports } = fakePorts({ answers: { verify: payload } });
  const json = await runJson('verify', ['--check', 'unit', '--check', 'device'], box, ports);
  assert.equal(json.code, 1, 'needs-environment is not verified');
  assert.equal(json.value.mode, 'full');
  assert.deepEqual(json.value.result.needsEnvironment, ['device']);
  assert.equal(json.value.summary, 'Software checks verified; needs another environment: device (bench-1).');
  const plain = await run('verify', ['--check', 'unit', '--check', 'device'], box, ports);
  assert.match(plain.text, /^check device: not-run mandatory not-current receipt none reason HARDWARE_UNAVAILABLE needs bench-1$/m);
  assert.match(plain.text, /^needs another environment: device$/m);

  // The older shape (no reason, environment or needsEnvironment) is still valid.
  const older = { ran: true, readiness: 'not-verified', checks: [{ checkId: 'unit', mandatory: true, outcome: 'failed', receiptId: 'r-2', fresh: true }], missing: ['unit'] };
  const old = await runJson('verify', ['--check', 'unit'], box, fakePorts({ answers: { verify: older } }).ports);
  assert.equal(old.value.mode, 'full');
  assert.equal(old.code, 1);
});

test('evidence get passes the selection it came from (P10, D): --selection and the MCP selectionId reach evidence.get; a malformed id is refused; none is left out', async (t) => {
  const box = sandbox(t);
  const { runEvidenceCommand } = await import('../dist/public-commands.js');
  const handle = `ev:${'a'.repeat(64)}`;
  const found = { handle, found: false, mediaType: null, byteLength: null, truncated: false, text: null };
  const { calls, ports } = fakePorts({ answers: { 'evidence.get': found } });
  const env = { ...box.env, JEVRIS_SIDECAR_AUTOSTART: '1' };
  const cli = async (argv) => {
    let text = '';
    const code = await runEvidenceCommand(argv, (chunk) => (text += chunk), { ports, env, cwd: box.workspace });
    return { code, text };
  };
  await cli(['get', handle, '--selection', 'sel_42', '--json']);
  await cli(['get', handle, '--json']);
  const bodies = calls.filter((c) => c.kind === 'request' && c.op === 'evidence.get').map((c) => c.body);
  assert.deepEqual(bodies, [{ handle, selectionId: 'sel_42' }, { handle }]);
  const bad = await cli(['get', handle, '--selection', 'no/slash']);
  assert.equal(bad.code, 2, bad.text);
  // The MCP tool takes the same field, and its schema names the same pattern.
  let text = '';
  const bytes = new TextEncoder().encode(JSON.stringify({ handle, selectionId: 'sel-7' }));
  const code = await runSurfaceCall(['evidence.get'], (chunk) => (text += chunk), async () => bytes, { ports, env, cwd: box.workspace });
  assert.equal(code === 0 || code === 1, true, text);
  assert.deepEqual(calls.filter((c) => c.kind === 'request' && c.op === 'evidence.get').at(-1).body, { handle, selectionId: 'sel-7' });
  const { TOOLS } = await import('../../../packages/mcp/dist/tools.js');
  assert.equal(TOOLS.find((tool) => tool.name === 'jevris_evidence_get').inputSchema.properties.selectionId.pattern, '^[A-Za-z][A-Za-z0-9_-]{0,63}$');
  // evidence.select may answer with the selection's id (D); the payload contract accepts it.
  const { surfacePayloadContract } = await import('@jevris/contracts');
  assert.equal(surfacePayloadContract('evidence.select').validate({ intent: 'why', items: [], missing: [], truncated: false, selectionId: 'sel_42' }).ok, true);
  assert.equal(surfacePayloadContract('evidence.select').validate({ intent: 'why', items: [], missing: [], truncated: false, selectionId: 'no/slash' }).ok, false);
});

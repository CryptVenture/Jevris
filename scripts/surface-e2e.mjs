#!/usr/bin/env node
/**
 * End-to-end proof of the user-facing surfaces against a running sidecar (CMD-01..08,
 * TOOL-01..10, HKR-01): every public CLI command, every MCP tool over real stdio, and every
 * hook fixture of every harness through the launcher to the sidecar and back.
 *
 * It drives whatever product it is given: the repository build (the default) or an installed
 * tarball (scripts/pack-smoke.mjs passes the installed paths). It uses a temp HOME and a temp
 * workspace, never spawns a harness binary and never reads the real home directory.
 *
 *   node scripts/surface-e2e.mjs [--report <file>]
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { guardStdin } from './child-stdin.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Adapter packages by launcher name. */
export const HARNESS_ADAPTERS = {
  claude: 'adapter-claude-code',
  codex: 'adapter-codex',
  kilo: 'adapter-kilocode',
  opencode: 'adapter-opencode',
  agy: 'adapter-antigravity',
};

/** Launcher reasons that prove the sidecar received the event and answered. */
export const ANSWERED = new Set(['NO_RESULT', 'NO_SUBSCRIBER_RESULT', 'NO_PROPOSAL', 'NOT_CERTIFIED', 'SUBSCRIBER_QUEUED']);

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const task = (id, extra = {}) => ({
  id,
  schemaVersion: '1.0',
  workspaceId: 'ws-e2e',
  revision: 'r1',
  state: 'proposed',
  requirementIds: ['REQ-1'],
  dependencyIds: [],
  writeScopes: [`src/${id}`],
  acceptanceCheckIds: ['unit'],
  rootBudgetId: 'b1',
  ...extra,
});

/** The public CLI commands with real arguments. */
export function cliCases(work) {
  return [
    { op: 'status', argv: ['status'] },
    { op: 'plan', argv: ['plan', '--graph', join(work, 'tasks.json')], expect: (r) => r.valid === true },
    { op: 'route', argv: ['route', '--model', 'claude-opus-4-7', '--pin', 'claude-opus-4-7'], expect: (r) => r.applied === false && r.main.pinState === 'pinned' },
    { op: 'checkpoint', argv: ['checkpoint', '--objective', 'Ship the e2e', '--constraint', 'No new dependencies'], expect: (r) => r.compactionTriggered === false },
    { op: 'recover', argv: ['recover', '--failure', 'boom', '--failure', 'boom'] },
    { op: 'verify', argv: ['verify', '--check', 'unit'], expect: (r) => r.readiness !== 'verified' || r.ran === true },
    { op: 'explain', argv: ['explain', 'd-e2e-none'], expect: (r) => r.found === false },
    { op: 'configure', argv: ['configure'], local: true, expect: (r) => r.valid === true },
  ];
}

/** Valid arguments for every MCP tool. */
export function toolCases() {
  return {
    jevris_status: {},
    jevris_explain_decision: { decisionId: 'd-e2e-none' },
    jevris_plan_route: { currentModel: 'claude-opus-4-7', modelPin: 'claude-opus-4-7' },
    jevris_select_evidence: { intent: 'the e2e checkpoint', maxItems: 4 },
    jevris_evidence_get: { handle: `ev:${'e'.repeat(64)}` },
    jevris_checkpoint: { objective: 'Ship the e2e over MCP', constraints: ['Keep the pin'] },
    jevris_get_task: { taskId: 'a' },
    jevris_record_verification: { receiptId: 'r-e2e', checkId: 'unit' },
    jevris_submit_task: { task: task('owned') },
    jevris_handoff_export: {},
    jevris_handoff_import: null, // filled from the export
    jevris_plan: { tasks: [task('a'), task('b', { dependencyIds: ['a'] })] },
    jevris_recover: { fingerprints: ['boom', 'boom'], environment: [false, false] },
    jevris_verify: { checkIds: ['unit'] },
    jevris_configure: {},
    jevris_delivery_report: { capabilityId: 'C57', input: { unresolvedComments: 1 } },
    jevris_advise: { capabilityId: 'C28' },
  };
}

function run(file, args, { env, cwd, input = '', timeoutMs = 60_000 }) {
  const result = spawnSync(process.execPath, [file, ...args], { env, cwd, input, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Where a fixture's workspace lives: point it at the temp workspace. */
export function localize(native, work) {
  if (native === null || typeof native !== 'object' || Array.isArray(native)) return native;
  const copy = structuredClone(native);
  if (typeof copy.cwd === 'string') copy.cwd = work;
  if (Array.isArray(copy.workspacePaths)) copy.workspacePaths = [work];
  return copy;
}

async function mcpClient(mcpPath, env, cwd) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcpPath], env, cwd, stderr: 'ignore' });
  const client = new Client({ name: 'jevris-e2e', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

/** Raw initialize with one requested version; returns the negotiated version. */
function negotiate(mcpPath, env, cwd, requested) {
  return new Promise((resolve, reject) => {
    const child = guardStdin(spawn(process.execPath, [mcpPath], { env, cwd, stdio: ['pipe', 'pipe', 'ignore'] }));
    let buffer = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('initialize timed out'));
    }, 20_000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const at = buffer.indexOf('\n');
      if (at === -1) return;
      clearTimeout(timer);
      child.kill();
      resolve(JSON.parse(buffer.slice(0, at)).result?.protocolVersion ?? null);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: requested, capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } })}\n`);
  });
}

/** The mock Jev server, run in its own process: the scenario drives the CLI with spawnSync,
 * which blocks this process, so a server here could not answer the sidecar meanwhile. */
const MOCK_PROVIDER_SERVER = `
import { createServer } from 'node:http';
const provider = await import(process.argv[1]);
const mock = provider.createMockFetch({});
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    try {
      if (req.url === '/__e2e/calls') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ calls: mock.calls }));
        return;
      }
      const headers = {};
      for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers[key] = value;
      const answer = await mock('https://api.typesafe.ai' + req.url, { method: req.method, headers, body: Buffer.concat(chunks).toString('utf8') });
      const out = Buffer.from(await answer.arrayBuffer());
      const sent = {};
      answer.headers.forEach((value, key) => (sent[key] = value));
      res.writeHead(answer.status, sent);
      res.end(out);
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
});
server.listen(0, '127.0.0.1', () => process.stdout.write(JSON.stringify({ port: server.address().port }) + '\\n'));
process.stdin.on('end', () => server.close(() => process.exit(0)));
process.stdin.resume();
`;

/**
 * Serves `createMockFetch` (the Jev conformance mock, from `providerModule`) on a loopback port
 * in a child process, for the JEVRIS_TEST_PROVIDER_URL override. Returns the base URL, an async
 * request count and a close().
 */
export async function startMockProvider(providerModule) {
  const child = guardStdin(spawn(process.execPath, ['--input-type=module', '-e', MOCK_PROVIDER_SERVER, providerModule], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true }));
  const port = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('the mock Jev did not start')), 15000);
    child.once('exit', () => reject(new Error('the mock Jev exited')));
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const at = buffer.indexOf('\n');
      if (at < 0) return;
      clearTimeout(timer);
      resolve(JSON.parse(buffer.slice(0, at)).port);
    });
  });
  const url = `http://127.0.0.1:${port}`;
  const calls = async () => {
    try {
      const answer = await fetch(`${url}/__e2e/calls`);
      return (await answer.json()).calls;
    } catch {
      return 0;
    }
  };
  const close = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => child.kill(), 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin.end();
    });
  return { url, calls, close };
}

/**
 * Runs the scenario twice: rules-only (no Jev key) and against the mock Jev through the test
 * provider override (steps prefixed "mock: "). `product` names the entry points to drive;
 * `load(pkg)` imports a repo package (contracts and adapters); `providerModule` is the URL of
 * the provider package whose mock Jev the second pass uses.
 */
export async function surfaceE2E(product, options = {}) {
  const load = options.load ?? ((pkg) => import(pathToFileURL(join(repoRoot, 'packages', pkg, 'dist', 'index.js')).href));
  const rules = await onePass(product, options, load, '', {});
  if (options.mock === false) return rules;
  const mock = await startMockProvider(options.providerModule ?? pathToFileURL(join(repoRoot, 'packages', 'provider-typesafe', 'dist', 'index.js')).href);
  try {
    const mocked = await onePass(product, options, load, 'mock: ', { JEVRIS_TEST_PROVIDER_URL: mock.url, JEVRIS_TEST_PROVIDER_KEY: 'e2e-test-key' });
    const calls = await mock.calls();
    const steps = [...rules.steps, ...mocked.steps, { name: 'mock: the mock Jev received decision calls', ok: calls > 0, detail: `${calls} calls` }];
    return { ok: steps.every((step) => step.ok), steps };
  } finally {
    await mock.close();
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function onePass(product, options, load, prefix, extraEnv) {
  const contracts = await load('contracts');
  const steps = [];
  const record = (name, ok, detail = '') => {
    steps.push({ name: `${prefix}${name}`, ok: Boolean(ok), detail: String(detail).slice(0, 500) });
    return Boolean(ok);
  };
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-e2e-')));
  const home = join(dir, 'home');
  const work = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(join(work, '.git'), { recursive: true });
  writeFileSync(join(work, 'tasks.json'), JSON.stringify([task('a'), task('b', { dependencyIds: ['a'] })]));
  // The caller's environment (including a test runner's keyring guard and NODE_OPTIONS preload),
  // minus any Jevris or harness setting that would change the scenario, with a temp HOME.
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue;
    if (/^(JEVRIS_|CLAUDE_|CODEX_|XDG_)/.test(key) && !/^JEVRIS_(TEST|NO_LIVE_HARNESS|HARNESS_STUB_DIR|STUB_LOG)/.test(key)) continue;
    env[key] = value;
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    JEVRIS_HOME: home,
    JEVRIS_BIN: product.bin,
    CLAUDE_PROJECT_DIR: work,
    ...(options.env ?? {}),
    ...extraEnv,
  });

  const jevris = (argv, input) => run(product.bin, argv, { env, cwd: work, input });
  try {
    // A first start of a fresh install is a cold start: on windows-latest it outlasted the
    // command's 5 s default while the same product's next start took less. This checks that the
    // sidecar starts and answers, not how fast (the bench measures start times).
    const started = jevris(['sidecar', 'start', '--home', home, '--wait-ms', '30000']);
    if (!record('sidecar starts', started.code === 0, started.stdout + started.stderr)) return { ok: false, steps };

    // CLI: every public command, contract-valid and answered by the sidecar.
    for (const c of cliCases(work)) {
      const out = jevris([...c.argv, '--json']);
      let value = null;
      try {
        value = JSON.parse(out.stdout);
      } catch {
        value = null;
      }
      const valid = value !== null && contracts.surfaceResultContract(c.op).validate(value).ok;
      const answered = value !== null && (c.local === true ? value.sidecar.reasonCode === null : value.mode === 'full' && value.sidecar.state === 'running');
      const expected = value !== null && (c.expect === undefined || c.expect(value.result));
      record(`cli ${c.op}`, valid && answered && expected, value === null ? out.stdout + out.stderr : `${value.mode} ${value.sidecar.state} ${value.sidecar.reasonCode ?? ''} ${value.summary}`);
    }
    // Verification: approving checks needs a person at a terminal (SR-1), so the CLI refuses a
    // scripted approval; the checks are then approved as the CLI records them after a y answer,
    // and run.
    writeFileSync(join(work, 'jevris.checks.json'), JSON.stringify({ schemaVersion: 'jevris-checks-1', checks: [{ id: 'unit', argv: [process.execPath, '-e', 'process.exit(0)'] }] }));
    const scripted = jevris(['verify', 'approve', '--yes', '--json']);
    record('cli verify approve refuses --yes', scripted.code === 2 && scripted.stdout.includes('CHANNEL_REFUSED'), scripted.stdout + scripted.stderr);
    const orchestrator = await load('orchestrator');
    const proposed = orchestrator.readProposedManifests(work, process.platform);
    const approval = proposed.ok ? await orchestrator.approveManifests(orchestrator.openWorkspace({ home, workspaceRoot: work, platform: process.platform }), proposed.manifests, proposed.hashes, 'cli', Date.now()) : null;
    record('verify approve (as a person at a terminal)', approval !== null && Object.keys(approval.hashes).join(',') === 'unit', proposed.ok ? '' : proposed.reason);
    // `jevris verify` answers inside a window of the request (40% of its deadline) and the run goes on after it. On a loaded host the answer is
    // not the result: it lists the check as running or queued, or as STALE (the freshness read missed the window), or says verified with
    // ran=false (the receipt is written and the run's own end is not). Asking again does not read the result: a run that has ended leaves
    // a current receipt, and the next ask starts another run that misses the window the same way, so no ask answers ran=true (the
    // slow-host gate: seven asks, each "verified ran=false"). So: ask once, wait until the sidecar has no verification run under way (its
    // status says `verificationRuns` 0), and when the answer did not hold the result read the receipt through the read-only `verify required`,
    // which runs nothing.
    const parseVerify = (out) => {
      try {
        return JSON.parse(out.stdout);
      } catch {
        return null;
      }
    };
    const holdsResult = (answer) =>
      answer?.result?.ran === true && answer.result.readiness === 'verified' && Array.isArray(answer.result.checks) && answer.result.checks.every((check) => !['RUNNING', 'QUEUED', 'STALE'].includes(check.reasonCode));
    const ran = jevris(['verify', '--check', 'unit', '--json']);
    const verified = parseVerify(ran);
    let afterRun = null;
    if (verified !== null) {
      const giveUpAt = Date.now() + 120_000;
      while (parseVerify(jevris(['sidecar', 'status', '--json']))?.verificationRuns !== 0 && Date.now() < giveUpAt) await new Promise((resolve) => setTimeout(resolve, 100));
      if (!holdsResult(verified)) afterRun = jevris(['verify', 'required', 'unit', '--json']);
    }
    record(
      'cli verify runs an approved check',
      verified !== null && verified.mode === 'full' && contracts.surfaceResultContract('verify').validate(verified).ok && (holdsResult(verified) || (afterRun !== null && afterRun.code === 0 && afterRun.stdout.includes('"status":"passed"'))),
      verified === null ? ran.stdout + ran.stderr : `${verified.mode} ${verified.result.readiness} ran=${verified.result.ran} ${verified.summary}${afterRun === null ? '' : `; after the run: ${afterRun.code} ${afterRun.stdout.slice(0, 200)}`}`,
    );
    const required = jevris(['verify', 'required', 'unit', '--json']);
    record('cli verify required', required.code === 0 && required.stdout.includes('"status":"passed"'), required.stdout + required.stderr);
    // DLV-01: the readiness report reads the receipts just written and the task graph; it is
    // advice only (every guard false) and names the mandatory check it kept.
    const readiness = jevris(['delivery', 'pr-readiness', '--json']);
    let pr = null;
    try {
      pr = JSON.parse(readiness.stdout);
    } catch {
      pr = null;
    }
    record(
      'cli delivery pr-readiness',
      pr !== null && pr.mode === 'full' && contracts.surfaceResultContract('capability.advise').validate(pr).ok && pr.result.capabilityId === 'C57' && pr.result.kept.includes('unit') && pr.result.requiresApproval === true && Object.values(pr.result.guards).every((flag) => flag === false),
      pr === null ? readiness.stdout + readiness.stderr : `${pr.mode} ${pr.result.recommendation} ${pr.summary}`,
    );
    // US22: D's capabilities through the same op; advice only (every guard false).
    const advised = jevris(['advise', 'C41', '--input', '{"base":"HEAD"}', '--json']);
    let advice = null;
    try {
      advice = JSON.parse(advised.stdout);
    } catch {
      advice = null;
    }
    record(
      'cli advise C41',
      advice !== null && advice.mode === 'full' && contracts.surfaceResultContract('capability.advise').validate(advice).ok && advice.result.capabilityId === 'C41' && Object.values(advice.result.guards).every((flag) => flag === false),
      advice === null ? advised.stdout + advised.stderr : `${advice.mode} ${advice.result.reasonCode} ${advice.summary}`,
    );

    // US12: a real decision explains requested and observed model apart; nothing observed
    // the worker here, so observed is unknown and no cost precision is claimed.
    const override = Object.hasOwn(extraEnv, 'JEVRIS_TEST_PROVIDER_URL');
    // The decision id comes from the engine's journal in the temp home (status lists store
    // rows only). The mock pass always has one: recover consulted the mock Jev.
    const { jevrisPaths } = await load('platform');
    let journal = [];
    try {
      journal = readdirSync(join(jevrisPaths({ home }).data, 'decisions')).filter((name) => /^d-[A-Za-z0-9-]+\.json$/.test(name)).sort();
    } catch {
      journal = [];
    }
    if (override || journal.length > 0) {
      const id = journal[0]?.slice(0, -'.json'.length);
      const explained = id === undefined ? null : parseJson(jevris(['explain', id, '--json']).stdout);
      const models = explained?.result?.trace?.models;
      record(
        'cli explain keeps requested and observed model apart',
        explained !== null && explained.mode === 'full' && contracts.surfaceResultContract('explain').validate(explained).ok && models !== undefined && models.observed === null && models.costPrecision === 'unknown' && /Worker model: requested/.test(explained.result.trace.rendered),
        id === undefined ? 'no decision in the journal' : JSON.stringify(models ?? explained),
      );
    }

    const human = jevris(['status']);
    record('cli status names the provider', human.code === 0 && human.stdout.includes('test provider override active') === override, human.stdout.split('\n').slice(-3).join(' | '));

    for (const argv of [['--help'], ['--version'], ['help', 'verify'], ['help', 'evidence']]) {
      const out = jevris(argv);
      record(`cli ${argv.join(' ')}`, out.code === 0 && out.stdout.length > 0 && !out.stdout.includes('npx jevris'), out.stderr);
    }

    // MCP: protocol negotiation, then every tool over stdio with output-schema validation.
    for (const version of [...PROTOCOL_VERSIONS, '1999-01-01']) {
      const got = await negotiate(product.mcp, env, work, version).catch((error) => error.message);
      record(`mcp initialize ${version}`, got === (PROTOCOL_VERSIONS.includes(version) ? version : PROTOCOL_VERSIONS[0]), got);
    }
    // Owned mode is a CLI-only workspace setting; it lets MCP submit owned work (task.submit only).
    // Turning it on needs a person at a terminal (SR-1): the CLI refuses --yes, and the setting is
    // then written as the CLI writes it after a y answer.
    const scriptedOwned = jevris(['configure', 'owned-mode', 'on', '--yes', '--json']);
    record('cli configure owned-mode on refuses --yes', scriptedOwned.code === 2 && scriptedOwned.stdout.includes('CHANNEL_REFUSED'), scriptedOwned.stdout + scriptedOwned.stderr);
    const ownedSet = await orchestrator.setOwnedMode({ home, workspaceId: orchestrator.workspaceIdFor(work, process.platform), enabled: true, channel: 'cli', actor: 'e2e', nowMs: Date.now() });
    const owned = jevris(['configure', 'owned-mode', '--json']);
    record('cli configure owned-mode on', ownedSet.ok === true && owned.code === 0 && owned.stdout.includes('"enabled":true'), owned.stdout + owned.stderr);
    // Owned work starts from the CLI: a plan under a root budget (plan.submit, CLI-only).
    writeFileSync(join(work, 'owned-plan.json'), JSON.stringify({ tasks: [task('p1', { expectedOutputs: ['p1'] }), task('p2', { dependencyIds: ['p1'], expectedOutputs: ['p2'] })] }));
    // A new root budget needs a person (SR-1): a scripted --yes is refused and creates nothing;
    // with the single-use authorization `jevris authorize budget.increase --scope e2e-budget`
    // mints at a terminal (its sidecar request, sent here for the sandbox user), it is accepted.
    const scriptedPlan = jevris(['plan', '--submit', '--graph', join(work, 'owned-plan.json'), '--budget', 'e2e-budget', '--limit-micro-usd', '1000000', '--owner', 'e2e', '--yes', '--json']);
    record('cli plan --submit refuses a new budget without a person', scriptedPlan.code === 2 && parseJson(scriptedPlan.stdout)?.reasonCode === 'CHANNEL_REFUSED', scriptedPlan.stdout + scriptedPlan.stderr);
    const cleanedUser = (env.USER ?? env.USERNAME ?? 'cli').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 63);
    const mintScript = `const { sidecarRequest } = await import(${JSON.stringify(pathToFileURL(join(repoRoot, 'apps', 'sidecar', 'dist', 'index.js')).href)}); const r = await sidecarRequest({ home: process.env.JEVRIS_HOME, op: 'authorization.mint', scope: 'cli', workspace: ${JSON.stringify(work)}, body: { actionClass: 'budget.increase', scope: 'e2e-budget', ttlMs: 300000, actor: ${JSON.stringify(/^[A-Za-z]/.test(cleanedUser) ? cleanedUser : `u${cleanedUser}`.slice(0, 64))}, channel: 'terminal' }, timeoutMs: 30000 }); process.stdout.write(JSON.stringify(r));`;
    const minted = parseJson(spawnSync(process.execPath, ['--input-type=module', '-e', mintScript], { env, cwd: work, encoding: 'utf8', timeout: 60_000, windowsHide: true }).stdout ?? '');
    record('sidecar authorization.mint budget.increase', minted?.ok === true && typeof minted.result?.authorizationId === 'string', JSON.stringify(minted));
    const submitted = jevris(['plan', '--submit', '--graph', join(work, 'owned-plan.json'), '--budget', 'e2e-budget', '--limit-micro-usd', '1000000', '--owner', 'e2e', '--authorization', String(minted?.result?.authorizationId ?? 'none'), '--yes', '--json']);
    const plan = parseJson(submitted.stdout);
    const rootBudgetId = plan?.rootBudgetId ?? null;
    record(
      'cli plan --submit',
      submitted.code === 0 && plan?.accepted === true && /^plan-[0-9a-f]{20}$/.test(plan.planId) && rootBudgetId === 'e2e-budget' && JSON.stringify(plan.taskIds) === '["p1","p2"]',
      submitted.stdout + submitted.stderr,
    );
    const client = await mcpClient(product.mcp, env, work);
    try {
      const { tools } = await client.listTools();
      const cases = toolCases();
      record('mcp tools/list', tools.length === Object.keys(cases).length && tools.every((tool) => Object.hasOwn(cases, tool.name) && typeof tool.outputSchema === 'object'), tools.map((tool) => tool.name).join(' '));
      let exported = null;
      for (const name of Object.keys(cases)) {
        // The owned task joins the submitted plan's budget, after one of its tasks.
        const args = name === 'jevris_handoff_import' ? { capsule: exported } : name === 'jevris_submit_task' ? { task: task('owned', { dependencyIds: ['p1'], expectedOutputs: ['owned'], rootBudgetId: rootBudgetId ?? 'b1' }) } : cases[name];
        // The SDK client validates structuredContent against the tool's outputSchema.
        const answer = await client.callTool({ name, arguments: args }).catch((error) => ({ thrown: error.message }));
        if ('thrown' in answer) {
          record(`mcp ${name}`, false, answer.thrown);
          continue;
        }
        const value = answer.structuredContent;
        if (name === 'jevris_handoff_export') exported = value?.result?.capsule ?? null;
        if (name === 'jevris_submit_task') record('mcp owned task accepted under the submitted plan', value?.result?.accepted === true && value.result.taskId === 'owned', JSON.stringify(value?.result ?? answer.content).slice(0, 300));
        const local = name === 'jevris_configure';
        const answered = value !== undefined && (local ? value.sidecar.reasonCode === null : value.mode === 'full' && value.sidecar.state === 'running');
        const mirrored = value !== undefined && answer.content?.[0]?.text === JSON.stringify(value);
        record(`mcp ${name}`, answer.isError === false && answered && mirrored, value === undefined ? JSON.stringify(answer.content).slice(0, 300) : `${value.mode} ${value.sidecar.reasonCode ?? ''} ${value.summary}`);
      }
      const refused = await client.callTool({ name: 'jevris_status', arguments: { home: '/elsewhere' } });
      record('mcp refuses a model-supplied home', refused.isError === true && refused.structuredContent === undefined, JSON.stringify(refused.content));
    } finally {
      await client.close();
    }

    // Hooks: every fixture of every harness through the launcher to the sidecar and back.
    const hookEnv = { ...env, JEVRIS_HOOK_DEBUG: '1', JEVRIS_HOOK_DEADLINE_MS: '4000' };
    for (const [launcher, pkg] of Object.entries(HARNESS_ADAPTERS)) {
      const adapter = await load(pkg);
      for (const fx of adapter.FIXTURES.filter((f) => f.refusal === undefined && f.kind !== null)) {
        const native = localize(fx.native, work);
        const args = ['--harness', launcher, ...(fx.hookKey !== undefined ? ['--event', fx.hookKey] : [])];
        const normalized = adapter.normalize(native, fx.hookKey !== undefined ? { hookKey: fx.hookKey } : {});
        const rendered = adapter.protocolResponse(normalized.ok ? normalized.event : null, { kind: 'observe' });
        // The launcher writes the adapter's rendering as one line.
        const expected = rendered === '' ? '' : `${rendered}\n`;
        // VER-05: a stop in a workspace whose approved checks have no current passing receipt is
        // answered with the orchestrator's verification reminder, rendered by the adapter as an
        // explain outcome (Claude and Codex: one systemMessage line). The e2e workspace changed
        // after `verify --check unit`, so its receipt is stale and the reminder is expected here.
        const stopReminder = (reason, stdout) => {
          if (!normalized.ok || normalized.event.kind !== 'turn.stopped' || reason !== 'PROPOSED_BY_ORCHESTRATOR') return false;
          let text;
          try {
            text = JSON.parse(stdout).systemMessage;
          } catch {
            return false;
          }
          return typeof text === 'string' && /^(Missing verification evidence|Unverified): /.test(text) && stdout === `${adapter.protocolResponse(normalized.event, { kind: 'explain', text })}\n`;
        };
        // GOV-12/13: the sidecar's security subscriber answers a risky proposed call (a fixture
        // runs `rm -rf /`) or an untrusted tool result with a one-line explain: advice, never a
        // permission decision. Its stdout must be exactly the adapter's explain rendering of a
        // "Jevris: " text.
        const findText = (value) => {
          if (typeof value === 'string') return value.startsWith('Jevris: ') ? value : null;
          if (value === null || typeof value !== 'object') return null;
          for (const item of Object.values(value)) {
            const found = findText(item);
            if (found !== null) return found;
          }
          return null;
        };
        const securityAdvice = (reason, stdout) => {
          if (!normalized.ok || !['tool.proposed', 'tool.finished', 'tool.failed'].includes(normalized.event.kind) || reason !== 'PROPOSED_BY_SECURITY') return false;
          let text = null;
          try {
            text = findText(JSON.parse(stdout));
          } catch {
            text = stdout.trim().startsWith('Jevris: ') ? stdout.trim() : null;
          }
          return text !== null && !/permissionDecision|"deny"|"block"/.test(stdout) && stdout === `${adapter.protocolResponse(normalized.event, { kind: 'explain', text })}\n`;
        };
        // G4/G5 (D, R31): on Kilo, OpenCode and Antigravity an answer that came due on an event the
        // harness does not show is queued per session, and the session's next showing event
        // (task.requested on Kilo and OpenCode, invocation.started on Antigravity) carries it once:
        // one line in `system` or one `injectSteps` ephemeral message, never a permission decision.
        const displayFlush = (reason, stdout) => {
          if (!normalized.ok || reason !== 'PROPOSED_BY_ORCHESTRATOR' || !['task.requested', 'invocation.started'].includes(normalized.event.kind)) return false;
          let parsed;
          try {
            parsed = JSON.parse(stdout);
          } catch {
            return false;
          }
          const lines = Array.isArray(parsed?.system) ? parsed.system : Array.isArray(parsed?.injectSteps) ? parsed.injectSteps.map((step) => step?.ephemeralMessage) : null;
          return Array.isArray(lines) && lines.length === 1 && typeof lines[0] === 'string' && !/permissionDecision|"deny"|"block"/.test(stdout);
        };
        const reasons = [];
        const stdouts = [];
        let outputs = true;
        for (let delivery = 0; delivery < 2; delivery += 1) {
          const out = run(product.hook, args, { env: hookEnv, cwd: work, input: JSON.stringify(native), timeoutMs: 20_000 });
          const reason = /jevris-hook \S+ (\S+)/.exec(out.stderr)?.[1] ?? 'none';
          reasons.push(reason);
          stdouts.push(out.stdout);
          // D's answer replay: the retry of an answer delivered in time renders that same answer.
          outputs = outputs && out.code === 0 && (out.stdout === expected || (delivery === 0 && (stopReminder(reason, out.stdout) || securityAdvice(reason, out.stdout) || displayFlush(reason, out.stdout))) || (delivery === 1 && out.stdout === stdouts[0]));
        }
        // The retry is a duplicate: observed as before, or the first answer replayed unchanged.
        const retried = reasons[1] === 'DUPLICATE_DELIVERY' || (reasons[1] === 'DUPLICATE_REPLAYED' && stdouts[1] === stdouts[0]);
        const firstOk =
          ANSWERED.has(reasons[0]) ||
          (normalized.ok && normalized.event.kind === 'turn.stopped' && reasons[0] === 'PROPOSED_BY_ORCHESTRATOR') ||
          (normalized.ok && ['tool.proposed', 'tool.finished', 'tool.failed'].includes(normalized.event.kind) && reasons[0] === 'PROPOSED_BY_SECURITY') ||
          (normalized.ok && ['task.requested', 'invocation.started'].includes(normalized.event.kind) && reasons[0] === 'PROPOSED_BY_ORCHESTRATOR');
        const ok = normalized.ok && firstOk && retried && outputs;
        record(`hook ${launcher} ${fx.id}`, ok, `${reasons.join(' then ')}${outputs ? '' : ' (unexpected protocol output)'}`);
      }
    }
  } finally {
    jevris(['sidecar', 'stop', '--home', home]);
    if (options.keep !== true) rmSync(dir, { recursive: true, force: true });
  }
  return { ok: steps.every((step) => step.ok), steps };
}

function isMain() {
  const entry = process.argv[1];
  return typeof entry === 'string' && pathToFileURL(entry).href === import.meta.url;
}

if (isMain()) {
  const at = process.argv.indexOf('--report');
  const report = await surfaceE2E({
    bin: join(repoRoot, 'bin', 'jevris.mjs'),
    mcp: join(repoRoot, 'plugins', 'shared', 'mcp.js'),
    hook: join(repoRoot, 'dist', 'hook.mjs'),
  });
  for (const step of report.steps) console.log(`${step.ok ? 'ok  ' : 'FAIL'} ${step.name}${step.ok ? '' : `: ${step.detail}`}`);
  console.log(`${report.steps.filter((s) => s.ok).length}/${report.steps.length} passed`);
  if (at !== -1 && process.argv[at + 1] !== undefined) writeFileSync(process.argv[at + 1], `${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
}

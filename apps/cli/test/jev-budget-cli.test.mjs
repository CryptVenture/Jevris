// Owner decision 2026-09-29: the Jev decision budget from the CLI.
// - `jevris configure set decisions.monthlyBudgetMicroUsd`: a raise needs a person at an
//   interactive terminal (a pipe, --yes, --json and JEVRIS_TEST=1 are refused with
//   CHANNEL_REFUSED); lowering never asks.
// - `jevris configure workspace-budget`: the same rules for this workspace's own cap.
// - `jevris status`, `jevris cost-report` and `jevris doctor` show the month's spend, the caps
//   and the reset date. Fake ports only: no sidecar process, no harness, no keychain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.JEVRIS_SIDECAR_AUTOSTART = '0';

const { runPublicCommand } = await import('../dist/public-commands.js');
const { checkCostReport, renderCostReport } = await import('../dist/cost-report.js');
const { jevCircuitDoctorLinesFrom } = await import('../dist/jev-circuit-doctor.js');
const { doctorLineSeverity } = await import('../dist/doctor-severity.js');
const { jevBudgetLines } = await import('../dist/public/render.js');
const orchestrator = await import('@jevris/orchestrator');
const { DecisionBudget } = await import('@jevris/core');
const { surfacePayloadContract } = await import('@jevris/contracts');
const { jevrisPaths } = await import('@jevris/platform');

const KEY = 'decisions.monthlyBudgetMicroUsd';
const NOW = Date.UTC(2026, 8, 25, 12);
const NOT_RUNNING = { ok: false, reason: 'unavailable', reasonCode: 'NOT_RUNNING', message: 'The Jevris sidecar is not running.' };

function sandbox(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-budget-cli-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const workspace = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(join(workspace, '.git'), { recursive: true });
  return { dir, home, workspace, env: { JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0' } };
}

/** No sidecar; D's real setter, so configure set runs the product's own path. */
function ports(answers = {}) {
  return {
    sidecar: {
      ensure: async () => ({ ok: true, endpoint: 'fake', started: false }),
      request: async (input) => (answers[input.op] === undefined ? NOT_RUNNING : { ok: true, result: answers[input.op] }),
    },
    engine: {},
    config: { setConfigValue: orchestrator.setConfigValue },
  };
}

async function run(box, name, argv, extra = {}) {
  let text = '';
  const code = await runPublicCommand(name, argv, (chunk) => (text += chunk), { ports: extra.ports ?? ports(), env: extra.env ?? box.env, cwd: box.workspace, nowMs: () => NOW, ...(extra.terminal === undefined ? {} : { interactive: () => true, confirm: async (q) => (extra.terminal.asked.push(q), extra.terminal.answer) }) });
  return { code, text };
}

const atTerminal = (answer = true) => ({ asked: [], answer });

test('configure set decisions.monthlyBudgetMicroUsd: a raise needs a person at a terminal; every other channel is refused', async (t) => {
  const box = sandbox(t);
  const refusal = (value) => `Nothing was changed (CHANNEL_REFUSED): raising ${KEY} to ${value} lets Jevris spend more on Jev calls, so it needs a person at an interactive terminal who answers y (never --yes, --json, MCP, a hook, a script, a pipe or a model's shell).\n`;
  const shown = JSON.parse((await run(box, 'configure', ['--json'])).text).result;
  assert.equal(shown.effective.monthlyBudgetMicroUsd, 5_000_000, 'the default is 5 USD');
  assert.match((await run(box, 'configure', [])).text, /^jev monthly budget: 5000000 micro-USD \(5\.00 USD\), machine-wide$/m);
  const never = atTerminal();
  // A pipe, --yes at a terminal, --json at a terminal and a test run: refused, nothing asked or written.
  assert.deepEqual(Object.values(await run(box, 'configure', ['set', KEY, '8000000'])), [2, refusal('8000000')]);
  assert.deepEqual(Object.values(await run(box, 'configure', ['set', KEY, '8000000', '--yes'], { terminal: never })), [2, refusal('8000000')]);
  const json = await run(box, 'configure', ['set', KEY, '8000000', '--json'], { terminal: never });
  assert.deepEqual([json.code, JSON.parse(json.text)], [2, { error: { code: 'CHANNEL_REFUSED', message: refusal('8000000').trim() } }]);
  assert.equal((await run(box, 'configure', ['set', KEY, '8000000'], { terminal: never, env: { ...box.env, JEVRIS_TEST: '1' } })).code, 2);
  assert.deepEqual(never.asked, []);
  assert.equal(orchestrator.machineJevBudget({ home: box.home }), 5_000_000, 'nothing was written');
  // A person who says no: nothing changes. One who says y: written.
  const no = atTerminal(false);
  assert.deepEqual(Object.values(await run(box, 'configure', ['set', KEY, '8000000'], { terminal: no })), [2, 'Nothing was changed.\n']);
  assert.deepEqual(no.asked, [`Raise ${KEY} to 8000000? It lets Jevris spend more on Jev calls. [y/N] `]);
  const yes = atTerminal(true);
  assert.equal((await run(box, 'configure', ['set', KEY, '8000000'], { terminal: yes })).code, 0);
  assert.equal(orchestrator.machineJevBudget({ home: box.home }), 8_000_000);
  // Lowering never asks, even with --yes or --json, and 0 says it means rules-only.
  assert.equal((await run(box, 'configure', ['set', KEY, '2000000', '--yes'])).code, 0);
  const zero = await run(box, 'configure', ['set', KEY, '0']);
  assert.equal(zero.code, 0);
  assert.match(zero.text, /^jev monthly budget: 0 micro-USD \(0\.00 USD\), machine-wide; 0 means no Jev calls, decisions run rules-only$/m);
  // Out of range, a fraction or a unit: refused as a value.
  for (const bad of ['1000000001', '1.5', '5USD', '-1']) assert.equal((await run(box, 'configure', ['set', KEY, bad])).code, 2, bad);
});

test('configure set without D\'s setter (the local fallback) follows the same raise and lower rules', async (t) => {
  const box = sandbox(t);
  const local = { ...ports(), config: {} };
  assert.equal((await run(box, 'configure', ['set', KEY, '6000000'], { ports: local })).code, 2);
  const set = JSON.parse((await run(box, 'configure', ['set', KEY, '6000000', '--json'], { ports: local, terminal: atTerminal() })).text);
  assert.equal(set.error.code, 'CHANNEL_REFUSED', '--json is refused even at a terminal');
  assert.equal((await run(box, 'configure', ['set', KEY, '6000000'], { ports: local, terminal: atTerminal() })).code, 0);
  const lowered = JSON.parse((await run(box, 'configure', ['set', KEY, '1000000', '--json'], { ports: local })).text);
  assert.deepEqual(lowered.result.changed, [{ key: KEY, from: '6000000', to: '1000000' }]);
  assert.equal(lowered.result.effective.monthlyBudgetMicroUsd, 1_000_000);
});

test('configure workspace-budget: a first cap and a lower one are free; a raise or none needs a person at a terminal', async (t) => {
  const box = sandbox(t);
  const workspaceId = orchestrator.workspaceIdFor(box.workspace);
  const show = await run(box, 'configure', ['workspace-budget']);
  assert.equal(show.code, 0);
  assert.match(show.text, /has no cap of its own: its Jev decisions share the machine-wide limit/);
  assert.match(show.text, /Machine-wide limit: 5000000 micro-USD \(5\.00 USD\)/);
  // A first cap: no question.
  const first = JSON.parse((await run(box, 'configure', ['workspace-budget', '1000000', '--json'])).text);
  assert.deepEqual([first.command, first.result.capMicroUsd, first.result.changed, first.result.workspaceId], ['configure workspace-budget', 1_000_000, true, workspaceId]);
  assert.equal(orchestrator.workspaceJevBudget({ home: box.home, workspaceId, workspaceRoot: box.workspace }).capMicroUsd, 1_000_000);
  // Lower: free, even with --yes.
  assert.equal((await run(box, 'configure', ['workspace-budget', '500000', '--yes'])).code, 0);
  // A raise and none, from each refused channel.
  const refusal = (target) => `Nothing was changed (CHANNEL_REFUSED): raising this workspace's Jev decision cap to ${target} lets Jevris spend more on Jev calls, so it needs a person at an interactive terminal who answers y (never --yes, --json, MCP, a hook, a script, a pipe or a model's shell).\n`;
  const never = atTerminal();
  for (const target of ['900000', 'none']) {
    assert.deepEqual(Object.values(await run(box, 'configure', ['workspace-budget', target])), [2, refusal(target)]);
    assert.deepEqual(Object.values(await run(box, 'configure', ['workspace-budget', target, '--yes'], { terminal: never })), [2, refusal(target)]);
    const json = await run(box, 'configure', ['workspace-budget', target, '--json'], { terminal: never });
    assert.deepEqual(JSON.parse(json.text), { error: { code: 'CHANNEL_REFUSED', message: refusal(target).trim() } });
    assert.equal((await run(box, 'configure', ['workspace-budget', target], { terminal: never, env: { ...box.env, JEVRIS_TEST: '1' } })).code, 2);
    // A dry run shows it and asks nobody.
    assert.equal((await run(box, 'configure', ['workspace-budget', target, '--dry-run'])).code, 0);
  }
  assert.deepEqual(never.asked, []);
  assert.equal(orchestrator.readWorkspaceJevBudgetCap(box.home, workspaceId).record.capMicroUsd, 500_000, 'nothing was written');
  // A person at a terminal.
  const yes = atTerminal(true);
  const raised = await run(box, 'configure', ['workspace-budget', '900000'], { terminal: yes });
  assert.equal(raised.code, 0, raised.text);
  assert.match(yes.asked[0], /^Raise this workspace's Jev decision cap to 900000 micro-USD \(0\.90 USD\)\? It lets Jevris spend more on Jev calls\. \[y\/N\] $/);
  assert.match(raised.text, /cap is 900000 micro-USD \(0\.90 USD\)/);
  assert.equal((await run(box, 'configure', ['workspace-budget', 'none'], { terminal: atTerminal(true) })).code, 0);
  assert.deepEqual(orchestrator.readWorkspaceJevBudgetCap(box.home, workspaceId), { state: 'none' });
  // Usage errors.
  assert.equal((await run(box, 'configure', ['workspace-budget', '2.5'])).code, 2);
  assert.equal((await run(box, 'configure', ['workspace-budget', '1000000001'])).code, 2);
  assert.equal((await run(box, 'configure', ['workspace-budget', '1', '2'])).code, 2);
});

test('configure workspace-budget names a repository lowering, which it cannot raise', async (t) => {
  const box = sandbox(t);
  mkdirSync(join(box.workspace, '.jevris')); // test-hygiene: not product source
  writeFileSync(join(box.workspace, '.jevris', 'config.json'), JSON.stringify({ decisions: { monthlyBudgetMicroUsd: 300_000 } })); // test-hygiene: not product source
  assert.equal((await run(box, 'configure', ['workspace-budget', '2000000'])).code, 0, 'a first cap never asks');
  const shown = await run(box, 'configure', ['workspace-budget']);
  assert.match(shown.text, /The repository's \.jevris\/config\.json lowers this workspace to 300000 micro-USD \(0\.30 USD\); the lower of the two applies\./);
  const json = JSON.parse((await run(box, 'configure', ['workspace-budget', '--json'])).text).result;
  assert.deepEqual([json.capMicroUsd, json.repositoryMicroUsd, json.effectiveCapMicroUsd], [2_000_000, 300_000, 300_000]);
});

test('status without the sidecar reads the shared budget file: the month\'s spend, this workspace\'s cap and the reset date', async (t) => {
  const box = sandbox(t);
  const workspaceId = orchestrator.workspaceIdFor(box.workspace);
  const file = join(jevrisPaths({ home: box.home }).data, 'decision-budget.json');
  const budget = DecisionBudget.open(file, { limitMicroUsd: 5_000_000, now: () => NOW });
  const mine = await budget.reserve({ decisionId: 'd1', workspaceId, microUsd: 400_000 });
  await budget.commit(mine.reservation.id, { usage: { inputTokens: 10, outputTokens: 1 }, actualMicroUsd: 400_000 });
  const other = await budget.reserve({ decisionId: 'd2', workspaceId: 'ws-other', microUsd: 100_000 });
  await budget.commit(other.reservation.id, { usage: { inputTokens: 10, outputTokens: 1 }, actualMicroUsd: 100_000 });
  let status = JSON.parse((await run(box, 'status', ['--json'])).text).result;
  assert.equal(surfacePayloadContract('status').validate(status).ok, true, JSON.stringify(status.budget));
  assert.deepEqual(status.budget, { state: 'within', reservedMicroUsd: 0, limitMicroUsd: 5_000_000, period: '2026-09', spentMicroUsd: 500_000, resetsAt: '2026-10-01T00:00:00.000Z', workspace: null, exhaustedBy: null });
  assert.match((await run(box, 'status', [])).text, /^jev budget: 0\.50 USD spent of 5\.00 USD in 2026-09, machine-wide; resets 2026-10-01 \(UTC\)$/m);
  // This workspace's cap: 400000 spent of 400000, so its decisions run rules-only; the machine has room.
  await orchestrator.setWorkspaceJevBudgetCap({ home: box.home, workspaceId, capMicroUsd: 400_000, channel: 'cli' });
  status = JSON.parse((await run(box, 'status', ['--json'])).text).result;
  assert.deepEqual(status.budget.workspace, { limitMicroUsd: 400_000, spentMicroUsd: 400_000, reservedMicroUsd: 0, availableMicroUsd: 0, source: 'cap' });
  assert.deepEqual([status.budget.state, status.budget.exhaustedBy], ['exhausted', 'workspace']);
  const text = (await run(box, 'status', [])).text;
  assert.match(text, /^jev budget this workspace: 0\.40 USD spent of its cap 0\.40 USD in 2026-09 \(set by jevris configure workspace-budget\)$/m);
  assert.match(text, /^jev budget spent: this workspace's cap \(BUDGET_WORKSPACE_CAP\); its decisions run rules-only until it resets$/m);
  // The machine-wide limit lowered below the spend: that is the one named.
  await orchestrator.setConfigValue({ home: box.home, key: KEY, value: '500000', dryRun: false });
  status = JSON.parse((await run(box, 'status', ['--json'])).text).result;
  assert.deepEqual([status.budget.limitMicroUsd, status.budget.exhaustedBy], [500_000, 'machine']);
  // The next month: both start again.
  let next = '';
  await runPublicCommand('status', ['--json'], (chunk) => (next += chunk), { ports: ports(), env: box.env, cwd: box.workspace, nowMs: () => Date.UTC(2026, 9, 1, 0, 0, 1) });
  const reset = JSON.parse(next).result.budget;
  assert.deepEqual([reset.period, reset.spentMicroUsd, reset.workspace.spentMicroUsd, reset.state, reset.resetsAt], ['2026-10', 0, 0, 'within', '2026-11-01T00:00:00.000Z']);
});

test('status from the sidecar renders the budget lines, and the degraded reason names the cap', () => {
  const base = { state: 'exhausted', reservedMicroUsd: 0, limitMicroUsd: 0, period: '2026-09', spentMicroUsd: 0, resetsAt: '2026-10-01T00:00:00.000Z', workspace: null, exhaustedBy: 'machine' };
  assert.deepEqual(jevBudgetLines(base), [
    'jev budget: 0.00 USD spent of 0.00 USD in 2026-09, machine-wide (0: no Jev calls, decisions run rules-only); resets 2026-10-01 (UTC)',
    'jev budget spent: the machine-wide limit (BUDGET_MACHINE_LIMIT); decisions run rules-only until it resets',
  ]);
  assert.deepEqual(jevBudgetLines({ state: 'unknown', reservedMicroUsd: null, limitMicroUsd: null }), []);
  const repo = jevBudgetLines({ ...base, state: 'within', limitMicroUsd: 5_000_000, spentMicroUsd: 1_000, exhaustedBy: null, workspace: { limitMicroUsd: 300_000, spentMicroUsd: 1_000, reservedMicroUsd: 0, availableMicroUsd: 299_000, source: 'repository' } });
  assert.equal(repo[1], "jev budget this workspace: 0.001 USD spent of its cap 0.30 USD in 2026-09 (set by the repository's .jevris/config.json)");
});

test('cost-report shows the month\'s spend against the machine-wide limit and this workspace\'s cap, with the reset date', () => {
  const body = {
    schemaVersion: 'jevris-cost-report-1',
    providerConfigured: true,
    route: 'direct',
    budget: { period: '2026-09', limitMicroUsd: 5_000_000, committedMicroUsd: 1_250_000, reservedMicroUsd: 0, heldMicroUsd: 0, availableMicroUsd: 3_750_000, holds: 0, reservations: 3, resetsAt: '2026-10-01T00:00:00.000Z', workspace: { workspaceId: 'ws-a', limitMicroUsd: 1_000_000, committedMicroUsd: 1_000_000, reservedMicroUsd: 0, heldMicroUsd: 0, availableMicroUsd: 0 } },
    decisions: { total: 3, providerCalls: 3, inputTokens: 900, outputTokens: 120, usageUnknown: 0, actualMicroUsd: 1_250_000, byOutcome: { advisory: 3 }, byBillingBasis: { 'provider-reported-usage': 3 }, scanned: 3, truncated: false },
    note: 'Decision-call cost only (Jev).',
    diagnostics: [],
  };
  const report = checkCostReport(body);
  assert.deepEqual(report.budget.workspace, { limitMicroUsd: 1_000_000, committedMicroUsd: 1_000_000, reservedMicroUsd: 0, availableMicroUsd: 0 });
  assert.equal(report.budget.resetsAt, '2026-10-01T00:00:00.000Z');
  const text = renderCostReport(report);
  assert.match(text, /^jev budget: 1\.25 USD spent of the machine-wide limit 5\.00 USD in 2026-09; resets 2026-10-01 \(UTC\)$/m);
  assert.match(text, /^jev budget this workspace: 1\.00 USD spent, 0\.00 USD reserved, 0\.00 USD available of its cap 1\.00 USD in 2026-09$/m);
  assert.match(text, /^jev budget spent: this workspace's cap \(BUDGET_WORKSPACE_CAP\); its decisions run rules-only until it resets$/m);
  // No cap and an older sidecar without the new fields: the line without a reset date, no workspace line.
  const older = checkCostReport({ ...body, budget: { ...body.budget, resetsAt: undefined, workspace: undefined } });
  assert.deepEqual([older.budget.resetsAt, older.budget.workspace], [null, null]);
  assert.doesNotMatch(renderCostReport(older), /jev budget this workspace/);
  // A workspace block that does not match is refused as a whole.
  assert.equal(checkCostReport({ ...body, budget: { ...body.budget, workspace: { limitMicroUsd: -1 } } }), null);
});

test('doctor names a spent machine-wide budget from the running sidecar\'s status; 0 by setting is a fact, not an action', () => {
  const spent = { state: 'exhausted', reservedMicroUsd: 0, limitMicroUsd: 5_000_000, period: '2026-09', spentMicroUsd: 5_000_000, resetsAt: '2026-10-01T00:00:00.000Z', workspace: null, exhaustedBy: 'machine' };
  const lines = jevCircuitDoctorLinesFrom({ jevCircuit: null, budget: spent });
  assert.deepEqual(lines, ['jev budget: spent (BUDGET_MACHINE_LIMIT) (5.00 USD of 5.00 USD in 2026-09); Jevris decides rules-only until 2026-10-01 (UTC); raise it with jevris configure set decisions.monthlyBudgetMicroUsd <micro-USD>']);
  assert.equal(doctorLineSeverity(lines[0]), 'action');
  const zero = jevCircuitDoctorLinesFrom({ budget: { ...spent, limitMicroUsd: 0, spentMicroUsd: 0 } });
  assert.match(zero[0], /^jev budget: 0 \(BUDGET_MACHINE_LIMIT, BUDGET_ZERO\): no Jev calls by setting/);
  assert.equal(doctorLineSeverity(zero[0]), 'info');
  assert.deepEqual(jevCircuitDoctorLinesFrom({ budget: { ...spent, state: 'within', exhaustedBy: null } }), []);
  assert.deepEqual(jevCircuitDoctorLinesFrom({ budget: { state: 'unknown', reservedMicroUsd: null, limitMicroUsd: null } }), []);
  assert.deepEqual(jevCircuitDoctorLinesFrom({ budget: { ...spent, limitMicroUsd: 'lots' } }), [], 'a field that does not match is left out');
});

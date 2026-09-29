import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';

// Owner decision 2026-09-29: the sidecar reads the Jev decision budget's limits from the settings
// at every read, so a `jevris configure` change shows (and applies) without a restart; a workspace
// cap shows on that workspace's status only; a spent cap is the degraded reason, naming the cap.
// Temp home, no credential (the engine is rules-only but keeps its budget), no harness.

const { startDaemon, sidecarRequest } = await import('../dist/index.js');
const { budgetSpentReason, budgetLimitReaders } = await import('../dist/state.js');
const { surfacePayloadContract } = await import('@jevris/contracts');
const { DEFAULT_CONFIG, setWorkspaceJevBudgetCap, workspaceIdFor } = await import('@jevris/orchestrator');
const { jevrisPaths } = await import('@jevris/platform');

test('status follows the budget settings live: the machine-wide limit, this workspace\'s cap and a repository lowering', { skip: managedHostSkip() }, async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-jev-budget-')));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3 }));
  const root = join(home, 'ws');
  const other = join(home, 'other');
  mkdirSync(root);
  mkdirSync(other);
  const config = jevrisPaths({ home }).config;
  mkdirSync(config, { recursive: true });
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  try {
    const status = async (workspace) => {
      const answer = await sidecarRequest({ home, op: 'status', scope: 'cli', workspace, body: {} });
      assert.equal(answer.ok, true, JSON.stringify(answer));
      assert.equal(surfacePayloadContract('status').validate(answer.result).ok, true, JSON.stringify(answer.result.budget));
      return answer.result;
    };
    let result = await status(root);
    assert.deepEqual([result.budget.limitMicroUsd, result.budget.spentMicroUsd, result.budget.workspace, result.budget.exhaustedBy], [5_000_000, 0, null, null]);
    assert.match(result.budget.resetsAt, /^\d{4}-\d{2}-01T00:00:00\.000Z$/);
    // `jevris configure set decisions.monthlyBudgetMicroUsd 2000000` writes the user file: no restart.
    writeFileSync(join(config, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, decisions: { ...DEFAULT_CONFIG.decisions, monthlyBudgetMicroUsd: 2_000_000 } }));
    assert.equal((await status(root)).budget.limitMicroUsd, 2_000_000);
    // This workspace's cap shows on its status only.
    const id = workspaceIdFor(root);
    assert.equal((await setWorkspaceJevBudgetCap({ home, workspaceId: id, capMicroUsd: 700_000, channel: 'cli' })).ok, true);
    result = await status(root);
    assert.deepEqual(result.budget.workspace, { limitMicroUsd: 700_000, spentMicroUsd: 0, reservedMicroUsd: 0, availableMicroUsd: 700_000, source: 'cap' });
    assert.equal((await status(other)).budget.workspace, null, 'another workspace has no cap');
    // The repository's file lowers it further, and status names where it comes from.
    mkdirSync(join(root, '.jevris'));
    writeFileSync(join(root, '.jevris', 'config.json'), JSON.stringify({ decisions: { monthlyBudgetMicroUsd: 200_000 } }));
    result = await status(root);
    assert.deepEqual([result.budget.workspace.limitMicroUsd, result.budget.workspace.source], [200_000, 'repository']);
    // A cap of 0: that workspace is exhausted, the machine is not.
    await setWorkspaceJevBudgetCap({ home, workspaceId: id, capMicroUsd: 0, channel: 'cli' });
    result = await status(root);
    assert.deepEqual([result.budget.state, result.budget.exhaustedBy], ['exhausted', 'workspace']);
    assert.equal((await status(other)).budget.state, 'within');
  } finally {
    await started.daemon.stop('test');
  }
});

test('the degraded reason names the cap that ran out, the reset date and the command', () => {
  const base = { reservedMicroUsd: 0, period: '2026-09', spentMicroUsd: 5_000_000, resetsAt: '2026-10-01T00:00:00.000Z' };
  assert.equal(budgetSpentReason({ ...base, state: 'within', limitMicroUsd: 5_000_000, workspace: null, exhaustedBy: null }), null);
  assert.equal(
    budgetSpentReason({ ...base, state: 'exhausted', limitMicroUsd: 5_000_000, workspace: null, exhaustedBy: 'machine' }),
    'The monthly Jev decision budget is spent (BUDGET_MACHINE_LIMIT); decisions run rules-only until 2026-10-01 (UTC). Raise it with `jevris configure set decisions.monthlyBudgetMicroUsd <micro-USD>`.',
  );
  assert.match(budgetSpentReason({ ...base, state: 'exhausted', limitMicroUsd: 0, workspace: null, exhaustedBy: 'machine' }), /^The Jev decision budget is 0 \(BUDGET_MACHINE_LIMIT, BUDGET_ZERO\): no Jev calls; decisions run rules-only\./);
  const ws = { limitMicroUsd: 100, spentMicroUsd: 100, reservedMicroUsd: 0, availableMicroUsd: 0, source: 'cap' };
  assert.equal(
    budgetSpentReason({ ...base, state: 'exhausted', limitMicroUsd: 5_000_000, workspace: ws, exhaustedBy: 'workspace' }),
    "This workspace's monthly Jev decision budget is spent (BUDGET_WORKSPACE_CAP); its decisions run rules-only until 2026-10-01 (UTC). Other workspaces go on. Its cap is set by `jevris configure workspace-budget`.",
  );
  assert.match(budgetSpentReason({ ...base, state: 'exhausted', limitMicroUsd: 5_000_000, workspace: { ...ws, limitMicroUsd: 0 }, exhaustedBy: 'workspace' }), /BUDGET_WORKSPACE_CAP, BUDGET_ZERO/);
});

test('the engine\'s limit readers go to the settings on every read', (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-jev-readers-')));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3 }));
  const config = jevrisPaths({ home }).config;
  mkdirSync(config, { recursive: true });
  const readers = budgetLimitReaders(home, () => null);
  assert.equal(readers.machine(), 5_000_000);
  assert.equal(readers.workspace('ws-a'), null);
  writeFileSync(join(config, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, decisions: { ...DEFAULT_CONFIG.decisions, monthlyBudgetMicroUsd: 0 } }));
  assert.equal(readers.machine(), 0);
});

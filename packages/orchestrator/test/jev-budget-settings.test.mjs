// Owner decision 2026-09-29: the monthly Jev decision budget as a setting.
// - decisions.monthlyBudgetMicroUsd: machine-wide, default 5 USD, 0 to 1,000 USD in integer
//   micro-USD; a raise needs a person, lowering never asks; host.json, organization.json and a
//   managed policy set ceilings that win; an unusable file is capped like other keys.
// - A workspace's own cap: the host ledger (CLI only), lowered, never raised, by the repository file.
// Temporary homes only; the managed policy through JEVRIS_TEST_MANAGED_DIR.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jevrisPaths } from '@jevris/platform';
import { JevrisConfigContract, copyHostDocument, mergeOrganization, surfacePayloadContract } from '@jevris/contracts';
import {
  DEFAULT_CONFIG,
  JEV_BUDGET_CAPS,
  SETTABLE_KEYS,
  jevBudgetText,
  loadEffectiveConfig,
  machineJevBudget,
  raiseRefusal,
  raisesAuthority,
  raisesWorkspaceJevBudget,
  readEffectiveConfig,
  readWorkspaceJevBudgetCap,
  setConfigValue,
  setWorkspaceJevBudgetCap,
  workspaceJevBudget,
  openLedger,
} from '../dist/index.js';
import { managedHostSkip } from '../../../test/managed-host.mjs';
import { tempDir } from './temp-dirs.mjs';

const KEY = 'decisions.monthlyBudgetMicroUsd';

const policy = (monthlyDecisionMicroUsd) => ({
  schemaVersion: '1.0',
  mode: 'bounded-auto',
  egress: 'deny-until-approved',
  retention: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 },
  budget: monthlyDecisionMicroUsd === undefined ? { maxRequestBytes: 131072 } : { maxRequestBytes: 131072, monthlyDecisionMicroUsd },
  pin: { model: 'jev-1.13.0', respectHumanPins: true },
  packPrivileges: [],
  credentialRef: 'host-secret:typesafe-primary',
  installerEnvName: 'JEVRIS_INSTALLER_KEY',
  allowUncalibratedActuation: false,
});

function fixture() {
  const dir = tempDir('jv-jev-budget-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home);
  mkdirSync(join(repo, '.jevris'), { recursive: true }); // test-hygiene: not product source
  const configDir = jevrisPaths({ home }).config;
  mkdirSync(configDir, { recursive: true });
  const write = (name, value) => writeFileSync(join(configDir, name), typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  const user = (budget) => write('jevris.config.json', { ...DEFAULT_CONFIG, decisions: { ...DEFAULT_CONFIG.decisions, monthlyBudgetMicroUsd: budget } });
  const repoFile = (value) => writeFileSync(join(repo, '.jevris', 'config.json'), JSON.stringify(value)); // test-hygiene: not product source
  return { dir, home, repo, configDir, write, user, repoFile };
}

test('the default is 5 USD in integer micro-USD, with no file and with a file that leaves the key out', async () => {
  const f = fixture();
  assert.equal(DEFAULT_CONFIG.decisions.monthlyBudgetMicroUsd, 5_000_000);
  assert.equal(machineJevBudget({ home: f.home }), 5_000_000);
  const { monthlyBudgetMicroUsd: _omitted, ...decisions } = DEFAULT_CONFIG.decisions;
  f.write('jevris.config.json', { ...DEFAULT_CONFIG, decisions });
  const eff = readEffectiveConfig({ home: f.home });
  assert.equal(eff.valid, true, 'the key is optional: an older file stays valid');
  assert.equal(eff.config.decisions.monthlyBudgetMicroUsd, 5_000_000);
  const payload = await loadEffectiveConfig({ home: f.home, workspaceRoot: null });
  assert.equal(payload.effective.monthlyBudgetMicroUsd, 5_000_000);
  assert.equal(surfacePayloadContract('configure').validate(payload).ok, true);
  assert.equal(jevBudgetText(5_000_000), '5.00 USD');
  assert.equal(jevBudgetText(1_234_567), '1.234567 USD');
  assert.equal(jevBudgetText(0), '0.00 USD');
});

test('the value is whole micro-USD from 0 to 1,000 USD: the contract and configure refuse anything else', () => {
  const valid = (v) => JevrisConfigContract.validate({ ...DEFAULT_CONFIG, decisions: { ...DEFAULT_CONFIG.decisions, monthlyBudgetMicroUsd: v } }).ok;
  assert.deepEqual([valid(0), valid(1), valid(1_000_000_000)], [true, true, true]);
  assert.deepEqual([valid(-1), valid(1.5), valid(1_000_000_001), valid('5000000')], [false, false, false, false]);
  const parse = SETTABLE_KEYS[KEY];
  assert.deepEqual([parse('0'), parse('2500000'), parse('1000000000')], [0, 2_500_000, 1_000_000_000]);
  assert.deepEqual([parse('-1'), parse('1.5'), parse('1000000001'), parse('5 USD'), parse('')], [undefined, undefined, undefined, undefined, undefined]);
});

test('raising the limit needs a person; lowering and the same value never ask', async () => {
  const f = fixture();
  // Against the effective value (5 USD by default).
  assert.equal(raisesAuthority({ home: f.home }, KEY, '5000001'), true);
  assert.equal(raisesAuthority({ home: f.home }, KEY, '5000000'), false);
  assert.equal(raisesAuthority({ home: f.home }, KEY, '0'), false);
  assert.equal(raisesAuthority({ home: f.home }, KEY, 'not-a-number'), false, 'a value the setter refuses anyway is not asked');
  const refused = await setConfigValue({ home: f.home, key: KEY, value: '9000000', dryRun: false });
  assert.deepEqual([refused.ok, refused.reasonCode], [false, 'CHANNEL_REFUSED']);
  assert.equal(refused.message, raiseRefusal(KEY, '9000000'));
  assert.match(refused.message, /^raising decisions\.monthlyBudgetMicroUsd to 9000000 lets Jevris spend more on Jev calls, so it needs a person at an interactive terminal/);
  assert.equal(machineJevBudget({ home: f.home }), 5_000_000, 'nothing was written');
  // A dry run shows it and asks no one.
  const dry = await setConfigValue({ home: f.home, key: KEY, value: '9000000', dryRun: true });
  assert.deepEqual(dry.changed, [{ key: KEY, from: '5000000', to: '9000000' }]);
  // A person at a terminal (the CLI sets confirmed only from a y).
  const raised = await setConfigValue({ home: f.home, key: KEY, value: '9000000', dryRun: false, confirmed: true });
  assert.deepEqual(raised.changed, [{ key: KEY, from: '5000000', to: '9000000' }]);
  assert.equal(raised.effective.monthlyBudgetMicroUsd, 9_000_000);
  assert.equal(machineJevBudget({ home: f.home }), 9_000_000);
  // Lowering, to 0 even: free.
  for (const value of ['1000000', '0']) {
    const lowered = await setConfigValue({ home: f.home, key: KEY, value, dryRun: false });
    assert.equal(lowered.ok, undefined, JSON.stringify(lowered));
    assert.equal(machineJevBudget({ home: f.home }), Number(value));
  }
});

test('host.json, organization.json and the managed policy set ceilings that win; the lowest applies', { skip: managedHostSkip() }, (t) => {
  const f = fixture();
  f.user(20_000_000);
  assert.equal(machineJevBudget({ home: f.home }), 20_000_000);
  f.write('organization.json', policy(8_000_000));
  let eff = readEffectiveConfig({ home: f.home });
  assert.equal(eff.config.decisions.monthlyBudgetMicroUsd, 8_000_000);
  assert.ok(eff.narrowed.some((n) => n.layer === 'organization' && n.key === KEY && n.from === '20000000' && n.to === '8000000'));
  f.write('host.json', policy(3_000_000));
  assert.equal(machineJevBudget({ home: f.home }), 3_000_000);
  // A ceiling above your setting changes nothing.
  f.write('host.json', policy(50_000_000));
  assert.equal(machineJevBudget({ home: f.home }), 8_000_000);
  f.write('host.json', policy());
  // The managed policy.
  const managed = join(f.dir, 'managed');
  mkdirSync(managed, { mode: 0o755 });
  const saved = { dir: process.env.JEVRIS_TEST_MANAGED_DIR, test: process.env.JEVRIS_TEST };
  process.env.JEVRIS_TEST = '1';
  process.env.JEVRIS_TEST_MANAGED_DIR = managed;
  t.after(() => {
    if (saved.dir === undefined) delete process.env.JEVRIS_TEST_MANAGED_DIR;
    else process.env.JEVRIS_TEST_MANAGED_DIR = saved.dir;
    if (saved.test === undefined) delete process.env.JEVRIS_TEST;
    else process.env.JEVRIS_TEST = saved.test;
  });
  writeFileSync(join(managed, 'policy.json'), JSON.stringify(policy(1_000_000)), { mode: 0o644 });
  eff = readEffectiveConfig({ home: f.home });
  assert.equal(eff.config.decisions.monthlyBudgetMicroUsd, 1_000_000);
  assert.ok(eff.narrowed.some((n) => n.layer === 'managed' && n.key === KEY));
  // Raising above a ceiling is still a raise of your setting, and the ceiling still wins after it.
  assert.equal(raisesAuthority({ home: f.home }, KEY, '2000000'), true);
});

test('a ceiling file that cannot be used caps the budget at the defaults\' 5 USD, as it caps the mode', () => {
  const f = fixture();
  f.user(40_000_000);
  f.write('host.json', '{ not json');
  let eff = readEffectiveConfig({ home: f.home });
  assert.equal(eff.config.decisions.monthlyBudgetMicroUsd, 5_000_000);
  f.write('host.json', policy());
  f.write('organization.json', { ...policy(), budget: { maxRequestBytes: 131072, monthlyDecisionMicroUsd: -5 } });
  eff = readEffectiveConfig({ home: f.home });
  assert.equal(eff.config.decisions.monthlyBudgetMicroUsd, 5_000_000);
  assert.ok(eff.issues.some((i) => i.path === 'organization:' && i.code === 'INVALID_POLICY'));
});

test('an unusable user file is capped like the other keys: the defaults, never its raised value', () => {
  const f = fixture();
  f.write('jevris.config.json', JSON.stringify({ ...DEFAULT_CONFIG, decisions: { ...DEFAULT_CONFIG.decisions, monthlyBudgetMicroUsd: 900_000_000 }, surprise: true }));
  const eff = readEffectiveConfig({ home: f.home });
  assert.equal(eff.valid, false);
  assert.equal(eff.config.decisions.monthlyBudgetMicroUsd, 5_000_000);
  assert.equal(eff.config.mode, 'observe');
});

test('an organization may add or lower a Jev ceiling under host policy, never raise it', () => {
  const host = copyHostDocument(policy(4_000_000));
  assert.equal(host.budget.monthlyDecisionMicroUsd, 4_000_000);
  assert.equal(mergeOrganization(host, copyHostDocument(policy(6_000_000))).ok, false);
  assert.equal(mergeOrganization(host, copyHostDocument(policy(2_000_000))).document.budget.monthlyDecisionMicroUsd, 2_000_000);
  assert.equal(mergeOrganization(host, copyHostDocument(policy())).document.budget.monthlyDecisionMicroUsd, 4_000_000);
  assert.equal(mergeOrganization(copyHostDocument(policy()), copyHostDocument(policy(1_000))).document.budget.monthlyDecisionMicroUsd, 1_000);
  assert.equal(copyHostDocument(policy()).budget.monthlyDecisionMicroUsd, undefined);
  assert.equal(copyHostDocument(policy(1_000_000_001)), undefined);
});

test('a repository file can lower this workspace\'s budget and never raise it; the machine-wide limit is unchanged', () => {
  const f = fixture();
  f.user(3_000_000);
  f.repoFile({ decisions: { monthlyBudgetMicroUsd: 50_000_000 } });
  let eff = readEffectiveConfig({ home: f.home, workspaceRoot: f.repo });
  assert.equal(eff.config.decisions.monthlyBudgetMicroUsd, 3_000_000, 'a higher value in the repository raises nothing');
  assert.deepEqual(workspaceJevBudget({ home: f.home, workspaceId: 'ws-repo', workspaceRoot: f.repo }).capMicroUsd, null);
  f.repoFile({ decisions: { monthlyBudgetMicroUsd: 1_000_000 } });
  eff = readEffectiveConfig({ home: f.home, workspaceRoot: f.repo });
  assert.equal(eff.config.decisions.monthlyBudgetMicroUsd, 1_000_000);
  const ws = workspaceJevBudget({ home: f.home, workspaceId: 'ws-repo', workspaceRoot: f.repo });
  assert.deepEqual([ws.capMicroUsd, ws.source, ws.repositoryMicroUsd], [1_000_000, 'repository', 1_000_000]);
  assert.equal(machineJevBudget({ home: f.home }), 3_000_000, 'the repository never touches the machine-wide limit');
  // A value of the wrong kind is refused and reported.
  f.repoFile({ decisions: { monthlyBudgetMicroUsd: 'lots' } });
  eff = readEffectiveConfig({ home: f.home, workspaceRoot: f.repo });
  assert.ok(eff.issues.some((i) => i.path === `workspace:${KEY}` && i.code === 'INVALID_VALUE'));
});

test('a workspace cap is kept per machine by workspace id; the lower of it and the repository lowering applies', async () => {
  const f = fixture();
  assert.deepEqual(readWorkspaceJevBudgetCap(f.home, 'ws-a'), { state: 'none' });
  assert.equal((await setWorkspaceJevBudgetCap({ home: f.home, workspaceId: 'ws-a', capMicroUsd: 700_000, channel: 'cli', nowMs: Date.UTC(2026, 8, 29) })).ok, true);
  const stored = readWorkspaceJevBudgetCap(f.home, 'ws-a');
  assert.deepEqual([stored.state, stored.record.capMicroUsd, stored.record.changedAt], ['set', 700_000, '2026-09-29T00:00:00.000Z']);
  assert.equal(workspaceJevBudget({ home: f.home, workspaceId: 'ws-a', workspaceRoot: null }).capMicroUsd, 700_000);
  assert.equal(workspaceJevBudget({ home: f.home, workspaceId: 'ws-b', workspaceRoot: null }).capMicroUsd, null, 'another workspace has no cap');
  f.repoFile({ decisions: { monthlyBudgetMicroUsd: 400_000 } });
  assert.deepEqual(workspaceJevBudget({ home: f.home, workspaceId: 'ws-a', workspaceRoot: f.repo }).capMicroUsd, 400_000);
  f.repoFile({ decisions: { monthlyBudgetMicroUsd: 900_000 } });
  const own = workspaceJevBudget({ home: f.home, workspaceId: 'ws-a', workspaceRoot: f.repo });
  assert.deepEqual([own.capMicroUsd, own.source], [700_000, 'cap']);
  // Only the CLI channel writes; amounts are integer micro-USD in range.
  assert.equal((await setWorkspaceJevBudgetCap({ home: f.home, workspaceId: 'ws-a', capMicroUsd: 1, channel: 'mcp' })).reasonCode, 'CHANNEL_REFUSED');
  assert.equal((await setWorkspaceJevBudgetCap({ home: f.home, workspaceId: 'ws-a', capMicroUsd: 1.5, channel: 'cli' })).reasonCode, 'INVALID_AMOUNT');
  assert.equal((await setWorkspaceJevBudgetCap({ home: f.home, workspaceId: '../x', capMicroUsd: 1, channel: 'cli' })).reasonCode, 'INVALID_WORKSPACE');
  // Removing it.
  assert.equal((await setWorkspaceJevBudgetCap({ home: f.home, workspaceId: 'ws-a', capMicroUsd: null, channel: 'cli' })).ok, true);
  assert.deepEqual(readWorkspaceJevBudgetCap(f.home, 'ws-a'), { state: 'none' });
});

test('a cap record that cannot be used is a cap of 0 for that workspace (fail closed)', async () => {
  const f = fixture();
  await openLedger(join(jevrisPaths({ home: f.home }).data, 'orchestration', 'host')).transact((tx) => tx.put(JEV_BUDGET_CAPS, 'ws-a', { workspaceId: 'ws-a', capMicroUsd: 'a lot' }));
  assert.deepEqual(readWorkspaceJevBudgetCap(f.home, 'ws-a'), { state: 'unreadable' });
  const ws = workspaceJevBudget({ home: f.home, workspaceId: 'ws-a', workspaceRoot: null });
  assert.deepEqual([ws.capMicroUsd, ws.source], [0, 'unreadable']);
});

test('raising a workspace cap or removing it needs a person; a first cap and a lower one never ask', () => {
  const none = { state: 'none' };
  const set = (capMicroUsd) => ({ state: 'set', record: { workspaceId: 'w', capMicroUsd, changedAt: '', changedBy: '' } });
  assert.equal(raisesWorkspaceJevBudget(none, 1_000_000_000), false, 'a first cap only narrows');
  assert.equal(raisesWorkspaceJevBudget(none, null), false);
  assert.equal(raisesWorkspaceJevBudget(set(500), 400), false);
  assert.equal(raisesWorkspaceJevBudget(set(500), 500), false);
  assert.equal(raisesWorkspaceJevBudget(set(500), 501), true);
  assert.equal(raisesWorkspaceJevBudget(set(500), null), true, 'removing a cap lets the workspace spend up to the machine-wide limit');
  assert.equal(raisesWorkspaceJevBudget({ state: 'unreadable' }, 0), false);
  assert.equal(raisesWorkspaceJevBudget({ state: 'unreadable' }, 1), true);
});

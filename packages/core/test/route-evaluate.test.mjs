import test from 'node:test';
import assert from 'node:assert/strict';

const core = await import('../dist/index.js');
const REG = core.BUNDLED_MODEL_REGISTRY;

test('RTE-02: routing-policy.json parses strictly; defaults name no allowlist, the global region and the registry account', () => {
  const parsed = core.parseRoutingPolicy({ schemaVersion: '1.0', accountId: 'acct-9', managedAllowlist: ['claude-opus-5'], allowedRegions: ['us'], costAssumptions: { reworkMicroUsd: 1_000_000 }, minimumBenefitMicroUsd: 50_000, defaultTaskTokens: { inputTokens: 1000, outputTokens: 100 }, generationBudgetMicroUsd: 5_000_000 }, REG);
  assert.deepEqual([parsed.accountId, parsed.managedAllowlist, parsed.allowedRegions, parsed.assumptions.reworkMicroUsd, parsed.assumptions.verificationMicroUsd, parsed.minimumBenefitMicroUsd, parsed.defaultTaskVolume, parsed.generationBudgetMicroUsd, parsed.source], ['acct-9', ['claude-opus-5'], ['us'], 1_000_000, 200_000, 50_000, { inputTokens: 1000, outputTokens: 100 }, 5_000_000, 'file']);
  for (const bad of [{ schemaVersion: '2.0' }, { schemaVersion: '1.0', extra: 1 }, { schemaVersion: '1.0', managedAllowlist: 'all' }, { schemaVersion: '1.0', allowedRegions: [] }, { schemaVersion: '1.0', costAssumptions: { reworkMicroUsd: -1 } }, { schemaVersion: '1.0', accountId: 'bad id' }, { schemaVersion: '1.0', defaultTaskTokens: { inputTokens: 0, outputTokens: 0 } }, { schemaVersion: '1.0', zeroDataRetention: 'yes' }]) {
    assert.equal(core.parseRoutingPolicy(bad, REG), null, JSON.stringify(bad));
  }
  const checked = { ...REG, entries: REG.entries.map((e) => ({ ...e, accountEligibility: [{ accountId: 'acct-1', eligible: true, checkedAt: '2026-09-22T00:00:00Z' }] })) };
  assert.equal(core.registryAccount(checked), 'acct-1');
  assert.equal(core.registryAccount(REG), null, 'no eligibility check: no account, so nothing is eligible');
  assert.equal(core.parseRoutingPolicy({ schemaVersion: '1.0' }, checked).accountId, 'acct-1');
  assert.equal(core.parseRoutingPolicy({ schemaVersion: '1.0' }, REG).zeroDataRetention, false, 'a workspace is not ZDR unless the policy says so');
  assert.equal(core.parseRoutingPolicy({ schemaVersion: '1.0', zeroDataRetention: true }, REG).zeroDataRetention, true);
});

test('DEC-08: write tools of every harness move the diff boundary (Antigravity and OpenCode names included)', () => {
  for (const name of ['Edit', 'apply_patch', 'multiedit', 'write_to_file', 'replace_file_content', 'multi_replace_file_content']) assert.equal(core.WRITE_TOOL_NAMES.has(name), true, name);
  assert.equal(core.WRITE_TOOL_NAMES.has('Read'), false);
});

test('INT-05: approved paths are task write scopes: a directory covers what is below it, * stays in one segment, ** crosses; nothing escapes', () => {
  const inside = (path, scopes) => core.withinWriteScopes(path, scopes);
  assert.equal(inside('app/cart/total.ts', ['app']), true);
  assert.equal(inside('./app/a.ts', ['app/']), true);
  assert.equal(inside('appx/a.ts', ['app']), false, 'a prefix of a name is not a directory');
  assert.equal(inside('lib/a.test.ts', ['lib/*.test.ts']), true);
  assert.equal(inside('lib/a.ts', ['lib/*.test.ts']), false);
  assert.equal(inside('docs/deep/x.md', ['docs/**']), true);
  assert.equal(inside('anything/at/all.ts', ['.']), true);
  for (const escape of ['/etc/passwd', '../outside.ts', 'app/../../x', 'C:/x']) assert.equal(inside(escape, ['app', '.']), false, escape);
  assert.equal(inside('app/a.ts', ['', '/app', '../app']), false);
});

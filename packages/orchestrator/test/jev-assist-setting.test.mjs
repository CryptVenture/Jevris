// Owner decision 2026-10-01 (Jev as an active decision aid): `jev.assist` is `classify` from install,
// a repository file may only lower it to `off`, and raising it back needs a person at a terminal
// (CHANNEL_REFUSED), like routing.firstTry. Temporary homes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jevrisPaths } from '@jevris/platform';
import { JEV_ASSIST_DEFAULT, JEV_ASSIST_VALUES, JevrisConfigContract } from '@jevris/contracts';
import { AUTHORITY_KEYS, DEFAULT_CONFIG, SETTABLE_KEYS, jevAssistOf, loadEffectiveConfig, raiseRefusal, raisesAuthority, readEffectiveConfig, setConfigValue } from '../dist/index.js';
import { tempDir } from './temp-dirs.mjs';

const KEY = 'jev.assist';
const noEgress = async () => 'not-approved';

function fixture() {
  const dir = tempDir('jv-jev-assist-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(jevrisPaths({ home }).config, { recursive: true });
  mkdirSync(join(repo, '.jevris'), { recursive: true });
  const user = (patch) => writeFileSync(join(jevrisPaths({ home }).config, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, ...patch }));
  const workspace = (patch) => writeFileSync(join(repo, '.jevris', 'config.json'), JSON.stringify(patch));
  return { home, repo, user, workspace };
}

test('jev assist is classify from install, a plain enum, and a file from before the key existed reads as classify', async () => {
  assert.deepEqual([...JEV_ASSIST_VALUES], ['off', 'classify']);
  assert.equal(JEV_ASSIST_DEFAULT, 'classify');
  assert.equal(DEFAULT_CONFIG.jev.assist, 'classify');
  assert.ok(KEY in SETTABLE_KEYS);
  const f = fixture();
  assert.equal(jevAssistOf(readEffectiveConfig({ home: f.home }).config), 'classify');
  const { jev: _dropped, ...rest } = DEFAULT_CONFIG;
  assert.equal(JevrisConfigContract.validate(rest).ok, true, 'the key is optional in the contract');
  writeFileSync(join(jevrisPaths({ home: f.home }).config, 'jevris.config.json'), JSON.stringify(rest));
  const eff = readEffectiveConfig({ home: f.home });
  assert.equal(eff.valid, true, JSON.stringify(eff.issues));
  assert.equal(jevAssistOf(eff.config), 'classify');
  assert.equal((await loadEffectiveConfig({ home: f.home, workspaceRoot: null, sourceEgress: noEgress })).effective.jevAssist, 'classify');
});

test('a repository file can only lower it to off; a classify there changes nothing', () => {
  const f = fixture();
  f.workspace({ jev: { assist: 'off' } });
  const lowered = readEffectiveConfig({ home: f.home, workspaceRoot: f.repo });
  assert.equal(jevAssistOf(lowered.config), 'off');
  assert.ok(lowered.narrowed.some((n) => n.layer === 'workspace' && n.key === KEY));
  // The person turned it off; a repository cannot turn it back on.
  f.user({ jev: { assist: 'off' } });
  f.workspace({ jev: { assist: 'classify' } });
  assert.equal(jevAssistOf(readEffectiveConfig({ home: f.home, workspaceRoot: f.repo }).config), 'off');
  f.workspace({ jev: { assist: 'decide' } });
  const bad = readEffectiveConfig({ home: f.home, workspaceRoot: f.repo });
  assert.ok(bad.issues.some((i) => i.path === `workspace:${KEY}` && i.code === 'INVALID_VALUE'));
});

test('configure set: raising off to classify needs a person at a terminal; lowering and the same value never ask', async () => {
  assert.ok(AUTHORITY_KEYS.includes(KEY));
  const f = fixture();
  f.user({ jev: { assist: 'off' } });
  assert.equal(raisesAuthority({ home: f.home }, KEY, 'classify'), true);
  assert.equal(raisesAuthority({ home: f.home }, KEY, 'off'), false);
  for (const confirmed of [undefined, false]) {
    const refused = await setConfigValue({ home: f.home, key: KEY, value: 'classify', dryRun: false, sourceEgress: noEgress, ...(confirmed === undefined ? {} : { confirmed }) });
    assert.deepEqual([refused.ok, refused.reasonCode, refused.message], [false, 'CHANNEL_REFUSED', raiseRefusal(KEY, 'classify')]);
  }
  assert.equal(jevAssistOf(readEffectiveConfig({ home: f.home }).config), 'off', 'nothing was written');
  const bad = await setConfigValue({ home: f.home, key: KEY, value: 'decide', dryRun: false, sourceEgress: noEgress, confirmed: true });
  assert.equal(bad.ok, false, 'decide is not accepted until it does something');
  const done = await setConfigValue({ home: f.home, key: KEY, value: 'classify', dryRun: false, sourceEgress: noEgress, confirmed: true });
  assert.deepEqual(done.changed, [{ key: KEY, from: 'off', to: 'classify' }], JSON.stringify(done));
  assert.equal(done.effective.jevAssist, 'classify');
  const lower = await setConfigValue({ home: f.home, key: KEY, value: 'off', dryRun: false, sourceEgress: noEgress });
  assert.deepEqual(lower.changed, [{ key: KEY, from: 'classify', to: 'off' }], JSON.stringify(lower));
  const same = await setConfigValue({ home: f.home, key: KEY, value: 'off', dryRun: false, sourceEgress: noEgress });
  assert.deepEqual(same.changed, [], JSON.stringify(same));
});

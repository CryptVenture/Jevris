// Owner decision 2026-09-30 (Sonnet-first routing): `routing.firstTry` is `auto` from install, a
// repository file may only lower it, and raising it back from `baseline` needs a person at a
// terminal (CHANNEL_REFUSED), like routing.managedWorkers. Temporary homes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jevrisPaths } from '@jevris/platform';
import { FIRST_TRY_VALUES } from '@jevris/contracts';
import { AUTHORITY_KEYS, DEFAULT_CONFIG, firstTryOf, raiseRefusal, raisesAuthority, readEffectiveConfig, setConfigValue } from '../dist/index.js';
import { tempDir } from './temp-dirs.mjs';

const KEY = 'routing.firstTry';
const noEgress = async () => 'not-approved';

function fixture() {
  const dir = tempDir('jv-first-try-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(jevrisPaths({ home }).config, { recursive: true });
  mkdirSync(join(repo, '.jevris'), { recursive: true });
  const user = (patch) => writeFileSync(join(jevrisPaths({ home }).config, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, ...patch }));
  const workspace = (patch) => writeFileSync(join(repo, '.jevris', 'config.json'), JSON.stringify(patch));
  return { home, repo, user, workspace };
}

test('first-try routing is auto from install, a plain enum, and a file from before the key existed reads as auto', () => {
  assert.deepEqual([...FIRST_TRY_VALUES], ['auto', 'baseline']);
  assert.equal(DEFAULT_CONFIG.routing.firstTry, 'auto');
  const f = fixture();
  assert.equal(firstTryOf(readEffectiveConfig({ home: f.home }).config), 'auto');
  const { firstTry: _dropped, ...routing } = DEFAULT_CONFIG.routing;
  f.user({ routing });
  const eff = readEffectiveConfig({ home: f.home });
  assert.equal(eff.valid, true, JSON.stringify(eff.issues));
  assert.equal(eff.config.routing.firstTry, 'auto');
});

test('a repository file can only lower it to baseline; an auto there changes nothing', () => {
  const f = fixture();
  f.workspace({ routing: { firstTry: 'baseline' } });
  const lowered = readEffectiveConfig({ home: f.home, workspaceRoot: f.repo });
  assert.equal(lowered.config.routing.firstTry, 'baseline');
  assert.ok(lowered.narrowed.some((n) => n.layer === 'workspace' && n.key === KEY));
  // The person turned it down; a repository cannot turn it back up.
  f.user({ routing: { ...DEFAULT_CONFIG.routing, firstTry: 'baseline' } });
  f.workspace({ routing: { firstTry: 'auto' } });
  assert.equal(readEffectiveConfig({ home: f.home, workspaceRoot: f.repo }).config.routing.firstTry, 'baseline');
});

test('configure set: raising baseline to auto needs a person at a terminal; lowering and the same value never ask', async () => {
  assert.ok(AUTHORITY_KEYS.includes(KEY));
  const f = fixture();
  f.user({ routing: { ...DEFAULT_CONFIG.routing, firstTry: 'baseline' } });
  assert.equal(raisesAuthority({ home: f.home }, KEY, 'auto'), true);
  assert.equal(raisesAuthority({ home: f.home }, KEY, 'baseline'), false);
  for (const confirmed of [undefined, false]) {
    const refused = await setConfigValue({ home: f.home, key: KEY, value: 'auto', dryRun: false, sourceEgress: noEgress, ...(confirmed === undefined ? {} : { confirmed }) });
    assert.deepEqual([refused.ok, refused.reasonCode, refused.message], [false, 'CHANNEL_REFUSED', raiseRefusal(KEY, 'auto')]);
  }
  assert.equal(readEffectiveConfig({ home: f.home }).config.routing.firstTry, 'baseline', 'nothing was written');
  const bad = await setConfigValue({ home: f.home, key: KEY, value: 'sonnet', dryRun: false, sourceEgress: noEgress, confirmed: true });
  assert.equal(bad.ok, false);
  const done = await setConfigValue({ home: f.home, key: KEY, value: 'auto', dryRun: false, sourceEgress: noEgress, confirmed: true });
  assert.deepEqual(done.changed, [{ key: KEY, from: 'baseline', to: 'auto' }], JSON.stringify(done));
  const lower = await setConfigValue({ home: f.home, key: KEY, value: 'baseline', dryRun: false, sourceEgress: noEgress });
  assert.deepEqual(lower.changed, [{ key: KEY, from: 'auto', to: 'baseline' }], JSON.stringify(lower));
  const same = await setConfigValue({ home: f.home, key: KEY, value: 'baseline', dryRun: false, sourceEgress: noEgress });
  assert.deepEqual(same.changed, [], JSON.stringify(same));
});

// JEV-0050: `privacy.sourceEgress` in the person's jevris.config.json is the person's own half of
// source-egress consent (the administrator's half is host policy: `jevris egress approve`). It is
// settable with `configure set`, but raising it to `approved-scoped` widens what may leave the
// machine, so it needs a person at an interactive terminal (the same SR-19 gate as every raise).
// The preference alone never approves egress, a repository file can never raise it, and an
// organization ceiling still caps it. Temporary homes only; no sidecar, no keychain, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jevrisPaths } from '@jevris/platform';
import {
  ADMIN_KEYS,
  DEFAULT_CONFIG,
  EGRESS_PREFERENCE_KEY,
  SETTABLE_KEYS,
  egressPreferenceApproved,
  hostSourceEgress,
  loadEffectiveConfig,
  raisePrompt,
  raiseRefusal,
  raiseWhat,
  raisesAuthority,
  readEffectiveConfig,
  setConfigValue,
} from '../dist/index.js';
import { tempDir } from './temp-dirs.mjs';

const KEY = 'privacy.sourceEgress';
const RAISE = 'approved-scoped';
const DENY = 'deny-until-approved';

function fixture() {
  const dir = tempDir('jv-egress-pref-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home);
  mkdirSync(join(repo, '.jevris'), { recursive: true }); // test-hygiene: not product source
  const configDir = jevrisPaths({ home }).config;
  mkdirSync(configDir, { recursive: true });
  const file = join(configDir, 'jevris.config.json');
  return { home, repo, configDir, file, preference: () => JSON.parse(readFileSync(file, 'utf8')).privacy.sourceEgress };
}

const denied = async () => 'not-approved';

test('the egress preference is a settable key with its own two values, and no longer an administrator key', () => {
  assert.equal(EGRESS_PREFERENCE_KEY, KEY);
  assert.equal(SETTABLE_KEYS[KEY](RAISE), RAISE);
  assert.equal(SETTABLE_KEYS[KEY](DENY), DENY);
  for (const bad of ['allowed', 'approved', 'true', '', 'APPROVED-SCOPED']) assert.equal(SETTABLE_KEYS[KEY](bad), undefined, bad);
  assert.equal(ADMIN_KEYS[KEY], undefined, 'the refusal "needs administrator consent through host policy, not configure" is gone');
  // The keys an administrator owns are still refused with their reasons.
  for (const key of ['provider.model', 'provider.credentialRef', 'decisions.allowUncalibratedActuation']) assert.notEqual(ADMIN_KEYS[key], undefined, key);
});

test('raising the preference needs a person at a terminal; lowering and the same value need no one', async () => {
  const f = fixture();
  // From the default: approved-scoped is a raise, deny-until-approved the same value.
  assert.equal(raisesAuthority({ home: f.home }, KEY, RAISE), true);
  assert.equal(raisesAuthority({ home: f.home }, KEY, DENY), false);
  // The refusal and the question say what the raise is, and that the administrator's half is separate.
  assert.equal(
    raiseRefusal(KEY, RAISE),
    `raising ${KEY} to ${RAISE} is your half of the consent for what may leave this machine, so it needs a person at an interactive terminal who answers y (never --yes, --json, MCP, a hook, a script, a pipe or a model's shell). Nothing was changed.`,
  );
  assert.equal(raiseWhat(KEY, RAISE), `raising ${KEY} to ${RAISE} is your half of the consent for what may leave this machine`);
  assert.equal(
    raisePrompt(KEY, RAISE),
    `Raise ${KEY} to ${RAISE}? It is your half of the consent for advice that quotes your text to Jev; nothing is sent until an administrator also approves egress (jevris egress approve). [y/N] `,
  );

  // No person: CHANNEL_REFUSED and nothing is written, not even the file.
  const refused = await setConfigValue({ home: f.home, key: KEY, value: RAISE, dryRun: false, sourceEgress: denied });
  assert.deepEqual([refused.ok, refused.reasonCode, refused.message], [false, 'CHANNEL_REFUSED', raiseRefusal(KEY, RAISE)]);
  assert.equal(existsSync(f.file), false, 'nothing was written');
  assert.equal(readEffectiveConfig({ home: f.home }).config.privacy.sourceEgress, DENY);
  // A dry run shows the change, writes nothing and asks no one.
  const dry = await setConfigValue({ home: f.home, key: KEY, value: RAISE, dryRun: true, sourceEgress: denied });
  assert.deepEqual([dry.dryRun, dry.changed], [true, [{ key: KEY, from: DENY, to: RAISE }]]);
  assert.equal(existsSync(f.file), false);

  // A person answered y (the CLI passes `confirmed` only after B's personAtTerminal): written, and only that key changes.
  const raised = await setConfigValue({ home: f.home, key: KEY, value: RAISE, dryRun: false, confirmed: true, sourceEgress: denied });
  assert.deepEqual(raised.changed, [{ key: KEY, from: DENY, to: RAISE }]);
  assert.equal(f.preference(), RAISE);
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), { ...DEFAULT_CONFIG, privacy: { ...DEFAULT_CONFIG.privacy, sourceEgress: RAISE } }, 'every other key keeps its value');
  // Already approved: the same value asks no one; lowering asks no one either.
  assert.equal(raisesAuthority({ home: f.home }, KEY, RAISE), false);
  const same = await setConfigValue({ home: f.home, key: KEY, value: RAISE, dryRun: false, sourceEgress: denied });
  assert.deepEqual(same.changed, []);
  const lowered = await setConfigValue({ home: f.home, key: KEY, value: DENY, dryRun: false, sourceEgress: denied });
  assert.deepEqual(lowered.changed, [{ key: KEY, from: RAISE, to: DENY }]);
  assert.equal(f.preference(), DENY);
  // After the lowering, raising again is a raise again.
  assert.equal(raisesAuthority({ home: f.home }, KEY, RAISE), true);
});

test('the preference alone never approves egress: the administrator\'s half is host policy and is not touched', async () => {
  const f = fixture();
  const hostFile = join(jevrisPaths({ home: f.home }).config, 'host.json');
  assert.equal(await hostSourceEgress(f.home), 'not-approved');
  await setConfigValue({ home: f.home, key: KEY, value: RAISE, dryRun: false, confirmed: true });
  // The person's half is on; the host decision is still the administrator's, still not approved, and no host file appeared.
  assert.equal(egressPreferenceApproved({ home: f.home }, { workspaceRoot: null }), true);
  assert.equal(await hostSourceEgress(f.home), 'not-approved');
  assert.equal(existsSync(hostFile), false, 'configure set never writes host.json');
  const shown = await loadEffectiveConfig({ home: f.home, workspaceRoot: null });
  assert.deepEqual([shown.effective.sourceEgress, shown.effective.sourceEgressSource, shown.effective.sourceEgressPreference], [DENY, 'host-policy', RAISE]);
  // With the administrator's approval (injected here as B's resolver would answer) both halves show; without the preference they would not matter to the consults.
  const both = await loadEffectiveConfig({ home: f.home, workspaceRoot: null, sourceEgress: async () => 'approved' });
  assert.deepEqual([both.effective.sourceEgress, both.effective.sourceEgressPreference], [RAISE, RAISE]);
});

test('a repository file never raises the preference, and an organization ceiling still caps it', async () => {
  const f = fixture();
  await setConfigValue({ home: f.home, key: KEY, value: RAISE, dryRun: false, confirmed: true });
  // A workspace file may only narrow: it cannot set this key at all (NOT_NARROWABLE), so with the person's value at deny it stays at deny.
  await setConfigValue({ home: f.home, key: KEY, value: DENY, dryRun: false });
  writeFileSync(join(f.repo, '.jevris', 'config.json'), JSON.stringify({ privacy: { sourceEgress: RAISE } })); // test-hygiene: not product source
  const repo = readEffectiveConfig({ home: f.home, workspaceRoot: f.repo });
  assert.equal(repo.config.privacy.sourceEgress, DENY, 'a repository file is not consent');
  assert.ok(repo.issues.some((i) => i.code === 'NOT_NARROWABLE' && i.path === `workspace:${KEY}`), JSON.stringify(repo.issues));
  assert.equal(egressPreferenceApproved({ home: f.home }, { workspaceRoot: f.repo }), false);
  // And a repository file cannot lower what the person raised below the person's own value either: it is ignored whole.
  await setConfigValue({ home: f.home, key: KEY, value: RAISE, dryRun: false, confirmed: true });
  writeFileSync(join(f.repo, '.jevris', 'config.json'), JSON.stringify({ privacy: { sourceEgress: DENY } })); // test-hygiene: not product source
  assert.equal(readEffectiveConfig({ home: f.home, workspaceRoot: f.repo }).config.privacy.sourceEgress, RAISE, 'the person\'s own file decides this key');
  // An organization that denies egress caps the person's preference, whatever the file says.
  writeFileSync(
    join(f.configDir, 'organization.json'),
    JSON.stringify({
      schemaVersion: '1.0',
      mode: 'bounded-auto',
      egress: DENY,
      retention: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 },
      budget: { maxRequestBytes: 131072 },
      pin: { model: 'jev-1.13.0', respectHumanPins: true },
      packPrivileges: [],
      credentialRef: 'host-secret:typesafe-primary',
      installerEnvName: 'TYPESAFE_API_KEY',
      allowUncalibratedActuation: false,
    }),
  );
  const capped = readEffectiveConfig({ home: f.home, workspaceRoot: null });
  assert.equal(capped.config.privacy.sourceEgress, DENY);
  assert.ok(capped.narrowed.some((n) => n.layer === 'organization' && n.key === KEY && n.to === DENY), JSON.stringify(capped.narrowed));
  assert.equal(egressPreferenceApproved({ home: f.home }, { workspaceRoot: null }), false);
});

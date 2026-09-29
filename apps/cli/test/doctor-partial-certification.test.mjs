// Doctor with signed records for some installed harnesses but not all: the top block names only
// the uncertified ones, never calls a certified harness uncertified, and the worker.route and
// adapter rows follow the harness rows (the legacy `certificationRecords: []` input to runDoctor
// only feeds actuators no signed record kind covers). Pure: no home, no harness, no keychain.
import test from 'node:test';
import assert from 'node:assert/strict';

const { topBlock } = await import('../dist/doctor-cli.js');

const row = (harness, version, certifiedFeatures) => ({
  harness,
  installed: true,
  version,
  certificationRecords: certifiedFeatures.length > 0 ? 1 : 0,
  certifiedFeatures,
  certifyCommand: `jevris certify --harness ${harness}`,
  smoke: [{ ok: true }],
  unsupported: [],
  upgrade: false,
  coverage: certifiedFeatures.length > 0 ? { range: `>=${version}`, lastVerified: version, verifiedAt: '2026-09-28T00:00:00.000Z' } : null,
  uncertified: [],
  newest: null,
  reverify: null,
});

test('doctor names only the harnesses without a signed record when some are certified', () => {
  const rows = [row('claude', '2.1.282', ['hooks.observe', 'hooks.context', 'worker.route']), row('codex', '0.157.1', [])];
  const top = topBlock(rows, false);
  assert.equal(top.full, false, 'the machine is not fully certified while codex has no record');
  assert.match(top.explain.harnessProbe, /no signed record covers codex 0\.157\.1 on this host yet/);
  assert.doesNotMatch(top.explain.harnessProbe, /claude/, 'the certified harness is never named uncertified');
  assert.match(top.explain.installStatus, /no signed record for this version here: codex 0\.157\.1/);
  assert.doesNotMatch(top.explain.installStatus, /claude/);
});

test('doctor is full once every installed harness has a signed record', () => {
  const top = topBlock([row('claude', '2.1.282', ['hooks.observe']), row('codex', '0.157.1', ['hooks.observe'])], false);
  assert.equal(top.full, true);
  assert.match(top.explain.installStatus, /every installed harness is certified/);
});

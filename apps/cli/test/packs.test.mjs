// PAK-01..08, W11, US28, US34, US40: the pack runtime and registry. Every test uses a temporary
// home; nothing touches the real one, and no harness binary starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { managedHostSkip } from '../../../test/managed-host.mjs';

const { PackManifestContract, adviseOnly, evaluateRules, packOwns } = await import('../dist/packs/manifest.js');
const { computeDelta } = await import('../dist/packs/delta.js');
const { calibrationFor, checkCalibrationBindings } = await import('../dist/packs/calibration.js');
const { readPackDir } = await import('../dist/packs/files.js');
const registry = await import('../dist/packs/registry.js');
const { isolationArgs, permissionModelDeniesNetwork, runPackExecutable } = await import('../dist/packs/isolation.js');
const { addPublisher } = await import('../dist/packs/trust.js');
const { runAdminCommand } = await import('../dist/admin-cli.js');
const { readKillSwitchStopped } = await import('../dist/kill-switch.js');
const { signRecord, HOST_SECRET_REF } = await import('../../../packages/contracts/dist/index.js');
const { jevrisPaths } = await import('../../../packages/platform/dist/index.js');

const root = fileURLToPath(new URL('../../..', import.meta.url));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-packs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const home = join(dir, 'home');
  mkdirSync(home);
  const publishers = join(dir, 'shipped-publishers.json');
  writeFileSync(publishers, JSON.stringify({ schemaVersion: 1, publishers: [] }));
  let clock = Date.parse('2026-09-26T10:00:00Z');
  const opts = () => ({ shippedPublishers: publishers, nowMs: (clock += 1000) });
  return { dir, home, publishers, opts };
}

function writePack(dir, manifest, files = {}) {
  mkdirSync(dir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    const path = join(dir, ...rel.split('/'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  writeFileSync(join(dir, 'pack.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

const FIXTURE = { 'fixtures/routing/cheap.json': JSON.stringify({ decision: 'route.v1', outcome: { selected: 'cheap' }, expect: { action: 'advise' } }) };

function manifest(over = {}) {
  return {
    schemaVersion: '1.0',
    id: 'jevris.testpack',
    version: '0.1.0',
    maturity: 'experimental',
    description: 'A test pack',
    requiresCapabilities: [],
    fallbackCapabilities: [],
    decisionSpecs: ['route.v1'],
    actions: ['advise', 'abstain'],
    dataScopes: ['task-metadata'],
    defaultMode: 'advise',
    conflicts: [],
    fixtures: ['routing/cheap'],
    evidenceSelectors: [{ id: 'objective', builder: 'task-objective', priority: 'mandatory', maxItems: 1 }],
    decisions: [{ id: 'route.v1', kind: 'choice', domain: 'worker-routing', question: 'Which worker tier fits this task?', evidence: ['objective'], options: ['cheap', 'strong'] }],
    rules: [{ id: 'cheap-advice', decision: 'route.v1', selected: 'cheap', action: 'advise' }],
    ...over,
  };
}

function shadowReport(dir, recordCount = 3, actuationCount = 0) {
  const path = join(dir, `shadow-${recordCount}-${actuationCount}.json`);
  writeFileSync(path, JSON.stringify({ schemaVersion: '1.0', kind: 'shadow-report', baselines: ['rules-only', 'native', 'jev'], recordCount, actuationCount, measuredSpeedRatio: null, measuredCostRatio: null }));
  return path;
}

function hostPolicy(home, over = {}) {
  const config = jevrisPaths({ home }).config;
  mkdirSync(config, { recursive: true });
  const doc = {
    schemaVersion: '1.0',
    mode: 'advise',
    egress: 'deny-until-approved',
    retention: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 },
    budget: { maxRequestBytes: 131072 },
    pin: { model: 'jev-1.13.0', respectHumanPins: true },
    packPrivileges: ['advise', 'abstain', 'task-metadata', 'request-checkpoint'],
    credentialRef: HOST_SECRET_REF,
    installerEnvName: 'JEVRIS_TYPESAFE_KEY',
    allowUncalibratedActuation: false,
    ...over,
  };
  writeFileSync(join(config, 'host.json'), `${JSON.stringify(doc)}\n`, { mode: 0o600 });
  return doc;
}

/** install, test and attach a shadow report: the version is then ready for approval. */
async function ready(box, source) {
  const installed = await registry.installPack(box.home, source, box.opts());
  assert.equal(installed.ok, true, JSON.stringify(installed));
  const tested = await registry.testPack(box.home, installed.packId, installed.version, box.opts());
  assert.equal(tested.passed, true, JSON.stringify(tested));
  const shadowed = await registry.shadowPack(box.home, installed.packId, installed.version, shadowReport(box.dir), box.opts());
  assert.equal(shadowed.ok, true, JSON.stringify(shadowed));
  const record = await registry.getPack(box.home, installed.packId);
  return { ...installed, deltaHash: record.versions[installed.version].deltaHash };
}

test('PAK-01: the SSOT routing.pack.json example and the built-in packs load; the extended manifest checks its cross-references', () => {
  const example = JSON.parse(readFileSync(join(root, 'fixtures', 'ssot', 'examples', 'routing.pack.json'), 'utf8'));
  const loaded = PackManifestContract.validate(example);
  assert.equal(loaded.ok, true, JSON.stringify(loaded.issues));
  assert.deepEqual(packOwns(loaded.value), ['worker-model-router']);
  assert.equal(PackManifestContract.validate(manifest()).ok, true);

  const codes = (value) => {
    const result = PackManifestContract.validate(value);
    return result.ok ? [] : result.issues.map((issue) => issue.code);
  };
  // An evidence builder must be on the allowlist, and its data scope declared.
  assert.ok(codes(manifest({ evidenceSelectors: [{ id: 'x', builder: 'read-any-file', priority: 'high', maxItems: 1 }] })).length > 0);
  assert.ok(codes(manifest({ evidenceSelectors: [{ id: 'objective', builder: 'source-spans', priority: 'high', maxItems: 1 }] })).includes('EVIDENCE_SCOPE_NOT_DECLARED'));
  assert.ok(codes(manifest({ rules: [{ id: 'r', decision: 'route.v1', selected: 'cheap', action: 'route-worker' }] })).includes('ACTION_NOT_DECLARED'));
  assert.ok(codes(manifest({ rules: [{ id: 'r', decision: 'route.v1', selected: 'medium', action: 'advise' }] })).includes('OPTION_UNKNOWN'));
  assert.ok(codes(manifest({ decisions: [{ id: 'other.v1', kind: 'noul', domain: 'd', question: 'q', evidence: ['objective'] }] })).includes('DECISION_NOT_DECLARED'));
  assert.ok(codes(manifest({ conflicts: ['anything goes'] })).includes('CONFLICT_FORM'));
  assert.ok(codes(manifest({ settings: [{ key: 'depth', type: 'integer', default: 'deep' }] })).includes('SETTING_DEFAULT_TYPE'));
  assert.ok(codes(manifest({ executables: [{ id: 'x', path: '../escape.js', sha256: 'a'.repeat(64), runtime: 'node', writesPackData: false, timeoutMs: 1000 }] })).length > 0, 'a path outside the pack is refused');
  assert.ok(codes(manifest({ unknownField: true })).length > 0, 'unknown fields are refused');

  assert.deepEqual(evaluateRules(manifest(), { decision: 'route.v1', selected: 'cheap' }), { action: 'advise', ruleId: 'cheap-advice' });
  assert.deepEqual(evaluateRules(manifest(), { decision: 'route.v1', selected: 'strong' }), { action: 'abstain', ruleId: null });
  assert.deepEqual(evaluateRules(manifest(), { decision: 'route.v1', selected: 'cheap', abstained: true }), { action: 'abstain', ruleId: null });
});

test('PAK-01: packs live under <data>/packs/<id>/<version>, enable per workspace, and two packs claiming one exclusive domain are refused', { skip: managedHostSkip() }, async (t) => {
  const box = sandbox(t);
  const first = writePack(join(box.dir, 'a'), manifest({ id: 'jevris.router-a', conflicts: ['exclusive:worker-model-router'] }), FIXTURE);
  const second = writePack(join(box.dir, 'b'), manifest({ id: 'jevris.router-b', conflicts: ['exclusive:worker-model-router'] }), FIXTURE);
  const a = await ready(box, first);
  assert.ok(existsSync(join(jevrisPaths({ home: box.home }).data, 'packs', 'jevris.router-a', '0.1.0', 'pack.json')));
  assert.equal((await registry.approvePack(box.home, a.deltaHash, box.opts())).ok, true);
  const b = await ready(box, second);
  const clash = await registry.approvePack(box.home, b.deltaHash, box.opts());
  assert.equal(clash.reasonCode, 'EXCLUSIVE_CONFLICT');
  assert.match(clash.detail, /worker-model-router: jevris\.router-a, jevris\.router-b/);

  const workspace = join(box.dir, 'ws');
  const elsewhere = join(box.dir, 'other');
  mkdirSync(workspace);
  mkdirSync(elsewhere);
  assert.deepEqual(await registry.activePacksFor(box.home, workspace, { shippedPublishers: box.publishers }), [], 'nothing runs until enabled');
  assert.equal((await registry.setPackEnabled(box.home, 'jevris.router-a', workspace, true, box.opts())).ok, true);
  const loaded = await registry.activePacksFor(box.home, workspace, { shippedPublishers: box.publishers });
  assert.deepEqual(loaded.map((item) => [item.id, item.version, item.stage, item.mode]), [['jevris.router-a', '0.1.0', 'canary', 'advise']]);
  assert.deepEqual(await registry.activePacksFor(box.home, elsewhere, { shippedPublishers: box.publishers }), []);
  // Missing capabilities fall back to advice when the fallback is present, else the pack is off.
  const offHere = await registry.activePacksFor(box.home, workspace, { shippedPublishers: box.publishers, harness: 'codex', capabilities: new Set() });
  assert.equal(offHere[0].mode, 'advise', 'no adapters listed and no capability required: still advice');
  assert.equal((await registry.setPackEnabled(box.home, 'jevris.router-a', workspace, false, box.opts())).ok, true);
  assert.deepEqual(await registry.activePacksFor(box.home, workspace, { shippedPublishers: box.publishers }), []);
});

test('PAK-02: install shows the executable, egress, tool-access and retention delta against the active version and host policy, with reason codes', { skip: managedHostSkip() }, async (t) => {
  const box = sandbox(t);
  const v1 = manifest();
  const v2 = manifest({
    version: '0.2.0',
    dataScopes: ['task-metadata', 'approved-tool-output'],
    actions: ['advise', 'abstain', 'request-checkpoint'],
    network: [{ host: 'api.example.com', purpose: 'fetch model prices' }],
    tools: ['mcp:jevris_verify'],
    effects: ['write-pack-data'],
    storage: { retentionDays: 30, migrations: [{ id: 'v2-index', fromVersion: '0.1.0', toVersion: '0.2.0', reversible: false }] },
    executables: [{ id: 'scorer', path: 'bin/scorer.cjs', sha256: 'b'.repeat(64), runtime: 'node', writesPackData: false, timeoutMs: 1000 }],
  });
  const host = hostPolicy(box.home);
  const delta = computeDelta(v2, v1, host);
  const got = delta.items.map((item) => `${item.category} ${item.reasonCode} ${item.value.split(' ')[0]} ${item.policy}`);
  assert.deepEqual(got, [
    'executable EXECUTABLE_ADDED scorer within',
    'egress EGRESS_DESTINATION_ADDED api.example.com ceiling',
    'egress DATA_SCOPE_ADDED approved-tool-output ceiling',
    'tool-access ACTION_ADDED request-checkpoint within',
    'tool-access TOOL_ACCESS_ADDED mcp:jevris_verify within',
    'tool-access EFFECT_ADDED write-pack-data within',
    'retention RETENTION_INCREASED 0 ceiling',
    'retention STORAGE_MIGRATION_IRREVERSIBLE v2-index within',
  ]);
  assert.match(delta.hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(computeDelta(v2, v1, host).hash, delta.hash, 'deterministic');
  assert.notEqual(computeDelta(v2, null, host).hash, delta.hash, 'bound to the active version');
  assert.deepEqual(computeDelta(v1, v1, host).items, [], 'the same version adds nothing');
  // Without a host policy nothing is beyond a ceiling, but every item is still shown.
  assert.ok(computeDelta(v2, v1, null).items.every((item) => item.policy === 'within'));

  // Through the registry: an item beyond the host policy cannot be approved.
  const src = writePack(join(box.dir, 'wide'), manifest({ id: 'jevris.wide', network: [{ host: 'api.example.com', purpose: 'prices' }] }), FIXTURE);
  const wide = await ready(box, src);
  const refusedCeiling = await registry.approvePack(box.home, wide.deltaHash, box.opts());
  assert.equal(refusedCeiling.reasonCode, 'POLICY_CEILING');
  assert.match(refusedCeiling.detail, /EGRESS_DESTINATION_ADDED api\.example\.com/);
});

test('PAK-03: an unsigned or unlisted pack cannot activate an executable component; a signature from an allowlisted publisher can', { skip: managedHostSkip() }, async (t) => {
  const box = sandbox(t);
  const component = 'process.stdout.write(JSON.stringify({ proposals: [] }) + "\\n");\n';
  const files = { ...FIXTURE, 'bin/component.cjs': component };
  const exec = [{ id: 'component', path: 'bin/component.cjs', sha256: sha(component), runtime: 'node', writesPackData: false, timeoutMs: 5000 }];
  const pins = Object.entries(files).map(([path, text]) => ({ path, sha256: sha(text) }));

  const unsigned = await ready(box, writePack(join(box.dir, 'unsigned'), manifest({ id: 'jevris.exec-unsigned', executables: exec }), files));
  assert.equal((await registry.approvePack(box.home, unsigned.deltaHash, box.opts())).reasonCode, 'UNSIGNED_EXECUTABLE');

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const signed = signRecord(manifest({ id: 'jevris.exec-signed', executables: exec, files: pins, publisher: 'acme' }), pem, 'acme-2026');
  const ready1 = await ready(box, writePack(join(box.dir, 'signed'), signed, files));
  assert.equal(ready1.signature, 'unlisted-publisher');
  assert.equal((await registry.approvePack(box.home, ready1.deltaHash, box.opts())).reasonCode, 'PUBLISHER_NOT_ALLOWED');
  assert.equal((await addPublisher(box.home, 'acme', 'acme-2026', publicKey.export({ type: 'spki', format: 'pem' }))).ok, true);
  const approved = await registry.approvePack(box.home, ready1.deltaHash, box.opts());
  assert.equal(approved.ok, true, JSON.stringify(approved));

  // A tampered signed pack is refused at install: the pins no longer match.
  const tampered = writePack(join(box.dir, 'tampered'), signed, { ...files, 'bin/component.cjs': `${component}// changed\n` });
  assert.equal((await registry.installPack(box.home, tampered, box.opts())).reasonCode, 'FILE_CHANGED');
  // A forged signature (a different key under the listed key id) is refused.
  const other = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  const forged = signRecord(manifest({ id: 'jevris.exec-forged', executables: exec, files: pins, publisher: 'acme' }), other, 'acme-2026');
  const forgedReady = await ready(box, writePack(join(box.dir, 'forged'), forged, files));
  assert.equal(forgedReady.signature, 'bad-signature');
  assert.equal((await registry.approvePack(box.home, forgedReady.deltaHash, box.opts())).reasonCode, 'PUBLISHER_NOT_ALLOWED');
});

test('PAK-04: draft, fixture-tested, shadow-approved, canary and stable; approval writes policy-previous; a canary regression rolls back and activates the kill switch; history is kept', { skip: managedHostSkip() }, async (t) => {
  const box = sandbox(t);
  hostPolicy(box.home);
  const src1 = writePack(join(box.dir, 'v1'), manifest(), FIXTURE);
  const installed = await registry.installPack(box.home, src1, box.opts());
  assert.equal(installed.stage, 'draft');
  const record0 = await registry.getPack(box.home, 'jevris.testpack');
  assert.equal((await registry.approvePack(box.home, record0.versions['0.1.0'].deltaHash, box.opts())).reasonCode, 'STAGE_NOT_READY', 'a draft cannot be approved');
  assert.equal((await registry.shadowPack(box.home, 'jevris.testpack', '0.1.0', shadowReport(box.dir), box.opts())).reasonCode, 'STAGE_NOT_READY', 'shadow needs passing fixtures');
  assert.equal((await registry.testPack(box.home, 'jevris.testpack', '0.1.0', box.opts())).stage, 'fixture-tested');
  assert.equal((await registry.shadowPack(box.home, 'jevris.testpack', '0.1.0', shadowReport(box.dir, 0), box.opts())).reasonCode, 'SHADOW_REPORT_INVALID');
  assert.equal((await registry.shadowPack(box.home, 'jevris.testpack', '0.1.0', shadowReport(box.dir, 2, 1), box.opts())).reasonCode, 'SHADOW_REPORT_INVALID', 'a shadow run that actuated is not shadow evidence');
  assert.equal((await registry.shadowPack(box.home, 'jevris.testpack', '0.1.0', shadowReport(box.dir), box.opts())).ok, true);
  const hash1 = (await registry.getPack(box.home, 'jevris.testpack')).versions['0.1.0'].deltaHash;
  const approved = await registry.approvePack(box.home, hash1, box.opts());
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(approved.policyPrevious, true);
  const config = jevrisPaths({ home: box.home }).config;
  assert.deepEqual(JSON.parse(readFileSync(join(config, 'policy-previous.json'), 'utf8')).packPrivileges, ['advise', 'abstain', 'task-metadata', 'request-checkpoint']);

  const metrics = (over) => {
    const path = join(box.dir, `metrics-${Math.random().toString(16).slice(2)}.json`);
    writeFileSync(path, JSON.stringify({ schemaVersion: '1.0', packId: 'jevris.testpack', version: '0.1.0', tasks: 25, verifiedSuccessRate: 0.9, baselineVerifiedSuccessRate: 0.88, privacyViolations: 0, ...over }));
    return JSON.parse(readFileSync(path, 'utf8'));
  };
  assert.equal((await registry.promotePack(box.home, 'jevris.testpack', box.opts())).reasonCode, 'CANARY_INSUFFICIENT');
  assert.equal((await registry.canaryPack(box.home, 'jevris.testpack', metrics({ tasks: 5 }), box.opts())).regression, false);
  assert.equal((await registry.promotePack(box.home, 'jevris.testpack', box.opts())).reasonCode, 'CANARY_INSUFFICIENT', 'too few canary tasks');
  assert.equal((await registry.canaryPack(box.home, 'jevris.testpack', metrics({}), box.opts())).regression, false);
  assert.equal((await registry.promotePack(box.home, 'jevris.testpack', box.opts())).ok, true);
  assert.equal((await registry.getPack(box.home, 'jevris.testpack')).versions['0.1.0'].stage, 'stable');

  // Upgrade to 0.2.0, then a canary privacy violation: rolled back to 0.1.0, kill switch on.
  const v2 = await ready(box, writePack(join(box.dir, 'v2'), manifest({ version: '0.2.0' }), FIXTURE));
  const approved2 = await registry.approvePack(box.home, v2.deltaHash, box.opts());
  assert.equal(approved2.previous, '0.1.0');
  const regression = await registry.canaryPack(box.home, 'jevris.testpack', { ...metrics({ privacyViolations: 1 }), version: '0.2.0' }, box.opts());
  assert.deepEqual([regression.regression, regression.reasons, regression.rolledBackTo, regression.killSwitch], [true, ['PRIVACY_VIOLATION'], '0.1.0', true]);
  assert.equal(await readKillSwitchStopped(box.home), true);
  const after = await registry.getPack(box.home, 'jevris.testpack');
  assert.equal(after.active, '0.1.0');
  assert.deepEqual(after.history.map((event) => event.event), ['install', 'test', 'shadow', 'approve', 'canary', 'canary', 'promote', 'install', 'test', 'shadow', 'approve', 'canary', 'rollback', 'kill-switch']);
  // While the kill switch is stopped, no pack activates and loaded packs are held at observe.
  const workspace = join(box.dir, 'ws');
  mkdirSync(workspace);
  await registry.setPackEnabled(box.home, 'jevris.testpack', workspace, true, box.opts());
  const held = await registry.activePacksFor(box.home, workspace, { shippedPublishers: box.publishers });
  assert.deepEqual([held[0].version, held[0].mode, held[0].reasons.includes('KILL_SWITCH')], ['0.1.0', 'observe', true]);
});

test('PAK-04: a quality regression rolls back without the kill switch unless asked; a stale delta hash is refused', { skip: managedHostSkip() }, async (t) => {
  const box = sandbox(t);
  const v1 = await ready(box, writePack(join(box.dir, 'v1'), manifest(), FIXTURE));
  assert.equal((await registry.approvePack(box.home, v1.deltaHash, box.opts())).ok, true);
  const v2 = await ready(box, writePack(join(box.dir, 'v2'), manifest({ version: '0.2.0' }), FIXTURE));
  const v3 = await ready(box, writePack(join(box.dir, 'v3'), manifest({ version: '0.3.0', actions: ['advise', 'abstain', 'request-checkpoint'], rules: [{ id: 'cheap-advice', decision: 'route.v1', selected: 'cheap', action: 'advise' }] }), FIXTURE));
  assert.equal((await registry.approvePack(box.home, v2.deltaHash, box.opts())).ok, true);
  // v3's delta was computed against 0.1.0; 0.2.0 is active now.
  const stale = await registry.approvePack(box.home, v3.deltaHash, box.opts());
  assert.equal(stale.reasonCode, 'DELTA_STALE');
  const fresh = (await registry.getPack(box.home, 'jevris.testpack')).versions['0.3.0'].deltaHash;
  assert.notEqual(fresh, v3.deltaHash);
  const quality = await registry.canaryPack(box.home, 'jevris.testpack', { schemaVersion: '1.0', packId: 'jevris.testpack', version: '0.2.0', tasks: 30, verifiedSuccessRate: 0.7, baselineVerifiedSuccessRate: 0.9, privacyViolations: 0 }, box.opts());
  assert.deepEqual([quality.reasons, quality.rolledBackTo, quality.killSwitch], [['QUALITY_REGRESSION'], '0.1.0', null]);
  assert.equal(await readKillSwitchStopped(box.home), false);
});

test('PAK-05: an irreversible storage migration takes a verified backup first, and rollback restores it', { skip: managedHostSkip() }, async (t) => {
  const box = sandbox(t);
  const v1 = await ready(box, writePack(join(box.dir, 'v1'), manifest({ storage: { retentionDays: 0 } }), FIXTURE));
  assert.equal((await registry.approvePack(box.home, v1.deltaHash, box.opts())).ok, true);
  const data = registry.packDataDir(box.home, 'jevris.testpack');
  mkdirSync(join(data, 'index'), { recursive: true });
  writeFileSync(join(data, 'index', 'v1.json'), '{"format":1}');
  const v2 = await ready(box, writePack(join(box.dir, 'v2'), manifest({ version: '0.2.0', storage: { retentionDays: 0, migrations: [{ id: 'reindex', fromVersion: '0.1.0', toVersion: '0.2.0', reversible: false }] } }), FIXTURE));
  const approved = await registry.approvePack(box.home, v2.deltaHash, box.opts());
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.ok(approved.backup !== null);
  assert.equal(readFileSync(join(approved.backup, 'data', 'index', 'v1.json'), 'utf8'), '{"format":1}');
  assert.match(readFileSync(join(approved.backup, 'RESTORE.txt'), 'utf8'), /jevris pack rollback jevris\.testpack/);
  // The migration rewrites the data; rollback brings the backup back and keeps the replaced data.
  writeFileSync(join(data, 'index', 'v1.json'), '{"format":2}');
  const rolled = await registry.rollbackPack(box.home, 'jevris.testpack', box.opts());
  assert.deepEqual([rolled.to, rolled.restoredBackup], ['0.1.0', approved.backup]);
  assert.equal(readFileSync(join(data, 'index', 'v1.json'), 'utf8'), '{"format":1}');
});

test('PAK-06: an executable component runs in a separate Node process under the permission model; undeclared actions are dropped', { skip: managedHostSkip() }, async (t) => {
  const box = sandbox(t);
  const outside = join(box.dir, 'secret.txt');
  writeFileSync(outside, 'secret');
  assert.deepEqual(isolationArgs('/p/v', '/p/v/bin/c.cjs', null), ['--permission', '--allow-fs-read=/p/v', '--disable-warning=ExperimentalWarning', '/p/v/bin/c.cjs']);
  assert.equal(permissionModelDeniesNetwork('24.9.0'), false);
  assert.equal(permissionModelDeniesNetwork('25.0.0'), true);
  const component = [
    "const fs = require('fs');",
    "let input = ''; process.stdin.on('data', (c) => (input += c));",
    "process.stdin.on('end', async () => {",
    '  const seen = [];',
    `  try { fs.readFileSync(${JSON.stringify(outside)}); seen.push('read:open'); } catch (e) { seen.push('read:' + e.code); }`,
    "  try { require('child_process').execFileSync(process.execPath, ['-e', '0']); seen.push('spawn:open'); } catch (e) { seen.push('spawn:' + e.code); }",
    "  await new Promise((r) => { const s = require('net').connect(9, '127.0.0.1'); s.on('error', (e) => { seen.push('net:' + e.code); r(); }); s.on('connect', () => { seen.push('net:open'); s.destroy(); r(); }); });",
    "  const got = JSON.parse(input);",
    "  process.stdout.write(JSON.stringify({ proposals: [{ action: 'advise', reason: seen.join(',') + ' input:' + got.input.task }, { action: 'route-worker', reason: 'not declared' }] }) + '\\n');",
    '});',
    '',
  ].join('\n');
  const files = { ...FIXTURE, 'bin/component.cjs': component };
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const signed = signRecord(
    manifest({ executables: [{ id: 'component', path: 'bin/component.cjs', sha256: sha(component), runtime: 'node', writesPackData: false, timeoutMs: 20000 }], files: Object.entries(files).map(([path, text]) => ({ path, sha256: sha(text) })), publisher: 'acme' }),
    pem,
    'acme-1',
  );
  await addPublisher(box.home, 'acme', 'acme-1', publicKey.export({ type: 'spki', format: 'pem' }));
  const r = await ready(box, writePack(join(box.dir, 'exec'), signed, files));
  assert.equal((await registry.approvePack(box.home, r.deltaHash, box.opts())).ok, true);
  if (!permissionModelDeniesNetwork()) {
    const refusedRun = await runPackExecutable(box.home, 'jevris.testpack', 'component', { task: 'x' }, { shippedPublishers: box.publishers });
    assert.equal(refusedRun.reasonCode, 'ISOLATION_UNAVAILABLE', 'without network denial an executable pack never runs');
    return;
  }
  const ran = await runPackExecutable(box.home, 'jevris.testpack', 'component', { task: 'rank' }, { shippedPublishers: box.publishers });
  assert.equal(ran.ok, true, JSON.stringify(ran));
  assert.equal(ran.rejected, 1, 'route-worker is not a declared action');
  assert.equal(ran.proposals.length, 1);
  assert.match(ran.proposals[0].reason, /read:ERR_ACCESS_DENIED/);
  assert.match(ran.proposals[0].reason, /spawn:ERR_ACCESS_DENIED/);
  assert.match(ran.proposals[0].reason, /net:ERR_ACCESS_DENIED/);
  assert.match(ran.proposals[0].reason, /input:rank/);
  // After the installed file is altered, nothing runs.
  writeFileSync(join(registry.packVersionDir(box.home, 'jevris.testpack', '0.1.0'), 'bin', 'component.cjs'), `${component}\n`);
  assert.equal((await runPackExecutable(box.home, 'jevris.testpack', 'component', {}, { shippedPublishers: box.publishers })).reasonCode, 'PACK_TAMPERED');
});

test('PAK-07: jevris.observability and jevris.memory ship, validate against the pack schema and load advise-only', { skip: managedHostSkip() }, async (t) => {
  const box = sandbox(t);
  const ajv = new Ajv2020({ strict: true });
  const validate = ajv.compile(JSON.parse(readFileSync(join(root, 'assets', 'schemas', 'pack-manifest.schema.json'), 'utf8')));
  const workspace = join(box.dir, 'ws');
  mkdirSync(workspace);
  for (const [name, id] of [['observability', 'jevris.observability'], ['memory', 'jevris.memory']]) {
    const dir = join(root, 'packs', name);
    const raw = JSON.parse(readFileSync(join(dir, 'pack.json'), 'utf8'));
    assert.equal(validate(raw), true, `${id}: ${JSON.stringify(validate.errors)}`);
    const read = await readPackDir(dir);
    assert.equal(read.ok, true);
    assert.equal(read.manifest.id, id);
    assert.equal(adviseOnly(read.manifest), true);
    const r = await ready(box, dir);
    assert.equal((await registry.approvePack(box.home, r.deltaHash, box.opts())).ok, true);
    await registry.setPackEnabled(box.home, id, workspace, true, box.opts());
  }
  const loaded = await registry.activePacksFor(box.home, workspace, { shippedPublishers: box.publishers });
  assert.deepEqual(loaded.map((item) => [item.id, item.mode]), [['jevris.memory', 'advise'], ['jevris.observability', 'advise']]);
});

function calibrationArtifact(pem, over = {}) {
  return signRecord(
    {
      id: 'cal-route-1',
      schemaVersion: '1.0',
      releaseState: 'released',
      decisionSpecId: 'route.v1',
      decisionSpecVersion: '1',
      dataset: { id: 'ds', version: '1', contentHash: `sha256:${'1'.repeat(64)}` },
      questionHash: `sha256:${'2'.repeat(64)}`,
      model: { modelId: 'jev-1.13.0', revisionHash: `sha256:${'3'.repeat(64)}` },
      encoderHash: `sha256:${'4'.repeat(64)}`,
      threshold: { metric: 'choice-probability', value: 0.7, errorBudget: 0.05 },
      permittedSlices: [{ sliceId: 'ts', calibrationSampleSize: 200, holdoutSampleSize: 200 }],
      uncertaintyInterval: { lower: 0.6, upper: 0.8, confidenceLevel: 0.95, method: 'wilson' },
      reviewer: { id: 'reviewer', reviewedAt: '2026-09-01T00:00:00Z' },
      issuedAt: '2026-09-02T00:00:00Z',
      expiresAt: '2027-09-02T00:00:00Z',
      expiryConditions: ['encoder-changed'],
      ...over,
    },
    pem,
    'calibration-key',
  );
}

test('PAK-08: each pack binds its calibration per pack, model and encoder; the loader refuses a mismatch', { skip: managedHostSkip() }, async (t) => {
  const box = sandbox(t);
  const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  const artifact = `${JSON.stringify(calibrationArtifact(pem))}\n`;
  const binding = (over = {}) => ({ decisionSpecId: 'route.v1', modelId: 'jev-1.13.0', encoderHash: `sha256:${'4'.repeat(64)}`, artifact: 'calibration/route.json', artifactHash: `sha256:${sha(artifact)}`, ...over });
  const files = { ...FIXTURE, 'calibration/route.json': artifact };

  const good = manifest({ calibration: [binding()] });
  const read = await readPackDir(writePack(join(box.dir, 'good'), good, files));
  const check = checkCalibrationBindings(read.manifest, read.files);
  assert.deepEqual([check.bound.length, check.refused], [1, []]);
  assert.equal(calibrationFor(check, { decisionSpecId: 'route.v1', modelId: 'jev-1.13.0', encoderHash: `sha256:${'4'.repeat(64)}` }).ok, true);
  assert.equal(calibrationFor(check, { decisionSpecId: 'route.v1', modelId: 'jev-1.14.0', encoderHash: `sha256:${'4'.repeat(64)}` }).reasonCode, 'CALIBRATION_MISMATCH', 'another model never reuses it');
  assert.equal(calibrationFor(check, { decisionSpecId: 'route.v1', modelId: 'jev-1.13.0', encoderHash: `sha256:${'5'.repeat(64)}` }).reasonCode, 'CALIBRATION_MISMATCH', 'another encoder never reuses it');

  const wrongEncoder = await readPackDir(writePack(join(box.dir, 'enc'), manifest({ calibration: [binding({ encoderHash: `sha256:${'5'.repeat(64)}` })] }), files));
  assert.equal(checkCalibrationBindings(wrongEncoder.manifest, wrongEncoder.files).refused[0].reasonCode, 'CALIBRATION_MISMATCH');
  const altered = await readPackDir(writePack(join(box.dir, 'alt'), manifest({ calibration: [binding({ artifactHash: `sha256:${'0'.repeat(64)}` })] }), files));
  assert.equal(checkCalibrationBindings(altered.manifest, altered.files).refused[0].reasonCode, 'CALIBRATION_CHANGED');

  // The registry refuses to approve a pack whose binding does not match its artifact.
  const bad = await ready(box, writePack(join(box.dir, 'bad'), manifest({ id: 'jevris.badcal', calibration: [binding({ modelId: 'jev-1.14.0' })] }), files));
  const refusedApproval = await registry.approvePack(box.home, bad.deltaHash, box.opts());
  assert.equal(refusedApproval.reasonCode, 'CALIBRATION_MISMATCH');
  const ok = await ready(box, writePack(join(box.dir, 'ok'), good, files));
  assert.equal((await registry.approvePack(box.home, ok.deltaHash, box.opts())).ok, true);
});

// JEV-0036: the documented flow is `jevris shadow --out f`, then `jevris pack shadow <id>@<v> --report f`.
test('pack shadow accepts the comparison record jevris shadow --out writes, and still refuses records that are not shadow evidence (JEV-0036)', { skip: managedHostSkip() }, async (t) => {
  const { recordShadowComparison } = await import('../../../packages/core/dist/index.js');
  const box = sandbox(t);
  hostPolicy(box.home);
  assert.equal((await registry.installPack(box.home, writePack(join(box.dir, 'v1'), manifest(), FIXTURE), box.opts())).stage, 'draft');
  assert.equal((await registry.testPack(box.home, 'jevris.testpack', '0.1.0', box.opts())).stage, 'fixture-tested');

  const destination = join(box.dir, 'comparison.json');
  const recorded = await recordShadowComparison({
    policyVersion: 'policyV1',
    actualModel: 'claude-sonnet-5',
    rulesInput: { kind: 'known-failure', family: 'type_error' },
    setting: { provenance: 'administrator', sourceEgress: 'approved-scoped' },
    untrustedClaims: [],
    destination,
  });
  assert.equal(recorded.fileWritten, true);
  const good = JSON.parse(readFileSync(destination, 'utf8'));
  assert.equal(good.kind, undefined, 'the --out file is a comparison record, not a report');
  const variant = (name, change) => {
    const path = join(box.dir, `${name}.json`);
    writeFileSync(path, JSON.stringify(change));
    return path;
  };
  const shadow = (path) => registry.shadowPack(box.home, 'jevris.testpack', '0.1.0', path, box.opts());

  // A record that is not shadow evidence stays refused.
  for (const [name, bad] of [
    ['applied', { ...good, applied: true }],
    ['sent', { ...good, sent: true }],
    ['actuated', { ...good, actuationCount: 1 }],
    ['worker', { ...good, actualWorker: 'someone' }],
    ['schema', { ...good, schemaVersion: '9.9' }],
    ['extra-key', { ...good, note: 'extra' }],
    ['not-an-object', [good]],
    ['empty', {}],
  ]) {
    const refused = await shadow(variant(name, bad));
    assert.equal(refused.ok, false, name);
    assert.equal(refused.reasonCode, 'SHADOW_REPORT_INVALID', name);
  }
  assert.equal((await registry.getPack(box.home, 'jevris.testpack')).versions['0.1.0'].stage, 'fixture-tested', 'a refusal attaches nothing');

  // The record itself is one shadow record.
  const accepted = await shadow(destination);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.recordCount, 1);
  assert.equal(accepted.reportHash, `sha256:${sha(readFileSync(destination))}`, 'the hash is of the file that was checked');
  assert.equal((await registry.getPack(box.home, 'jevris.testpack')).versions['0.1.0'].stage, 'shadow-approved');
});

// JEV-0036: the documented CLI flow, end to end.
test('jevris shadow --out, then jevris pack shadow --report on that file, reaches shadow-approved (JEV-0036)', { skip: managedHostSkip() }, async (t) => {
  const { main } = await import('../dist/cli.js');
  const box = sandbox(t);
  const fixture = join(box.dir, 'labels.json');
  writeFileSync(fixture, JSON.stringify({
    policyVersion: 'policyV1',
    actualModel: 'claude-sonnet-5',
    rulesInput: { kind: 'known-failure', family: 'type_error' },
    jevLabel: 'jev-1.13.0',
    setting: { provenance: 'administrator', sourceEgress: 'approved-scoped' },
    untrustedClaims: [],
  }));
  const out = join(box.dir, 'shadow.json');
  let text = '';
  assert.equal(await main(['shadow', '--home', box.home, '--fixture', fixture, '--out', out], (chunk) => (text += chunk)), 0, text);
  const run = async (args) => {
    let answer = '';
    const code = await runAdminCommand(['pack', ...args, '--home', box.home], (chunk) => (answer += chunk), { packageRoot: root, isTTY: false });
    return { code, text: answer };
  };
  assert.equal((await run(['install', writePack(join(box.dir, 'cli'), manifest(), FIXTURE), '--json'])).code, 0);
  assert.equal((await run(['test', 'jevris.testpack@0.1.0'])).code, 0);
  const attached = await run(['shadow', 'jevris.testpack@0.1.0', '--report', out]);
  assert.equal(attached.code, 0, attached.text);
  assert.equal((await registry.getPack(box.home, 'jevris.testpack')).versions['0.1.0'].stage, 'shadow-approved');
});

test('jevris pack: the CLI drives the lifecycle; approval needs a person at a terminal and refuses --yes (SR-1)', { skip: managedHostSkip() }, async (t) => {
  const box = sandbox(t);
  const src = writePack(join(box.dir, 'cli'), manifest(), FIXTURE);
  const run = async (args, hooks = { isTTY: false }) => {
    let text = '';
    const code = await runAdminCommand(['pack', ...args, '--home', box.home], (chunk) => (text += chunk), { packageRoot: root, ...hooks });
    return { code, text };
  };
  const installed = await run(['install', src, '--json']);
  assert.equal(installed.code, 0, installed.text);
  const doc = JSON.parse(installed.text);
  assert.deepEqual([doc.command, doc.packId, doc.version, doc.stage], ['pack install', 'jevris.testpack', '0.1.0', 'draft']);
  assert.match(doc.delta.hash, /^sha256:/);
  assert.equal((await run(['test', 'jevris.testpack@0.1.0'])).code, 0);
  assert.equal((await run(['shadow', 'jevris.testpack@0.1.0', '--report', shadowReport(box.dir)])).code, 0);
  const hash = (await registry.getPack(box.home, 'jevris.testpack')).versions['0.1.0'].deltaHash;
  const inspected = await run(['inspect', 'jevris.testpack@0.1.0']);
  assert.match(inspected.text, /installed: shadow-approved/);

  const noTerminal = await run(['approve', hash]);
  assert.equal(noTerminal.code, 2);
  assert.match(noTerminal.text, /^Nothing was changed \(CHANNEL_REFUSED\): approving a pack delta changes what Jevris may run and send/);
  assert.equal((await registry.getPack(box.home, 'jevris.testpack')).active, null);
  // A person at a terminal: the test's environment has no JEVRIS_TEST, as a real terminal does not.
  const person = { isTTY: true, confirm: async () => true, env: {} };
  const asked = [];
  for (const [args, hooks] of [
    [['approve', hash, '--yes'], {}],
    [['approve', hash, '--yes'], { ...person, confirm: async (q) => (asked.push(q), true) }],
    [['approve', hash, '--json'], { ...person, confirm: async (q) => (asked.push(q), true) }],
    [['approve', hash], { ...person, env: { JEVRIS_TEST: '1' }, confirm: async (q) => (asked.push(q), true) }],
  ]) {
    const refused = await run(args, hooks);
    assert.equal(refused.code, 2, args.join(' '));
    assert.match(refused.text, /^Nothing was changed \(CHANNEL_REFUSED\): /, args.join(' '));
  }
  assert.deepEqual(asked, [], 'a refused channel is never asked');
  assert.equal((await registry.getPack(box.home, 'jevris.testpack')).active, null);
  const declined = await run(['approve', hash], { ...person, confirm: async () => false });
  assert.equal(declined.code, 2);
  const yes = await run(['approve', hash], person);
  assert.equal(yes.code, 0, yes.text);
  assert.match(yes.text, /approved: jevris\.testpack@0\.1\.0 is active as canary/);
  const listed = await run(['list']);
  assert.match(listed.text, /jevris\.testpack: active 0\.1\.0 \(canary\)/);
  assert.match(listed.text, /built-in: jevris\.memory 0\.1\.0 \(advise-only\)/);
  const unknown = await run(['approve', `sha256:${'0'.repeat(64)}`], person);
  assert.match(unknown.text, /refused \(DELTA_UNKNOWN\)/);
  const rolled = await run(['rollback', 'jevris.testpack']);
  assert.match(rolled.text, /rolled back: jevris\.testpack 0\.1\.0 -> nothing active; history kept/);
  assert.equal((await run(['bogus'])).code, 2);
});

test('jevris pack publisher add needs a person at a terminal and refuses --yes; remove narrows and needs no terminal (SR-1)', async (t) => {
  const box = sandbox(t);
  const { publicKey } = generateKeyPairSync('ed25519');
  const pem = join(box.dir, 'acme.pub.pem');
  writeFileSync(pem, publicKey.export({ type: 'spki', format: 'pem' }));
  const run = async (args, hooks = { isTTY: false }) => {
    let text = '';
    const code = await runAdminCommand(['pack', ...args, '--home', box.home], (chunk) => (text += chunk), { packageRoot: root, ...hooks });
    return { code, text };
  };
  const trusted = async () => (await run(['publisher', 'list'])).text.includes('acme (');
  const add = ['publisher', 'add', 'acme', '--key', pem, '--key-id', 'k1'];
  const scripted = await run([...add, '--yes']);
  assert.equal(scripted.code, 2);
  assert.match(scripted.text, /^Nothing was changed \(CHANNEL_REFUSED\): trusting a publisher lets its signed packs run executable components/);
  assert.equal(scripted.text.split('\n').length, 2, 'one line');
  const atTerminal = await run([...add, '--yes'], { isTTY: true, confirm: async () => true, env: {} });
  assert.equal(atTerminal.code, 2, '--yes is refused at a terminal too');
  assert.equal(await trusted(), false);
  const added = await run(add, { isTTY: true, confirm: async () => true, env: {} });
  assert.equal(added.code, 0, added.text);
  assert.match(added.text, /trusted publisher acme \(key k1\)/);
  assert.equal(await trusted(), true);
  const removed = await run(['publisher', 'remove', 'acme']);
  assert.equal(removed.code, 0, removed.text);
  assert.equal(await trusted(), false);
});

test('W11: pack uninstall removes only the pack versions and workspace enablements, keeps data and history until --cleanup, and never touches the workspace', { skip: managedHostSkip() }, async (t) => {
  const box = sandbox(t);
  const v1 = await ready(box, writePack(join(box.dir, 'v1'), manifest(), FIXTURE));
  assert.equal((await registry.approvePack(box.home, v1.deltaHash, box.opts())).ok, true);
  const other = await ready(box, writePack(join(box.dir, 'other'), manifest({ id: 'jevris.other' }), FIXTURE));
  assert.equal((await registry.approvePack(box.home, other.deltaHash, box.opts())).ok, true);
  const workspace = join(box.dir, 'ws');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'mine.txt'), 'mine\n');
  for (const id of ['jevris.testpack', 'jevris.other']) assert.equal((await registry.setPackEnabled(box.home, id, workspace, true, box.opts())).ok, true);
  const data = registry.packDataDir(box.home, 'jevris.testpack');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'state.json'), '{}');
  const run = async (args, hooks = { isTTY: false }) => {
    let text = '';
    const code = await runAdminCommand(['pack', ...args, '--home', box.home], (chunk) => (text += chunk), { packageRoot: root, ...hooks });
    return { code, text };
  };
  assert.match((await run(['uninstall', 'jevris.nothing'])).text, /refused \(PACK_UNKNOWN\)/);
  const removed = await run(['uninstall', 'jevris.testpack', '--json']);
  assert.equal(removed.code, 0, removed.text);
  const doc = JSON.parse(removed.text);
  assert.deepEqual([doc.command, doc.packId, doc.wasActive, doc.removedVersions, doc.cleanedUp], ['pack uninstall', 'jevris.testpack', '0.1.0', ['0.1.0'], false]);
  assert.equal(doc.disabledIn.length, 1);
  assert.deepEqual(doc.kept, [data]);
  assert.equal(existsSync(registry.packVersionDir(box.home, 'jevris.testpack', '0.1.0')), false);
  assert.equal(readFileSync(join(data, 'state.json'), 'utf8'), '{}', 'data is kept');
  assert.equal(readFileSync(join(workspace, 'mine.txt'), 'utf8'), 'mine\n', 'the workspace is untouched');
  const record = await registry.getPack(box.home, 'jevris.testpack');
  assert.deepEqual([record.active, Object.keys(record.versions), Object.keys(record.workspaces)], [null, [], []]);
  assert.equal(record.history.at(-1).event, 'uninstall', 'history is kept');
  const loaded = await registry.activePacksFor(box.home, workspace, { shippedPublishers: box.publishers });
  assert.deepEqual(loaded.map((item) => item.id), ['jevris.other'], 'the other pack is untouched');
  assert.equal(existsSync(registry.packVersionDir(box.home, 'jevris.other', '0.1.0')), true);
  // Cleanup deletes data, so it asks first.
  const noTerminal = await run(['uninstall', 'jevris.testpack', '--cleanup']);
  assert.equal(noTerminal.code, 2);
  assert.match(noTerminal.text, /^Nothing was changed\./);
  assert.equal(existsSync(data), true);
  const cleaned = await run(['uninstall', 'jevris.testpack', '--cleanup', '--yes']);
  assert.equal(cleaned.code, 0, cleaned.text);
  assert.match(cleaned.text, /data and backups: deleted/);
  assert.equal(existsSync(join(registry.packsRoot(box.home), 'jevris.testpack')), false);
  // Installing again starts from a fresh draft.
  const again = await registry.installPack(box.home, join(box.dir, 'v1'), box.opts());
  assert.deepEqual([again.ok, again.stage, again.already], [true, 'draft', false]);
});

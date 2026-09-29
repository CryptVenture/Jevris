import test from 'node:test';
import assert from 'node:assert/strict';
import { assertOwnerOnly, jevrisPaths } from '../../../packages/platform/dist/index.js';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


const { main } = await import('../dist/cli.js');
const { loadHostPolicy } = await import('../dist/host-policy.js');
const { rollbackPolicy, stagePackUpgrade } = await import('../dist/pack-policy.js');

const KEY_CANARY = 'KEY_CANARY_do_not_log';
const BODY_CANARY = 'BODY_CANARY_do_not_print';
const BYTE_CAP = 131072;

function validHost(overrides = {}) {
  return {
    schemaVersion: '1.0',
    mode: 'advise',
    egress: 'deny-until-approved',
    retention: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 },
    budget: { maxRequestBytes: 131072 },
    pin: { model: 'jev-1.13.0', respectHumanPins: true },
    packPrivileges: ['advise', 'abstain', 'task-metadata'],
    credentialRef: 'host-secret:typesafe-primary',
    installerEnvName: 'JEVRIS_INSTALLER_KEY',
    allowUncalibratedActuation: false,
    ...overrides,
  };
}

function validManifest(overrides = {}) {
  return {
    schemaVersion: '1.0',
    id: 'jevris.routing',
    version: '0.1.0',
    maturity: 'experimental',
    description: 'Advise only',
    requiresCapabilities: ['task-metadata'],
    fallbackCapabilities: [],
    decisionSpecs: ['task-profile.v1'],
    actions: ['advise'],
    dataScopes: ['task-metadata'],
    defaultMode: 'observe',
    conflicts: [],
    fixtures: ['routing/eligibility'],
    ...overrides,
  };
}

async function withRoots(fn) {
  const parent = await mkdtemp(join(tmpdir(), 'jevris-pack-'));
  const home = join(parent, 'home');
  const workspace = join(parent, 'workspace');
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  try {
    await fn({ home, workspace });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

function hostPath(home) {
  return join(configDir(home), 'host.json');
}

function activePath(home) {
  return join(configDir(home), 'policy-active.json');
}

function previousPath(home) {
  return join(configDir(home), 'policy-previous.json');
}

function stagedPath(home) {
  return join(configDir(home), 'policy-staged.json');
}

async function writeHost(home, value) {
  const path = hostPath(home);
  await mkdir(configDir(home), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function sameBytes(left, right) {
  return Buffer.from(left).equals(Buffer.from(right));
}

test('an invalid manifest writes nothing and the CLI refuses without printing the body', async () => {
  await withRoots(async ({ home, workspace }) => {
    const manifest = join(workspace, 'bad.json');
    const cases = [
      JSON.stringify({ ...validManifest(), schemaVersion: '9.9', description: BODY_CANARY }),
      JSON.stringify({ ...validManifest(), extra: BODY_CANARY }),
      Buffer.concat([Buffer.alloc(BYTE_CAP, 0x20), Buffer.from(BODY_CANARY)]),
    ];
    for (const body of cases) {
      await writeFile(manifest, body);
      let text = '';
      const code = await main(
        ['policy', 'stage', '--manifest', manifest, '--home', home, '--workspace', workspace],
        (chunk) => {
          text += chunk;
        },
      );
      assert.equal(code, 2);
      assert.equal(text, 'refused\n');
      assert.equal(text.includes(BODY_CANARY), false);
      assert.equal(text.includes(KEY_CANARY), false);
      assert.equal(await exists(stagedPath(home)), false);
      assert.equal(await exists(activePath(home)), false);
    }
    await writeFile(manifest, JSON.stringify({ ...validManifest(), apiKey: KEY_CANARY }));
    const direct = await stagePackUpgrade({ home, workspace, manifestPath: manifest });
    assert.equal(direct.ok, false);
    assert.equal(JSON.stringify(direct).includes(KEY_CANARY), false);
    assert.equal(await exists(stagedPath(home)), false);
  });
});

test('a privilege delta does not change active policy and an expanded action does not activate', async () => {
  await withRoots(async ({ home, workspace }) => {
    await writeHost(home, validHost({ packPrivileges: ['advise', 'abstain', 'task-metadata'] }));
    await loadHostPolicy({ home, workspace });
    const before = await readFile(activePath(home));
    const outside = join(workspace, 'outside.json');
    await writeFile(
      outside,
      JSON.stringify(
        validManifest({
          actions: ['route-worker'],
          dataScopes: ['task-metadata'],
          requiresCapabilities: ['task-metadata'],
          description: BODY_CANARY,
        }),
      ),
    );
    const delta = await stagePackUpgrade({ home, workspace, manifestPath: outside });
    assert.equal(delta.ok, false);
    assert.equal(delta.reasonCode, 'DRILL_REQUIRED');
    assert.notEqual(delta.activated, true);
    assert.equal(JSON.stringify(delta).includes(BODY_CANARY), false);
    assert.equal(await exists(stagedPath(home)), false);
    assert.equal(sameBytes(await readFile(activePath(home)), before), true);

    const first = join(workspace, 'first.json');
    await writeFile(first, JSON.stringify(validManifest({ actions: ['advise'] })));
    const stagedFirst = await stagePackUpgrade({ home, workspace, manifestPath: first });
    assert.equal(stagedFirst.activated, false);
    assert.equal(sameBytes(await readFile(activePath(home)), before), true);
    const second = join(workspace, 'second.json');
    await writeFile(second, JSON.stringify(validManifest({ actions: ['advise', 'abstain'] })));
    const expanded = await stagePackUpgrade({ home, workspace, manifestPath: second });
    assert.equal(expanded.ok, true);
    assert.equal(expanded.activated, false);
    assert.equal(expanded.reasonCode, 'PRIVILEGE_DELTA');
    assert.equal(sameBytes(await readFile(activePath(home)), before), true);
    let text = '';
    const code = await main(
      ['policy', 'stage', '--manifest', second, '--home', home, '--workspace', workspace],
      (chunk) => {
        text += chunk;
      },
    );
    assert.equal(text.includes(BODY_CANARY), false);
    assert.equal(code === 0 || code === 2, true);
    assert.equal(sameBytes(await readFile(activePath(home)), before), true);
  });
});

test('the product writes policy-previous.json and a restore cannot widen past the host file', async () => {
  await withRoots(async ({ home, workspace }) => {
    const narrow = validHost({
      egress: 'deny-until-approved',
      retention: { rawArtifactRetentionDays: 1, decisionRetentionDays: 1 },
      budget: { maxRequestBytes: 2048 },
      packPrivileges: ['advise'],
    });
    const wide = validHost({
      egress: 'approved-scoped',
      retention: { rawArtifactRetentionDays: 14, decisionRetentionDays: 60 },
      budget: { maxRequestBytes: 8192 },
      packPrivileges: ['advise', 'abstain'],
    });
    await writeHost(home, narrow);
    await loadHostPolicy({ home, workspace });
    assert.equal(await exists(previousPath(home)), false);
    const narrowBytes = await readFile(activePath(home));
    await writeHost(home, wide);
    await loadHostPolicy({ home, workspace });
    assert.deepEqual(await assertOwnerOnly(previousPath(home)), { ok: true });
    assert.equal(sameBytes(await readFile(previousPath(home)), narrowBytes), true);
    const rolled = await rollbackPolicy({ home, workspace });
    assert.equal(rolled.ok, true);
    assert.equal(sameBytes(await readFile(activePath(home)), narrowBytes), true);

    await writeHost(home, wide);
    await loadHostPolicy({ home, workspace });
    await writeHost(home, narrow);
    await loadHostPolicy({ home, workspace });
    const activeNarrow = await readFile(activePath(home));
    const manifest = join(workspace, 'staged.json');
    await writeFile(manifest, JSON.stringify(validManifest({ actions: ['advise'], requiresCapabilities: ['advise'] })));
    await stagePackUpgrade({ home, workspace, manifestPath: manifest });
    assert.equal(await exists(stagedPath(home)), true);
    const refused = await rollbackPolicy({ home, workspace });
    assert.equal(refused.ok, false);
    assert.equal(sameBytes(await readFile(activePath(home)), activeNarrow), true);
    assert.equal(await exists(stagedPath(home)), false);
    const project = join(workspace, 'project.json');
    await writeFile(
      project,
      JSON.stringify({ mode: 'off', packPrivileges: [], allowUncalibratedActuation: true, note: KEY_CANARY }),
    );
    const after = await loadHostPolicy({ home, workspace, project });
    assert.equal(after.document.allowUncalibratedActuation, false);
    assert.deepEqual(after.document.packPrivileges, ['advise']);
    assert.equal(JSON.stringify(after).includes(KEY_CANARY), false);
    let text = '';
    const code = await main(
      ['policy', 'rollback', '--home', home, '--workspace', workspace, '--project', project],
      (chunk) => {
        text += chunk;
      },
    );
    assert.equal(text.includes(KEY_CANARY), false);
    assert.equal(code === 0 || code === 2, true);
    assert.equal(sameBytes(await readFile(activePath(home)), activeNarrow), true);
  });
});

test('an unknown policy flag is refused', async () => {
  await withRoots(async ({ home }) => {
    let text = '';
    const code = await main(['policy', 'stage', '--nope', '--home', home], (chunk) => {
      text += chunk;
    });
    assert.equal(code, 2);
    assert.equal(text, 'refused\n');
  });
});

/** Jevris config dir for this OS (BLD-09). */
function configDir(home) {
  return jevrisPaths({ home }).config;
}

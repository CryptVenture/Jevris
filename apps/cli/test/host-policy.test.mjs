import test from 'node:test';
import assert from 'node:assert/strict';
import { assertOwnerOnly, jevrisPaths } from '../../../packages/platform/dist/index.js';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideEgress } from '@jevris/core';
import { applyProjectNarrowing, mergeOrganization } from '@jevris/contracts';


const { main } = await import('../dist/cli.js');
const { loadHostPolicy, screenSemanticDecision } = await import('../dist/host-policy.js');
const { resolveProviderCredential } = await import('../dist/credential.js');

const EXAMPLE = join(import.meta.dirname, '../../../fixtures/ssot/examples/jevris.config.json');
const MISSING_CONSENT = 'Egress denied: missing consent.';
const SOURCE_CANARY = 'SOURCE_CANARY_do_not_send';
const KEY_CANARY = 'KEY_CANARY_do_not_log';
const BYTE_CAP = 131072;

function validHost(overrides = {}) {
  return {
    schemaVersion: '1.0',
    mode: 'advise',
    egress: 'deny-until-approved',
    retention: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 },
    budget: { maxRequestBytes: 131072 },
    pin: { model: 'jev-1.13.0', respectHumanPins: true },
    packPrivileges: ['advise', 'abstain'],
    credentialRef: 'host-secret:typesafe-primary',
    installerEnvName: 'JEVRIS_INSTALLER_KEY',
    allowUncalibratedActuation: false,
    ...overrides,
  };
}

function countingFetch() {
  let calls = 0;
  const fetch = () => {
    calls += 1;
    throw new Error('provider');
  };
  return {
    fetch,
    calls: () => calls,
  };
}

async function withRoots(fn) {
  const parent = await mkdtemp(join(tmpdir(), 'jevris-host-'));
  const home = join(parent, 'home');
  const workspace = join(parent, 'workspace');
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  try {
    await fn({ parent, home, workspace });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

function hostPath(home) {
  return join(configDir(home), 'host.json');
}

function organizationPath(home) {
  return join(configDir(home), 'organization.json');
}

async function writeOrganization(home, value) {
  const path = organizationPath(home);
  await mkdir(configDir(home), { recursive: true });
  await writeFile(path, JSON.stringify(value));
  return path;
}

function activePath(home) {
  return join(configDir(home), 'policy-active.json');
}

async function writeHost(home, value) {
  const path = hostPath(home);
  await mkdir(configDir(home), { recursive: true });
  const bytes = typeof value === 'string' || value instanceof Uint8Array ? value : JSON.stringify(value);
  await writeFile(path, bytes);
  return path;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test('a host file outside the workspace is administrator policy and the file has no provenance', async () => {
  await withRoots(async ({ home, workspace }) => {
    const document = validHost();
    await writeHost(home, document);
    const loaded = await loadHostPolicy({ home, workspace });
    assert.equal(loaded.active, true);
    assert.equal(loaded.provenance, 'administrator');
    assert.equal(Object.hasOwn(loaded.document, 'provenance'), false);
    assert.equal(Object.hasOwn(loaded.document, 'sourceEgress'), false);
    assert.notEqual(loaded.gate, loaded.document);
    assert.deepEqual(Object.keys(loaded.gate).sort(), ['provenance', 'sourceEgress']);
    assert.equal(loaded.gate.provenance, 'administrator');
    assert.equal(loaded.gate.sourceEgress, 'deny-until-approved');
    const onDisk = JSON.parse(await readFile(hostPath(home), 'utf8'));
    assert.equal(Object.hasOwn(onDisk, 'provenance'), false);
    const active = JSON.parse(await readFile(activePath(home), 'utf8'));
    assert.equal(Object.hasOwn(active, 'provenance'), false);
    assert.equal(active.egress, 'deny-until-approved');
    assert.equal(active.credentialRef, 'host-secret:typesafe-primary');
    assert.equal(active.allowUncalibratedActuation, false);
    assert.equal(active.pin.model, 'jev-1.13.0');
    assert.deepEqual(await assertOwnerOnly(activePath(home)), { ok: true });
    assert.equal(await exists(join(configDir(home), 'policy-previous.json')), false);
  });
});

test('the same bytes inside the workspace are not consent and do not build a gate', async () => {
  await withRoots(async ({ home, workspace }) => {
    const bytes = JSON.stringify(validHost());
    const inside = join(workspace, 'host.json');
    await writeFile(inside, bytes);
    const dir = configDir(home);
    await mkdir(dir, { recursive: true });
    await symlink(inside, join(dir, 'host.json'));
    const loaded = await loadHostPolicy({ home, workspace });
    assert.equal(loaded.active, false);
    assert.equal(loaded.provenance, undefined);
    assert.equal(loaded.gate, undefined);
    assert.equal(await exists(activePath(home)), false);
    const contained = join(workspace, 'nested-home');
    await mkdir(configDir(contained), { recursive: true });
    await writeFile(join(configDir(contained), 'host.json'), bytes);
    const again = await loadHostPolicy({ home: contained, workspace });
    assert.equal(again.active, false);
    assert.equal(again.provenance, undefined);
    assert.equal(again.gate, undefined);
  });
});

test('policy check --would-send-source prints missing consent and does not call fetch', async () => {
  await withRoots(async ({ home, workspace }) => {
    await writeHost(home, validHost());
    const counter = countingFetch();
    const screened = await screenSemanticDecision({
      home,
      workspace,
      wouldSendSource: true,
      fetch: counter.fetch,
    });
    assert.equal(screened.explanation, MISSING_CONSENT);
    assert.equal(screened.sent, false);
    assert.equal(screened.providerCalls, 0);
    assert.equal(screened.gate.sourceEgress, 'deny-until-approved');
    assert.equal(screened.gate.provenance, 'administrator');
    assert.equal(Object.hasOwn(screened.gate, 'sourceEgress'), true);
    assert.equal(counter.calls(), 0);
    const omitted = decideEgress({
      setting: { provenance: 'administrator' },
      untrustedClaims: [],
    });
    assert.equal(omitted.decision, 'deny');
    assert.equal(omitted.explanation, MISSING_CONSENT);
    let text = '';
    const code = await main(
      ['policy', 'check', '--would-send-source', '--home', home, '--workspace', workspace],
      (chunk) => {
        text += chunk;
      },
      { fetch: counter.fetch },
    );
    assert.equal(code, 0);
    assert.equal(text.includes(MISSING_CONSENT), true);
    assert.equal(text.includes(SOURCE_CANARY), false);
    assert.equal(text.includes(KEY_CANARY), false);
    assert.equal(text.includes('JEVRIS_REPORT'), false);
    assert.equal(counter.calls(), 0);
    let refused = '';
    const extra = await main(
      ['policy', 'check', '--would-send-source', SOURCE_CANARY, '--home', home, '--workspace', workspace],
      (chunk) => {
        refused += chunk;
      },
      { fetch: counter.fetch },
    );
    assert.equal(extra, 2);
    assert.equal(refused.includes(SOURCE_CANARY), false);
    assert.equal(counter.calls(), 0);
  });
});

test('a project file that claims approved-scoped does not set sourceEgress or authorize a send', async () => {
  await withRoots(async ({ home, workspace }) => {
    await writeHost(home, validHost());
    const example = JSON.parse(await readFile(EXAMPLE, 'utf8'));
    example.privacy.sourceEgress = 'approved-scoped';
    example.sourceEgress = 'approved-scoped';
    example.note = SOURCE_CANARY;
    const project = join(workspace, 'jevris.config.json');
    await writeFile(project, JSON.stringify(example));
    const counter = countingFetch();
    const loaded = await loadHostPolicy({ home, workspace, project });
    assert.equal(loaded.active, true);
    assert.equal(loaded.gate.sourceEgress, 'deny-until-approved');
    assert.equal(loaded.provenance, 'administrator');
    assert.equal(Object.hasOwn(loaded.document, 'sourceEgress'), false);
    const screened = await screenSemanticDecision({
      home,
      workspace,
      project,
      wouldSendSource: true,
      fetch: counter.fetch,
    });
    assert.equal(screened.explanation, MISSING_CONSENT);
    assert.equal(screened.sent, false);
    assert.equal(screened.providerCalls, 0);
    assert.equal(screened.gate.sourceEgress, 'deny-until-approved');
    assert.equal(counter.calls(), 0);
    let text = '';
    const code = await main(
      ['policy', 'check', '--would-send-source', '--home', home, '--workspace', workspace, '--project', project],
      (chunk) => {
        text += chunk;
      },
      { fetch: counter.fetch },
    );
    assert.equal(code, 0);
    assert.equal(text.includes(MISSING_CONSENT), true);
    assert.equal(text.includes(SOURCE_CANARY), false);
    assert.equal(text.includes('approved-scoped'), false);
    assert.equal(counter.calls(), 0);
  });
});

test('an over-cap host file is not parsed and a raw key is refused without logging the value', async () => {
  await withRoots(async ({ home, workspace }) => {
    const over = new Uint8Array(BYTE_CAP + 1);
    over.set(new TextEncoder().encode(KEY_CANARY), BYTE_CAP + 1 - KEY_CANARY.length);
    await writeHost(home, over);
    const overLoaded = await loadHostPolicy({ home, workspace });
    assert.equal(overLoaded.active, false);
    assert.equal(overLoaded.gate, undefined);
    assert.equal(JSON.stringify(overLoaded).includes(KEY_CANARY), false);
    assert.equal(await exists(activePath(home)), false);
    const poisoned = validHost();
    poisoned.apiKey = KEY_CANARY;
    await writeHost(home, poisoned);
    const loaded = await loadHostPolicy({ home, workspace });
    assert.equal(loaded.active, false);
    assert.equal(loaded.reasonCode, 'RAW_KEY_REFUSED');
    assert.equal(loaded.gate, undefined);
    assert.equal(JSON.stringify(loaded).includes(KEY_CANARY), false);
    assert.equal(await exists(activePath(home)), false);
    const nested = validHost();
    nested.retention = { rawArtifactRetentionDays: 7, decisionRetentionDays: 30, apiKey: KEY_CANARY };
    await writeHost(home, nested);
    const nestedLoaded = await loadHostPolicy({ home, workspace });
    assert.equal(nestedLoaded.reasonCode, 'RAW_KEY_REFUSED');
    assert.equal(JSON.stringify(nestedLoaded).includes(KEY_CANARY), false);
    const ambient = validHost();
    ambient.TYPESAFE_API_KEY = KEY_CANARY;
    await writeHost(home, ambient);
    const ambientLoaded = await loadHostPolicy({ home, workspace });
    assert.equal(ambientLoaded.reasonCode, 'RAW_KEY_REFUSED');
    assert.equal(JSON.stringify(ambientLoaded).includes(KEY_CANARY), false);
    let text = '';
    const counter = countingFetch();
    const code = await main(
      ['policy', 'check', '--would-send-source', '--home', home, '--workspace', workspace],
      (chunk) => {
        text += chunk;
      },
      { fetch: counter.fetch },
    );
    assert.equal(text.includes(KEY_CANARY), false);
    assert.equal(text.includes(SOURCE_CANARY), false);
    assert.equal(counter.calls(), 0);
    assert.equal(code === 0 || code === 2, true);
    assert.equal(await exists(activePath(home)), false);
  });
});

test('organization intersection keeps the tighter egress and passes it as sourceEgress', async () => {
  await withRoots(async ({ home, workspace }) => {
    const host = validHost({ egress: 'approved-scoped' });
    const organization = validHost({ egress: 'deny-until-approved' });
    await writeHost(home, host);
    await writeOrganization(home, organization);
    const loaded = await loadHostPolicy({ home, workspace });
    assert.equal(loaded.active, true);
    assert.equal(loaded.provenance, 'administrator');
    assert.equal(Object.hasOwn(loaded.document, 'provenance'), false);
    assert.equal(loaded.document.egress, 'deny-until-approved');
    assert.equal(loaded.gate.sourceEgress, 'deny-until-approved');
    assert.equal(loaded.gate.provenance, 'administrator');
    assert.equal(Object.hasOwn(loaded.gate, 'sourceEgress'), true);
    assert.notEqual(loaded.gate, loaded.document);
    const onDisk = JSON.parse(await readFile(organizationPath(home), 'utf8'));
    assert.equal(Object.hasOwn(onDisk, 'provenance'), false);
    const counter = countingFetch();
    const screened = await screenSemanticDecision({
      home,
      workspace,
      wouldSendSource: true,
      fetch: counter.fetch,
    });
    assert.equal(screened.explanation, MISSING_CONSENT);
    assert.equal(screened.gate.sourceEgress, 'deny-until-approved');
    assert.equal(screened.providerCalls, 0);
    assert.equal(counter.calls(), 0);
    const omitted = decideEgress({
      setting: { provenance: 'administrator' },
      untrustedClaims: [],
    });
    assert.equal(omitted.decision, 'deny');
    const merged = mergeOrganization(host, organization);
    assert.equal(merged.ok, true);
    assert.equal(merged.document.egress, 'deny-until-approved');
  });
});

test('policy check --would-send-source says allowed, not refused, when source egress is approved (JEV-0024)', async () => {
  await withRoots(async ({ home, workspace }) => {
    await writeHost(home, validHost({ egress: 'approved-scoped' }));
    const counter = countingFetch();
    const screened = await screenSemanticDecision({ home, workspace, wouldSendSource: true, fetch: counter.fetch });
    assert.equal(screened.decision, 'allow');
    assert.match(screened.explanation, /^Egress allowed: /);
    assert.equal(screened.sent, false);
    assert.equal(screened.providerCalls, 0);
    let text = '';
    const code = await main(['policy', 'check', '--would-send-source', '--home', home, '--workspace', workspace], (chunk) => {
      text += chunk;
    }, { fetch: counter.fetch });
    assert.equal(code, 0, text);
    assert.match(text, /^Egress allowed: /);
    assert.equal(/refused/i.test(text), false, text);
    assert.equal(counter.calls(), 0, 'a check never calls the provider');
  });
});

test('a widening organization file is not applied and does not replace active policy', async () => {
  await withRoots(async ({ home, workspace }) => {
    const host = validHost();
    await writeHost(home, host);
    await loadHostPolicy({ home, workspace });
    const before = await readFile(activePath(home));
    await writeOrganization(home, validHost({ egress: 'approved-scoped' }));
    const counter = countingFetch();
    const loaded = await loadHostPolicy({ home, workspace });
    assert.equal(loaded.reasonCode, 'POLICY_WIDEN');
    assert.equal(loaded.document.egress, 'deny-until-approved');
    assert.equal(loaded.gate.sourceEgress, 'deny-until-approved');
    const after = await readFile(activePath(home));
    assert.equal(Buffer.from(after).equals(Buffer.from(before)), true);
    assert.equal(counter.calls(), 0);
    const screened = await screenSemanticDecision({
      home,
      workspace,
      wouldSendSource: true,
      fetch: counter.fetch,
    });
    assert.equal(screened.providerCalls, 0);
    assert.equal(counter.calls(), 0);
    assert.equal(screened.explanation, MISSING_CONSENT);

    await rm(organizationPath(home));
    await loadHostPolicy({ home, workspace });
    const baseline = await readFile(activePath(home));
    for (const organization of [
      validHost({ retention: { rawArtifactRetentionDays: 8, decisionRetentionDays: 30 } }),
      validHost({ retention: { rawArtifactRetentionDays: 7, decisionRetentionDays: 31 } }),
      validHost({ budget: { maxRequestBytes: 131073 } }),
      validHost({ pin: { model: 'jev-9.9.9', respectHumanPins: true } }),
      validHost({ installerEnvName: 'JEVRIS_OTHER_KEY' }),
    ]) {
      await writeOrganization(home, organization);
      const widened = await loadHostPolicy({ home, workspace });
      assert.equal(widened.reasonCode, 'POLICY_WIDEN');
      const bytes = await readFile(activePath(home));
      assert.equal(Buffer.from(bytes).equals(Buffer.from(baseline)), true);
    }
  });
});

test('a privilege subset intersects and an added privilege does not activate', async () => {
  await withRoots(async ({ home, workspace }) => {
    const host = validHost({ packPrivileges: ['advise', 'abstain', 'task-metadata'] });
    await writeHost(home, host);
    await writeOrganization(home, validHost({ packPrivileges: ['abstain', 'advise'] }));
    const loaded = await loadHostPolicy({ home, workspace });
    assert.equal(loaded.reasonCode, undefined);
    assert.deepEqual(loaded.document.packPrivileges, ['advise', 'abstain']);
    const active = JSON.parse(await readFile(activePath(home), 'utf8'));
    assert.deepEqual(active.packPrivileges, ['advise', 'abstain']);
    const before = await readFile(activePath(home));
    await writeOrganization(home, validHost({ packPrivileges: ['advise', 'route-worker'] }));
    const widened = await loadHostPolicy({ home, workspace });
    assert.equal(widened.reasonCode, 'POLICY_WIDEN');
    assert.equal(widened.document.packPrivileges.includes('route-worker'), false);
    const after = await readFile(activePath(home));
    assert.equal(Buffer.from(after).equals(Buffer.from(before)), true);
  });
});

test('a project file only narrows mode toward off and cannot set sourceEgress', async () => {
  await withRoots(async ({ home, workspace }) => {
    await writeHost(home, validHost({ mode: 'advise', egress: 'deny-until-approved' }));
    const project = join(workspace, 'jevris.config.json');
    await writeFile(
      project,
      JSON.stringify({
        mode: 'off',
        provenance: 'administrator',
        sourceEgress: 'approved-scoped',
        note: SOURCE_CANARY,
      }),
    );
    const loaded = await loadHostPolicy({ home, workspace, project });
    assert.equal(loaded.document.mode, 'off');
    assert.equal(loaded.provenance, 'administrator');
    assert.equal(Object.hasOwn(loaded.document, 'provenance'), false);
    assert.equal(Object.hasOwn(loaded.document, 'sourceEgress'), false);
    assert.equal(loaded.gate.sourceEgress, 'deny-until-approved');
    const active = JSON.parse(await readFile(activePath(home), 'utf8'));
    assert.equal(active.mode, 'advise');
    const narrowed = applyProjectNarrowing(validHost({ mode: 'advise' }), { mode: 'off', sourceEgress: 'approved-scoped' });
    assert.equal(narrowed.ok, true);
    assert.equal(narrowed.document.mode, 'off');
    assert.equal(Object.hasOwn(narrowed.document, 'sourceEgress'), false);

    await writeHost(home, validHost({ mode: 'observe' }));
    await writeFile(project, JSON.stringify({ mode: 'bounded-auto', provenance: 'administrator' }));
    const before = await readFile(activePath(home));
    const rejected = await loadHostPolicy({ home, workspace, project });
    assert.equal(rejected.reasonCode, 'POLICY_WIDEN');
    assert.equal(rejected.document.mode, 'observe');
    assert.equal(rejected.provenance, 'administrator');
    const after = await readFile(activePath(home));
    assert.equal(Buffer.from(after).equals(Buffer.from(before)) || JSON.parse(after.toString()).mode === 'observe', true);
  });
});

test('a missing project file leaves host policy and a raw key is refused', async () => {
  await withRoots(async ({ home, workspace }) => {
    await writeHost(home, validHost({ mode: 'advise' }));
    const missing = join(workspace, 'missing-project.json');
    const loaded = await loadHostPolicy({ home, workspace, project: missing });
    assert.equal(loaded.active, true);
    assert.equal(loaded.document.mode, 'advise');
    assert.equal(loaded.reasonCode, undefined);
    const project = join(workspace, 'poison.json');
    await writeFile(project, JSON.stringify({ mode: 'off', apiKey: KEY_CANARY }));
    const before = await readFile(activePath(home));
    const refused = await loadHostPolicy({ home, workspace, project });
    assert.equal(refused.reasonCode, 'RAW_KEY_REFUSED');
    assert.equal(refused.document.mode, 'advise');
    assert.equal(JSON.stringify(refused).includes(KEY_CANARY), false);
    const after = await readFile(activePath(home));
    assert.equal(Buffer.from(after).equals(Buffer.from(before)), true);
    let text = '';
    const code = await main(
      ['policy', 'check', '--would-send-source', '--home', home, '--workspace', workspace, '--project', project],
      (chunk) => {
        text += chunk;
      },
    );
    assert.equal(text.includes(KEY_CANARY), false);
    assert.equal(text.includes(SOURCE_CANARY), false);
    assert.equal(code === 0 || code === 2, true);
  });
});

test('an invalid host file does not replace a previous active policy', async () => {
  await withRoots(async ({ home, workspace }) => {
    await writeHost(home, validHost());
    await loadHostPolicy({ home, workspace });
    const before = await readFile(activePath(home));
    await writeHost(home, '{');
    const loaded = await loadHostPolicy({ home, workspace });
    assert.equal(loaded.active, false);
    assert.equal(loaded.provenance, undefined);
    assert.equal(loaded.gate, undefined);
    const after = await readFile(activePath(home));
    assert.equal(Buffer.from(after).equals(Buffer.from(before)), true);
  });
});

/** Jevris config dir for this OS (BLD-09). */
function configDir(home) {
  return jevrisPaths({ home }).config;
}

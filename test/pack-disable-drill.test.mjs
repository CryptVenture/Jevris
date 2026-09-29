// The economics gate's pack-disable drill for a release without a seed (SSOT §22.2 as amended
// at 827fc87: "harmful packs can be disabled independently"). Every pack the package ships is
// installed, approved and enabled in one workspace; disabling each in turn leaves every other
// one active. The gate names this test in RUNTIME_GATE_TESTS (apps/cli/src/release-gates.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedHostSkip } from './managed-host.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const registry = await import('../apps/cli/dist/packs/registry.js');
const { loadPackIds } = await import('../apps/cli/dist/gate-records.js');

test('every shipped pack disables on its own: the others stay active in the workspace, and it comes back when enabled (§22.2 economics, RLS-09)', { skip: managedHostSkip() }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-pack-drill-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const home = join(dir, 'home');
  const workspace = join(dir, 'ws');
  mkdirSync(home);
  mkdirSync(workspace);
  const publishers = join(dir, 'shipped-publishers.json');
  writeFileSync(publishers, JSON.stringify({ schemaVersion: 1, publishers: [] }));
  const report = join(dir, 'shadow.json');
  writeFileSync(report, JSON.stringify({ schemaVersion: '1.0', kind: 'shadow-report', baselines: ['rules-only', 'native', 'jev'], recordCount: 3, actuationCount: 0, measuredSpeedRatio: null, measuredCostRatio: null }));
  let clock = Date.parse('2026-09-26T10:00:00Z');
  const opts = () => ({ shippedPublishers: publishers, nowMs: (clock += 1000) });

  const shipped = await loadPackIds(root);
  assert.ok(shipped.length >= 3, `the package ships ${shipped.join(', ')}`);
  const installedIds = [];
  for (const name of (await import('node:fs')).readdirSync(join(root, 'packs')).sort()) {
    const installed = await registry.installPack(home, join(root, 'packs', name), opts());
    if (!installed.ok) continue;
    const tested = await registry.testPack(home, installed.packId, installed.version, opts());
    assert.equal(tested.passed, true, `${installed.packId}: ${JSON.stringify(tested)}`);
    assert.equal((await registry.shadowPack(home, installed.packId, installed.version, report, opts())).ok, true, installed.packId);
    const record = await registry.getPack(home, installed.packId);
    assert.equal((await registry.approvePack(home, record.versions[installed.version].deltaHash, opts())).ok, true, installed.packId);
    assert.equal((await registry.setPackEnabled(home, installed.packId, workspace, true, opts())).ok, true, installed.packId);
    installedIds.push(installed.packId);
  }
  assert.deepEqual([...installedIds].sort(), [...shipped].sort(), 'every shipped pack installs');

  const active = async () => (await registry.activePacksFor(home, workspace, { shippedPublishers: publishers })).map((item) => item.id).sort();
  assert.deepEqual(await active(), [...shipped].sort());
  for (const id of shipped) {
    assert.equal((await registry.setPackEnabled(home, id, workspace, false, opts())).ok, true, id);
    assert.deepEqual(await active(), shipped.filter((other) => other !== id).sort(), `disabling ${id} leaves the others active`);
    assert.equal((await registry.setPackEnabled(home, id, workspace, true, opts())).ok, true, id);
    assert.deepEqual(await active(), [...shipped].sort(), `${id} comes back`);
  }
});

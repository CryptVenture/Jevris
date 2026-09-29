// C's found-gone record in doctor (f5b19ab; E for F's doctor, coordinator 2026-09-27): a model
// found gone on this machine is an action line naming the clear command for once it is back; a
// model not accessible from one harness and sign-in is an info line. Pair: no record, no line.
// A temporary home only; no harness binary runs (the CLI stub has none).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const core = await import('@jevris/core');
const { doctorLineSeverity } = await import('../dist/doctor-severity.js');
const { runDoctorCommand } = await import('../dist/doctor-cli.js');
const { modelAvailabilityDoctorLines, modelAvailabilityView } = await import('../dist/model-availability.js');

const root = fileURLToPath(new URL('../../..', import.meta.url));
const NO_HARNESS = { available: () => false, run: async () => ({ spawned: false, code: null, stdout: '' }) };

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'jevris-gone-doctor-'));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3 }));
  return home;
}

async function record(home, modelId, reasonCode, port, authMode) {
  const r = await core.recordModelUnavailable({ home, modelId, reasonCode, port, authMode, source: 'provider-call', nowMs: Date.UTC(2026, 8, 27, 9), registry: core.BUNDLED_MODEL_REGISTRY });
  assert.equal(r.ok, true, JSON.stringify(r));
}

async function doctorJson(home) {
  let out = '';
  await runDoctorCommand({ home, json: true, values: {}, root, cli: NO_HARNESS, policies: [] }, (chunk) => (out += chunk));
  return JSON.parse(out);
}

test('doctor: a model found gone is an action with the clear fix, one not accessible from one harness is info, and no record gives no line', async (t) => {
  const home = tempHome(t);
  const none = await doctorJson(home);
  assert.equal(none.lines.some((l) => l.text.startsWith('modelAvailability ')), false, 'no record, no line');

  await record(home, 'claude-opus-5-5', 'MODEL_GONE', 'claude-api', 'api-key');
  await record(home, 'gpt-5.1-codex', 'MODEL_NOT_ACCESSIBLE', 'codex', 'subscription');
  const view = await modelAvailabilityView(home);
  assert.equal(view.registrySnapshotId, core.BUNDLED_MODEL_REGISTRY.snapshotId);
  const lines = modelAvailabilityDoctorLines(view);
  const gone = lines.find((l) => l.startsWith('modelAvailability claude-opus-5-5: '));
  const denied = lines.find((l) => l.startsWith('modelAvailability gpt-5.1-codex: '));
  // C's line is carried as it is; only MODEL_GONE gains the fix.
  assert.ok(gone.includes(core.modelAvailabilityLines(view.entries.filter((e) => e.modelId === 'claude-opus-5-5'))[0]), gone);
  assert.match(gone, /Fix, once the model is back: jevris route learning gone clear claude-opus-5-5 --yes$/);
  assert.doesNotMatch(denied, /Fix/);
  assert.equal(doctorLineSeverity(gone), 'action');
  assert.equal(doctorLineSeverity(denied), 'info');

  // The same lines reach doctor --json with their severity.
  const report = await doctorJson(home);
  const rows = report.lines.filter((l) => l.text.startsWith('modelAvailability '));
  assert.deepEqual(rows.map((l) => [l.text.split(':')[0], l.severity]).sort(), [['modelAvailability claude-opus-5-5', 'action'], ['modelAvailability gpt-5.1-codex', 'info']]);
});

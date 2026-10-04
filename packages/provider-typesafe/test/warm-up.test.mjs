// The first decision of a process used to pay for compiling its validators (the decision record 33 ms, the Jev request
// 14 ms, the decision result 8 ms; about 70 ms of a first decision that took 110 ms with an instant stub Jev, where the
// next took 22). `createSidecarEngine` warms the decision path before it returns, so the sidecar pays at start, before it
// answers anything, and the first request does not. This file is its own process, and this test runs first in it: the
// number of schemas the shared Ajv has compiled is what tells.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackEngine } from './engine-settle.mjs';

const provider = await import('../dist/index.js');
const { warmDecisionPath } = await import('../dist/warm-up.js');
const core = await import('@jevris/core');
const contracts = await import('@jevris/contracts');

const compiled = () => {
  const cache = contracts.contractAjv()._cache;
  assert.ok(cache instanceof Map, 'Ajv keeps its compiled schemas in a Map; if this changed, count them another way');
  return cache.size;
};

function request() {
  const done = core.compileDecisionSpec({ id: 'task-profile', version: 'v1', questions: provider.CONFORMANCE_REQUEST.questions, evidenceRequirements: ['e1'], deadlineMs: 60_000, fallback: 'rules-only' });
  return {
    spec: done.spec,
    questions: provider.CONFORMANCE_REQUEST.questions,
    workspaceId: 'w-warm',
    evidenceRevision: 'rev-1',
    packet: { objective: 'Add an optional display label to an existing response', trustedPolicy: {}, facts: { publicApiChanged: true }, evidence: [{ id: 'e1', text: 'Existing consumers deserialize this response.', sourceKind: 'file', priority: 'mandatory' }], missingEvidence: [] },
  };
}

test('createSidecarEngine compiles the decision path before it returns: the first decision compiles no schema', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'jevris-warm-'));
  let tracker = null;
  t.after(async () => {
    await tracker?.settled();
    rmSync(home, { recursive: true, force: true });
  });
  const before = compiled();
  const engine = await provider.createSidecarEngine({ home, credential: 'test-key-not-a-secret', fetch: provider.createMockFetch({ scenario: 'valid' }), env: {} });
  tracker = trackEngine(engine);
  const afterCreate = compiled();
  assert.ok(afterCreate > before, `creating the engine compiled nothing (${before} before, ${afterCreate} after)`);
  const outcome = await engine.decide(request());
  assert.equal(outcome.abstained, false, JSON.stringify(outcome));
  assert.equal(compiled(), afterCreate, 'the first decision had to compile a schema: it was not warmed');
});

test('the warm-up changes nothing a person could see: no file, and the engine is the same one', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'jevris-warm-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const engine = await provider.createSidecarEngine({ home, credential: null, env: {} });
  assert.equal(engine.providerConfigured, false);
  // Nothing was written to the journal, and the budget file does not exist until a reservation is made.
  const names = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else names.push(entry.name);
    }
  };
  walk(home);
  assert.deepEqual(names.filter((name) => /decision-budget|\.json$/.test(name)), []);
  // It can be called again and never rejects, whatever state the process is in.
  assert.equal(await warmDecisionPath(), undefined);
});

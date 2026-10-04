// The inventory of every place the product asks Jev stays true to the source: each entry names a file
// that holds its spec, and no file that asks Jev is missing from the list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { FEATURE_INVENTORY, inventoryByWiring } = await import('../dist/index.js');
const root = fileURLToPath(new URL('../../..', import.meta.url));

function sources(dir) {
  const out = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(rel));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(rel);
  }
  return out;
}

test('every inventory entry names a source file that holds its spec', () => {
  assert.equal(new Set(FEATURE_INVENTORY.map((e) => e.spec)).size, FEATURE_INVENTORY.length, 'specs are unique');
  for (const entry of FEATURE_INVENTORY) {
    const path = join(root, entry.file);
    assert.ok(existsSync(path), `${entry.spec}: ${entry.file} exists`);
    assert.ok(readFileSync(path, 'utf8').includes(entry.needle), `${entry.spec}: ${entry.file} holds ${entry.needle}`);
    assert.ok(entry.note.length > 10, `${entry.spec} says what reaches it`);
  }
});

test('no file that asks Jev is missing from the inventory', () => {
  const listed = new Set(FEATURE_INVENTORY.map((e) => e.file));
  const asking = [];
  for (const dir of ['packages/core/src', 'packages/provider-typesafe/src', 'packages/orchestrator/src', 'apps/sidecar/src']) {
    for (const file of sources(dir)) {
      const text = readFileSync(join(root, file), 'utf8');
      // The engine's own call, the shared bounded-question helper and the capability consult helpers.
      if (/askBoundedDecision\(|consultChoice\(|consultNoul\(|consultScore\(|\bengine\.decide\(|\bdecide\(\s*\{/.test(text) && !/export (async )?function (consult|ask)/.test(text)) asking.push(file);
    }
  }
  const infrastructure = new Set([
    'packages/core/src/decision-engine.ts', // the engine itself (the probe is listed)
    'packages/core/src/decision-reschedule.ts', // re-asks a stale decision through the engine
    'packages/orchestrator/src/capabilities/consult.ts',
    'packages/provider-typesafe/src/features-suite.ts', // this suite
    'packages/provider-typesafe/src/trigger-handlers.ts', // routes triggers to the handlers above
    'packages/provider-typesafe/src/live-handlers.ts',
    'apps/sidecar/src/state.ts',
    'packages/core/src/ledger.ts', // an unrelated `decide` of its own
    'packages/core/src/route-switch.ts', // an unrelated `decide` of its own
    'packages/core/src/intent-decisions.ts', // listed per spec
    'packages/core/src/security-advice.ts',
  ]);
  const missing = asking.filter((file) => !listed.has(file) && !infrastructure.has(file));
  assert.deepEqual(missing, [], 'a file asks Jev but is not in the inventory: add it to features-inventory.ts');
});

test('the inventory counts what is live, on demand, dormant and never asked', () => {
  const counts = inventoryByWiring();
  assert.ok(counts.hot >= 3, 'route, check ranking and the probe are on a hot path');
  assert.ok(counts.detached >= 4, 'repeated failure, new task and the two security decisions run after the hook has answered');
  assert.ok(counts.dormant >= 6, 'the older intent decisions and the memory functions no op reaches');
  assert.equal(counts['not-asked'], 1, 'worker-readiness is defined and never asked');
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), FEATURE_INVENTORY.length);
});

// The inventory of every place the product asks Jev (`features-inventory.ts`) says the feature suite covers each
// entry once, and the changelog says every Jev decision has a case (JEV-0067). The engine-level entries are covered
// by rows of the engine groups (`packages/provider-typesafe/test/features-suite.test.mjs` checks that every such
// entry has a row of its own spec, the circuit breaker's health probe included). This checks the other half: every
// capability entry (`d-cNN`) has a case among the capability parts the sidecar runs, whose id is the capability's own
// (`C25`, or a variant such as `C28-owned`), and no case names a capability the inventory does not list.
import test from 'node:test';
import assert from 'node:assert/strict';

const { FEATURE_INVENTORY } = await import('@jevris/provider-typesafe');
const { CASES } = await import('../scripts/jev-feature-cases.mjs');

const CAPABILITY_ENTRY = /^d-c(\d{2})$/;

test('every capability the inventory lists has a case in the capability parts, and every capability case that asks Jev is in the inventory', () => {
  const inventory = FEATURE_INVENTORY.flatMap((e) => (CAPABILITY_ENTRY.exec(e.spec) === null ? [] : [CAPABILITY_ENTRY.exec(e.spec)[1]]));
  const idOf = (c) => /^C(\d{2})/.exec(c.id)?.[1];
  const cased = [...new Set(CASES.flatMap((c) => (idOf(c) === undefined ? [] : [idOf(c)])))];
  // A case that expects no Jev request (C65, C66 and C71 never consult Jev, so they are not asks) is not an ask the inventory must list.
  const asking = [...new Set(CASES.filter((c) => c.expectAsked !== false).flatMap((c) => (idOf(c) === undefined ? [] : [idOf(c)])))];
  assert.ok(inventory.length > 0 && cased.length > 0, 'the inventory and the cases were read');
  assert.deepEqual(inventory.filter((id) => !cased.includes(id)).map((id) => `C${id}`), [], 'an inventory capability with no case in the suite');
  assert.deepEqual(asking.filter((id) => !inventory.includes(id)).map((id) => `C${id}`), [], 'a case that asks Jev for a capability the inventory does not list');
});

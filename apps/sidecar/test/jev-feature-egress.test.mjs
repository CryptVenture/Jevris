// The inventory's `egress` field and what a capability does with source egress denied agree (JEV-0064). A capability whose Jev question is about text
// (a query, a span, a diff, a requirement, a name or an id a person gave) sets `sendsWorkspaceText` on its consult, so with egress denied it is not asked: the
// packet builder would withhold the text and Jev would be asked about a hash and a length, and its answer would be labelled Jev's. A capability whose question
// holds everything it needs in counts, codes and flags (`facts`) still asks. The feature cases run each capability with egress denied and approved
// (jev-feature-cases-{a,b,c}.test.mjs): this file checks that the inventory, the cases and the source say the same thing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES as CASES_A, OWNED_CASES } from '../scripts/jev-feature-cases-a.mjs';
import { CASES as CASES_B } from '../scripts/jev-feature-cases-b.mjs';
import { CASES as CASES_C } from '../scripts/jev-feature-cases-c.mjs';

const { FEATURE_INVENTORY } = await import('@jevris/provider-typesafe');
const root = fileURLToPath(new URL('../../..', import.meta.url));

/** The capabilities the inventory lists (`d-c41` is C41), with the entry. */
const capabilities = FEATURE_INVENTORY.filter((entry) => /^d-c\d{2}$/.test(entry.spec)).map((entry) => ({ id: entry.spec.slice(2).toUpperCase(), entry }));

/** The capability a case is about: part C names it, parts A and B name it in the call. */
const capabilityOf = (kase) => kase.capability ?? kase.call.body.capabilityId;

const ALL_CASES = [...CASES_A, ...OWNED_CASES, ...CASES_B, ...CASES_C];

test('every capability the inventory lists has a feature case, and its egress field says whether the cases need egress', () => {
  assert.ok(capabilities.length > 0, 'the inventory lists no capability');
  const disagree = [];
  for (const { id, entry } of capabilities) {
    const mine = ALL_CASES.filter((kase) => capabilityOf(kase) === id);
    assert.ok(mine.length >= 1, `${id} is in the inventory and has no feature case`);
    const needsEgress = mine.map((kase) => kase.egressNeeded === true);
    // `text`: every case waits for egress approval. `features`: none does.
    const expected = entry.egress === 'text';
    if (needsEgress.some((needs) => needs !== expected)) disagree.push(`${id}: the inventory says ${entry.egress}, the cases ${mine.map((kase) => `${kase.id}=${String(kase.egressNeeded === true)}`).join(' ')}`);
  }
  assert.deepEqual(disagree, []);
});

test('the source of each capability agrees with the inventory: a text capability marks its consult sendsWorkspaceText, a features one does not', () => {
  const disagree = [];
  for (const { id, entry } of capabilities) {
    // The memory capabilities and C29 are gated by their own consult gate (the person's preference as well as the administrator's); the others by the flag.
    if (!entry.file.includes('/capabilities/')) continue;
    const source = readFileSync(join(root, entry.file), 'utf8');
    const at = source.indexOf(`capabilityId: '${id}'`);
    assert.ok(at >= 0, `${id}: no consult in ${entry.file}`);
    const next = source.indexOf("capabilityId: '", at + 10);
    const block = source.slice(at, next < 0 ? source.length : next);
    const flagged = /sendsWorkspaceText: true/.test(block);
    if (flagged !== (entry.egress === 'text')) disagree.push(`${id}: the inventory says ${entry.egress}, its consult ${flagged ? 'sets' : 'does not set'} sendsWorkspaceText`);
  }
  assert.deepEqual(disagree, []);
});

test('the capabilities named in the report of JEV-0064 are about text and wait for egress approval, and the features-only ones do not', () => {
  const egress = new Map(capabilities.map(({ id, entry }) => [id, entry.egress]));
  for (const id of ['C34', 'C35', 'C37', 'C40', 'C62', 'C67']) assert.equal(egress.get(id), 'text', `${id}: its question is about text a person or the workspace supplied`);
  for (const id of ['C32', 'C44', 'C46', 'C47', 'C59', 'C64', 'C68', 'C69', 'C72', 'C29']) assert.equal(egress.get(id), 'features', `${id}: its question is judged from counts, codes and flags`);
});

// The inventory of every place the product asks Jev stays true to the source: each entry names a file
// that holds its spec, and no file that asks Jev is missing from the list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { FEATURE_INVENTORY, OP_ONLY_ENTRY, inventoryByWiring } = await import('../dist/index.js');
const orchestrator = await import('@jevris/orchestrator');
const contracts = await import('@jevris/contracts');
const root = fileURLToPath(new URL('../../..', import.meta.url));

function sources(dir) {
  const out = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    // Forward slashes on every host: the inventory names files the way the repository does.
    const rel = `${dir}/${entry.name}`;
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
    assert.ok(entry.note.length > 10, `${entry.spec} says what it does`);
    assert.ok(entry.entry.length > 10, `${entry.spec} names the real entry that reaches it`);
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
    'packages/core/src/intent-fixed.ts', // the fixed vocabulary of the new-task decisions
  ]);
  const missing = asking.filter((file) => !listed.has(file) && !infrastructure.has(file));
  assert.deepEqual(missing, [], 'a file asks Jev but is not in the inventory: add it to features-inventory.ts');
});

/** The files a pattern is found in, under the source folders the product asks Jev from. */
function sourceTexts() {
  const out = [];
  for (const dir of ['packages/core/src', 'packages/provider-typesafe/src', 'packages/orchestrator/src', 'apps/sidecar/src']) {
    for (const file of sources(dir)) out.push([file, readFileSync(join(root, file), 'utf8')]);
  }
  return out;
}

test('no consult site is missing from the inventory: every capability a consult names, and every decision spec a handler asks, is listed', () => {
  const specs = new Set(FEATURE_INVENTORY.map((e) => e.spec));
  const unlisted = [];
  for (const [file, text] of sourceTexts()) {
    // A capability consult: `capabilityId: 'C19'`. (A capability that never consults Jev, such as C65, is not an ask.)
    for (const m of text.matchAll(/capabilityId: '(C\d{2})'/g)) if (!specs.has(`d-${m[1].toLowerCase()}`)) unlisted.push(`${file}: ${m[1]}`);
    // A decision spec a handler asks through the bounded-question helper: `ask(engine, 'c01-task-family', ...)`.
    for (const m of text.matchAll(/\b(?:ask|askBoundedDecision)\(\s*(?:engine|input\.engine|e),\s*'([a-z][a-z0-9-]*)'/g)) if (!specs.has(m[1])) unlisted.push(`${file}: ${m[1]}`);
  }
  assert.deepEqual([...new Set(unlisted)], [], 'a consult site or decision spec asks Jev and is not in the inventory: add it to features-inventory.ts');
});

test('the inventory says what is true after the wiring: nothing is dormant and nothing is defined and never asked; a new such entry fails here', () => {
  const counts = inventoryByWiring();
  assert.deepEqual(FEATURE_INVENTORY.filter((e) => e.wiring === 'dormant' || e.wiring === 'not-asked').map((e) => e.spec), [], 'a decision with no caller from a hook, an op, a command or a tool');
  assert.equal(counts.dormant, 0);
  assert.equal(counts['not-asked'], 0);
  assert.equal(counts.hot, 8, 'route and plan slices, check ranking, the probe, the PostCompact audit, the capsule choice, the project memory at a restore, the risk of a subagent launch and the model tier');
  assert.equal(counts.detached, 10, 'repeated failure, new task and its three decisions, C06, the two security decisions, worker readiness and the output spans');
  assert.equal(counts['on-demand'], FEATURE_INVENTORY.length - 18);
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), FEATURE_INVENTORY.length);
  // The decisions that were dormant (C01, C02, C04, C06, C19 to C24 and the worker-readiness question) are all live now. C05 asks Jev nothing: its question was measured and removed.
  assert.equal(FEATURE_INVENTORY.some((e) => e.spec === 'c05-evidence'), false, 'C05 is rules only: no inventory entry for a question nothing asks');
  const was = ['c01-task-family', 'c02-ambiguity', 'c04-template', 'c06-scope', 'd-c19', 'd-c20', 'd-c21', 'd-c22', 'd-c23', 'd-c24', 'worker-readiness'];
  assert.deepEqual(was.filter((spec) => !FEATURE_INVENTORY.some((e) => e.spec === spec && e.wiring !== 'dormant' && e.wiring !== 'not-asked')), []);
});

test('every capability the inventory lists is reachable: through a command and a tool, or through the capability.advise op only, and the ones the op alone reaches are named', () => {
  const capabilities = FEATURE_INVENTORY.filter((e) => /^d-c\d{2}$/.test(e.spec) && e.file.includes('/capabilities/'));
  const named = new Set([...contracts.ADVISE_CAPABILITY_IDS, ...Object.values(contracts.DELIVERY_REPORTS)]);
  const opOnly = capabilities.filter((e) => e.entry === OP_ONLY_ENTRY).map((e) => e.spec.slice(2).toUpperCase());
  for (const e of capabilities) {
    const id = e.spec.slice(2).toUpperCase();
    assert.equal(e.entry === OP_ONLY_ENTRY, !named.has(id), `${id}: the entry says what a command, a tool or only the op reaches`);
    assert.ok(orchestrator.CAPABILITIES.has(id) || id in orchestrator.CAPABILITY_OPS, `${id} is defined in the capability registry the op serves`);
  }
  // The capabilities that only the op reaches. The fourteen no command named were given `jevris advise` and `jevris_advise` ids (decision of
  // 2026-10-04) except C68, which creates and removes git worktrees and applies patches in them and so does not fit a read-only advice tool; its
  // inventory entry says so. A new one fails here.
  assert.deepEqual(opOnly, ['C68']);
  assert.match(capabilities.find((e) => e.spec === 'd-c68').note, /worktrees/);
  for (const id of ['C32', 'C33', 'C34', 'C35', 'C36', 'C37', 'C38', 'C40', 'C62', 'C67', 'C69', 'C70', 'C72']) assert.ok(contracts.ADVISE_CAPABILITY_IDS.includes(id), `${id} is on jevris advise and jevris_advise`);
  // The memory capabilities and C29 have their own product op (checkpoint, recover, a hook event) rather than capability.advise.
  for (const id of ['C18', 'C19', 'C20', 'C21', 'C22', 'C23', 'C24', 'C29']) assert.ok(id in orchestrator.CAPABILITY_OPS || ['C19', 'C20', 'C21', 'C22', 'C23', 'C24'].includes(id), id);
});

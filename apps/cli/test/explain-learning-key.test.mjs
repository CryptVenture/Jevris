// JEV-0055 through `jevris explain <decision> --slice <key>` and jevris_explain_decision: a learning
// key (`<slice>::<baseline model>`, as `route learning status` lists it) can be explained, and its
// route-learning trace names that key's own baseline as the default arm, with the same numbers that
// route learning status lists for it. The bare slice keeps Opus 5.5. Temporary HOME, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NEW_KEY, NEW_SOL, OLD_KEY, OLD_SOL, OPUS, SLICE, seededBox } from './learning-keys-fixture.mjs';

const { jevrisPaths } = await import('@jevris/platform');

const DECISION = 'd-00000000-0000-4000-8000-000000000055';

// A current time: the sidecar's retention sweep at start prunes a journal entry past the retention cutoff.
function journalEntry(decisionId) {
  const record = {
    schemaVersion: '1.0',
    decisionId,
    specId: 'main-route',
    modelResolved: null,
    mode: 'advise',
    evidenceRevision: 'r1',
    outcome: 'advisory',
    reasonCodes: ['KEEP_CURRENT'],
    proposedAction: { kind: 'advise', templateId: 'main-route', evidenceIds: [] },
    appliedAction: null,
    usage: null,
    billingBasis: 'no-provider-call',
    actualTaskOutcome: 'unknown',
  };
  return { schemaVersion: 'jevris-decision-journal-1', decisionId, state: 'evaluated', history: [{ state: 'evaluated', atMs: Date.now() }], draft: {}, record, schemaFailure: null };
}

test('explain --slice names the key\'s own default arm too, on the CLI and the MCP tool, and agrees with route learning status', async (t) => {
  const box = await seededBox(t);
  assert.equal(box.startSidecar().code, 0, 'the sidecar did not start');
  const journal = join(jevrisPaths({ home: box.home }).data, 'decisions');
  mkdirSync(journal, { recursive: true });
  writeFileSync(join(journal, `${DECISION}.json`), `${JSON.stringify(journalEntry(DECISION))}\n`);
  const client = await box.mcp();
  const status = Object.fromEntries(box.jevris(['route', 'learning', 'status'], { json: true }).json.slices.map((s) => [s.sliceId, s]));

  for (const [key, defaultArm] of [[SLICE, OPUS], [OLD_KEY, OLD_SOL], [NEW_KEY, NEW_SOL]]) {
    const shown = box.jevris(['explain', DECISION, '--slice', key], { json: true });
    assert.equal(shown.code, 0, `${key}: ${shown.stdout} ${shown.stderr}`);
    const learning = shown.json.result.trace.learning;
    assert.equal(learning.sliceId, key);
    assert.equal(learning.economics.defaultArmId, defaultArm, key);
    // The numbers are the ones route learning status lists for the key.
    assert.deepEqual(learning.economics, status[key].economics, key);
    assert.ok(learning.lines.some((l) => l.startsWith(`Per verified task ${defaultArm}:`) && l.endsWith('(the default).')), `${key}: ${learning.lines.join('\n')}`);
    const viaMcp = await client.callTool({ name: 'jevris_explain_decision', arguments: { decisionId: DECISION, sliceId: key } });
    assert.notEqual(viaMcp.isError, true, `${key}: ${JSON.stringify(viaMcp)}`);
    assert.deepEqual(viaMcp.structuredContent.result.trace.learning.economics, learning.economics, key);
  }
  const human = box.jevris(['explain', DECISION, '--slice', OLD_KEY]).stdout;
  assert.match(human, new RegExp(`^Per verified task ${OLD_SOL}: .* \\(the default\\)\\.$`, 'm'));
  assert.doesNotMatch(human, new RegExp(`${OPUS} \\(the default\\)`));
});


test('a learning key must still be a plain id: a path, a space, a leading colon or an over-long key is refused on the CLI and the MCP tool', async (t) => {
  const box = await seededBox(t);
  assert.equal(box.startSidecar().code, 0, 'the sidecar did not start');
  const journal = join(jevrisPaths({ home: box.home }).data, 'decisions');
  mkdirSync(journal, { recursive: true });
  writeFileSync(join(journal, `${DECISION}.json`), `${JSON.stringify(journalEntry(DECISION))}\n`);
  const client = await box.mcp();
  for (const bad of ['../x', `${SLICE}::../x`, `${SLICE}::gpt 6`, '::gpt-6-sol', `${SLICE}::${'m'.repeat(130)}`]) {
    const cli = box.jevris(['explain', DECISION, '--slice', bad], { json: true });
    assert.equal(cli.code, 2, `${bad}: ${cli.stdout} ${cli.stderr}`);
    const mcp = await client.callTool({ name: 'jevris_explain_decision', arguments: { decisionId: DECISION, sliceId: bad } });
    assert.equal(mcp.isError, true, bad);
  }
});

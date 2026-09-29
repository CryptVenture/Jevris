// US12 through the product: `jevris explain` and jevris_explain_decision show which model did
// the work in the session a decision came from, kept apart from the one requested. The session
// rows come from real Claude hook deliveries through the launcher: SessionStart and later events
// report the model in use (actual), PreModelSwitch names the model asked for (requested). The
// decisions are journal entries naming those sessions. Three cases: substituted, the same model,
// and nothing observed (unknown, with no cost precision claimed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from '../../../test/acceptance/lib.mjs';
import { deliverHook } from '../../../test/acceptance/certified-hooks.mjs';

const { jevrisPaths } = await import('@jevris/platform');

const DECISIONS = {
  substituted: { id: 'd-00000000-0000-4000-8000-000000000012', session: 'sess-sub', requested: 'claude-opus-4-7', actual: 'claude-sonnet-4-6' },
  same: { id: 'd-00000000-0000-4000-8000-000000000013', session: 'sess-same', requested: 'claude-sonnet-4-6', actual: 'claude-sonnet-4-6' },
  quiet: { id: 'd-00000000-0000-4000-8000-000000000014', session: 'sess-quiet', requested: 'claude-opus-4-7', actual: null },
};

function journalEntry(decisionId, sessionId) {
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
    sessionId,
  };
  return { schemaVersion: 'jevris-decision-journal-1', decisionId, state: 'evaluated', history: [{ state: 'evaluated', atMs: Date.now() }], draft: {}, record, schemaFailure: null };
}

test('explain shows the requested and the actual model of the decision\'s session, and unknown when nothing observed it (US12)', async (t) => {
  const box = await sandbox(t);
  box.write('work/src/a.js', 'export const a = 1;\n');
  box.gitInit();
  assert.equal(box.startSidecar().code, 0, 'the sidecar did not start');
  const journal = join(jevrisPaths({ home: box.home }).data, 'decisions');
  mkdirSync(journal, { recursive: true });
  for (const d of Object.values(DECISIONS)) {
    const native = (fields) => ({ session_id: d.session, cwd: box.work, ...fields });
    // Starts on the requested model when one is known; nothing reports a model in the quiet session.
    deliverHook(box, 'claude', native({ hook_event_name: 'SessionStart', source: 'startup', ...(d.actual === null ? {} : { model: d.requested }) }));
    deliverHook(box, 'claude', native({ hook_event_name: 'PreModelSwitch', from_model: d.requested, to_model: d.requested }));
    // A later event reports the model that is actually in use.
    if (d.actual !== null) deliverHook(box, 'claude', native({ hook_event_name: 'UserPromptSubmit', prompt: 'continue', model: d.actual }));
    writeFileSync(join(journal, `${d.id}.json`), `${JSON.stringify(journalEntry(d.id, d.session))}\n`);
  }

  const cli = (id) => box.jevris(['explain', id], { json: true });
  const sub = cli(DECISIONS.substituted.id);
  assert.equal(sub.code, 0, sub.stdout + sub.stderr);
  assert.equal(sub.json.mode, 'full');
  assert.deepEqual(sub.json.result.trace.models, { requested: 'claude-opus-4-7', observed: 'claude-sonnet-4-6', source: 'session', substituted: true, costPrecision: 'unknown' });
  const subText = box.jevris(['explain', DECISIONS.substituted.id]).stdout;
  assert.match(subText, /^requested model: claude-opus-4-7$/m);
  assert.match(subText, /^observed model: claude-sonnet-4-6 \(reported by the session\)$/m);
  assert.match(subText, /^substituted: yes: claude-opus-4-7 was requested, claude-sonnet-4-6 did the work$/m);
  assert.match(subText, /^cost precision: unknown$/m);

  const same = cli(DECISIONS.same.id);
  assert.deepEqual(same.json.result.trace.models, { requested: 'claude-sonnet-4-6', observed: 'claude-sonnet-4-6', source: 'session', substituted: false, costPrecision: 'unknown' });
  assert.match(box.jevris(['explain', DECISIONS.same.id]).stdout, /^substituted: no$/m);

  const quiet = cli(DECISIONS.quiet.id);
  assert.deepEqual(quiet.json.result.trace.models, { requested: 'claude-opus-4-7', observed: null, source: 'unknown', substituted: null, costPrecision: 'unknown' });
  const quietText = box.jevris(['explain', DECISIONS.quiet.id]).stdout;
  assert.match(quietText, /^observed model: unknown \(nothing reported it\)$/m);
  assert.match(quietText, /^substituted: unknown$/m);

  // The same answer over MCP, where the SDK client checks the tool's output schema.
  const client = await box.mcp();
  const mcp = await client.callTool({ name: 'jevris_explain_decision', arguments: { decisionId: DECISIONS.substituted.id } });
  assert.notEqual(mcp.isError, true, JSON.stringify(mcp));
  assert.deepEqual(mcp.structuredContent.result.trace.models, sub.json.result.trace.models);
  const text = mcp.content.map((part) => part.text ?? '').join('\n');
  assert.match(text, /claude-sonnet-4-6/);
  assert.match(text, /claude-opus-4-7/);
  const mcpQuiet = await client.callTool({ name: 'jevris_explain_decision', arguments: { decisionId: DECISIONS.quiet.id } });
  assert.equal(mcpQuiet.structuredContent.result.trace.models.observed, null);
  assert.equal(mcpQuiet.structuredContent.result.trace.models.costPrecision, 'unknown');
});

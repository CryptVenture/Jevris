import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliverHook } from './certified-hooks.mjs';
import { load, story } from './lib.mjs';

// US12: the harness substitutes the requested model. The session's requested and actual model
// come from real Claude hook deliveries through the launcher and the sidecar (B's session rows:
// PreModelSwitch names the model asked for, SessionStart and later events report the model in
// use). The task's result is a decision in that session (a journal entry naming it), and
// `jevris explain` reports the two models apart (C's trace.models, E's rendering). A session
// nothing observed reads unknown, and no cost precision is claimed.

const DECISIONS = {
  substituted: { id: 'd-00000000-0000-4000-8000-000000001201', session: 'us12-sub', requested: 'claude-opus-4-7', actual: 'claude-sonnet-4-6' },
  quiet: { id: 'd-00000000-0000-4000-8000-000000001202', session: 'us12-quiet', requested: 'claude-opus-4-7', actual: null },
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
  // A current time: the sidecar's retention sweep at start (B 3254d35, K4) prunes a journal entry
  // past the retention cutoff, so an entry from 1970 could be gone before explain reads it.
  return { schemaVersion: 'jevris-decision-journal-1', decisionId, state: 'evaluated', history: [{ state: 'evaluated', atMs: Date.now() }], draft: {}, record, schemaFailure: null };
}

story('US12', async ({ then, sandbox, evidence }) => {
  const box = await sandbox();
  const { jevrisPaths } = await load('platform');
  box.write('work/src/a.js', 'export const a = 1;\n');
  box.gitInit();
  assert.equal(box.startSidecar().code, 0, 'the sidecar did not start');
  const journal = join(jevrisPaths({ home: box.home, env: box.env }).data, 'decisions');
  mkdirSync(journal, { recursive: true });
  for (const d of Object.values(DECISIONS)) {
    const native = (fields) => ({ session_id: d.session, cwd: box.work, ...fields });
    // The person asks for the model; only the substituted session reports what actually ran.
    deliverHook(box, 'claude', native({ hook_event_name: 'SessionStart', source: 'startup' }));
    deliverHook(box, 'claude', native({ hook_event_name: 'PreModelSwitch', from_model: 'claude-haiku-4-5', to_model: d.requested }));
    if (d.actual !== null) deliverHook(box, 'claude', native({ hook_event_name: 'UserPromptSubmit', prompt: 'continue the task', model: d.actual }));
    writeFileSync(join(journal, `${d.id}.json`), `${JSON.stringify(journalEntry(d.id, d.session))}\n`);
  }
  const explain = (id) => ({ json: box.jevris(['explain', id], { json: true }).json, text: box.jevris(['explain', id]).stdout });
  const sub = explain(DECISIONS.substituted.id);
  const quiet = explain(DECISIONS.quiet.id);
  evidence({ sub: sub.json?.result?.trace?.models, quiet: quiet.json?.result?.trace?.models });

  await then('The report separates requested and observed model', () => {
    assert.deepEqual(sub.json?.result?.trace?.models, { requested: 'claude-opus-4-7', observed: 'claude-sonnet-4-6', source: 'session', substituted: true, costPrecision: 'unknown' });
    assert.match(sub.text, /^requested model: claude-opus-4-7$/m);
    assert.match(sub.text, /^observed model: claude-sonnet-4-6 \(reported by the session\)$/m);
    assert.match(sub.text, /^substituted: yes: claude-opus-4-7 was requested, claude-sonnet-4-6 did the work$/m);
  });

  await then('missing observation is marked unknown and does not fabricate cost precision', () => {
    assert.deepEqual(quiet.json?.result?.trace?.models, { requested: 'claude-opus-4-7', observed: null, source: 'unknown', substituted: null, costPrecision: 'unknown' });
    assert.match(quiet.text, /^observed model: unknown \(nothing reported it\)$/m);
    assert.match(quiet.text, /^substituted: unknown$/m);
    assert.match(quiet.text, /^cost precision: unknown$/m);
    assert.doesNotMatch(quiet.text, /provider-reported|estimate/);
  });
});

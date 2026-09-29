/**
 * P5 on the model-change hook (C's side of B's adherence port, 0d977da): advice is opened only when
 * its answer is delivered (the proposal's commit), and advice a session did not follow twice is not
 * repeated there. Without the port (rules-only, the global workspace) nothing changes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { modelChangeAdviceWith, ADVICE_REPEAT_LIMIT } = await import('../dist/index.js');
const { AdviceOnce } = await import('@jevris/core');

// pinned-clock: the advice time comes from this stand-in engine clock.
const T = Date.parse('2026-09-27T12:00:00Z');
const KEY = `sha256:${'ab'.repeat(32)}`;
const advise = () => ({ outcome: 'recommend', adviceKey: KEY, recommendedModelId: 'claude-sonnet-5', reasonCode: 'ROUTE_RECOMMEND', text: 'Jevris suggests another model.' });

function input(t, adviceAdherence, sessionId = 'sess-1') {
  const home = mkdtempSync(join(tmpdir(), 'jevris-adherence-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return {
    ctx: { home, body: {}, ...(adviceAdherence === undefined ? {} : { adviceAdherence }) },
    envelope: { sessionId, workspaceId: 'w-1', expectedRevision: 'r1', occurredAt: new Date(T).toISOString() },
    event: { model: 'claude-opus-5' },
    engine: { now: () => T },
  };
}

test('P5: model-change advice is opened for adherence only when delivered, under an id derived from its advice key', async (t) => {
  const opened = [];
  const port = { open: (i) => (opened.push(i), true), overrides: () => 0 };
  const proposal = await modelChangeAdviceWith(input(t, port), { advise, once: new AdviceOnce() });
  assert.equal(proposal.hookOutcome.kind, 'explain');
  assert.deepEqual(opened, [], 'not delivered yet');
  assert.equal(proposal.commit(), true);
  assert.deepEqual(opened, [{ decisionId: `advice-${'ab'.repeat(16)}-${T.toString(36)}`, sessionId: 'sess-1', adviceKind: 'model-change', slice: 'session', advisedModel: 'claude-sonnet-5', currentModel: null, atMs: T }]);
  assert.equal(proposal.commit(), false, 'shown once');
  assert.equal(opened.length, 1);
});

test('P5: advice this session did not follow twice is not proposed again; once is not enough; without the port nothing changes', async (t) => {
  assert.equal(ADVICE_REPEAT_LIMIT, 2);
  const counting = (n) => ({ open: () => true, overrides: (i) => (i.sessionId === 'sess-1' && i.adviceKind === 'model-change' && i.advisedModel === 'claude-sonnet-5' ? n : 0) });
  assert.equal(await modelChangeAdviceWith(input(t, counting(2)), { advise, once: new AdviceOnce() }), null);
  assert.notEqual(await modelChangeAdviceWith(input(t, counting(1)), { advise, once: new AdviceOnce() }), null);
  assert.notEqual(await modelChangeAdviceWith(input(t, counting(2), 'sess-2'), { advise, once: new AdviceOnce() }), null, 'a new session starts at 0');
  const plain = await modelChangeAdviceWith(input(t, undefined), { advise, once: new AdviceOnce() });
  assert.equal(plain.commit(), true);
  // A port that throws never breaks the hook.
  const broken = { open: () => { throw new Error('store'); }, overrides: () => { throw new Error('store'); } };
  const survived = await modelChangeAdviceWith(input(t, broken), { advise, once: new AdviceOnce() });
  assert.equal(survived.commit(), true);
});

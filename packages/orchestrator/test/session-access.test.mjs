// Access limits seen in interactive sessions (R71): what counts as a success that clears a scope.
// A failed or errored turn never has its own pause cleared by a success of that same turn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { drainSessionAccess, noteSessionAccess, setCertificationGate } from '../dist/index.js';
import { emptyLearningState, readAccessLimits, saveLearningState } from '@jevris/core';
import { tempDir } from './temp-dirs.mjs';

const NOW = Date.parse('2026-09-28T10:00:00Z');
const CREDIT = { port: 'opencode', channel: 'structured', errorType: 'APIError', status: 402 };

function home() {
  const dir = join(tempDir('jv-session-access-'), 'home');
  mkdirSync(dir);
  return dir;
}

const ev = (harness, kind, sessionId, extra = {}) => ({ harness, kind, sessionId, agentId: null, model: null, payload: {}, ...extra });
const pauses = async (h) => (await readAccessLimits(h)).entries.map((e) => [e.scope.harness, e.class]);

test('R71: an errored assistant message is neither a success nor a failure; it clears nothing, and the turn\'s later messages clear nothing until the next turn starts', async () => {
  const h = home();
  let t = NOW;
  noteSessionAccess(h, ev('opencode', 'task.requested', 's-err'), (t += 1_000));
  noteSessionAccess(h, ev('opencode', 'message.completed', 's-err', { model: 'zai/glm-5.3' }), (t += 60_000));
  assert.equal(noteSessionAccess(h, ev('opencode', 'turn.failed', 's-err', { payload: { accessSignal: CREDIT } }), (t += 1_000)), 'ACCESS_QUEUED');
  await drainSessionAccess();
  assert.deepEqual(await pauses(h), [['opencode', 'credit-exhausted']]);
  // The next turn: an assistant message that ended on an error that is not an access signal.
  noteSessionAccess(h, ev('opencode', 'task.requested', 's-err'), (t += 60_000));
  // The adapters' payload for a failed assistant message (F c511bae9): token counts and the fixed
  // flag, never the error's name or text; the flag is absent on a message that did not fail.
  assert.equal(noteSessionAccess(h, ev('opencode', 'message.completed', 's-err', { model: 'zai/glm-5.3', payload: { inputTokens: 12, outputTokens: 0, errored: true } }), (t += 1_000)), null, 'an errored message records nothing');
  assert.equal(noteSessionAccess(h, ev('opencode', 'message.completed', 's-err', { model: 'zai/glm-5.3' }), (t += 20_000)), null, 'a later message of the errored turn is no success');
  await drainSessionAccess();
  assert.deepEqual(await pauses(h), [['opencode', 'credit-exhausted']], 'the pause stays');
  // A turn that finishes without an error clears it.
  noteSessionAccess(h, ev('opencode', 'task.requested', 's-err'), (t += 60_000));
  assert.equal(noteSessionAccess(h, ev('opencode', 'message.completed', 's-err', { model: 'zai/glm-5.3', payload: { errored: false } }), (t += 1_000)), 'ACCESS_SUCCESS_QUEUED');
  await drainSessionAccess();
  assert.deepEqual(await pauses(h), []);
});

test('R71: a success never clears a pause its own turn recorded, whichever event arrives first; the writes land in event order', async () => {
  const h = home();
  let t = NOW;
  // Kilo: the failure first, then the failed message's completion with no error marker (an adapter without the flag).
  noteSessionAccess(h, ev('kilocode', 'task.requested', 's-race'), (t += 1_000));
  noteSessionAccess(h, ev('kilocode', 'message.completed', 's-race', { model: 'moonshotai/kimi-k3' }), (t += 60_000));
  noteSessionAccess(h, ev('kilocode', 'task.requested', 's-race'), (t += 60_000));
  assert.equal(noteSessionAccess(h, ev('kilocode', 'turn.failed', 's-race', { payload: { accessSignal: { port: 'kilocode', channel: 'structured', errorType: 'ProviderAuthError' } } }), (t += 1_000)), 'ACCESS_QUEUED');
  assert.equal(noteSessionAccess(h, ev('kilocode', 'message.completed', 's-race', { model: 'moonshotai/kimi-k3' }), (t += 1)), null, 'the failed turn\'s message is no success');
  await drainSessionAccess();
  assert.deepEqual(await pauses(h), [['kilocode', 'account-blocked']]);
  // A success queued just before a failure: the clear runs first, the pause lands after it.
  const g = home();
  t += 60_000;
  noteSessionAccess(g, ev('opencode', 'task.requested', 's-order'), t);
  assert.equal(noteSessionAccess(g, ev('opencode', 'message.completed', 's-order', { model: 'zai/glm-5.3' }), (t += 1)), 'ACCESS_SUCCESS_QUEUED');
  assert.equal(noteSessionAccess(g, ev('opencode', 'turn.failed', 's-order', { payload: { accessSignal: CREDIT } }), (t += 1)), 'ACCESS_QUEUED');
  await drainSessionAccess();
  assert.deepEqual(await pauses(g), [['opencode', 'credit-exhausted']]);
});

test('R71: a Claude Code Stop after a failed turn clears nothing until a new prompt starts the next turn', async () => {
  const h = home();
  let t = NOW;
  noteSessionAccess(h, ev('claude', 'session.started', 's-claude', { model: 'claude-opus-5-5[1m]' }), (t += 1_000));
  noteSessionAccess(h, ev('claude', 'task.requested', 's-claude'), (t += 1_000));
  assert.equal(noteSessionAccess(h, ev('claude', 'turn.failed', 's-claude', { payload: { accessSignal: { port: 'claude', channel: 'structured', errorType: 'billing_error' } } }), (t += 1_000)), 'ACCESS_QUEUED');
  assert.equal(noteSessionAccess(h, ev('claude', 'turn.stopped', 's-claude'), (t += 1_000)), null);
  await drainSessionAccess();
  assert.deepEqual(await pauses(h), [['claude', 'credit-exhausted']]);
  noteSessionAccess(h, ev('claude', 'task.requested', 's-claude'), (t += 60_000));
  assert.equal(noteSessionAccess(h, ev('claude', 'turn.stopped', 's-claude'), (t += 60_000)), 'ACCESS_SUCCESS_QUEUED');
  await drainSessionAccess();
  assert.deepEqual(await pauses(h), []);
});

test('R71: a stop that carries a signal (Antigravity\'s Stop on an error) is recorded like a failed turn and clears nothing; a plain Claude stop still clears', async () => {
  const h = home();
  let t = NOW;
  noteSessionAccess(h, ev('antigravity', 'session.started', 's-agy', { model: 'gemini-3-pro' }), (t += 1_000));
  noteSessionAccess(h, ev('antigravity', 'task.requested', 's-agy'), (t += 1_000));
  const signal = { port: 'antigravity', channel: 'error-text', text: { pattern: 'G1', weekly: false, family: null, resetAtMs: null, resetForm: null } };
  assert.equal(noteSessionAccess(h, ev('antigravity', 'turn.stopped', 's-agy', { payload: { accessSignal: signal } }), (t += 1_000)), 'ACCESS_QUEUED');
  await drainSessionAccess();
  assert.deepEqual(await pauses(h), [['antigravity', 'usage-window']]);
  // Nothing else in that turn: the next plain stop is a later turn's, and clears it (see the Antigravity test below).
  // Claude: a stop with a signal records; after a new prompt, a plain stop clears.
  noteSessionAccess(h, ev('claude', 'session.started', 's-cl', { model: 'claude-opus-5-5[1m]' }), (t += 1_000));
  noteSessionAccess(h, ev('claude', 'task.requested', 's-cl'), (t += 1_000));
  assert.equal(noteSessionAccess(h, ev('claude', 'turn.stopped', 's-cl', { payload: { accessSignal: { port: 'claude', channel: 'structured', errorType: 'billing_error' } } }), (t += 1_000)), 'ACCESS_QUEUED');
  assert.equal(noteSessionAccess(h, ev('claude', 'turn.stopped', 's-cl'), (t += 1_000)), null, 'the failed turn clears nothing');
  await drainSessionAccess();
  assert.deepEqual((await pauses(h)).sort(), [['antigravity', 'usage-window'], ['claude', 'credit-exhausted']]);
  noteSessionAccess(h, ev('antigravity', 'turn.stopped', 's-agy'), (t += 1_000));
  noteSessionAccess(h, ev('claude', 'task.requested', 's-cl'), (t += 60_000));
  assert.equal(noteSessionAccess(h, ev('claude', 'turn.stopped', 's-cl'), (t += 60_000)), 'ACCESS_SUCCESS_QUEUED', 'a plain stop of a later turn is a success');
  await drainSessionAccess();
  assert.deepEqual(await pauses(h), []);
});

test('R71: Antigravity (no prompt event): an error Stop (errored, F fac99271) is a failed turn whether or not it carries a signal; the clean stop of a later turn is a success and clears the pause', async () => {
  const h = home();
  let t = NOW;
  const signal = { port: 'antigravity', channel: 'error-text', text: { pattern: 'G1', weekly: false, family: null, resetAtMs: null, resetForm: null } };
  noteSessionAccess(h, ev('antigravity', 'session.started', 's-g', { model: 'gemini-3-pro' }), (t += 1_000));
  // An error Stop with a signal: recorded, and it is no success.
  assert.equal(noteSessionAccess(h, ev('antigravity', 'turn.stopped', 's-g', { payload: { errored: true, accessSignal: signal } }), (t += 1_000)), 'ACCESS_QUEUED');
  // An error Stop with no signal (an error that is not an access limit): records nothing, clears nothing.
  assert.equal(noteSessionAccess(h, ev('antigravity', 'turn.stopped', 's-g', { payload: { errored: true } }), (t += 60_000)), null);
  await drainSessionAccess();
  assert.deepEqual(await pauses(h), [['antigravity', 'usage-window']]);
  // A subagent's stop is not the session's success.
  assert.equal(noteSessionAccess(h, ev('antigravity', 'turn.stopped', 's-g', { agentId: 'sub-1' }), (t += 60_000)), null);
  // The next clean stop ends a later turn: a success.
  assert.equal(noteSessionAccess(h, ev('antigravity', 'turn.stopped', 's-g'), (t += 60_000)), 'ACCESS_SUCCESS_QUEUED');
  await drainSessionAccess();
  assert.deepEqual(await pauses(h), []);
});

test('R71: a made model switch (PostModelSwitch, model.changed) moves the session\'s scope; a requested one (PreModelSwitch) never does', async () => {
  const h = home();
  let t = NOW;
  const rate = { port: 'claude', channel: 'structured', errorType: 'rate_limit' };
  noteSessionAccess(h, ev('claude', 'session.started', 's-sw', { model: 'claude-opus-5-5' }), (t += 1_000));
  noteSessionAccess(h, ev('claude', 'model.change.requested', 's-sw', { payload: { fromModel: 'claude-opus-5-5', toModel: 'claude-sonnet-5' } }), (t += 1_000));
  noteSessionAccess(h, ev('claude', 'task.requested', 's-sw'), (t += 1_000));
  assert.equal(noteSessionAccess(h, ev('claude', 'turn.failed', 's-sw', { payload: { accessSignal: rate } }), (t += 1_000)), 'ACCESS_QUEUED');
  await drainSessionAccess();
  let entries = (await readAccessLimits(h)).entries;
  assert.deepEqual(entries.map((e) => e.scope.modelId), ['claude-opus-5-5'], 'a refused or pending switch leaves the scope on the session model');
  noteSessionAccess(h, ev('claude', 'model.changed', 's-sw', { payload: { fromModel: 'claude-opus-5-5', toModel: 'claude-sonnet-5' } }), (t += 1_000));
  noteSessionAccess(h, ev('claude', 'task.requested', 's-sw'), (t += 1_000));
  assert.equal(noteSessionAccess(h, ev('claude', 'turn.failed', 's-sw', { payload: { accessSignal: rate } }), (t += 1_000)), 'ACCESS_QUEUED');
  await drainSessionAccess();
  entries = (await readAccessLimits(h)).entries;
  assert.deepEqual(entries.map((e) => e.scope.modelId).sort(), ['claude-opus-5-5', 'claude-sonnet-5'], 'after the switch, the new model is paused');
});

test('OP-4: a session\'s text signal is trusted only when access.session is certified at the version the session forwarded; another version or no record holds it as a timed window', async () => {
  const asked = [];
  setCertificationGate(async (q) => (asked.push([q.harness, q.featureId, q.harnessVersion ?? null]), { certified: q.harness === 'claude' && q.featureId === 'access.session' && q.harnessVersion === '2.1.300', reasonCode: null }));
  const credit = { port: 'claude', channel: 'error-text', text: { pattern: 'C2', weekly: false, family: null, resetAtMs: null, resetForm: null } };
  const failTurn = async (version) => {
    const h = home();
    noteSessionAccess(h, ev('claude', 'session.started', 's-c', { model: 'claude-sonnet-5' }), NOW);
    const context = version === undefined ? {} : { harnessVersion: version };
    assert.equal(noteSessionAccess(h, ev('claude', 'turn.failed', 's-c', { payload: { accessSignal: credit } }), NOW + 1_000, context), 'ACCESS_QUEUED');
    await drainSessionAccess();
    return (await readAccessLimits(h)).entries.map((e) => [e.class, e.untilMs === null, e.resetBasis]);
  };
  try {
    assert.deepEqual(await failTurn('2.1.300'), [['credit-exhausted', true, 'none']], 'certified: untimed');
    assert.deepEqual(await failTurn('2.1.301'), [['usage-window', false, 'rule']], 'the same payload at another version: a timed window on the rule');
    assert.deepEqual(await failTurn(undefined), [['usage-window', false, 'rule']], 'no forwarded version and none installed: timed');
    assert.deepEqual(asked, [['claude', 'access.session', '2.1.300'], ['claude', 'access.session', '2.1.301'], ['claude', 'access.session', null]]);
  } finally {
    setCertificationGate(null);
  }
});

test('OP-11: a session\'s usage window with no reported reset is timed from its workspace\'s limitCooldownHours', async () => {
  const h = home();
  assert.equal((await saveLearningState(h, emptyLearningState({ workspaceId: 'ws-cool', now: new Date(NOW).toISOString(), settings: { limitCooldownHours: 0.5 } }))).ok, true);
  const window = { port: 'antigravity', channel: 'error-text', text: { pattern: 'G1', weekly: false, family: null, resetAtMs: null, resetForm: null } };
  noteSessionAccess(h, ev('antigravity', 'session.started', 's-w', { model: 'gemini-3-pro' }), NOW);
  noteSessionAccess(h, ev('antigravity', 'turn.failed', 's-w', { payload: { accessSignal: window } }), NOW + 1_000, { workspaceId: 'ws-cool' });
  await drainSessionAccess();
  assert.deepEqual((await readAccessLimits(h)).entries.map((e) => e.untilMs - (NOW + 1_000)), [30 * 60_000]);
  // Another workspace with no learning state: core's 5 h.
  const g = home();
  noteSessionAccess(g, ev('antigravity', 'session.started', 's-w', { model: 'gemini-3-pro' }), NOW);
  noteSessionAccess(g, ev('antigravity', 'turn.failed', 's-w', { payload: { accessSignal: window } }), NOW + 1_000, { workspaceId: 'ws-none' });
  await drainSessionAccess();
  assert.deepEqual((await readAccessLimits(g)).entries.map((e) => e.untilMs - (NOW + 1_000)), [5 * 3_600_000]);
});

// VER-05 (SSOT §10.5, US23): the first stop on an unchanged missing-evidence condition continues
// once where the harness's Stop can block (Claude Code and Codex: `{"decision":"block","reason"}`),
// only for a certified reminder from D's completion subscriber. The second stop (stop_hook_active)
// gets the unverified report as a message; config maxStopContinuationsPerCondition 0 means D
// proposes no continuation, so nothing blocks. Antigravity continues through its documented
// Stop output `{"decision":"continue","reason"}` (G6, owner decision DOMAINS 9d6a66d) on a first
// execution attempt only. Kilo and OpenCode cannot block a stop and stay message-only. The reason
// names only the missing evidence ids.
import test from 'node:test';
import assert from 'node:assert/strict';

const { runLauncher } = await import('../dist/launcher.js');
const { stillRunningText } = await import('@jevris/contracts');
const claude = await import('@jevris/adapter-claude-code');
const codex = await import('@jevris/adapter-codex');
const kilocode = await import('@jevris/adapter-kilocode');
const opencode = await import('@jevris/adapter-opencode');
const antigravity = await import('@jevris/adapter-antigravity');

const adapters = { claude, kilo: kilocode, codex, opencode, agy: antigravity };
const REMIND = 'Missing verification evidence: unit. Uncovered requirements: none. Run the declared checks (jevris verify) before finishing.';
const UNVERIFIED = 'Unverified: the work ends without current passing receipts for unit. Uncovered requirements: none. It is labelled unverified.';

async function deliver(harness, native, completion, event = null) {
  const sidecar = {
    async ensure() {
      return { ok: true, endpoint: 'fake', started: false };
    },
    async request() {
      return { ok: true, result: { recorded: true, duplicate: false, results: { completion } } };
    },
  };
  return runLauncher({ harness, event }, JSON.stringify(native), { adapters, sidecar, env: { JEVRIS_HOME: '/tmp/jevris-home' }, cwd: () => '/w/repo', nowMs: () => Date.now() }, Date.now());
}

const reminder = (over = {}) => ({ hookOutcome: { kind: 'explain', text: REMIND }, certified: false, reasonCode: 'STOP_REMINDER', stopContinuation: { text: REMIND, certified: true, missingEvidence: ['unit', 'lint'], ...over } });
const report = { hookOutcome: { kind: 'explain', text: UNVERIFIED }, certified: false, reasonCode: 'STOP_UNVERIFIED' };

for (const [harness, adapter, id] of [
  ['claude', claude, 'claude.stop'],
  ['codex', codex, 'codex.stop'],
]) {
  const base = adapter.FIXTURES.find((f) => f.id === id).native;
  const first = { ...base, stop_hook_active: false };
  const second = { ...base, stop_hook_active: true };

  test(`VER-05 ${harness}: the first stop blocks once with the evidence ids as the reason`, async () => {
    const result = await deliver(harness, first, reminder());
    assert.equal(result.reason, 'STOP_CONTINUATION');
    // The reminder the person would have seen stays beside the block.
    assert.deepEqual(JSON.parse(result.stdout), { systemMessage: REMIND, decision: 'block', reason: 'Jevris: verification evidence is missing: unit, lint. Run the declared checks (jevris verify) before finishing.' });
  });

  test(`VER-05 ${harness}: the second stop reports unverified as a message and never blocks`, async () => {
    const result = await deliver(harness, second, report);
    const rendered = adapter.protocolResponse(adapter.normalize(second).event, { kind: 'explain', text: UNVERIFIED });
    assert.equal(result.stdout, rendered);
    assert.equal(result.stdout.includes('"block"'), false);
  });

  test(`VER-05 ${harness}: stop_hook_active true never blocks, even if a continuation is proposed`, async () => {
    const result = await deliver(harness, second, reminder());
    assert.notEqual(result.reason, 'STOP_CONTINUATION');
    assert.equal(result.stdout.includes('"block"'), false);
    const unknown = { ...base };
    delete unknown.stop_hook_active;
    assert.equal((await deliver(harness, unknown, reminder())).stdout.includes('"block"'), false, 'a stop that does not say it is fresh never blocks');
  });

  test(`VER-05 ${harness}: config 0 (no continuation proposed), an uncertified one, or no usable ids never block`, async () => {
    const { stopContinuation, ...noContinuation } = reminder();
    assert.ok(stopContinuation);
    for (const completion of [noContinuation, reminder({ certified: false }), reminder({ missingEvidence: [] }), reminder({ missingEvidence: ['../../etc', 'a b'] })]) {
      const result = await deliver(harness, first, completion);
      assert.equal(result.stdout.includes('"block"'), false, JSON.stringify(completion.stopContinuation ?? null));
      assert.equal(result.stdout, adapter.protocolResponse(adapter.normalize(first).event, { kind: 'explain', text: REMIND }), 'the reminder is still shown as a message');
    }
  });

  test(`VER-05 ${harness}: a missing check still running in the background is named as running, not asked for again (US23, pair)`, async () => {
    const reasonOf = async (over) => JSON.parse((await deliver(harness, first, reminder(over))).stdout).reason;
    const missing = 'Jevris: verification evidence is missing: unit, lint.';
    // Nothing pending (or nothing usable): both are asked for, as before.
    for (const pending of [undefined, {}, { unit: 'DONE' }, { other: 'RUNNING' }, ['unit']]) {
      assert.equal(await reasonOf(pending === undefined ? {} : { pending }), `${missing} Run the declared checks (jevris verify) before finishing.`, JSON.stringify(pending ?? null));
    }
    // unit is running: its words come from the shared wording, and only lint is asked for.
    assert.equal(await reasonOf({ pending: { unit: 'RUNNING' } }), `${missing} ${stillRunningText([['unit', 'RUNNING']])} Run the declared checks for lint (jevris verify) before finishing.`);
    // Both are on their way: nothing to ask for, and stopping again ends the turn unverified.
    assert.equal(
      await reasonOf({ pending: { unit: 'RUNNING', lint: 'QUEUED' } }),
      `${missing} ${stillRunningText([['unit', 'RUNNING'], ['lint', 'QUEUED']])} Stopping again ends this turn labelled unverified.`,
    );
    assert.match(stillRunningText([['unit', 'RUNNING'], ['lint', 'QUEUED']]), /unit \(running\), lint \(queued\)/);
  });

  test(`VER-05 ${harness}: the reason carries no workspace text, only validated ids`, async () => {
    const result = await deliver(harness, first, reminder({ text: 'secret sk-live-123 from /w/repo/.env', missingEvidence: ['unit', 'sk-live-123 /w/repo/.env'] }));
    const { reason } = JSON.parse(result.stdout);
    assert.equal(reason, 'Jevris: verification evidence is missing: unit. Run the declared checks (jevris verify) before finishing.');
  });
}

test('G6 Antigravity: a first stop continues once with the evidence ids as the reason', async () => {
  const base = antigravity.FIXTURES.find((f) => f.id === 'antigravity.stop').native;
  const first = await deliver('agy', { ...base, executionNum: 1 }, reminder(), 'Stop');
  assert.equal(first.reason, 'STOP_CONTINUATION');
  assert.deepEqual(JSON.parse(first.stdout), { decision: 'continue', reason: 'Jevris: verification evidence is missing: unit, lint. Run the declared checks (jevris verify) before finishing.' });
  const running = await deliver('agy', { ...base, executionNum: 1 }, reminder({ pending: { unit: 'RUNNING' } }), 'Stop');
  assert.match(JSON.parse(running.stdout).reason, /unit \(running\)/);
});

test('G6 Antigravity: a later execution attempt, background work, an error or the step limit never continue', async () => {
  const base = antigravity.FIXTURES.find((f) => f.id === 'antigravity.stop').native;
  const { executionNum: _n, ...unnumbered } = base;
  for (const native of [
    { ...base, executionNum: 2 },
    unnumbered,
    { ...base, executionNum: 0 },
    { ...base, fullyIdle: false },
    { ...base, terminationReason: 'error', error: 'boom' },
    { ...base, terminationReason: 'max_steps_exceeded' },
  ]) {
    const result = await deliver('agy', native, reminder(), 'Stop');
    assert.notEqual(result.reason, 'STOP_CONTINUATION', JSON.stringify(native));
    assert.deepEqual(JSON.parse(result.stdout), { decision: 'stop' }, 'the stop proceeds');
  }
  for (const completion of [reminder({ certified: false }), reminder({ missingEvidence: ['a b'] })]) {
    assert.deepEqual(JSON.parse((await deliver('agy', base, completion, 'Stop')).stdout), { decision: 'stop' });
  }
});

test('VER-05: Kilo and OpenCode cannot block a stop and stay message-only', async () => {
  for (const [harness, native, event] of [
    ['kilo', { event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } }, null],
    ['opencode', { event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } }, null],
  ]) {
    assert.equal(adapters[harness].stopContinuationResponse, undefined, harness);
    const result = await deliver(harness, native, reminder(), event);
    assert.notEqual(result.reason, 'STOP_CONTINUATION', harness);
    assert.equal(result.stdout.includes('"block"'), false, harness);
  }
});

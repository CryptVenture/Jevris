import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from '../../../test/acceptance/lib.mjs';
import { startJevStub } from '../../../test/acceptance/jev-stub.mjs';
import { managedHostSkip } from '../../../test/managed-host.mjs';
import { DEADLINE_ATTEMPTS, NOT_REPEATED_OPS, askSidecar, askSidecarCounted, cutShort, freshDelivery, waitUntilQuiet } from '../scripts/sidecar-ask.mjs';

// The helper that asks a spawned sidecar again when it cut the call short (DEADLINE on a slow host): which answers count as
// cut short, how often and when it asks again, what it waits for between attempts, and, against a real sidecar whose journal
// writes are held up, that a call which the sidecar really answers DEADLINE is answered on the next attempt.

const deadline = { ok: false, reason: 'rejected', reasonCode: 'DEADLINE', message: 'The sidecar could not answer inside the deadline; this call ran rules-only.' };
const answered = { ok: true, result: { advice: 'x' } };

/** A client that answers from a script, one answer per request, and records what it was asked. */
function scripted(answers) {
  const asked = [];
  return {
    asked,
    async sidecarRequest(request) {
      asked.push(request);
      const next = answers.shift();
      assert.notEqual(next, undefined, `the client was asked ${String(asked.length)} times, more than the script has answers`);
      return next;
    },
  };
}

test('only a cut-short answer counts as cut short: DEADLINE and a client timeout, never another refusal or a cancel', () => {
  assert.equal(cutShort(deadline), true);
  for (const reasonCode of ['TIMEOUT', 'CONNECT_TIMEOUT', 'HANDSHAKE_TIMEOUT']) assert.equal(cutShort({ ok: false, reason: 'timeout', reasonCode }), true, reasonCode);
  assert.equal(cutShort({ ok: false, reason: 'timeout', reasonCode: 'ABORTED' }), false, 'a call the caller cancelled is not retried');
  for (const reasonCode of ['BUSY', 'KILL_SWITCH', 'SCOPE_DENIED', 'UNKNOWN_OP', 'MALFORMED', 'STORE_UNAVAILABLE']) assert.equal(cutShort({ ok: false, reason: 'rejected', reasonCode }), false, reasonCode);
  assert.equal(cutShort({ ok: false, reason: 'unavailable', reasonCode: 'NOT_RUNNING' }), false);
  assert.equal(cutShort({ ok: false, reason: 'refused', reasonCode: 'SERVER_UNPROVEN' }), false);
  assert.equal(cutShort(answered), false);
  assert.equal(cutShort(null), false);
  assert.equal(cutShort(undefined), false);
});

test('an answer is returned at once, with one attempt and no wait', async () => {
  const client = scripted([answered]);
  const settled = [];
  const out = await askSidecarCounted(client, { op: 'capability.advise', home: 'h' }, { settle: async () => settled.push(1) });
  assert.deepEqual(out, { answer: answered, attempts: 1 });
  assert.equal(client.asked.length, 1);
  assert.deepEqual(settled, []);
});

test('a refusal that is not a cut-short call is returned at once, however many attempts are allowed', async () => {
  for (const refusal of [{ ok: false, reason: 'rejected', reasonCode: 'BUSY' }, { ok: false, reason: 'rejected', reasonCode: 'KILL_SWITCH' }, { ok: false, reason: 'unavailable', reasonCode: 'NOT_RUNNING' }, { ok: false, reason: 'timeout', reasonCode: 'ABORTED' }]) {
    const client = scripted([refusal]);
    const out = await askSidecarCounted(client, { op: 'capability.advise', home: 'h' }, { attempts: 5, settle: async () => assert.fail('waited for a refusal that was not a cut-short call') });
    assert.equal(out.answer, refusal);
    assert.equal(out.attempts, 1);
    assert.equal(client.asked.length, 1);
  }
});

test('a cut-short call is asked again after the sidecar has settled, with the same request, and the answer is the one that follows', async () => {
  const client = scripted([deadline, { ok: false, reason: 'timeout', reasonCode: 'TIMEOUT' }, answered]);
  const log = [];
  const request = { op: 'capability.advise', scope: 'mcp', home: 'h', workspace: 'w', body: { capabilityId: 'C32' }, timeoutMs: 20_000 };
  const out = await askSidecarCounted(client, request, {
    settle: async (sidecar, asked) => {
      assert.equal(sidecar, client);
      assert.equal(asked, request);
      log.push(`settled after ${String(client.asked.length)}`);
    },
  });
  assert.deepEqual(out, { answer: answered, attempts: 3 });
  assert.deepEqual(log, ['settled after 1', 'settled after 2']);
  for (const asked of client.asked) assert.equal(asked, request, 'a retry sent a different request');
});

test('a product that never answers in time still fails: the last answer comes back after the bound, with its own reason code', async () => {
  const client = scripted(Array.from({ length: DEADLINE_ATTEMPTS }, () => ({ ...deadline })));
  let settles = 0;
  const out = await askSidecarCounted(client, { op: 'capability.advise', home: 'h' }, { settle: async () => (settles += 1) });
  assert.equal(out.attempts, DEADLINE_ATTEMPTS);
  assert.equal(out.answer.ok, false);
  assert.equal(out.answer.reasonCode, 'DEADLINE');
  assert.equal(client.asked.length, DEADLINE_ATTEMPTS);
  assert.equal(settles, DEADLINE_ATTEMPTS - 1, 'it waits between attempts, not after the last');
  assert.equal(DEADLINE_ATTEMPTS, 4);
});

test('attempts: 1 is a single attempt, and plan.submit, which records its tasks, is never asked twice', async () => {
  const once = scripted([deadline]);
  assert.deepEqual(await askSidecarCounted(once, { op: 'capability.advise', home: 'h' }, { attempts: 1, settle: async () => assert.fail('waited with a single attempt') }), { answer: deadline, attempts: 1 });
  assert.deepEqual([...NOT_REPEATED_OPS], ['plan.submit']);
  const client = scripted([deadline]);
  const out = await askSidecarCounted(client, { op: 'plan.submit', home: 'h' }, { attempts: 4, settle: async () => assert.fail('plan.submit was repeated') });
  assert.equal(out.attempts, 1);
  assert.equal(client.asked.length, 1);
});

test('an answer that came but is not what the caller needs is asked again, within the same bound, and a refusal is never judged', async () => {
  const thin = { ok: true, result: { source: 'rules' } };
  const full = { ok: true, result: { source: 'jev' } };
  const seen = [];
  const client = scripted([thin, thin, full]);
  const out = await askSidecarCounted(client, { op: 'capability.advise', home: 'h' }, {
    satisfied: async (answer) => {
      seen.push(answer.result.source);
      return answer.result.source === 'jev';
    },
    settle: async (_client, _request, answer, attempt) => assert.deepEqual([answer, attempt <= 2], [thin, true]),
  });
  assert.deepEqual(out, { answer: full, attempts: 3 });
  assert.deepEqual(seen, ['rules', 'rules', 'jev']);

  // A call that never does what is needed stops at the bound, with the last answer, as it did the first time.
  const never = scripted(Array.from({ length: DEADLINE_ATTEMPTS }, () => ({ ...thin })));
  const stuck = await askSidecarCounted(never, { op: 'capability.advise', home: 'h' }, { satisfied: () => false, settle: async () => undefined });
  assert.equal(stuck.attempts, DEADLINE_ATTEMPTS);
  assert.equal(stuck.answer.ok, true);
  assert.equal(never.asked.length, DEADLINE_ATTEMPTS);

  // A refusal that is not a cut-short call is returned at once: `satisfied` judges answers, not refusals.
  const refused = scripted([{ ok: false, reason: 'rejected', reasonCode: 'KILL_SWITCH' }]);
  const out2 = await askSidecarCounted(refused, { op: 'capability.advise', home: 'h' }, { satisfied: () => assert.fail('a refusal was judged'), settle: async () => assert.fail('waited for a refusal') });
  assert.equal(out2.attempts, 1);
});

test('a hook event that is asked again is sent as a fresh delivery: the same key would be answered with the duplicate answer', async () => {
  const event = { op: 'event', scope: 'hook', home: 'h', workspace: 'w', timeoutMs: 20_000, body: { deliveryKey: 'dk-1', harnessVersion: '2.1.278', envelope: { kind: 'session.started', sessionId: 's1', dedupKey: 'dk-1' } } };
  const before = JSON.stringify(event);
  const second = freshDelivery(event, 2);
  const third = freshDelivery(event, 3);
  assert.equal(JSON.stringify(event), before, 'the request was changed in place');
  assert.match(second.body.deliveryKey, /^[0-9a-f]{64}$/);
  assert.notEqual(second.body.deliveryKey, 'dk-1');
  assert.equal(second.body.envelope.dedupKey, second.body.deliveryKey, 'the envelope and the delivery key were one key and stay one');
  assert.notEqual(third.body.deliveryKey, second.body.deliveryKey, 'two attempts share a key');
  assert.equal(freshDelivery(event, 2).body.deliveryKey, second.body.deliveryKey, 'the key of an attempt is not repeatable');
  assert.deepEqual([second.body.harnessVersion, second.body.envelope.kind, second.body.envelope.sessionId, second.scope, second.workspace], ['2.1.278', 'session.started', 's1', 'hook', 'w']);
  // Not an event, or an event with no delivery key: returned as it is.
  const advise = { op: 'capability.advise', home: 'h', body: { deliveryKey: 'x' } };
  assert.equal(freshDelivery(advise, 2), advise);
  const bare = { op: 'event', home: 'h', body: { envelope: {} } };
  assert.equal(freshDelivery(bare, 2), bare);

  // Through the helper: a cut-short event is sent again under a key of its own, and the answer after it is returned.
  const client = scripted([deadline, answered]);
  const out = await askSidecarCounted(client, event, { settle: async () => undefined });
  assert.equal(out.attempts, 2);
  assert.equal(client.asked[0], event);
  assert.equal(client.asked[1].body.deliveryKey, second.body.deliveryKey);
});

test('askSidecar gives the answer alone, in the shape sidecarRequest returns', async () => {
  const client = scripted([deadline, answered]);
  assert.deepEqual(await askSidecar(client, { op: 'status', home: 'h' }, { settle: async () => undefined }), answered);
});

const queue = (fields = {}) => ({ hotInFlight: 0, backgroundInFlight: 1, overrun: 0, running: 0, held: 0, queued: 0, spooled: 0, ...fields });

test('waitUntilQuiet polls the sidecar until nothing is left to do behind an answer, and gives up at its bound', async () => {
  // Not quiet: an answered-late request whose work runs on, a job running, one held, one queued, one spooled, a client timeout,
  // and a verification run under way. Quiet: the requests being served now (the status call itself) do not count.
  const calls = [];
  const script = [
    ['status', { ok: false, reason: 'timeout', reasonCode: 'TIMEOUT' }],
    ['status', { ok: true, result: { queue: queue({ overrun: 1 }) } }],
    ['status', { ok: true, result: { queue: queue({ running: 1 }) } }],
    ['status', { ok: true, result: { queue: queue({ held: 1 }) } }],
    ['status', { ok: true, result: { queue: queue({ queued: 2 }) } }],
    ['status', { ok: true, result: { queue: queue({ spooled: 1 }) } }],
    ['status', { ok: true, result: { queue: queue({ hotInFlight: 2, backgroundInFlight: 3 }) } }],
    ['health', { ok: true, result: { verificationRuns: 1 } }],
    ['status', { ok: true, result: { queue: queue() } }],
    ['health', { ok: true, result: { verificationRuns: 0 } }],
  ];
  const client = {
    async sidecarRequest(request) {
      calls.push(request);
      const [op, answer] = script.shift();
      assert.equal(request.op, op, `the ${String(calls.length)}th call`);
      return answer;
    },
  };
  const pauses = [];
  const quiet = await waitUntilQuiet(client, { home: 'the-home', workspace: 'the-work', op: 'event' }, { pause: async (ms) => pauses.push(ms) });
  assert.equal(quiet, true);
  assert.deepEqual(script, []);
  assert.equal(pauses.length, 7, 'one pause after each poll that found the sidecar busy');
  for (const asked of calls) assert.deepEqual([asked.home, asked.workspace, asked.scope], ['the-home', 'the-work', 'cli']);

  // A sidecar that stays busy: the wait ends at the bound and says so; the next attempt is made anyway.
  let clock = 0;
  const busy = { async sidecarRequest() { return { ok: true, result: { queue: queue({ overrun: 1 }) } }; } };
  const stuck = await waitUntilQuiet(busy, { home: 'h' }, { boundMs: 1000, pollMs: 300, now: () => clock, pause: async (ms) => (clock += ms) });
  assert.equal(stuck, false);
  assert.ok(clock >= 1000);

  // A status with no queue (a sidecar that does not report one) and no workspace in the request.
  const bare = { async sidecarRequest(request) { assert.equal(Object.hasOwn(request, 'workspace'), false); return { ok: true, result: request.op === 'health' ? {} : {} }; } };
  assert.equal(await waitUntilQuiet(bare, { home: 'h' }), true);
});

test('the part B ops ask again for the calls they make themselves, when they are given attempts', async () => {
  const { wrapSidecar } = await import('../scripts/jev-feature-cases-b.mjs');
  const seen = [];
  let listed = 0;
  const fake = {
    async sidecarRequest(request) {
      seen.push(request.op);
      if (request.op === 'capability.advise') {
        listed += 1;
        // The first listing is cut short; the second says there is nothing open.
        return listed === 1 ? deadline : { ok: true, result: { ranked: [] } };
      }
      return { ok: true, result: { queue: queue(), verificationRuns: 0 } };
    },
  };
  const wrapped = wrapSidecar(fake, { attempts: DEADLINE_ATTEMPTS });
  const out = await wrapped.sidecarRequest({ op: 'caseB.cancel-open-tasks', home: 'h', workspace: 'w', body: {} });
  assert.deepEqual(out, { ok: true, result: { cancelled: 0 } });
  assert.deepEqual(seen, ['capability.advise', 'status', 'health', 'capability.advise']);
  // Without attempts (the live suite) the cut-short listing fails the op as it always did.
  seen.length = 0;
  listed = 0;
  const single = await wrapSidecar(fake).sidecarRequest({ op: 'caseB.cancel-open-tasks', home: 'h', workspace: 'w', body: {} });
  assert.equal(single.ok, false);
  assert.equal(single.reasonCode, 'CASE_B_OP_FAILED');
  assert.deepEqual(seen, ['capability.advise']);
});

// ----------------------------------------------------------------------------- a real sidecar

/**
 * A preload for the sidecar process: while the flag file exists, every fsync and rename of the decision journal, the budget file
 * and the circuit file waits `ms`, the way a loaded runner's scanner holds them. A cold Jev decision makes eight such writes in a
 * row, so with each held up for 1.5 s it cannot finish inside the 5 s a background op has, on any host.
 */
const STALL = (flag, ms) => `
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { syncBuiltinESMExports } = require('node:module');
const TARGET = /(?:[\\\\/]decisions[\\\\/]|decision-budget|jev-circuit)/;
const wait = () => (fs.existsSync(${JSON.stringify(flag)}) ? new Promise((resolve) => setTimeout(resolve, ${String(ms)})) : Promise.resolve());
const open = fsp.open;
fsp.open = async function (...args) {
  const handle = await open.apply(this, args);
  if (TARGET.test(String(args[0]))) {
    const sync = handle.sync.bind(handle);
    handle.sync = async () => { await wait(); return sync(); };
  }
  return handle;
};
const rename = fsp.rename;
fsp.rename = async function (from, to) {
  if (TARGET.test(String(to))) await wait();
  return rename.call(this, from, to);
};
syncBuiltinESMExports();
`;

test('against a real sidecar an idle sidecar reads as quiet; and a call it really cuts short is answered on the next attempt, once the disk is back', { skip: managedHostSkip(), timeout: 600_000 }, async (t) => {
  const stub = await startJevStub(t, { scenario: 'confident' });
  // The held-up writes must outlast the sidecar's budget, so the sidecar keeps the product's exact budgets whatever scale the runner sets (test/budget-scale.mjs).
  const box = await sandbox(t, { env: stub.env, exactBudgets: true });
  const flag = join(box.dir, 'stall.flag').replace(/\\/g, '/');
  const preload = join(box.dir, 'stall-journal.cjs').replace(/\\/g, '/');
  writeFileSync(preload, STALL(flag, 1500));
  // The sandbox's environment is the one the CLI hands the sidecar it starts, so the preload goes into it before the start.
  box.env.NODE_OPTIONS = `${box.env.NODE_OPTIONS ?? ''} --require "${preload}"`.trim();
  const started = box.startSidecar();
  assert.equal(started.code, 0, `the sidecar did not start: ${started.stdout} ${started.stderr}`);
  const sidecar = await import('../dist/index.js');
  const request = { home: box.home, op: 'capability.advise', scope: 'mcp', workspace: box.work, body: { capabilityId: 'C32', input: { harness: 'claude', collaborative: false } }, timeoutMs: 60_000 };

  // Nothing is held up yet: the sidecar is quiet, which the helper reads from its status and health.
  assert.equal(await waitUntilQuiet(sidecar, request), true, 'an idle sidecar did not read as quiet');

  // The journal writes are held up: a cold decision cannot finish inside the sidecar's budget, so the first attempt is answered
  // DEADLINE. Between the attempts the disk comes back (the flag goes), the helper waits until the abandoned work has ended, and the
  // sidecar answers the second attempt, from Jev (the stub).
  writeFileSync(flag, 'go\n');
  const cut = [];
  const out = await askSidecarCounted(sidecar, request, {
    settle: async (client, asked, answer, attempt) => {
      cut.push({ attempt, reason: answer.reason, reasonCode: answer.reasonCode });
      rmSync(flag, { force: true });
      assert.equal(await waitUntilQuiet(client, asked), true, 'the abandoned work of the cut-short attempt never ended');
    },
  });
  t.diagnostic(`attempts ${String(out.attempts)}, ok ${String(out.answer.ok)}, source ${String(out.answer.result?.source)}`);
  assert.deepEqual(cut, [{ attempt: 1, reason: 'rejected', reasonCode: 'DEADLINE' }], 'the held-up writes did not make the sidecar answer DEADLINE once');
  assert.equal(out.attempts, 2);
  assert.equal(out.answer.ok, true, JSON.stringify(out.answer));
  assert.equal(out.answer.result.source, 'jev', `answered from ${String(out.answer.result.source)}`);
  assert.equal(await waitUntilQuiet(sidecar, request), true);
  assert.equal(box.stopSidecar().code, 0);
});

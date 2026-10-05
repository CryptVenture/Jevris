// A waiting advice line that an event could not show stays held until an event does show it (JEV-0062).
//
// The line is held in the sidecar's memory for ten minutes, per session (docs/settings.md). The
// decision subscriber hands it to an event that can show it and takes it off the queue only when
// that answer is used. Each subscriber answers on its own and the launcher then picks what to render:
// a certified context outcome (the orientation line a Kilo or OpenCode session gets with its first
// message) outranks an explain. The line used to be taken at the subscriber, before the launcher
// dropped it, so it was lost. Now the subscriber hands the take to the sidecar, which runs it after
// every subscriber has answered and only when an explain is what will be shown.
//
// Through a real sidecar and the real hook launcher in a sandbox (temporary home, no keychain, no
// Jev: the rules settle an equal failure), with this machine's Kilo Code hooks certified in the
// sandbox the way `jevris certify` leaves them (test/acceptance/certified-hooks.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from '../../../test/acceptance/lib.mjs';
import { certifyHooks } from '../../../test/acceptance/certified-hooks.mjs';
import { managedHostSkip } from '../../../test/managed-host.mjs';

const VERSION = '7.8.1';
const ORIENTATION = /Jevris is on here \(mode: /;
const FAILURE_LINE = /this failure has come back 2 times; the next most useful evidence is /;
let seq = 0;
const uid = () => `${process.pid}-${(seq += 1)}`;

const plugin = {
  bashFailure: (sid, command) => ({ hookKey: 'tool.execute.after', input: { tool: 'bash', sessionID: sid, callID: `call_${uid()}`, args: { command } }, output: { title: command, output: 'FAIL src/a.test.js', metadata: { exit: 1 } }, harnessVersion: VERSION }),
  sessionCreated: (sid) => ({ hookKey: 'event', event: { type: 'session.created', properties: { info: { id: sid } } }, harnessVersion: VERSION }),
  chat: (sid, text, messageId = `msg_${uid()}`) => ({ hookKey: 'chat.message', input: { sessionID: sid, agent: 'build', model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' }, messageID: messageId }, output: { message: {}, parts: [{ type: 'text', text }] }, harnessVersion: VERSION }),
};

/** The lines a Kilo or OpenCode answer adds to the system prompt. */
function linesOf(hook) {
  assert.equal(hook.code, 0, `the hook exited ${hook.code}: ${hook.stderr}`);
  assert.doesNotMatch(hook.reason ?? '', /DEADLINE|TIMEOUT/, `the hook ran out of time (${hook.reason}): the machine is too loaded for the 4 s hook deadline`);
  if (hook.stdout.trim() === '') return [];
  const json = JSON.parse(hook.stdout);
  assert.deepEqual(Object.keys(json), ['system'], `Kilo and OpenCode take advice on the system prompt only: ${hook.stdout}`);
  return json.system.flatMap((line) => String(line).split('\n').filter(Boolean));
}

const SLOW = { extraEnv: { JEVRIS_HOOK_DEADLINE_MS: '4000' } };

for (const [launcher, harness] of [['kilo', 'kilocode'], ['opencode', 'opencode']]) {
  test(`${launcher}: a repeated-failure line that lost its message to the orientation context is shown at the next message, once`, { timeout: 120_000, skip: managedHostSkip() }, async (t) => {
    const box = await sandbox(t);
    assert.equal(box.startSidecar().code, 0, 'the sidecar did not start');
    await certifyHooks(box, { harness, version: VERSION });
    const send = (native) => box.hook(launcher, native, SLOW);
    const sid = `ctx-${launcher}-${uid()}`;
    const command = `npm run held-${uid()}`;

    // The same failure twice: a tool event cannot show a line here, so the line waits for a message.
    for (let i = 0; i < 2; i += 1) assert.deepEqual(linesOf(send(plugin.bashFailure(sid, command))), []);
    // A new session's orientation is held for its first message, where it will be the context.
    assert.deepEqual(linesOf(send(plugin.sessionCreated(sid))), []);

    const first = linesOf(send(plugin.chat(sid, 'where are we with this work now')));
    assert.equal(first.length, 1, `the first message shows the context alone: ${JSON.stringify(first)}`);
    assert.match(first[0], ORIENTATION, 'a certified context outranks the explain');

    // The line the context outranked was not shown, so it is still held: the next message shows it.
    const messageId = `msg_${uid()}`;
    const second = send(plugin.chat(sid, 'and what about the next step here', messageId));
    assert.deepEqual(linesOf(second).filter((line) => FAILURE_LINE.test(line)).length, 1, `the line is shown at the next message: ${second.stdout}`);
    assert.doesNotMatch(second.stdout, /Jevris is on here/, 'the orientation was sent once');

    // A line shown once is not shown again, by a later message or by a redelivery of the message that showed it.
    assert.deepEqual(linesOf(send(plugin.chat(sid, 'one more thing about this'))), [], 'shown once');
    const replay = send(plugin.chat(sid, 'and what about the next step here', messageId));
    assert.equal(replay.reason, 'DUPLICATE_REPLAYED', replay.stderr);
    assert.deepEqual(linesOf(replay).filter((line) => FAILURE_LINE.test(line)).length, 1, 'a redelivery gets the answer the first delivery got');
    assert.deepEqual(linesOf(send(plugin.chat(sid, 'a last message here'))), [], 'and the redelivery took nothing again');
  });
}

test('kilo: the waiting line and the orchestrator\'s own loop advice both wait out the orientation message, and come together at the next one, in subscriber-name order', { timeout: 120_000, skip: managedHostSkip() }, async (t) => {
  const box = await sandbox(t);
  assert.equal(box.startSidecar().code, 0, 'the sidecar did not start');
  await certifyHooks(box, { harness: 'kilocode', version: VERSION });
  const send = (native) => box.hook('kilo', native, SLOW);
  const sid = `two-${uid()}`;
  const command = `npm run two-lines-${uid()}`;
  // The same bash failure four times: the repeated-failure line, and the orchestrator's once-only line that the loop earns.
  for (let i = 0; i < 4; i += 1) assert.deepEqual(linesOf(send(plugin.bashFailure(sid, command))), []);
  assert.deepEqual(linesOf(send(plugin.sessionCreated(sid))), []);

  const first = linesOf(send(plugin.chat(sid, 'where are we with this work now')));
  assert.deepEqual(first.filter((line) => !ORIENTATION.test(line)), [], `the first message shows the context alone: ${JSON.stringify(first)}`);

  const second = linesOf(send(plugin.chat(sid, 'and what about the next step here')));
  assert.equal(second.length, 2, `both lines come at the next message: ${JSON.stringify(second)}`);
  assert.match(second[0], /^Jevris: this failure has come back \d+ times/, 'the decision engine\'s line first');
  assert.doesNotMatch(second[1], /come back/, 'then the orchestrator\'s');
  assert.deepEqual(linesOf(send(plugin.chat(sid, 'one more thing about this'))), [], 'each is shown once');
});

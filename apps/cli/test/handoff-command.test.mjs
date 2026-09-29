// Owner decision 29423b6 (coordinator's approval): `jevris handoff import <capsule.json> [--link]`
// runs the MCP tool's handoff.import on the CLI key; --link then links the session working on
// the capsule's task through the shared route-link code (B's session.link). The link needs a
// person at a terminal, checked before the import. Fake sidecar ports only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.JEVRIS_SIDECAR_AUTOSTART = '0';

const { runHandoffCommand, HANDOFF_HELP } = await import('../dist/handoff-command.js');
const { main } = await import('../dist/cli.js');

const AT = Date.parse('2026-09-28T09:00:00Z');
const SES = 'ses_4f2a9c1b7d3e5a60';
const IMPORTED = { accepted: true, reasonCode: 'IMPORTED', capsuleId: 'cap-0123456789abcdef', facts: 2, unresolved: [], authorityGranted: false };

function sandbox(t, taskIds = ['fix-parser']) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-handoff-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const workspace = join(dir, 'repo');
  mkdirSync(home);
  mkdirSync(join(workspace, '.git'), { recursive: true });
  const capsule = join(dir, 'capsule.json');
  writeFileSync(capsule, JSON.stringify({ id: 'cap-0123456789abcdef', schemaVersion: '1.0', taskIds }));
  return { dir, home, workspace, capsule, env: { JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0', USER: 'dev' } };
}

function fakePorts(answers) {
  const calls = [];
  return {
    calls,
    ports: {
      sidecar: {
        async ensure() {
          return { ok: true, endpoint: 'fake', started: false };
        },
        async request(input) {
          calls.push(input);
          const answer = answers[input.op];
          if (answer === undefined) return { ok: false, reason: 'unavailable', reasonCode: 'NOT_RUNNING', message: 'not running' };
          return typeof answer === 'function' ? answer(input) : { ok: true, result: answer };
        },
      },
      engine: {},
      config: {},
    },
  };
}

async function run(box, argv, ports, interactive = true) {
  let text = '';
  const code = await runHandoffCommand(argv, (chunk) => (text += chunk), { ports, env: box.env, cwd: box.workspace, interactive: () => interactive });
  return { code, text, json: text.startsWith('{') ? JSON.parse(text) : null };
}

const linkedAnswer = { result: 'linked', harness: 'kilocode', sessionId: SES, taskId: 'fix-parser', lastSeenAtMs: AT, via: 'route' };

test('handoff import on the CLI key prints the import; without --link nothing is linked', async (t) => {
  const box = sandbox(t);
  const fake = fakePorts({ 'handoff.import': IMPORTED });
  const plain = await run(box, ['import', box.capsule], fake.ports, false);
  assert.equal(plain.code, 0, plain.text);
  assert.deepEqual(fake.calls.map((c) => [c.op, c.scope]), [['handoff.import', 'cli']]);
  const json = await run(box, ['import', box.capsule, '--json'], fake.ports, false);
  assert.equal(json.json.command, 'handoff import');
  assert.equal(json.json.import.result.accepted, true);
  assert.equal(json.json.link, null);
});

test('--link needs a terminal, checked before the import: nothing is imported or linked', async (t) => {
  const box = sandbox(t);
  const fake = fakePorts({ 'handoff.import': IMPORTED, 'session.link': linkedAnswer });
  const piped = await run(box, ['import', box.capsule, '--link'], fake.ports, false);
  assert.equal(piped.code, 2);
  assert.match(piped.text, /^Nothing was imported\. Not linked: .*interactive terminal/);
  assert.equal(fake.calls.length, 0);
});

test('--link imports, then links the capsule task through session.link with the terminal channel', async (t) => {
  const box = sandbox(t);
  const fake = fakePorts({ 'handoff.import': IMPORTED, 'session.link': linkedAnswer });
  const done = await run(box, ['import', box.capsule, '--link', '--harness', 'kilocode'], fake.ports);
  assert.equal(done.code, 0, done.text);
  assert.match(done.text, /^Linked: the kilocode session …7d3e5a60 \(last seen 2026-09-28 09:00 UTC\) works on task fix-parser\.$/m);
  assert.deepEqual(fake.calls.map((c) => c.op), ['handoff.import', 'session.link']);
  const body = fake.calls[1].body;
  assert.equal(body.taskId, 'fix-parser');
  assert.equal(body.channel, 'terminal');
  assert.equal(body.harness, 'kilocode');
  assert.equal(body.via, 'handoff', 'B dd06675: the link records that it came from a handoff');
  assert.equal(fake.calls[1].scope, 'cli');

  const json = await run(box, ['import', box.capsule, '--link', '--json'], fake.ports);
  assert.equal(json.json.link.result, 'linked');
  assert.equal(json.json.link.changed, true);
});

test('the task comes from the capsule: one id, or the one --task names; a capsule not accepted is never linked', async (t) => {
  const two = sandbox(t, ['fix-parser', 'add-tests']);
  const fake = fakePorts({ 'handoff.import': IMPORTED, 'session.link': (input) => ({ ok: true, result: { ...linkedAnswer, taskId: input.body.taskId } }) });
  const unclear = await run(two, ['import', two.capsule, '--link'], fake.ports);
  assert.equal(unclear.code, 2);
  assert.match(unclear.text, /names 2 tasks; choose one with --task: fix-parser, add-tests/);
  const foreign = await run(two, ['import', two.capsule, '--link', '--task', 'other'], fake.ports);
  assert.equal(foreign.code, 2);
  assert.match(foreign.text, /names no task other/);
  assert.equal(fake.calls.length, 0, 'a usage error imports nothing');
  const chosen = await run(two, ['import', two.capsule, '--link', '--task', 'add-tests'], fake.ports);
  assert.equal(chosen.code, 0, chosen.text);
  assert.equal(fake.calls.at(-1).body.taskId, 'add-tests');

  const box = sandbox(t);
  const rejected = fakePorts({ 'handoff.import': { ...IMPORTED, accepted: false, reasonCode: 'CAPSULE_EXPIRED' }, 'session.link': linkedAnswer });
  const refused = await run(box, ['import', box.capsule, '--link'], rejected.ports);
  assert.equal(refused.code, 1);
  assert.match(refused.text, /Not linked: the capsule was not accepted\./);
  assert.deepEqual(rejected.calls.map((c) => c.op), ['handoff.import']);
});

test('usage errors, and the command is reachable from jevris with its help', async (t) => {
  const box = sandbox(t);
  const quiet = fakePorts({});
  for (const argv of [['export'], ['import'], ['import', box.capsule, 'extra'], ['import', box.capsule, '--task', 'x'], ['import', box.capsule, '--link', '--harness', 'vim'], ['import', join(box.dir, 'missing.json')]]) {
    const bad = await run(box, argv, quiet.ports);
    assert.equal(bad.code, 2, argv.join(' '));
  }
  assert.equal(quiet.calls.length, 0);
  let text = '';
  const code = await main(['help', 'handoff'], (chunk) => (text += chunk));
  assert.equal(code, 0);
  assert.equal(text.trimEnd(), HANDOFF_HELP);
  assert.match(HANDOFF_HELP, /The MCP tool never\s+links/);
});

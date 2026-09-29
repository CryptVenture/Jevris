// `jevris credential reenable` (decision ea2af91a on A's R77 finding): after a billing (402) or
// account (403) refusal, a person at an interactive terminal lets Jev decide again. No --yes, no
// --json, no pipe, no test run; it asks y/N, calls nothing, never starts the sidecar and sends only
// { channel: 'terminal' } to B's jev.reenable op. A key refusal (401) stays until a new key.
// A temp home and fake sidecar ports only: nothing is started and no harness runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.JEVRIS_SIDECAR_AUTOSTART = '0';

const { runCredentialReenableCommand } = await import('../dist/credential-reenable.js');
const { main } = await import('../dist/cli.js');

async function box(t) {
  const dir = await mkdtemp(join(tmpdir(), 'jevris-reenable-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  await mkdir(home);
  return { home, cwd: dir, env: { JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0', USER: 'dev' } };
}

function fakePorts(answer) {
  const calls = [];
  const ensured = [];
  return {
    calls,
    ensured,
    ports: {
      sidecar: {
        async ensure(input) {
          ensured.push(input);
          return { ok: true, endpoint: 'fake', started: false };
        },
        async request(input) {
          calls.push(input);
          return answer;
        },
      },
      engine: {},
      config: {},
    },
  };
}

async function run(b, argv, extra = {}) {
  let text = '';
  const questions = [];
  const answerYes = extra.answer ?? true;
  const code = await runCredentialReenableCommand(argv, (chunk) => (text += chunk), {
    env: b.env,
    cwd: b.cwd,
    interactive: () => true,
    confirm: async (q) => {
      questions.push(q);
      return answerYes;
    },
    ...extra,
  });
  return { code, text, questions };
}

const cleared = (result) => ({ ok: true, result });

test('off a terminal, with --json, or in a test run it is refused before the sidecar is asked; --yes and extra arguments are usage errors', async (t) => {
  const b = await box(t);
  for (const [argv, extra] of [
    [[], { interactive: () => false }],
    [['--json'], {}],
  ]) {
    const f = fakePorts(cleared({ cleared: 'BILLING', persisted: true, audited: true }));
    const r = await run(b, argv, { ports: f.ports, ...extra });
    assert.equal(r.code, 2, argv.join(' '));
    assert.match(r.text, /^Not re-enabled \(CHANNEL_REFUSED\)/);
    assert.match(r.text, /Nothing changed\.\n$/);
    assert.equal(r.questions.length, 0);
    assert.equal(f.calls.length, 0);
  }
  const f = fakePorts(cleared({ cleared: 'BILLING', persisted: true, audited: true }));
  const testRun = await run({ ...b, env: { ...b.env, JEVRIS_TEST: '1' } }, [], { ports: f.ports });
  assert.equal(testRun.code, 2);
  assert.match(testRun.text, /CHANNEL_REFUSED/);
  assert.equal(f.calls.length, 0);

  const yes = await run(b, ['--yes'], { ports: f.ports });
  assert.equal(yes.code, 2);
  assert.match(yes.text, /has no --yes/);
  const extraArg = await run(b, ['now'], { ports: f.ports });
  assert.equal(extraArg.code, 2);
  assert.match(extraArg.text, /Unexpected argument "now"/);
  assert.equal(f.calls.length, 0);
});

test('the cli dispatches credential reenable to its own parser, and a test run is refused there too', async (t) => {
  const b = await box(t);
  let text = '';
  const code = await main(['credential', 'reenable', '--home', b.home], (chunk) => (text += chunk));
  assert.equal(code, 2);
  assert.match(text, /CHANNEL_REFUSED/);
  let help = '';
  assert.equal(await main(['credential', 'reenable', '--help'], (chunk) => (help += chunk)), 0);
  assert.match(help, /jevris credential reenable \[--home <dir>\]/);
  assert.match(help, /A refused key \(401\) is not cleared by reenable/);
});

test('a person who answers no changes nothing, and the question says nothing is called now', async (t) => {
  const b = await box(t);
  const f = fakePorts(cleared({ cleared: 'BILLING', persisted: true, audited: true }));
  const r = await run(b, [], { ports: f.ports, answer: false });
  assert.equal(r.code, 1);
  assert.equal(r.questions.length, 1);
  assert.match(r.questions[0], /Jevris calls nothing now; the next Jev call comes from ordinary use and is billed\. \[y\/N\] $/);
  assert.match(r.text, /refused billing \(402\) or the account \(403\)/);
  assert.match(r.text, /Not re-enabled\. Nothing changed\.\n$/);
  assert.equal(f.calls.length, 0);
});

test('a yes sends only the terminal channel to jev.reenable and never starts the sidecar', async (t) => {
  const b = await box(t);
  const f = fakePorts(cleared({ cleared: 'BILLING', persisted: true, audited: true }));
  const r = await run(b, [], { ports: f.ports });
  assert.equal(r.code, 0);
  assert.equal(f.ensured.length, 0);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].op, 'jev.reenable');
  assert.equal(f.calls[0].scope, 'cli');
  assert.deepEqual(f.calls[0].body, { channel: 'terminal' });
  assert.match(r.text, /Jev re-enabled after billing \(402\): Jevris observes first/);
  assert.match(r.text, /Nothing was called now\.\n$/);
  assert.doesNotMatch(r.text, /restarts|audit log/);

  const account = await run(b, [], { ports: fakePorts(cleared({ cleared: 'ACCOUNT', persisted: false, audited: false })).ports });
  assert.equal(account.code, 0);
  assert.match(account.text, /after the account \(403\)/);
  assert.match(account.text, /holds only until the sidecar restarts/);
  assert.match(account.text, /not written to the audit log/);
});

test('not disabled exits 0, a key refusal points to credential set, and a stopped sidecar changes nothing', async (t) => {
  const b = await box(t);
  const notDisabled = await run(b, [], { ports: fakePorts({ ok: false, reason: 'rejected', reasonCode: 'NOT_DISABLED', message: 'x' }).ports });
  assert.equal(notDisabled.code, 0);
  assert.match(notDisabled.text, /^Jev decisions stay disabled[^\n]*\nJev is not disabled; nothing to re-enable\. Nothing changed\.\n$/);

  const auth = await run(b, [], { ports: fakePorts({ ok: false, reason: 'rejected', reasonCode: 'AUTH_NEEDS_NEW_KEY', message: 'x' }).ports });
  assert.equal(auth.code, 1);
  assert.match(auth.text, /Not re-enabled \(AUTH_NEEDS_NEW_KEY\): [^\n]*jevris credential set\. Nothing changed\.\n$/);

  for (const reasonCode of ['NOT_RUNNING', 'CONNECT_FAILED', 'KEY_UNREADABLE', undefined]) {
    const f = fakePorts({ ok: false, reason: 'unavailable', ...(reasonCode === undefined ? {} : { reasonCode }), message: 'remote text that is never shown' });
    const r = await run(b, [], { ports: f.ports });
    assert.equal(r.code, 1, String(reasonCode));
    assert.match(r.text, /Nothing changed \(SIDECAR_NOT_RUNNING\): [^\n]*jevris sidecar start/);
    assert.doesNotMatch(r.text, /remote text/);
    assert.equal(f.ensured.length, 0);
  }
  const missing = await run(b, [], { ports: fakePorts({ ok: false, reason: 'unavailable', reasonCode: 'SIDECAR_CLIENT_MISSING', message: 'x' }).ports });
  assert.match(missing.text, /Nothing changed \(SIDECAR_CLIENT_MISSING\): the Jevris sidecar client is not installed/);
  const foreign = await run(b, [], { ports: fakePorts({ ok: false, reason: 'unavailable', reasonCode: 'FOREIGN_LOCALITY', message: 'x' }).ports });
  assert.match(foreign.text, /Nothing changed \(FOREIGN_LOCALITY\): the sidecar for this home runs in another execution environment/);
  const write = await run(b, [], { ports: fakePorts({ ok: false, reason: 'rejected', reasonCode: 'WRITE_FAILED', message: 'x' }).ports });
  assert.equal(write.code, 1);
  assert.match(write.text, /Nothing changed \(WRITE_FAILED\)/);
});

test('a timeout or an unrecognised answer is reported as unknown, never as unchanged (LOW 34)', async (t) => {
  const b = await box(t);
  const late = await run(b, [], { ports: fakePorts({ ok: false, reason: 'timeout', reasonCode: 'SIDECAR_CLIENT_TIMEOUT', message: 'x' }).ports });
  assert.equal(late.code, 1);
  assert.match(late.text, /Not confirmed \(SIDECAR_CLIENT_TIMEOUT\): [^\n]*unknown/);
  assert.doesNotMatch(late.text, /Nothing changed/);

  for (const result of [{ cleared: 'AUTH', persisted: true, audited: true }, { cleared: 'BILLING', persisted: true }, { cleared: 'BILLING', persisted: true, audited: true, fingerprint: 'abc' }, null]) {
    const r = await run(b, [], { ports: fakePorts(cleared(result)).ports });
    assert.equal(r.code, 1, JSON.stringify(result));
    assert.match(r.text, /Not confirmed \(SIDECAR_INVALID_RESULT\): [^\n]*unknown/);
    assert.doesNotMatch(r.text, /Nothing changed/);
  }
});

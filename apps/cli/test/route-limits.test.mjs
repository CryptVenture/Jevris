// Access limits R78 (design 9.2): `jevris route limits` lists the pauses in force from the machine
// record, and `clear` needs a person at an interactive terminal (no --yes, no --json, no pipe, no
// test run), shows the pauses, asks, and sends only the keys shown to B's access-limits.clear op.
// A temp home and fake sidecar ports only: nothing is started and no harness runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

process.env.JEVRIS_SIDECAR_AUTOSTART = '0';

const { runRouteLimitsCommand } = await import('../dist/access-limits-command.js');
const { runPublicCommand } = await import('../dist/public-commands.js');
const core = await import('../../../packages/core/dist/index.js');
const contracts = await import('../../../packages/contracts/dist/index.js');

const T = Date.parse('2026-09-28T12:00:00Z');
const H = 3_600_000;

async function box(t) {
  const dir = await mkdtemp(join(tmpdir(), 'jevris-limits-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  await mkdir(home);
  return { home, cwd: dir, env: { JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0', USER: 'dev' } };
}

/** Two pauses: a codex usage window (timed) and a kilocode credit stop (untimed). */
async function seed(home) {
  const windowSignal = { port: 'codex', channel: 'error-text', certified: false, text: contracts.matchAccessText("You've hit your usage limit.", 'codex', T) };
  const creditSignal = { port: 'kilocode', channel: 'structured', certified: false, errorType: 'APIError', status: 402 };
  const a = await core.recordAccessLimit({ home, scope: { harness: 'codex', authMode: 'subscription', servingHost: 'openai', modelId: 'gpt-5.5', family: null }, classification: core.classifyAccessSignal(windowSignal, 'subscription', T), source: 'owned-run', nowMs: T });
  const b = await core.recordAccessLimit({ home, scope: { harness: 'kilocode', authMode: 'api-key', servingHost: 'openrouter', modelId: null, family: null }, classification: core.classifyAccessSignal(creditSignal, 'api-key', T), source: 'session', nowMs: T });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  return (await core.readAccessLimits(home)).entries;
}

function fakePorts(answer) {
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
          return typeof answer === 'function' ? answer(input) : answer;
        },
      },
      engine: {},
      config: {},
    },
  };
}

async function run(b, argv, extra = {}) {
  let text = '';
  const code = await runRouteLimitsCommand(argv, (chunk) => (text += chunk), { env: b.env, cwd: b.cwd, nowMs: () => T + H, ...extra });
  return { code, text, json: text.startsWith('{') ? JSON.parse(text) : null };
}

const clearedAll = (input) => ({ ok: true, result: { cleared: [], audited: true, ...input } });

test('the list shows the pauses in force, numbered, from fixed text only, and --json carries keys and scopes', async (t) => {
  const b = await box(t);
  const empty = await run(b, []);
  assert.equal(empty.code, 0);
  assert.match(empty.text, /^No access pauses in force\./);

  const entries = await seed(b.home);
  const listed = await run(b, []);
  assert.equal(listed.code, 0);
  assert.match(listed.text, /^2 access pauses in force/);
  assert.match(listed.text, /\n {3}1 {2}\S/);
  assert.match(listed.text, /codex subscription openai: usage-window until 2026-09-28T17:00Z \(rule\) \(owned-run\)/);
  assert.match(listed.text, /kilocode api-key openrouter: credit-exhausted since 2026-09-28T12:00Z; clears with jevris route limits clear \(session\)/);
  assert.match(listed.text, /jevris route limits clear <n>/);

  const json = await run(b, ['--json']);
  assert.equal(json.code, 0);
  assert.equal(json.json.command, 'route limits');
  assert.equal(json.json.readable, true);
  assert.equal(json.json.full, false);
  assert.deepEqual(json.json.entries.map((e) => [e.n, e.key, e.class]), entries.map((e, i) => [i + 1, e.key, e.class]));
  assert.ok(json.json.entries.every((e) => !('fingerprint' in e)), 'the fingerprint is not shown');

  // After the window's reset only the credit stop is in force.
  const later = await run(b, [], { nowMs: () => T + 6 * H });
  assert.match(later.text, /^1 access pause in force/);
  assert.doesNotMatch(later.text, /usage-window/);

  const bad = await run(b, ['extra']);
  assert.equal(bad.code, 2);
});

test('a clear is refused without a person at a terminal: no TTY, --json, a test run, and there is no --yes', async (t) => {
  const b = await box(t);
  await seed(b.home);
  const fake = fakePorts({ ok: false, reason: 'unavailable' });
  const confirm = async () => assert.fail('no question without a terminal');
  const noTty = await run(b, ['clear', '1'], { ports: fake.ports, interactive: () => false, confirm });
  assert.equal(noTty.code, 2);
  assert.match(noTty.text, /CHANNEL_REFUSED/);
  const json = await run(b, ['clear', '1', '--json'], { ports: fake.ports, interactive: () => true, confirm });
  assert.equal(json.code, 2);
  assert.match(json.text, /CHANNEL_REFUSED/);
  const underTest = await run({ ...b, env: { ...b.env, JEVRIS_TEST: '1' } }, ['clear', '--all'], { ports: fake.ports, interactive: () => true, confirm });
  assert.equal(underTest.code, 2);
  assert.match(underTest.text, /CHANNEL_REFUSED/);
  const yes = await run(b, ['clear', '--all', '--yes'], { ports: fake.ports, interactive: () => true, confirm });
  assert.equal(yes.code, 2);
  assert.match(yes.text, /has no --yes/);
  assert.equal(fake.calls.length, 0, 'the sidecar is never asked');
  assert.equal((await core.readAccessLimits(b.home)).entries.length, 2, 'nothing changed');
});

test('a clear shows the chosen pauses, asks, and sends only their keys; declining changes nothing', async (t) => {
  const b = await box(t);
  const entries = await seed(b.home);
  const tty = { interactive: () => true };

  const usage = [await run(b, ['clear'], tty), await run(b, ['clear', '1', '--all'], tty), await run(b, ['clear', '0'], tty), await run(b, ['clear', '1', '1'], tty), await run(b, ['clear', '3'], tty)];
  for (const u of usage) assert.equal(u.code, 2, u.text);
  assert.match(usage[4].text, /no pause 3/);

  const fake = fakePorts((input) => clearedAll({ cleared: input.body.entries.map((key) => ({ key, class: entries.find((e) => e.key === key).class, scope: entries.find((e) => e.key === key).scope })) }));
  const k = entries.findIndex((e) => e.scope.harness === 'kilocode');
  const n = String(k + 1);
  let question = '';
  const declined = await run(b, ['clear', n], { ...tty, ports: fake.ports, confirm: async (q) => ((question = q), false) });
  assert.equal(declined.code, 1);
  assert.equal(question, 'Clear 1 access pause? Jevris will route to them again. [y/N] ');
  assert.match(declined.text, /kilocode api-key openrouter: credit-exhausted/);
  assert.match(declined.text, /Nothing changed/);
  assert.equal(fake.calls.length, 0);

  const one = await run(b, ['clear', n], { ...tty, ports: fake.ports, confirm: async () => true });
  assert.equal(one.code, 0, one.text);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].op, 'access-limits.clear');
  assert.equal(fake.calls[0].scope, 'cli');
  assert.deepEqual(fake.calls[0].body, { entries: [entries[k].key], channel: 'terminal' });
  assert.match(one.text, /Cleared 1 access pause; Jevris routes to them again:\n {2}kilocode api-key openrouter: credit-exhausted/);

  const all = await run(b, ['clear', '--all'], { ...tty, ports: fake.ports, confirm: async (q) => ((question = q), true) });
  assert.equal(all.code, 0);
  assert.equal(question, 'Clear 2 access pauses? Jevris will route to them again. [y/N] ');
  assert.deepEqual(fake.calls[1].body.entries, entries.map((e) => e.key), '--all sends the keys shown, never "all"');
});

test('a clear reports a partial clear, a missing audit row, a refusal and a malformed answer, and changes nothing itself', async (t) => {
  const b = await box(t);
  const entries = await seed(b.home);
  const opts = (answer) => ({ interactive: () => true, confirm: async () => true, ports: fakePorts(answer).ports });
  const brief = (e) => ({ key: e.key, class: e.class, scope: e.scope });

  const partial = await run(b, ['clear', '--all'], opts({ ok: true, result: { cleared: [brief(entries[0])], audited: false } }));
  assert.equal(partial.code, 0);
  assert.match(partial.text, /1 access pause had already lifted or changed/);
  assert.match(partial.text, /not written to the audit log/);

  const none = await run(b, ['clear', '1'], opts({ ok: true, result: { cleared: [], audited: true } }));
  assert.equal(none.code, 0);
  assert.match(none.text, /Nothing cleared/);

  const down = await run(b, ['clear', '1'], opts({ ok: false, reason: 'unavailable', message: 'not running' }));
  assert.equal(down.code, 1);
  assert.match(down.text, /Nothing changed \(SIDECAR_UNAVAILABLE\): the Jevris sidecar is not running/);

  const slow = await run(b, ['clear', '1'], opts({ ok: false, reason: 'timeout', message: 'slow' }));
  assert.equal(slow.code, 1);
  assert.match(slow.text, /Nothing changed \(SIDECAR_TIMEOUT\): the Jevris sidecar did not answer; check jevris sidecar status and retry/);

  const refusedWrite = await run(b, ['clear', '1'], opts({ ok: false, reason: 'refused', reasonCode: 'WRITE_FAILED', message: 'x' }));
  assert.equal(refusedWrite.code, 1);
  assert.match(refusedWrite.text, /Nothing changed \(WRITE_FAILED\): the access-limit record could not be changed \(it may be in use\); retry in a moment/);

  const foreign = await run(b, ['clear', '1'], opts({ ok: true, result: { cleared: [brief(entries[1])], audited: true } }));
  // entries[1] is not pause 1, so the answer names a key that was not asked for.
  assert.equal(foreign.code, 1, 'a key that was not asked for');
  assert.match(foreign.text, /SIDECAR_INVALID_RESULT/);
  const malformed = await run(b, ['clear', '1'], opts({ ok: true, result: { cleared: 'all' } }));
  assert.match(malformed.text, /SIDECAR_INVALID_RESULT/);

  assert.equal((await core.readAccessLimits(b.home)).entries.length, 2, 'the CLI never writes the record');
});

test('an unreadable record is said, and jevris route limits --help and jevris route --help show the help', async (t) => {
  const b = await box(t);
  const path = core.accessLimitsPath(b.home);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '{not json');
  const listed = await run(b, []);
  assert.equal(listed.code, 0);
  assert.match(listed.text, /ACCESS_LIMITS_UNREADABLE/);
  const cleared = await run(b, ['clear', '1'], { interactive: () => true, confirm: async () => assert.fail('no question') });
  assert.equal(cleared.code, 1);
  assert.match(cleared.text, /ACCESS_LIMITS_UNREADABLE/);
  assert.match(cleared.text, /jevris route limits clear --all/);
  assert.match(listed.text, /Rewrite it empty with jevris route limits clear --all/);
  // --all on an unreadable record: one question, then 'all' (the only thing that rewrites it).
  const fake = fakePorts({ ok: true, result: { cleared: [], audited: true } });
  let question = '';
  const reset = await run(b, ['clear', '--all'], { interactive: () => true, ports: fake.ports, confirm: async (q) => ((question = q), true) });
  assert.equal(reset.code, 0, reset.text);
  assert.match(question, /ACCESS_LIMITS_UNREADABLE\). Rewrite it empty\?/);
  assert.deepEqual(fake.calls[0].body, { entries: 'all', channel: 'terminal' });
  assert.match(reset.text, /rewritten empty/);

  let help = '';
  assert.equal(await runPublicCommand('route', ['limits', '--help'], (c) => (help += c), { env: b.env, cwd: b.cwd }), 0);
  assert.match(help, /^Usage: jevris route limits \[--json\]/);
  let routeHelp = '';
  await runPublicCommand('route', ['--help'], (c) => (routeHelp += c), { env: b.env, cwd: b.cwd });
  assert.match(routeHelp, /Access limits \(jevris route limits --help\):/);
});

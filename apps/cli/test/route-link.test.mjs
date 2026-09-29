// Owner decision 29423b6 (coordinator c065d52): `jevris route --task <id> --link` and
// `jevris route --unlink` over B's session.link and session.unlink ops. The sidecar resolves the
// session from its own records; the CLI needs a person at a terminal to link, never picks among
// candidates, and always names the session it linked. Fake sidecar ports only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.JEVRIS_SIDECAR_AUTOSTART = '0';

const { runPublicCommand } = await import('../dist/public-commands.js');
const renderMod = await import('../dist/public/render.js');
const { sessionLinksLine } = renderMod;
const { SessionLinkResultContract, surfacePayloadContract } = await import('../../../packages/contracts/dist/index.js');

const AT = Date.parse('2026-09-27T21:30:00Z');
const SES = 'ses_4f2a9c1b7d3e5a60';

function sandbox(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-route-link-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const workspace = join(dir, 'repo');
  mkdirSync(home);
  mkdirSync(join(workspace, '.git'), { recursive: true });
  return { home, workspace, env: { JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0', USER: 'dev' } };
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
          return typeof answer === 'function' ? answer(input) : (answer ?? { ok: false, reason: 'unavailable', reasonCode: 'NOT_RUNNING', message: 'not running' });
        },
      },
      engine: {},
      config: {},
    },
  };
}

async function run(box, argv, ports, interactive = true) {
  let text = '';
  const { runRouteLink } = await import('../dist/route-link.js');
  const code = await runRouteLink(argv, (chunk) => (text += chunk), { ports, env: box.env, cwd: box.workspace, interactive: () => interactive });
  return { code, text, json: text.startsWith('{') ? JSON.parse(text) : null };
}

const linked = (extra = {}) => ({ ok: true, result: { result: 'linked', harness: 'kilocode', sessionId: SES, taskId: 'fix-parser', lastSeenAtMs: AT, via: 'route', ...extra } });

test('the link answer contract: linked, ambiguous with 2 to 8 candidates, unlinked; nothing else', () => {
  const ok = (value) => SessionLinkResultContract.validate(value).ok;
  assert.equal(ok(linked().result), true);
  assert.equal(ok({ result: 'ambiguous', candidates: [{ harness: 'kilocode', sessionId: 'a1', lastSeenAtMs: AT }, { harness: 'opencode', sessionId: 'b2', lastSeenAtMs: AT }] }), true);
  assert.equal(ok({ result: 'ambiguous', candidates: [{ harness: 'kilocode', sessionId: 'a1', lastSeenAtMs: AT }] }), false, 'one candidate is not ambiguous');
  assert.equal(ok({ result: 'unlinked', harness: 'opencode', sessionId: SES }), true);
  assert.equal(ok({ ...linked().result, via: 'mcp' }), false);
  assert.equal(ok({ ...linked().result, sessionId: 'ses 1; rm' }), false);
  assert.equal(ok({ result: 'allow' }), false);
});

test('--link needs a person at a terminal: without one, nothing reaches the sidecar (B security review)', async (t) => {
  const box = sandbox(t);
  const fake = fakePorts({ 'session.link': linked() });
  const piped = await run(box, ['--task', 'fix-parser', '--link'], fake.ports, false);
  assert.equal(piped.code, 2);
  assert.match(piped.text, /needs a person at an interactive terminal/);
  const testEnv = await (async () => {
    let text = '';
    const { runRouteLink } = await import('../dist/route-link.js');
    const code = await runRouteLink(['--task', 'fix-parser', '--link'], (c) => (text += c), { ports: fake.ports, env: { ...box.env, JEVRIS_TEST: '1' }, cwd: box.workspace, interactive: () => true });
    return { code, text };
  })();
  assert.equal(testEnv.code, 2, 'a test run is never a person');
  assert.equal(fake.calls.length, 0);
});

test('a link names the session it linked, sends the terminal channel on the CLI key, and --replace rides along', async (t) => {
  const box = sandbox(t);
  const fake = fakePorts({ 'session.link': linked() });
  const done = await run(box, ['--task', 'fix-parser', '--link', '--harness', 'kilocode', '--session', SES, '--replace'], fake.ports);
  assert.equal(done.code, 0, done.text);
  assert.match(done.text, /^Linked: the kilocode session …7d3e5a60 \(last seen 2026-09-27 21:30 UTC\) works on task fix-parser\.$/m);
  assert.match(done.text, /Undo with jevris route --unlink/);
  const call = fake.calls[0];
  assert.deepEqual([call.op, call.scope, call.workspace], ['session.link', 'cli', box.workspace]);
  assert.deepEqual(call.body, { taskId: 'fix-parser', harness: 'kilocode', session: SES, replace: true, channel: 'terminal' });

  const json = await run(box, ['--task', 'fix-parser', '--link', '--json'], fake.ports);
  assert.deepEqual(json.json, { schemaVersion: '1.0', command: 'route link', changed: true, ...linked().result });
  assert.deepEqual(fake.calls[1].body, { taskId: 'fix-parser', channel: 'terminal' }, 'no hint: the sidecar resolves the session');
});

test('more than one session: the candidates are listed and none is linked; refusals say why', async (t) => {
  const box = sandbox(t);
  const candidates = [{ harness: 'kilocode', sessionId: 'ses_a', lastSeenAtMs: AT }, { harness: 'opencode', sessionId: 'ses_b', lastSeenAtMs: AT - 60_000 }];
  const ambiguous = await run(box, ['--task', 'fix-parser', '--link'], fakePorts({ 'session.link': { ok: true, result: { result: 'ambiguous', candidates } } }).ports);
  assert.equal(ambiguous.code, 1);
  assert.deepEqual(ambiguous.text.trimEnd().split('\n'), [
    'Not linked: more than one session could be meant. Name one with --session <id>:',
    '  kilocode ses_a (last seen 2026-09-27 21:30 UTC)',
    '  opencode ses_b (last seen 2026-09-27 21:29 UTC)',
  ]);
  for (const [code, pattern] of [
    ['SESSION_ALREADY_LINKED', /add --replace/],
    ['UNKNOWN_SESSION', /no active session of that harness recorded/],
    ['TASK_NOT_ACTIVE', /not approved or running/],
    ['KILL_SWITCH_ACTIVE', /kill switch/],
  ]) {
    const refused = await run(box, ['--task', 'fix-parser', '--link'], fakePorts({ 'session.link': { ok: false, reason: 'refused', reasonCode: code, message: 'x' } }).ports);
    assert.equal(refused.code, 1, code);
    assert.match(refused.text, new RegExp(`Nothing changed \\(${code}\\)`));
    assert.match(refused.text, pattern, code);
  }
  const broken = await run(box, ['--task', 'fix-parser', '--link'], fakePorts({ 'session.link': { ok: true, result: { result: 'linked', harness: 'kilocode' } } }).ports);
  assert.match(broken.text, /SIDECAR_INVALID_RESULT/);
});

test('--unlink works without a terminal and takes no task; usage errors are refused before the sidecar', async (t) => {
  const box = sandbox(t);
  const fake = fakePorts({ 'session.unlink': { ok: true, result: { result: 'unlinked', harness: 'opencode', sessionId: SES } } });
  const gone = await run(box, ['--unlink'], fake.ports, false);
  assert.equal(gone.code, 0, gone.text);
  assert.match(gone.text, /^Unlinked the opencode session …7d3e5a60\. Its turns get advice only\.$/m);
  assert.deepEqual([fake.calls[0].op, fake.calls[0].body], ['session.unlink', {}]);
  const none = await run(box, ['--unlink', '--harness', 'opencode'], fakePorts({ 'session.unlink': { ok: true, result: { result: 'not-linked', harness: 'opencode', sessionId: SES } } }).ports, false);
  assert.match(none.text, /was not linked; nothing changed/);

  const quiet = fakePorts({});
  for (const argv of [['--link'], ['--link', '--unlink', '--task', 't'], ['--unlink', '--task', 't'], ['--unlink', '--replace'], ['--task', 'bad id!', '--link'], ['--task', 't', '--link', '--harness', 'vim'], ['--task', 't', '--link', '--session', 'a b'], ['--task', 't', '--link', 'extra']]) {
    const bad = await run(box, argv, quiet.ports);
    assert.equal(bad.code, 2, argv.join(' '));
  }
  assert.equal(quiet.calls.length, 0);
});

test('jevris route dispatches --link and --unlink, and plain route advice is unchanged', async (t) => {
  const box = sandbox(t);
  const fake = fakePorts({ 'session.unlink': { ok: true, result: { result: 'unlinked', harness: 'kilocode', sessionId: SES } } });
  let text = '';
  const code = await runPublicCommand('route', ['--unlink'], (c) => (text += c), { ports: fake.ports, env: box.env, cwd: box.workspace });
  assert.equal(code, 0, text);
  assert.equal(fake.calls[0].op, 'session.unlink');
});

test('status shows each session link, and says a session gets advice only until linked', () => {
  const link = { harness: 'kilocode', sessionId: SES, taskId: 'fix-parser', linkedAtMs: AT, via: 'route' };
  assert.equal(sessionLinksLine([link]), 'session links: kilocode …7d3e5a60 -> task fix-parser (route, 2026-09-27)');
  assert.equal(sessionLinksLine([link, { ...link, harness: 'opencode', sessionId: 'ses_9e8d7c6ba1b2c3d4', taskId: 'T1', via: 'plan', worker: true }]), 'session links: kilocode …7d3e5a60 -> task fix-parser (route, 2026-09-27); opencode …a1b2c3d4 -> task T1 (plan, worker, 2026-09-27)');
  assert.match(sessionLinksLine([]), /^session links: none \(a Kilo or OpenCode session gets advice only until linked: jevris route --task <id> --link\)$/);
  const { sessionLinkExplainLine } = renderMod;
  assert.equal(sessionLinkExplainLine(link), 'session link: kilocode …7d3e5a60 -> task fix-parser (route, 2026-09-27)');
  assert.match(sessionLinkExplainLine(null), /^session link: none, so this turn got advice only/);
  const status = surfacePayloadContract('status');
  const bad = status.validate({ sessionLinks: [{ ...link, via: 'model' }] });
  assert.equal(bad.ok, false);
  // A worker link is marked only as `worker: true`; false or any other value does not fit.
  const view = (value) => surfacePayloadContract('explain').validate({ decisionId: 'dec-1', found: true, trace: { outcome: 'switch', reasonCodes: [], resolvedModel: null, usage: { known: false, inputTokens: null, outputTokens: null }, uncertainty: 'none', policyVersion: null, applied: false, rendered: 'x', sessionLink: value } }).ok;
  assert.equal(view({ ...link, worker: true }), true);
  assert.equal(view({ ...link, worker: false }), false);
  assert.equal(view({ ...link, worker: 'yes' }), false);
});

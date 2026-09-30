// JEV-0017: a workspace folder with a long generated name (an OS temporary folder) must not make a
// result fail its own contract, and a contract failure names its reason code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.JEVRIS_SIDECAR_AUTOSTART = '0';

const { runPublicCommand } = await import('../dist/public-commands.js');

const NOT_RUNNING = { ok: false, reason: 'unavailable', reasonCode: 'NOT_RUNNING', message: 'The Jevris sidecar is not running.' };
// 40 characters of mixed-case letters and digits in one segment: the shape of a generated temp name.
const LONG_SEGMENT = 'jev-e2e-cli-memory-recover-Ab3xYz9Qw7Lk2Mn';

function box(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-longpath-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const workspace = join(dir, LONG_SEGMENT);
  mkdirSync(home);
  mkdirSync(join(workspace, '.git'), { recursive: true });
  return { dir, home, workspace, env: { JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0' } };
}

const ports = (answers = {}) => ({
  sidecar: {
    async ensure() {
      return { ok: true, endpoint: 'fake', started: false };
    },
    async request(input) {
      const answer = answers[input.op];
      if (answer === undefined) return NOT_RUNNING;
      return { ok: true, result: answer };
    },
  },
  engine: {},
  config: {},
});

async function run(name, argv, b, p = ports()) {
  let text = '';
  const code = await runPublicCommand(name, argv, (chunk) => (text += chunk), { ports: p, env: b.env, cwd: b.workspace, nowMs: () => Date.UTC(2026, 8, 25) });
  return { code, text };
}

test('a workspace folder with a long mixed-case generated name does not fail the result contract', async (t) => {
  const b = box(t);
  for (const [name, argv] of [
    ['status', []],
    ['recover', ['--failure', 'f1']],
    ['checkpoint', ['--objective', 'Ship the parser']],
  ]) {
    const { code, text } = await run(name, [...argv, '--json'], b);
    assert.doesNotMatch(text, /invalid .* result|RESULT_CONTRACT_INVALID/, `${name}: ${text}`);
    assert.equal(code, 0, `${name}: ${text}`);
    assert.ok(JSON.parse(text.trimEnd().split('\n')[0]).workspace.root.includes(LONG_SEGMENT), name);
  }
});

test('a result that fails its contract is refused with RESULT_CONTRACT_INVALID, not a bare bug line', async (t) => {
  // A folder whose name is a provider key format is the one path the result contract still refuses.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-longpath-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const workspace = join(dir, 'sk-ant-api03-notarealkey');
  mkdirSync(home);
  mkdirSync(join(workspace, '.git'), { recursive: true });
  const b = { dir, home, workspace, env: { JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0' } };
  const { code, text } = await run('status', [], b);
  assert.equal(code, 2, text);
  assert.match(text, /Refused \(RESULT_CONTRACT_INVALID\): Jevris produced an invalid status result/);
  assert.doesNotMatch(text, /--help/);
  const json = await run('status', ['--json'], b);
  assert.equal(json.code, 2);
  assert.equal(JSON.parse(json.text.trimEnd()).error.code, 'RESULT_CONTRACT_INVALID');
});

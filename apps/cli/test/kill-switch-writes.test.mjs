// JEV-0022, GOV-02..04: a stopped Jevris writes no capsule. `checkpoint` and `handoff.import` are
// refused (KILL_SWITCH, exit 2) whether the sidecar is running and refuses, or is not running and the
// CLI would otherwise write the capsule file itself. Fake ports only; the real home is never used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

process.env.JEVRIS_SIDECAR_AUTOSTART = '0';

const { runPublicCommand, runSurfaceCall } = await import('../dist/public-commands.js');
const { killSwitchPath } = await import('../dist/kill-switch.js');

const NOT_RUNNING = { ok: false, reason: 'unavailable', reasonCode: 'NOT_RUNNING', message: 'The Jevris sidecar is not running.' };
const STOPPED = { ok: false, reason: 'refused', reasonCode: 'KILL_SWITCH', message: 'The kill switch is on.' };

function sandbox(t, { stopped }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-killwrites-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const workspace = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(join(workspace, '.git'), { recursive: true });
  if (stopped) {
    mkdirSync(dirname(killSwitchPath(home)), { recursive: true });
    writeFileSync(killSwitchPath(home), JSON.stringify({ stopped: true, reason: 'test' }));
  }
  return { dir, home, workspace, env: { JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0' } };
}

function ports(answer) {
  return {
    sidecar: {
      async ensure() {
        return { ok: true, endpoint: 'fake', started: false };
      },
      async request() {
        return answer;
      },
    },
    engine: {},
    config: {},
  };
}

function capsuleFiles(home) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.json') && entry.name !== 'kill-switch.json') found.push(full);
    }
  };
  walk(home);
  return found;
}

async function command(box, name, argv, answer) {
  let text = '';
  const code = await runPublicCommand(name, argv, (chunk) => (text += chunk), { ports: ports(answer), env: box.env, cwd: box.workspace, nowMs: () => Date.UTC(2026, 8, 25) });
  return { code, text };
}

async function surface(box, op, args, answer) {
  let text = '';
  const bytes = new TextEncoder().encode(JSON.stringify(args));
  const code = await runSurfaceCall([op], (chunk) => (text += chunk), async () => bytes, { ports: ports(answer), env: box.env, cwd: box.workspace, nowMs: () => Date.UTC(2026, 8, 25) });
  return { code, text };
}

for (const [label, answer] of [['the sidecar is not running', NOT_RUNNING], ['the sidecar refuses with KILL_SWITCH', STOPPED]]) {
  test(`JEV-0022: checkpoint while stopped is refused with KILL_SWITCH and writes no capsule (${label})`, async (t) => {
    const box = sandbox(t, { stopped: true });
    const { code, text } = await command(box, 'checkpoint', ['--objective', 'Ship the parser'], answer);
    assert.equal(code, 2, text);
    assert.match(text, /KILL_SWITCH/);
    assert.match(text, /kill-switch clear/);
    assert.deepEqual(capsuleFiles(box.home), []);
  });

  test(`JEV-0022: handoff.import while stopped is refused with KILL_SWITCH and imports nothing (${label})`, async (t) => {
    const box = sandbox(t, { stopped: true });
    const capsule = { id: 'cap-0123456789abcdef', schemaVersion: '1.0', taskIds: [] };
    const { code, text } = await surface(box, 'handoff.import', { capsule }, answer);
    // The MCP-facing call reports any refusal as REFUSED with the message; the message names the kill switch.
    assert.equal(code, 2, text);
    assert.match(text, /kill switch is on/);
    assert.deepEqual(capsuleFiles(box.home), []);
  });
}

test('JEV-0022: with the kill switch clear, a checkpoint without a sidecar still writes its capsule', async (t) => {
  const box = sandbox(t, { stopped: false });
  const { code, text } = await command(box, 'checkpoint', ['--objective', 'Ship the parser'], NOT_RUNNING);
  assert.equal(code, 0, text);
  assert.equal(capsuleFiles(box.home).length, 1);
});

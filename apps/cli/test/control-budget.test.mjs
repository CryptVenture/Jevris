// windows-latest Node 22.14 (61367de): `jevris control migrate --yes` answered DEADLINE. It is a
// person's command that calls a service over the network, but it asked the sidecar for the hot
// budget (900 ms), which one loaded-host round trip overran. It and `control status` now ask for
// the background budget and wait for it. Deterministic: the request the command sends is checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runControlCommand } = await import('../dist/control-command.js');

test('control status and migrate ask the sidecar for the background budget and wait past it', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-control-budget-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const work = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(join(work, '.git'), { recursive: true });
  const calls = [];
  const ports = {
    sidecar: {
      async ensure() {
        return { ok: true, endpoint: 'fake', started: false };
      },
      async request(input) {
        calls.push(input);
        return { ok: false, reason: 'timeout', reasonCode: 'DEADLINE' };
      },
    },
    engine: {},
    config: {},
  };
  const env = { JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0' };
  for (const argv of [['status'], ['migrate', '--yes']]) {
    await runControlCommand([...argv, '--json'], () => {}, { ports, env, cwd: work });
  }
  assert.deepEqual(calls.map((call) => call.op), ['control.status', 'control.migrate']);
  for (const call of calls) {
    assert.equal(call.budget, 'background', `${call.op} is not a hook call`);
    assert.ok(call.timeoutMs >= 10_000, `${call.op} waits past the 5 s background budget (${call.timeoutMs} ms)`);
  }
});

// ORC-03: `jevris status` names the test worker port only when a test worker script is named,
// as ACTIVE or refused with D's reason; with no script there is no line. Temp home only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../../../bin/jevris.mjs', import.meta.url));

function status(home, work, extra) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, JEVRIS_HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state'), APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'), JEVRIS_SIDECAR_AUTOSTART: '0', CLAUDE_PROJECT_DIR: work, ...extra };
  delete env.JEVRIS_TEST_WORKER_SCRIPT;
  Object.assign(env, extra);
  return spawnSync(process.execPath, [bin, 'status', '--json'], { env, cwd: work, encoding: 'utf8' });
}

test('status shows the test worker port only when a script is named, with the reason it is refused', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-status-tw-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const work = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(join(work, '.git'), { recursive: true });
  const none = status(home, work, {});
  assert.equal(none.status, 0, none.stderr);
  assert.equal(JSON.parse(none.stdout).result.testWorkerPort, undefined);
  const named = status(home, work, { JEVRIS_TEST_WORKER_SCRIPT: join(dir, 'worker.json') });
  assert.equal(named.status, 0, named.stderr);
  // No test-home marker in this home: the port is refused whatever JEVRIS_TEST says.
  assert.match(JSON.parse(named.stdout).result.testWorkerPort, /^test worker port refused \((NOT_TEST_MODE|NO_TEST_HOME_MARKER)\): owned workers use the Agent SDK$/);
});

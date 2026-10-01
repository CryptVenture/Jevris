// `verification.backgroundAtStop` acts only when the mode allows acting (bounded-auto): observe, advise
// and actuate are separate. With the setting on and a lower mode, `jevris status` and `jevris configure`
// say why no check is queued at Stop, in one line. The JSON payloads are unchanged. Temp home, no
// sidecar, no harness binary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runPublicCommand } = await import('../dist/public-commands.js');
const { backgroundVerifyAtStopText } = await import('../dist/background-verify-line.js');
const { DEFAULT_CONFIG } = await import('@jevris/orchestrator');
const { jevrisPaths } = await import('@jevris/platform');

const ports = { sidecar: { ensure: async () => ({ ok: true, endpoint: 'fake', started: false }), request: async () => ({ ok: false, reason: 'unavailable', reasonCode: 'NOT_RUNNING', message: 'x' }) }, engine: {}, config: {} };

/** A temp home whose own jevris.config.json carries the given mode and background setting. */
function scene(t, mode, backgroundAtStop) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-bg-verify-')));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  const home = join(dir, 'home');
  const config = jevrisPaths({ home }).config;
  mkdirSync(config, { recursive: true });
  const workspace = join(dir, 'work');
  mkdirSync(join(workspace, '.git'), { recursive: true });
  writeFileSync(join(config, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, mode, verification: { backgroundAtStop } }));
  const env = { JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0' };
  const show = async (command, ...args) => {
    let out = '';
    await runPublicCommand(command, args, (chunk) => (out += chunk), { ports, env, cwd: workspace });
    return out;
  };
  return { show };
}

const lineOf = (text) => text.split('\n').find((line) => line.startsWith('background verify at stop:'));

test('the line text: on with a mode that may act says what a Stop does; on below bounded-auto says why nothing is queued; off is off', () => {
  assert.equal(backgroundVerifyAtStopText('on', 'bounded-auto', 'a Stop queues them'), 'on (a Stop queues them)');
  for (const mode of ['off', 'observe', 'advise']) {
    assert.equal(
      backgroundVerifyAtStopText('on', mode, 'a Stop queues them'),
      `on, but mode ${mode} never runs checks at Stop: only bounded-auto does (observe, advise and actuate are separate)`,
    );
  }
  for (const mode of ['off', 'observe', 'advise', 'bounded-auto']) assert.equal(backgroundVerifyAtStopText('off', mode, 'x'), 'off');
});

test('status with the setting on in advise mode says that advise never runs checks at Stop', async (t) => {
  const { show } = scene(t, 'advise', 'on');
  const text = await show('status');
  assert.equal(lineOf(text), 'background verify at stop: on, but mode advise never runs checks at Stop: only bounded-auto does (observe, advise and actuate are separate)');
  assert.match(text, /^mode: advise$/m);
  const json = JSON.parse(await show('status', '--json')).result;
  assert.equal(json.backgroundVerifyAtStop, 'on', 'the payload still reports the setting itself');
  assert.equal(json.jevrisMode, 'advise');
});

test('status with the setting on in bounded-auto keeps the plain line (pair)', async (t) => {
  const { show } = scene(t, 'bounded-auto', 'on');
  assert.equal(lineOf(await show('status')), 'background verify at stop: on (a main-session Stop queues the missing approved checks)');
});

test('status with the setting off says off in every mode (pair)', async (t) => {
  for (const mode of ['observe', 'advise', 'bounded-auto']) {
    const { show } = scene(t, mode, 'off');
    assert.equal(lineOf(await show('status')), 'background verify at stop: off', mode);
  }
});

test('configure shows the same reason, and the plain line in bounded-auto', async (t) => {
  const low = scene(t, 'observe', 'on');
  assert.equal(lineOf(await low.show('configure')), 'background verify at stop: on, but mode observe never runs checks at Stop: only bounded-auto does (observe, advise and actuate are separate)');
  const high = scene(t, 'bounded-auto', 'on');
  assert.equal(lineOf(await high.show('configure')), 'background verify at stop: on (a main-session Stop queues the missing approved checks in the background)');
});

// The reduced (sidecar down) answer of a public surface call carries the not-running text of the
// sidecar client. With JEVRIS_SIDECAR_AUTOSTART=0 nothing starts the sidecar on demand, so the text
// names the fix and never promises a start; with autostart allowed the wording is unchanged. The
// reason code is NOT_RUNNING either way. A temporary home, the real client, no sidecar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runSurfaceCall } = await import('../dist/public-commands.js');

async function status(t, autostart) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-not-running-cli-')));
  const home = join(dir, 'home');
  const workspace = join(dir, 'work');
  mkdirSync(join(workspace, '.git'), { recursive: true });
  const before = process.env['JEVRIS_SIDECAR_AUTOSTART'];
  if (autostart === '0') process.env['JEVRIS_SIDECAR_AUTOSTART'] = '0';
  else delete process.env['JEVRIS_SIDECAR_AUTOSTART'];
  t.after(() => {
    if (before === undefined) delete process.env['JEVRIS_SIDECAR_AUTOSTART'];
    else process.env['JEVRIS_SIDECAR_AUTOSTART'] = before;
    rmSync(dir, { recursive: true, force: true });
  });
  const env = { JEVRIS_HOME: home, ...(autostart === '0' ? { JEVRIS_SIDECAR_AUTOSTART: '0' } : {}) };
  let text = '';
  const bytes = new TextEncoder().encode('{}');
  await runSurfaceCall(['status'], (chunk) => (text += chunk), async () => bytes, { env, cwd: workspace });
  return JSON.parse(text.trimEnd()).sidecar;
}

test('autostart off: the reduced status names the fix and never says it starts on demand', async (t) => {
  const sidecar = await status(t, '0');
  assert.equal(sidecar.state, 'not-running');
  assert.equal(sidecar.reasonCode, 'NOT_RUNNING');
  assert.match(sidecar.message, /autostart is off \(JEVRIS_SIDECAR_AUTOSTART=0\)/);
  assert.match(sidecar.message, /`jevris sidecar start`/);
  assert.doesNotMatch(sidecar.message, /on demand/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The "not running" answer must not promise a start that will not happen. With
// JEVRIS_SIDECAR_AUTOSTART=0 nothing starts the sidecar on demand, so the text names the fix
// (`jevris sidecar start`, or turn autostart back on) and never says "on demand". Where autostart is
// allowed the wording is unchanged. Text only: the reason code is NOT_RUNNING in both cases.
// A temporary home with no sidecar; the environment is restored after each test.

const { sidecarRequest } = await import('../dist/index.js');

const KEY = 'JEVRIS_SIDECAR_AUTOSTART';

function withAutostart(t, value) {
  const before = process.env[KEY];
  if (value === undefined) delete process.env[KEY];
  else process.env[KEY] = value;
  t.after(() => {
    if (before === undefined) delete process.env[KEY];
    else process.env[KEY] = before;
  });
}

function emptyHome(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-not-running-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test('autostart off: the not-running message names the fix and never says it starts on demand', async (t) => {
  withAutostart(t, '0');
  const home = emptyHome(t);
  const answer = await sidecarRequest({ home, op: 'health', scope: 'cli', body: {} });
  assert.equal(answer.ok, false, JSON.stringify(answer));
  assert.equal(answer.reason, 'unavailable');
  assert.equal(answer.reasonCode, 'NOT_RUNNING');
  assert.match(answer.message, /autostart is off/);
  assert.match(answer.message, /JEVRIS_SIDECAR_AUTOSTART=0/);
  assert.match(answer.message, /`jevris sidecar start`/);
  assert.match(answer.message, /unset JEVRIS_SIDECAR_AUTOSTART/);
  assert.doesNotMatch(answer.message, /on demand/);
  assert.doesNotMatch(answer.message, /retry/);
});

test('autostart allowed: the not-running message keeps its wording', async (t) => {
  withAutostart(t, undefined);
  const home = emptyHome(t);
  const answer = await sidecarRequest({ home, op: 'health', scope: 'cli', body: {} });
  assert.equal(answer.ok, false, JSON.stringify(answer));
  assert.equal(answer.reasonCode, 'NOT_RUNNING');
  assert.equal(answer.message, 'The Jevris sidecar is not running. Run `jevris sidecar start`, or retry: it starts on demand.');
});

test('a value other than 0 leaves autostart allowed', async (t) => {
  withAutostart(t, '1');
  const home = emptyHome(t);
  const answer = await sidecarRequest({ home, op: 'health', scope: 'cli', body: {} });
  assert.equal(answer.reasonCode, 'NOT_RUNNING');
  assert.match(answer.message, /starts on demand/);
});

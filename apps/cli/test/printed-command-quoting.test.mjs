// JEV-0041: every printed copy-and-run command quotes a path or user-controlled value that needs it.
// pack-hint-quoting.test.mjs pins the `pack list` install hint; this file pins the other three
// sites the fix changed: the doctor `route learning gone clear <model>` fix, the `service uninstall
// --home <home>` next step, and the `Run Jevris as: node <entry>` install fallback. Temp homes only;
// no harness binary runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelAvailabilityDoctorLines } from '../dist/model-availability.js';
import { stopSidecarBeforeRemoval } from '../dist/global-harness.js';
import { main } from '../dist/cli.js';
import { shellQuote } from '../../../packages/platform/dist/index.js';

const POSIX = process.platform !== 'win32';

function tempDir(t, prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

/** Runs a printed one-line command through /bin/sh with `jevris` stubbed to echo its arguments, one per line. */
function argvThroughShell(line) {
  const stub = 'jevris() { for a in "$@"; do printf "%s\\n" "$a"; done; }; ';
  const run = spawnSync('/bin/sh', ['-c', stub + line], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.split('\n').slice(0, -1);
}

function goneView(modelId) {
  return { registrySnapshotId: 'test', entries: [{ modelId, reasonCode: 'MODEL_GONE' }], lines: ['gone'] };
}

test('doctor: the route learning gone clear fix quotes a model id that needs it and leaves a plain one alone (JEV-0041)', () => {
  const plain = modelAvailabilityDoctorLines(goneView('claude-opus-5-5'));
  assert.match(plain[0], / jevris route learning gone clear claude-opus-5-5 --yes$/);

  const spaced = modelAvailabilityDoctorLines(goneView('my model'));
  assert.equal(shellQuote('my model') === 'my model', false, 'the helper quotes an id with a space');
  assert.ok(spaced[0].endsWith(` jevris route learning gone clear ${shellQuote('my model')} --yes`), spaced[0]);
  assert.equal(spaced[0].includes('clear my model --yes'), false, 'the id is not interpolated raw');
  if (POSIX) {
    const line = spaced[0].slice(spaced[0].indexOf('jevris route'));
    assert.deepEqual(argvThroughShell(line), ['route', 'learning', 'gone', 'clear', 'my model', '--yes']);
  }
});

test('doctor: a shell metacharacter in a model id cannot split the printed fix (JEV-0041)', { skip: !POSIX }, () => {
  const hostile = "a b'; echo pwned; '";
  const [line] = modelAvailabilityDoctorLines(goneView(hostile));
  const command = line.slice(line.indexOf('jevris route'));
  assert.deepEqual(argvThroughShell(command), ['route', 'learning', 'gone', 'clear', hostile, '--yes']);
});

test('uninstall: the service uninstall next step for another home quotes a home with a space (JEV-0041)', { skip: !POSIX }, async (t) => {
  const dir = tempDir(t, 'jev41-uninstall-');
  const account = join(dir, 'account');
  const home = join(dir, 'my home');
  mkdirSync(account);
  mkdirSync(home);
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = account;
  process.env.USERPROFILE = account;
  delete process.env.XDG_CONFIG_HOME;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const calls = [];
  const outcome = await stopSidecarBeforeRemoval(home, true, (...args) => {
    calls.push(args);
    return { status: 0, stdout: '', stderr: '' };
  });
  assert.equal(outcome.serviceRemoval, false, 'another home never removes the account service');
  assert.deepEqual(calls, [], 'no service manager call for another home');
  assert.ok(outcome.nextStep !== null, 'a next step is named');
  assert.ok(outcome.nextStep.endsWith(` jevris service uninstall --home ${shellQuote(home)}.`), outcome.nextStep);
  assert.equal(outcome.nextStep.includes(`--home ${home}.`), false, 'the home is not interpolated raw');
  const command = outcome.nextStep.slice(outcome.nextStep.indexOf('jevris service uninstall'), -1);
  assert.deepEqual(argvThroughShell(command), ['service', 'uninstall', '--home', home]);
});

test('install: the fallback "Run Jevris as: node <entry>" quotes a runtime path with a space (JEV-0041)', { skip: !POSIX }, async (t) => {
  const dir = tempDir(t, 'jev41-install-');
  const home = join(dir, 'my home');
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  // A `jevris` that is not Jevris's own is left alone, so the launcher is not written and the
  // install names the fallback command instead.
  writeFileSync(join(home, '.local', 'bin', 'jevris'), '#!/bin/sh\necho someone else\n', { mode: 0o755 });
  let text = '';
  const code = await main(['install', '--yes', '--home', home, '--harness', 'claude'], (chunk) => (text += chunk));
  assert.equal(code, 0, text);
  const match = /Run Jevris as: node (.+)$/m.exec(text);
  assert.ok(match !== null, `the fallback is printed:\n${text}`);
  const printed = match[1];
  assert.match(printed, /^'.*my home.*'$/, 'the entry path with a space is single-quoted');
  const shown = spawnSync('/bin/sh', ['-c', `printf '%s' ${printed}`], { encoding: 'utf8' });
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /my home\/.*\/bin\/jevris\.mjs$/, 'pasted through a shell it is one path');
});

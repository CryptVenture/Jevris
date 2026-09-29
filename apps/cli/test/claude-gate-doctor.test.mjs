// B's LOW 31 (access limits R68): doctor compares the gated Claude events the installed hooks.json
// registers with the features the installed binary's record certifies. Temp homes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { renderedClaudeGates, claudeGateLine, CLAUDE_MARKETPLACE_REL } = await import('../dist/global-harness.js');
const { doctorLineSeverity } = await import('../dist/doctor-severity.js');

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'jevris-gate-doctor-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function writeHooks(home, text) {
  const dir = join(home, CLAUDE_MARKETPLACE_REL, 'plugins', 'jevris', 'hooks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'hooks.json'), text);
}

const entry = [{ hooks: [{ type: 'command', command: 'node hook.mjs', timeout: 5 }] }];

test('renderedClaudeGates reads only the gated event names of the installed plugin hooks.json', async (t) => {
  const home = tempHome(t);
  assert.equal(await renderedClaudeGates(home), null, 'no installed plugin');
  writeHooks(home, JSON.stringify({ hooks: { Stop: entry, SessionStart: entry } }));
  assert.deepEqual(await renderedClaudeGates(home), []);
  writeHooks(home, JSON.stringify({ hooks: { Stop: entry, StopFailure: entry } }));
  assert.deepEqual(await renderedClaudeGates(home), ['StopFailure']);
  writeHooks(home, '{not json');
  assert.equal(await renderedClaudeGates(home), null);
  writeHooks(home, JSON.stringify({ hooks: [] }));
  assert.equal(await renderedClaudeGates(home), null);
});

test('a registered gated event its record no longer certifies is an action naming jevris install', () => {
  const line = claudeGateLine(['StopFailure'], ['hooks.observe'], '2.1.300');
  assert.equal(line, 'harness claude install: StopFailure registered, but access.session is not certified for 2.1.300; fix: jevris install --harness claude');
  assert.equal(doctorLineSeverity(line), 'action');
});

test('a certified gated event not registered yet is information, since the feature is optional', () => {
  const line = claudeGateLine([], ['hooks.observe', 'access.session'], '2.1.300');
  assert.equal(line, 'harness claude hooks: StopFailure not registered yet, although access.session is certified for 2.1.300; to add: jevris install --harness claude');
  assert.equal(doctorLineSeverity(line), 'info');
});

test('no line when the hooks and the record agree, or nothing can be compared', () => {
  assert.equal(claudeGateLine(['StopFailure'], ['hooks.observe', 'access.session'], '2.1.300'), null);
  assert.equal(claudeGateLine([], ['hooks.observe'], '2.1.300'), null);
  assert.equal(claudeGateLine(null, ['access.session'], '2.1.300'), null, 'no installed hooks.json');
  assert.equal(claudeGateLine(['StopFailure'], [], null), null, 'the binary was not found; the harness line says so');
});

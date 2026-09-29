// A's finding (coordinator, 2026-09-27): `jevris verify` against a sidecar that took the request
// and answered late printed `mode: reduced`, "nothing ran" and every check not-run, while the
// sidecar was running them. A late answer now says the state is unknown and how to see it, never
// a reduced answer; a sidecar that is down still gets the reduced one. Stub ports only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.JEVRIS_SIDECAR_AUTOSTART = '0';

const { runPublicCommand, runSurfaceCall } = await import('../dist/public-commands.js');

function sandbox(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-verify-late-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const workspace = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(join(workspace, '.git'), { recursive: true });
  return { home, workspace, env: { JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0' } };
}

/** A sidecar that takes the request and answers after the client stopped waiting. */
function lateSidecar() {
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
          await new Promise((resolve) => setTimeout(resolve, 20));
          // What the client port answers once its deadline passes (ports.ts withDeadline).
          return { ok: false, reason: 'timeout', reasonCode: 'SIDECAR_CLIENT_TIMEOUT', message: 'The sidecar did not answer in time. Run jevris sidecar status.' };
        },
      },
      engine: {},
      config: {},
    },
  };
}

function downSidecar() {
  return {
    sidecar: {
      async ensure() {
        return { ok: true, endpoint: 'fake', started: false };
      },
      async request() {
        return { ok: false, reason: 'unavailable', reasonCode: 'NOT_RUNNING', message: 'The Jevris sidecar is not running.' };
      },
    },
    engine: {},
    config: {},
  };
}

async function verify(box, argv, ports) {
  let text = '';
  const code = await runPublicCommand('verify', argv, (chunk) => (text += chunk), { ports, env: box.env, cwd: box.workspace });
  return { code, text };
}

test('a verify the sidecar answers late is unknown, never reduced or "nothing ran"', async (t) => {
  const box = sandbox(t);
  const late = lateSidecar();
  const human = await verify(box, [], late.ports);
  assert.equal(late.calls.length, 1, 'the request was sent');
  assert.equal(late.calls[0].op, 'verify');
  assert.equal(human.code, 1, human.text);
  assert.match(human.text, /did not answer within 5 s \(SIDECAR_CLIENT_TIMEOUT\)/);
  assert.match(human.text, /state of the checks is unknown: they may still be running/);
  assert.match(human.text, /Run jevris verify again/);
  assert.match(human.text, /\(VERIFY_STATE_UNKNOWN\)$/m);
  assert.doesNotMatch(human.text, /reduced|nothing ran|not-run/i);

  const json = await verify(box, ['--json'], lateSidecar().ports);
  assert.equal(json.code, 1);
  const parsed = JSON.parse(json.text);
  assert.equal(parsed.error.code, 'VERIFY_STATE_UNKNOWN');
  assert.equal('mode' in parsed, false, 'no mode is claimed for a sidecar that is alive but slow');
});

test('the MCP verify tool says the same through its one JSON line', async (t) => {
  const box = sandbox(t);
  let text = '';
  const bytes = new TextEncoder().encode('{}');
  const code = await runSurfaceCall(['verify'], (chunk) => (text += chunk), async () => bytes, { ports: lateSidecar().ports, env: box.env, cwd: box.workspace });
  assert.equal(code, 1);
  const parsed = JSON.parse(text);
  assert.equal(parsed.error.code, 'VERIFY_STATE_UNKNOWN');
  assert.match(parsed.error.message, /Call jevris_verify again/);
});

test('a sidecar that is down still gets the local reduced answer', async (t) => {
  const box = sandbox(t);
  const down = await verify(box, ['--json'], downSidecar());
  const parsed = JSON.parse(down.text);
  assert.equal(parsed.mode, 'reduced');
  assert.equal(parsed.sidecar.state, 'not-running');
});

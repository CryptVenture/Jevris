// SSOT §4.2 "Off: no Jev calls" (owner decision 0eb319de, coordinator follow-up): with the mode off,
// the CLI and the MCP surface refuse route, plan, recover and capability.advise with MODE_OFF and
// the command that raises the mode, whether or not a sidecar answers; the sidecar is never asked.
// Read-only commands (status, explain, configure, evidence get) still answer. Temp homes and fake
// ports only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const { runPublicCommand, runSurfaceCall } = await import('../dist/public-commands.js');
const { DEFAULT_CONFIG, configFilePath } = await import('@jevris/orchestrator');

function sandbox(t, mode) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-off-cli-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const workspace = join(dir, 'work');
  mkdirSync(join(workspace, '.git'), { recursive: true });
  const env = { JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0' };
  const path = configFilePath({ home, env });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...DEFAULT_CONFIG, mode }));
  return { home, workspace, env };
}

function ports() {
  const asked = [];
  return {
    asked,
    ports: {
      sidecar: {
        async ensure() {
          return { ok: true, endpoint: 'fake', started: false };
        },
        async request(input) {
          asked.push(input.op);
          return { ok: false, reason: 'unavailable', reasonCode: 'NOT_RUNNING', message: 'not running' };
        },
      },
      engine: {},
      config: {},
    },
  };
}

async function surface(box, fake, op, args = {}) {
  let text = '';
  const bytes = new TextEncoder().encode(JSON.stringify(args));
  const code = await runSurfaceCall([op], (chunk) => (text += chunk), async () => bytes, { ports: fake.ports, env: box.env, cwd: box.workspace });
  return { code, value: JSON.parse(text.trimEnd()) };
}

test('off: the MCP surface refuses every Jev ask with MODE_OFF and never asks the sidecar', async (t) => {
  const box = sandbox(t, 'off');
  const fake = ports();
  for (const op of ['route', 'plan', 'recover', 'capability.advise']) {
    const out = await surface(box, fake, op);
    assert.equal(out.code, 2, op);
    assert.equal(out.value.error.code, 'MODE_OFF', `${op}: ${JSON.stringify(out.value)}`);
    assert.match(out.value.error.message, /jevris configure set mode advise/);
  }
  assert.deepEqual(fake.asked, [], 'a refused ask reached the sidecar');
  // Read-only operations still answer.
  for (const [op, args] of [['status', {}], ['explain', { decisionId: 'd-missing' }], ['configure', {}], ['evidence.get', { handle: 'ev:missing' }]]) {
    const out = await surface(box, fake, op, args);
    assert.equal(out.value.error, undefined, `${op} was refused in off: ${JSON.stringify(out.value)}`);
  }
});

test('off: `jevris route` says why and names the command; advise does not refuse', async (t) => {
  const off = sandbox(t, 'off');
  let text = '';
  const code = await runPublicCommand('route', [], (chunk) => (text += chunk), { ports: ports().ports, env: off.env, cwd: off.workspace });
  assert.equal(code, 2);
  assert.match(text, /^Refused \(MODE_OFF\): Jevris is off, so route was not run: in off mode Jevris makes no Jev call\. Run `jevris configure set mode advise`/);
  const on = sandbox(t, 'advise');
  let again = '';
  await runPublicCommand('route', [], (chunk) => (again += chunk), { ports: ports().ports, env: on.env, cwd: on.workspace });
  assert.doesNotMatch(again, /MODE_OFF/);
});

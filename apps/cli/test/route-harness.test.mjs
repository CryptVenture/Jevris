// Harness parity audit G20 (C 458f0ce): the route request carries the session's harness and
// sign-in, and a model id as the harness reports it (`provider/model`, a gateway's two segments,
// Claude Code's `[1m]`). The CLI and MCP accept the same pattern (contracts
// HARNESS_MODEL_ID_PATTERN); the sidecar resolves it, and a local answer carries the bare model id
// so it stays within the contract. Fake ports only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.JEVRIS_SIDECAR_AUTOSTART = '0';

const { parseOpInput } = await import('../dist/public/inputs.js');
const { runPublicCommand } = await import('../dist/public-commands.js');
const { TOOLS } = await import('../../../packages/mcp/dist/main.js');
const { HARNESS_MODEL_ID_PATTERN, surfacePayloadContract } = await import('../../../packages/contracts/dist/index.js');

const NOT_RUNNING = { ok: false, reason: 'unavailable', reasonCode: 'NOT_RUNNING', message: 'The Jevris sidecar is not running.' };

function sandbox(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-route-harness-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const workspace = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(join(workspace, '.git'), { recursive: true });
  return { home, workspace, env: { JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0' } };
}

function fakePorts() {
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
          return NOT_RUNNING;
        },
      },
      engine: {},
      config: {},
    },
  };
}

async function route(box, argv, ports) {
  let text = '';
  const code = await runPublicCommand('route', [...argv, '--json'], (chunk) => (text += chunk), { ports, env: box.env, cwd: box.workspace });
  return { code, json: text.startsWith('{') ? JSON.parse(text) : null, text };
}

test('route takes a harness model id, a harness and a sign-in, and refuses anything else', () => {
  for (const model of ['claude-opus-5-5', 'claude-opus-5-5[1m]', 'anthropic/claude-opus-5-5', 'openrouter/anthropic/claude-opus-5', 'gpt-5.5:20260101']) {
    const ok = parseOpInput('route', { currentModel: model, modelPin: model });
    assert.equal(ok.ok, true, `${model}: ${JSON.stringify(ok)}`);
    assert.equal(ok.input.currentModel, model, 'the raw id goes to the sidecar, which resolves it');
  }
  for (const model of ['Anthropic/claude-opus-5', 'a/b/c/claude-opus-5', '../claude', 'claude-opus-5[2m]', 'claude opus', '/claude']) {
    assert.equal(parseOpInput('route', { currentModel: model }).ok, false, model);
  }
  const scoped = parseOpInput('route', { harness: 'opencode', authMode: 'subscription' });
  assert.deepEqual([scoped.input.harness, scoped.input.authMode], ['opencode', 'subscription']);
  const bare = parseOpInput('route', {});
  assert.deepEqual([bare.input.harness, bare.input.authMode], [null, null]);
  assert.equal(parseOpInput('route', { harness: 'vim' }).ok, false);
  assert.equal(parseOpInput('route', { authMode: 'free' }).ok, false);
});

test('the MCP route tool accepts the same harness model ids as the CLI (one pattern in contracts)', () => {
  const tool = TOOLS.find((t) => t.name === 'jevris_plan_route');
  for (const key of ['currentModel', 'modelPin']) assert.equal(tool.inputSchema.properties[key].pattern, HARNESS_MODEL_ID_PATTERN, key);
});

test('jevris route sends --harness and --auth-mode at the top level, and keeps the session auth mode for a priced switch', async (t) => {
  const box = sandbox(t);
  const fake = fakePorts();
  const run = await route(box, ['--model', 'anthropic/claude-opus-5-5[1m]', '--harness', 'opencode', '--auth-mode', 'subscription'], fake.ports);
  assert.equal(run.code, 0, run.text);
  const body = fake.calls.find((c) => c.op === 'route').body;
  assert.deepEqual(body, { currentModel: 'anthropic/claude-opus-5-5[1m]', modelPin: null, effortPin: null, taskId: null, sliceId: null, harness: 'opencode', authMode: 'subscription' });
  // With the sidecar down the local answer carries the bare model id, within the contract.
  assert.equal(run.json.result.main.currentModel, 'claude-opus-5-5');
  assert.equal(surfacePayloadContract('route').validate(run.json.result).ok, true);

  const priced = fakePorts();
  await route(box, ['--model', 'claude-opus-5', '--warm-prefix', '150000', '--auth-mode', 'api-key'], priced.ports);
  const pricedBody = priced.calls.find((c) => c.op === 'route').body;
  assert.equal(pricedBody.authMode, 'api-key');
  assert.deepEqual(pricedBody.session, { warmPrefixTokens: 150000, authMode: 'api-key' });
  assert.equal('harness' in pricedBody, false, 'no harness named on the CLI: none is sent');

  for (const argv of [['--harness', 'vim'], ['--auth-mode', 'free'], ['--model', 'Anthropic/claude']]) {
    const refused = await route(box, argv, fakePorts().ports);
    assert.equal(refused.code, 2, argv.join(' '));
  }
});

// The shipped plugins/shared/mcp.js end to end, driven by the official MCP SDK client (TOOL-04):
// real CLI answers, output schemas the client validates, protocol hygiene and an argument fuzz.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardStdin } from '../../../scripts/child-stdin.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SERVER = join(ROOT, 'plugins', 'shared', 'mcp.js');
const BIN = join(ROOT, 'bin', 'jevris.mjs');

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-mcp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const work = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(join(work, '.git'), { recursive: true });
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string') env[key] = value;
  Object.assign(env, { JEVRIS_HOME: home, JEVRIS_BIN: BIN, JEVRIS_SIDECAR_AUTOSTART: '0', CLAUDE_PROJECT_DIR: work });
  return { dir, home, work, env };
}

async function connect(t, env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr: 'ignore' });
  const client = new Client({ name: 'jevris-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

const task = (id) => ({
  id,
  schemaVersion: '1.0',
  workspaceId: 'ws1',
  revision: 'r1',
  state: 'proposed',
  requirementIds: ['REQ-1'],
  dependencyIds: [],
  writeScopes: [`src/${id}`],
  acceptanceCheckIds: ['c1'],
  rootBudgetId: 'b1',
});

test('the SDK client lists the tools and gets schema-valid real results', { timeout: 120_000 }, async (t) => {
  const box = sandbox(t);
  const client = await connect(t, box.env);
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  for (const name of ['jevris_status', 'jevris_explain_decision', 'jevris_plan_route', 'jevris_select_evidence', 'jevris_checkpoint', 'jevris_plan', 'jevris_verify']) {
    assert.equal(names.includes(name), true, name);
  }
  for (const tool of tools) assert.equal(typeof tool.outputSchema, 'object', `${tool.name} declares an outputSchema`);

  // The SDK validates structuredContent against each tool's outputSchema.
  const status = await client.callTool({ name: 'jevris_status', arguments: {} });
  assert.equal(status.isError, false);
  assert.equal(status.structuredContent.command, 'status');
  assert.equal(status.structuredContent.workspace.root !== null, true);
  assert.deepEqual(JSON.parse(status.content[0].text), status.structuredContent);

  const plan = await client.callTool({ name: 'jevris_plan', arguments: { tasks: [task('a'), { ...task('b'), dependencyIds: ['a'] }] } });
  assert.deepEqual(plan.structuredContent.result.waves, [['a'], ['b']]);

  const route = await client.callTool({ name: 'jevris_plan_route', arguments: { currentModel: 'claude-opus-4-7', modelPin: 'claude-opus-4-7' } });
  assert.equal(route.structuredContent.result.applied, false);
  assert.equal(route.structuredContent.result.main.pinState, 'pinned');

  const checkpoint = await client.callTool({ name: 'jevris_checkpoint', arguments: { objective: 'Ship it', constraints: ['No new dependencies'] } });
  assert.equal(checkpoint.structuredContent.result.compactionTriggered, false);

  const missing = await client.callTool({ name: 'jevris_explain_decision', arguments: { decisionId: 'd-none' } });
  assert.equal(missing.isError, false);
  assert.equal(missing.structuredContent.result.found, false);

  const verify = await client.callTool({ name: 'jevris_verify', arguments: { checkIds: ['unit'] } });
  assert.equal(verify.structuredContent.result.ran, false);
  assert.notEqual(verify.structuredContent.result.readiness, 'verified');

  const record = await client.callTool({ name: 'jevris_record_verification', arguments: { receiptId: 'r1', checkId: 'c1' } });
  assert.equal(record.structuredContent.result.receiptCreated, false);

  const settings = await client.callTool({ name: 'jevris_configure', arguments: {} });
  assert.equal(settings.structuredContent.result.nativePermissionsChanged, false);

  const home = await client.callTool({ name: 'jevris_status', arguments: { home: '/tmp/elsewhere' } });
  assert.equal(home.isError, true);
  assert.match(home.content[0].text, /Refused/);

  const resources = await client.listResources();
  assert.deepEqual(resources.resources.map((r) => r.uri).sort(), ['jevris://report/configuration', 'jevris://report/status']);
  const report = await client.readResource({ uri: 'jevris://report/status' });
  assert.equal(JSON.parse(report.contents[0].text).command, 'status');
});

test('fuzzed arguments never crash the server and always get a result or a tool error', { timeout: 180_000 }, async (t) => {
  const box = sandbox(t);
  const client = await connect(t, box.env);
  const { tools } = await client.listTools();
  const values = [null, true, 0, -1, 1e308, '', 'x'.repeat(5000), '../../etc/passwd', '\u0000', [], [1, 'a'], {}, { __proto__: { polluted: 1 } }, { constructor: 1 }];
  let seed = 7;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed;
  };
  for (const tool of tools) {
    const keys = [...Object.keys(tool.inputSchema.properties ?? {}), 'home', 'root', 'extra'];
    for (let round = 0; round < 3; round += 1) {
      const args = {};
      for (const key of keys) if (next() % 2 === 0) args[key] = values[next() % values.length];
      const answer = await client.callTool({ name: tool.name, arguments: args }).catch((error) => ({ thrown: error }));
      if ('thrown' in answer) {
        // Only an SDK-side output validation failure could throw here; that would be a bug.
        assert.fail(`${tool.name} ${JSON.stringify(args).slice(0, 200)}: ${answer.thrown.message}`);
      }
      assert.equal(typeof answer.isError, 'boolean');
    }
  }
  const alive = await client.ping();
  assert.deepEqual(alive, {});
});

test('raw protocol: oversize lines, parse errors and notifications never stop the server', { timeout: 60_000 }, async (t) => {
  const box = sandbox(t);
  const child = guardStdin(spawn(process.execPath, [SERVER], { env: box.env, stdio: ['pipe', 'pipe', 'ignore'] }));
  t.after(() => child.kill());
  const lines = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let at = buffer.indexOf('\n');
    while (at !== -1) {
      lines.push(JSON.parse(buffer.slice(0, at)));
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf('\n');
    }
  });
  const waitFor = async (predicate) => {
    for (let i = 0; i < 200; i += 1) {
      const found = lines.find(predicate);
      if (found !== undefined) return found;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail('no response');
  };
  child.stdin.write(`${'x'.repeat(1_100_000)}\n`);
  const oversize = await waitFor((m) => m.error?.message?.includes('1 MiB'));
  assert.equal(oversize.id, null);
  child.stdin.write('{not json}\n');
  await waitFor((m) => m.error?.code === -32700);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'alive', method: 'ping' })}\n`);
  const pong = await waitFor((m) => m.id === 'alive');
  assert.deepEqual(pong.result, {});
  assert.equal(lines.filter((m) => m.id === undefined).length, 0, 'nothing answered the notification');
});

test('the shipped server imports node builtins only and carries no machine path', () => {
  const text = readFileSync(SERVER, 'utf8');
  const specifiers = [
    ...[...text.matchAll(/^\s*(?:import|export)\s[^'"\n]*?from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]),
    ...[...text.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]),
    ...[...text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
  ];
  assert.equal(specifiers.length > 0, true);
  for (const spec of specifiers) assert.match(spec, /^node:/, spec);
  for (const banned of ['/Users/', '/Volumes/', '/home/runner/', 'npx ']) assert.equal(text.includes(banned), false, banned);
});

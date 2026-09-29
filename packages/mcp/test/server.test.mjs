// The MCP server in-process with a fake surface runner (TOOL-01..04, TOOL-08..10).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { createServer, TOOLS, SUPPORTED_PROTOCOLS, cliRunner, resolveBin, rootPath } = await import('../dist/server.js');

const REQUIRED = [
  'jevris_status',
  'jevris_explain_decision',
  'jevris_plan_route',
  'jevris_select_evidence',
  'jevris_evidence_get',
  'jevris_checkpoint',
  'jevris_get_task',
  'jevris_record_verification',
  'jevris_handoff_export',
  'jevris_handoff_import',
  'jevris_plan',
  'jevris_recover',
  'jevris_verify',
  'jevris_configure',
];

function server({ env = {}, answer, cwd = '/work/cwd', schemas } = {}) {
  const calls = [];
  const sent = [];
  const s = createServer({
    env,
    cwd: () => cwd,
    version: '9.9.9',
    ...(schemas !== undefined ? { outputSchemas: schemas } : {}),
    send: (message) => sent.push(message),
    runSurface: async (op, args, workspace, signal) => {
      calls.push({ op, args, workspace });
      if (typeof answer === 'function') return answer(op, args, signal);
      return answer ?? { kind: 'result', result: { schemaVersion: '1.0', command: op, summary: 'ok', result: {} } };
    },
  });
  return { s, calls, sent };
}

const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

test('initialize negotiates the requested version when supported, else the newest', async () => {
  const { s } = server();
  for (const version of SUPPORTED_PROTOCOLS) {
    const r = await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, capabilities: {} } });
    assert.equal(r.result.protocolVersion, version);
  }
  const old = await s.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(old.result.protocolVersion, SUPPORTED_PROTOCOLS[0]);
  assert.equal(old.result.serverInfo.version, '9.9.9');
  assert.deepEqual(Object.keys(old.result.capabilities).sort(), ['resources', 'tools']);
});

test('tools/list: every §6.4 tool, bounded schemas, annotations, effect class and no destructive tool', async () => {
  const schemas = Object.fromEntries(TOOLS.map((tool) => [tool.op, { type: 'object' }]));
  const { s } = server({ schemas });
  const { result } = await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const names = result.tools.map((tool) => tool.name);
  for (const name of REQUIRED) assert.equal(names.includes(name), true, name);
  assert.equal(names.includes('jevris_submit_task'), true, 'submit is listed; the sidecar enforces owned mode');
  for (const tool of result.tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    for (const key of Object.keys(tool.inputSchema.properties ?? {})) {
      assert.equal(/home|root|path|dir|output|shell|command/i.test(key), false, `${tool.name}.${key}`);
    }
    assert.equal(tool.annotations.destructiveHint, false, tool.name);
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean');
    assert.match(tool._meta['jevris/effect'], /^(read|advise|write-local|submit)$/);
    assert.deepEqual(tool.outputSchema, { type: 'object' });
  }
  // submit_task is always listed; the sidecar decides per request whether owned mode is on.
  assert.equal(result.tools.some((tool) => tool.name === 'jevris_submit_task'), true);
});

test('a tool result mirrors the CLI result in structuredContent and the text block', async () => {
  const cli = { schemaVersion: '1.0', command: 'route', mode: 'reduced', summary: 'Keep the model.', result: { applied: false } };
  const { s, calls } = server({ answer: { kind: 'result', result: cli } });
  const r = await s.handle(call(7, 'jevris_plan_route', { modelPin: 'claude-opus-4-7' }));
  assert.equal(r.id, 7);
  assert.equal(r.result.isError, false);
  assert.deepEqual(r.result.structuredContent, cli);
  assert.deepEqual(JSON.parse(r.result.content[0].text), cli);
  assert.deepEqual(calls[0], { op: 'route', args: { modelPin: 'claude-opus-4-7' }, workspace: '/work/cwd' });
  assert.equal(JSON.stringify(r).includes('credentialRef'), false);
  assert.equal(JSON.stringify(r).includes('presence'), false);
});

test('refusal, timeout and spawn failure set isError with a distinct message', async () => {
  const refused = await server({ answer: { kind: 'refused', code: 'REFUSED', message: 'Unknown argument "home".' } }).s.handle(call(1, 'jevris_status', { home: '/x' }));
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /^Refused \(REFUSED\): Unknown argument "home"\./);
  assert.equal('structuredContent' in refused.result, false);
  const failed = await server({ answer: { kind: 'failed', message: 'Jevris did not answer within 20 seconds.' } }).s.handle(call(2, 'jevris_status', {}));
  assert.equal(failed.result.isError, true);
  assert.match(failed.result.content[0].text, /did not answer/);
  const unknown = await server().s.handle(call(3, 'jevris_install', {}));
  assert.equal(unknown.error.code, -32602);
  const badArgs = await server().s.handle(call(4, 'jevris_status', ['x']));
  assert.equal(badArgs.result.isError, true);
  // submit_task goes to the CLI like any tool; the sidecar decides whether owned mode is on.
  const submitted = server({ answer: { kind: 'result', result: { command: 'task.submit' } } });
  const submit = await submitted.s.handle(call(5, 'jevris_submit_task', { task: {} }));
  assert.equal(submit.result.isError, false);
  assert.equal(submitted.calls[0].op, 'task.submit');
});

test('protocol hygiene: notifications get no reply, ping works, unknown methods and batches are errors', async () => {
  const { s } = server();
  assert.equal(await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
  assert.equal(await s.handle({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'jevris_status' } }), undefined, 'a request without an id is a notification');
  assert.deepEqual(await s.handle({ jsonrpc: '2.0', id: 'p', method: 'ping' }), { jsonrpc: '2.0', id: 'p', result: {} });
  assert.equal((await s.handle({ jsonrpc: '2.0', id: 9, method: 'sampling/createMessage' })).error.code, -32601);
  assert.equal((await s.handle([{ jsonrpc: '2.0', id: 1, method: 'ping' }])).error.code, -32600);
  assert.equal((await s.handle('text')).error.code, -32600);
  assert.equal((await s.handle({ jsonrpc: '2.0', id: {}, method: 'ping' })).error.code, -32600);
});

test('a cancelled call stops its runner and gets no response', async () => {
  let aborted = false;
  const { s } = server({
    answer: (op, args, signal) =>
      new Promise((resolve) => {
        signal.onAbort(() => {
          aborted = true;
          resolve({ kind: 'failed', message: 'cancelled' });
        });
      }),
  });
  const pending = s.handle(call(42, 'jevris_status', {}));
  await s.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 42 } });
  assert.equal(await pending, undefined);
  assert.equal(aborted, true);
});

test('the workspace comes from CLAUDE_PROJECT_DIR, else the client roots, else the working directory', async () => {
  const project = server({ env: { CLAUDE_PROJECT_DIR: '/work/project' } });
  await project.s.handle(call(1, 'jevris_status', {}));
  assert.equal(project.calls[0].workspace, '/work/project');

  const rooted = server();
  await rooted.s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: SUPPORTED_PROTOCOLS[0], capabilities: { roots: {} } } });
  await rooted.s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(rooted.sent.length, 1);
  assert.equal(rooted.sent[0].method, 'roots/list');
  assert.equal(await rooted.s.handle({ jsonrpc: '2.0', id: rooted.sent[0].id, result: { roots: [{ uri: 'file:///work/from%20roots', name: 'r' }] } }), undefined);
  await rooted.s.handle(call(2, 'jevris_status', {}));
  assert.equal(rooted.calls[0].workspace, '/work/from roots');

  const plain = server();
  await plain.s.handle(call(1, 'jevris_status', {}));
  assert.equal(plain.calls[0].workspace, '/work/cwd');
  assert.equal(rootPath('file:///C:/repo', 'win32'), 'C:/repo');
  assert.equal(rootPath('https://example.com/x', 'linux'), null);
});

test('resources: only approved report ids are served', async () => {
  const { s, calls } = server();
  const list = await s.handle({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
  assert.deepEqual(list.result.resources.map((r) => r.uri), ['jevris://report/status', 'jevris://report/configuration']);
  const read = await s.handle({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'jevris://report/status' } });
  assert.equal(read.result.contents[0].mimeType, 'application/json');
  assert.equal(calls[0].op, 'status');
  for (const uri of ['jevris://report/../secrets', 'file:///etc/passwd', 'jevris://report/doctor']) {
    const refused = await s.handle({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri } });
    assert.equal(refused.error.code, -32002, uri);
  }
});

test('the CLI is found from JEVRIS_BIN, the install pointer or a parent bin, never PATH', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-mcp-bin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, 'plugin', 'bin', 'mcp.js');
  mkdirSync(join(dir, 'plugin', 'bin'), { recursive: true });
  assert.equal(resolveBin({ PATH: '/usr/bin' }, script), null);
  assert.equal(resolveBin({ JEVRIS_BIN: '/abs/jevris.mjs' }, script), '/abs/jevris.mjs');
  assert.equal(resolveBin({ JEVRIS_BIN: 'relative.mjs' }, script), null);
  writeFileSync(join(dir, 'plugin', 'bin', 'jevris-bin.json'), JSON.stringify({ bin: '/pkg/bin/jevris.mjs' }));
  assert.equal(resolveBin({}, script), '/pkg/bin/jevris.mjs');
  rmSync(join(dir, 'plugin', 'bin', 'jevris-bin.json'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'jevris.mjs'), '');
  assert.equal(resolveBin({}, script), join(dir, 'bin', 'jevris.mjs'));
});

test('the CLI runner passes arguments on stdin and the workspace in the environment, and bounds the child', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-mcp-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = (name, body) => {
    const path = join(dir, `${name}.mjs`);
    writeFileSync(path, body);
    return path;
  };
  const echo = fake(
    'echo',
    `let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ schemaVersion: '1.0', command: process.argv[3], args: JSON.parse(input), workspace: process.env.JEVRIS_WORKSPACE ?? null, argv: process.argv.slice(2) }) + '\\n');
});`,
  );
  const never = { aborted: false, onAbort: () => undefined };
  const ok = await cliRunner({ JEVRIS_BIN: echo }, null)('route', { modelPin: 'm' }, '/work/x', never);
  assert.equal(ok.kind, 'result');
  assert.deepEqual(ok.result.args, { modelPin: 'm' });
  assert.equal(ok.result.workspace, '/work/x');
  assert.deepEqual(ok.result.argv, ['__surface', 'route']);

  const refuse = fake('refuse', "process.stdout.write(JSON.stringify({ error: { code: 'REFUSED', message: 'Unknown argument \"home\".' } }) + '\\n');");
  const refused = await cliRunner({ JEVRIS_BIN: refuse }, null)('status', {}, null, never);
  assert.deepEqual(refused, { kind: 'refused', code: 'REFUSED', message: 'Unknown argument "home".' });

  const garbage = fake('garbage', "process.stdout.write('not json');");
  assert.equal((await cliRunner({ JEVRIS_BIN: garbage }, null)('status', {}, null, never)).kind, 'failed');
  const other = fake('other', "process.stdout.write(JSON.stringify({ hello: 1 }));");
  assert.match((await cliRunner({ JEVRIS_BIN: other }, null)('status', {}, null, never)).message, /unexpected answer/);

  const hang = fake('hang', 'setInterval(() => {}, 1000);');
  const slow = await cliRunner({ JEVRIS_BIN: hang }, null, 300)('status', {}, null, never);
  assert.equal(slow.kind, 'failed');
  assert.match(slow.message, /did not answer/);

  const flood = fake('flood', "const chunk = 'x'.repeat(65536); for (let i = 0; i < 20; i += 1) process.stdout.write(chunk);");
  assert.match((await cliRunner({ JEVRIS_BIN: flood }, null)('status', {}, null, never)).message, /larger than 1 MiB/);

  let abort;
  const cancelled = cliRunner({ JEVRIS_BIN: hang }, null)('status', {}, null, { aborted: false, onAbort: (fn) => (abort = fn) });
  abort();
  assert.match((await cancelled).message, /cancelled/);

  const missing = await cliRunner({}, null)('status', {}, null, never);
  assert.match(missing.message, /was not found/);
});

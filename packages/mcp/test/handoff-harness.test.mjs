// TOOL-02, MEM-10: the MCP server learns its harness only from its own `--harness <id>` argument
// (the installer writes it into each harness's MCP entry) and sends it with handoff.import and
// handoff.export, so the sidecar negotiates the import for that harness from its certification
// records. An inherited JEVRIS_HARNESS or an unknown id counts for nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { certifyHooks } from '../../../test/acceptance/certified-hooks.mjs';
import { sandbox } from '../../../test/acceptance/lib.mjs';

const mcp = await import('../dist/main.js');
const { HARNESS_IDS } = await import('../../contracts/dist/index.js');

test('serverEnv takes the harness from argv only, and only a known id', () => {
  assert.deepEqual([...mcp.MCP_HARNESS_IDS], [...HARNESS_IDS]);
  const inherited = { PATH: '/bin', JEVRIS_HARNESS: 'claude' };
  assert.equal(mcp.serverEnv([], inherited).JEVRIS_HARNESS, undefined, 'an inherited value counts');
  assert.equal(mcp.serverEnv([], inherited).PATH, '/bin');
  assert.equal(mcp.serverEnv(['--harness', 'codex'], inherited).JEVRIS_HARNESS, 'codex');
  assert.equal(mcp.serverEnv(['--harness=opencode'], {}).JEVRIS_HARNESS, 'opencode');
  assert.equal(mcp.serverEnv(['--harness', 'vscode'], inherited).JEVRIS_HARNESS, undefined);
  assert.equal(mcp.serverEnv(['--harness'], inherited).JEVRIS_HARNESS, undefined);
});

async function client(t, box, args, extraEnv = {}) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [box.product.mcp, ...args], env: { ...box.env, ...extraEnv }, cwd: box.work, stderr: 'ignore' });
  const c = new Client({ name: 'jevris-handoff-test', version: '1.0.0' });
  await c.connect(transport);
  t.after(() => c.close().catch(() => {}));
  return async (name, args2) => (await c.callTool({ name, arguments: args2 })).structuredContent;
}

test('an import is negotiated for the harness named on the MCP server argv', async (t) => {
  const box = await sandbox(t);
  assert.equal(box.startSidecar().code, 0);
  assert.equal(box.jevris(['checkpoint', '--objective', 'Hand off the parser', '--constraint', 'C1: keep the API'], { json: true }).code, 0);
  // Claude's context hook is certified on this machine; nothing else is.
  await certifyHooks(box);

  const plain = await client(t, box, []);
  const exported = await plain('jevris_handoff_export', {});
  assert.equal(exported.result.found, true, JSON.stringify(exported));
  const envelope = exported.result.capsule;

  // No harness named: the target cannot inject context, so the import is advice only.
  const unnamed = await plain('jevris_handoff_import', { capsule: envelope });
  assert.equal(unnamed.result.reasonCode, 'IMPORTED_ADVICE_ONLY_CAPABILITY', JSON.stringify(unnamed.result));
  // An inherited variable does not name it either.
  const inherited = await client(t, box, [], { JEVRIS_HARNESS: 'claude' });
  assert.equal((await inherited('jevris_handoff_import', { capsule: envelope })).result.reasonCode, 'IMPORTED_ADVICE_ONLY_CAPABILITY');
  // Uncertified harness named: still advice only.
  const codex = await client(t, box, ['--harness', 'codex']);
  assert.equal((await codex('jevris_handoff_import', { capsule: envelope })).result.reasonCode, 'IMPORTED_ADVICE_ONLY_CAPABILITY');
  // The certified harness, named by the installer's argument: the import may actuate. It still grants no authority.
  const claude = await client(t, box, ['--harness', 'claude']);
  const named = await claude('jevris_handoff_import', { capsule: envelope });
  assert.equal(named.result.reasonCode, 'IMPORTED_ACTUATE', JSON.stringify(named.result));
  assert.equal(named.result.authorityGranted, false);
  // Export names the source harness in the envelope.
  const again = await claude('jevris_handoff_export', {});
  assert.equal(again.result.capsule.source.harness, 'claude');
  assert.equal((await plain('jevris_handoff_export', {})).result.capsule.source.harness, null);
});

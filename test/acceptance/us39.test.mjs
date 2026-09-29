import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { certifyHooks } from './certified-hooks.mjs';
import { story } from './lib.mjs';

function git(cwd, ...args) {
  const run = spawnSync('git', ['-c', 'user.email=ci@example.invalid', '-c', 'user.name=ci', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
}

/** The installed MCP server as a given harness runs it: `mcp.js --harness <id>`. */
async function mcpAs(t, box, harness) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [box.product.mcp, '--harness', harness], env: box.env, cwd: box.work, stderr: 'ignore' });
  const client = new Client({ name: `jevris-us39-${harness}`, version: '1.0.0' });
  await client.connect(transport);
  box.closeAtTeardown(() => client.close().catch(() => {}));
  return async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
}

story('US39', async ({ t, then, sandbox, evidence }) => {
  const box = await sandbox();
  // Given: a task in Claude Code at a known revision, with an approved check that is failing.
  spawnSync(process.execPath, ['-e', `require('node:fs').rmSync(${JSON.stringify(join(box.work, '.git'))}, { recursive: true, force: true })`]);
  box.write('work/src/parser.js', 'export const parse = (s) => s.split(",");\n');
  box.write('work/jevris.checks.json', {
    schemaVersion: 'jevris-checks-1',
    checks: [{ id: 'unit', argv: [process.execPath, '-e', 'process.exit(1)'], mandatory: true, resultFormat: 'exit-code', description: 'parser unit tests' }],
  });
  git(box.work, 'init', '-q');
  git(box.work, 'config', 'core.autocrlf', 'false');
  git(box.work, 'add', '.');
  git(box.work, 'commit', '-q', '-m', 'parser');
  assert.equal((await box.approveChecks()).code, 0);
  const verified = box.jevris(['verify', '--check', 'unit'], { json: true });
  assert.equal(verified.json?.result?.checks?.[0]?.outcome, 'failed', `the failing check did not record a failed receipt: ${JSON.stringify(verified.json) ?? verified.stdout} ${verified.stderr}`);
  const up = box.startSidecar();
  assert.equal(up.code, 0, `sidecar start failed: ${up.stdout} ${up.stderr}`);
  const checkpoint = box.jevris(['checkpoint', '--objective', 'Make the parser handle quoted fields', '--constraint', 'C1: keep the public parse() signature'], { json: true });
  assert.equal(checkpoint.code, 0, `checkpoint failed: ${checkpoint.stdout} ${checkpoint.stderr}`);

  const claude = await mcpAs(t, box, 'claude');
  const exported = await claude('jevris_handoff_export', {});
  evidence(exported);
  assert.equal(exported.result.found, true, `export failed: ${JSON.stringify(exported)}`);
  const envelope = exported.result.capsule;
  assert.equal(envelope.source.harness, 'claude');
  assert.ok(envelope.requiredCapabilities.includes('context-injection') && envelope.requiredCapabilities.includes('verify-runner'), JSON.stringify(envelope.requiredCapabilities));
  assert.deepEqual(envelope.openChecks, ['unit']);

  // When: a Kilo session imports it. Kilo is not certified for context here.
  const kilo = await mcpAs(t, box, 'kilocode');
  const reduced = await kilo('jevris_handoff_import', { capsule: envelope });
  evidence(reduced);

  await then('It negotiates capabilities, preserves unresolved checks and reports reduced functionality rather than translating unsupported controls blindly', async () => {
    // Negotiation: the same capsule, two capability sets.
    assert.equal(reduced.result.accepted, true, JSON.stringify(reduced.result));
    assert.equal(reduced.result.reasonCode, 'IMPORTED_ADVICE_ONLY_CAPABILITY', 'an uncertified target was not reduced for its missing context capability');
    // Once Kilo's hooks are certified for context on this machine, the same capsule imports in full.
    await certifyHooks(box, { harness: 'kilocode', version: '7.7.9', features: ['hooks.observe', 'hooks.context'] });
    const full = await kilo('jevris_handoff_import', { capsule: envelope });
    evidence(full);
    assert.equal(full.result.reasonCode, 'IMPORTED_ACTUATE', `a certified target was not given the capability: ${JSON.stringify(full.result)}`);

    // The failing check is carried as unresolved work, never as passed.
    assert.ok(reduced.result.unresolved.some((line) => /Check unit is open/.test(line)), `open check lost: ${JSON.stringify(reduced.result.unresolved)}`);
    assert.ok(reduced.result.unresolved.some((line) => /Check unit failed/.test(line)), `failed check lost: ${JSON.stringify(reduced.result.unresolved)}`);
    const resumed = await kilo('jevris_handoff_export', { capsuleId: reduced.result.capsuleId });
    evidence(resumed);
    const items = resumed.result.capsule.items;
    assert.ok(items.some((item) => item.kind === 'open-check' && /unit/.test(item.text)), 'the imported capsule has no open check');
    assert.ok(items.some((item) => item.kind === 'constraint' && item.text.includes('C1: keep the public parse() signature')), 'the constraint was lost');
    // Reduced, and said so: advice only, no authority, no approval carried over as a control.
    assert.equal(reduced.result.authorityGranted, false);
    assert.notEqual(reduced.result.reasonCode, 'IMPORTED_ACTUATE');
    assert.equal(items.some((item) => item.kind === 'approval'), false, 'an approval travelled as a control');
    assert.deepEqual(resumed.result.capsule.capsule.authorizationHistoryRefs, [], 'approvals were carried over');
    // The verification check still runs through the target's own runner; nothing marked it passed.
    const verify = box.jevris(['verify', '--check', 'unit'], { json: true });
    assert.notEqual(verify.json?.result?.readiness, 'verified', 'the imported failing check verified');
  });
});

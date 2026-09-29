import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { certifyHooks } from './certified-hooks.mjs';
import { workflow } from './lib.mjs';

function git(cwd, ...args) {
  const run = spawnSync('git', ['-c', 'user.email=ci@example.invalid', '-c', 'user.name=ci', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
}

/** The installed MCP server as a harness runs it (`mcp.js --harness <id>`), in `cwd`. */
async function mcpAs(t, box, harness, cwd = box.work) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [box.product.mcp, '--harness', harness], env: { ...box.env, CLAUDE_PROJECT_DIR: cwd }, cwd, stderr: 'ignore' });
  const client = new Client({ name: `jevris-w10-${harness}`, version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close().catch(() => {}));
  return async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
}

// W10: a task moves from Claude Code to Kilo. The capsule leaves only after the egress check;
// Kilo reports its capabilities and checks the revision; task state and evidence move, Claude's
// controls and approvals do not; Kilo continues with context advice but no routing and says so;
// the first resumed task has an explicit continuation check; what cannot be resumed is blocked
// with a precise reason.
workflow('W10', 'Moving from Claude Code to another harness', async ({ t, then, sandbox, evidence }) => {
  const box = await sandbox();
  spawnSync(process.execPath, ['-e', `require('node:fs').rmSync(${JSON.stringify(join(box.work, '.git'))}, { recursive: true, force: true })`]);
  box.write('work/src/report.js', 'export const total = (rows) => rows.length;\n');
  box.write('work/jevris.checks.json', {
    schemaVersion: 'jevris-checks-1',
    checks: [{ id: 'unit', argv: [process.execPath, '-e', 'process.exit(1)'], mandatory: true, resultFormat: 'exit-code', description: 'report unit tests' }],
  });
  git(box.work, 'init', '-q');
  git(box.work, 'add', '.');
  git(box.work, 'commit', '-q', '-m', 'report');
  assert.equal((await box.approveChecks()).code, 0);
  box.jevris(['verify', '--check', 'unit'], { json: true });
  box.write('work/src/report.js', 'export const total = (rows) => rows.reduce((n, r) => n + r.amount, 0);\n');
  assert.equal(box.startSidecar().code, 0);
  const SECRET = 'AKIAIOSFODNN7EXAMPLE';
  const checkpoint = box.jevris(['checkpoint', '--objective', 'Sum report amounts', '--constraint', 'C1: amounts are integer cents', '--constraint', `do not paste ${SECRET} anywhere`], { json: true });
  assert.equal(checkpoint.code, 0, `checkpoint failed: ${checkpoint.stdout} ${checkpoint.stderr}`);
  await certifyHooks(box, { harness: 'kilocode', version: '7.7.9', features: ['hooks.observe', 'hooks.context'] });
  const claude = await mcpAs(t, box, 'claude');
  const kilo = await mcpAs(t, box, 'kilocode');

  // The developer requests a handoff.
  const exported = await claude('jevris_handoff_export', {});
  evidence(exported);

  await then('the capsule is exported only after the egress check: no secret leaves in it', () => {
    assert.equal(exported.result.found, true, `export failed: ${JSON.stringify(exported)}`);
    assert.equal(JSON.stringify(exported).includes(SECRET), false, 'a secret left in the handoff capsule');
    assert.equal(exported.result.capsule.source.harness, 'claude');
    assert.match(exported.result.contentHash, /^sha256:[0-9a-f]{64}$/);
  });
  const envelope = exported.result.capsule;
  const imported = await kilo('jevris_handoff_import', { capsule: envelope });
  evidence(imported);

  await then('the target reports its capabilities and verifies the revision before it imports', () => {
    assert.equal(imported.result.accepted, true, JSON.stringify(imported.result));
    // Kilo is certified for context here, the revision and the changed file match: full import.
    assert.equal(imported.result.reasonCode, 'IMPORTED_ACTUATE', JSON.stringify(imported.result));
    assert.ok(envelope.source.head.length > 0 && envelope.source.changedFiles.some((file) => file.path === 'src/report.js'), 'the capsule does not name the revision and changed file it was taken at');
  });

  await then('task state and evidence move; Claude control messages and approvals do not', async () => {
    const resumed = await kilo('jevris_handoff_export', { capsuleId: imported.result.capsuleId });
    evidence(resumed);
    const items = resumed.result.capsule.items;
    for (const kind of ['objective', 'constraint', 'open-check', 'changed-file']) assert.ok(items.some((item) => item.kind === kind), `the ${kind} did not move: ${JSON.stringify(items.map((item) => item.kind))}`);
    assert.equal(items.some((item) => item.kind === 'approval'), false);
    assert.deepEqual(resumed.result.capsule.capsule.authorizationHistoryRefs, []);
    assert.equal(imported.result.authorityGranted, false);
    assert.equal(JSON.stringify(resumed).includes('hookSpecificOutput'), false, 'a Claude control message moved');
  });

  await then('the target supports context advice; its routes wait for their own certification, so it continues in reduced mode and says so', () => {
    const doctor = box.jevris(['doctor', '--harness', 'kilo', '--json']);
    evidence(doctor.stdout);
    const report = JSON.parse(doctor.stdout);
    const row = (report.harnesses ?? report.rows ?? []).find((item) => item.harness === 'kilocode');
    assert.ok(row !== undefined, `no kilocode row: ${doctor.stdout.slice(0, 400)}`);
    // Kilo routes a subagent and a main-session turn (R20, OD-8), each only once certify proves it.
    for (const feature of ['hooks.route', 'session.route']) assert.equal(row.certifiedFeatures.includes(feature), false, `${feature} is not certified here, so it must not actuate`);
    assert.equal((row.unsupported ?? []).some((item) => item.feature === 'hooks.route'), false, 'routing is a certified feature on Kilo, not a by-design limit');
    const text = box.jevris(['doctor', '--harness', 'kilo']);
    assert.match(text.stdout, /jevris certify/, 'doctor says how to certify what is missing');
  });

  await then('the first resumed task has an explicit continuation check', async () => {
    // The file changes after the handoff: the import is reduced and names the file.
    box.write('work/src/report.js', 'export const total = () => 0;\n');
    const moved = await kilo('jevris_handoff_import', { capsule: envelope });
    evidence(moved);
    assert.equal(moved.result.reasonCode, 'IMPORTED_ADVICE_ONLY_CONTINUATION', JSON.stringify(moved.result));
    assert.ok(moved.result.unresolved.some((line) => line.includes('src/report.js changed since the handoff')), JSON.stringify(moved.result.unresolved));
  });

  await then('what cannot be resumed is blocked with a precise reason, never a generic command', async () => {
    const other = join(box.dir, 'other-repo');
    mkdirSync(other);
    git(other, 'init', '-q');
    const elsewhere = await mcpAs(t, box, 'kilocode', other);
    const blocked = await elsewhere('jevris_handoff_import', { capsule: envelope });
    evidence(blocked);
    assert.equal(blocked.result.accepted, false);
    assert.equal(blocked.result.reasonCode, 'WORKSPACE_MISMATCH', JSON.stringify(blocked.result));
    const tampered = { ...envelope, capsule: { ...envelope.capsule, validUntil: '2020-01-01T00:00:00.000Z' } };
    const expired = await kilo('jevris_handoff_import', { capsule: tampered });
    assert.equal(expired.result.accepted, false);
    assert.match(expired.result.reasonCode, /^(CAPSULE_EXPIRED|HASH_MISMATCH|CAPSULE_INVALID)$/);
  });
});

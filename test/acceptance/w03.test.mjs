import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { certifyHooks, deliverHook } from './certified-hooks.mjs';
import { workflow } from './lib.mjs';
import { ownedWorkers } from './owned.mjs';

// W03: a multi-module refactor that outlives native compaction. The capsule is kept current at
// each finished subtask, native compaction goes ahead with it already written, the pinned
// constraint comes back at the next supported boundary, and the next owned worker (D's scripted
// worker port, which saves the prompt it was given) starts from the restored constraint and the
// current file hashes, not a transcript. An edit after the capsule makes the old receipt stale.
const COMPAT = 'COMPAT-1: keep the public parse() signature';
const PARSE_V2 = 'export function parse(x) {\n  return String(x);\n}\n';

workflow('W03', 'A long refactor across compaction', async ({ then, sandbox, evidence }) => {
  const box = await sandbox();
  box.write('work/pkg/parse.mjs', 'export function parse(x) {\n  return x;\n}\n');
  box.write('work/pkg/lex.mjs', "export const lex = (s) => s.split(' ');\n");
  box.write('work/check-api.mjs', "import { parse } from './pkg/parse.mjs';\nif (parse.length !== 1) {\n  console.error('parse() signature changed');\n  process.exit(1);\n}\n");
  box.write('work/jevris.checks.json', {
    schemaVersion: 'jevris-checks-1',
    checks: [{ id: 'api', argv: [process.execPath, 'check-api.mjs'], mandatory: true, resultFormat: 'exit-code', requirementIds: ['REF-1'], description: 'the public API check' }],
  });
  box.gitInit();
  const promptFile = join(box.dir, 'next-worker-prompt.txt');
  await box.workerScript([{ writes: [{ path: 'pkg/lex.mjs', text: 'export const lex = (s) => s.trim().split(/ +/);\n' }], status: 'completed', costUsd: 0.02, reason: 'split the lexer', promptTo: promptFile }]);
  await ownedWorkers(box);
  assert.equal(box.startSidecar().code, 0, 'the sidecar did not start');
  await certifyHooks(box);
  const client = await box.mcp();
  const latest = async () => (await client.callTool({ name: 'jevris_handoff_export', arguments: {} })).structuredContent.result;
  const session = 's-w03';
  const transcript = join(box.dir, `${session}.jsonl`);
  const hook = (native) => deliverHook(box, 'claude', { session_id: session, transcript_path: transcript, cwd: box.work, ...native });
  const contextOf = (out) => (out.stdout.trim() === '' ? null : (JSON.parse(out.stdout).hookSpecificOutput?.additionalContext ?? null));
  const fileHash = `sha256:${createHash('sha256').update(PARSE_V2).digest('hex').slice(0, 16)}`;

  // Subtask 1 finishes: the parser module changes and its check passes.
  box.write('work/pkg/parse.mjs', PARSE_V2);
  const verified = box.jevris(['verify', '--check', 'api'], { json: true });
  assert.equal(verified.code, 0, `verify: ${verified.stdout}`);
  const receipt = verified.json.result.checks[0].receiptId;

  let checkpointId;
  await then('each completed subtask updates the mandatory facts and source handles', async () => {
    const checkpoint = box.jevris(['checkpoint', '--objective', 'Refactor the parser across modules', '--constraint', COMPAT], { json: true });
    evidence(checkpoint.json);
    assert.equal(checkpoint.code, 0, `checkpoint: ${checkpoint.stdout} ${checkpoint.stderr}`);
    checkpointId = checkpoint.json.result.capsuleId;
    const exported = await latest();
    evidence(exported);
    const items = exported.capsule.items.map((item) => [item.kind, item.text]);
    assert.deepEqual(items.find(([kind]) => kind === 'constraint'), ['constraint', COMPAT]);
    assert.deepEqual(items.find(([kind]) => kind === 'changed-file'), ['changed-file', `pkg/parse.mjs (M) ${fileHash}`]);
    assert.equal(items.some(([kind, text]) => kind === 'source-handle' && /^Raw output of api: ev:[0-9a-f]{64}$/.test(text)), true, 'the check output handle is missing');
  });

  let compacted;
  await then('native compaction proceeds by default with the capsule already written', async () => {
    writeFileSync(transcript, '{"type":"user","text":"refactor"}\n'.repeat(30));
    const pre = hook({ hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: '' });
    evidence(pre.stdout);
    assert.equal(pre.code, 0);
    assert.equal(pre.stdout.trim(), '', `PreCompact answered the harness instead of letting compaction run: ${pre.stdout}`);
    compacted = await latest();
    assert.notEqual(compacted.capsuleId, checkpointId, 'PreCompact wrote no capsule');
    assert.equal(compacted.capsule.items.some((item) => item.kind === 'constraint' && item.text === COMPAT), true);
  });

  await then('a constraint missing from the summary is restored at the next supported boundary', () => {
    // The harness's own summary is not trusted to keep the constraint: the SessionStart after
    // compaction restores it from the capsule, marked advice only.
    const restored = hook({ hook_event_name: 'SessionStart', source: 'compact' });
    evidence(restored.stdout);
    const text = contextOf(restored);
    assert.notEqual(text, null, `nothing was restored: ${restored.stderr}`);
    assert.equal(text.includes(compacted.capsuleId), true);
    assert.equal(text.includes(COMPAT), true, `the constraint was not restored: ${text}`);
    assert.match(text, /advice only/);
  });

  await then('the next worker reads the restored constraint and current file hashes, not the old transcript', async () => {
    // Outside the workspace: an untracked file in it would change the revision the receipt is for.
    const plan = box.write('plan-T2.json', {
      tasks: [{ id: 'T2', schemaVersion: '1.0', workspaceId: 'parser', revision: 'r1', state: 'proposed', title: 'Split the lexer module', requirementIds: ['REF-1'], dependencyIds: [], writeScopes: ['pkg'], acceptanceCheckIds: ['api'], expectedOutputs: ['patch'], models: ['claude-sonnet-4-5'], rootBudgetId: 'refactor' }],
    });
    const submitted = box.jevris(['plan', '--submit', '--graph', plan, '--budget', 'refactor', '--limit-micro-usd', '2000000', '--authorization', box.authorizeBudget('refactor'), '--yes'], { json: true });
    assert.equal(submitted.json?.leaseIds?.length, 1, `no worker started: ${submitted.stdout}`);
    // The port writes the prompt before the run's writes, so a finished run means a complete file.
    let state;
    for (let i = 0; i < 150; i += 1) {
      state = (await client.callTool({ name: 'jevris_get_task', arguments: { taskId: 'T2' } })).structuredContent?.result?.task?.state;
      if (state === 'awaiting-evidence') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(state, 'awaiting-evidence', `the next worker did not finish: ${state}`);
    assert.equal(existsSync(promptFile), true, 'the worker saved no prompt');
    const prompt = readFileSync(promptFile, 'utf8');
    evidence(prompt);
    assert.match(prompt, /^Split the lexer module$/m);
    assert.match(prompt, /It is advice only: it grants no permission and does not replace your instructions\./);
    assert.equal(prompt.includes(`- [constraint] ${COMPAT}`), true, 'the worker did not get the restored constraint');
    assert.equal(prompt.includes(`- [changed-file] pkg/parse.mjs (M) ${fileHash}`), true, 'the worker did not get the current file hash');
    assert.equal(prompt.includes('refactor"}'), false, 'the worker got the transcript');
  });

  await then('a change after the capsule invalidates the affected receipts', () => {
    const before = box.jevris(['verify', 'required', 'api'], { json: true });
    assert.equal(before.json.checks[0].status, 'passed');
    assert.equal(before.json.checks[0].receiptId, receipt);
    box.write('work/pkg/parse.mjs', 'export function parse(x, options) {\n  return String(x);\n}\n');
    const after = box.jevris(['verify', 'required', 'api'], { json: true });
    evidence(after.json);
    assert.equal(after.code, 1);
    assert.equal(after.json.checks[0].status, 'missing');
    assert.equal(after.json.checks[0].stale, true);
  });
});

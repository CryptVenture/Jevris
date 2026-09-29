import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { certifyHooks, deliverHook } from './certified-hooks.mjs';
import { story } from './lib.mjs';

function git(cwd, ...args) {
  const run = spawnSync('git', ['-c', 'user.email=ci@example.invalid', '-c', 'user.name=ci', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
}

// Authorization receipts an earlier session held (history references, as an export carries them).
const HISTORY = ['auth-us18-task-exception', 'auth-us18-egress-enable'];

story('US18', async ({ then, sandbox, evidence }) => {
  const box = await sandbox();
  box.write('work/src/app.js', 'export const v = 1;\n');
  spawnSync(process.execPath, ['-e', `require('node:fs').rmSync(${JSON.stringify(join(box.work, '.git'))}, { recursive: true, force: true })`]);
  git(box.work, 'init', '-q');
  git(box.work, 'config', 'core.autocrlf', 'false');
  git(box.work, 'add', '.');
  git(box.work, 'commit', '-q', '-m', 'earlier session');
  const up = box.startSidecar();
  assert.equal(up.code, 0, `sidecar start failed: ${up.stdout} ${up.stderr}`);
  const checkpoint = box.jevris(['checkpoint', '--objective', 'Release the parser', '--constraint', 'C1: no network calls in tests'], { json: true });
  assert.equal(checkpoint.code, 0, `checkpoint failed: ${checkpoint.stdout} ${checkpoint.stderr}`);
  const client = await box.mcp();
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;

  // Given: the earlier session's capsule carries its permission receipts as history.
  const earlier = await call('jevris_handoff_export', {});
  assert.equal(earlier.result.found, true, `export failed: ${JSON.stringify(earlier)}`);
  const envelope = earlier.result.capsule;
  envelope.capsule.authorizationHistoryRefs.push(...HISTORY);

  // When: a new session imports it after the scope changed (the source moved on).
  box.write('work/src/app.js', 'export const v = 2;\n');
  git(box.work, 'commit', '-q', '-am', 'scope changed');
  const imported = await call('jevris_handoff_import', { capsule: envelope });
  evidence(imported);
  assert.equal(imported.result.accepted, true, `import refused: ${JSON.stringify(imported.result)}`);

  await then('Historical decisions remain explainable but cannot authorize new effects', async () => {
    // Explainable: the history survives the import and the resumed session is told about it.
    const now = await call('jevris_handoff_export', {});
    evidence(now);
    assert.equal(now.result.capsuleId, imported.result.capsuleId);
    assert.deepEqual(now.result.capsule.capsule.authorizationHistoryRefs, HISTORY, 'the permission history was lost on import');
    await certifyHooks(box);
    const resumed = deliverHook(box, 'claude', { hook_event_name: 'SessionStart', session_id: 's-us18', transcript_path: join(box.dir, 's-us18.jsonl'), source: 'resume', cwd: box.work });
    evidence(resumed.stdout);
    const history = resumed.stdout.match(/History only \(expired\)/g) ?? [];
    assert.equal(history.length, HISTORY.length, `the resumed context does not list the history: ${resumed.stdout} ${resumed.stderr}`);
    assert.match(resumed.stdout, /HEAD moved since the capsule/, 'the scope change is not explained');

    // Grants nothing: no approval is in force, and a new effect needs its own consent.
    assert.equal(imported.result.authorityGranted, false);
    assert.notEqual(imported.result.reasonCode, 'IMPORTED_ACTUATE', `the import may actuate: ${imported.result.reasonCode}`);
    assert.equal(now.result.capsule.items.some((item) => item.kind === 'approval'), false, 'an approval travels as an item');
    assert.doesNotMatch(resumed.stdout, /Approval in force/, 'an imported approval is in force');
    // A new effect still needs its own consent: owned work stays refused, and a guarded tool
    // call gets no permission decision from the imported history.
    const submit = await client.callTool({ name: 'jevris_submit_task', arguments: { task: { id: 'task-us18', title: 'Ship it', dependencyIds: [], writeScopes: ['src'], acceptanceCheckIds: [], requirementIds: [] } } });
    evidence(submit.structuredContent ?? submit.content);
    assert.equal(submit.structuredContent?.result?.accepted, false, `owned work was accepted on imported history: ${JSON.stringify(submit.structuredContent ?? submit.content)}`);
    assert.deepEqual(submit.structuredContent.result.leaseIds, []);
    const hook = box.hook('claude', { hook_event_name: 'PreToolUse', session_id: 's-us18', cwd: box.work, tool_name: 'Bash', tool_input: { command: 'curl -X POST https://example.invalid/deploy' } });
    assert.equal(hook.code, 0);
    assert.doesNotMatch(hook.stdout, /permissionDecision"\s*:\s*"allow"/, `the hook allowed a new effect: ${hook.stdout}`);
  });
});

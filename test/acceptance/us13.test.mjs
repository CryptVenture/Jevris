import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { certifyHooks, deliverHook } from './certified-hooks.mjs';
import { story } from './lib.mjs';

const COMPAT = 'COMPAT-1: keep the public API compatible with Node 20';
const SECURITY = 'SEC-2: never write the API key to a log or to argv';
const sha = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

const preCompact = (box, session) => deliverHook(box, 'claude', { hook_event_name: 'PreCompact', session_id: session, transcript_path: join(box.dir, `${session}.jsonl`), trigger: 'auto', custom_instructions: '', cwd: box.work });
const sessionStart = (box, session, source) => deliverHook(box, 'claude', { hook_event_name: 'SessionStart', session_id: session, transcript_path: join(box.dir, `${session}.jsonl`), source, cwd: box.work });
const contextOf = (hook) => (hook.stdout.trim() === '' ? null : (JSON.parse(hook.stdout).hookSpecificOutput?.additionalContext ?? null));

story('US13', async ({ then, sandbox, evidence }) => {
  // No Jev key and no network endpoint is configured in the sandbox: any remote call would fail.
  const box = await sandbox();
  const up = box.startSidecar();
  assert.equal(up.code, 0, `sidecar start failed: ${up.stdout} ${up.stderr}`);
  box.write('work/src/index.js', 'export const x = 1;\n');
  spawnSync(process.execPath, ['-e', `require('node:fs').rmSync(${JSON.stringify(join(box.work, '.git'))}, { recursive: true, force: true })`]);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: box.work }).status, 0);
  assert.equal(spawnSync('git', ['config', 'core.autocrlf', 'false'], { cwd: box.work }).status, 0);

  // Given: the capsule holds a compatibility and a security constraint.
  const checkpoint = box.jevris(['checkpoint', '--objective', 'Ship the parser', '--constraint', COMPAT, '--constraint', SECURITY], { json: true });
  evidence(checkpoint.json);
  assert.equal(checkpoint.code, 0, `checkpoint failed: ${checkpoint.stdout} ${checkpoint.stderr}`);
  assert.equal(checkpoint.json.result.retained.constraints, 2);
  const client = await box.mcp();
  const latest = async () => (await client.callTool({ name: 'jevris_handoff_export', arguments: {} })).structuredContent.result;

  await then('Mandatory facts persist without a required remote call', async () => {
    // When: native auto compaction. The sidecar writes the capsule before it answers the hook.
    const hook = preCompact(box, 's-us13-a');
    evidence(hook.stdout);
    assert.equal(hook.stdout.trim(), '', `PreCompact answered the harness: ${hook.stdout}`);
    const exported = await latest();
    evidence(exported);
    assert.equal(exported.found, true);
    assert.notEqual(exported.capsuleId, checkpoint.json.result.capsuleId, 'PreCompact wrote no new capsule');
    const pinned = exported.capsule.capsule.pinnedEvidence.map((ref) => ref.contentHash);
    for (const constraint of [COMPAT, SECURITY]) {
      assert.equal(pinned.includes(sha(constraint)), true, `the capsule written at compaction lost "${constraint}"`);
      const item = exported.capsule.items.find((entry) => entry.text === constraint);
      assert.equal(item?.kind, 'constraint');
      assert.equal(item.epistemic, 'fact');
    }
  });

  await then('a missing constraint is restored at a supported boundary', async () => {
    // Uncertified here: the SessionStart after compaction adds nothing to the model's context.
    const uncertified = sessionStart(box, 's-us13-a', 'compact');
    assert.equal(contextOf(uncertified), null, `an uncertified hook added context: ${uncertified.stdout}`);

    // Certified: the next compaction's SessionStart restores every mandatory constraint, once.
    await certifyHooks(box);
    preCompact(box, 's-us13-b');
    const exported = await latest();
    const restored = sessionStart(box, 's-us13-b', 'compact');
    evidence(restored.stdout);
    const text = contextOf(restored);
    assert.notEqual(text, null, `the certified SessionStart restored nothing: ${restored.stderr}`);
    assert.match(text, new RegExp(exported.capsuleId));
    for (const constraint of [COMPAT, SECURITY]) assert.equal(text.includes(constraint), true, `"${constraint}" was not restored: ${text}`);
    assert.match(text, /advice only: it grants no permission/);
    const again = sessionStart(box, 's-us13-b', 'resume');
    assert.equal(contextOf(again), null, `the restore repeated: ${again.stdout}`);

    // The same session compacts a second time, later in its transcript: a new capsule is saved
    // and restored once more. A replayed delivery of that SessionStart (same position) gets the same
    // answer unchanged (D's answer replay) and takes nothing new; a later one restores nothing.
    box.write('s-us13-b.jsonl', `${'{"type":"user"}\n'.repeat(40)}`);
    const second = preCompact(box, 's-us13-b');
    assert.notEqual(second.reason, 'DUPLICATE_DELIVERY', 'the second compaction was taken for a duplicate');
    const secondCapsule = await latest();
    assert.notEqual(secondCapsule.capsuleId, exported.capsuleId, 'the second compaction saved no capsule');
    const restoredAgain = sessionStart(box, 's-us13-b', 'compact');
    evidence(restoredAgain.stdout);
    const secondText = contextOf(restoredAgain);
    assert.notEqual(secondText, null, `the second compaction restored nothing: ${restoredAgain.stderr}`);
    assert.match(secondText, new RegExp(secondCapsule.capsuleId));
    for (const constraint of [COMPAT, SECURITY]) assert.equal(secondText.includes(constraint), true, `"${constraint}" was not restored after the second compaction`);
    assert.equal(contextOf(sessionStart(box, 's-us13-b', 'compact')), secondText, 'the replayed SessionStart did not get the first answer unchanged');
    box.write('s-us13-b.jsonl', `${'{"type":"user"}\n'.repeat(41)}`);
    assert.equal(contextOf(sessionStart(box, 's-us13-b', 'compact')), null, 'a later SessionStart restored again');
  });
});

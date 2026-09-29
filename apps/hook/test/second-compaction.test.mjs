// A second compaction in one session is a new delivery, not a duplicate. Claude Code sends no
// event id on PreCompact or SessionStart, so the launcher gives the adapter the transcript's
// size (its position in the session) and the dedup key includes it. Through the real launcher
// and sidecar in a sandbox: two compactions in one session each write a capsule and each
// restore once, and a replay of the same delivery (same position) still dedups: it runs nothing
// again, and gets the first delivery's answer unchanged (D's answer replay).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from '../../../test/acceptance/lib.mjs';
import { certifyHooks } from '../../../test/acceptance/certified-hooks.mjs';
import { managedHostSkip } from '../../../test/managed-host.mjs';

const contextOf = (hook) => (hook.stdout.trim() === '' ? null : (JSON.parse(hook.stdout).hookSpecificOutput?.additionalContext ?? null));

test('two compactions in one session each write a capsule and each restore once; a replayed delivery still dedups', { timeout: 120_000, skip: managedHostSkip() }, async (t) => {
  const box = await sandbox(t);
  rmSync(join(box.work, '.git'), { recursive: true, force: true });
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: box.work }).status, 0);
  assert.equal(box.startSidecar().code, 0);
  const checkpoint = box.jevris(['checkpoint', '--objective', 'Ship the parser', '--constraint', 'C1: keep Node 20 support'], { json: true });
  assert.equal(checkpoint.code, 0, checkpoint.stderr);
  await certifyHooks(box);
  const client = await box.mcp();
  const latest = async () => (await client.callTool({ name: 'jevris_handoff_export', arguments: {} })).structuredContent.result.capsuleId;

  const session = 's-two-compactions';
  const transcript = join(box.dir, `${session}.jsonl`);
  writeFileSync(transcript, `${JSON.stringify({ type: 'user', text: 'turn 1' })}\n`);
  const grow = (text) => appendFileSync(transcript, `${JSON.stringify({ type: 'assistant', text })}\n`);
  // The longest hook deadline the launcher allows (4 s): under a loaded CI cell the default
  // 1.5 s can end a restore in observe mode, which is the degraded path, not what this tests.
  const slow = { extraEnv: { JEVRIS_HOOK_DEADLINE_MS: '4000' } };
  const preCompact = () => box.hook('claude', { hook_event_name: 'PreCompact', session_id: session, transcript_path: transcript, trigger: 'auto', custom_instructions: '', cwd: box.work }, slow);
  const restore = () => box.hook('claude', { hook_event_name: 'SessionStart', session_id: session, transcript_path: transcript, source: 'compact', cwd: box.work }, slow);

  // Under load the sidecar can miss a hook's slice or deadline (SUBSCRIBER_QUEUED, DEADLINE, a
  // hook timeout). That is the degraded path: the restore then stays pending (US14, D 1608a3d),
  // and the next SessionStart, at a later transcript position, must deliver it. So a degraded
  // miss is retried at a later position, and only a restore that never arrives fails the test.
  const DEGRADED = new Set(['SUBSCRIBER_QUEUED', 'DEADLINE', 'TIMEOUT', 'HOOK_DEADLINE', 'HANDSHAKE_TIMEOUT']);
  const restored = (capsule, label) => {
    const reasons = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) grow(`${label}: a later turn after a degraded restore`);
      const hook = restore();
      const text = contextOf(hook);
      reasons.push(hook.reason);
      if (text?.includes(capsule)) return reasons;
      if (!DEGRADED.has(hook.reason)) break;
    }
    assert.fail(`the ${label} compaction was not restored: ${reasons.join(', ')}`);
  };

  const before = await latest();
  assert.equal(preCompact().code, 0);
  const first = await latest();
  assert.notEqual(first, before, 'the first compaction wrote no capsule');
  grow('compact summary 1');
  restored(first, 'first');

  grow('turn 2 work');
  grow('more work before the second compaction');
  const second = preCompact();
  assert.equal(second.code, 0);
  assert.notEqual(second.reason, 'DUPLICATE_DELIVERY', 'the second compaction was dropped as a duplicate');
  const secondCapsule = await latest();
  assert.notEqual(secondCapsule, first, 'the second compaction in the same session wrote no capsule');
  // A redelivery of the same PreCompact (the transcript has not moved) is still a duplicate.
  const replay = preCompact();
  assert.equal(replay.code, 0);
  assert.equal(await latest(), secondCapsule, 'a replayed PreCompact wrote another capsule');
  grow('compact summary 2');
  restored(secondCapsule, 'second');

  // A redelivery of the same SessionStart (same position) is the same event: it gets the first
  // answer again, unchanged (D's answer replay), and restores nothing new.
  const shown = contextOf(restore());
  assert.ok(shown?.includes(secondCapsule), 'the redelivery replays the restore it answered');
  // The restore was spent once: a later SessionStart restores nothing again.
  grow('a later turn after the restore');
  assert.equal(contextOf(restore()), null, 'a restore was taken twice');
});

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { certifyHooks, deliverHook } from './certified-hooks.mjs';
import { story } from './lib.mjs';

/** Launcher reasons for an event the sidecar recorded and had nothing to add to (docs/mcp.md). */
const ANSWERED_EMPTY = ['NO_PROPOSAL', 'SUBSCRIBER_QUEUED'];

/** True when a hook answer would stop or delay the harness's compaction. */
function blocks(hook) {
  if (hook.code === 2) return true;
  const out = hook.stdout.trim();
  if (out === '') return false;
  const json = JSON.parse(out);
  return json.decision === 'block' || json.continue === false || json.hookSpecificOutput?.permissionDecision === 'deny';
}

story('US14', async ({ then, sandbox, evidence }) => {
  const box = await sandbox();
  const up = box.startSidecar();
  assert.equal(up.code, 0, `sidecar start failed: ${up.stdout} ${up.stderr}`);
  box.write('work/src/index.js', 'export const x = 1;\n');
  const checkpoint = box.jevris(['checkpoint', '--constraint', 'C1: keep the CLI flags stable'], { json: true });
  assert.equal(checkpoint.code, 0, `checkpoint failed: ${checkpoint.stdout} ${checkpoint.stderr}`);
  // The Claude context hook is certified here, but the only compaction signal any harness gives
  // is the native auto trigger: no certified proactive or recovery signal exists.
  await certifyHooks(box);

  await then('It allows compaction by default and never repeatedly blocks after context exhaustion', () => {
    // Deferral cannot be turned on without a certified deferral signal.
    const enable = box.jevris(['configure', 'set', 'compaction.nativeAutoDeferral', 'true'], { json: true });
    evidence(enable.json);
    assert.equal(enable.code, 2, `deferral was enabled: ${enable.stdout}`);
    assert.match(`${enable.stdout} ${enable.stderr}`, /compaction\.nativeAutoDeferral/);
    for (const [harness, native] of [
      ['claude', { hook_event_name: 'PreCompact', session_id: 's-us14', transcript_path: join(box.dir, 's-us14.jsonl'), trigger: 'auto', custom_instructions: '', cwd: box.work }],
      ['codex', { hook_event_name: 'PreCompact', session_id: 's-us14-codex', turn_id: 't1', transcript_path: null, trigger: 'auto', cwd: box.work, model: 'gpt-5' }],
    ]) {
      const hook = deliverHook(box, harness, native);
      evidence(hook.stdout);
      assert.equal(hook.code, 0, `${harness} PreCompact exited ${hook.code}: ${hook.stderr}`);
      assert.equal(blocks(hook), false, `${harness} PreCompact blocked compaction: ${hook.stdout}`);
      // Answered by the sidecar with nothing to add; SUBSCRIBER_QUEUED when load made a subscriber miss its slice.
      assert.ok(ANSWERED_EMPTY.includes(hook.reason), `${harness} PreCompact did not reach the sidecar (${hook.reason}): ${hook.stderr}`);
      assert.equal(hook.stdout.trim(), '', `${harness} PreCompact answered the harness: ${hook.stdout}`);
    }

    // An exhausted context compacts again and again, across turns and sessions: every one is allowed.
    const answers = [];
    for (let turn = 0; turn < 6; turn += 1) {
      const session = `s-us14-exhausted-${turn % 2}`;
      answers.push(box.hook('claude', { hook_event_name: 'PreCompact', session_id: session, transcript_path: join(box.dir, `${session}.jsonl`), trigger: 'auto', custom_instructions: '', cwd: box.work }, { extraEnv: { JEVRIS_HOOK_DEADLINE_MS: '100' } }));
      answers.push(box.hook('codex', { hook_event_name: 'PreCompact', session_id: 's-us14-codex-exhausted', turn_id: `t${turn + 2}`, transcript_path: null, trigger: 'auto', cwd: box.work, model: 'gpt-5' }, { extraEnv: { JEVRIS_HOOK_DEADLINE_MS: '100' } }));
    }
    evidence(answers.map((hook) => hook.stdout));
    for (const hook of answers) {
      assert.equal(hook.code, 0, `a PreCompact exited ${hook.code}: ${hook.stderr}`);
      assert.equal(blocks(hook), false, `a repeated PreCompact blocked: ${hook.stdout}`);
    }
    // One session that keeps exhausting its context: each compaction, later in the transcript,
    // is a new delivery that Jevris handles and allows, and after each one the session resumes
    // with its constraint.
    for (let round = 1; round <= 3; round += 1) {
      box.write('s-us14-long.jsonl', `${'{"type":"assistant"}\n'.repeat(round * 25)}`);
      const native = { session_id: 's-us14-long', transcript_path: join(box.dir, 's-us14-long.jsonl'), cwd: box.work };
      const compact = deliverHook(box, 'claude', { ...native, hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: '' });
      assert.equal(compact.code, 0, `compaction ${round} exited ${compact.code}: ${compact.stderr}`);
      assert.equal(blocks(compact), false, `compaction ${round} was blocked: ${compact.stdout}`);
      assert.ok(ANSWERED_EMPTY.includes(compact.reason), `compaction ${round} was not handled as a new delivery (${compact.reason}): ${compact.stderr}`);
      const start = deliverHook(box, 'claude', { ...native, hook_event_name: 'SessionStart', source: 'compact' });
      evidence(start.stdout);
      assert.equal(start.code, 0);
      assert.equal(blocks(start), false);
      assert.match(start.stdout, /C1: keep the CLI flags stable/, `the session did not resume with its constraint after compaction ${round}: ${start.stdout} ${start.stderr}`);
    }
  });
});

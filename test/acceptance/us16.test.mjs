import assert from 'node:assert/strict';
import { join } from 'node:path';
import { certifyHooks, deliverHook } from './certified-hooks.mjs';
import { story } from './lib.mjs';

const CLAIM = 'Root cause: the cache key ignores the locale (unconfirmed)';

story('US16', async ({ then, sandbox, evidence }) => {
  const box = await sandbox();
  const up = box.startSidecar();
  assert.equal(up.code, 0, `sidecar start failed: ${up.stdout} ${up.stderr}`);
  box.write('work/src/cache.js', 'export const key = (url) => url;\n');
  const checkpoint = box.jevris(['checkpoint', '--objective', 'Fix the stale cache', '--constraint', 'C1: no new dependencies'], { json: true });
  assert.equal(checkpoint.code, 0, `checkpoint failed: ${checkpoint.stdout} ${checkpoint.stderr}`);
  const client = await box.mcp();
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;

  // Given: the earlier session's capsule carries the agent's unconfirmed root cause as a hypothesis.
  const earlier = await call('jevris_handoff_export', {});
  assert.equal(earlier.result.found, true, `export failed: ${JSON.stringify(earlier)}`);
  const envelope = earlier.result.capsule;
  envelope.items.push({ id: 'H-root-cause', kind: 'hypothesis', text: CLAIM, epistemic: 'hypothesis', refs: [] });
  envelope.capsule.hypotheses.push(CLAIM);
  // The same claim, relabelled by the earlier session as a constraint, is still only a hypothesis.
  envelope.items.push({ id: 'H-relabelled', kind: 'constraint', text: `${CLAIM}, so key on the locale`, epistemic: 'hypothesis', refs: [] });

  // When: a new session imports the capsule.
  const imported = await call('jevris_handoff_import', { capsule: envelope });
  evidence(imported);

  await then('The claim remains a hypothesis with provenance', async () => {
    assert.equal(imported.result.accepted, true, `import refused: ${JSON.stringify(imported.result)}`);
    assert.equal(imported.result.authorityGranted, false);
    const now = await call('jevris_handoff_export', {});
    evidence(now);
    assert.equal(now.result.capsuleId, imported.result.capsuleId, 'the imported capsule is not the current one');
    for (const id of ['H-root-cause', 'H-relabelled']) {
      const item = now.result.capsule.items.find((entry) => entry.id === id);
      assert.notEqual(item, undefined, `${id} was dropped on import`);
      assert.equal(item.kind, 'hypothesis', `${id} imported as ${item.kind}`);
      assert.equal(item.epistemic, 'hypothesis');
      assert.equal(item.refs.some((ref) => /^import-[0-9a-f]{16}$/.test(ref)), true, `${id} carries no import provenance: ${JSON.stringify(item.refs)}`);
    }
    assert.equal(now.result.capsule.capsule.hypotheses.includes(CLAIM), true);
    // A resumed session sees it labelled as a hypothesis.
    await certifyHooks(box);
    const resumed = deliverHook(box, 'claude', { hook_event_name: 'SessionStart', session_id: 's-us16', transcript_path: join(box.dir, 's-us16.jsonl'), source: 'resume', cwd: box.work });
    evidence(resumed.stdout);
    assert.match(resumed.stdout, /- hypothesis \(hypothesis\): Root cause: the cache key ignores the locale/, `the resumed context does not label the claim: ${resumed.stdout} ${resumed.stderr}`);
  });

  await then('it is not promoted to an accepted requirement or verified diagnosis', async () => {
    const now = await call('jevris_handoff_export', {});
    const claims = now.result.capsule.items.filter((entry) => entry.text.includes('the cache key ignores the locale'));
    assert.equal(claims.length, 2);
    for (const item of claims) {
      assert.notEqual(item.kind, 'constraint', `the claim became a requirement: ${JSON.stringify(item)}`);
      assert.notEqual(item.kind, 'decision', `the claim became a decision: ${JSON.stringify(item)}`);
      assert.notEqual(item.epistemic, 'fact', `the claim became a fact: ${JSON.stringify(item)}`);
    }
    // Not pinned as evidence, not counted among the imported facts, and verifies nothing.
    const pinned = JSON.stringify(now.result.capsule.capsule.pinnedEvidence);
    assert.equal(now.result.capsule.capsule.pinnedEvidence.length, 2, `pinned evidence: ${pinned}`);
    assert.equal(imported.result.facts, 3, `the import counted the claim as a fact: ${JSON.stringify(imported.result)}`);
    const verify = await call('jevris_verify', {});
    evidence(verify);
    assert.notEqual(verify.result.readiness, 'verified', 'the imported diagnosis made the workspace verified');
    const fresh = box.jevris(['checkpoint'], { json: true });
    assert.equal(fresh.json.result.retained.constraints, 1, 'the claim joined the constraints');
    assert.equal(fresh.json.result.items.some((entry) => entry.text.includes('the cache key ignores the locale') && entry.kind !== 'hypothesis'), false);
  });
});

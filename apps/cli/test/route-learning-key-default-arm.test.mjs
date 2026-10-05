// JEV-0055 through the built CLI: every learning key names its own baseline as the default arm.
// The registry's own baseline (Opus 5.5) keeps the bare slice id, and any other baseline learns
// under `<slice>::<model>`, so after Codex's baseline moved from GPT-6 Sol to GPT-6.1 Sol the old
// data stays under `<slice>::gpt-6-sol` and the new under `<slice>::gpt-6.1-sol`. `route learning
// status` (text and JSON, the whole list or one key) compares each key's arms with that key's own
// default, and a key never changes because of another key's outcomes (`explain --slice` is in
// explain-learning-key.test.mjs). Temporary HOME, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LUNA, NEW_KEY, NEW_SOL, OLD_KEY, OLD_SOL, OPUS, SLICE, seededBox } from './learning-keys-fixture.mjs';

/** The text of one slice's section of `route learning status`: its "Slice <id>:" line to the blank line that ends it. */
function section(text, key) {
  const lines = text.split('\n');
  const from = lines.findIndex((l) => l.startsWith(`Slice ${key}:`));
  assert.notEqual(from, -1, `no section for ${key} in\n${text}`);
  const rest = lines.slice(from + 1);
  const to = rest.findIndex((l) => l === '');
  return [lines[from], ...(to === -1 ? rest : rest.slice(0, to))].join('\n');
}

test('route learning status lists each key with its own baseline as the default arm, in text and in JSON', async (t) => {
  const box = await seededBox(t);
  const text = box.jevris(['route', 'learning', 'status']);
  assert.equal(text.code, 0, text.stdout + text.stderr);

  const old = section(text.stdout, OLD_KEY);
  assert.match(old, new RegExp(`^Per verified task ${OLD_SOL}: \\$1\\.0000 billed, 1\\.0 min wall time, 3 verified over 3 routes \\(the default\\)\\.$`, 'm'));
  assert.match(old, new RegExp(`^Per verified task ${LUNA}: \\$0\\.2500 billed, 0\\.5 min wall time, 1 verified over 1 routes \\(vs ${OLD_SOL}: cost 0\\.25x, usage n/a, time 0\\.50x\\)\\.$`, 'm'));
  assert.match(old, new RegExp(`^Waiting for \\d+ more local outcomes on ${OLD_SOL} \\(the default\\) before any switch\\.$`, 'm'));
  assert.doesNotMatch(old, new RegExp(`${OPUS}`), 'the GPT-6 Sol key never mentions the Opus 5.5 default');

  const newer = section(text.stdout, NEW_KEY);
  assert.match(newer, new RegExp(`^Per verified task ${NEW_SOL}: \\$1\\.5000 billed, 1\\.0 min wall time, 2 verified over 2 routes \\(the default\\)\\.$`, 'm'));
  assert.doesNotMatch(newer, new RegExp(`${OPUS}|${OLD_SOL}`));

  // The bare slice keeps Opus 5.5 as its default, exactly as before.
  const bare = section(text.stdout, SLICE);
  assert.match(bare, new RegExp(`^Per verified task ${OPUS}: \\$2\\.6667 billed, 1\\.3 min wall time, 3 verified over 4 routes \\(the default\\)\\.$`, 'm'));
  assert.match(bare, new RegExp(`^Per verified task claude-sonnet-5: .* \\(vs ${OPUS}: `, 'm'));
  assert.doesNotMatch(bare, new RegExp(`${OLD_SOL}|${NEW_SOL}`));

  const json = box.jevris(['route', 'learning', 'status'], { json: true });
  assert.equal(json.code, 0, json.stdout + json.stderr);
  const byKey = Object.fromEntries(json.json.slices.map((s) => [s.sliceId, s]));
  assert.deepEqual(Object.keys(byKey).sort(), [SLICE, OLD_KEY, NEW_KEY].sort());
  assert.deepEqual(
    Object.fromEntries(Object.entries(byKey).map(([k, s]) => [k, [s.economics.defaultArmId, s.economics.arms.filter((a) => a.isDefault).map((a) => a.armId)]])),
    { [SLICE]: [OPUS, [OPUS]], [OLD_KEY]: [OLD_SOL, [OLD_SOL]], [NEW_KEY]: [NEW_SOL, [NEW_SOL]] },
  );
  assert.deepEqual(byKey[OLD_KEY].guard.waiting.map((w) => w.armId), [OLD_SOL, LUNA]);
});

test('route learning status --slice names the key\'s own default arm, and the key\'s view does not depend on the other keys', async (t) => {
  const box = await seededBox(t);
  const one = box.jevris(['route', 'learning', 'status', '--slice', OLD_KEY], { json: true });
  assert.equal(one.code, 0, one.stdout + one.stderr);
  assert.deepEqual(one.json.slices.map((s) => s.sliceId), [OLD_KEY]);
  assert.equal(one.json.slices[0].economics.defaultArmId, OLD_SOL);
  const text = box.jevris(['route', 'learning', 'status', '--slice', OLD_KEY]).stdout;
  assert.match(text, new RegExp(`^Per verified task ${OLD_SOL}: .* \\(the default\\)\\.$`, 'm'));
  assert.doesNotMatch(text, new RegExp(`${OPUS} \\(the default\\)`));
  // The same key's explanation, whether the whole list or the key alone was asked for.
  const listed = box.jevris(['route', 'learning', 'status'], { json: true }).json.slices.find((s) => s.sliceId === OLD_KEY);
  assert.deepEqual(one.json.slices[0], listed);
});

test('jevris status carries no default arm of its own: it never names Opus 5.5 as the default of a key that is not Opus 5.5\'s', async (t) => {
  const box = await seededBox(t);
  const status = box.jevris(['status']);
  assert.equal(status.code, 0, status.stdout + status.stderr);
  assert.doesNotMatch(status.stdout, /\(the default\)/);
  const json = box.jevris(['status'], { json: true });
  assert.equal(json.code, 0, json.stdout + json.stderr);
  assert.doesNotMatch(JSON.stringify(json.json), /defaultArmId/);
});

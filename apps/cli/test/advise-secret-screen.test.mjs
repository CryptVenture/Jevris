// JEV-0065 through the real surfaces: `jevris advise C67` and the `jevris_advise` tool, over a real sidecar and a real evidence store. A question
// draft that holds a planted fake secret is refused with SECRET_BLOCKED, and the secret is in no file under the Jevris home (the evidence store
// included); a clean draft is stored as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from '../../../test/acceptance/lib.mjs';
import { managedHostSkip } from '../../../test/managed-host.mjs';

// Obviously fake, and shaped like a GitHub token, which the product's secret rules refuse.
const FAKE = `ghp_${'FAKE'.repeat(9)}`;
const DRAFT = (instructions) => ({ instructions, options: { a: 'The first option.', none: 'No option applies.' }, mandatoryEvidence: ['e1'], threshold: 0.6 });
const input = (candidate) => ({ specId: 'my-spec', current: DRAFT('Which option applies?'), candidate: DRAFT(candidate), misclassifications: [{ expected: 'a', got: 'none' }] });

function filesHolding(dir, text, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) filesHolding(path, text, out);
    else if (stat.isFile()) {
      try {
        if (readFileSync(path).includes(text)) out.push(path);
      } catch {
        // a file that is gone or locked holds nothing to find
      }
    }
  }
  return out;
}

test('advise C67 with a planted fake secret in the candidate is refused over a real sidecar: no secret in the output, and none under the home', { skip: managedHostSkip() }, async (t) => {
  const box = await sandbox(t);
  box.write('work/src/app.js', 'export const x = 1;\n');
  box.gitInit();
  assert.equal(box.startSidecar().code, 0);

  // From a file, so the secret is not in this command's argv either.
  const file = box.write('secret-C67.json', JSON.stringify(input(`${FAKE} which one option applies best?`)));
  const refused = box.jevris(['advise', 'C67', '--input-file', file], { json: true });
  assert.equal(refused.code, 0, refused.stdout + refused.stderr);
  assert.equal(refused.json.result.capabilityId, 'C67');
  assert.equal(refused.json.result.reasonCode, 'SECRET_BLOCKED');
  assert.equal(refused.json.result.verb, 'abstain');
  assert.equal(refused.json.result.source, 'rules');
  assert.deepEqual(refused.json.result.evidenceIds, []);
  assert.equal(refused.stdout.includes(FAKE) || refused.stderr.includes(FAKE), false, 'the secret is in the command output');
  const plain = box.jevris(['advise', 'C67', '--input-file', file]);
  assert.equal(plain.stdout.includes(FAKE) || plain.stderr.includes(FAKE), false, 'the secret is in the plain-text output');
  assert.match(plain.stdout, /secret/i);

  // The same through the tool.
  const client = await box.mcp();
  const viaTool = (await client.callTool({ name: 'jevris_advise', arguments: { capabilityId: 'C67', input: input(`${FAKE} which one option applies best?`) } })).structuredContent;
  assert.equal(viaTool.result.reasonCode, 'SECRET_BLOCKED');
  assert.equal(JSON.stringify(viaTool).includes(FAKE), false, 'the secret is in the tool result');

  assert.deepEqual(filesHolding(box.home, FAKE).map((p) => p.replace(box.home, '<home>')), [], 'the planted secret was written into the Jevris home');
  assert.equal(box.git('for-each-ref', 'refs/heads/jevris').stdout.trim(), '', 'no proposal branch');

  // A clean draft is stored behind an evidence handle, as before.
  const clean = box.jevris(['advise', 'C67', '--input', JSON.stringify(input('Which one option applies best?'))], { json: true });
  assert.equal(clean.code, 0, clean.stdout + clean.stderr);
  assert.notEqual(clean.json.result.reasonCode, 'SECRET_BLOCKED');
  assert.equal(clean.json.result.verb, 'report');
  assert.ok(clean.json.result.evidenceIds.length >= 1, 'the proposal is behind an evidence handle');
});

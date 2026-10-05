// JEV-0065: a capability that stores text it was given (a question proposal, a campaign plan) screens that text for credentials first. A finding
// stops the capability with SECRET_BLOCKED before anything is sent, stored or written to a branch; clean text is stored as before. The
// invariant is the one docs/privacy.md states for every request, applied to what is kept as well: a planted fake secret is in no request and in
// no file under the Jevris home or its evidence store, with source egress approved or not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { adviseFixture, filesHolding, git } from './advise-fixture.mjs';

// Obviously fake, and shaped like a GitHub token (`ghp_` and 36 letters or digits), which the product's secret rules refuse.
const FAKE = `ghp_${'FAKE'.repeat(9)}`;
// A second shape, an assignment: the packet builder's env-assignment rule (and the contracts' entropy pattern) are not the same rule as the token above.
const FAKE_ASSIGNMENT = 'API_TOKEN=fake-not-a-real-value-0000';

const DRAFT = (instructions = 'Which option applies?') => ({ instructions, options: { a: 'The first option.', none: 'No option applies.' }, mandatoryEvidence: ['e1'], threshold: 0.6 });
/**
 * One input per text field of a C67 request, with `secret` planted in that field only. A field that holds an identifier (the spec id, an option key,
 * an evidence name, a misclassification's option) can hold only a token-shaped secret, so `ids` says whether the secret fits an identifier.
 */
function plantedInputs(secret, ids) {
  const base = () => ({ specId: 'my-spec', current: DRAFT(), candidate: DRAFT('Which one option applies best?'), misclassifications: [{ expected: 'a', got: 'none' }] });
  const cases = {
    'current.instructions': { ...base(), current: DRAFT(`Which option applies? ${secret}`) },
    'current.options (text)': { ...base(), current: { ...DRAFT(), options: { a: `The first option ${secret}`, none: 'No option applies.' } } },
    'current.mandatoryEvidence': { ...base(), current: { ...DRAFT(), mandatoryEvidence: [secret] } },
    'candidate.instructions': { ...base(), candidate: DRAFT(`Which one option applies best? ${secret}`) },
    'candidate.options (text)': { ...base(), candidate: { ...DRAFT('Which one option applies best?'), options: { a: `The first option ${secret}`, none: 'No option applies.' } } },
    'candidate.mandatoryEvidence': { ...base(), candidate: { ...DRAFT('Which one option applies best?'), mandatoryEvidence: ['e1', secret] } },
  };
  if (ids) {
    cases['specId'] = { ...base(), specId: secret };
    cases['current.options (key)'] = { ...base(), current: { ...DRAFT(), options: { [secret]: 'The first option.', none: 'No option applies.' } } };
    cases['candidate.options (key)'] = { ...base(), candidate: { ...DRAFT('Which one option applies best?'), options: { [secret]: 'The first option.', none: 'No option applies.' } } };
    cases['misclassifications.expected'] = { ...base(), misclassifications: [{ expected: secret, got: 'none' }] };
    cases['misclassifications.got'] = { ...base(), misclassifications: [{ expected: 'a', got: secret }] };
  }
  return cases;
}

for (const egress of [true, false]) {
  test(`C67 with a planted fake secret in any text field is stopped before anything is sent or stored (source egress ${egress ? 'approved' : 'denied'})`, async (t) => {
    const f = await adviseFixture(t, { egress });
    for (const secret of [FAKE, FAKE_ASSIGNMENT]) {
      for (const [field, input] of Object.entries(plantedInputs(secret, secret === FAKE))) {
        for (const writeBranch of [false, true]) {
          const result = await f.advise('C67', { ...input, writeBranch });
          assert.equal(result.ok, true, field);
          const advice = result.advice;
          const where = `${field} (${secret.slice(0, 8)}, writeBranch ${String(writeBranch)})`;
          assert.equal(advice.reasonCode, 'SECRET_BLOCKED', where);
          assert.equal(advice.verb, 'abstain', where);
          assert.equal(advice.source, 'rules', where);
          assert.equal(advice.decisionId, null, `${where}: no decision was made`);
          assert.deepEqual(advice.evidenceIds, [], `${where}: nothing was stored behind a handle`);
          assert.equal(advice.recommendation, null, where);
          // The refusal says where and why, never what: the secret is not echoed.
          assert.equal(JSON.stringify(advice).includes(secret), false, `${where}: the refusal echoed the secret`);
          assert.match(advice.summary, /secret/i, where);
        }
      }
    }
    assert.equal(f.requests.length, 0, 'no request was sent for a draft that holds a secret');
    for (const secret of [FAKE, FAKE_ASSIGNMENT]) {
      assert.deepEqual(filesHolding(f.dir, secret), [], `the secret ${secret.slice(0, 8)} is in a file under the home or the repository`);
      assert.deepEqual(filesHolding(f.engineHome, secret), [], 'the secret is in the engine journal');
    }
    // Nothing of the proposal was written either: no evidence of its kind, and no proposal branch.
    assert.equal(git(f.repo, 'for-each-ref', 'refs/heads/jevris').trim(), '', 'a proposal branch was written for a refused draft');
  });
}

test('C67 with a clean draft is stored as before, with egress approved or not', async (t) => {
  for (const egress of [true, false]) {
    const f = await adviseFixture(t, { egress });
    const result = await f.advise('C67', { specId: 'my-spec', current: DRAFT(), candidate: DRAFT('Which one option applies best?'), misclassifications: [{ expected: 'a', got: 'none' }], writeBranch: true });
    assert.equal(result.ok, true);
    const advice = result.advice;
    assert.notEqual(advice.reasonCode, 'SECRET_BLOCKED');
    assert.equal(advice.verb, 'report');
    assert.equal(advice.evidenceIds.length >= 1, true, 'the proposal is behind an evidence handle');
    const stored = advice.evidenceIds.map((id) => JSON.parse(new TextDecoder().decode(f.ws.evidence.get(id, f.ws.workspaceId))));
    const proposal = stored.find((record) => record.schemaVersion === 'jevris-question-proposal-1');
    assert.ok(proposal, 'the question proposal is stored');
    assert.equal(proposal.schemaVersion, 'jevris-question-proposal-1');
    assert.equal(proposal.specId, 'my-spec');
    assert.equal(proposal.candidate.instructions, 'Which one option applies best?');
    assert.equal(proposal.live, false);
    assert.match(git(f.repo, 'for-each-ref', 'refs/heads/jevris').trim(), /refs\/heads\/jevris\/proposals\/my-spec-/, 'the proposal branch is written for a clean draft');
  }
});

test('a sensitive path name in a draft is not a secret: it is stored, as it is not sent', async (t) => {
  const f = await adviseFixture(t, { egress: false });
  const result = await f.advise('C67', { specId: 'my-spec', current: DRAFT('Which option applies to the .env file?'), candidate: DRAFT('Which option applies to the .env file, or none?') });
  assert.equal(result.advice.reasonCode === 'SECRET_BLOCKED', false);
  assert.equal(result.advice.evidenceIds.length >= 1, true);
});

test('C70 stores the module paths a caller names in its campaign plan, so a secret in one is refused before anything is stored', async (t) => {
  for (const egress of [true, false]) {
    const f = await adviseFixture(t, { egress });
    for (const input of [
      { campaignId: 'camp1', modules: ['pkg/a', `pkg/${FAKE}`], contract: 'rename the helper' },
      { campaignId: 'camp1', modules: ['pkg/a', 'pkg/b'], canary: `pkg/${FAKE}`, contract: 'rename the helper' },
      { campaignId: FAKE, modules: ['pkg/a', 'pkg/b'], contract: 'rename the helper' },
    ]) {
      const advice = (await f.advise('C70', input)).advice;
      assert.equal(advice.reasonCode, 'SECRET_BLOCKED');
      assert.equal(advice.source, 'rules');
      assert.deepEqual(advice.evidenceIds, []);
      assert.equal(JSON.stringify(advice).includes(FAKE), false);
    }
    assert.equal(f.requests.length, 0);
    assert.deepEqual(filesHolding(f.dir, FAKE), []);
    // Clean modules still make a plan.
    const clean = (await f.advise('C70', { campaignId: 'camp1', modules: ['pkg/a', 'pkg/b'], contract: 'rename the helper', waveSize: 2 })).advice;
    assert.equal(clean.verb, 'rank');
    assert.equal(clean.evidenceIds.some((id) => id.startsWith('ev:')), true, 'the plan is behind an evidence handle');
  }
});

for (const egress of [true, false]) {
  test(`a fake secret planted in the quoted field of every capability reached through advise is in no file under the home (source egress ${egress ? 'approved' : 'denied'})`, async (t) => {
    const f = await adviseFixture(t, {
      egress,
      files: { 'src/cart.js': 'export function calculateTotal(items) {\n  return items.reduce((n, i) => n + i.price, 0);\n}\n', 'docs/guide.md': '# Install guide\n\nInstall the app, then run the setup.\n' },
      skills: { 'run-tests': 'Run the unit tests of a project', 'write-docs': 'Write documentation for a project' },
    });
    const quoted = {
      C33: { intent: `${FAKE} run the unit tests`, maxItems: 4 },
      C34: { query: `${FAKE} calculate total`, maxItems: 3 },
      C35: { query: `${FAKE} install guide setup`, maxItems: 3 },
      C36: { intent: `${FAKE} run the tests`, tools: [{ id: 'run_tests', description: 'Run the unit tests', effects: ['exec'] }, { id: 'edit_file', description: 'Edit a file', effects: ['write'] }], allowlist: ['run_tests', 'edit_file'], permittedEffects: ['exec', 'write'] },
      C37: { tool: 'Bash', args: { command: `ls -la ${FAKE}` }, writeScopes: ['src'] },
      C40: { findings: [{ id: 'f1', text: `${FAKE} the save button is cut off at the right edge`, source: 'screenshot' }] },
      C62: { incidents: [{ id: 'inc1', severity: 'high', resolved: false }], rollout: { stages: ['canary', 'all'], rollbackPlan: `revert the release ${FAKE}` }, exceptions: [{ id: 'ex1', resolved: true }] },
      C67: { specId: 'my-spec', current: DRAFT(), candidate: DRAFT(`${FAKE} which one option applies best?`), misclassifications: [{ expected: 'a', got: 'none' }] },
      C70: { campaignId: 'camp1', modules: ['pkg/a', 'pkg/b'], contract: `${FAKE} rename the helper across modules`, waveSize: 2 },
    };
    for (const [id, input] of Object.entries(quoted)) {
      const result = await f.advise(id, input);
      assert.equal(result.ok, true, id);
      assert.equal(JSON.stringify(result.advice).includes(FAKE), false, `${id}: the secret is in the advice`);
    }
    assert.equal(JSON.stringify(f.requests).includes(FAKE), false, 'a secret left in a request');
    assert.deepEqual(filesHolding(f.dir, FAKE).map((p) => p.replace(f.dir, '')), [], 'the planted secret was written under the home or the repository');
    assert.deepEqual(filesHolding(f.engineHome, FAKE), [], 'the planted secret is in the engine journal');
  });
}

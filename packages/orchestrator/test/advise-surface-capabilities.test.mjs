// The thirteen capabilities reached through `jevris advise` and `jevris_advise` (C32 to C38, C40, C62, C67, C69, C70, C72), run with
// exactly the input their surface accepts, through the real engine and its packet builder against a scripted Jev (no live call). Per id:
// the advice is the contract's envelope with every guard false; Jev answers when asked and its decision is recorded; and with source egress
// denied nothing quoted from the input (a marker planted in each) is in any request, while with it approved the text goes where the
// capability reads it, so the egress check is not vacuous. C32, C69 and C72 ask from counts and flags alone and are asked either way.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { surfacePayloadContract } from '@jevris/contracts';
import { createSidecarEngine } from '@jevris/provider-typesafe';
import { adviseCapability, approveManifests, manifestHash, openWorkspace, parseManifest } from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

/** A scripted Jev: a valid, confident answer to whatever is asked (the first option of a Choice, the middle anchor of a Score, a Noul of 0.9). */
function scriptedJev() {
  const requests = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      if (q.type === 'noul') answers[id] = { type: 'noul', noul: 0.9 };
      else if (q.type === 'score') {
        const n = q.criteria.length;
        const probabilities = Object.fromEntries(q.criteria.map((_, i) => [String(i), i === 2 ? 0.9 : Math.round((0.1 / (n - 1)) * 1000) / 1000]));
        // A Score's `score` is the expected value of its distribution, as the real API gives it.
        const score = Math.round(Object.entries(probabilities).reduce((sum, [level, p]) => sum + Number(level) * p, 0) * 100) / 100;
        answers[id] = { type: 'score', score, probabilities, legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])), confidence: 0.9 };
      } else {
        const keys = Object.keys(q.criteria);
        const pick = keys.find((k) => k !== 'none' && k !== 'unknown') ?? keys[0];
        const probabilities = Object.fromEntries(keys.map((k) => [k, k === pick ? 0.9 : 0.1 / (keys.length - 1)]));
        answers[id] = { type: 'choice', choice: pick, probabilities, confidence: 0.9 };
      }
    }
    return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 400, output_tokens: 20 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, requests };
}

async function fixture(t, { egress, files = {}, skills = {} }) {
  const dir = tempDir('jv-adv-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const put = (root, rel, text) => {
    mkdirSync(join(root, ...rel.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(root, ...rel.split('/')), text);
  };
  put(repo, 'README.md', '# app\n');
  for (const [rel, text] of Object.entries(files)) put(repo, rel, text);
  for (const [name, description] of Object.entries(skills)) put(home, `.claude/skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`);
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  const store = testStore(dir);
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
  const script = scriptedJev();
  const engineHome = mkdtempSync(join(tmpdir(), 'jevris-adv-engine-'));
  const engine = await createSidecarEngine({ home: engineHome, credential: 'test-key-not-a-secret', fetch: script.fetch, env: {}, sourceEgress: () => ({ provenance: 'administrator', sourceEgress: egress ? 'approved-scoped' : 'deny-until-approved' }) });
  t.after(() => {
    closeTestStore(store);
    rmSync(dir, { recursive: true, force: true });
    rmSync(engineHome, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  return {
    ws, home, engine, requests: script.requests,
    advise: (capabilityId, input = {}) => adviseCapability(ws, { capabilityId, input, home, env: { HOME: home }, engine, egressApproved: egress, remainingMs: 60_000 }),
    evidence: (text) => ws.evidence.put({ workspaceId: ws.workspaceId, kind: 'tool-output', bytes: new TextEncoder().encode(text), nowMs: Date.now() }).then((m) => m.handle),
  };
}

const UNIT = { id: 'unit', argv: [process.execPath, '-e', '0'], resultFormat: 'exit-code', mandatory: true };
const DRAFT = (instructions) => ({ instructions, options: { a: 'The first option.', none: 'No option applies.' }, mandatoryEvidence: ['e1'], threshold: 0.6 });

/**
 * `ask`: when Jev is asked with source egress denied: `always` (counts and flags only) or `egress-only` (the question quotes text, so nothing is sent
 * unless egress is approved) or `evidence` (a request goes, with the quoted evidence withheld by the packet builder). `marker`: planted in the input.
 */
const CASES = {
  C32: { ask: 'always', marker: null, input: () => ({ harness: 'claude', collaborative: false }) },
  C33: { ask: 'egress-only', marker: 'MARKINTENT', files: {}, skills: { 'run-tests': 'Run the unit tests of a project', 'write-docs': 'Write documentation for a project' }, input: () => ({ intent: 'MARKINTENT run the unit tests', maxItems: 4 }) },
  C34: { ask: 'evidence', marker: 'MARKQUERY', files: { 'src/cart.ts': 'export function calculateTotal(items) {\n  return items.reduce((n, i) => n + i.price, 0);\n}\n' }, input: () => ({ query: 'MARKQUERY calculate total', maxItems: 3 }) },
  C35: { ask: 'evidence', marker: 'MARKQUERY', files: { 'docs/guide.md': '# Install guide\n\nInstall the app with the installer, then run the setup.\n' }, input: () => ({ query: 'MARKQUERY install guide setup', maxItems: 3 }) },
  C36: { ask: 'egress-only', marker: 'MARKINTENT', input: () => ({ intent: 'MARKINTENT run the tests', tools: [{ id: 'run_tests', description: 'Run the unit tests', effects: ['exec'] }, { id: 'edit_file', description: 'Edit a file', effects: ['write'] }], allowlist: ['run_tests', 'edit_file'], permittedEffects: ['exec', 'write'] }) },
  C37: { ask: 'evidence', marker: 'MARKCMD', input: () => ({ tool: 'Bash', args: { command: 'ls -la MARKCMD' }, writeScopes: ['src'] }) },
  C38: { ask: 'evidence', marker: 'MARKOUT', input: async (f) => ({ handle: await f.evidence('npm test\nError: connect ECONNREFUSED 127.0.0.1:5432 MARKOUT\n') }) },
  C40: { ask: 'evidence', marker: 'MARKFINDING', input: () => ({ findings: [{ id: 'f1', text: 'MARKFINDING the save button is cut off at the right edge', source: 'screenshot' }] }) },
  C62: { ask: 'evidence', marker: 'MARKINC', input: () => ({ incidents: [{ id: 'MARKINC', severity: 'high', resolved: false }], rollout: { stages: ['canary', 'all'], rollbackPlan: 'revert the release' } }) },
  C67: { ask: 'evidence', marker: 'MARKSPEC', input: () => ({ specId: 'my-spec', current: DRAFT('Which option applies?'), candidate: DRAFT('MARKSPEC which one option applies best?'), misclassifications: [{ expected: 'a', got: 'none' }] }) },
  C69: { ask: 'always', marker: null, input: async (f) => ({ reports: [{ id: 'r1', model: 'model-one', conclusion: 'yes', evidenceIds: [await f.evidence('first proof')], sources: ['s1'] }, { id: 'r2', model: 'model-two', conclusion: 'no', evidenceIds: [await f.evidence('second proof')], sources: ['s2'] }] }) },
  C70: { ask: 'egress-only', marker: 'MARKCONTRACT', approve: true, input: () => ({ campaignId: 'camp1', modules: ['pkg/a', 'pkg/b'], contract: 'MARKCONTRACT rename the helper across modules', waveSize: 2 }) },
  C72: { ask: 'always', marker: null, approve: true, input: () => ({}) },
};

for (const id of Object.keys(CASES)) {
  const c = CASES[id];
  test(`${id}: through its surface input, with egress denied nothing quoted is sent and the rules answer; with egress approved Jev is asked, answers and is recorded`, async (t) => {
    for (const egress of [false, true]) {
      const f = await fixture(t, { egress, files: c.files ?? {}, skills: c.skills ?? {} });
      if (c.approve === true) {
        const m = parseManifest(UNIT).manifest;
        await approveManifests(f.ws, [m], { [m.id]: manifestHash(m) }, 'test');
      }
      const input = await c.input(f);
      const result = await f.advise(id, input);
      assert.equal(result.ok, true, `${id} egress=${String(egress)}: ${JSON.stringify(result)}`);
      const advice = result.advice;
      // The advice is the contract's envelope, and nothing was applied, granted, run or certified.
      assert.equal(advice.capabilityId, id);
      assert.equal(surfacePayloadContract('capability.advise').validate(advice).ok, true, `${id}: ${JSON.stringify(surfacePayloadContract('capability.advise').validate(advice))}`);
      assert.deepEqual(advice.guards, { applied: false, authorityGranted: false, verified: false, permissionChanged: false, executed: false, allowlistExpanded: false, certified: false });
      const wire = JSON.stringify(f.requests);
      if (!egress) {
        if (c.marker !== null) assert.equal(wire.includes(c.marker), false, `${id}: the marker ${c.marker} left with egress denied`);
        if (c.ask === 'egress-only') assert.equal(f.requests.length, 0, `${id}: a question that quotes text is not asked without egress`);
        if (c.ask === 'always') assert.ok(f.requests.length >= 1, `${id}: asked from counts and flags with egress denied`);
        if (c.ask === 'egress-only') assert.equal(advice.source, 'rules', `${id}: the rules answered`);
      } else {
        assert.ok(f.requests.length >= 1, `${id}: asked with egress approved`);
        assert.equal(advice.source, 'jev', `${id}: Jev's answer was used`);
        assert.ok(typeof advice.decisionId === 'string', `${id}: the decision is recorded`);
        const record = await f.engine.lookup(advice.decisionId);
        assert.equal(record.specId, `d-${id.toLowerCase()}`, `${id}: the record is the capability's own decision`);
        assert.notEqual(record.outcome, 'abstained');
        if (c.marker !== null) assert.equal(wire.includes(c.marker), true, `${id}: with egress approved the text goes where the capability reads it`);
      }
    }
  });
}

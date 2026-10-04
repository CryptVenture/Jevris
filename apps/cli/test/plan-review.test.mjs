// Jev as a reviewer of a plan (C03 and C07): `jevris plan --graph` and the jevris_plan tool carry requirements and
// candidate plans to the plan op, and the result's review is printed. Review scores are aids, never a feasibility
// verdict. Fake ports: no sidecar, no model, no real home.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.JEVRIS_SIDECAR_AUTOSTART = '0';

const { runPublicCommand } = await import('../dist/public-commands.js');
const { surfacePayloadContract } = await import('../../../packages/contracts/dist/index.js');
const { TOOLS } = await import('../../../packages/mcp/dist/tools.js');

const NOT_RUNNING = { ok: false, reason: 'unavailable', reasonCode: 'NOT_RUNNING', message: 'The Jevris sidecar is not running.' };

function sandbox(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-plan-review-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const work = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(join(work, '.git'), { recursive: true });
  return { dir, home, work, env: { JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0' } };
}

function fakePorts(answers = {}) {
  const calls = [];
  return {
    calls,
    ports: {
      sidecar: {
        async ensure() {
          return { ok: true, endpoint: 'fake', started: false };
        },
        async request(input) {
          calls.push(input);
          const answer = answers[input.op];
          return answer === undefined ? NOT_RUNNING : { ok: true, result: answer };
        },
      },
      engine: {},
      config: {},
    },
  };
}

const node = (id) => ({ id, schemaVersion: '1.0', workspaceId: 'ws1', revision: 'r1', state: 'proposed', requirementIds: ['R1'], dependencyIds: [], writeScopes: [`src/${id}/a.ts`], acceptanceCheckIds: ['unit-test'], rootBudgetId: 'b1' });
const REQUIREMENTS = [{ id: 'R1', text: 'Users can log in with a password.' }, { id: 'R2', text: 'Users can reset a forgotten password by email.' }];
const CANDIDATES = [{ id: 'p1', summary: 'Add the flag and ship behind it', constraints: ['no downtime'], tradeoffs: ['slower rollout'] }, { id: 'p2', summary: 'Rewrite the module' }];

const PLAN = { valid: true, taskCount: 1, order: ['T1'], waves: [['T1']], criticalPath: ['T1'], ready: ['T1'], issues: [], advice: ['1 wave(s); the critical path has 1 task(s).'] };
const REVIEW = {
  decomposition: { label: 'decomposition-review-score', isFeasibility: false, issues: [{ id: 'R2', code: 'REQUIREMENT_UNCOVERED' }], coverage: [{ requirementId: 'R1', score: 3 }, { requirementId: 'R2', score: 0 }], reasonCode: 'SCORED', decisionId: 'dec-0123456789abcdef' },
  plans: { label: 'plan-review-score', isFeasibility: false, reviewRequired: true, ranking: [{ planId: 'p2', rank: 1, score: 2 }, { planId: 'p1', rank: 2, score: 2 }], note: 'A review score, not a feasibility verdict; a person reviews every plan.', reasonCode: 'SCORED', decisionId: null },
};

async function run(box, argv, options = {}) {
  let text = '';
  const code = await runPublicCommand('plan', argv, (chunk) => (text += chunk), { env: box.env, cwd: box.work, ...options });
  return { code, text };
}

test('a graph file with requirements and candidates sends them to the plan op, and the review is printed with what it is', async (t) => {
  const box = sandbox(t);
  const file = join(box.dir, 'graph.json');
  writeFileSync(file, JSON.stringify({ tasks: [node('T1')], requirements: REQUIREMENTS, candidates: CANDIDATES }));
  const payload = { ...PLAN, review: REVIEW };
  assert.equal(surfacePayloadContract('plan').validate(payload).ok, true);
  const fake = fakePorts({ plan: payload });
  const out = await run(box, ['--graph', file], { ports: fake.ports });
  assert.equal(out.code, 0);
  const body = fake.calls.at(-1).body;
  assert.deepEqual([body.requirements, body.candidates], [REQUIREMENTS, CANDIDATES]);
  const lines = out.text.split('\n');
  assert.ok(lines.includes('review: how the tasks cover each requirement (a review score from 0 to 4, not a feasibility verdict; reason SCORED)'), out.text);
  assert.ok(lines.includes('requirement R1: coverage 3 of 4') && lines.includes('requirement R2: coverage 0 of 4') && lines.includes('requirement R2: REQUIREMENT_UNCOVERED'), out.text);
  assert.ok(lines.includes('decision: dec-0123456789abcdef (jevris explain dec-0123456789abcdef)'), out.text);
  assert.ok(lines.includes('review: the candidate plans (a review score from 0 to 4, not a feasibility verdict; reason SCORED)'), out.text);
  assert.ok(lines.includes('plan p2: rank 1, score 2 of 4') && lines.includes('plan p1: rank 2, score 2 of 4'), out.text);
});

test('a plain list of tasks, or a graph with neither, sends no requirements and no candidates, and prints no review', async (t) => {
  const box = sandbox(t);
  const file = join(box.dir, 'graph.json');
  writeFileSync(file, JSON.stringify([node('T1')]));
  const fake = fakePorts({ plan: PLAN });
  const out = await run(box, ['--graph', file], { ports: fake.ports });
  assert.equal(out.code, 0);
  const body = fake.calls.at(-1).body;
  assert.equal('requirements' in body || 'candidates' in body, false);
  assert.doesNotMatch(out.text, /review:/);
});

test('with no sidecar, the plan is checked by rules alone: nothing is reviewed, and the lists do not stop it', async (t) => {
  const box = sandbox(t);
  const file = join(box.dir, 'graph.json');
  writeFileSync(file, JSON.stringify({ tasks: [node('T1')], requirements: REQUIREMENTS, candidates: CANDIDATES }));
  const out = await run(box, ['--graph', file, '--json'], { ports: fakePorts().ports });
  assert.equal(out.code, 0);
  const value = JSON.parse(out.text.trim());
  assert.equal(value.mode, 'reduced');
  assert.equal('review' in value.result, false);
});

test('a requirements list that is not a list, or is too long, is refused before anything is sent', async (t) => {
  const box = sandbox(t);
  const file = join(box.dir, 'graph.json');
  const fake = fakePorts({ plan: PLAN });
  writeFileSync(file, JSON.stringify({ tasks: [node('T1')], requirements: 'all of them' }));
  const bad = await run(box, ['--graph', file], { ports: fake.ports });
  assert.notEqual(bad.code, 0);
  writeFileSync(file, JSON.stringify({ tasks: [node('T1')], candidates: Array.from({ length: 13 }, (_, i) => ({ id: `p${i}`, summary: 'x' })) }));
  const long = await run(box, ['--graph', file], { ports: fake.ports });
  assert.notEqual(long.code, 0);
  assert.equal(fake.calls.length, 0);
});

test('the jevris_plan tool takes requirements and candidates, and says what they return', () => {
  const tool = TOOLS.find((x) => x.name === 'jevris_plan');
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['candidates', 'requirements', 'tasks']);
  assert.deepEqual(tool.inputSchema.required, ['tasks']);
  assert.equal(tool.inputSchema.properties.requirements.maxItems, 64);
  assert.equal(tool.inputSchema.properties.candidates.maxItems, 12);
  assert.match(tool.description, /review scores/);
});

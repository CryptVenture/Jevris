// Owner decision 2026-10-01 (Jev as an active decision aid): `jevris plan` and `jevris plan --submit`
// print one short line per task with the slice and risk the route classifier gives it. A label for a
// person, advice only; it is not part of the plan. Fake ports: no sidecar, no model, no real home.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.JEVRIS_SIDECAR_AUTOSTART = '0';

const { runPublicCommand } = await import('../dist/public-commands.js');
const { main } = await import('../dist/cli.js');
const { checkPlanSubmitResult } = await import('../dist/plan-submit.js');
const { surfacePayloadContract } = await import('../../../packages/contracts/dist/index.js');
const { TOOLS } = await import('../../../packages/mcp/dist/tools.js');
const { INSTRUCTIONS, INSTRUCTIONS_MAX_BYTES } = await import('../../../packages/mcp/dist/server.js');

const NOT_RUNNING = { ok: false, reason: 'unavailable', reasonCode: 'NOT_RUNNING', message: 'The Jevris sidecar is not running.' };

function sandbox(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-plan-slices-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const work = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(join(work, '.git'), { recursive: true });
  return { dir, home, work, env: { JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0' } };
}

function node(id, extra = {}) {
  return { id, schemaVersion: '1.0', workspaceId: 'ws1', revision: 'r1', state: 'proposed', requirementIds: ['R1'], dependencyIds: [], writeScopes: [`src/${id}/a.ts`, `src/${id}/b.ts`], acceptanceCheckIds: ['unit-test'], rootBudgetId: 'b1', ...extra };
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
          if (answer === undefined) return NOT_RUNNING;
          return { ok: true, result: answer };
        },
      },
      engine: {},
      config: {},
    },
  };
}

async function run(box, argv, options = {}) {
  let text = '';
  const code = await runPublicCommand('plan', argv, (chunk) => (text += chunk), { env: box.env, cwd: box.work, ...options });
  return { code, text };
}

function graphFile(box, tasks) {
  const file = join(box.dir, 'graph.json');
  writeFileSync(file, JSON.stringify(tasks));
  return file;
}

const sug = (taskId, extra = {}) => ({ taskId, slice: 'bounded-edit', source: 'rules', risk: 'low', confidencePercent: null, reasonCode: 'SLICE_RULES_SURE', decisionId: null, ...extra });

const PLAN = {
  valid: true, taskCount: 2, order: ['T1', 'T2'], waves: [['T1'], ['T2']], criticalPath: ['T1', 'T2'], ready: ['T1'], issues: [], advice: ['2 wave(s); the critical path has 2 task(s).'],
};

test('plan prints one line per task: who suggested the slice, the risk, and what was kept as given', async (t) => {
  const box = sandbox(t);
  const payload = {
    ...PLAN,
    taskCount: 6,
    order: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'],
    sliceSuggestions: [
      sug('T1', { slice: 'bounded-edit', source: 'jev', confidencePercent: 86, reasonCode: 'SLICE_JEV', decisionId: 'd-aaa' }),
      sug('T2', { slice: 'docs', source: 'rules' }),
      sug('T3', { slice: 'refactor', source: 'given', suggestedSlice: 'refactor', suggestedBy: 'jev', agrees: true, risk: 'low' }),
      sug('T4', { slice: 'feature', source: 'given', suggestedSlice: 'issue-fix', suggestedBy: 'jev', agrees: false, risk: 'medium' }),
      sug('T5', { slice: null, source: 'none', risk: 'high', reasonCode: 'SLICE_HIGH_RISK' }),
      sug('T6', { slice: 'bounded-edit', source: 'rules', reasonCode: 'PLAN_JEV_CAP' }),
    ],
  };
  assert.equal(surfacePayloadContract('plan').validate(payload).ok, true);
  const fake = fakePorts({ plan: payload });
  const out = await run(box, ['--graph', graphFile(box, [node('T1')])], { ports: fake.ports });
  assert.equal(out.code, 0);
  const lines = out.text.split('\n');
  assert.ok(lines.includes('task T1: slice bounded-edit (suggested by Jev, advice only); risk low'), out.text);
  assert.ok(lines.includes('task T2: slice docs (suggested by the rules, advice only); risk low'), out.text);
  assert.ok(lines.includes('task T3: slice refactor (declared in the plan; Jev agrees); risk low'), out.text);
  assert.ok(lines.includes('task T4: slice feature (declared in the plan; Jev suggests issue-fix, advice only); risk medium'), out.text);
  assert.ok(lines.includes('task T5: no slice suggested (a protected path or a high risk, so the approved baseline stays); risk high'), out.text);
  assert.ok(lines.includes('task T6: slice bounded-edit (suggested by the rules, advice only; reason PLAN_JEV_CAP); risk low'), out.text);
});

test('plan with no sidecar still labels each task from the rules, in reduced mode, and --json carries the same labels', async (t) => {
  const box = sandbox(t);
  const file = graphFile(box, [node('T1'), node('T2', { writeScopes: ['docs/guide.md'] }), node('T3', { writeScopes: ['.github/workflows/ci.yml'] })]);
  const human = await run(box, ['--graph', file], { ports: fakePorts().ports });
  assert.equal(human.code, 0);
  assert.match(human.text, /^task T1: slice bounded-edit \(suggested by the rules, advice only\); risk low$/m);
  assert.match(human.text, /^task T2: slice docs \(suggested by the rules, advice only\); risk low$/m);
  assert.match(human.text, /^task T3: no slice suggested .*; risk high$/m);
  const json = await run(box, ['--graph', file, '--json'], { ports: fakePorts().ports });
  const value = JSON.parse(json.text.trim());
  assert.equal(value.mode, 'reduced');
  assert.deepEqual(value.result.sliceSuggestions.map((x) => [x.taskId, x.slice, x.source]), [['T1', 'bounded-edit', 'rules'], ['T2', 'docs', 'rules'], ['T3', null, 'none']]);
  assert.equal(surfacePayloadContract('plan').validate(value.result).ok, true);
  // An invalid graph is labelled by nobody.
  const cyclic = await run(box, ['--graph', graphFile(box, [node('A', { dependencyIds: ['B'] }), node('B', { dependencyIds: ['A'] })]), '--json'], { ports: fakePorts().ports });
  assert.equal(cyclic.code, 1);
  assert.equal('sliceSuggestions' in JSON.parse(cyclic.text.trim()).result, false);
});

test('plan --submit prints the labels after the submit lines; a malformed label list is dropped, never a reason to doubt the submit', async (t) => {
  const box = sandbox(t);
  const file = graphFile(box, [{ id: 'a', writeScopes: ['src/a'], acceptanceCheckIds: ['unit'], expectedOutputs: ['a'], requirementIds: ['R1'] }]);
  const submitted = { accepted: true, reasonCode: 'SUBMITTED', planId: 'plan-0123456789abcdef0123', rootBudgetId: 'sprint-1', taskIds: ['a'], waves: [['a']], leaseIds: [], issues: [] };
  const args = ['--submit', '--graph', file, '--budget', 'sprint-1', '--limit-micro-usd', '5000000', '--owner', 'alice', '--yes'];
  const good = fakePorts({ 'plan.submit': { ...submitted, sliceSuggestions: [sug('a', { slice: 'issue-fix', source: 'jev', confidencePercent: 90, reasonCode: 'SLICE_JEV_OVER_RULES' })] } });
  const out = await run(box, args, { ports: good.ports });
  assert.equal(out.code, 0);
  assert.match(out.text, /^workers: none started/m);
  assert.match(out.text, /^task a: slice issue-fix \(suggested by Jev, advice only\); risk low$/m);
  assert.ok(out.text.indexOf('workers:') < out.text.indexOf('task a:'), 'the labels follow the submit lines');
  const json = await run(box, [...args, '--json'], { ports: good.ports });
  assert.equal(JSON.parse(json.text.trim()).sliceSuggestions[0].slice, 'issue-fix');
  // The request carries the plan as given: nothing of the labels goes back.
  assert.equal(JSON.stringify(good.calls.at(-1).body).includes('sliceSuggestions'), false);
  assert.deepEqual(good.calls.at(-1).body.plan.tasks, JSON.parse(JSON.stringify([{ id: 'a', writeScopes: ['src/a'], acceptanceCheckIds: ['unit'], expectedOutputs: ['a'], requirementIds: ['R1'] }])));
  // A label list that does not match its contract is left out, and the submit still reads as submitted.
  const bad = fakePorts({ 'plan.submit': { ...submitted, sliceSuggestions: [{ taskId: 'a', slice: 5 }] } });
  const dropped = await run(box, args, { ports: bad.ports });
  assert.equal(dropped.code, 0);
  assert.doesNotMatch(dropped.text, /^task a:/m);
  assert.equal(checkPlanSubmitResult({ ...submitted, sliceSuggestions: [] }).sliceSuggestions, undefined);
  // A refused plan never shows labels.
  assert.equal(checkPlanSubmitResult({ accepted: false, reasonCode: 'PLAN_INVALID', planId: null, rootBudgetId: null, taskIds: [], waves: [], leaseIds: [], issues: [], sliceSuggestions: [sug('a')] }).sliceSuggestions, undefined);
});

test('help and the MCP tool name the new field in few words; the server instructions stay within their cap', async () => {
  let help = '';
  assert.equal(await main(['help', 'plan'], (chunk) => (help += chunk)), 0);
  assert.match(help, /slice and risk hint, one line per task/);
  assert.match(help, /not stored in the plan and change nothing in it/);
  const tool = TOOLS.find((x) => x.name === 'jevris_plan');
  assert.match(tool.description, /sliceSuggestions/);
  assert.match(tool.description, /advice only/);
  assert.ok(Buffer.byteLength(INSTRUCTIONS, 'utf8') <= INSTRUCTIONS_MAX_BYTES);
});

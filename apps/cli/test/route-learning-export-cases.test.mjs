// `jevris route learning export-cases` (C 01c1e29, audit P4): the sidecar's calibration.export
// writes this workspace's local calibration cases for a person to review. The CLI asks nothing,
// sends {}, checks the reply before it prints it, and shows a refusal as its reason code only.
// Temporary home, a fake sidecar port, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runRouteLearningCommand } = await import('../dist/route-learning-command.js');

const EXPORTED = {
  schemaVersion: 'jevris-calibration-export-1',
  file: '/tmp/jevris/route-learning/calibration-cases/ws.json',
  totals: { decisions: 4, cases: 6 },
  groups: 2,
  excluded: { sessionWindowOnly: 1, notVerified: 2, noRecord: 0, noProbabilities: 1, overCap: 0 },
  lines: ['Local calibration cases: 6 from 4 decision(s) with a verified task outcome, in 2 question group(s).', 'Not turned into cases: 4 (2 not verified, 1 joined only by session, 0 without a record, 1 without a provider probability).'],
};

function sandbox(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-export-cases-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const work = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(join(work, '.git'), { recursive: true });
  return { home, work, env: { JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0' } };
}

function fakePorts(answer) {
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
          return typeof answer === 'function' ? answer(input) : answer;
        },
      },
      engine: {},
      config: {},
    },
  };
}

async function run(box, argv, ports) {
  let text = '';
  let asked = false;
  const code = await runRouteLearningCommand(['export-cases', ...argv], (chunk) => (text += chunk), { ports, env: box.env, cwd: box.work, confirm: async () => ((asked = true), false) });
  return { code, text, asked, json: argv.includes('--json') && text.startsWith('{') ? JSON.parse(text) : null };
}

test('export-cases sends {} to calibration.export, asks nothing, and prints the lines the sidecar wrote', async (t) => {
  const box = sandbox(t);
  const fake = fakePorts({ ok: true, result: EXPORTED });
  const shown = await run(box, [], fake.ports);
  assert.equal(shown.code, 0, shown.text);
  assert.equal(shown.asked, false);
  assert.equal(shown.text, `${EXPORTED.lines.join('\n')}\n`);
  const request = fake.calls.at(-1);
  assert.deepEqual([request.op, request.scope, request.budget, request.workspace], ['calibration.export', 'cli', 'background', box.work]);
  assert.deepEqual(request.body, {});

  const json = await run(box, ['--json'], fake.ports);
  assert.equal(json.code, 0);
  assert.deepEqual(json.json, { schemaVersion: '1.0', command: 'route learning export-cases', exported: EXPORTED, reasonCode: null });
});

test('export-cases shows a refusal or a reply that does not match as a reason code, and exits 1', async (t) => {
  const box = sandbox(t);
  for (const reasonCode of ['STORE_UNAVAILABLE', 'NO_DECISION_ENGINE', 'WRITE_FAILED', 'INVALID_REQUEST']) {
    const refused = await run(box, [], fakePorts({ ok: false, reason: 'refused', reasonCode }).ports);
    assert.equal(refused.code, 1);
    assert.equal(refused.text, `No calibration cases were exported (${reasonCode}).\n`);
    const json = await run(box, ['--json'], fakePorts({ ok: false, reason: 'refused', reasonCode }).ports);
    assert.deepEqual(json.json, { schemaVersion: '1.0', command: 'route learning export-cases', exported: null, reasonCode });
  }
  const down = await run(box, [], fakePorts({ ok: false, reason: 'unavailable' }).ports);
  assert.equal(down.code, 1);
  assert.match(down.text, /^No calibration cases were exported \(SIDECAR_UNAVAILABLE\)\. .*jevris sidecar start/);
  const bad = [
    { ...EXPORTED, schemaVersion: 'x' },
    { ...EXPORTED, totals: { decisions: -1, cases: 0 } },
    { ...EXPORTED, excluded: { ...EXPORTED.excluded, overCap: 1.5 } },
    { ...EXPORTED, lines: ['a\nb'] },
    { ...EXPORTED, file: 7 },
    null,
  ];
  for (const result of bad) {
    const checked = await run(box, [], fakePorts({ ok: true, result }).ports);
    assert.equal(checked.code, 1, JSON.stringify(result)?.slice(0, 80));
    assert.equal(checked.text, 'No calibration cases were exported (SIDECAR_INVALID_RESULT).\n');
  }
});

test('export-cases takes no arguments, no --yes and no other subcommand\'s flag; nothing reaches the sidecar', async (t) => {
  const box = sandbox(t);
  const fake = fakePorts({ ok: true, result: EXPORTED });
  for (const argv of [['extra'], ['--yes'], ['--slice', 'bounded-edit'], ['--clear-evidence']]) assert.equal((await run(box, argv, fake.ports)).code, 2, argv.join(' '));
  assert.equal(fake.calls.length, 0);
});

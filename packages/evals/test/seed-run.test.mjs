// The owner's seed run (quality-trial plan section 3): deterministic task pick, 24 runs with a
// seeded arm order, the owner-only guard, usage-limit pause and stop, predictions and priors.
// No harness, no network, no billing: every port is a stub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEED_PLAN, SEED_TASK_FIELDS, parseSeedTaskLines, parseSeedTasks, seedEconomics, seedEvaluationOf, seedEvaluationProblem, seedRunsHash, resolvedIdsOf, runSeed, seedGuard, seedPredictions, seedPriors, seedPrompt, seedRunOrder, selectSeedTasks, selectionValid } from '../dist/index.js';

const SHA = 'a'.repeat(40);
const H = `sha256:${'e'.repeat(64)}`;
const rows_ = (...a) => rows(...a);
function rows(n, { created = '2026-03-01T00:00:00Z', repos = n } = {}) {
  return Array.from({ length: n }, (_, i) => ({ instance_id: `org__repo${i % repos}-${i}`, repo: `org/repo${i % repos}`, base_commit: SHA, created_at: created, problem_statement: `Issue ${i}` }));
}

test('seed: the pick is deterministic, after the cutoff, one task per repository, and hashed', () => {
  const { tasks, skipped } = parseSeedTasks([...rows(20), ...rows(5, { created: '2026-01-15T00:00:00Z' }).map((r) => ({ ...r, instance_id: `${r.instance_id}-old`, repo: `old/${r.repo.split('/')[1]}` })), { instance_id: 'bad' }], 'ts');
  assert.equal(skipped, 1);
  const a = selectSeedTasks(tasks);
  const b = selectSeedTasks([...tasks].reverse());
  assert.deepEqual(a.selection, b.selection);
  assert.equal(a.selection.instanceIds.length, 12);
  assert.equal(new Set(a.tasks.map((t) => t.repo)).size, 12);
  assert.ok(a.tasks.every((t) => t.createdAt > '2026-02-01'));
  assert.equal(a.selection.revision, SEED_PLAN.revision);
  assert.equal(selectionValid(a.selection), true);
  assert.equal(selectionValid({ ...a.selection, instanceIds: [...a.selection.instanceIds].reverse() }), false);
  assert.match(selectSeedTasks(parseSeedTasks(rows(20, { repos: 5 }), 'ts').tasks).error, /only 5 repositories/);
  // A split outside the plan (Python here) is never picked.
  assert.match(selectSeedTasks(parseSeedTasks(rows(20), 'py').tasks).error, /only 0 repositories/);
});

test('seed: 24 runs, each task on Opus 5.5 at medium and Sonnet 5 at high, arm order seeded per task', () => {
  const { selection } = selectSeedTasks(parseSeedTasks(rows(20), 'ts').tasks);
  const order = seedRunOrder(selection);
  assert.equal(order.length, 24);
  assert.deepEqual(order, seedRunOrder(selection));
  for (const id of selection.instanceIds) assert.deepEqual(order.filter((r) => r.instanceId === id).map((r) => `${r.modelId}@${r.effort}`).sort(), ['claude-opus-5-5@medium', 'claude-sonnet-5@high']);
  const firsts = new Set(selection.instanceIds.map((id) => order.find((r) => r.instanceId === id).modelId));
  assert.equal(firsts.size, 2, 'both arms go first on some task');
});

test('seed: only the owner starts it: never from a test, an agent shell, without a terminal, with an API key or without the live flag', () => {
  const tty = { stdin: true, stdout: true };
  const ok = { JEVRIS_LIVE_HARNESS: '1' };
  assert.equal(seedGuard(ok, tty), null);
  assert.match(seedGuard({ ...ok, NODE_TEST_CONTEXT: 'child' }, tty), /test run/);
  assert.match(seedGuard({ ...ok, JEVRIS_TEST: '1' }, tty), /test run/);
  assert.match(seedGuard({ ...ok, CLAUDECODE: '1' }, tty), /agent's shell \(CLAUDECODE/);
  assert.match(seedGuard({ ...ok, CODEX_SANDBOX: 'seatbelt' }, tty), /agent's shell/);
  assert.match(seedGuard(ok, { stdin: false, stdout: true }), /interactive terminal/);
  assert.match(seedGuard({ ...ok, ANTHROPIC_API_KEY: 'x' }, tty), /subscription login, not an API key/);
  assert.match(seedGuard({}, tty), /JEVRIS_LIVE_HARNESS=1/);
});

test('seed: the script refuses to run from this test process before touching anything', () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'seed-run.mjs');
  const out = join(tmpdir(), `seed-guard-${process.pid}`);
  const r = spawnSync(process.execPath, [script, 'run', '--out', out], { env: { ...process.env, JEVRIS_TEST: '1', JEVRIS_LIVE_HARNESS: '1' }, encoding: 'utf8' });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /never starts from a test run/);
  assert.equal(existsSync(out), false, 'nothing was written');
});

function ports({ outcomes }) {
  const log = [];
  const recorded = [];
  const slept = [];
  let clock = Date.parse('2026-09-27T09:00:00Z');
  let i = 0;
  return {
    log,
    recorded,
    slept,
    ports: {
      prepare: async (task, spec) => ({ cwd: `work/${spec.runId}` }),
      run: async (input) => {
        const o = outcomes[i] ?? { status: 'completed' };
        i += 1;
        assert.equal(input.auth, 'subscription');
        assert.equal(input.maxBudgetUsd, 10);
        assert.equal(input.timeoutMs, 45 * 60_000);
        return { reason: '', actualModel: input.model, costUsd: 7.5, usage: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 8000, cacheCreationInputTokens: 900 }, durationMs: 1000, authMode: 'subscription', ...o };
      },
      diff: async () => 'diff --git a/x b/x\n',
      record: async (e) => recorded.push(e),
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
      now: () => clock,
      log: (l) => log.push(l),
    },
  };
}

test('seed: a usage limit pauses until the reset and reruns the same run; the second hit stops; a restart resumes', async () => {
  const picked = selectSeedTasks(parseSeedTasks(rows(20), 'js').tasks);
  const p = ports({ outcomes: [{ status: 'completed' }, { status: 'usage-limit', resetAt: '2026-09-27T12:00:00Z' }, { status: 'completed' }, { status: 'completed' }, { status: 'usage-limit' }] });
  const summary = await runSeed({ selection: picked.selection, tasks: picked.tasks, done: new Set(), ports: p.ports });
  assert.equal(summary.outcome, 'stopped-usage-limit');
  assert.equal(summary.limitHits, 2);
  assert.equal(summary.runsDone, 3);
  assert.equal(p.slept.length, 1);
  assert.equal(p.slept[0], Date.parse('2026-09-27T12:00:00Z') - Date.parse('2026-09-27T09:00:00Z') + 60_000);
  const order = seedRunOrder(picked.selection);
  assert.deepEqual(p.recorded.map((r) => r.runId), order.slice(0, 3).map((r) => r.runId), 'the limited run is rerun, not skipped');
  assert.equal(p.recorded[0].tokens, 10_000);
  assert.equal(p.recorded[0].apiEquivalentUsd, 7.5);
  // The economics evidence per run: the reported charge and its basis, usage by kind, wall time, auth mode.
  assert.deepEqual([p.recorded[0].costUsd, p.recorded[0].costBasis, p.recorded[0].durationMs, p.recorded[0].authMode], [7.5, 'reported', 1000, 'subscription']);
  assert.deepEqual(p.recorded[0].usage, { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 8000, cacheCreationInputTokens: 900 });
  // A worker that reports no cost (a subscription) gets the list-price estimate from usage.
  const est = ports({ outcomes: [{ status: 'completed', costUsd: null }] });
  est.ports.estimateUsd = (modelId, usage) => (modelId.length > 0 ? usage.outputTokens / 100 : null);
  await runSeed({ selection: picked.selection, tasks: picked.tasks, done: new Set(order.slice(1).map((r) => r.runId)), ports: est.ports });
  assert.equal(est.recorded[0].apiEquivalentUsd, 1);
  assert.deepEqual([est.recorded[0].costUsd, est.recorded[0].costBasis], [null, 'list-price-estimate']);
  // Resume: the done runs are skipped.
  const q = ports({ outcomes: [] });
  const rest = await runSeed({ selection: picked.selection, tasks: picked.tasks, done: new Set(p.recorded.map((r) => r.runId)), ports: q.ports });
  assert.equal(rest.outcome, 'complete');
  assert.equal(q.recorded.length, 21);
  assert.equal(rest.runsDone, 24);
});

test('seed (access limits R63-R67): an access limit with a reset pauses like a usage limit; without one that model stops; an overload retries, then stops; neither is recorded', async () => {
  const picked = selectSeedTasks(parseSeedTasks(rows(20), 'js').tasks);
  const order = seedRunOrder(picked.selection);
  // With a reset (ISO or the port's finding), the same run is rerun after it; the second hit stops the seed.
  const reset = ports({ outcomes: [{ status: 'access-limit', resetAt: '2026-09-27T12:00:00Z' }, { status: 'completed' }, { status: 'access-limit', accessLimit: { resetAtMs: Date.parse('2026-09-27T20:00:00Z'), resetBasis: 'reported' } }] });
  const a = await runSeed({ selection: picked.selection, tasks: picked.tasks, done: new Set(), ports: reset.ports });
  assert.deepEqual([a.outcome, a.limitHits, a.runsDone], ['stopped-access-limit', 2, 1]);
  assert.deepEqual(reset.slept, [Date.parse('2026-09-27T12:00:00Z') - Date.parse('2026-09-27T09:00:00Z') + 60_000]);
  assert.deepEqual(reset.recorded.map((r) => r.runId), [order[0].runId], 'the limited run is rerun, never recorded');
  const withFinding = ports({ outcomes: [{ status: 'access-limit', accessLimit: { resetAtMs: Date.parse('2026-09-27T10:00:00Z'), resetBasis: 'rule' } }] });
  await runSeed({ selection: picked.selection, tasks: picked.tasks, done: new Set(order.slice(1).map((r) => r.runId)), ports: withFinding.ports });
  assert.deepEqual(withFinding.slept, [3_600_000 + 60_000]);

  // No reset: that model's remaining runs are skipped, the other model's run on, and the seed says so.
  const first = order[0].modelId;
  const other = order.find((r) => r.modelId !== first).modelId;
  const untimed = ports({ outcomes: [{ status: 'access-limit', accessLimit: { resetBasis: 'none' } }] });
  const b = await runSeed({ selection: picked.selection, tasks: picked.tasks, done: new Set(), ports: untimed.ports });
  assert.deepEqual([b.outcome, b.stoppedModels, b.limitHits, b.runsDone], ['stopped-access-limit', [first], 1, 12]);
  assert.equal(untimed.slept.length, 0, 'nothing waits out an untimed limit');
  assert.ok(untimed.recorded.every((r) => r.modelId === other));
  assert.ok(untimed.log.some((l) => /no reset: its remaining runs are skipped/.test(l)));

  // Overloaded: retried after 30 s, 60 s and 120 s, never recorded; a fourth stops the seed.
  const busy = ports({ outcomes: [{ status: 'overloaded' }, { status: 'overloaded' }, { status: 'completed' }, { status: 'overloaded' }, { status: 'overloaded' }, { status: 'overloaded' }, { status: 'overloaded' }] });
  const c = await runSeed({ selection: picked.selection, tasks: picked.tasks, done: new Set(), ports: busy.ports });
  assert.deepEqual([c.outcome, c.limitHits, c.runsDone], ['stopped-overloaded', 0, 1]);
  assert.deepEqual(busy.slept, [30_000, 60_000, 30_000, 60_000, 120_000], 'the retry count restarts after a run that is not overloaded');
  assert.deepEqual(busy.recorded.map((r) => r.status), ['completed']);

  // 'usage-limit' is still accepted as before (the first test), and a restart resumes.
  const q = ports({ outcomes: [] });
  const rest = await runSeed({ selection: picked.selection, tasks: picked.tasks, done: new Set(untimed.recorded.map((r) => r.runId)), ports: q.ports });
  assert.deepEqual([rest.outcome, rest.runsDone, q.recorded.length], ['complete', 24, 12]);
});

test('seed: predictions per model, and priors from the evaluation reports (every run counts)', () => {
  const recs = [
    { runId: 'a__claude-opus-5-5', instanceId: 'a', modelId: 'claude-opus-5-5', patch: 'p1', tokens: 100, apiEquivalentUsd: 8 },
    { runId: 'b__claude-opus-5-5', instanceId: 'b', modelId: 'claude-opus-5-5', patch: '', tokens: 300, apiEquivalentUsd: 6 },
    { runId: 'a__claude-sonnet-5', instanceId: 'a', modelId: 'claude-sonnet-5', patch: 'p2', tokens: null, apiEquivalentUsd: null },
  ];
  // The evaluator's --patch_dir format: one object keyed by instance id, each with model_patch.
  assert.deepEqual(seedPredictions(recs, 'claude-sonnet-5'), { a: { model_patch: 'p2', model_name_or_path: 'jevris-seed-claude-sonnet-5' } });
  assert.deepEqual(resolvedIdsOf({ resolved_ids: ['a'] }), ['a']);
  assert.deepEqual(resolvedIdsOf({ resolved: ['a'] }), ['a']);
  assert.equal(resolvedIdsOf({}), null);
  const priors = seedPriors(recs, { 'claude-opus-5-5': ['a'], 'claude-sonnet-5': [] }, '2026-09-28');
  assert.deepEqual(priors.map((p) => [p.modelId, p.effort, p.successRate, p.trials, p.meanTokens, p.meanApiEquivalentUsd]), [
    ['claude-opus-5-5', 'medium', 0.5, 2, 200, 7],
    ['claude-sonnet-5', 'high', 0, 1, null, null],
  ]);
  assert.equal(priors[0].sourceId, 'seed:swe-bench-live-multilang@2026-09');
  assert.equal(priors[0].priorSliceId, 'issue-fix');
  // The baseline builder needs the real counts and the provenance hashes.
  assert.deepEqual(priors.map((p) => p.successes), [1, 0]);
  assert.equal(priors[0].runsHash, seedRunsHash(recs));
  assert.equal(priors[0].selectionHash, null);
  assert.equal(seedPriors(recs, {}, '2026-09-28', SEED_PLAN, H)[1].selectionHash, H);
});

test('seed: the prompt carries the issue and no test hints', () => {
  const text = seedPrompt({ instanceId: 'x', repo: 'org/r', baseCommit: SHA, createdAt: '2026-03-01T00:00:00Z', problemStatement: 'The parser drops the last token.' });
  assert.match(text, /org\/r/);
  assert.match(text, /The parser drops the last token\./);
  assert.match(text, /do not modify or add tests/);
});

test('seed economics: cost, tokens and wall time per arm and paired on the same tasks; subscription dollars are marked as estimates', () => {
  const run = (instanceId, modelId, usd, tokens, durationMs, status = 'completed', costBasis = 'list-price-estimate') => ({
    runId: `${instanceId}__${modelId}`, instanceId, modelId, effort: modelId === 'claude-opus-5-5' ? 'medium' : 'high', status, reason: '', actualModel: modelId,
    apiEquivalentUsd: usd, costUsd: null, costBasis, usage: null, tokens, durationMs, authMode: 'subscription', patchBytes: 1, patch: 'p', at: '2026-09-27T09:00:00.000Z',
  });
  const recs = [
    run('a', 'claude-opus-5-5', 8, 9_000_000, 600_000), run('a', 'claude-sonnet-5', 5, 7_000_000, 900_000),
    run('b', 'claude-opus-5-5', 6, 7_000_000, 500_000), run('b', 'claude-sonnet-5', 10, 12_000_000, 2_700_000, 'budget-exceeded'),
    run('c', 'claude-opus-5-5', 7, 8_000_000, 550_000), run('c', 'claude-sonnet-5', 4, 5_000_000, 700_000),
    run('d', 'claude-opus-5-5', 9, 10_000_000, 650_000),
  ];
  const econ = seedEconomics(recs, { selectionHash: H, resolvedByModel: { 'claude-opus-5-5': ['a', 'b', 'c'], 'claude-sonnet-5': ['a'] } });
  assert.equal(econ.runsHash, seedRunsHash(recs));
  assert.deepEqual([econ.selectionHash, econ.tasks, econ.runs], [H, 4, 7]);
  assert.deepEqual([econ.baseline.modelId, econ.baseline.effort, econ.candidate.modelId, econ.candidate.effort], ['claude-opus-5-5', 'medium', 'claude-sonnet-5', 'high']);
  assert.deepEqual([econ.baseline.runs, econ.baseline.verified, econ.baseline.totalUsd, econ.baseline.usdPerVerified, econ.baseline.meanDurationMs], [4, 3, 30, 10, 575_000]);
  assert.deepEqual([econ.candidate.runs, econ.candidate.verified, econ.candidate.capHits, econ.candidate.totalUsd, econ.candidate.usdPerVerified], [3, 1, 1, 19, 19]);
  assert.deepEqual(econ.candidate.authModes, { subscription: 3 });
  assert.deepEqual(econ.candidate.costBases, { 'list-price-estimate': 3 });
  // Only tasks run on both arms pair; d has no candidate run.
  assert.deepEqual(econ.pairs.map((p) => [p.instanceId, p.baseline.verified, p.candidate.verified]), [['a', true, true], ['b', true, false], ['c', true, false]]);
  const usd = econ.pairedDifference.usd;
  assert.equal(usd.n, 3);
  assert.equal(usd.point, Math.round(((5 - 8 + 10 - 6 + 4 - 7) / 3) * 10_000) / 10_000);
  assert.ok(usd.lower <= usd.point && usd.point <= usd.upper);
  assert.match(econ.note, /not charges/);
  // Without the evaluation reports nothing is called verified.
  const bare = seedEconomics(recs);
  assert.deepEqual([bare.baseline.verified, bare.baseline.usdPerVerified, bare.pairs[0].baseline.verified], [null, null, null]);
});

test('seed: the dataset is read line by line with only the task fields, and gives the same selection and hash as the whole-file read', async (t) => {
  // Extra columns (the real rows carry test lists, patches and more), a CRLF line, a blank line and a non-JSON line.
  const rows = [...rows_(24), ...rows_(6, { created: '2026-01-15T00:00:00Z' }).map((r) => ({ ...r, instance_id: `${r.instance_id}-old` }))].map((r, i) => ({ ...r, FAIL_TO_PASS: ['t'.repeat(i)], patch: 'x'.repeat(1000), language: 'python' }));
  const expected = parseSeedTasks(rows, 'ts');
  const lines = [...rows.map((r) => JSON.stringify(r)), '', `${JSON.stringify(rows[0])}\r`.slice(0, 5), `${JSON.stringify({ instance_id: 'bad' })}\r`];
  const streamed = await parseSeedTaskLines(lines, 'ts');
  assert.deepEqual(streamed.tasks, expected.tasks);
  assert.equal(streamed.skipped, expected.skipped + 2, 'the non-JSON line and the malformed row are counted');
  assert.deepEqual(SEED_TASK_FIELDS, ['instance_id', 'repo', 'base_commit', 'created_at', 'problem_statement']);
  const a = selectSeedTasks(expected.tasks);
  const b = selectSeedTasks(streamed.tasks);
  assert.equal(b.selection.selectionHash, a.selection.selectionHash);
  assert.deepEqual(b.tasks, a.tasks);
  // `datasets`' to_json writes created_at as epoch milliseconds: the same instants give the same tasks.
  const epoch = rows.map((r) => ({ ...r, created_at: Date.parse(r.created_at) }));
  assert.deepEqual((await parseSeedTaskLines(epoch.map((r) => JSON.stringify(r)), 'ts')).tasks, expected.tasks);
  assert.deepEqual(parseSeedTasks(rows.map((r) => ({ ...r, created_at: Date.parse(r.created_at) / 1000 })), 'ts').tasks, expected.tasks, 'epoch seconds too');
  // The script streams a JSON-lines file and still reads a JSON array; both give this selection.
  const dir = mkdtempSync(join(tmpdir(), 'jevris-seed-select-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'seed-run.mjs');
  writeFileSync(join(dir, 'full.jsonl'), `\uFEFF${rows.map((r) => JSON.stringify(r)).join('\r\n')}\r\n`);
  writeFileSync(join(dir, 'full.json'), JSON.stringify(rows));
  for (const file of ['full.jsonl', 'full.json']) {
    const out = join(dir, `out-${file}`);
    const r = spawnSync(process.execPath, [script, 'select', '--dataset', `ts=${join(dir, file)}`, '--out', out], { env: { ...process.env, JEVRIS_TEST: '1' }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'selection.json'), 'utf8')), { ...a.selection, gold: false, goldExcluded: [] }, file);
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'tasks.json'), 'utf8')), a.tasks, file);
  }
});

// MultiLang rows as the dataset ships them (no language field; created_at an ISO string; the
// evaluator's own columns), one file per split.
function multiLangRow(split, n, repo, created = '2026-03-01T00:00:00Z') {
  return {
    repo, pull_number: String(100 + n), instance_id: `${repo.replace('/', '__')}-${split}${n}`, issue_numbers: [String(n)], base_commit: SHA, patch: 'diff --git a/x b/x', test_patch: 'diff --git a/t b/t',
    problem_statement: `Issue ${split} ${n}`, hints_text: '', all_hints_text: '', commit_urls: [], created_at: created, commit_url: '', rebuild_cmds: ['pnpm build'], test_cmds: ['pnpm test'], print_cmds: ['cat log'],
    log_parser: 'jest', FAIL_TO_PASS: ['a'], PASS_TO_PASS: ['b'], docker_image: `starryzhang/sweb.eval.x86_64.${split}${n}`,
  };
}

function multiLang(dir) {
  const ts = [...Array.from({ length: 5 }, (_, i) => multiLangRow('ts', i, `tsorg/r${i}`)), multiLangRow('ts', 99, 'tsorg/old', '2025-12-01T00:00:00Z'), multiLangRow('ts', 50, 'shared/both')];
  const js = [...Array.from({ length: 5 }, (_, i) => multiLangRow('js', i, `jsorg/r${i}`)), multiLangRow('js', 50, 'shared/both')];
  const go = Array.from({ length: 6 }, (_, i) => multiLangRow('go', i, `goorg/r${i}`));
  const files = {};
  for (const [split, rows] of Object.entries({ ts, js, go })) {
    files[split] = join(dir, `${split}.jsonl`);
    writeFileSync(files[split], `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  }
  return { ts, js, go, files };
}

test('seed MultiLang: ts and js first, go only as a top-up, one task per repository across splits, the language recorded, and the evaluator dataset rows written verbatim', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-seed-multilang-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { ts, js, go, files } = multiLang(dir);
  assert.deepEqual([SEED_PLAN.dataset, SEED_PLAN.revision, SEED_PLAN.splits, SEED_PLAN.topUpSplits], ['SWE-bench-Live/MultiLang', '3638632e8153a10ca422c1022bed79023084b5c9', ['ts', 'js'], ['go']]);
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'seed-run.mjs');
  const node = (...argv) => spawnSync(process.execPath, [script, ...argv], { env: { ...process.env, JEVRIS_TEST: '1' }, encoding: 'utf8' });
  const out = join(dir, 'seed');
  const select = (...extra) => node('select', '--dataset', `ts=${files.ts}`, '--dataset', `js=${files.js}`, '--dataset', `go=${files.go}`, '--out', out, ...extra);
  const r = select();
  assert.equal(r.status, 0, r.stderr);
  const selection = JSON.parse(readFileSync(join(out, 'selection.json'), 'utf8'));
  const tasks = JSON.parse(readFileSync(join(out, 'tasks.json'), 'utf8'));
  assert.equal(selectionValid(selection), true);
  // 11 ts and js repositories (the shared one once, from ts; the old ts task is before the cutoff), then 1 from go.
  const byLanguage = tasks.reduce((acc, x) => ({ ...acc, [x.language]: (acc[x.language] ?? 0) + 1 }), {});
  assert.deepEqual(byLanguage, { ts: 6, js: 5, go: 1 });
  assert.equal(new Set(tasks.map((x) => x.repo)).size, 12);
  assert.ok(tasks.some((x) => x.instanceId === 'shared__both-ts50') && !tasks.some((x) => x.instanceId === 'shared__both-js50'));
  assert.ok(!tasks.some((x) => x.repo === 'tsorg/old'));
  assert.ok(tasks.slice(0, 11).every((x) => x.language !== 'go'), 'the top-up comes last');
  // The same pick in process.
  const all = [...parseSeedTasks(ts, 'ts').tasks, ...parseSeedTasks(js, 'js').tasks, ...parseSeedTasks(go, 'go').tasks];
  const pick = selectSeedTasks(all);
  assert.deepEqual(pick.selection, { planId: selection.planId, dataset: selection.dataset, revision: selection.revision, instanceIds: selection.instanceIds, selectionHash: selection.selectionHash });
  // The evaluator's dataset files: the rows exactly as shipped, the 12 in pick order, the candidates for the gold check.
  const evalRows = readFileSync(join(out, 'eval-dataset.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const byId = new Map([...ts, ...js, ...go].map((row) => [row.instance_id, row]));
  assert.deepEqual(evalRows, selection.instanceIds.map((id) => byId.get(id)));
  const candidates = readFileSync(join(out, 'eval-candidates.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).instance_id);
  assert.deepEqual(candidates, pick.candidates.slice(0, SEED_PLAN.goldCandidates).map((x) => x.instanceId));
  assert.equal(candidates.length, 17, 'every eligible repository once (fewer than 18 here)');
  // The gold check: a candidate whose gold patch failed here is passed over before any run.
  const failedGold = selection.instanceIds[3];
  writeFileSync(join(dir, 'gold.json'), JSON.stringify({ submitted: 17, submitted_ids: candidates, success_ids: candidates.filter((id) => id !== failedGold), failure_ids: [failedGold], error_ids: [], incomplete_ids: [], empty_patch_ids: [] }));
  const gold = select('--gold', join(dir, 'gold.json'));
  assert.equal(gold.status, 0, gold.stderr);
  const checked = JSON.parse(readFileSync(join(out, 'selection.json'), 'utf8'));
  assert.deepEqual([checked.gold, checked.goldExcluded], [true, [failedGold]]);
  assert.ok(!checked.instanceIds.includes(failedGold) && checked.instanceIds.length === 12);
  assert.deepEqual(checked.instanceIds.slice(0, 3), selection.instanceIds.slice(0, 3));
  // Once runs exist, the selection cannot change.
  writeFileSync(join(out, 'runs.jsonl'), `${JSON.stringify({ runId: 'x', instanceId: checked.instanceIds[0] })}\n`);
  const moved = select();
  assert.equal(moved.status, 3);
  assert.match(moved.stderr, /cannot change once the seed has started/);
});

test('seed MultiLang: predictions are the evaluator patch file; priors and economics read its results.json and stop on an unfinished evaluation', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-seed-eval-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'seed-run.mjs');
  const node = (...argv) => spawnSync(process.execPath, [script, ...argv], { env: { ...process.env, JEVRIS_TEST: '1' }, encoding: 'utf8' });
  const ids = ['o__a-ts1', 'o__b-js2', 'o__c-go3'];
  const record = (instanceId, modelId, patch) => ({ runId: `${instanceId}__${modelId}`, instanceId, language: instanceId.slice(-3, -1), modelId, effort: modelId === 'claude-opus-5-5' ? 'medium' : 'high', status: 'completed', reason: '', actualModel: modelId, apiEquivalentUsd: 5, costUsd: null, costBasis: 'list-price-estimate', usage: null, tokens: 1000, durationMs: 60_000, authMode: 'subscription', patchBytes: patch.length, patch, at: '2026-10-01T00:00:00.000Z' });
  const runs = ids.flatMap((id) => [record(id, 'claude-opus-5-5', `diff opus ${id}`), record(id, 'claude-sonnet-5', id.endsWith('3') ? '' : `diff sonnet ${id}`)]);
  writeFileSync(join(dir, 'runs.jsonl'), `${runs.map((r) => JSON.stringify(r)).join('\n')}\n`);
  assert.equal(node('predictions', '--out', dir).status, 0);
  const predictions = JSON.parse(readFileSync(join(dir, 'predictions-claude-sonnet-5.json'), 'utf8'));
  assert.deepEqual(Object.keys(predictions), ids);
  assert.deepEqual(predictions['o__a-ts1'], { model_patch: 'diff sonnet o__a-ts1', model_name_or_path: 'jevris-seed-claude-sonnet-5' });
  // results.json as `python -m evaluation.evaluation` writes it.
  const results = (success, failure, extra = {}) => ({ submitted: 3, submitted_ids: ids, empty_patch: 0, empty_patch_ids: [], success_ids: success, failure_ids: failure, error_ids: [], incomplete_ids: [], success: success.length, failure: failure.length, error: 0, incomplete: 0, ...extra });
  writeFileSync(join(dir, 'opus.json'), JSON.stringify(results(['o__a-ts1', 'o__b-js2'], ['o__c-go3'])));
  writeFileSync(join(dir, 'sonnet.json'), JSON.stringify(results(['o__a-ts1'], ['o__b-js2'], { empty_patch: 1, empty_patch_ids: ['o__c-go3'] })));
  const reports = ['--report', `claude-opus-5-5=${join(dir, 'opus.json')}`, '--report', `claude-sonnet-5=${join(dir, 'sonnet.json')}`];
  const priors = node('priors', '--out', dir, ...reports);
  assert.equal(priors.status, 0, priors.stderr);
  const written = JSON.parse(readFileSync(join(dir, 'seed-priors.json'), 'utf8'));
  assert.deepEqual(written.map((p) => [p.modelId, p.successes, p.trials]), [['claude-opus-5-5', 2, 3], ['claude-sonnet-5', 1, 3]]);
  assert.match(written[0].benchmark, /^MultiLang@3638632e \(ts, js, go; after 2026-02-01; agent in a base-commit checkout, not the task image\)$/);
  assert.equal(written[0].url, 'https://huggingface.co/datasets/SWE-bench-Live/MultiLang');
  const econ = node('economics', '--out', dir, ...reports);
  assert.equal(econ.status, 0, econ.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'seed-economics.json'), 'utf8')).candidate.verified, 1);
  // An evaluation error or an unfinished instance is not a model failure: priors stop and say so.
  writeFileSync(join(dir, 'sonnet.json'), JSON.stringify(results(['o__a-ts1'], [], { error_ids: ['o__b-js2'], empty_patch_ids: ['o__c-go3'] })));
  const stopped = node('priors', '--out', dir, ...reports);
  assert.equal(stopped.status, 3);
  assert.match(stopped.stderr, /did not finish o__b-js2/);
  // A report that was not given a run's prediction stops too.
  writeFileSync(join(dir, 'sonnet.json'), JSON.stringify(results(['o__a-ts1'], [], { submitted_ids: ['o__a-ts1'] })));
  assert.match(node('economics', '--out', dir, ...reports).stderr, /was not given o__b-js2, o__c-go3/);
  // The pure readers.
  assert.deepEqual(seedEvaluationOf(results(['x'], ['y'], { incomplete_ids: ['z'] })), { resolved: ['x'], unscored: ['z'], submitted: ids });
  assert.deepEqual(seedEvaluationOf({ resolved_ids: ['x'] }), { resolved: ['x'], unscored: [], submitted: null });
  assert.equal(seedEvaluationOf({}), null);
  assert.equal(seedEvaluationProblem(runs, 'claude-opus-5-5', seedEvaluationOf(results(['o__a-ts1'], []))), null);
  assert.deepEqual(resolvedIdsOf(results(['o__a-ts1'], [])), ['o__a-ts1']);
});

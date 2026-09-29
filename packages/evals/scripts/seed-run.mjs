#!/usr/bin/env node
/**
 * The owner's seed run (quality-trial plan section 3, owner decision 2026-09-26).
 *
 *   node packages/evals/scripts/seed-run.mjs select --dataset ts=<ts.jsonl> --dataset js=<js.jsonl> --dataset go=<go.jsonl> --out <dir> [--gold <results.json>]
 *   JEVRIS_LIVE_HARNESS=1 node packages/evals/scripts/seed-run.mjs run --out <dir>
 *   node packages/evals/scripts/seed-run.mjs predictions --out <dir>
 *   node packages/evals/scripts/seed-run.mjs priors --out <dir> --report claude-opus-5-5=<results.json> --report claude-sonnet-5=<results.json>
 *   node packages/evals/scripts/seed-run.mjs economics --out <dir> [--report <model>=<results.json> ...]
 *
 * - `select` needs no harness. Each `--dataset` names one split's JSON-lines file as
 *   `<split>=<file>` (the split is the task's language; MultiLang rows carry no language field).
 *   Files are streamed. It picks the 12 tasks deterministically and writes selection.json (with
 *   its hash), tasks.json, eval-candidates.jsonl (the candidates' dataset rows, in pick order,
 *   for the gold-patch check) and eval-dataset.jsonl (the 12 tasks' rows, for the evaluation).
 *   With `--gold <results.json>` from the gold run, candidates whose gold patch failed here are
 *   passed over. It refuses to change a selection that already has runs.
 * - `run` is the only step that uses the owner's Claude subscription. It refuses from npm test,
 *   from an agent's shell, without a terminal, with an Anthropic API key in the environment, and
 *   without JEVRIS_LIVE_HARNESS=1. It asks for a typed confirmation.
 *   - Every run goes through F's Claude Code worker (`@jevris/cli/claude-worker`, `claude -p`
 *     under the owner's login), in a fresh checkout at the task's base commit.
 *   - It resumes where it stopped: finished runs are in runs.jsonl.
 * - `predictions` writes predictions-<model>.json per model: the object keyed by instance id,
 *   each with `model_patch`, that `python -m evaluation.evaluation --patch_dir` reads.
 * - `priors` and `economics` read that evaluator's results.json (`--report <model>=<file>`). A
 *   run it did not finish (error or incomplete) or was not given stops them, rather than count
 *   as a failure.
 * - `priors` turns the evaluation reports into seed-priors.json, named by the selection and
 *   run-records hashes. `baseline-release.mjs build` turns them into the signed baseline release.
 * - `economics` writes seed-economics.json, the release economics evidence (owner decision
 *   2026-09-26): cost, tokens and wall time per arm and paired on the same tasks, and with the
 *   evaluation reports, per verified run. On a subscription the dollars are API-equivalent
 *   estimates from usage at list price (`costBasis`), not charges.
 */
import { execFile } from 'node:child_process';
import { appendFileSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';
import { SEED_CONFIRMATION, SEED_PLAN, parseSeedTaskLines, parseSeedTasks, runSeed, seedEconomics, seedEvaluationOf, seedEvaluationProblem, seedGuard, seedPredictions, seedPriors, selectSeedTasks, selectionValid } from '../dist/index.js';

const run = promisify(execFile);

function args() {
  const out = { _: [], report: [], dataset: [] };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--report') out.report.push(argv[++i] ?? '');
    else if (a === '--dataset') out.dataset.push(argv[++i] ?? '');
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i] ?? '';
    else out._.push(a);
  }
  return out;
}

function fail(message, code = 1) {
  process.stderr.write(`seed-run: ${message}\n`);
  process.exit(code);
}

/** A small JSON or JSON-lines file (run records, reports). The dataset is streamed instead. */
function readJsonLines(file) {
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
  if (text.startsWith('[')) return JSON.parse(text);
  return text === '' ? [] : text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

async function git(cwd, ...argv) {
  const { stdout } = await run('git', argv, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

const opts = args();
const command = opts._[0];
if (typeof opts.out !== 'string' || opts.out === '') fail('usage: seed-run.mjs select|run|predictions|priors|economics --out <dir> ...', 2);
const out = resolve(opts.out);
// The run's guard comes before anything touches the disk.
if (command === 'run') {
  const refusal = seedGuard(process.env, { stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true });
  if (refusal !== null) fail(refusal, 3);
}
mkdirSync(out, { recursive: true, mode: 0o700 });
const runsFile = join(out, 'runs.jsonl');

/** Whether a file holds one JSON array (read whole) rather than JSON lines (streamed). */
function isJsonArray(file) {
  const head = Buffer.alloc(64);
  const fd = openSync(file, 'r');
  const got = readSync(fd, head, 0, head.length, 0);
  closeSync(fd);
  return head.subarray(0, got).toString('utf8').replace(/^\uFEFF/, '').trimStart().startsWith('[');
}

function lines(file) {
  return createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
}

/** The dataset rows of the given instances, verbatim, in the given order (JSON lines). */
async function rowsOf(splits, ids) {
  const wanted = new Set(ids);
  const found = new Map();
  for (const { file } of splits) {
    const source = isJsonArray(file) ? readJsonLines(file).map((row) => JSON.stringify(row)) : lines(file);
    for await (const line of source) {
      const text = line.replace(/^\uFEFF/, '').trim();
      if (text === '') continue;
      let id;
      try {
        id = JSON.parse(text).instance_id;
      } catch {
        continue;
      }
      if (wanted.has(id) && !found.has(id)) found.set(id, text);
    }
  }
  return ids.map((id) => found.get(id)).filter((line) => line !== undefined);
}

if (command === 'select') {
  const splits = opts.dataset.map((pair) => {
    const at = pair.indexOf('=');
    if (at < 1) fail('--dataset takes <split>=<file.jsonl>, for example ts=ts.jsonl', 2);
    return { language: pair.slice(0, at), file: resolve(pair.slice(at + 1)) };
  });
  if (splits.length === 0) fail(`select needs --dataset <split>=<file.jsonl> for ${[...SEED_PLAN.splits, ...SEED_PLAN.topUpSplits].join(', ')}`, 2);
  const tasks = [];
  let skipped = 0;
  for (const { language, file } of splits) {
    // A split can be hundreds of MB, more than one string can hold: JSON lines are streamed.
    const parsed = isJsonArray(file) ? parseSeedTasks(readJsonLines(file), language) : await parseSeedTaskLines(lines(file), language);
    tasks.push(...parsed.tasks);
    skipped += parsed.skipped;
  }
  let gold = null;
  if (typeof opts.gold === 'string' && opts.gold !== '') {
    const evaluation = seedEvaluationOf(JSON.parse(readFileSync(resolve(opts.gold), 'utf8')));
    if (evaluation === null) fail(`${opts.gold} is not an evaluation results.json`, 2);
    gold = new Set(evaluation.resolved);
  }
  const picked = selectSeedTasks(tasks, SEED_PLAN, gold);
  if ('error' in picked) fail(picked.error);
  const existing = join(out, 'selection.json');
  if (existsSync(runsFile) && readFileSync(runsFile, 'utf8').trim() !== '' && existsSync(existing) && JSON.parse(readFileSync(existing, 'utf8')).selectionHash !== picked.selection.selectionHash) {
    fail('runs.jsonl already has runs for another selection; the selection cannot change once the seed has started', 3);
  }
  const candidates = picked.candidates.slice(0, SEED_PLAN.goldCandidates).map((t) => t.instanceId);
  writeFileSync(existing, `${JSON.stringify({ ...picked.selection, gold: gold !== null, goldExcluded: picked.goldExcluded }, null, 2)}\n`);
  writeFileSync(join(out, 'tasks.json'), `${JSON.stringify(picked.tasks, null, 2)}\n`);
  writeFileSync(join(out, 'eval-candidates.jsonl'), `${(await rowsOf(splits, candidates)).join('\n')}\n`);
  writeFileSync(join(out, 'eval-dataset.jsonl'), `${(await rowsOf(splits, picked.selection.instanceIds)).join('\n')}\n`);
  const languages = picked.tasks.reduce((acc, t) => ({ ...acc, [t.language]: (acc[t.language] ?? 0) + 1 }), {});
  process.stdout.write(
    [
      `selected ${picked.selection.instanceIds.length} tasks (${skipped} rows skipped; ${Object.entries(languages).map(([k, v]) => `${k} ${v}`).join(', ')})${gold === null ? ', no gold check yet' : `, gold check passed over ${picked.goldExcluded.length}`}`,
      `selection hash ${picked.selection.selectionHash}`,
      ...picked.tasks.map((t) => `${t.instanceId} (${t.language})`),
    ].join('\n') + '\n',
  );
  process.exit(0);
}

function records() {
  return existsSync(runsFile) ? readJsonLines(runsFile) : [];
}

if (command === 'run') {
  const selection = JSON.parse(readFileSync(join(out, 'selection.json'), 'utf8'));
  if (!selectionValid(selection)) fail('selection.json does not match its hash; run select again', 3);
  const tasks = JSON.parse(readFileSync(join(out, 'tasks.json'), 'utf8'));
  let workerModule;
  try {
    workerModule = await import('@jevris/cli/claude-worker');
  } catch {
    fail("F's Claude Code worker (@jevris/cli/claude-worker) is not installed in this checkout; build the repository at a commit that has it", 3);
  }
  const port = workerModule.claudeWorkerPort();
  // A subscription run reports no dollars; the API-equivalent estimate comes from usage at list price.
  const core = await import('@jevris/core').catch(() => null);
  const estimateUsd = (modelId, usage) => {
    const model = core === null ? null : core.registryModel(core.BUNDLED_MODEL_REGISTRY, modelId);
    if (model === null) return null;
    const micro = core.generationCostMicroUsd(model.tariff, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadInputTokens, cacheWriteTokens: usage.cacheCreationInputTokens });
    return Math.round(micro / 10_000) / 100;
  };
  const done = new Set(records().map((r) => r.runId));
  const planned = SEED_PLAN.taskCount * SEED_PLAN.arms.length;
  process.stdout.write(
    [
      `Seed run ${SEED_PLAN.id}: ${planned} runs (${done.size} already done), selection ${selection.selectionHash}.`,
      `Models: ${SEED_PLAN.arms.map((a) => `${a.modelId} at ${a.effort}`).join(', ')}, in Claude Code on your subscription login.`,
      `Per run: at most $${SEED_PLAN.perRunUsd} API-equivalent and ${SEED_PLAN.perRunMinutes} minutes. A usage limit pauses until its reset; the ${SEED_PLAN.maxLimitHits}nd hit stops the seed.`,
      `Type "${SEED_CONFIRMATION}" to continue: `,
    ].join('\n'),
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('')).trim();
  rl.close();
  if (answer !== SEED_CONFIRMATION) fail('not confirmed; nothing ran', 4);
  const cache = join(out, 'repos');
  mkdirSync(cache, { recursive: true });
  const summary = await runSeed({
    selection,
    tasks,
    done,
    ports: {
      async prepare(task, spec) {
        const mirror = join(cache, task.repo.replace('/', '__'));
        if (!existsSync(mirror)) await git(out, 'clone', '--quiet', '--no-checkout', `https://github.com/${task.repo}.git`, mirror);
        const dir = join(out, 'work', spec.runId);
        rmSync(dir, { recursive: true, force: true });
        await git(out, 'clone', '--quiet', '--no-checkout', mirror, dir);
        await git(dir, 'checkout', '--quiet', '--detach', task.baseCommit);
        return { cwd: dir };
      },
      run: (input) => port.run({ ...input, signal: new AbortController().signal }),
      async diff(cwd, base) {
        await git(cwd, 'add', '-A');
        return git(cwd, 'diff', '--cached', '--binary', base);
      },
      async record(entry) {
        appendFileSync(runsFile, `${JSON.stringify(entry)}\n`);
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
      log: (line) => process.stdout.write(`${line}\n`),
      estimateUsd,
    },
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exit(summary.outcome === 'complete' ? 0 : 5);
}

if (command === 'predictions') {
  const all = records();
  for (const arm of SEED_PLAN.arms) {
    const file = join(out, `predictions-${arm.modelId}.json`);
    writeFileSync(file, `${JSON.stringify(seedPredictions(all, arm.modelId), null, 2)}\n`);
    process.stdout.write(`${file}\n`);
  }
  process.exit(0);
}

function reports() {
  const resolved = {};
  const recorded = records();
  for (const pair of opts.report) {
    const at = pair.indexOf('=');
    if (at < 1) fail('--report takes <modelId>=<results.json>', 2);
    const modelId = pair.slice(0, at);
    const evaluation = seedEvaluationOf(JSON.parse(readFileSync(pair.slice(at + 1), 'utf8')));
    if (evaluation === null) fail(`${pair.slice(at + 1)} is not an evaluation results.json (no success_ids)`, 2);
    const problem = seedEvaluationProblem(recorded, modelId, evaluation);
    if (problem !== null) fail(problem, 3);
    resolved[modelId] = evaluation.resolved;
  }
  return resolved;
}

function selectionHash() {
  const file = join(out, 'selection.json');
  if (!existsSync(file)) return null;
  const selection = JSON.parse(readFileSync(file, 'utf8'));
  if (!selectionValid(selection)) fail('selection.json does not match its hash', 3);
  return selection.selectionHash;
}

if (command === 'priors') {
  const priors = seedPriors(records(), reports(), new Date().toISOString().slice(0, 10), SEED_PLAN, selectionHash());
  writeFileSync(join(out, 'seed-priors.json'), `${JSON.stringify(priors, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(priors, null, 2)}\n`);
  process.exit(0);
}

if (command === 'economics') {
  const resolved = reports();
  const economics = seedEconomics(records(), { selectionHash: selectionHash(), ...(opts.report.length === 0 ? {} : { resolvedByModel: resolved }) });
  writeFileSync(join(out, 'seed-economics.json'), `${JSON.stringify(economics, null, 2)}\n`);
  const { pairs, ...summary } = economics;
  process.stdout.write(`${JSON.stringify({ ...summary, pairs: pairs.length }, null, 2)}\n`);
  process.exit(0);
}

fail('usage: seed-run.mjs select|run|predictions|priors|economics --out <dir> ...', 2);

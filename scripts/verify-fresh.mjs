#!/usr/bin/env node
/**
 * npm run verify:fresh -- [--overlay <path>...] [--future-days N] [--dir <parent>] [--keep]
 *
 * The verification an agent runs before reporting work as done (CLAUDE.md, verification):
 * - a fresh clone of this checkout's HEAD in a temporary folder;
 * - plus the overlay: the named working-tree paths, copied from this checkout. A named path that
 *   no longer exists here but is in HEAD is removed from the clone, as a deletion. A path in
 *   neither is refused (exit 2), so a mistyped path, or several paths the shell passed as one
 *   argument, never leaves the run testing bare HEAD while it prints PASS;
 * - then npm ci, build, lint, test, docs --check and check:pack. With --future-days N, it also
 *   runs test:future for N days;
 * - the test step is the suite run once under coverage (scripts/coverage.mjs), so it also fails
 *   when a package falls below its floor in coverage-floors.json, as CI does;
 * - it prints the exact counts and removes the clone.
 *
 * Before every step, it checks that the step's working folder is the clone's top level and not
 * this checkout. A step can never run in the shared checkout, whatever the shell does with a path
 * that has spaces. On a failure, the step logs are kept and their folder is printed. --keep
 * keeps the clone too.
 * The whole run holds the machine-wide host suite lock (scripts/suite-lock.mjs), so it waits
 * while another full suite or Docker cell runs on this machine.
 * Each run's folder holds its owner's pid. A passing run removes its folder. A failing run keeps
 * its logs (and, with --keep, the clone) and prints where. At the start of a run, kept folders
 * from earlier runs are pruned: only the 3 newest are kept, none older than 24 hours, and never
 * one a live process uses (its owner runs, a process names it, or it changed in the last 15
 * minutes).
 * Exit 0: every step passed. Exit 1: a step failed or was refused. Exit 2: usage error.
 * Exit 75: the host suite lock stayed held.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './build.mjs';
import { INSTALL_SCRIPT_PACKAGES } from './ci-cell.mjs';

export const MAIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The steps, in order. `future` runs only with --future-days. */
export function verifySteps(futureDays = null) {
  return [
    // As CI installs (scripts/ci-cell.mjs): no install scripts, then the ones dependencies declare.
    { id: 'ci', npm: ['ci', '--ignore-scripts', '--no-audit', '--no-fund'] },
    { id: 'rebuild', npm: ['rebuild', ...INSTALL_SCRIPT_PACKAGES] },
    { id: 'build', npm: ['run', 'build'] },
    { id: 'lint', npm: ['run', 'lint'] },
    // The suite once, under coverage, with the per-package floors checked (QA-06).
    { id: 'test', node: ['scripts/coverage.mjs'] },
    { id: 'docs', node: ['scripts/docs.mjs', '--check'] },
    { id: 'pack', npm: ['run', 'check:pack'] },
    ...(futureDays === null ? [] : [{ id: 'future', npm: ['run', 'test:future', '--', '--days', String(futureDays), '--no-build'] }]),
  ];
}

/** Steps whose failure makes the rest meaningless. */
const GATING = new Set(['ci', 'rebuild', 'build']);

export function parseVerifyArgs(argv) {
  const options = { overlay: [], futureDays: null, dir: null, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--overlay') {
      let taken = 0;
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        options.overlay.push(argv[i + 1]);
        i += 1;
        taken += 1;
      }
      if (taken === 0) throw new Error('--overlay takes one or more paths');
    } else if (arg === '--future-days') {
      const value = argv[i + 1];
      if (value === undefined || !/^[1-9]\d{0,5}$/.test(value)) throw new Error('--future-days takes a whole number of days from 1 to 999999');
      options.futureDays = Number(value);
      i += 1;
    } else if (arg === '--dir') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--dir takes a folder');
      options.dir = value;
      i += 1;
    } else if (arg === '--keep') options.keep = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

/**
 * The overlay as copy or remove actions, relative to the checkout. It refuses an absolute path,
 * a path that leaves the checkout, anything under .git, and a path that is neither in the working
 * tree nor in HEAD: only a path HEAD has can be deleted. `inHead(rel)` is injectable for tests.
 */
export function overlayPlan(mainRoot, paths, inHead = (rel) => inHeadOf(mainRoot, rel)) {
  const plan = [];
  for (const raw of paths) {
    if (typeof raw !== 'string' || raw.length === 0 || isAbsolute(raw)) throw new Error(`overlay path must be relative to the checkout: ${raw}`);
    const rel = normalize(raw).replace(/[\\/]+$/, '');
    if (rel === '' || rel === '.' || rel === '..' || rel.startsWith(`..${sep}`) || relative(mainRoot, join(mainRoot, rel)).startsWith('..')) throw new Error(`overlay path leaves the checkout: ${raw}`);
    if (rel === '.git' || rel.startsWith(`.git${sep}`)) throw new Error(`overlay path is inside .git: ${raw}`);
    const source = join(mainRoot, rel);
    if (existsSync(source)) plan.push({ rel, action: 'copy' });
    else if (inHead(rel)) plan.push({ rel, action: 'remove' });
    else {
      const joined = /\s/.test(raw) ? '; it contains a space, so if it names several paths the shell passed them as one argument (in zsh an unquoted $VAR is not split: list the paths, or write ${=VAR})' : '';
      throw new Error(`overlay path is in neither the working tree nor HEAD: ${raw}${joined}`);
    }
  }
  return plan;
}

export const WORK_PREFIX = 'jevris-verify-fresh-';
export const KEEP_FAILED = 3;
export const KEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const ACTIVE_WINDOW_MS = 15 * 60 * 1000;

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** Every process's command line (POSIX; empty elsewhere), for the in-use check. */
function processArgs() {
  if (process.platform === 'win32') return [];
  const result = spawnSync('ps', ['-A', '-o', 'args='], { encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return result.status === 0 ? result.stdout.split('\n') : [];
}

/** The newest modification time of a folder, its direct entries and its logs. */
function lastChange(dir) {
  let newest = 0;
  for (const path of [dir, join(dir, 'logs')]) {
    try {
      newest = Math.max(newest, statSync(path).mtimeMs);
      for (const name of readdirSync(path)) {
        try {
          newest = Math.max(newest, statSync(join(path, name)).mtimeMs);
        } catch {
          // gone meanwhile
        }
      }
    } catch {
      // no such folder
    }
  }
  return newest;
}

/**
 * Removes kept folders of earlier runs in `parent`: beyond the `keep` newest, or older than
 * `maxAgeMs`. A folder a live process uses is never removed: its owner.pid runs, a process's
 * command line names it, or it changed within `activeMs`. Returns the removed paths.
 */
export function pruneKept(parent, { self = null, now = Date.now(), keep = KEEP_FAILED, maxAgeMs = KEEP_MAX_AGE_MS, activeMs = ACTIVE_WINDOW_MS, alive = pidAlive, args = processArgs } = {}) {
  let names;
  try {
    names = readdirSync(parent).filter((name) => name.startsWith(WORK_PREFIX));
  } catch {
    return [];
  }
  const lines = names.length === 0 ? [] : args();
  const kept = [];
  for (const name of names) {
    const dir = join(parent, name);
    if (self !== null && dir === self) continue;
    let owner = null;
    try {
      owner = Number(readFileSync(join(dir, 'owner.pid'), 'utf8'));
    } catch {
      owner = null;
    }
    const resolved = real(dir) ?? dir;
    const changed = lastChange(dir);
    const inUse = (owner !== null && alive(owner)) || lines.some((line) => line.includes(dir) || line.includes(resolved)) || now - changed < activeMs;
    if (!inUse) kept.push({ dir, changed });
  }
  kept.sort((a, b) => b.changed - a.changed);
  const removed = [];
  kept.forEach((entry, index) => {
    if (index < keep && now - entry.changed <= maxAgeMs) return;
    rmSync(entry.dir, { recursive: true, force: true });
    removed.push(entry.dir);
  });
  return removed;
}

/** Whether HEAD of `mainRoot` has `rel` (a file or a folder). */
function inHeadOf(mainRoot, rel) {
  const result = spawnSync('git', ['cat-file', '-e', `HEAD:${rel.split(sep).join('/')}`], { cwd: mainRoot, encoding: 'utf8', shell: false, windowsHide: true });
  return result.status === 0;
}

/** The overlay in the summary line: how many paths were copied and removed. */
export function overlaySummary(plan) {
  if (plan.length === 0) return 'no overlay: HEAD alone';
  const removed = plan.filter((p) => p.action === 'remove').length;
  return `${plan.length} overlay path(s): ${plan.length - removed} copied, ${removed} removed`;
}

function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Why a step may not run in `cwd`, or null when it may: `cwd` must be the clone's own top level
 * (its own .git), and never the main checkout or a folder inside it.
 */
export function guardCwd(cwd, clone, mainRoot, git = gitTopLevel) {
  const here = real(cwd);
  const want = real(clone);
  const main = real(mainRoot);
  if (here === null || want === null) return 'NOT_FOUND';
  if (main !== null) {
    const inside = relative(main, here);
    if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) return 'MAIN_CHECKOUT';
  }
  if (here !== want) return 'NOT_THE_CLONE';
  if (!existsSync(join(here, '.git'))) return 'NOT_A_CLONE';
  const top = git(here);
  if (top === null || real(top) !== want) return 'NOT_THE_CLONE';
  return null;
}

function gitTopLevel(cwd) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', shell: false, windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** The node:test summary counts in `text` (the last summary wins), or null when there is none. */
export function parseCounts(text) {
  const counts = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^(?:ℹ|#) (tests|pass|fail|skipped|cancelled|todo) (\d+)\s*$/.exec(line);
    if (match !== null) counts[match[1]] = Number(match[2]);
  }
  return counts.tests === undefined ? null : counts;
}

/**
 * The coverage result in a test step's output (scripts/coverage.mjs): the floor failures, or how
 * many packages met their floors; null when the run stopped before coverage was checked.
 */
export function coverageDetail(text) {
  const lines = String(text).split(/\r?\n/);
  const failures = lines.filter((line) => line.startsWith('coverage floor: ')).map((line) => line.slice('coverage floor: '.length).trim());
  if (failures.length > 0) return `coverage below floor: ${failures.join('; ')}`;
  const start = lines.lastIndexOf('coverage (lines / branches):');
  if (start === -1) return null;
  const packages = lines.slice(start + 1).filter((line) => /^ {2}(?:apps|packages)\/[^:]+: /.test(line));
  const floored = packages.filter((line) => !line.endsWith('(no floor)')).length;
  return `coverage floors met (${floored} package(s))`;
}

/** One line for a step's result. */
export function describeStep(step) {
  const time = `${Math.round(step.ms / 1000)}s`;
  if (step.refused !== undefined) return `${step.id}: REFUSED (${step.refused})`;
  const status = step.code === 0 ? 'ok' : `FAILED (exit ${step.code})`;
  const counts = step.counts === null || step.counts === undefined ? '' : ` ${step.counts.tests} tests, ${step.counts.pass} pass, ${step.counts.fail} fail, ${step.counts.skipped ?? 0} skipped`;
  const extra = step.detail === undefined || step.detail === null ? '' : ` ${step.detail}`;
  return `${step.id}: ${status}${counts}${extra} (${time})`;
}

/** How to run npm without a shell: the npm that started this script, or the one beside node. */
export function npmCommand(env = process.env, execPath = process.execPath, platform = process.platform) {
  const candidates = [
    env.npm_execpath,
    platform === 'win32' ? join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js') : join(dirname(execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && /npm-cli\.js$/.test(candidate) && existsSync(candidate)) return { file: execPath, prefix: [candidate] };
  }
  return { file: platform === 'win32' ? 'npm.cmd' : 'npm', prefix: [] };
}

/** Runs one step with no shell, its output to `logPath`; resolves with the exit code and the output. */
function runStep(step, cwd, logPath, env = process.env) {
  const npm = npmCommand(env);
  const [file, args] = step.npm !== undefined ? [npm.file, [...npm.prefix, ...step.npm]] : [process.execPath, step.node];
  return new Promise((resolve) => {
    const log = createWriteStream(logPath);
    let output = '';
    const child = spawn(file, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const take = (chunk) => {
      log.write(chunk);
      output += chunk;
      if (output.length > 4_000_000) output = output.slice(-2_000_000);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (error) => {
      take(`verify:fresh: could not start ${file}: ${error.message}\n`);
    });
    child.on('close', (code) => {
      log.end(() => resolve({ code: code ?? 1, output }));
    });
  });
}

/**
 * The clone holds HEAD's bytes: `core.autocrlf` off, whatever the host sets (Git for Windows sets
 * it on), so a file with no .gitattributes rule is not rewritten with CRLF beside the overlay's
 * working-tree copies.
 */
function cloneHead(mainRoot, clone) {
  const cloned = spawnSync('git', ['clone', '--quiet', '--no-hardlinks', '--config', 'core.autocrlf=false', mainRoot, clone], { encoding: 'utf8', shell: false, windowsHide: true });
  if (cloned.status !== 0) throw new Error(`git clone failed: ${String(cloned.stderr).trim().slice(0, 300)}`);
  const head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: clone, encoding: 'utf8', shell: false, windowsHide: true });
  return head.status === 0 ? head.stdout.trim() : 'unknown';
}

function applyOverlay(mainRoot, clone, plan) {
  for (const item of plan) {
    const target = join(clone, item.rel);
    if (item.action === 'remove') {
      rmSync(target, { recursive: true, force: true });
      continue;
    }
    const source = join(mainRoot, item.rel);
    mkdirSync(dirname(target), { recursive: true });
    if (lstatSync(source).isDirectory()) cpSync(source, target, { recursive: true, force: true });
    else cpSync(source, target, { force: true });
  }
}

/**
 * Clones HEAD of `mainRoot`, applies the overlay, runs every step inside the clone and returns
 * the report. `run(step, cwd, logPath)` and `write(line)` are injectable for tests.
 */
export async function verifyFresh({ mainRoot = MAIN_ROOT, options, run = runStep, write = (line) => process.stdout.write(`${line}\n`), git = gitTopLevel }) {
  const plan = overlayPlan(mainRoot, options.overlay);
  // --overlay was given but nothing would be overlaid: refuse rather than test bare HEAD.
  if (options.overlay.length > 0 && plan.length === 0) throw new Error('--overlay named paths but the overlay is empty');
  const parent = options.dir ?? tmpdir();
  mkdirSync(parent, { recursive: true });
  const work = mkdtempSync(join(parent, WORK_PREFIX));
  writeFileSync(join(work, 'owner.pid'), String(process.pid));
  const pruned = pruneKept(parent, { self: work });
  if (pruned.length > 0) write(`verify:fresh: removed ${pruned.length} kept folder(s) of earlier runs (at most ${KEEP_FAILED} are kept, none older than 24 h)`);
  const clone = join(work, 'repo');
  const logs = join(work, 'logs');
  mkdirSync(logs);
  const report = { head: null, overlay: plan, steps: [], ok: false, logs, clone };
  try {
    report.head = cloneHead(mainRoot, clone);
    applyOverlay(mainRoot, clone, plan);
    write(`verify:fresh: clone of HEAD ${report.head}${plan.length === 0 ? '' : ` plus ${plan.length} overlay path(s): ${plan.map((p) => (p.action === 'remove' ? `-${p.rel}` : p.rel)).join(', ')}`}`);
    let gated = false;
    for (const step of verifySteps(options.futureDays)) {
      if (gated) break;
      const started = Date.now();
      const refused = guardCwd(clone, clone, mainRoot, git);
      if (refused !== null) {
        report.steps.push({ id: step.id, code: 1, refused, ms: 0 });
        write(`verify:fresh: ${describeStep(report.steps.at(-1))}`);
        break;
      }
      const result = await run(step, clone, join(logs, `${step.id}.log`));
      const counts = ['lint', 'test', 'future'].includes(step.id) ? parseCounts(result.output) : null;
      const detail = step.id === 'pack' ? (/tarball ok: [^\n]*/.exec(result.output)?.[0] ?? null) : step.id === 'test' ? coverageDetail(result.output) : null;
      const record = { id: step.id, code: result.code, counts, detail, ms: Date.now() - started };
      report.steps.push(record);
      write(`verify:fresh: ${describeStep(record)}`);
      if (result.code !== 0 && GATING.has(step.id)) gated = true;
    }
    report.ok = report.steps.length === verifySteps(options.futureDays).length && report.steps.every((step) => step.code === 0);
  } catch (error) {
    write(`verify:fresh: ${error.message}`);
  } finally {
    if (!options.keep) rmSync(clone, { recursive: true, force: true });
    if (report.ok && !options.keep) rmSync(work, { recursive: true, force: true });
    else write(`verify:fresh: kept ${work}: logs in ${logs}${options.keep ? `; clone in ${clone}` : ''} (the newest ${KEEP_FAILED} kept folders stay, for at most 24 h)`);
  }
  write(`verify:fresh: ${report.ok ? 'PASS' : 'FAIL'} at ${report.head ?? 'no clone'} with ${overlaySummary(plan)}`);
  return report;
}

async function main(argv) {
  let options;
  try {
    options = parseVerifyArgs(argv);
    overlayPlan(MAIN_ROOT, options.overlay);
  } catch (error) {
    console.error(`verify:fresh: ${error.message}`);
    console.error('usage: npm run verify:fresh -- [--overlay <path>...] [--future-days N] [--dir <parent>] [--keep]');
    return 2;
  }
  // The whole verification is one full suite: it waits its turn for the host suite lock, and
  // the steps it runs inherit the hold.
  const { runHostLocked } = await import('./suite-lock.mjs');
  return runHostLocked(async () => ((await verifyFresh({ options })).ok ? 0 : 1));
}

if (isMain(import.meta.url)) process.exit(await main(process.argv.slice(2)));

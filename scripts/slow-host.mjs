/**
 * The slow-host kit: makes a fast developer machine behave like the Windows CI runner, so a test
 * or a default that assumes a fast host fails here, before a push, and not in CI after it.
 *
 * Why. Every push of the week of 2026-10-05 got one different Windows-only red test: a bound on a
 * hot commit (520 ms against 401), a held-advice test (a fresh subscriber's first call took over
 * 100 ms and was deferred), a spawned CLI that waited its default 5 s for a sidecar, a trace line
 * lost to one transient write error, a decision read once before it was recorded. All of them are
 * the same thing: the runner stalls for seconds and a test or a default assumed a fast host.
 *
 * What the kit applies (nothing of it is in a product path; it is test-only and never touches the
 * real home):
 *   - CPU burners: `3 x cores` busy node processes, always killed (only the pids the kit started;
 *     never pkill), and ending on their own when the kit's process has gone;
 *   - the Windows runner's settings: JEVRIS_TEST_BUDGET_SCALE=6 (all `budgetScaleFor` sets there);
 *   - scripts/slow-host-preload.cjs in every node process (NODE_OPTIONS --require): a slow process
 *     start, slow writes, renames, fsyncs and opens with now and then a stall of seconds, and a
 *     transient EBUSY/EPERM on a small fraction of the writes the product retries;
 *   - a `git` first on PATH that starts late (300 ms, sometimes 2 s).
 *
 * `npm run test:slow -- [--quick] [--runs N] [files...]` runs the suite under it (scripts/test-slow.mjs).
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, homedir, platform, tmpdir, userInfo } from 'node:os';
import { delimiter, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { budgetScaleFor, collectTestFiles, SERIAL_TEST_FILES } from './test.mjs';

export const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
export const PRELOAD_FILE = join(repoRoot, 'scripts', 'slow-host-preload.cjs');

/** What a Windows CI runner does that a developer machine does not. All of it can be set from the command line. */
export const DEFAULTS = Object.freeze({
  burnersPerCore: 3,
  scale: '6',
  seed: 1,
  fs: Object.freeze({ delayMs: 6, stallRate: 0.0002, stallMs: Object.freeze([1500, 3000]), burstExtra: 1, errorRate: 0.02 }),
  start: Object.freeze({ delayMs: 300, stallRate: 0.02, stallMs: Object.freeze([2000, 2000]) }),
  git: Object.freeze({ delayMs: 100, longRate: 0.02, longMs: 2000 }),
  // A whole process standing still for a moment: the runner's VM loses its CPU, a scanner holds the process (what a loop
  // stall in a test looks like). Every `tickMs` the freezer stops one process the run started for `minMs` to `maxMs`.
  freeze: Object.freeze({ tickMs: 500, rate: 0.04, minMs: 300, maxMs: 1500 }),
  // A COMMIT that waits for a slow flush while its transaction holds the write lock (better-sqlite3).
  sqlite: Object.freeze({ delayMs: 1, stallRate: 0.002, stallMs: Object.freeze([300, 800]) }),
});

/**
 * `--harsh`: the settings the kit started with, before they were calibrated against the fixed tree. About ten times as many stalls
 * and frozen processes, a 300 ms git and 5% of starts at 2 s. It fails correct tests now and then (a sidecar that is stood still for
 * 5 s answers DEADLINE, rightly); it is for hunting a suspect file with `--runs 8`, not for a green gate.
 */
export const HARSH = Object.freeze({ fsStallRate: 0.002, fsBurstExtra: 2, startStallRate: 0.05, gitDelayMs: 300, gitLongRate: 0.05, freezeRate: 0.1 });

/**
 * The operations the product retries on a transient EBUSY, EPERM or EACCES, and only these are failed by default:
 * an append to a log or a trace file (line-writer.ts), a rename of a durable write's temp (durable-write.ts) and an
 * unlink of the sidecar's or the spawn lock file (lock-file.ts; the store's writer lock is not retried, so it is not on the list). A rule for anything else is a decision of the caller (`--fs-error-rule`).
 */
export const RETRYABLE_ERROR_RULES = Object.freeze([
  Object.freeze({ ops: Object.freeze(['write', 'appendFile']), match: String.raw`(?:[\\/]trace-[^\\/]*\.jsonl|[\\/]sidecar\.log)$`, on: 'target' }),
  Object.freeze({ ops: Object.freeze(['rename']), match: String.raw`\.jtmp$`, on: 'from' }),
  Object.freeze({ ops: Object.freeze(['unlink']), match: String.raw`(?:^|[\\/])(?:sidecar|spawn)\.lock$`, on: 'target' }),
]);

// ------------------------------------------------------------------------------ arguments

const USAGE = [
  'usage: npm run test:slow -- [--quick] [--runs N] [--burners N] [--scale N] [--seed N] [--no-build] [<test file>...]',
  '  --quick               only the latency, sidecar, daemon, hook, CLI and acceptance files (found by a scan of the test files)',
  '  --runs N              run the selection N times (the full suite once, then the quick set N-1 more times)',
  '  --harsh               the first, harsher settings (10x the stalls and freezes, 300 ms git): to hunt a suspect file, not a green gate',
  '  --burners N           CPU burners (default 3 per core; 0 for none)',
  '  --scale N             JEVRIS_TEST_BUDGET_SCALE (default 6, the Windows runner\'s)',
  '  --seed N              seed of the fault schedule (each run adds its number)',
  '  --fs-delay MS         every write, rename, fsync and open waits MS (default 6; 0 turns the delay off)',
  '  --fs-stall RATE       chance per operation of a stall of 1.5 to 3 s, in a burst (default 0.0002)',
  '  --fs-error-rate RATE  chance per retryable operation of a transient EBUSY or EPERM (default 0.02)',
  '  --fs-error-first      instead, fail the FIRST such operation on every path once (deterministic)',
  '  --fs-error-rule JSON  an extra rule { ops: [...], match: "<regex>", on: "target"|"from" } (an operation the product may not retry: your call)',
  '  --fs-match REGEX      delay and fail only paths that match',
  '  --start-delay MS      every node process waits MS before it runs (default 300, 2% of them 2 s; 0 turns it off)',
  '  --git-delay MS        every git call waits MS (default 100, 2% of them 2 s; 0 turns it off)',
  '  --sqlite-delay MS     every COMMIT waits MS while its transaction holds the lock (default 1; 0 turns it off)',
  '  --sqlite-stall RATE   chance per COMMIT of a stall of 0.3 to 0.8 s (default 0.002)',
  '  --freeze-rate RATE    chance per half second that one process of the run stands still for 0.3 to 1.5 s, as a stalled runner does (default 0.04; 0 turns it off)',
  '  --freeze-ms MIN-MAX   how long a frozen process stands still (default 300-1500)',
  '  --no-env-inject       do not put the preload into children that a test gives an environment of their own',
  '  --no-build            do not build first (verify:fresh has built)',
  '  --keep                keep the kit folder (its log of injected faults)',
].join('\n');

export function usage() {
  return USAGE;
}

function whole(value, name, { min = 0, max = 1_000_000 } = {}) {
  if (typeof value !== 'string' || !/^\d{1,7}$/.test(value) || Number(value) < min || Number(value) > max) throw new Error(`${name} takes a whole number from ${min} to ${max}`);
  return Number(value);
}

function rate(value, name) {
  const number = Number(value);
  if (typeof value !== 'string' || value.trim() === '' || !Number.isFinite(number) || number < 0 || number > 1) throw new Error(`${name} takes a number from 0 to 1`);
  return number;
}

/** The options of a `test:slow` command line; throws an Error with the reason on a bad one. */
export function parseSlowArgs(argv, cores = availableParallelism()) {
  const options = {
    quick: false,
    runs: 1,
    burners: DEFAULTS.burnersPerCore * cores,
    scale: null,
    seed: DEFAULTS.seed,
    fsDelayMs: DEFAULTS.fs.delayMs,
    fsStallRate: DEFAULTS.fs.stallRate,
    fsBurstExtra: DEFAULTS.fs.burstExtra,
    fsErrorRate: DEFAULTS.fs.errorRate,
    fsErrorFirst: false,
    fsErrorRules: [],
    fsMatch: null,
    startDelayMs: DEFAULTS.start.delayMs,
    // Not on the command line: how often a start or a git call takes 2 s instead (a test of the kit sets them to 0).
    startStallRate: DEFAULTS.start.stallRate,
    gitLongRate: DEFAULTS.git.longRate,
    gitDelayMs: DEFAULTS.git.delayMs,
    sqliteDelayMs: DEFAULTS.sqlite.delayMs,
    sqliteStallRate: DEFAULTS.sqlite.stallRate,
    freezeRate: DEFAULTS.freeze.rate,
    freezeMinMs: DEFAULTS.freeze.minMs,
    freezeMaxMs: DEFAULTS.freeze.maxMs,
    injectEnv: true,
    build: true,
    keep: false,
    files: [],
  };
  // --harsh sets the starting point; any flag beside it overrides it.
  if (argv.includes('--harsh')) Object.assign(options, HARSH);
  const value = (i, name) => {
    const next = argv[i + 1];
    if (next === undefined || (next.startsWith('--') && next !== '--')) throw new Error(`${name} takes a value`);
    return next;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      options.files.push(...argv.slice(i + 1));
      break;
    } else if (arg === '--quick') options.quick = true;
    else if (arg === '--harsh') continue;
    else if (arg === '--no-build') options.build = false;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--no-env-inject') options.injectEnv = false;
    else if (arg === '--fs-error-first') options.fsErrorFirst = true;
    else if (arg === '--runs') options.runs = whole(value(i++, arg), arg, { min: 1, max: 1000 });
    else if (arg === '--burners') options.burners = whole(value(i++, arg), arg, { max: 1024 });
    else if (arg === '--scale') options.scale = String(whole(value(i++, arg), arg, { min: 1, max: 20 }));
    else if (arg === '--seed') options.seed = whole(value(i++, arg), arg);
    else if (arg === '--fs-delay') options.fsDelayMs = whole(value(i++, arg), arg, { max: 60_000 });
    else if (arg === '--fs-stall') options.fsStallRate = rate(value(i++, arg), arg);
    else if (arg === '--fs-error-rate') options.fsErrorRate = rate(value(i++, arg), arg);
    else if (arg === '--fs-match') {
      options.fsMatch = value(i++, arg);
      new RegExp(options.fsMatch);
    } else if (arg === '--fs-error-rule') {
      const rule = JSON.parse(value(i++, arg));
      if (rule === null || typeof rule !== 'object' || !Array.isArray(rule.ops) || typeof rule.match !== 'string') throw new Error('--fs-error-rule takes { "ops": [...], "match": "<regex>" }');
      new RegExp(rule.match);
      options.fsErrorRules.push({ ops: rule.ops.map(String), match: rule.match, on: rule.on === 'from' ? 'from' : 'target' });
    } else if (arg === '--sqlite-delay') options.sqliteDelayMs = whole(value(i++, arg), arg, { max: 60_000 });
    else if (arg === '--sqlite-stall') options.sqliteStallRate = rate(value(i++, arg), arg);
    else if (arg === '--freeze-rate') options.freezeRate = rate(value(i++, arg), arg);
    else if (arg === '--freeze-ms') {
      const range = /^(\d{1,6})-(\d{1,6})$/.exec(value(i++, arg));
      if (range === null || Number(range[1]) > Number(range[2]) || Number(range[2]) > 60_000) throw new Error('--freeze-ms takes MIN-MAX in milliseconds, for example 300-1500');
      options.freezeMinMs = Number(range[1]);
      options.freezeMaxMs = Number(range[2]);
    } else if (arg === '--start-delay') options.startDelayMs = whole(value(i++, arg), arg, { max: 60_000 });
    else if (arg === '--git-delay') options.gitDelayMs = whole(value(i++, arg), arg, { max: 60_000 });
    else if (arg.startsWith('--')) throw new Error(`unknown argument: ${arg}`);
    else options.files.push(arg);
  }
  if (options.quick && options.files.length > 0) throw new Error('--quick selects the files itself; name files or use --quick, not both');
  return options;
}

// ------------------------------------------------------------------------------ the quick set

/** What makes a test file a timing-sensitive one: it starts a sidecar, a daemon, a hook or the CLI (a scan of its text). */
export const QUICK_SIGNALS = Object.freeze({
  daemon: /\bstartDaemon\(|\bwithDaemon\(/,
  sidecar: /\bensureSidecar\(|\bstartSidecar\(|\bspawnSidecar\(|JEVRIS_SIDECAR_ENTRY|['"]sidecar['"],\s*['"](?:start|restart)['"]/,
  story: /from ['"]\.\/lib\.mjs['"]|acceptance\/lib\.mjs/,
  cli: /\brunCli\(|bin\/jevris\.mjs|['"]bin['"],\s*['"]jevris\.mjs['"]|['"]cli\.mjs['"]/,
  hook: /dist\/hook|['"]hook\.mjs['"]|\bwarmHooks\b|\bhook-settled\b|\bbox\.hook\(/,
});

/** The signals one file's text shows (names), empty when it is not a timing-sensitive file. */
export function quickSignals(text) {
  return Object.entries(QUICK_SIGNALS)
    .filter(([, pattern]) => pattern.test(text))
    .map(([name]) => name);
}

/**
 * The quick set: every file of SERIAL_TEST_FILES (the latency-bound ones) and every test file whose text shows it
 * starts a sidecar, a daemon, a hook or the CLI (`quickSignals`), as paths relative to `root`, sorted. Found by a scan, so a
 * new test of that kind joins the set without anyone listing it.
 */
export function quickTestFiles(root = repoRoot, files = collectTestFiles(root), read = (file) => readFileSync(file, 'utf8')) {
  const serial = new Set(SERIAL_TEST_FILES.map((file) => resolve(root, file)));
  const chosen = files.filter((file) => serial.has(resolve(file)) || quickSignals(read(file)).length > 0);
  return chosen.map((file) => relative(root, file).split(sep).join('/')).sort();
}

// ------------------------------------------------------------------------------ the fault configuration

/** The account's real home, from the password database and not the HOME variable (a test run points that at a temporary home). */
export function realHomeOf() {
  try {
    return userInfo().homedir;
  } catch {
    return homedir();
  }
}

/** The JSON the preload reads (scripts/slow-host-preload.cjs), for run number `runIndex` (0 based). */
export function slowConfig(options, { log, enable, runIndex = 0, realHome = realHomeOf() } = {}) {
  const rules = [...(options.fsErrorRate > 0 || options.fsErrorFirst ? RETRYABLE_ERROR_RULES : []), ...options.fsErrorRules];
  return {
    active: true,
    realHome,
    seed: options.seed + runIndex,
    log,
    enable,
    injectEnv: options.injectEnv,
    sqlite: { delayMs: options.sqliteDelayMs, stallRate: options.sqliteStallRate, stallMs: [...DEFAULTS.sqlite.stallMs] },
    start: { delayMs: options.startDelayMs, stallRate: options.startDelayMs > 0 ? options.startStallRate : 0, stallMs: [...DEFAULTS.start.stallMs] },
    fs: {
      delayMs: options.fsDelayMs,
      stallRate: options.fsStallRate,
      stallMs: [...DEFAULTS.fs.stallMs],
      burstExtra: options.fsBurstExtra,
      ...(options.fsMatch === null ? {} : { match: options.fsMatch }),
      errors: { rate: options.fsErrorFirst ? 0 : options.fsErrorRate, firstPerPath: options.fsErrorFirst, codes: ['EBUSY', 'EPERM'], rules },
    },
  };
}

// ------------------------------------------------------------------------------ the kit folder

/** The first `name` on `pathValue` that is not inside `skip`, or null. */
export function findOnPath(name, pathValue, skip = null, exists = existsSync) {
  for (const dir of String(pathValue ?? '').split(delimiter)) {
    if (dir.length === 0 || (skip !== null && resolve(dir) === resolve(skip))) continue;
    const candidate = join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** The sh script that stands in for git: waits `shortMs` (`longMs` for about `longRate` of the calls), counts the call, runs the real git. */
export function gitWrapperScript({ realGit, shortMs, longMs, longRate, callsFile }) {
  const seconds = (ms) => (ms / 1000).toFixed(3);
  const threshold = Math.round(Math.max(0, Math.min(1, longRate)) * 256);
  return [
    '#!/bin/sh',
    '# jevris slow-host kit: a git call that starts late, as on a CI runner whose scanner reads every file first.',
    `printf . >> '${callsFile}' 2>/dev/null`,
    "n=$(od -An -N1 -tu1 /dev/urandom 2>/dev/null | tr -d ' ')",
    `if [ -n "$n" ] && [ "$n" -lt ${threshold} ]; then sleep ${seconds(longMs)}; else sleep ${seconds(shortMs)}; fi`,
    `exec '${realGit}' "$@"`,
    '',
  ].join('\n');
}

/**
 * Writes the kit's files into `dir`: `enable.cjs` (what NODE_OPTIONS --require names: it hands the preload its
 * configuration, so a child with an environment of its own gets the same), a `bin/git` wrapper when git is found and
 * the delay is on, and the empty log. Returns the paths.
 */
export function writeKit(dir, options, { pathValue = process.env.PATH, runIndex = 0, realHome = realHomeOf() } = {}) {
  mkdirSync(join(dir, 'bin'), { recursive: true });
  const enable = join(dir, 'enable.cjs');
  const log = join(dir, 'faults.log');
  const gitCalls = join(dir, 'git-calls');
  writeFileSync(log, '');
  writeFileSync(gitCalls, '');
  const config = slowConfig(options, { log, enable, runIndex, realHome });
  writeFileSync(enable, `'use strict';\nprocess.env.JEVRIS_SLOW_CONFIG = process.env.JEVRIS_SLOW_CONFIG || ${JSON.stringify(JSON.stringify(config))};\nrequire(${JSON.stringify(PRELOAD_FILE)});\n`);
  let wrapped = false;
  if (options.gitDelayMs > 0) {
    const realGit = findOnPath('git', pathValue, join(dir, 'bin'));
    if (realGit !== null) {
      const wrapper = join(dir, 'bin', 'git');
      writeFileSync(wrapper, gitWrapperScript({ realGit, shortMs: options.gitDelayMs, longMs: DEFAULTS.git.longMs, longRate: options.gitLongRate, callsFile: gitCalls }));
      chmodSync(wrapper, 0o755);
      wrapped = true;
    }
  }
  return { dir, enable, log, gitCalls, bin: join(dir, 'bin'), gitWrapped: wrapped, config };
}

/**
 * The environment of the test run: the caller's own, with the budget scale of the Windows runner (a value of the caller's own
 * wins, as it does in scripts/test.mjs), the kit's preload in NODE_OPTIONS, the kit's git first on PATH and the events file.
 * `scaleOf` is `budgetScaleFor` of scripts/test.mjs, injected so the kit never copies the runner's rule.
 */
export function slowEnvironment(base, kit, options, { eventsFile, scaleOf = budgetScaleFor }) {
  const pathKey = Object.keys(base).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  const current = typeof base[pathKey] === 'string' ? base[pathKey] : '';
  const nodeOptions = typeof base.NODE_OPTIONS === 'string' ? base.NODE_OPTIONS.trim() : '';
  const requireFlag = `--require=${/\s/.test(kit.enable) ? `"${kit.enable}"` : kit.enable}`;
  const scale = options.scale ?? scaleOf({ ...base, CI: base.CI ?? '1' }, 'win32');
  const env = {
    ...base,
    [pathKey]: kit.gitWrapped ? `${kit.bin}${delimiter}${current}` : current,
    NODE_OPTIONS: nodeOptions.includes(requireFlag) ? nodeOptions : `${nodeOptions} ${requireFlag}`.trim(),
    JEVRIS_SLOW_CONFIG: JSON.stringify(kit.config),
    JEVRIS_TEST_EVENTS: eventsFile,
  };
  if (scale !== undefined) env.JEVRIS_TEST_BUDGET_SCALE = scale;
  return env;
}

// ------------------------------------------------------------------------------ CPU burners

/** The code of one burner: spins, and ends when its parent has gone or after `maxMs`. */
export function burnerSource(parentPid, maxMs = 4 * 60 * 60 * 1000) {
  return `const p=${Number(parentPid)},t=Date.now();let n=0;for(;;){for(let i=0;i<2e6;i++)n+=i;if(Date.now()-t>${Number(maxMs)})process.exit(0);try{process.kill(p,0)}catch{process.exit(0)}}`;
}

/**
 * Starts `count` CPU burners and returns `{ pids, stop }`. Only these pids are ever signalled (never pkill, never by name);
 * `stop` is also run on exit, SIGINT and SIGTERM, and a burner ends on its own when this process has gone. `spawnFn` and
 * `kill` are injectable, so a test starts no real process.
 */
export function startBurners(count, { spawnFn = spawn, kill = (pid) => process.kill(pid, 'SIGKILL'), parentPid = process.pid, program = process.execPath, hook = true, signals = false } = {}) {
  const pids = [];
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const pid of pids.splice(0)) {
      try {
        kill(pid);
      } catch {
        // already gone
      }
    }
  };
  try {
    for (let i = 0; i < count; i += 1) {
      const child = spawnFn(program, ['-e', burnerSource(parentPid)], { stdio: 'ignore', env: { PATH: process.env.PATH ?? '' } });
      if (typeof child.pid === 'number') pids.push(child.pid);
      if (typeof child.unref === 'function') child.unref();
    }
  } catch (error) {
    stop();
    throw error;
  }
  if (hook) process.once('exit', stop);
  if (signals) {
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => {
        stop();
        process.exit(signal === 'SIGINT' ? 130 : 143);
      });
    }
  }
  return { pids, stop };
}

// ------------------------------------------------------------------------------ the freezer

/** The processes below `rootPid` in a `ps -o pid=,ppid=,args=` listing: [{ pid, ppid, args }], the root excluded. */
export function descendantsOf(listing, rootPid) {
  const rows = [];
  for (const line of String(listing).split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match !== null) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), args: match[3] });
  }
  const below = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (!below.has(row.pid) && below.has(row.ppid)) {
        below.add(row.pid);
        grew = true;
      }
    }
  }
  return rows.filter((row) => row.pid !== rootPid && below.has(row.pid));
}

/** A process the freezer may stop: not a `node --test` runner (it only reports), not a shell or a `sleep` of the kit's own. */
export function freezable(row) {
  return !/(?:^|\s)--test(?:\s|$)/.test(row.args) && !/(?:^|\/)(?:ps|sleep)(?:\s|$)/.test(row.args);
}

/** A seeded random number source in [0, 1). */
export function seededRandom(seed) {
  let state = (Number(seed) * 2654435761) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Stands a process still for a moment, the way a stalled CI runner does: every `tickMs`, with chance `rate`, it picks one process
 * below `rootPid` (a test file, a sidecar, a hook; never a burner or the kit) and stops it with SIGSTOP for `minMs` to `maxMs`.
 * The resume is the job of a detached shell (`sleep; kill -CONT`), so a process is never left stopped when this one is killed;
 * `stop()` also resumes every process it froze. Only pids found below the root are ever signalled. `list`, `signal`, `spawnFn` and
 * `random` are injectable, so a test stops no real process.
 */
export function startFreezer({ rootPid, rate, minMs, maxMs, tickMs = DEFAULTS.freeze.tickMs, seed = 1, random = seededRandom(seed), list = psListing, signal = (pid, name) => process.kill(pid, name), spawnFn = spawn, timers = { setInterval, clearInterval } }) {
  const frozen = new Map();
  const stats = { ticks: 0, freezes: 0, frozenMs: 0 };
  const pickMs = () => minMs + Math.floor(random() * (maxMs - minMs + 1));
  const tick = () => {
    stats.ticks += 1;
    if (random() >= rate) return;
    const candidates = descendantsOf(list(), rootPid).filter(freezable).filter((row) => !frozen.has(row.pid));
    if (candidates.length === 0) return;
    const target = candidates[Math.floor(random() * candidates.length)];
    const ms = pickMs();
    try {
      signal(target.pid, 'SIGSTOP');
    } catch {
      return;
    }
    frozen.set(target.pid, Date.now() + ms);
    stats.freezes += 1;
    stats.frozenMs += ms;
    // The resume does not depend on this process: a shell that outlives it.
    try {
      const resume = spawnFn('/bin/sh', ['-c', `sleep ${(ms / 1000).toFixed(3)}; kill -CONT ${target.pid} 2>/dev/null`], { detached: true, stdio: 'ignore' });
      if (typeof resume.unref === 'function') resume.unref();
    } catch {
      signal(target.pid, 'SIGCONT');
    }
    setTimeout(() => frozen.delete(target.pid), ms + 50).unref();
  };
  const timer = rate > 0 ? timers.setInterval(tick, tickMs) : null;
  if (timer !== null && typeof timer.unref === 'function') timer.unref();
  return {
    stats,
    stop() {
      if (timer !== null) timers.clearInterval(timer);
      for (const pid of frozen.keys()) {
        try {
          signal(pid, 'SIGCONT');
        } catch {
          // gone
        }
      }
      frozen.clear();
    },
  };
}

function psListing() {
  const result = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8', shell: false, maxBuffer: 32 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : '';
}

// ------------------------------------------------------------------------------ reading the results

/** The failed tests of an events file (scripts/test-events-reporter.mjs): [{ file, name }]. */
export function failedTests(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const row = JSON.parse(line);
      if (row.passed === false && row.skipped !== true) out.push({ file: typeof row.file === 'string' ? row.file : null, name: String(row.name) });
    } catch {
      // a line cut off mid-write
    }
  }
  return out;
}

/** The node:test summary counts of a run's output ("ℹ tests N" lines, the last wins), or null. */
export function summaryCounts(text) {
  const counts = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^(?:ℹ|#) (tests|pass|fail|cancelled|skipped) (\d+)\s*$/.exec(line);
    if (match !== null) counts[match[1]] = Number(match[2]);
  }
  return counts.tests === undefined ? null : counts;
}

/** The faults the processes of the run logged (one JSON line each at exit), added up. */
export function faultTotals(logText, gitCallsText = '') {
  const total = { processes: 0, fsOps: 0, fsMs: 0, stalls: 0, stallMs: 0, errors: {}, starts: 0, startMs: 0, startStalls: 0, childEnv: 0, gitCalls: String(gitCallsText).length };
  for (const line of String(logText).split('\n')) {
    if (line.trim().length === 0) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    total.processes += 1;
    for (const key of ['fsOps', 'fsMs', 'stalls', 'stallMs', 'startMs', 'startStalls', 'childEnv', 'sqliteCommits', 'sqliteMs', 'sqliteStalls']) total[key] = (total[key] ?? 0) + (Number(row[key]) || 0);
    if (Number(row.startMs) > 0) total.starts += 1;
    for (const [code, n] of Object.entries(row.errors ?? {})) total.errors[code] = (total.errors[code] ?? 0) + Number(n);
  }
  return total;
}

/** One line for the faults a run injected. */
export function describeFaults(total) {
  const errors = Object.entries(total.errors).map(([code, n]) => `${code} x${n}`).join(', ');
  return [
    `${total.fsOps} slowed file operation(s) (${Math.round(total.fsMs / 1000)} s waited in all, ${total.stalls} stall(s) of ${total.stalls > 0 ? Math.round(total.stallMs / total.stalls / 100) / 10 : 0} s on average)`,
    `${Object.values(total.errors).reduce((sum, n) => sum + n, 0)} transient write error(s)${errors === '' ? '' : ` (${errors})`}`,
    `${total.starts} slowed process start(s) (${Math.round(total.startMs / 1000)} s waited, ${total.startStalls} of them 2 s)`,
    `${total.gitCalls} delayed git call(s)`,
    `${total.childEnv} child(ren) given the kit with their own environment`,
    `${total.sqliteCommits ?? 0} slowed COMMIT(s) (${Math.round((total.sqliteMs ?? 0) / 1000)} s waited, ${total.sqliteStalls ?? 0} stall(s))`,
    `${total.freezes ?? 0} process freeze(s) (${Math.round((total.frozenMs ?? 0) / 1000)} s stood still in all)`,
  ].join('; ');
}

/**
 * Failures across runs, grouped: [{ file, name, runs }] sorted by file and name, where `runs` is how many of the runs it failed in.
 * `perRun` is a list of failedTests() lists.
 */
export function groupFailures(perRun, root = repoRoot) {
  const seen = new Map();
  for (const failures of perRun) {
    const unique = new Set(failures.map((f) => `${f.file === null ? '' : relative(root, f.file).split(sep).join('/')}\0${f.name}`));
    for (const key of unique) seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen]
    .map(([key, runs]) => {
      const [file, name] = key.split('\0');
      return { file, name, runs };
    })
    .sort((a, b) => (a.file === b.file ? (a.name < b.name ? -1 : 1) : a.file < b.file ? -1 : 1));
}

// ------------------------------------------------------------------------------ the run

/**
 * Runs the selection `options.runs` times under the kit and returns the exit code. Called with the host suite lock and the
 * checkout's suite lock held (scripts/test-slow.mjs), so the burners never run beside another full suite and dist/ is not
 * rewritten under it.
 */
export async function runSlow(options, { say = (line) => console.log(line), errorSay = (line) => console.error(line), scaleOf = budgetScaleFor, build = null, runner = spawnRunner, burn = startBurners, freeze = startFreezer, files: listFiles = () => collectTestFiles(repoRoot), baseEnv = process.env, tmp = tmpdir() } = {}) {
  const quick = quickTestFiles(repoRoot, listFiles());
  const named = options.files.length > 0;
  const plan = [];
  for (let i = 0; i < options.runs; i += 1) {
    if (named) plan.push({ files: options.files, label: 'named files' });
    else if (options.quick || i > 0) plan.push({ files: quick, label: 'quick set' });
    else plan.push({ files: [], label: 'full suite' });
  }
  if (options.build && build !== null) {
    const code = build();
    if (code !== 0) return code;
  }
  const dir = mkdtempSync(join(tmp, 'jslow-'));
  const burners = burn(options.burners);
  const runs = [];
  let code = 0;
  let aborted = null;
  try {
    say(`test:slow: ${options.burners} CPU burner(s), budget scale ${options.scale ?? scaleOf({ ...baseEnv, CI: baseEnv.CI ?? '1' }, 'win32') ?? 'none'}, file delay ${options.fsDelayMs} ms, freezes ${options.freezeRate > 0 ? `${options.freezeMinMs}-${options.freezeMaxMs} ms at ${options.freezeRate} per tick` : 'off'}, process start ${options.startDelayMs} ms, git ${options.gitDelayMs} ms, ${options.fsErrorFirst ? 'a first transient error per retried path' : `transient errors at rate ${options.fsErrorRate}`}; kit in ${dir}`);
    for (let index = 0; index < plan.length && aborted === null; index += 1) {
      const { files, label } = plan[index];
      const runDir = join(dir, `run-${index + 1}`);
      const kit = writeKit(runDir, options, { runIndex: index, pathValue: baseEnv.PATH });
      const eventsFile = join(runDir, 'events.jsonl');
      const env = slowEnvironment(baseEnv, kit, options, { eventsFile, scaleOf });
      say(`test:slow: run ${index + 1} of ${plan.length}: ${label}${files.length > 0 ? ` (${files.length} file(s))` : ''}`);
      const started = Date.now();
      let freezer = null;
      const status = await runner({
        files,
        env,
        errorSay,
        // The freezer works below the runner's pid; a signal to this process ends the runner, then the kit.
        onStart: (pid) => {
          freezer = freeze({ rootPid: pid, rate: options.freezeRate, minMs: options.freezeMinMs, maxMs: options.freezeMaxMs, seed: options.seed + index });
        },
        onSignal: (signal) => {
          aborted = signal;
        },
      });
      freezer?.stop();
      const read = (file) => {
        try {
          return readFileSync(file, 'utf8');
        } catch {
          return '';
        }
      };
      const failures = failedTests(read(eventsFile));
      const events = read(eventsFile).split('\n').filter((line) => line.trim().length > 0);
      const faults = faultTotals(read(kit.log), read(kit.gitCalls));
      faults.freezes = freezer?.stats.freezes ?? 0;
      faults.frozenMs = freezer?.stats.frozenMs ?? 0;
      runs.push({ status, failures, tests: events.length, faults, ms: Date.now() - started, label });
      if (status !== 0 && code === 0) code = status;
      say(`test:slow: run ${index + 1} ${status === 0 ? 'passed' : `FAILED (exit ${status})`}: ${events.length} test(s) reported, ${failures.length} failed, in ${Math.round((Date.now() - started) / 1000)} s`);
      say(`test:slow: run ${index + 1} injected: ${describeFaults(faults)}`);
    }
  } finally {
    burners.stop();
    if (options.keep) errorSay(`test:slow: kept the kit folder ${dir} (the log of injected faults is run-N/faults.log)`);
    else rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
  if (aborted !== null) {
    errorSay(`test:slow: stopped by ${aborted}`);
    return aborted === 'SIGINT' ? 130 : 143;
  }
  const grouped = groupFailures(runs.map((run) => run.failures));
  const failedRuns = runs.filter((run) => run.status !== 0).length;
  if (grouped.length > 0) {
    say(`test:slow: ${grouped.length} failing test(s) over ${runs.length} run(s):`);
    for (const row of grouped) say(`  ${row.file === '' ? '(no file)' : row.file} :: ${row.name}  (failed in ${row.runs} of ${runs.length} run(s))`);
  } else if (failedRuns > 0) {
    say('test:slow: a run failed with no failing test reported (a file that did not finish, a guard of the runner): read the output above');
  }
  say(`test:slow: ${code === 0 ? 'PASS' : 'FAIL'}: ${runs.length - failedRuns} of ${runs.length} run(s) passed`);
  return code;
}

/** The runner of one run: `scripts/test.mjs --no-build <files>` in `env`, its output on this one's. Resolves with its exit code. */
export function spawnRunner({ files, env, errorSay, onStart, onSignal }) {
  return new Promise((resolveStatus) => {
    const child = spawn(process.execPath, [join(repoRoot, 'scripts', 'test.mjs'), '--no-build', ...files], { cwd: repoRoot, env, stdio: 'inherit', shell: false, windowsHide: true });
    onStart(child.pid);
    const forward = (signal) => {
      onSignal(signal);
      child.kill('SIGTERM');
    };
    process.once('SIGINT', forward);
    process.once('SIGTERM', forward);
    child.on('error', (error) => {
      errorSay(`test:slow: could not start the runner: ${error.message}`);
      resolveStatus(1);
    });
    child.on('close', (exit, signal) => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
      resolveStatus(exit ?? (signal === null ? 1 : 128));
    });
  });
}

/** Runs the build the way the suite does (scripts/build.mjs), before the kit starts, so the build is not slowed. */
export function buildFirst() {
  const result = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'build.mjs')], { cwd: repoRoot, env: process.env, stdio: 'inherit', shell: false, windowsHide: true });
  return result.status ?? 1;
}

export function refuseWindows(host = platform()) {
  return host === 'win32' ? 'the slow-host kit makes a fast POSIX host behave like the Windows runner; run the suite as it is on Windows' : null;
}

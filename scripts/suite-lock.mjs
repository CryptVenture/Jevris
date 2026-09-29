#!/usr/bin/env node
/**
 * The suite lock: one directory, `.jevris-suite.lock` at the checkout root, held by whatever
 * rewrites the checkout's dist/ (scripts/build.mjs, scripts/bundle.mjs) or runs the suite
 * against it (scripts/test.mjs). Several agents share one checkout, and a build that rewrites
 * dist/chunks while a suite runs pulls files out from under it. Taking the lock is automatic in
 * those scripts, so nobody has to remember it.
 *
 *   node scripts/suite-lock.mjs -- <command> [args...]   run one command while holding the lock
 *   node scripts/suite-lock.mjs --status                 say who holds it
 *
 * - The lock is created with mkdir, which is atomic. `owner.json` inside it names a random token,
 *   the pid, the host, the command and the start time.
 * - A holder removes only the lock it created: release reads owner.json and removes the
 *   directory only when the token is its own. A lock someone else holds is never removed.
 * - Children inherit JEVRIS_SUITE_LOCK_HELD=<token>, so `npm test` calling the build does not
 *   wait for itself.
 * - A lock whose holder process is gone (same host, the pid no longer exists) is taken over.
 *   A lock without a readable owner.json is waited for and never removed.
 * - A waiter gives up after JEVRIS_SUITE_LOCK_WAIT_S seconds (default 2700), naming the holder.
 *
 * The host suite lock is a second, machine-wide layer. Full suites and Docker cells from any
 * clone on this machine run one at a time, because several at once oversubscribe the machine
 * (and the Docker VM) until hook and decision deadlines fail. It holds only a token, the pid and
 * the start time, in a per-user folder in the system temp directory, never in a home. A waiter
 * prints "waiting for suite lock held by pid N since T". A lock whose pid is dead is stale and
 * is taken over. Children inherit JEVRIS_HOST_SUITE_LOCK_HELD, so a suite inside a held run
 * (verify:fresh, test:future, a cell) does not wait for itself. Single test files and lint
 * never take it. It waits JEVRIS_HOST_SUITE_LOCK_WAIT_S seconds (default 7200).
 *
 * The host lock is taken first come, first served. Each waiter puts a ticket in the queue folder
 * beside the lock (`<lock>.queue/`, one file per waiter: its pid, start time and token, named by
 * arrival time), refreshes it while it waits, and tries the lock only when no live ticket is
 * older than its own. A ticket whose pid is gone, or that has not been refreshed for
 * TICKET_STALE_MS, is swept, the way a stale lock is taken over; a live waiter's ticket is never
 * removed by anyone else. A waiter says "waiting: N ahead" whenever that count changes, and
 * removes its own ticket when it takes the lock or gives up (exit 75).
 *
 *   node scripts/suite-lock.mjs --host-status            say who holds the host suite lock
 *
 * Exit codes (CLI): the command's own; 75 the lock could not be taken in time; 2 usage.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOCK_DIR = '.jevris-suite.lock';
export const HELD_ENV = 'JEVRIS_SUITE_LOCK_HELD';
export const WAIT_ENV = 'JEVRIS_SUITE_LOCK_WAIT_S';
export const HOST_HELD_ENV = 'JEVRIS_HOST_SUITE_LOCK_HELD';
export const HOST_WAIT_ENV = 'JEVRIS_HOST_SUITE_LOCK_WAIT_S';
/** Tests point the host lock at their own folder with this. */
export const HOST_DIR_ENV = 'JEVRIS_HOST_SUITE_LOCK_DIR';
const DEFAULT_WAIT_S = 2700;
const DEFAULT_HOST_WAIT_S = 7200;
const POLL_MS = 2000;
/** A host-lock ticket not refreshed for this long is stale (its waiter polls every 2 s). */
export const TICKET_STALE_MS = 120_000;

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The holder recorded in a lock directory, or null when owner.json is missing or unreadable. */
export function readOwner(lockPath) {
  try {
    const owner = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8'));
    return owner !== null && typeof owner === 'object' && typeof owner.token === 'string' ? owner : null;
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error?.code === 'EPERM';
  }
}

/**
 * True only when the holder is provably gone: same host, and its pid no longer exists. A host
 * suite lock records no host: it is on this machine by where it lives.
 */
export function holderGone(owner, host = hostname()) {
  return owner !== null && (owner.host === undefined || owner.host === host) && Number.isInteger(owner.pid) && owner.pid > 0 && !alive(owner.pid);
}

export function describeOwner(owner) {
  if (owner === null) return 'an unknown holder (no readable owner.json)';
  if (owner.host === undefined) return `pid ${String(owner.pid)} since ${String(owner.startedAt)}`;
  return `${owner.command ?? 'a process'} (pid ${String(owner.pid)} on ${String(owner.host)}, since ${String(owner.startedAt)})`;
}

/**
 * The host suite lock's path: a per-user folder in the system temp directory. It is the real
 * temp directory, not a run's own TMPDIR (JEVRIS_REAL_TMPDIR, which scripts/test.mjs sets), so
 * every clone on the machine meets at the same lock.
 */
export function hostLockPath(env = process.env) {
  const override = env[HOST_DIR_ENV];
  if (typeof override === 'string' && override.length > 0) return join(override, 'jevris-host-suite.lock');
  let user = 'user';
  try {
    user = typeof process.getuid === 'function' ? String(process.getuid()) : userInfo().username.replace(/[^A-Za-z0-9_-]/g, '_');
  } catch {
    // keep the generic name
  }
  const base = typeof env.JEVRIS_REAL_TMPDIR === 'string' && env.JEVRIS_REAL_TMPDIR.length > 0 ? env.JEVRIS_REAL_TMPDIR : tmpdir();
  return join(base, `jevris-host-suite-${user}.lock`);
}

/** The host lock's queue folder: one ticket file per waiter. */
export function queuePath(lockPath) {
  return `${lockPath}.queue`;
}

/** A waiter's ticket: its file (named by arrival, so names sort in arrival order) and its content. */
export function writeTicket(lockPath, ticket) {
  const dir = queuePath(lockPath);
  mkdirSync(dir, { recursive: true });
  const name = `${String(ticket.arrivedMs).padStart(15, '0')}-${ticket.token}.json`;
  const file = join(dir, name);
  // Written aside and renamed in, so a reader never sees half a ticket.
  const aside = join(dir, `.${name}.tmp`);
  writeFileSync(aside, `${JSON.stringify({ pid: ticket.pid, startedAt: ticket.startedAt, token: ticket.token })}\n`);
  renameSync(aside, file);
  return file;
}

/**
 * The live tickets in arrival order, after sweeping the stale ones: a ticket whose pid is gone
 * or that was not refreshed for `staleMs`. A ticket that cannot be read is left in place and
 * does not hold anyone up. `own` (a ticket file) is never swept here; with `sweep: false`
 * (the status line) nothing is removed, and a stale ticket is only left out.
 */
export function liveTickets(lockPath, { own = null, nowMs = Date.now(), staleMs = TICKET_STALE_MS, say = () => {}, sweep = true } = {}) {
  const dir = queuePath(lockPath);
  let names = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json') && !name.startsWith('.')).sort();
  } catch {
    return [];
  }
  const live = [];
  for (const name of names) {
    const file = join(dir, name);
    let ticket = null;
    let modifiedMs = 0;
    try {
      ticket = JSON.parse(readFileSync(file, 'utf8'));
      modifiedMs = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (ticket === null || typeof ticket !== 'object' || !Number.isInteger(ticket.pid)) continue;
    const gone = file !== own && (!alive(ticket.pid) || nowMs - modifiedMs > staleMs);
    if (gone) {
      if (!sweep) continue;
      try {
        rmSync(file, { force: true });
        say(`host suite lock: removed the queue ticket of pid ${String(ticket.pid)} (since ${String(ticket.startedAt)}), which is no longer waiting`);
      } catch {
        // someone else swept it
      }
      continue;
    }
    live.push({ file, ...ticket });
  }
  return live;
}

/**
 * Takes the suite lock of `root`, waiting up to `waitMs`. Returns { release, token, reentrant }.
 * Throws an Error with code SUITE_LOCK_TIMEOUT when the lock stays held by someone else.
 */
export function acquireSuiteLock(root = repoRoot, options = {}) {
  return acquireLockAt(join(root, LOCK_DIR), options, { heldEnv: HELD_ENV, waitEnv: WAIT_ENV, defaultWaitS: DEFAULT_WAIT_S, label: 'suite lock', host: true });
}

/**
 * Takes the machine-wide host suite lock (see the header), waiting its turn. Returns
 * { release, token, reentrant }; throws SUITE_LOCK_TIMEOUT when it stays held.
 */
export function acquireHostSuiteLock(options = {}) {
  const env = options.env ?? process.env;
  const lockPath = options.lockPath ?? hostLockPath(env);
  mkdirSync(dirname(lockPath), { recursive: true });
  return acquireLockAt(lockPath, options, { heldEnv: HOST_HELD_ENV, waitEnv: HOST_WAIT_ENV, defaultWaitS: DEFAULT_HOST_WAIT_S, label: 'host suite lock', host: false });
}

function acquireLockAt(lockPath, options, kind) {
  const env = options.env ?? process.env;
  const waitS = Number(env[kind.waitEnv]);
  const waitMs = options.waitMs ?? (env[kind.waitEnv] !== undefined && Number.isFinite(waitS) && waitS >= 0 ? waitS * 1000 : kind.defaultWaitS * 1000);
  const pollMs = options.pollMs ?? POLL_MS;
  const say = options.say ?? ((line) => process.stderr.write(`${line}\n`));
  const held = env[kind.heldEnv];
  if (typeof held === 'string' && held.length > 0 && readOwner(lockPath)?.token === held) {
    return { token: held, reentrant: true, release: () => false };
  }
  const token = randomBytes(12).toString('hex');
  const startedAt = new Date().toISOString();
  const pid = options.pid ?? process.pid;
  // The host lock holds the pid and the start time only (and the token that proves ownership).
  const owner = kind.host ? { token, pid, host: hostname(), command: options.command ?? process.argv.slice(1).join(' ').slice(0, 200), startedAt } : { token, pid, startedAt };
  const deadline = Date.now() + waitMs;
  let announced = false;
  // The host lock is first come, first served: a ticket in its queue, tried only at the front.
  const queued = kind.host === false;
  let ticket = queued ? writeTicket(lockPath, { arrivedMs: Date.now(), pid, startedAt, token }) : null;
  const dropTicket = () => {
    if (ticket !== null) rmSync(ticket, { force: true });
  };
  let lastAhead = 0;
  for (;;) {
    let ahead = 0;
    if (ticket !== null) {
      try {
        const now = new Date();
        utimesSync(ticket, now, now);
      } catch {
        // swept while this process was held up: queue again at the back
        ticket = writeTicket(lockPath, { arrivedMs: Date.now(), pid, startedAt, token });
      }
      const live = liveTickets(lockPath, { own: ticket, say });
      const mine = live.findIndex((item) => item.token === token);
      ahead = mine === -1 ? live.length : mine;
      if (ahead !== lastAhead && ahead > 0) say(`host suite lock: waiting: ${String(ahead)} ahead`);
      lastAhead = ahead;
    }
    if (ahead === 0) try {
      mkdirSync(lockPath);
      try {
        writeFileSync(join(lockPath, 'owner.json'), `${JSON.stringify(owner)}\n`);
      } catch (error) {
        rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      dropTicket();
      env[kind.heldEnv] = token;
      let released = false;
      const release = () => {
        if (released) return false;
        released = true;
        if (env[kind.heldEnv] === token) delete env[kind.heldEnv];
        // Only a lock this call created is removed.
        if (readOwner(lockPath)?.token !== token) return false;
        rmSync(lockPath, { recursive: true, force: true });
        return true;
      };
      return { token, reentrant: false, release };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        dropTicket();
        throw error;
      }
    }
    const current = readOwner(lockPath);
    if (ahead === 0 && holderGone(current)) {
      // Move the dead holder's lock aside under a unique name, then check it was that one.
      const aside = `${lockPath}.stale-${token}`;
      try {
        renameSync(lockPath, aside);
        if (readOwner(aside)?.token === current.token) {
          rmSync(aside, { recursive: true, force: true });
          say(`${kind.label}: took over from ${describeOwner(current)}, which is no longer running`);
        } else {
          try {
            renameSync(aside, lockPath);
          } catch {
            // A new holder took the lock meanwhile; leave the moved directory for inspection.
          }
        }
      } catch {
        // Someone else moved or released it first.
      }
      continue;
    }
    if (Date.now() >= deadline) {
      dropTicket();
      const queue = ahead > 0 ? ` with ${String(ahead)} waiter(s) ahead` : '';
      const error = new Error(`the ${kind.label} ${lockPath} is held by ${existsSync(lockPath) ? describeOwner(current) : 'no one'}${queue}. Wait for it to finish, or run through node scripts/suite-lock.mjs if you hold it yourself.`);
      error.code = 'SUITE_LOCK_TIMEOUT';
      throw error;
    }
    if (!announced && existsSync(lockPath)) {
      say(kind.host ? `suite lock: waiting for ${describeOwner(current)}` : `waiting for suite lock held by ${describeOwner(current)} (the host suite lock: one full suite or Docker cell at a time on this machine)`);
      announced = true;
    }
    sleepSync(Math.max(1, Math.min(pollMs, deadline - Date.now())));
  }
}

/**
 * Runs `fn` while holding the lock and releases it afterwards, also on SIGINT, SIGTERM and exit.
 * `fn` may return a promise.
 */
export async function withSuiteLock(root, fn, options = {}) {
  return withLock(acquireSuiteLock(root, options), fn);
}

/** Runs `fn` holding the host suite lock, released afterwards and on SIGINT, SIGTERM and exit. */
export async function withHostSuiteLock(fn, options = {}) {
  return withLock(acquireHostSuiteLock(options), fn);
}

async function withLock(lock, fn) {
  const onExit = () => lock.release();
  const onSignal = (signal) => {
    lock.release();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.on('exit', onExit);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    return await fn(lock);
  } finally {
    process.off('exit', onExit);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    lock.release();
  }
}

/**
 * For a script's entry point: runs `fn` under the lock and returns its exit code, or 75 with
 * the holder named when the lock stays held.
 */
export async function runLocked(root, fn, options = {}) {
  try {
    return await withSuiteLock(root, fn, options);
  } catch (error) {
    if (error?.code !== 'SUITE_LOCK_TIMEOUT') throw error;
    console.error(`suite-lock: ${error.message}`);
    return 75;
  }
}

/** For a full suite or a Docker cell: `fn` under the host suite lock, or 75 when it stays held. */
export async function runHostLocked(fn, options = {}) {
  try {
    return await withHostSuiteLock(fn, options);
  } catch (error) {
    if (error?.code !== 'SUITE_LOCK_TIMEOUT') throw error;
    console.error(`suite-lock: ${error.message}`);
    return 75;
  }
}

function isMain(moduleUrl) {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry.length === 0) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entry);
  } catch {
    return false;
  }
}

async function main(argv) {
  if (argv[0] === '--host-status') {
    const lockPath = hostLockPath();
    console.log(existsSync(lockPath) ? `host suite lock: held by ${describeOwner(readOwner(lockPath))}` : 'host suite lock: free');
    const waiting = liveTickets(lockPath, { sweep: false });
    if (waiting.length > 0) console.log(`host suite lock: waiting: ${waiting.map((item) => `pid ${String(item.pid)} since ${String(item.startedAt)}`).join(', ')}`);
    return 0;
  }
  if (argv[0] === '--status') {
    const lockPath = join(repoRoot, LOCK_DIR);
    console.log(existsSync(lockPath) ? `suite lock: held by ${describeOwner(readOwner(lockPath))}` : 'suite lock: free');
    return 0;
  }
  const dash = argv.indexOf('--');
  const command = dash === -1 ? [] : argv.slice(dash + 1);
  if (command.length === 0) {
    console.error('usage: node scripts/suite-lock.mjs -- <command> [args...] | --status');
    return 2;
  }
  return runLocked(repoRoot, () => {
    const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit', env: process.env, shell: false, windowsHide: true });
    if (result.error !== undefined) {
      console.error(`suite-lock: ${command[0]} did not start: ${result.error.message}`);
      return 127;
    }
    return result.status ?? 1;
  }, { command: command.join(' ').slice(0, 200) });
}

if (isMain(import.meta.url)) process.exit(await main(process.argv.slice(2)));

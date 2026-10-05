'use strict';
/**
 * The slow-host preload: makes a fast developer machine behave like a loaded Windows CI runner.
 * TEST ONLY. Only scripts/slow-host.mjs (npm run test:slow) loads it, through a generated
 * `enable.cjs` named in NODE_OPTIONS (`--require`); no product file names it and lint/slow-host
 * keeps it that way. It reads its configuration from JEVRIS_SLOW_CONFIG (a JSON object the kit
 * writes) and does nothing without one that says `active: true`.
 *
 * What it does, in every node process the run starts (the test files, and the CLI, sidecar and hook
 * they start):
 *   - start: the process waits `start.delayMs` before it runs anything, and now and then a few
 *     seconds (a Windows process start goes through the scanner and a cold file cache);
 *   - fs delay: the synchronous, callback and promise forms of writeFile, appendFile, write, rename,
 *     fsync, open and copyFile wait `fs.delayMs`, and now and then, in a burst, `fs.stallMs` (a
 *     flush storm, a scanner holding the volume). Synchronous calls block the thread, as they do
 *     on a slow disk;
 *   - fs errors: a small fraction of the writes the product RETRIES fails once with EBUSY or EPERM
 *     (what Defender and an indexer do): an append to a log or a trace file, a rename of a durable
 *     write's `.jtmp`, an unlink of a `.lock` file. Only those operations are eligible by default,
 *     because the product retries them; an operation it cannot retry is never failed unless the
 *     kit is asked to (`fs.errors.rules`);
 *   - sqlite: a COMMIT (`Statement.run` of a COMMIT and `exec('COMMIT')` in better-sqlite3) waits `sqlite.delayMs` before it
 *     runs, and now and then `sqlite.stallMs`: the transaction still holds its write lock, so a hot commit that meets it waits
 *     as it does on a runner whose disk flush stalls (the maintenance hot-commit test of 2026-10-05);
 *   - children: a child a test starts with an environment of its own (no NODE_OPTIONS) gets this
 *     preload put into it, so `{ PATH, HOME, ... }` children are as slow as the rest.
 *
 * It only ever touches paths under the process's temporary folder (the run's TMPDIR), never the
 * account's real home (and no folder that holds it or sits inside it), and it never changes what an operation does: it waits, or fails an operation the
 * product retries. It writes nothing but one summary line per process to the kit's own log.
 */

// A process under Node's permission model cannot even read this file's helpers: it is left alone.
const config = process.permission !== undefined ? null : (() => {
  try {
    const parsed = JSON.parse(process.env.JEVRIS_SLOW_CONFIG || 'null');
    return parsed !== null && typeof parsed === 'object' && parsed.active === true ? parsed : null;
  } catch {
    return null;
  }
})();

if (config !== null) install(config);

function install(cfg) {
  const fs = require('node:fs');
  const fsp = require('node:fs/promises');
  const cp = require('node:child_process');
  const os = require('node:os');
  const path = require('node:path');
  const { syncBuiltinESMExports } = require('node:module');

  const original = {
    appendFileSync: fs.appendFileSync,
    realpathSync: fs.realpathSync,
  };

  // ---------------------------------------------------------------- randomness and waiting
  let state = (Number(cfg.seed || 1) * 2654435761 + process.pid) >>> 0;
  const rnd = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const between = (a, b) => a + Math.floor(rnd() * (Math.max(a, b) - a + 1));
  const cell = new Int32Array(new SharedArrayBuffer(4));
  const sleepSync = (ms) => {
    if (ms > 0) Atomics.wait(cell, 0, 0, ms);
  };
  const sleepAsync = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ---------------------------------------------------------------- statistics (one line at exit)
  const stats = { pid: process.pid, argv: String(process.argv[1] || '').split(/[\\/]/).slice(-2).join('/'), fsOps: 0, fsMs: 0, stalls: 0, stallMs: 0, errors: {}, startMs: 0, startStalls: 0, childEnv: 0 };
  const log = typeof cfg.log === 'string' && cfg.log.length > 0 ? cfg.log : null;
  process.on('exit', () => {
    if (log === null || (stats.fsOps === 0 && stats.startMs === 0 && stats.childEnv === 0 && !stats.sqliteCommits && Object.keys(stats.errors).length === 0)) return;
    try {
      original.appendFileSync(log, `${JSON.stringify(stats)}\n`);
    } catch {
      // the kit's log is best effort
    }
  });

  // ---------------------------------------------------------------- process start
  // Only a process that runs a script file starts late: a helper a test starts with `node -e` (a stdin writer, a one-line probe) is not a
  // product process, and one that exits at once would otherwise outlive the write the test makes to it (test/child-stdin.test.mjs).
  const start = cfg.start;
  const isRunner = process.execArgv.includes('--test') || process.env.JEVRIS_SLOW_NO_START === '1';
  const runsFile = typeof process.argv[1] === 'string' && process.argv[1].length > 0;
  if (start && start.delayMs > 0 && !isRunner && runsFile) {
    const long = start.stallRate > 0 && rnd() < start.stallRate;
    const ms = long ? between(...(start.stallMs || [2000, 2000])) : start.delayMs;
    stats.startMs = ms;
    if (long) stats.startStalls = 1;
    sleepSync(ms);
  }

  // ---------------------------------------------------------------- scope: only under the temp folder
  // The REAL home (the account's own, from the kit's configuration or the password database), never the HOME variable: a test run
  // points HOME at a temporary home inside its temporary folder, and that folder is exactly where the faults belong.
  const realHome = (() => {
    try {
      return path.resolve(typeof cfg.realHome === 'string' && cfg.realHome.length > 0 ? cfg.realHome : os.userInfo().homedir);
    } catch {
      return null;
    }
  })();
  const roots = [];
  for (const raw of [os.tmpdir(), process.env.TMPDIR, process.env.TMP, process.env.TEMP, process.env.JEVRIS_HOME]) {
    if (typeof raw !== 'string' || raw.length === 0 || !path.isAbsolute(raw)) continue;
    for (const form of [path.resolve(raw), (() => { try { return original.realpathSync(raw); } catch { return null; } })()]) {
      if (form === null || form === path.parse(form).root) continue;
      // A folder that holds the real home (or is it, or sits inside it) is not a temp folder: never in scope, so the real home is never touched.
      if (realHome === null || realHome === form || realHome.startsWith(form + path.sep) || form.startsWith(realHome + path.sep)) continue;
      if (!roots.includes(form)) roots.push(form);
    }
  }
  const runnerOwn = /[\\/](?:serial-gate|batches)[\\/]|\.(?:ledger|home-writes)$/;
  const scopeMatch = cfg.fs && typeof cfg.fs.match === 'string' && cfg.fs.match.length > 0 ? new RegExp(cfg.fs.match) : null;
  const toPath = (target) => {
    if (typeof target === 'string') return target;
    if (target instanceof URL) return target.protocol === 'file:' ? require('node:url').fileURLToPath(target) : null;
    if (Buffer.isBuffer(target)) return target.toString();
    return null;
  };
  const fdPaths = new Map();
  const resolveTarget = (target) => {
    if (typeof target === 'number') return fdPaths.get(target) ?? null;
    const text = toPath(target);
    return text === null ? null : path.resolve(text);
  };
  const inScope = (full) => full !== null && roots.some((root) => full.startsWith(root + path.sep)) && !runnerOwn.test(full) && (scopeMatch === null || scopeMatch.test(full));
  const track = (fd, target) => {
    const full = resolveTarget(target);
    if (typeof fd === 'number' && full !== null && roots.some((root) => full.startsWith(root + path.sep))) fdPaths.set(fd, full);
  };

  // ---------------------------------------------------------------- fs delays (bursty stalls)
  const spec = cfg.fs || {};
  let burstLeft = 0;
  const fsDelay = () => {
    if (burstLeft > 0) {
      burstLeft -= 1;
      return between(...(spec.stallMs || [1500, 3000]));
    }
    if (spec.stallRate > 0 && rnd() < spec.stallRate) {
      burstLeft = between(0, spec.burstExtra === undefined ? 2 : spec.burstExtra);
      return between(...(spec.stallMs || [1500, 3000]));
    }
    return spec.delayMs > 0 ? spec.delayMs : 0;
  };
  const account = (ms) => {
    stats.fsOps += 1;
    stats.fsMs += ms;
    if (ms >= 500) {
      stats.stalls += 1;
      stats.stallMs += ms;
    }
  };

  // ---------------------------------------------------------------- fs errors on retryable operations only
  const errorSpec = spec.errors || {};
  const errorCodes = Array.isArray(errorSpec.codes) && errorSpec.codes.length > 0 ? errorSpec.codes : ['EBUSY', 'EPERM'];
  const errorRules = (Array.isArray(errorSpec.rules) ? errorSpec.rules : []).map((rule) => ({ ops: new Set(rule.ops), match: new RegExp(rule.match), on: rule.on === 'from' ? 'from' : 'target' }));
  const failedOnce = new Set();
  const failure = (op, full) => {
    const code = errorCodes[between(0, errorCodes.length - 1)];
    const error = new Error(`${code}: ${code === 'EBUSY' ? 'resource busy or locked' : 'operation not permitted'}, ${op} '${full}'`);
    error.code = code;
    error.syscall = op;
    error.path = full;
    error.errno = code === 'EBUSY' ? -16 : -1;
    stats.errors[code] = (stats.errors[code] || 0) + 1;
    return error;
  };
  /** Whether a product bundle (a file under a `dist` folder) is on the stack: a test's own fixture write is never failed. */
  const callerIsProduct = () => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 40;
    const stack = String(new Error().stack);
    Error.stackTraceLimit = limit;
    return /[\\/]dist[\\/]/.test(stack);
  };
  /** An error to inject for `op` on (`from`, `target`), or null. `product` is a caller check made earlier (a handle method waits first). */
  const injected = (op, from, target, product) => {
    if (errorRules.length === 0) return null;
    const targetPath = resolveTarget(target);
    const fromPath = resolveTarget(from);
    for (const rule of errorRules) {
      if (!rule.ops.has(op)) continue;
      const full = rule.on === 'from' ? fromPath : targetPath;
      if (full === null || !roots.some((root) => full.startsWith(root + path.sep)) || runnerOwn.test(full) || !rule.match.test(full)) continue;
      if (!(product === undefined ? callerIsProduct() : product)) continue;
      if (errorSpec.firstPerPath === true) {
        const key = `${op}\0${full}`;
        if (failedOnce.has(key)) continue;
        failedOnce.add(key);
        return failure(op, full);
      }
      if (errorSpec.rate > 0 && rnd() < errorSpec.rate) return failure(op, full);
    }
    return null;
  };

  /** The wrapper keeps the original's own symbols (util.promisify.custom on fs.write), so promisify still works. */
  const keep = (wrapper, fn) => {
    for (const symbol of Object.getOwnPropertySymbols(fn)) Object.defineProperty(wrapper, symbol, Object.getOwnPropertyDescriptor(fn, symbol));
    return wrapper;
  };

  // Which argument names the file for each operation (0: first, 1: second; `from` is the source of a rename).
  const delayed = {
    sync: ['writeFileSync', 'appendFileSync', 'renameSync', 'fsyncSync', 'openSync', 'writeSync', 'copyFileSync'],
    callback: ['writeFile', 'appendFile', 'rename', 'fsync', 'open', 'write', 'copyFile'],
    promise: ['writeFile', 'appendFile', 'rename', 'open', 'copyFile'],
  };
  const renaming = new Set(['renameSync', 'rename', 'copyFileSync', 'copyFile']);
  const wantsError = new Set(['writeFileSync', 'appendFileSync', 'renameSync', 'writeSync', 'unlinkSync', 'writeFile', 'appendFile', 'rename', 'write', 'unlink']);
  const fileOf = (name, args) => (renaming.has(name) ? args[1] : args[0]);
  const fromOf = (name, args) => (renaming.has(name) ? args[0] : undefined);
  const delayFor = (name, args) => {
    const target = resolveTarget(fileOf(name, args));
    if (!inScope(target)) return 0;
    const ms = fsDelay();
    account(ms);
    return ms;
  };
  for (const name of delayed.sync) {
    const fn = fs[name];
    if (typeof fn !== 'function') continue;
    fs[name] = keep(function slowSync(...args) {
      sleepSync(delayFor(name, args));
      if (wantsError.has(name)) {
        const error = injected(name.replace(/Sync$/, ''), fromOf(name, args), fileOf(name, args));
        if (error !== null) throw error;
      }
      const result = fn.apply(this, args);
      if (name === 'openSync') track(result, args[0]);
      return result;
    }, fn);
  }
  if (typeof fs.unlinkSync === 'function') {
    const fn = fs.unlinkSync;
    fs.unlinkSync = function slowUnlinkSync(...args) {
      const error = injected('unlink', undefined, args[0]);
      if (error !== null) throw error;
      return fn.apply(this, args);
    };
  }
  if (typeof fs.closeSync === 'function') {
    const fn = fs.closeSync;
    fs.closeSync = function trackedClose(fd, ...rest) {
      fdPaths.delete(fd);
      return fn.call(this, fd, ...rest);
    };
  }
  for (const name of delayed.callback) {
    const fn = fs[name];
    if (typeof fn !== 'function') continue;
    fs[name] = keep(function slowCallback(...args) {
      const ms = delayFor(name, args);
      const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      const error = wantsError.has(name) && callback !== null ? injected(name, fromOf(name, args), fileOf(name, args)) : null;
      const run = () => {
        if (error !== null) {
          process.nextTick(callback, error);
          return;
        }
        if (name === 'open' && callback !== null) {
          const target = args[0];
          args[args.length - 1] = function opened(err, fd) {
            if (!err) track(fd, target);
            return callback.call(this, err, fd);
          };
        }
        fn.apply(fs, args);
      };
      // Node gives no order between two asynchronous operations in flight on one file (the thread pool), so none is kept here either.
      if (ms > 0) setTimeout(run, ms);
      else run();
    }, fn);
  }
  if (typeof fs.unlink === 'function') {
    const fn = fs.unlink;
    fs.unlink = function slowUnlink(...args) {
      const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      const error = callback !== null ? injected('unlink', undefined, args[0]) : null;
      if (error !== null) {
        process.nextTick(callback, error);
        return;
      }
      return fn.apply(this, args);
    };
  }
  if (typeof fs.close === 'function') {
    const fn = fs.close;
    fs.close = function trackedCloseAsync(fd, ...rest) {
      fdPaths.delete(fd);
      return fn.call(this, fd, ...rest);
    };
  }

  // fs/promises: the calls, and the FileHandle `open` returns.
  const wrapHandle = (handle, target) => {
    const full = resolveTarget(target);
    if (!inScope(full)) return handle;
    for (const method of ['sync', 'write', 'writeFile', 'appendFile']) {
      const fn = handle[method];
      if (typeof fn !== 'function') continue;
      handle[method] = async function slowHandle(...args) {
        const product = method !== 'sync' && errorRules.length > 0 ? callerIsProduct() : false;
        const ms = fsDelay();
        account(ms);
        if (ms > 0) await sleepAsync(ms);
        if (method !== 'sync') {
          const error = injected(method === 'write' ? 'write' : 'writeFile', undefined, full, product);
          if (error !== null) throw error;
        }
        return fn.apply(this, args);
      };
    }
    return handle;
  };
  for (const name of delayed.promise) {
    const fn = fsp[name];
    if (typeof fn !== 'function') continue;
    fsp[name] = keep(async function slowPromise(...args) {
      const ms = delayFor(name, args);
      if (ms > 0) await sleepAsync(ms);
      if (wantsError.has(name)) {
        const error = injected(name, fromOf(name, args), fileOf(name, args));
        if (error !== null) throw error;
      }
      const result = await fn.apply(this, args);
      return name === 'open' ? wrapHandle(result, args[0]) : result;
    }, fn);
  }
  if (typeof fsp.unlink === 'function') {
    const fn = fsp.unlink;
    fsp.unlink = async function slowUnlinkPromise(...args) {
      const error = injected('unlink', undefined, args[0]);
      if (error !== null) throw error;
      return fn.apply(this, args);
    };
  }

  // ---------------------------------------------------------------- slow commits (better-sqlite3), patched when it loads
  const sqlite = cfg.sqlite;
  if (sqlite && (sqlite.delayMs > 0 || sqlite.stallRate > 0)) {
    const Module = require('node:module');
    const load = Module._load;
    const patched = new WeakSet();
    const COMMIT = /^\s*(?:COMMIT|END)\b/i;
    let sqlBurst = 0;
    const commitDelay = () => {
      const stallMs = sqlite.stallMs || [300, 800];
      let ms = sqlite.delayMs > 0 ? sqlite.delayMs : 0;
      if (sqlBurst > 0) {
        sqlBurst -= 1;
        ms = between(stallMs[0], stallMs[1]);
      } else if (sqlite.stallRate > 0 && rnd() < sqlite.stallRate) {
        ms = between(stallMs[0], stallMs[1]);
      }
      stats.sqliteCommits = (stats.sqliteCommits || 0) + 1;
      stats.sqliteMs = (stats.sqliteMs || 0) + ms;
      if (ms >= 200) stats.sqliteStalls = (stats.sqliteStalls || 0) + 1;
      sleepSync(ms);
    };
    const patchSqlite = (Database) => {
      if (typeof Database !== 'function' || patched.has(Database)) return;
      patched.add(Database);
      try {
        const probe = new Database(':memory:');
        const proto = Object.getPrototypeOf(probe.prepare('SELECT 1'));
        const run = proto.run;
        proto.run = function slowRun(...args) {
          if (COMMIT.test(this.source)) commitDelay();
          return run.apply(this, args);
        };
        const exec = Database.prototype.exec;
        Database.prototype.exec = function slowExec(sql, ...rest) {
          if (typeof sql === 'string' && COMMIT.test(sql)) commitDelay();
          return exec.call(this, sql, ...rest);
        };
        probe.close();
      } catch {
        // an addon this preload cannot probe is left as it is
      }
    };
    Module._load = function slowLoad(request, ...rest) {
      const exports = load.call(this, request, ...rest);
      if (typeof request === 'string' && /better-sqlite3(?:[\\/]lib[\\/]index\.js)?$/.test(request)) patchSqlite(exports);
      return exports;
    };
  }

  // ---------------------------------------------------------------- children with an environment of their own
  const enable = typeof cfg.enable === 'string' ? cfg.enable : '';
  const quoted = /\s/.test(enable) ? `"${enable}"` : enable;
  const withEnable = (options) => {
    if (enable.length === 0 || options === null || typeof options !== 'object' || Array.isArray(options)) return options;
    const env = options.env;
    if (env === null || typeof env !== 'object') return options;
    const current = typeof env.NODE_OPTIONS === 'string' ? env.NODE_OPTIONS : '';
    if (current.includes(enable)) return options;
    stats.childEnv += 1;
    return { ...options, env: { ...env, NODE_OPTIONS: `${current} --require=${quoted}`.trim() } };
  };
  /** The options with the kit taken out of NODE_OPTIONS (explicit or inherited), for a child that could not load it. */
  const withoutEnable = (options) => {
    const base = options !== null && typeof options === 'object' && !Array.isArray(options) ? options : {};
    const env = base.env !== null && typeof base.env === 'object' ? base.env : process.env;
    const current = typeof env.NODE_OPTIONS === 'string' ? env.NODE_OPTIONS : '';
    if (enable.length === 0 || !current.includes(enable)) return options;
    const stripped = current.replace(/(?:^|\s)--require=(?:"[^"]*"|\S*)/g, (match) => (match.includes(enable) ? '' : match)).trim();
    return { ...base, env: { ...env, NODE_OPTIONS: stripped } };
  };
  const isNode = (file) => typeof file === 'string' && (file === process.execPath || /^node(?:\.exe)?$/i.test(path.basename(file)));
  const optionsIndex = (args) => (Array.isArray(args[1]) ? 2 : 1);
  /** A child started under Node's permission model could not load the preload (it may read nothing outside its allowed paths). */
  const underPermission = (args) => (Array.isArray(args[1]) ? args[1] : []).some((arg) => /^--(?:experimental-)?permission$/.test(String(arg)));
  if (cfg.injectEnv !== false) {
    for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
      const fn = cp[name];
      cp[name] = function withSlowEnv(...args) {
        if (isNode(args[0])) {
          const at = optionsIndex(args);
          if (underPermission(args)) args.splice(at, args[at] !== undefined && typeof args[at] === 'object' ? 1 : 0, withoutEnable(args[at] !== undefined && typeof args[at] === 'object' ? args[at] : undefined));
          else if (args[at] !== undefined && typeof args[at] === 'object') args[at] = withEnable(args[at]);
        }
        return fn.apply(this, args);
      };
    }
    const fork = cp.fork;
    cp.fork = function forkWithSlowEnv(...args) {
      const at = optionsIndex(args);
      const execArgv = args[at] !== undefined && typeof args[at] === 'object' && Array.isArray(args[at].execArgv) ? args[at].execArgv : [];
      if (args[at] !== undefined && typeof args[at] === 'object' && !execArgv.some((arg) => /^--(?:experimental-)?permission$/.test(String(arg)))) args[at] = withEnable(args[at]);
      return fork.apply(this, args);
    };
  }

  syncBuiltinESMExports();
}

// Preloaded into every test process by scripts/test.mjs (NODE_OPTIONS --import).
// Blocks resolution of @napi-rs/keyring so no test process can load the OS keychain
// binding, even through a code path that forgot to inject a memory keyring.
import * as nodeModule from 'node:module';
import { resolveSync } from './test-keyring-hooks.mjs';
// npm run test:future: Date and file times move ahead; a no-op otherwise.
import './test-clock-shift.mjs';
// Process hygiene: a process a test started ends once that test file's process has gone.
import { installOwnerWatch } from './test-owner-watch.mjs';

if (typeof nodeModule.registerHooks === 'function') {
  nodeModule.registerHooks({ resolve: resolveSync });
} else {
  nodeModule.register(new URL('./test-keyring-hooks.mjs', import.meta.url));
}

installOwnerWatch();

// Temp attribution (QA-07): every test process runs with the run's own TMPDIR, so a directory
// created directly in the real temp dir (a hard-coded /tmp path, say) is a leak of this run.
// Each one is appended to the run's ledger; scripts/test.mjs names those still present at the
// end. Entries other programs create there are never in the ledger, so they never count.
import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';

const realTemp = process.env.JEVRIS_REAL_TMPDIR;
const ledger = process.env.JEVRIS_TEMP_LEDGER;
if (typeof realTemp === 'string' && realTemp.length > 0 && typeof ledger === 'string' && ledger.length > 0) {
  const require = createRequire(import.meta.url);
  const fs = require('node:fs');
  const { syncBuiltinESMExports } = require('node:module');
  const roots = new Set([resolve(realTemp)]);
  try {
    roots.add(fs.realpathSync(realTemp));
  } catch {
    // keep the plain path
  }
  const append = fs.appendFileSync;
  const note = (path) => {
    try {
      const full = resolve(String(path));
      if (roots.has(dirname(full))) append(ledger, `${full}\n`);
    } catch {
      // attribution never breaks a test
    }
  };
  const wrapSync = (name, pick) => {
    const original = fs[name];
    fs[name] = function wrapped(...args) {
      const out = original.apply(this, args);
      note(pick(args, out));
      return out;
    };
  };
  wrapSync('mkdtempSync', (_args, out) => out);
  // A recursive mkdir returns the first directory it created, which is the one to attribute.
  const firstMade = (args, out) => (typeof out === 'string' ? out : args[0]);
  wrapSync('mkdirSync', firstMade);
  const promises = fs.promises;
  for (const [name, pick] of [['mkdtemp', (_args, out) => out], ['mkdir', firstMade]]) {
    const original = promises[name];
    promises[name] = async function wrapped(...args) {
      const out = await original.apply(this, args);
      note(pick(args, out));
      return out;
    };
  }
  syncBuiltinESMExports();
}
// Home-write attribution (QA-07). Every write, removal, rename, copy, link, mkdir or open for
// writing that lands inside the real home is appended to the run's home-write ledger, and so is
// every native SQLite database a test process opens there for writing (better-sqlite3 writes in
// C, past the fs module). scripts/test.mjs fails the run on any entry: a test process never
// writes to the real home. Paths inside the checkout, the real temp dir and the run's own temp
// dir are not the home's (a CI checkout or a Windows temp dir can sit inside the home).
// Children get the same preload and ledger even when a test hands them an explicit env.
// The runner's own variables: a test that overrides JEVRIS_TEST_REAL_HOME for a child never moves them.
// The real harness configuration roots (the account's XDG_CONFIG_HOME, CODEX_HOME,
// CLAUDE_CONFIG_DIR and APPDATA, which the runner points into the temporary home; the runner
// passes them as JEVRIS_GUARD_REAL_ROOTS, a JSON array) are guarded the same way, wherever they are. Each entry names the test file it came from (JEVRIS_TEST_ORIGIN):
// node --test runs every file in a process of its own, and children inherit the name. Paths only.
const realHome = process.env.JEVRIS_GUARD_REAL_HOME;
const homeLedger = process.env.JEVRIS_HOME_WRITE_LEDGER;
if (typeof realHome === 'string' && realHome.length > 0 && typeof homeLedger === 'string' && homeLedger.length > 0) {
  const require = createRequire(import.meta.url);
  const fs = require('node:fs');
  const childProcess = require('node:child_process');
  const nodeModuleCjs = require('node:module');
  const { syncBuiltinESMExports } = nodeModuleCjs;
  const { sep } = require('node:path');
  const { fileURLToPath } = require('node:url');
  const both = (path) => {
    const out = [resolve(path)];
    try {
      out.push(fs.realpathSync(path));
    } catch {
      // keep the plain path
    }
    return [...new Set(out)];
  };
  const within = (full, roots) => roots.some((root) => full === root || full.startsWith(root.endsWith(sep) ? root : `${root}${sep}`));
  const realRootsText = process.env.JEVRIS_GUARD_REAL_ROOTS;
  const realRoots = (() => {
    try {
      const parsed = typeof realRootsText === 'string' && realRootsText.length > 0 ? JSON.parse(realRootsText) : [];
      return Array.isArray(parsed) ? parsed.filter((root) => typeof root === 'string' && isAbsolute(root)) : [];
    } catch {
      return [];
    }
  })();
  const homes = [...new Set([realHome, ...realRoots].flatMap(both))];
  const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');
  const notHome = [repo, process.env.JEVRIS_REAL_TMPDIR, process.env.TMPDIR, process.env.TMP, process.env.TEMP]
    .filter((path) => typeof path === 'string' && path.length > 0)
    .flatMap(both)
    // Only a directory strictly inside a guarded root is carved out of it; a temp dir that holds
    // the home (a test's fake home) never hides it.
    .filter((root) => !homes.includes(root) && within(root, homes));
  // The test file this process belongs to, relative to the checkout: inherited from the process
  // that started this one, else this process's own main module when node:test started it (the
  // runner's parent process runs no test of its own and names none).
  const origin = (() => {
    const inherited = process.env.JEVRIS_TEST_ORIGIN;
    if (typeof inherited === 'string' && inherited.length > 0) return inherited;
    const main = process.argv[1];
    if ((process.env.NODE_TEST_CONTEXT ?? '').length === 0 || typeof main !== 'string' || main.length === 0) return '';
    const full = resolve(main);
    return (within(full, [repo]) ? full.slice(repo.length + 1) : full).split(sep).join('/');
  })();
  if (origin.length > 0) process.env.JEVRIS_TEST_ORIGIN = origin;
  const append = fs.appendFileSync;
  const note = (path) => {
    try {
      if (typeof path !== 'string' && !(path instanceof URL) && !Buffer.isBuffer(path)) return;
      const full = resolve(path instanceof URL ? fileURLToPath(path) : String(path));
      if (within(full, homes) && !within(full, notHome)) append(homeLedger, `${origin.length > 0 ? JSON.stringify([full, origin]) : full}\n`);
    } catch {
      // attribution never breaks a test
    }
  };
  const writing = (flags) => typeof flags === 'number' ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_TRUNC)) !== 0 : typeof flags === 'string' && /[wa+]/.test(flags);
  const first = (args) => args[0];
  const second = (args) => args[1];
  const targets = {
    writeFile: first,
    appendFile: first,
    truncate: first,
    rename: second,
    copyFile: second,
    cp: second,
    link: second,
    symlink: second,
    mkdir: first,
    mkdtemp: first,
    rm: first,
    rmdir: first,
    unlink: first,
    utimes: first,
    open: (args) => (writing(args[1]) ? args[0] : undefined),
  };
  const wrap = (holder, name, pick) => {
    const original = holder[name];
    if (typeof original !== 'function') return;
    holder[name] = function wrapped(...args) {
      note(pick(args));
      return original.apply(this, args);
    };
  };
  for (const [name, pick] of Object.entries(targets)) {
    wrap(fs, `${name}Sync`, pick);
    wrap(fs, name, pick);
    wrap(fs.promises, name, pick);
  }
  wrap(fs, 'createWriteStream', first);

  // Native SQLite: better-sqlite3 opens and writes its file in C. A database opened for writing
  // inside the real home is recorded with its WAL and shared-memory files.
  const Module = nodeModuleCjs.Module ?? nodeModuleCjs;
  const load = Module._load;
  const drivers = new WeakMap();
  const isDriver = (value) => typeof value === 'function' && value.name === 'Database' && typeof value.prototype?.prepare === 'function' && typeof value.prototype?.pragma === 'function';
  const recorded = (driver) => {
    if (!drivers.has(driver)) {
      const proxy = new Proxy(driver, {
        construct(target, args, newTarget) {
          const [file, options] = args;
          if (typeof file === 'string' && file !== ':memory:' && file.length > 0 && options?.readonly !== true) {
            for (const suffix of ['', '-wal', '-shm', '-journal']) note(`${file}${suffix}`);
          }
          return Reflect.construct(target, args, newTarget === proxy ? target : newTarget);
        },
        apply(_target, _self, args) {
          return Reflect.construct(proxy, args);
        },
      });
      drivers.set(driver, proxy);
    }
    return drivers.get(driver);
  };
  // By what it loads, not by the request string: the ES module shim requires it by file path.
  Module._load = function jevrisGuardLoad(...args) {
    const loaded = load.apply(this, args);
    return isDriver(loaded) ? recorded(loaded) : loaded;
  };

  // Children: an explicit env keeps this preload, this ledger and the temporary home (a test's
  // own JEVRIS_GUARD_REAL_HOME, ledger or HOME, when it sets them, are kept).
  const flag = `--import=${import.meta.url}`;
  const guarded = (env) => {
    if (env === null || typeof env !== 'object') return env;
    const out = { ...env };
    if (typeof out.JEVRIS_HOME_WRITE_LEDGER !== 'string' || out.JEVRIS_HOME_WRITE_LEDGER.length === 0) {
      out.JEVRIS_GUARD_REAL_HOME = realHome;
      out.JEVRIS_HOME_WRITE_LEDGER = homeLedger;
      if (typeof realRootsText === 'string' && realRootsText.length > 0) out.JEVRIS_GUARD_REAL_ROOTS = realRootsText;
    }
    if (origin.length > 0 && !('JEVRIS_TEST_ORIGIN' in out)) out.JEVRIS_TEST_ORIGIN = origin;
    // Without HOME (USERPROFILE on Windows) a child's os.homedir() is the account's real home.
    const testHome = process.env.JEVRIS_TEST_HOME;
    if (typeof testHome === 'string' && testHome.length > 0) {
      for (const key of ['HOME', 'USERPROFILE']) if (!(key in out)) out[key] = testHome;
    }
    // npm run test:future: a child lives on the same date as its parent.
    const shift = process.env.JEVRIS_TEST_CLOCK_SHIFT_DAYS;
    if (shift !== undefined && !('JEVRIS_TEST_CLOCK_SHIFT_DAYS' in out)) out.JEVRIS_TEST_CLOCK_SHIFT_DAYS = shift;
    const current = typeof out.NODE_OPTIONS === 'string' ? out.NODE_OPTIONS.trim() : '';
    if (!current.includes(flag)) out.NODE_OPTIONS = current.length === 0 ? flag : `${current} ${flag}`;
    return out;
  };
  // A child under the Node permission model reads only what it is granted, so the preload
  // cannot load there; the model already confines its writes (a pack's executable component).
  const sandboxed = (args) => args.some((arg) => Array.isArray(arg) && arg.some((item) => typeof item === 'string' && /^--(?:experimental-)?permission\b/.test(item)));
  const withOptions = (args, at) => {
    if (sandboxed(args)) return args;
    const index = args.findIndex((arg, i) => i >= at && arg !== null && typeof arg === 'object' && !Array.isArray(arg));
    if (index === -1 || !('env' in args[index]) || args[index].env === undefined) return args;
    const copy = [...args];
    copy[index] = { ...args[index], env: guarded(args[index].env) };
    return copy;
  };
  for (const [name, at] of [['spawn', 1], ['spawnSync', 1], ['execFile', 1], ['execFileSync', 1], ['fork', 1], ['exec', 1], ['execSync', 1]]) {
    const original = childProcess[name];
    if (typeof original !== 'function') continue;
    childProcess[name] = function guardedChild(...args) {
      return original.apply(this, withOptions(args, at));
    };
  }
  syncBuiltinESMExports();
}

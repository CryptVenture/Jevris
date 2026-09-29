#!/usr/bin/env node
/**
 * Cross-platform test runner. No shell, no glob expansion by a shell.
 *
 * - Builds first (scripts/build.mjs) unless --no-build is passed.
 * - Holds the suite lock (scripts/suite-lock.mjs) for the whole run, and, for the full suite
 *   (no test file named), the host suite lock first.
 * - Runs every test file by default, or only the files named as arguments.
 * - Runs the latency-bound files (SERIAL_TEST_FILES) last and one at a time, with no other test
 *   file beside them, in the same node --test run (scripts/test-serial-gate.mjs).
 * - Bounds every test (--test-timeout, 120 s, on Node 24 and later: see testTimeoutArgs) and
 *   every test file: a file silent for JEVRIS_TEST_FILE_SILENT_S (default 600 s, well
 *   above --test-timeout) ends itself and every process it started, and fails with
 *   FILE_SILENT_BOUND (scripts/test-file-bound.mjs), so a file a leaked child keeps alive cannot
 *   hold the run, or the host suite lock, for good.
 * - Builds the SSOT reference handoff (fixtures/ssot/reference) with the repository tsc.
 * - Runs every <workspace>/test/*.test.mjs, test/*.test.mjs, test/qa/*.test.mjs,
 *   test/acceptance/*.test.mjs and fixtures/ssot/reference/tests.mjs.
 *   Tests run from source test/ directories, so a stale dist/*.test.js can never run.
 * - Every run gets a fresh temporary HOME (and USERPROFILE, XDG_*, APPDATA, CODEX_HOME,
 *   CLAUDE_CONFIG_DIR, JEVRIS_HOME).
 * - JEVRIS_TEST=1 and a preload that blocks @napi-rs/keyring keep every test process, and
 *   every child it spawns, away from the OS keychain.
 * - No test may start a real harness binary (claude, kilo, opencode, codex, agy): a real
 *   `claude` under a temp HOME asks the macOS keychain for its login (a dialog), makes a
 *   paid model call and can leave MCP servers running. The runner puts a directory of stub
 *   executables first on PATH and sets JEVRIS_NO_LIVE_HARNESS=1, which the probe code in
 *   apps/cli/src/live-harness.ts honours. Real-harness checks run only through
 *   `JEVRIS_LIVE_HARNESS=1 npm run smoke:harness`.
 *   The real home's Jevris-relevant paths are snapshotted before and after, and the run fails
 *   when they changed. The preload records every real-home write a test process (or any child
 *   it starts) makes, native SQLite included, and any such write fails the run, naming the test
 *   file it came from; the real XDG_CONFIG_HOME, CODEX_HOME, CLAUDE_CONFIG_DIR and APPDATA folders
 *   are guarded the same way wherever they are. When the owner
 *   uses Jevris for real (an install receipt from before the run, or one the owner wrote during
 *   it that no test process recorded), a change that no test process recorded, inside the
 *   Jevris folders or at a path an install receipt lists (before or after the run: a reinstall
 *   rewrites the harness plugin folders and configuration it names), is the live install's and
 *   is summarised, not failed; anything else still fails. JEVRIS_HOME_GUARD=off disables the
 *   guard on exotic hosts.
 * - Every test process gets the run's own TMPDIR (TMP, TEMP), removed at the end, so a
 *   forgotten temp dir cannot accumulate; JEVRIS_KEEP_TEST_DIRS=1 keeps it for debugging.
 *   The run fails when its own test processes created entries directly in the real temp dir
 *   and left them, as recorded by the preload; entries of other programs never count
 *   (JEVRIS_TEMP_GUARD=off disables that check).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { writeFileSync, chmodSync } from 'node:fs';
import { basename, delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMain, runNode, tscPath, workspaces } from './build.mjs';
import { DEFAULT_FILE_SILENT_S } from './test-file-bound.mjs';
import { describeWait } from './test-serial-gate.mjs';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/** Real-home paths an install, a sidecar or a hook test could touch. */
export const GUARDED_PATHS = [
  '.jevris',
  join('.claude', 'skills', 'jevris'),
  join('.claude', 'plugins', 'jevris-local'),
  join('.codex', 'hooks.json'),
  join('.codex', 'config.toml'),
  join('.codex', 'hooks'),
  join('.codex', 'jevris'),
  join('.config', 'kilo', 'kilo.json'),
  join('.config', 'kilo', 'kilo.jsonc'),
  join('.config', 'kilo', 'plugin'),
  join('.config', 'kilo', 'jevris'),
  join('.config', 'kilo', 'skills'),
  join('.config', 'opencode', 'opencode.json'),
  join('.config', 'opencode', 'opencode.jsonc'),
  join('.config', 'opencode', 'plugins'),
  join('.config', 'opencode', 'jevris'),
  join('.kilo', 'bin'),
  join('.kilo', 'plugin'),
  join('.kilo', 'skills'),
  join('.agents', 'plugins'),
  join('.gemini', 'config', 'mcp_config.json'),
  join('.gemini', 'antigravity-cli', 'plugins', 'jevris'),
  // Per-OS Jevris layout (BLD-02): XDG on linux, AppData on Windows.
  join('.config', 'jevris'),
  join('.local', 'share', 'jevris'),
  join('.local', 'state', 'jevris'),
  join('AppData', 'Roaming', 'Jevris'),
  join('AppData', 'Local', 'Jevris'),
];

/**
 * Files whose assertions are wall-clock latency targets: an answer inside a hook deadline, a
 * maintenance write under 50 ms, BUSY before a client deadline. The run lists them last, and
 * scripts/test-serial-gate.mjs runs each one alone once every other file has finished. Their
 * assertions are unchanged; next to the suite's own parallel files a host is loaded far past
 * what those targets describe (A's flake pass, coordinator 2026-09-28; D's K3 trace).
 */
export const SERIAL_TEST_FILES = [
  'test/sidecar-lifecycle-load.test.mjs',
  'apps/sidecar/test/maintenance-worker.test.mjs',
  'apps/sidecar/test/daemon.test.mjs',
  'packages/mcp/test/surface-e2e.test.mjs',
  'packages/orchestrator/test/verify-background.test.mjs',
];

export const SERIAL_GATE_URL = pathToFileURL(join(repoRoot, 'scripts', 'test-serial-gate.mjs')).href;

export const FILE_BOUND_URL = pathToFileURL(join(repoRoot, 'scripts', 'test-file-bound.mjs')).href;

/**
 * The per-file bound for a run: the silence bound in seconds (the caller's valid
 * JEVRIS_TEST_FILE_SILENT_S, else the default) and NODE_OPTIONS with the bound's import added
 * last, after the serial gate's, so a serial file's wait for its turn never counts.
 */
export function fileBound(env, callerEnv = process.env) {
  const own = callerEnv.JEVRIS_TEST_FILE_SILENT_S;
  const seconds = typeof own === 'string' && /^[1-9]\d{0,5}$/.test(own) ? own : String(DEFAULT_FILE_SILENT_S);
  const current = typeof env.NODE_OPTIONS === 'string' ? env.NODE_OPTIONS.trim() : '';
  const flag = `--import=${FILE_BOUND_URL}`;
  const without = current.split(/\s+/).filter((part) => part.length > 0 && part !== flag).join(' ');
  return { JEVRIS_TEST_FILE_SILENT_S: seconds, NODE_OPTIONS: `${without} ${flag}`.trim() };
}

/** The serial gate's capped waits in a run's gate folder, one line each (scripts/test-serial-gate.mjs). */
/** The `count` slowest test files of a gated run, each with its time from start to exit (gate included). */
export function slowestFiles(dir, count = 15) {
  const rows = [];
  let names = [];
  try {
    names = readdirSync(dir).filter((name) => /^took-[0-9a-f]+\.json$/.test(name));
  } catch {
    return rows;
  }
  for (const name of names) {
    try {
      const row = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (typeof row.file === 'string' && Number.isFinite(row.ms)) rows.push(row);
    } catch {
      // a file cut off mid-write
    }
  }
  return rows
    .sort((a, b) => b.ms - a.ms)
    .slice(0, count)
    .map((row) => `test: slow file ${Math.round(row.ms / 1000)} s ${relative(repoRoot, row.file).split(sep).join('/')}`);
}

export function cappedWaits(dir) {
  const lines = [];
  let names = [];
  try {
    names = readdirSync(dir).filter((name) => /^waited-[0-9a-f]+\.json$/.test(name)).sort();
  } catch {
    return lines;
  }
  for (const name of names) {
    try {
      lines.push(describeWait(JSON.parse(readFileSync(join(dir, name), 'utf8'))));
    } catch {
      lines.push(`serial gate: ${name} could not be read`);
    }
  }
  return lines;
}

/** The files split into those that run in parallel and the serial ones (SERIAL_TEST_FILES), each in order. */
export function splitSerial(files, root = repoRoot) {
  const serial = new Set(SERIAL_TEST_FILES.map((file) => resolve(root, file)));
  return { parallel: files.filter((file) => !serial.has(resolve(file))), serial: files.filter((file) => serial.has(resolve(file))) };
}

/**
 * The serial gate for a run in `runTemp`: its plan file, and the environment that turns it on.
 * Null when the run holds no serial file, or nothing else (a serial file alone needs no gate).
 */
export function serialGate(parallel, serial, runTemp, env) {
  if (serial.length === 0 || parallel.length === 0) return null;
  const dir = join(runTemp, 'serial-gate');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plan.json'), JSON.stringify({ parallel: parallel.map((file) => resolve(file)), serial: serial.map((file) => resolve(file)) }));
  const current = typeof env.NODE_OPTIONS === 'string' ? env.NODE_OPTIONS.trim() : '';
  const flag = `--import=${SERIAL_GATE_URL}`;
  return { JEVRIS_SERIAL_GATE: dir, NODE_OPTIONS: current.includes(flag) ? current : `${current} ${flag}`.trim() };
}

export function collectTestFiles(root = repoRoot) {
  const files = [];
  // test/qa (QA-03..05 property, fuzz and clock suites) and test/acceptance (RLS-02, RLS-03)
  // are collected like the flat root test/ directory.
  const testDirs = [
    ...workspaces(root).map((workspace) => join(root, workspace, 'test')),
    join(root, 'test'),
    join(root, 'test', 'qa'),
    join(root, 'test', 'acceptance'),
  ];
  for (const dir of testDirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith('.test.mjs')) files.push(join(dir, name));
    }
  }
  const reference = join(root, 'fixtures', 'ssot', 'reference', 'tests.mjs');
  if (existsSync(reference)) files.push(reference);
  return files;
}

export function realHomeFromEnv() {
  return process.env.JEVRIS_TEST_REAL_HOME;
}

/** Records one guarded entry (and, for a directory, its children to `depth`) in `out`. */
function snapshotEntry(path, out, depth) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) {
    out.set(path, { kind: 'link', size: 0, mtimeMs: st.mtimeMs });
    return;
  }
  if (st.isDirectory()) {
    out.set(path, { kind: 'dir', size: 0, mtimeMs: null });
    if (depth <= 0) return;
    let names = [];
    try {
      names = readdirSync(path).sort();
    } catch {
      return;
    }
    for (const name of names.slice(0, 2000)) snapshotEntry(join(path, name), out, depth - 1);
    return;
  }
  out.set(path, { kind: 'file', size: st.size, mtimeMs: st.mtimeMs });
}

/**
 * The Jevris-relevant parts of a home, plus any top-level `.j*` entry (a stray short socket
 * directory): a Map of absolute path to { kind, size, mtimeMs }.
 */
export function homeSnapshot(home) {
  const out = new Map();
  for (const rel of GUARDED_PATHS) snapshotEntry(join(home, rel), out, 6);
  let top = [];
  try {
    top = readdirSync(home)
      .filter((name) => name.startsWith('.j'))
      .sort();
  } catch {
    top = [];
  }
  for (const name of top) {
    const path = join(home, name);
    if (!out.has(path)) snapshotEntry(path, out, 0);
  }
  return out;
}

/** A fingerprint of homeSnapshot(home). */
export function homeFingerprint(home) {
  const hash = createHash('sha256');
  for (const [path, entry] of [...homeSnapshot(home)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) hash.update(`${path}\0${entry.kind}\0${entry.size}\0${entry.mtimeMs}\n`);
  return hash.digest('hex');
}

/**
 * Files the owner's own running sidecar refreshes on its own schedule (locality every 30 s,
 * the status line after a request). Their modification is not a test's when the real home's
 * endpoint.json names a live sidecar serving that home and outside any test folder.
 */
export const LIVE_SIDECAR_FILES = [join('.jevris', 'run', 'locality.json'), join('.jevris', 'statusline.json')];

/** The pid of a live sidecar serving `home` itself (not a test), or null. */
export function liveHomeSidecar(home, runTemp) {
  let pid;
  try {
    pid = JSON.parse(readFileSync(join(home, '.jevris', 'run', 'endpoint.json'), 'utf8')).pid;
  } catch {
    return null;
  }
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code !== 'EPERM') return null;
  }
  if (process.platform === 'win32') return null;
  const ps = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', shell: false });
  const args = ps.status === 0 ? ps.stdout.trim() : '';
  if (!args.includes('sidecar') || !args.endsWith(`--home ${home}`)) return null;
  if (runTemp !== undefined && args.includes(runTemp)) return null;
  return pid;
}

/** Drops the live sidecar's own refreshes from a diff; additions and removals always count. */
export function withoutLiveSidecarRefresh(diff, home, livePid) {
  if (livePid === null) return diff;
  const own = new Set(LIVE_SIDECAR_FILES.map((rel) => join(home, rel)));
  return { ...diff, modified: diff.modified.filter((path) => !own.has(path)) };
}

/**
 * The folders a Jevris install owns in a home, per OS layout (BLD-02): the data, config and
 * state folders. Once the owner uses Jevris for real, their own harness sessions change these at
 * any time (hook deliveries, the store and its WAL, harness-version refreshes, logs).
 */
export const JEVRIS_OWN_ROOTS = [
  '.jevris',
  join('.config', 'jevris'),
  join('.local', 'share', 'jevris'),
  join('.local', 'state', 'jevris'),
  join('AppData', 'Roaming', 'Jevris'),
  join('AppData', 'Local', 'Jevris'),
];

/** Whether `path` is one of the Jevris-owned folders of `home`, or inside one. */
export function jevrisOwnPath(home, path) {
  return JEVRIS_OWN_ROOTS.some((rel) => {
    const root = join(home, rel);
    return path === root || path.startsWith(`${root}${sep}`);
  });
}

/**
 * Whether the real home held a live Jevris install before the run started: an install receipt
 * (`<harness>-install-receipt.json` in a Jevris-owned folder) older than the run. A receipt the
 * run itself wrote is newer, and is an addition the guard reports anyway.
 */
export function liveInstallBefore(home, startedAt) {
  return JEVRIS_OWN_ROOTS.some((rel) => {
    let names = [];
    try {
      names = readdirSync(join(home, rel));
    } catch {
      return false;
    }
    return names.some((name) => {
      if (!/^[a-z]+-install-receipt\.json$/.test(name)) return false;
      try {
        return statSync(join(home, rel, name)).mtimeMs < startedAt;
      } catch {
        return false;
      }
    });
  });
}

/**
 * The install receipts in the Jevris-owned folders of `home`: each harness's
 * `<harness>-install-receipt.json` and the command launcher's `jevris-command-receipt.json`.
 */
export function installReceipts(home) {
  return JEVRIS_OWN_ROOTS.flatMap((rel) => {
    try {
      return readdirSync(join(home, rel))
        .filter((name) => /^[a-z]+-install-receipt\.json$/.test(name) || name === 'jevris-command-receipt.json')
        .map((name) => join(home, rel, name));
    } catch {
      return [];
    }
  });
}

/**
 * Every real-home path the install receipts of `home` list: each harness's installed files and
 * folders and the shared files it edited, and the command launcher with the folders it created.
 * A reinstall rewrites exactly these (the plugin tree under ~/.claude/plugins/jevris-local, the
 * other harnesses' plugin folders and configuration), so when the owner reinstalls during a run
 * these are the live install's too. An unreadable or malformed receipt lists nothing.
 */
export function receiptListedPaths(home) {
  const listed = new Set();
  const add = (path) => {
    if (typeof path !== 'string' || path.length === 0) return;
    const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
    if (parts.includes('..')) return;
    listed.add(/^([a-zA-Z]:)?[\\/]/.test(path) ? resolve(path) : join(home, ...parts));
  };
  for (const file of installReceipts(home)) {
    let receipt;
    try {
      receipt = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (receipt === null || typeof receipt !== 'object') continue;
    for (const entry of Array.isArray(receipt.files) ? receipt.files : []) add(entry?.path);
    for (const dir of Array.isArray(receipt.dirs) ? receipt.dirs : []) add(dir);
    for (const edit of Array.isArray(receipt.edits) ? receipt.edits : []) add(edit?.file);
    add(receipt.launcher?.path);
    for (const dir of Array.isArray(receipt.createdDirs) ? receipt.createdDirs : []) add(dir);
  }
  return listed;
}

/**
 * One home-write ledger line: a plain path, or `[path, test]` as JSON when the preload knew the
 * test file (an absolute path never starts with `[`). Null for anything else.
 */
export function ledgerEntry(line) {
  if (!line.startsWith('[')) return line.length > 0 ? { path: line, test: null } : null;
  try {
    const parsed = JSON.parse(line);
    if (Array.isArray(parsed) && typeof parsed[0] === 'string' && parsed[0].length > 0) {
      return { path: parsed[0], test: typeof parsed[1] === 'string' && parsed[1].length > 0 ? parsed[1] : null };
    }
  } catch {
    // a torn line: skipped
  }
  return null;
}

function ledgerEntries(ledgerFile) {
  try {
    return readFileSync(ledgerFile, 'utf8').split('\n').map(ledgerEntry).filter((entry) => entry !== null);
  } catch {
    return [];
  }
}

/** The real-home paths this run's test processes wrote (the preload's home-write ledger). */
export function homeWrites(ledgerFile) {
  return [...new Set(ledgerEntries(ledgerFile).map((entry) => entry.path))].sort();
}

/** Each written path with the test files that wrote it, sorted by path; paths only, never contents. */
export function homeWriteOrigins(ledgerFile) {
  const byPath = new Map();
  for (const { path, test } of ledgerEntries(ledgerFile)) {
    const tests = byPath.get(path) ?? new Set();
    if (test !== null) tests.add(test);
    byPath.set(path, tests);
  }
  return [...byPath.keys()].sort().map((path) => ({ path, tests: [...byPath.get(path)].sort() }));
}

/** The home-write failure lines: each path with the test that wrote it, at most 40 paths. */
export function homeWriteReport(origins, home) {
  const lines = [`home guard: test processes wrote ${origins.length} path(s) under the real home ${home} or a real harness configuration folder:`];
  for (const { path, tests } of origins.slice(0, 40)) lines.push(`  ${path}  (${tests.length > 0 ? `from ${tests.join(', ')}` : 'test not known'})`);
  if (origins.length > 40) lines.push(`  ... and ${origins.length - 40} more`);
  lines.push('A test uses its temporary home only (HOME, JEVRIS_HOME and the harness folders point there); fix the named test so it builds no path from the real home.');
  return lines;
}

/** Harness configuration roots the runner moves into the temporary home: their real values. */
export const GUARDED_ROOT_VARIABLES = ['XDG_CONFIG_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'APPDATA'];

/** The real values of GUARDED_ROOT_VARIABLES (absolute ones only), for the preload to guard. */
export function realGuardedRoots(env = process.env) {
  return [...new Set(GUARDED_ROOT_VARIABLES.map((name) => env[name]).filter((value) => typeof value === 'string' && isAbsolute(value)))];
}

/**
 * Splits a diff between the live install and the run. With a live install, a change that no test
 * process recorded, inside a Jevris-owned folder (its sessions keep writing there) or at a path
 * one of its install receipts lists (`listed`: a reinstall during the run rewrites those), is the
 * live install's; it is summarised, not failed. Everything else still counts: any other change,
 * any path a test process wrote, and every change when there is no live install.
 */
export function attributeToLiveInstall(diff, home, live, written, listed = new Set()) {
  const none = { added: [], removed: [], modified: [] };
  if (!live) return { diff, attributed: none };
  const byTest = new Set(written);
  const theirs = (path) => (jevrisOwnPath(home, path) || listed.has(path)) && !byTest.has(path);
  const split = (list) => [list.filter((path) => !theirs(path)), list.filter(theirs)];
  const [added, addedLive] = split(diff.added);
  const [removed, removedLive] = split(diff.removed);
  const [modified, modifiedLive] = split(diff.modified);
  return { diff: { added, removed, modified }, attributed: { added: addedLive, removed: removedLive, modified: modifiedLive } };
}

/** One line per Jevris-owned folder the live install changed during the run, with counts. */
export function liveInstallSummary(home, attributed) {
  const counts = new Map();
  for (const [kind, list] of Object.entries(attributed)) {
    for (const path of list) {
      const rel = path.slice(home.length + 1).split(sep);
      const key = rel.slice(0, -1).slice(0, 3).join(sep) || rel[0];
      const row = counts.get(key) ?? { added: 0, removed: 0, modified: 0 };
      row[kind] += 1;
      counts.set(key, row);
    }
  }
  const total = Object.values(attributed).reduce((sum, list) => sum + list.length, 0);
  if (total === 0) return [];
  const lines = [`home guard: ${total} change(s) under ${home} attributed to the live Jevris install, not this run (inside its own folders or listed in its install receipts, and no test process wrote them):`];
  for (const [key, row] of [...counts].sort(([a], [b]) => (a < b ? -1 : 1)).slice(0, 12)) {
    lines.push(`  ${key}: ${['added', 'removed', 'modified'].filter((kind) => row[kind] > 0).map((kind) => `${row[kind]} ${kind}`).join(', ')}`);
  }
  if (counts.size > 12) lines.push(`  ... and ${counts.size - 12} more folder(s)`);
  return lines;
}

/** What changed between two snapshots: added, removed and modified paths, each sorted. */
export function diffSnapshots(before, after) {
  const same = (a, b) => a.kind === b.kind && a.size === b.size && a.mtimeMs === b.mtimeMs;
  const sorted = (list) => list.sort();
  return {
    added: sorted([...after.keys()].filter((path) => !before.has(path))),
    removed: sorted([...before.keys()].filter((path) => !after.has(path))),
    modified: sorted([...after.keys()].filter((path) => before.has(path) && !same(before.get(path), after.get(path)))),
  };
}

function when(entry) {
  return entry === undefined || entry.mtimeMs === null ? '' : ` (modified ${new Date(entry.mtimeMs).toISOString()})`;
}

/** The home-guard failure text: every changed path with its kind and time, at most 40 lines. */
export function homeGuardReport(home, before, after, startedAt, diff = diffSnapshots(before, after)) {
  const lines = [`home guard: the test run changed Jevris paths under the real home ${home} (the run started ${new Date(startedAt).toISOString()}):`];
  const rows = [
    ...diff.added.map((path) => `  added ${after.get(path).kind}: ${path}${when(after.get(path))}`),
    ...diff.removed.map((path) => `  removed ${before.get(path).kind}: ${path}`),
    ...diff.modified.map((path) => `  modified ${after.get(path).kind}: ${path}${when(before.get(path)).replace('modified', 'was')}${when(after.get(path))}`),
  ];
  lines.push(...rows.slice(0, 40));
  if (rows.length > 40) lines.push(`  ... and ${rows.length - 40} more`);
  lines.push('A change made by you or another program during the run (for example a harness login rewriting its config) also trips the guard; rerun to tell the two apart.');
  return lines.join('\n');
}

/**
 * The directories this run's test processes created directly in the real temp dir and left
 * there: the preload (scripts/test-preload.mjs) appends each such path to the run's ledger, so
 * entries that other programs or concurrent runs create there never count.
 */
export function ledgerLeaks(ledgerFile, uid = typeof process.getuid === 'function' ? process.getuid() : null) {
  // The shared runtime socket dir (the IPC fallback) is meant to outlive a run.
  const live = `jevris-${String(uid)}`;
  let text = '';
  try {
    text = readFileSync(ledgerFile, 'utf8');
  } catch {
    return [];
  }
  return [...new Set(text.split('\n').filter((line) => line.length > 0))].filter((path) => basename(path) !== live && existsSync(path)).sort();
}

export const PRELOAD_URL = pathToFileURL(join(repoRoot, 'scripts', 'test-preload.mjs')).href;

/** File URL form: no spaces, so NODE_OPTIONS needs no quoting on any shell or OS. */
export function nodeOptionsWithPreload(existing) {
  const flag = `--import=${PRELOAD_URL}`;
  const base = typeof existing === 'string' ? existing.trim() : '';
  if (base.includes(flag)) return base;
  return base.length === 0 ? flag : `${base} ${flag}`;
}

export const HARNESS_BINARIES = ['claude', 'kilo', 'opencode', 'codex', 'agy'];

const STUB_SCRIPT = [
  "'use strict';",
  "const fs = require('node:fs');",
  'const name = process.argv[2];',
  'const log = process.env.JEVRIS_STUB_LOG;',
  "if (typeof log === 'string' && log.length > 0) {",
  "  try { fs.appendFileSync(log, JSON.stringify({ name, argv: process.argv.slice(3) }) + '\\n'); } catch {}",
  '}',
  "process.stderr.write(`jevris test stub: the real ${name} is never started by npm test\\n`);",
  'process.exit(1);',
  '',
].join('\n');

/**
 * Writes one stub per harness binary into `dir`: a node script elsewhere, a .cmd on
 * Windows. Each logs its call to JEVRIS_STUB_LOG and exits 1 with no stdout.
 */
export function writeHarnessStubs(dir, platform = process.platform) {
  mkdirSync(dir, { recursive: true });
  const script = join(dir, 'harness-stub.cjs');
  writeFileSync(script, STUB_SCRIPT);
  for (const name of HARNESS_BINARIES) {
    if (platform === 'win32') {
      writeFileSync(join(dir, `${name}.cmd`), `@"${process.execPath}" "%~dp0harness-stub.cjs" ${name} %*\r\n@exit /b %ERRORLEVEL%\r\n`);
      continue;
    }
    const launcher = join(dir, name);
    writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${script}" ${name} "$@"\n`);
    chmodSync(launcher, 0o755);
  }
  return dir;
}

export function withStubPath(env, stubDir) {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  const current = env[key];
  return { ...env, [key]: typeof current === 'string' && current.length > 0 ? `${stubDir}${delimiter}${current}` : stubDir };
}

export function testEnvironment(tempHome, realHome, stubDir, tempDir) {
  const base = stubDir === undefined ? process.env : withStubPath(process.env, stubDir);
  return {
    ...base,
    // A private temp dir per run: whatever a test forgets to remove goes when the run ends.
    ...(tempDir === undefined ? {} : { TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir }),
    ...(stubDir === undefined
      ? {}
      : { JEVRIS_NO_LIVE_HARNESS: '1', JEVRIS_HARNESS_STUB_DIR: stubDir, JEVRIS_STUB_LOG: join(stubDir, 'calls.log') }),
    HOME: tempHome,
    USERPROFILE: tempHome,
    XDG_CONFIG_HOME: join(tempHome, '.config'),
    XDG_DATA_HOME: join(tempHome, '.local', 'share'),
    XDG_STATE_HOME: join(tempHome, '.local', 'state'),
    XDG_CACHE_HOME: join(tempHome, '.cache'),
    APPDATA: join(tempHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(tempHome, 'AppData', 'Local'),
    CODEX_HOME: join(tempHome, '.codex'),
    // Claude Code's default folder under the temporary home: an account's own CLAUDE_CONFIG_DIR never reaches a test.
    CLAUDE_CONFIG_DIR: join(tempHome, '.claude'),
    // `npm test` hands its children the real home's npm cache; an npm a test starts (npm pack
    // --dry-run, say) would write its cache and logs there.
    npm_config_cache: join(tempHome, '.npm'),
    JEVRIS_HOME: tempHome,
    JEVRIS_TEST: '1',
    // The CLI's sidecar autostart wait (at most 60 s under a test run): a cold start on a loaded
    // host can outlast the product's 5 s (B 6d26fae).
    JEVRIS_SIDECAR_WAIT_MS: '60000',
    JEVRIS_TEST_HOME: tempHome,
    JEVRIS_TEST_REAL_HOME: realHome,
    NODE_OPTIONS: nodeOptionsWithPreload(process.env.NODE_OPTIONS),
  };
}

/**
 * scripts/coverage.mjs sets JEVRIS_TEST_COVERAGE_LCOV to a file path: the run then adds
 * node's test coverage over every workspace's built dist files and writes lcov there,
 * next to the usual spec output (QA-06).
 */
export function coverageArgs(env) {
  const lcov = env.JEVRIS_TEST_COVERAGE_LCOV;
  if (typeof lcov !== 'string' || lcov.length === 0) return [];
  return [
    '--experimental-test-coverage',
    '--test-coverage-include=apps/*/dist/**/*.js',
    '--test-coverage-include=packages/*/dist/**/*.js',
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    '--test-reporter=lcov',
    `--test-reporter-destination=${lcov}`,
  ];
}

export const EVENTS_REPORTER_URL = pathToFileURL(join(repoRoot, 'scripts', 'test-events-reporter.mjs')).href;

/**
 * scripts/acceptance-report.mjs sets JEVRIS_TEST_EVENTS to a file path: the run then also
 * writes one JSON line per finished test there (its file, name and result), next to the usual
 * spec output, for the runtime-gate report.
 */
export function eventArgs(env, coverage = coverageArgs(env)) {
  const events = env.JEVRIS_TEST_EVENTS;
  if (typeof events !== 'string' || events.length === 0) return [];
  const spec = coverage.includes('--test-reporter=spec') ? [] : ['--test-reporter=spec', '--test-reporter-destination=stdout'];
  return [...spec, `--test-reporter=${EVENTS_REPORTER_URL}`, `--test-reporter-destination=${events}`];
}

async function main(argv) {
  const build = !argv.includes('--no-build');
  if (build) {
    const code = runNode([join(repoRoot, 'scripts', 'build.mjs')]);
    if (code !== 0) return code;
  }
  const referenceConfig = join(repoRoot, 'fixtures', 'ssot', 'reference', 'tsconfig.json');
  if (existsSync(referenceConfig)) {
    const code = runNode([tscPath(), '-p', referenceConfig]);
    if (code !== 0) return code;
  }
  const selected = argv.filter((arg) => !arg.startsWith('--')).map((arg) => resolve(repoRoot, arg));
  const files = selected.length > 0 ? selected : collectTestFiles();
  if (files.length === 0) {
    console.error('no test files found');
    return 1;
  }
  const realHome = homedir();
  // After the build, so the helper reads the location through the product's own policy reader.
  const managed = (await import(pathToFileURL(join(repoRoot, 'test', 'managed-host.mjs')).href)).realManagedPolicyLocation();
  if (managed !== null) console.error(`test: this machine has a real managed Jevris policy at ${managed}; tests that need an unmanaged host are skipped (test/managed-host.mjs).`);
  const guard = process.env.JEVRIS_HOME_GUARD !== 'off';
  const startedAt = Date.now();
  const before = guard ? homeSnapshot(realHome) : new Map();
  // Judged now, not after the run: the owner may reinstall while the suite runs, and that rewrites
  // every receipt, so none would look older than the run afterwards.
  const liveBefore = guard && liveInstallBefore(realHome, startedAt);
  const listedBefore = guard ? receiptListedPaths(realHome) : new Set();
  const realTemp = tmpdir();
  const tempGuard = process.env.JEVRIS_TEMP_GUARD !== 'off';
  // Everything the run creates lives in one dir under the real temp dir (short name: socket
  // paths have a length limit): the temp HOME, the harness stubs, and the TMPDIR every test
  // process gets. The harness tripwire accepts only binaries inside that TMPDIR. On Windows the
  // temp folder can be an 8.3 name (C:\Users\RUNNER~1 on windows-latest) while the product
  // resolves a workspace through realpath.native to the long name; the run folder is given in
  // its long form, so a test's paths and the product's agree.
  const made = mkdtempSync(join(realTemp, 'jt-'));
  const runTemp = process.platform === 'win32' ? realpathSync.native(made) : made;
  const tempHome = join(runTemp, 'h');
  mkdirSync(join(tempHome, '.config'), { recursive: true });
  const stubDir = writeHarnessStubs(join(runTemp, 'bin'));
  // The ledger lives beside the run folder, so it survives the folder's removal until checked.
  const ledger = `${runTemp}.ledger`;
  const homeLedger = `${runTemp}.home-writes`;
  // Read before testEnvironment moves them into the temporary home.
  const realRoots = realGuardedRoots(process.env);
  const keep = process.env.JEVRIS_KEEP_TEST_DIRS === '1';
  let code;
  try {
    const env = testEnvironment(tempHome, realHome, stubDir, runTemp);
    // The latency-bound files are listed last and each runs alone (scripts/test-serial-gate.mjs).
    const { parallel, serial } = splitSerial(files);
    const gate = serialGate(parallel, serial, runTemp, env);
    if (gate !== null) console.log(`test: ${serial.length} latency-bound file(s) each run alone (scripts/test-serial-gate.mjs)`);
    const bound = fileBound({ ...env, ...(gate ?? {}) });
    // A hung test fails after two minutes instead of stalling a CI cell for its job limit.
    const result = spawnSync(process.execPath, ['--test', ...testTimeoutArgs(), ...coverageArgs(process.env), ...eventArgs(process.env), ...parallel, ...serial], {
      cwd: repoRoot,
      env: {
        ...env,
        ...(gate ?? {}),
        ...bound,
        ...(tempGuard ? { JEVRIS_REAL_TMPDIR: realTemp, JEVRIS_TEMP_LEDGER: ledger } : {}),
        ...(guard ? { JEVRIS_GUARD_REAL_HOME: realHome, JEVRIS_HOME_WRITE_LEDGER: homeLedger, JEVRIS_GUARD_REAL_ROOTS: JSON.stringify(realRoots) } : {}),
      },
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
    });
    if (result.error !== undefined) throw result.error;
    code = result.status ?? 1;
    if (gate !== null) for (const line of [...slowestFiles(gate.JEVRIS_SERIAL_GATE), ...cappedWaits(gate.JEVRIS_SERIAL_GATE)]) console.error(line);
  } finally {
    if (keep) console.error(`test: kept this run's temp dir ${runTemp} (JEVRIS_KEEP_TEST_DIRS=1)`);
    else rmSync(runTemp, { recursive: true, force: true, maxRetries: 3 });
  }
  if (tempGuard) {
    const leaked = ledgerLeaks(ledger);
    rmSync(ledger, { force: true });
    if (leaked.length > 0) {
      console.error(`temp guard: the test run created ${leaked.length} entries directly in the real temp dir ${realTemp} and left them (outside the run's own TMPDIR):`);
      for (const path of leaked.slice(0, 40)) console.error(`  ${path}`);
      console.error('A test that builds a path from a fixed temp root instead of os.tmpdir() leaks this way. Entries other programs create there are not counted. JEVRIS_TEMP_GUARD=off disables the check.');
      return 1;
    }
  }
  if (guard) {
    const after = homeSnapshot(realHome);
    const origins = homeWriteOrigins(homeLedger);
    const written = origins.map((entry) => entry.path);
    rmSync(homeLedger, { force: true });
    const sidecarFree = withoutLiveSidecarRefresh(diffSnapshots(before, after), realHome, liveHomeSidecar(realHome, runTemp));
    // A receipt written during the run by the owner (no test process recorded it) makes the
    // install live too; the paths receipts list before or after the run are the install's.
    const ownerReceipt = installReceipts(realHome).some((file) => !written.includes(file));
    const listed = new Set([...listedBefore, ...receiptListedPaths(realHome)]);
    const { diff, attributed } = attributeToLiveInstall(sidecarFree, realHome, liveBefore || ownerReceipt, written, listed);
    for (const line of liveInstallSummary(realHome, attributed)) console.error(line);
    if (written.length > 0) {
      for (const line of homeWriteReport(origins, realHome)) console.error(line);
      return 1;
    }
    if (diff.added.length + diff.removed.length + diff.modified.length > 0) {
      console.error(homeGuardReport(realHome, before, after, startedAt, diff));
      return 1;
    }
  }
  return code;
}

/**
 * `--test-timeout=120000` where node:test applies it to each test (Node 24 and later). Node 22
 * and 23 apply it to each whole file instead (checked on 22.14.0, 22.23.3, 23.6.0 and 23.11.1):
 * there it cut every file that ran longer than two minutes, including a latency-bound file
 * waiting at the serial gate, so those runs pass none and rely on the per-file silence bound.
 */
export function testTimeoutArgs(version = process.versions.node) {
  const major = Number.parseInt(String(version).split('.')[0] ?? '', 10);
  return Number.isInteger(major) && major >= 24 ? ['--test-timeout=120000'] : [];
}

/** A run with no test file named is the full suite, and takes the host suite lock. */
export function isFullSuite(argv) {
  return !argv.some((arg) => !arg.startsWith('--'));
}

// The whole run holds the suite lock: its own build re-enters it, and another agent's build
// waits until the suite is done instead of rewriting dist/ under it. A full suite also holds the
// host suite lock first, so full suites, test:future, verify:fresh and Docker cells run one at a
// time on this machine (a caller that already holds it passes the hold on); a run of named files
// does not wait for it.
if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const { runHostLocked, runLocked } = await import('./suite-lock.mjs');
  const run = () => runLocked(repoRoot, () => main(argv));
  process.exit(await (isFullSuite(argv) ? runHostLocked(run) : run()));
}

import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
import { attributeToLiveInstall, diffSnapshots, GUARDED_ROOT_VARIABLES, homeFingerprint, homeGuardReport, homeSnapshot, homeWriteOrigins, homeWriteReport, homeWrites, installReceipts, ledgerEntry, jevrisOwnPath, ledgerLeaks, liveHomeSidecar, liveInstallBefore, liveInstallSummary, nodeOptionsWithPreload, realGuardedRoots, receiptListedPaths, testEnvironment, withoutLiveSidecarRefresh } from '../scripts/test.mjs';

function fakeHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'home-guard-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test('the home guard names each changed path, with its kind and time, not only a hash (QA-07)', (t) => {
  const home = fakeHome(t);
  mkdirSync(join(home, '.codex'));
  writeFileSync(join(home, '.codex', 'config.toml'), 'model = "a"\n');
  mkdirSync(join(home, '.jevris', 'logs'), { recursive: true });
  writeFileSync(join(home, '.jevris', 'logs', 'old.jsonl'), '{}\n');
  writeFileSync(join(home, 'unrelated.txt'), 'x');
  const before = homeSnapshot(home);
  const hash = homeFingerprint(home);

  // A harness login rewrites its config; a stray short socket dir appears; a log goes away.
  writeFileSync(join(home, '.codex', 'config.toml'), 'model = "b"\nlogin = true\n');
  utimesSync(join(home, '.codex', 'config.toml'), new Date('2026-09-26T12:27:00Z'), new Date('2026-09-26T12:27:00Z'));
  mkdirSync(join(home, '.j16a1b2c3d4'));
  rmSync(join(home, '.jevris', 'logs', 'old.jsonl'));
  writeFileSync(join(home, 'unrelated.txt'), 'changed but not guarded');
  const after = homeSnapshot(home);

  assert.notEqual(homeFingerprint(home), hash);
  assert.deepEqual(diffSnapshots(before, after), {
    added: [join(home, '.j16a1b2c3d4')],
    removed: [join(home, '.jevris', 'logs', 'old.jsonl')],
    modified: [join(home, '.codex', 'config.toml')],
  });
  const text = homeGuardReport(home, before, after, Date.parse('2026-09-26T12:00:00Z'));
  assert.match(text, /the run started 2026-09-26T12:00:00\.000Z/);
  assert.match(text, new RegExp(`added dir: ${join(home, '.j16a1b2c3d4').replace(/[.\\]/g, '\\$&')}`));
  assert.match(text, /removed file: .*old\.jsonl/);
  assert.match(text, /modified file: .*config\.toml \(was .*\) \(modified 2026-09-26T12:27:00\.000Z\)/);
  assert.match(text, /A change made by you or another program during the run/);
  assert.doesNotMatch(text, /unrelated/);
});

test('an unchanged home has no differences (QA-07)', (t) => {
  const home = fakeHome(t);
  mkdirSync(join(home, '.jevris'));
  writeFileSync(join(home, '.jevris', 'a'), '1');
  assert.deepEqual(diffSnapshots(homeSnapshot(home), homeSnapshot(home)), { added: [], removed: [], modified: [] });
});

test('the temp guard counts only what this run\'s processes created in the real temp dir and left there (QA-07)', async (t) => {
  const temp = fakeHome(t);
  const ledger = join(temp, 'ledger.txt');
  mkdirSync(join(temp, 'jevris-cell-concurrent'));
  const script = [
    "import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';",
    "import { mkdir, mkdtemp } from 'node:fs/promises';",
    "import { join } from 'node:path';",
    'const temp = process.env.JEVRIS_REAL_TMPDIR;',
    "mkdtempSync(join(temp, 'jevris-leak-'));",
    "mkdirSync(join(temp, 'jevris-501'));",
    "await mkdir(join(temp, 'promised'));",
    "const gone = await mkdtemp(join(temp, 'jevris-gone-')); rmSync(gone, { recursive: true });",
    "mkdirSync(join(temp, 'nested', 'deeper'), { recursive: true });",
  ].join('\n');
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: nodeOptionsWithPreload(process.env.NODE_OPTIONS), JEVRIS_REAL_TMPDIR: temp, JEVRIS_TEMP_LEDGER: ledger },
  });
  assert.equal(run.status, 0, run.stderr);
  const leaks = ledgerLeaks(ledger, 501).map((path) => path.slice(temp.length + 1).replace(/-[A-Za-z0-9]{6}$/, '-*'));
  // Not the concurrent run's dir, not the live socket dir, not one removed, not a nested one's child.
  assert.deepEqual(leaks, ['jevris-leak-*', 'nested', 'promised']);
});

test('each test process gets the run\'s own TMPDIR, TMP and TEMP (QA-07)', () => {
  const env = testEnvironment('/h', '/real', undefined, '/tmp/jt-run');
  assert.deepEqual([env.TMPDIR, env.TMP, env.TEMP], ['/tmp/jt-run', '/tmp/jt-run', '/tmp/jt-run']);
  assert.equal(testEnvironment('/h', '/real').TMPDIR, process.env.TMPDIR);
  // npm run by a test keeps its cache and logs in the temporary home, not the real ~/.npm.
  assert.equal(env.npm_config_cache, join('/h', '.npm'));
});

test('the owner\'s own running sidecar refreshing its locality and status-line files is not a test\'s change (QA-07)', (t) => {
  const home = fakeHome(t);
  const diff = { added: [join(home, '.jevris', 'x.json')], removed: [], modified: [join(home, '.jevris', 'run', 'locality.json'), join(home, '.jevris', 'statusline.json'), join(home, '.jevris', 'config.json')] };
  // Without a live sidecar for this home, every change counts.
  assert.equal(liveHomeSidecar(home), null);
  assert.deepEqual(withoutLiveSidecarRefresh(diff, home, null), diff);
  // With one, only its two refreshed files are dropped; additions and other files still count.
  assert.deepEqual(withoutLiveSidecarRefresh(diff, home, 4242), { added: diff.added, removed: [], modified: [join(home, '.jevris', 'config.json')] });
  // An endpoint.json naming a process that is not a sidecar for this home does not count.
  mkdirSync(join(home, '.jevris', 'run'), { recursive: true });
  writeFileSync(join(home, '.jevris', 'run', 'endpoint.json'), JSON.stringify({ pid: process.pid }));
  assert.equal(liveHomeSidecar(home), null);
});

test('with a live install, unrecorded changes inside the Jevris folders are the install\'s and summarised; anything else, or any recorded write, still counts (QA-07)', (t) => {
  const home = fakeHome(t);
  mkdirSync(join(home, '.jevris'), { recursive: true });
  const delivery = join(home, '.jevris', 'orchestration', 'host', 'hook-deliveries', 'd1.json');
  const wal = join(home, '.jevris', 'jevris.db-wal');
  const shm = join(home, '.jevris', 'jevris.db-shm');
  const oldLog = join(home, '.jevris', 'logs', 'old.jsonl');
  const xdg = join(home, '.local', 'share', 'jevris', 'jevris.db');
  const codex = join(home, '.codex', 'hooks.json');
  const keys = join(home, '.jevris-release-keys');
  const byTest = join(home, '.jevris', 'config.json');
  assert.equal(jevrisOwnPath(home, wal), true);
  assert.equal(jevrisOwnPath(home, join(home, '.jevris')), true);
  assert.equal(jevrisOwnPath(home, xdg), true);
  assert.equal(jevrisOwnPath(home, keys), false, 'a sibling that shares the prefix is not inside .jevris');
  assert.equal(jevrisOwnPath(home, codex), false);
  const diff = { added: [delivery, keys], removed: [oldLog], modified: [byTest, codex, shm, wal, xdg] };

  // No live install: every change counts.
  assert.deepEqual(attributeToLiveInstall(diff, home, false, []), { diff, attributed: { added: [], removed: [], modified: [] } });
  // A live install: its own folders' changes are attributed, unless a test process wrote them.
  const split = attributeToLiveInstall(diff, home, true, [byTest]);
  assert.deepEqual(split.diff, { added: [keys], removed: [], modified: [byTest, codex] });
  assert.deepEqual(split.attributed, { added: [delivery], removed: [oldLog], modified: [shm, wal, xdg] });
  const summary = liveInstallSummary(home, split.attributed).join('\n');
  assert.match(summary, /5 change\(s\) under .* attributed to the live Jevris install, not this run/);
  assert.match(summary, new RegExp(`\\n  ${join('.jevris', 'orchestration', 'host').replace(/[.\\]/g, '\\$&')}: 1 added`));
  assert.match(summary, /\n  \.jevris: 2 modified/);
  assert.match(summary, new RegExp(`\\n  ${join('.jevris', 'logs').replace(/[.\\]/g, '\\$&')}: 1 removed`));
  assert.deepEqual(liveInstallSummary(home, { added: [], removed: [], modified: [] }), []);

  // Live means an install receipt older than the run, in any Jevris folder layout.
  const startedAt = Date.now();
  assert.equal(liveInstallBefore(home, startedAt), false);
  const receipt = join(home, '.jevris', 'claude-install-receipt.json');
  writeFileSync(receipt, '{}');
  utimesSync(receipt, new Date(startedAt + 1000), new Date(startedAt + 1000));
  assert.equal(liveInstallBefore(home, startedAt), false, 'a receipt the run wrote is not a live install');
  utimesSync(receipt, new Date(startedAt - 60_000), new Date(startedAt - 60_000));
  assert.equal(liveInstallBefore(home, startedAt), true);
  const linux = fakeHome(t);
  mkdirSync(join(linux, '.local', 'share', 'jevris'), { recursive: true });
  writeFileSync(join(linux, '.local', 'share', 'jevris', 'codex-install-receipt.json'), '{}');
  utimesSync(join(linux, '.local', 'share', 'jevris', 'codex-install-receipt.json'), new Date(startedAt - 60_000), new Date(startedAt - 60_000));
  assert.equal(liveInstallBefore(linux, startedAt), true);
});

test('the paths the install receipts list are the live install\'s too; an unlisted path beside them, or one a test wrote, still counts (QA-07)', (t) => {
  const home = fakeHome(t);
  mkdirSync(join(home, '.jevris'), { recursive: true });
  const plugin = join(home, '.claude', 'plugins', 'jevris-local');
  writeFileSync(
    join(home, '.jevris', 'claude-install-receipt.json'),
    JSON.stringify({
      files: [{ path: '.claude/plugins/jevris-local/plugins/jevris/hooks/hooks.json', sha256: 'x' }, { path: '../outside.json' }, { path: 7 }],
      dirs: ['.claude/plugins/jevris-local', '.claude/plugins/jevris-local/plugins'],
      edits: [{ file: '.claude/settings.json' }],
    }),
  );
  writeFileSync(join(home, '.jevris', 'codex-install-receipt.json'), '{not json');
  writeFileSync(join(home, '.jevris', 'jevris-command-receipt.json'), JSON.stringify({ launcher: { path: join(home, '.local', 'bin', 'jevris') }, createdDirs: [join(home, '.local', 'bin')] }));
  assert.deepEqual(installReceipts(home).map((file) => file.slice(home.length + 1)).sort(), [join('.jevris', 'claude-install-receipt.json'), join('.jevris', 'codex-install-receipt.json'), join('.jevris', 'jevris-command-receipt.json')].sort());
  const listed = receiptListedPaths(home);
  assert.deepEqual([...listed].sort(), [
    join(plugin, 'plugins', 'jevris', 'hooks', 'hooks.json'),
    plugin,
    join(plugin, 'plugins'),
    join(home, '.claude', 'settings.json'),
    join(home, '.local', 'bin', 'jevris'),
    join(home, '.local', 'bin'),
  ].sort(), 'files, folders, edited files and the launcher; a malformed receipt, a non-string or a .. path lists nothing');

  const hooks = join(plugin, 'plugins', 'jevris', 'hooks', 'hooks.json');
  const stray = join(plugin, 'stray.json');
  const byTest = join(home, '.claude', 'settings.json');
  const diff = { added: [stray], removed: [], modified: [byTest, hooks] };
  const split = attributeToLiveInstall(diff, home, true, [byTest], listed);
  assert.deepEqual(split.diff, { added: [stray], removed: [], modified: [byTest] });
  assert.deepEqual(split.attributed, { added: [], removed: [], modified: [hooks] });
  assert.deepEqual(attributeToLiveInstall(diff, home, false, [], listed).diff, diff, 'no live install: nothing is attributed');
  assert.deepEqual(attributeToLiveInstall(diff, home, true, []).attributed.modified, [], 'without the listed paths, a harness path is never the install\'s');
});

/** Runs `script` (an ES module) in a child with the preload, recording writes under `home`. */
function underPreload(home, ledger, script, extraEnv = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: nodeOptionsWithPreload(process.env.NODE_OPTIONS), JEVRIS_GUARD_REAL_HOME: home, JEVRIS_HOME_WRITE_LEDGER: ledger, ...extraEnv },
  });
}

test('the preload records every write a test process makes anywhere under the real home, and only writes (QA-07)', (t) => {
  const home = fakeHome(t);
  const ledger = join(tmpdir(), `home-writes-${process.pid}-${Date.now()}.txt`);
  t.after(() => rmSync(ledger, { force: true }));
  const versions = join(home, '.jevris', 'orchestration', 'host', 'harness-versions');
  mkdirSync(versions, { recursive: true });
  mkdirSync(join(home, 'elsewhere'));
  mkdirSync(join(home, 'scratch'));
  writeFileSync(join(home, 'elsewhere', 'gone.txt'), 'x');
  const script = [
    "import fs from 'node:fs';",
    "import { closeSync, openSync, renameSync, writeFileSync, rmSync, symlinkSync, mkdtempSync, readFileSync } from 'node:fs';",
    "import { writeFile, cp } from 'node:fs/promises';",
    "import { join } from 'node:path';",
    'const home = process.env.JEVRIS_GUARD_REAL_HOME;',
    "const dir = join(home, '.jevris', 'orchestration', 'host', 'harness-versions');",
    "writeFileSync(join(dir, 'tmp-1'), '{}');",
    "renameSync(join(dir, 'tmp-1'), join(dir, 'a.json'));",
    "closeSync(openSync(join(dir, 'b.json'), 'w'));",
    "await writeFile(join(home, '.jevris', 'c.json'), '{}');",
    "writeFileSync(join(home, 'elsewhere', 'not-jevris.json'), '{}');",
    "rmSync(join(home, 'elsewhere', 'gone.txt'));",
    "symlinkSync(join(home, 'elsewhere'), join(home, 'link'));",
    "mkdtempSync(join(home, 'tmp-'));", // recorded by the prefix it names
    "await cp(join(dir, 'a.json'), join(home, '.codex-copy.json'));",
    "await new Promise((done) => fs.writeFile(join(home, '.jevris', 'callback.json'), '{}', done));",
    "await new Promise((done) => { const s = fs.createWriteStream(join(home, '.jevris', 'stream.log')); s.end('x', done); });",
    // Reads never count, and neither does the run's own temp dir inside the home.
    "closeSync(openSync(join(dir, 'a.json'), 'r')); readFileSync(join(dir, 'b.json'));",
    "writeFileSync(join(process.env.TMPDIR, 'own-temp.txt'), 'x');",
  ].join('\n');
  // A test that points JEVRIS_TEST_REAL_HOME elsewhere for a child does not move the guard.
  const run = underPreload(home, ledger, script, { JEVRIS_TEST_REAL_HOME: join(home, 'elsewhere'), TMPDIR: join(home, 'scratch') });
  assert.equal(run.status, 0, run.stderr);
  const rel = homeWrites(ledger).map((path) => path.slice(home.length + 1));
  const v = join('.jevris', 'orchestration', 'host', 'harness-versions');
  assert.deepEqual(rel, [
    '.codex-copy.json',
    join('.jevris', 'c.json'),
    join('.jevris', 'callback.json'),
    join('.jevris', 'stream.log'),
    join(v, 'a.json'),
    join(v, 'b.json'),
    join(v, 'tmp-1'),
    join('elsewhere', 'gone.txt'),
    join('elsewhere', 'not-jevris.json'),
    'link',
    'tmp-',
  ].sort());
  assert.deepEqual(homeWrites(join(home, 'missing.txt')), []);
});

test('the preload records a native SQLite database a test process opens for writing under the real home, with its WAL files (QA-07)', (t) => {
  const home = fakeHome(t);
  const ledger = join(tmpdir(), `home-sqlite-${process.pid}-${Date.now()}.txt`);
  t.after(() => rmSync(ledger, { force: true }));
  mkdirSync(join(home, '.jevris'));
  const script = [
    "import { createRequire } from 'node:module';",
    "import { join } from 'node:path';",
    "const require = createRequire(join(process.cwd(), 'packages', 'store', 'package.json'));",
    "const Database = require('better-sqlite3');",
    'const home = process.env.JEVRIS_GUARD_REAL_HOME;',
    "const db = new Database(join(home, '.jevris', 'jevris.db'));",
    "db.pragma('journal_mode = WAL'); db.exec('create table t (x)'); db.close();",
    // Called without new, as better-sqlite3 allows; a read-only open and :memory: never count.
    "Database(join(home, '.jevris', 'second.db')).close();",
    "new Database(join(home, '.jevris', 'jevris.db'), { readonly: true }).close();",
    "new Database(':memory:').close();",
    // The ES module import resolves to the same recorded driver.
    "const esm = (await import('better-sqlite3')).default; new esm(join(home, '.jevris', 'third.db')).close();",
  ].join('\n');
  const run = underPreload(home, ledger, script);
  assert.equal(run.status, 0, run.stderr);
  const files = homeWrites(ledger).map((path) => path.slice(join(home, '.jevris').length + 1));
  for (const name of ['jevris.db', 'second.db', 'third.db']) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) assert.equal(files.includes(`${name}${suffix}`), true, `${name}${suffix} in ${files.join(', ')}`);
  }
  assert.equal(files.length, 12, files.join(', '));
});

test('a child started with an explicit env keeps the preload and the ledger, so its writes are recorded too (QA-07)', (t) => {
  const home = fakeHome(t);
  const ledger = join(tmpdir(), `home-child-${process.pid}-${Date.now()}.txt`);
  t.after(() => rmSync(ledger, { force: true }));
  const grandchild = "require('node:fs').writeFileSync(require('node:path').join(process.argv[1], process.argv[2]), 'x')";
  const script = [
    "import { spawnSync, execFileSync, spawn } from 'node:child_process';",
    'const home = process.env.JEVRIS_GUARD_REAL_HOME;',
    `const code = ${JSON.stringify(grandchild)};`,
    // A bare env, an env with its own NODE_OPTIONS, and the async spawn.
    "const bare = spawnSync(process.execPath, ['-e', code, home, 'bare.txt'], { env: { PATH: process.env.PATH ?? '' } });",
    "if (bare.status !== 0) throw new Error(String(bare.stderr));",
    "execFileSync(process.execPath, ['-e', code, home, 'own-options.txt'], { env: { NODE_OPTIONS: '--no-warnings' } });",
    "await new Promise((done, fail) => spawn(process.execPath, ['-e', code, home, 'async.txt'], { env: {}, stdio: 'ignore' }).on('exit', (c) => (c === 0 ? done() : fail(new Error(String(c))))));",
    // No env option: the child inherits the environment, preload included.
    "spawnSync(process.execPath, ['-e', code, home, 'inherited.txt']);",
    // Under the Node permission model the preload could not load; the model confines the child itself.
    "const sandboxed = spawnSync(process.execPath, ['--permission', '-e', 'process.stdout.write(process.env.NODE_OPTIONS ?? \"none\")'], { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8' });",
    "if (sandboxed.status !== 0 || sandboxed.stdout !== 'none') throw new Error(`sandboxed: ${sandboxed.status} ${sandboxed.stdout} ${sandboxed.stderr}`);",
  ].join('\n');
  const run = underPreload(home, ledger, script);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(homeWrites(ledger), ['async.txt', 'bare.txt', 'inherited.txt', 'own-options.txt'].map((name) => join(home, name)));
});

test('each ledger entry names the test file that wrote it, a child inherits the name, and the report prints it (QA-07)', (t) => {
  const home = fakeHome(t);
  const ledger = join(home, '..', `home-origin-${process.pid}-${Date.now()}.txt`);
  t.after(() => rmSync(ledger, { force: true }));
  const probe = join(home, 'probe.test.mjs');
  writeFileSync(probe, [
    "import { spawnSync } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    'const home = process.env.JEVRIS_GUARD_REAL_HOME;',
    "writeFileSync(join(home, 'own.txt'), 'x');",
    "const code = `require('node:fs').writeFileSync(require('node:path').join(${JSON.stringify(home)}, 'child.txt'), 'x')`;",
    // An explicit env without the name: the preload hands the child its parent's test.
    "const child = spawnSync(process.execPath, ['-e', code], { env: { PATH: process.env.PATH ?? '' } });",
    "if (child.status !== 0) throw new Error(String(child.stderr));",
  ].join('\n'));
  // node:test's child context: the process's own main module is its test file. An empty name,
  // since this process's preload would otherwise hand the probe this file's own.
  const run = spawnSync(process.execPath, [probe], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, JEVRIS_TEST_ORIGIN: '', NODE_TEST_CONTEXT: 'child-v8', NODE_OPTIONS: nodeOptionsWithPreload(process.env.NODE_OPTIONS), JEVRIS_GUARD_REAL_HOME: home, JEVRIS_HOME_WRITE_LEDGER: ledger },
  });
  assert.equal(run.status, 0, run.stderr);
  const name = probe.split(/[\\/]/).join('/');
  assert.deepEqual(homeWriteOrigins(ledger), [
    { path: join(home, 'child.txt'), tests: [name] },
    { path: join(home, 'own.txt'), tests: [name] },
  ]);
  assert.deepEqual(homeWrites(ledger), [join(home, 'child.txt'), join(home, 'own.txt')]);
  // Outside node:test (the runner's own parent process) no test is named.
  rmSync(ledger, { force: true });
  const bare = underPreload(home, ledger, "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.JEVRIS_GUARD_REAL_HOME + '/bare.txt', 'x');", { JEVRIS_TEST_ORIGIN: '', NODE_TEST_CONTEXT: '' });
  assert.equal(bare.status, 0, bare.stderr);
  assert.deepEqual(homeWriteOrigins(ledger), [{ path: join(home, 'bare.txt'), tests: [] }]);

  const report = homeWriteReport([{ path: '/r/.codex/x', tests: ['test/a.test.mjs', 'test/b.test.mjs'] }, { path: '/r/y', tests: [] }], '/r');
  assert.match(report[0], /wrote 2 path\(s\) under the real home \/r or a real harness configuration folder/);
  assert.equal(report[1], '  /r/.codex/x  (from test/a.test.mjs, test/b.test.mjs)');
  assert.equal(report[2], '  /r/y  (test not known)');
  // The old plain form, a named entry, and torn or foreign lines.
  assert.deepEqual(ledgerEntry('/r/z'), { path: '/r/z', test: null });
  assert.deepEqual(ledgerEntry(JSON.stringify(['/r/z', 'test/c.test.mjs'])), { path: '/r/z', test: 'test/c.test.mjs' });
  for (const line of ['', '["/r/z"', '[1]', '[]']) assert.equal(ledgerEntry(line), null, line);
});

test('the real harness configuration roots are guarded wherever they are, and a test process sees only temporary ones (QA-07)', (t) => {
  const base = fakeHome(t);
  const home = join(base, 'home');
  const codex = join(base, 'codex-home');
  const beside = join(base, 'beside');
  for (const dir of [home, codex, beside]) mkdirSync(dir);
  const ledger = join(base, 'ledger.txt');
  const script = [
    "import { writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    'const [codex, beside] = JSON.parse(process.env.PROBE_DIRS);',
    "writeFileSync(join(codex, 'config.toml'), 'x');",
    "writeFileSync(join(beside, 'free.txt'), 'x');",
  ].join('\n');
  const run = underPreload(home, ledger, script, { JEVRIS_GUARD_REAL_ROOTS: JSON.stringify([codex, 'relative/ignored']), PROBE_DIRS: JSON.stringify([codex, beside]) });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(homeWrites(ledger), [join(codex, 'config.toml')]);

  assert.deepEqual(GUARDED_ROOT_VARIABLES, ['XDG_CONFIG_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'APPDATA']);
  const real = { XDG_CONFIG_HOME: join(base, 'xdg'), CODEX_HOME: codex, CLAUDE_CONFIG_DIR: 'relative', APPDATA: codex, HOME: home };
  assert.deepEqual(realGuardedRoots(real), [join(base, 'xdg'), codex]);
  const env = testEnvironment('/h', home);
  assert.equal(env.CLAUDE_CONFIG_DIR, join('/h', '.claude'), 'an account\'s own CLAUDE_CONFIG_DIR never reaches a test');
  for (const name of GUARDED_ROOT_VARIABLES) assert.equal(env[name].startsWith(join('/h')), true, name);
});

test('under npm test, a test process and its children resolve every home to the temporary one, so the real store cannot be opened (QA-07)', { skip: process.env.JEVRIS_GUARD_REAL_HOME === undefined ? 'only under scripts/test.mjs' : false }, async () => {
  const real = process.env.JEVRIS_GUARD_REAL_HOME;
  const temp = process.env.JEVRIS_TEST_HOME;
  assert.notEqual(temp, real);
  for (const home of [process.env.HOME, process.env.JEVRIS_HOME]) assert.equal(home, temp);
  const { jevrisPaths } = await import('../packages/platform/dist/index.js');
  const paths = jevrisPaths({ env: process.env });
  for (const [name, dir] of Object.entries(paths)) {
    if (typeof dir !== 'string') continue;
    assert.equal(dir.startsWith(real + (real.endsWith('/') ? '' : '/')) && !dir.startsWith(temp), false, `${name}: ${dir}`);
  }
  assert.equal(paths.data.startsWith(temp), true, paths.data);
  // The child sees the same temporary home and the same ledger.
  // The child only reports the home node resolves (lint/test-hygiene forbids a test writing under it).
  const report = "const { homedir: resolveHome } = require('node:os'); process.stdout.write(JSON.stringify([resolveHome(), process.env.JEVRIS_HOME_WRITE_LEDGER, process.env.NODE_OPTIONS]))";
  const child = spawnSync(process.execPath, ['-e', report], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  const [childHome, childLedger, childOptions] = JSON.parse(child.stdout);
  // A bare env gets the temporary HOME back: without it os.homedir() would be the account's home.
  assert.equal(childHome, temp);
  assert.equal(childLedger, process.env.JEVRIS_HOME_WRITE_LEDGER);
  assert.match(childOptions, /test-preload\.mjs/);
});

test('the runner end to end: a live install\'s own change passes with a summary, a reinstall during the run too; a test\'s write or a change outside the Jevris folders fails (QA-07)', { skip: process.platform === 'win32' ? 'uses sh for a write no test process records' : false }, (t) => {
  const base = fakeHome(t);
  const home = join(base, 'home');
  const nestedTemp = join(base, 'tmp');
  mkdirSync(join(home, '.jevris'), { recursive: true });
  mkdirSync(join(home, '.codex'));
  mkdirSync(nestedTemp);
  mkdirSync(join(home, '.claude', 'plugins', 'jevris-local'), { recursive: true });
  const receipt = join(home, '.jevris', 'claude-install-receipt.json');
  writeFileSync(receipt, JSON.stringify({ files: [{ path: '.claude/plugins/jevris-local/plugin.json' }], dirs: ['.claude/plugins/jevris-local'] }));
  utimesSync(receipt, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  const file = join(base, 'probe.test.mjs');
  writeFileSync(file, [
    "import test from 'node:test';",
    "import { spawnSync } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    'const home = process.env.JEVRIS_GUARD_REAL_HOME;',
    // sh is not a node process: its write is one no test process records, like the owner's own sessions.
    "const sh = (script) => spawnSync('/bin/sh', ['-c', script, 'sh', home], { stdio: 'inherit' });",
    "test('probe', () => {",
    "  if (process.env.PROBE === 'live') sh('mkdir -p \"$1/.jevris/orchestration/host/hook-deliveries\" && echo x > \"$1/.jevris/orchestration/host/hook-deliveries/d.json\" && echo x > \"$1/.jevris/jevris.db-wal\"');",
    "  if (process.env.PROBE === 'outside') sh('echo x > \"$1/.codex/hooks.json\"');",
    "  if (process.env.PROBE === 'test-write') writeFileSync(join(home, '.jevris', 'written-by-a-test.json'), '{}');",
    // The owner reinstalling during the run rewrites a file the receipt lists, outside ~/.jevris.
    "  if (process.env.PROBE === 'listed') sh('echo x > \"$1/.claude/plugins/jevris-local/plugin.json\"');",
    "  if (process.env.PROBE === 'unlisted') sh('echo x > \"$1/.claude/plugins/jevris-local/stray.json\"');",
    // The owner's first install during the run: a new receipt and the plugin file it lists.
    "  if (process.env.PROBE === 'first-install') sh('mkdir -p \"$1/.jevris\" && echo x > \"$1/.claude/plugins/jevris-local/plugin.json\" && echo \\'{\"files\":[{\"path\":\".claude/plugins/jevris-local/plugin.json\"}]}\\' > \"$1/.jevris/claude-install-receipt.json\"');",
    // The owner reinstalling during the run: every receipt is rewritten and a backup folder added.
    "  if (process.env.PROBE === 'reinstall') sh('mkdir -p \"$1/.jevris/backups/b1/files\" && echo x > \"$1/.jevris/backups/b1/files/00001.bak\" && echo {} > \"$1/.jevris/claude-install-receipt.json\"');",
    '});',
    '',
  ].join('\n'));
  // A runner of its own (node:test's NODE_TEST_CONTEXT would make it skip its files).
  const { NODE_TEST_CONTEXT: _context, ...outer } = process.env;
  const run = (probe, runHome = home) => spawnSync(process.execPath, [join(root, 'scripts', 'test.mjs'), '--no-build', file], {
    cwd: root,
    encoding: 'utf8',
    env: { ...outer, HOME: runHome, USERPROFILE: runHome, TMPDIR: nestedTemp, TMP: nestedTemp, TEMP: nestedTemp, PROBE: probe },
  });

  const live = run('live');
  assert.equal(live.status, 0, live.stderr);
  // Three new folders, the delivery file and the WAL, summarised per folder.
  assert.match(live.stderr, /5 change\(s\) under .* attributed to the live Jevris install, not this run/);
  assert.match(live.stderr, /\n  \.jevris\/orchestration\/host: 2 added\n/);
  assert.equal(existsSync(join(home, '.jevris', 'jevris.db-wal')), true);

  const outside = run('outside');
  assert.equal(outside.status, 1, outside.stderr);
  assert.match(outside.stderr, /home guard: the test run changed Jevris paths under the real home/);
  assert.match(outside.stderr, /added file: .*\.codex\/hooks\.json/);

  const written = run('test-write');
  assert.equal(written.status, 1, written.stderr);
  assert.match(written.stderr, /home guard: test processes wrote 1 path\(s\) under the real home/);
  assert.match(written.stderr, /written-by-a-test\.json/);
  assert.doesNotMatch(written.stderr, /attributed to the live Jevris install/, 'a recorded write is never the live install\'s');
  assert.equal(readFileSync(join(home, '.jevris', 'written-by-a-test.json'), 'utf8'), '{}');

  // A path the receipt lists is the install's, even outside ~/.jevris; one beside it is not.
  const listed = run('listed');
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stderr, /\n  \.claude\/plugins\/jevris-local: 1 added\n/);
  const unlisted = run('unlisted');
  assert.equal(unlisted.status, 1, unlisted.stderr);
  assert.match(unlisted.stderr, /added file: .*jevris-local\/stray\.json/);
  rmSync(join(home, '.claude', 'plugins', 'jevris-local', 'stray.json'));

  // Live is judged when the run starts: a reinstall during the run rewrites the receipt, and its
  // changes are still the live install's. Last, because it leaves the receipt newer than a run.
  const reinstall = run('reinstall');
  assert.equal(reinstall.status, 0, reinstall.stderr);
  assert.match(reinstall.stderr, /change\(s\) under .* attributed to the live Jevris install, not this run/);
  assert.match(reinstall.stderr, /5 change\(s\) under .* attributed to the live Jevris install/);
  assert.match(reinstall.stderr, /\n  \.jevris: 1 added, 1 modified\n/, 'the backups folder, and the rewritten receipt');
  assert.match(reinstall.stderr, /\n  \.jevris\/backups\/b1: 2 added\n/);

  // No install before the run: the receipt the owner writes during it (no test process recorded
  // it) makes the install live, and the plugin file it lists is the install's.
  const fresh = join(base, 'fresh');
  mkdirSync(join(fresh, '.claude', 'plugins', 'jevris-local'), { recursive: true });
  mkdirSync(join(fresh, '.codex'));
  const first = run('first-install', fresh);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stderr, /3 change\(s\) under .* attributed to the live Jevris install/);
  assert.match(readFileSync(join(fresh, '.jevris', 'claude-install-receipt.json'), 'utf8'), /plugin\.json/);
});

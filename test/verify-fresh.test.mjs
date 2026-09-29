import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { coverageDetail, describeStep, guardCwd, npmCommand, overlayPlan, overlaySummary, parseCounts, parseVerifyArgs, pruneKept, verifyFresh, verifySteps } from '../scripts/verify-fresh.mjs';

// QA: npm run verify:fresh is the one fresh-clone verification every agent uses. It clones HEAD,
// applies the overlay, runs each step inside the clone only (never in the shared checkout, even
// from a path with spaces), prints exact counts and cleans up. No test here runs npm.

const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

/** A small repository in a folder whose path has spaces, with one commit and working-tree edits. */
function repoWithSpaces(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'jevris verify fresh ')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const main = join(base, 'main checkout');
  mkdirSync(join(main, 'src dir'), { recursive: true });
  writeFileSync(join(main, 'src dir', 'a file.txt'), 'committed\n');
  writeFileSync(join(main, 'gone.txt'), 'committed\n');
  writeFileSync(join(main, 'kept.txt'), 'committed\n');
  git(main, 'init', '-q');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'base');
  writeFileSync(join(main, 'src dir', 'a file.txt'), 'edited in the working tree\n');
  writeFileSync(join(main, 'new file.txt'), 'untracked\n');
  writeFileSync(join(main, 'kept.txt'), 'edited but not in the overlay\n');
  rmSync(join(main, 'gone.txt'));
  return { base, main };
}

const SUMMARY = (tests, pass, fail, skipped) => `✔ something\nℹ tests ${tests}\nℹ suites 0\nℹ pass ${pass}\nℹ fail ${fail}\nℹ cancelled 0\nℹ skipped ${skipped}\nℹ todo 0\n`;

test('verify:fresh arguments: repeatable --overlay with one or more paths, --future-days, --dir and --keep; anything else is a usage error', () => {
  assert.deepEqual(parseVerifyArgs([]), { overlay: [], futureDays: null, dir: null, keep: false });
  assert.deepEqual(parseVerifyArgs(['--overlay', 'a b.txt', 'c', '--future-days', '365', '--overlay', 'd', '--dir', '/x y', '--keep']), { overlay: ['a b.txt', 'c', 'd'], futureDays: 365, dir: '/x y', keep: true });
  for (const bad of [['--overlay'], ['--overlay', '--keep'], ['--future-days', '0'], ['--future-days', 'x'], ['--dir'], ['--bogus']]) assert.throws(() => parseVerifyArgs(bad), Error, bad.join(' '));
  assert.deepEqual(verifySteps().map((s) => s.id), ['ci', 'build', 'lint', 'test', 'docs', 'pack']);
  assert.deepEqual(verifySteps(30).at(-1).npm, ['run', 'test:future', '--', '--days', '30', '--no-build']);
});

test('verify:fresh runs the suite once under coverage and reports the floors: a package under its floor fails the test step, as in CI (QA-06)', () => {
  assert.deepEqual(verifySteps().find((s) => s.id === 'test'), { id: 'test', node: ['scripts/coverage.mjs'] });
  const table = 'coverage (lines / branches):\n  apps/cli: 90% / 80% (floor 86 / 74)\n  packages/adapter-codex: 97% / 94% (floor 96 / 93)\n  packages/extra: 50% / 40% (no floor)\n';
  assert.equal(coverageDetail(`${SUMMARY(10, 10, 0, 0)}${table}`), 'coverage floors met (2 package(s))');
  const below = `${SUMMARY(10, 10, 0, 0)}${table}coverage floor: packages/adapter-codex: lines 90% < floor 96%\ncoverage floor: packages/adapter-kilocode: no coverage recorded\n`;
  assert.equal(coverageDetail(below), 'coverage below floor: packages/adapter-codex: lines 90% < floor 96%; packages/adapter-kilocode: no coverage recorded');
  assert.equal(coverageDetail(`${SUMMARY(10, 9, 1, 0)}coverage: the test run failed\n`), null, 'a failed run never reached the floors');
  assert.equal(
    describeStep({ id: 'test', code: 1, counts: parseCounts(below), detail: coverageDetail(below), ms: 2000 }),
    'test: FAILED (exit 1) 10 tests, 10 pass, 0 fail, 0 skipped coverage below floor: packages/adapter-codex: lines 90% < floor 96%; packages/adapter-kilocode: no coverage recorded (2s)',
  );
});

test('verify:fresh refuses an overlay path that is absolute, leaves the checkout or is inside .git, and plans a deletion for a path that is gone', (t) => {
  const { main } = repoWithSpaces(t);
  assert.deepEqual(overlayPlan(main, ['src dir/a file.txt', 'gone.txt', 'src dir/']), [
    { rel: join('src dir', 'a file.txt'), action: 'copy' },
    { rel: 'gone.txt', action: 'remove' },
    { rel: 'src dir', action: 'copy' },
  ]);
  for (const bad of [join(main, 'kept.txt'), '../elsewhere', 'src dir/../../x', '.', '.git/config', '.git']) assert.throws(() => overlayPlan(main, [bad]), /overlay path/, bad);
});

test('verify:fresh refuses an overlay path in neither the working tree nor HEAD, and says when several paths were passed as one argument; the summary counts the overlay', async (t) => {
  const { main } = repoWithSpaces(t);
  // A mistyped path is not a deletion: HEAD never had it.
  assert.throws(() => overlayPlan(main, ['kept.txt', 'never.txt']), /overlay path is in neither the working tree nor HEAD: never\.txt$/);
  // zsh passes an unquoted $PATHS as one argument: the run must not test bare HEAD and print PASS.
  assert.throws(() => overlayPlan(main, ['kept.txt new file.txt']), /neither the working tree nor HEAD: kept\.txt new file\.txt; it contains a space.*\$\{=VAR\}/);
  // A path that is gone from the working tree but in HEAD is still a deletion.
  assert.deepEqual(overlayPlan(main, ['gone.txt']), [{ rel: 'gone.txt', action: 'remove' }]);
  assert.equal(overlaySummary([]), 'no overlay: HEAD alone');
  assert.equal(overlaySummary(overlayPlan(main, ['kept.txt', 'gone.txt', 'new file.txt'])), '3 overlay path(s): 2 copied, 1 removed');
  // verifyFresh refuses before cloning, and runs no step.
  const lines = [];
  let ran = 0;
  await assert.rejects(
    verifyFresh({ mainRoot: main, options: { overlay: ['kept.txt new file.txt'], futureDays: null, dir: null, keep: false }, run: async () => { ran += 1; return { code: 0, output: '' }; }, write: (line) => lines.push(line) }),
    /neither the working tree nor HEAD/,
  );
  assert.equal(ran, 0);
  assert.equal(lines.some((line) => /PASS/.test(line)), false);
});

test('verify:fresh runs a step only in the clone\'s own top level: never the main checkout, a folder inside it, or a folder that is not a clone', (t) => {
  const { base, main } = repoWithSpaces(t);
  const clone = join(base, 'the clone');
  git(base, 'clone', '-q', main, clone);
  assert.equal(guardCwd(clone, clone, main), null);
  assert.equal(guardCwd(main, main, main), 'MAIN_CHECKOUT');
  assert.equal(guardCwd(join(main, 'src dir'), join(main, 'src dir'), main), 'MAIN_CHECKOUT');
  assert.equal(guardCwd(main, clone, main), 'MAIN_CHECKOUT');
  assert.equal(guardCwd(join(clone, '.git'), clone, main), 'NOT_THE_CLONE');
  const plain = join(base, 'plain');
  mkdirSync(plain);
  assert.equal(guardCwd(plain, plain, main), 'NOT_A_CLONE');
  assert.equal(guardCwd(join(base, 'missing'), join(base, 'missing'), main), 'NOT_FOUND');
  // A folder with a .git whose top level is elsewhere is not the clone.
  assert.equal(guardCwd(clone, clone, main, () => main), 'NOT_THE_CLONE');
});

test('verify:fresh clones HEAD from a path with spaces, applies the overlay, runs every step in the clone, prints exact counts and cleans up', async (t) => {
  const { base, main } = repoWithSpaces(t);
  const head = git(main, 'rev-parse', '--short', 'HEAD');
  const seen = [];
  const lines = [];
  const run = async (step, cwd, logPath) => {
    seen.push(step.id);
    assert.notEqual(realpathSync(cwd), realpathSync(main), `${step.id} ran in the main checkout`);
    assert.equal(git(cwd, 'rev-parse', '--show-toplevel'), realpathSync(cwd));
    assert.equal(readFileSync(join(cwd, 'src dir', 'a file.txt'), 'utf8'), 'edited in the working tree\n', 'the overlay copy reached the clone');
    assert.equal(readFileSync(join(cwd, 'new file.txt'), 'utf8'), 'untracked\n');
    assert.equal(existsSync(join(cwd, 'gone.txt')), false, 'a deleted overlay path is deleted in the clone');
    assert.equal(readFileSync(join(cwd, 'kept.txt'), 'utf8'), 'committed\n', 'a path outside the overlay is HEAD\'s');
    writeFileSync(logPath, step.id);
    if (step.id === 'lint') return { code: 0, output: SUMMARY(110, 110, 0, 0) };
    if (step.id === 'test') return { code: 0, output: SUMMARY(2181, 2180, 0, 1) };
    if (step.id === 'future') return { code: 0, output: '# tests 5\n# pass 5\n# fail 0\n# skipped 0\n' };
    if (step.id === 'pack') return { code: 0, output: 'x\ntarball ok: @webventures/jevris@1.2.0, 119 files\n' };
    return { code: 0, output: '' };
  };
  const parent = join(base, 'work area');
  const report = await verifyFresh({ mainRoot: main, options: { overlay: ['src dir/a file.txt', 'new file.txt', 'gone.txt'], futureDays: 3700, dir: parent, keep: false }, run, write: (line) => lines.push(line) });
  assert.equal(report.ok, true, lines.join('\n'));
  assert.deepEqual(seen, ['ci', 'build', 'lint', 'test', 'docs', 'pack', 'future']);
  assert.equal(report.head, head);
  assert.ok(lines.includes('verify:fresh: lint: ok 110 tests, 110 pass, 0 fail, 0 skipped (0s)'), lines.join('\n'));
  assert.ok(lines.includes('verify:fresh: test: ok 2181 tests, 2180 pass, 0 fail, 1 skipped (0s)'), lines.join('\n'));
  assert.ok(lines.some((line) => line.startsWith('verify:fresh: pack: ok tarball ok: @webventures/jevris@1.2.0, 119 files')), lines.join('\n'));
  assert.equal(lines.at(-1), `verify:fresh: PASS at ${head} with 3 overlay path(s): 2 copied, 1 removed`);
  assert.equal(existsSync(report.clone), false, 'the clone was removed');
  assert.equal(existsSync(report.logs), false, 'a passing run leaves nothing behind');
  // The main checkout is untouched: its edits are still uncommitted and nothing was added.
  const status = spawnSync('git', ['status', '--porcelain=v1', '-z'], { cwd: main, encoding: 'utf8' }).stdout.split('\0').filter(Boolean).sort();
  assert.deepEqual(status, [' D gone.txt', ' M kept.txt', ' M src dir/a file.txt', '?? new file.txt']);
  assert.equal(git(main, 'rev-parse', '--short', 'HEAD'), head);
});

test('verify:fresh stops after a failed build, keeps the logs, and fails; a failing test step still reports the other counts', async (t) => {
  const { base, main } = repoWithSpaces(t);
  const lines = [];
  const failBuild = await verifyFresh({ mainRoot: main, options: { overlay: [], futureDays: null, dir: base, keep: false }, run: async (step) => ({ code: step.id === 'build' ? 2 : 0, output: '' }), write: (line) => lines.push(line) });
  assert.equal(failBuild.ok, false);
  assert.deepEqual(failBuild.steps.map((s) => [s.id, s.code]), [['ci', 0], ['build', 2]]);
  assert.equal(existsSync(failBuild.clone), false);
  assert.equal(existsSync(failBuild.logs), true, 'the logs of a failed run are kept');
  assert.ok(lines.some((line) => line.startsWith(`verify:fresh: kept ${dirname(failBuild.logs)}: logs in ${failBuild.logs}`)), lines.join('\n'));
  assert.equal(lines.at(-1).startsWith('verify:fresh: FAIL at '), true);

  const failTest = await verifyFresh({ mainRoot: main, options: { overlay: [], futureDays: null, dir: base, keep: true }, run: async (step) => (step.id === 'test' ? { code: 1, output: SUMMARY(10, 9, 1, 0) } : { code: 0, output: '' }), write: () => undefined });
  assert.equal(failTest.ok, false);
  assert.deepEqual(failTest.steps.map((s) => s.id), ['ci', 'build', 'lint', 'test', 'docs', 'pack']);
  assert.equal(describeStep(failTest.steps[3]), 'test: FAILED (exit 1) 10 tests, 9 pass, 1 fail, 0 skipped (0s)');
  assert.equal(existsSync(failTest.clone), true, '--keep keeps the clone');
});

test('verify:fresh reads node:test and TAP summaries, and runs npm through node without a shell', () => {
  assert.deepEqual(parseCounts(SUMMARY(3, 2, 1, 0)), { tests: 3, pass: 2, fail: 1, cancelled: 0, skipped: 0, todo: 0 });
  assert.deepEqual(parseCounts('# tests 110\n# pass 110\n# fail 0\n# skipped 0\n'), { tests: 110, pass: 110, fail: 0, skipped: 0 });
  assert.equal(parseCounts('no summary'), null);
  const cli = join(mkdtempSync(join(tmpdir(), 'jevris-npm-')), 'npm-cli.js');
  writeFileSync(cli, '');
  try {
    assert.deepEqual(npmCommand({ npm_execpath: cli }, '/opt/node/bin/node', 'linux'), { file: '/opt/node/bin/node', prefix: [cli] });
    assert.equal(npmCommand({}, join(tmpdir(), 'no-node-here', 'node'), 'win32').file, 'npm.cmd');
  } finally {
    rmSync(join(cli, '..'), { recursive: true, force: true });
  }
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['verify:fresh'], 'node scripts/verify-fresh.mjs');
});

test('verify:fresh prunes kept folders of earlier runs: the 3 newest stay, none older than 24 h, and never one a live process uses', (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'vf-prune-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const make = (name, ageMs, owner = null) => {
    const dir = join(parent, `jevris-verify-fresh-${name}`);
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(join(dir, 'logs', 'test.log'), 'x');
    if (owner !== null) writeFileSync(join(dir, 'owner.pid'), String(owner));
    const at = new Date(now - ageMs);
    for (const path of [join(dir, 'logs', 'test.log'), join(dir, 'logs'), ...(owner === null ? [] : [join(dir, 'owner.pid')]), dir]) utimesSync(path, at, at);
    return dir;
  };
  const self = make('self', 0, process.pid);
  const newest = [make('a', 1 * hour), make('b', 2 * hour), make('c', 3 * hour)];
  const fourth = make('d', 4 * hour);
  const old = make('e', 30 * hour);
  const running = make('f', 40 * hour, 4242);
  const named = make('g', 50 * hour);
  const recent = make('h', 5 * 60 * 1000);
  mkdirSync(join(parent, 'something-else'));
  const removed = pruneKept(parent, { self, now, alive: (pid) => pid === 4242, args: () => [`node ${named}/repo/scripts/test.mjs`] });
  assert.deepEqual(removed.sort(), [fourth, old].sort());
  for (const dir of [self, ...newest, running, named, recent]) assert.equal(existsSync(dir), true, dir);
  assert.equal(existsSync(join(parent, 'something-else')), true, 'only verify:fresh folders are touched');
  // Once nothing uses them, the old ones go; the 3 newest under 24 h stay.
  const again = pruneKept(parent, { self, now, alive: () => false, args: () => [] });
  assert.deepEqual(again.sort(), [running, named].sort());
  assert.equal(existsSync(recent), true, 'changed within 15 minutes: in use');
  assert.deepEqual(pruneKept(join(parent, 'missing')), []);
});

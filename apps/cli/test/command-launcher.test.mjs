// Owner report 2026-09-26: "Once I've installed jevris from the GitHub repo, I have no Jevris
// executable on my path." Paired tests for the `jevris` launcher install writes, the PATH
// question it asks once, and the uninstall that removes all of it. Temp homes, fake PATH and
// SHELL values, fake profile files and a fake reg.exe only: never the real profile, PATH or
// registry, and no harness binary starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { main } = await import('../dist/cli.js');
const launcher = await import('../dist/command-launcher.js');
const { jevrisPaths } = await import('@jevris/platform');

const POSIX = process.platform !== 'win32';

function tempDir(t, prefix = 'jevris-command-') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

async function run(argv, hooks) {
  let text = '';
  const code = await main(argv, (chunk) => (text += chunk), hooks);
  return { code, text };
}

function claudeStub() {
  return {
    available: (file) => file === 'claude',
    run: async (_file, args) => {
      const line = args.join(' ');
      if (line === '--version') return { spawned: true, code: 0, stdout: '2.1.283 (Claude Code)\n' };
      if (line === 'plugin list --json') return { spawned: true, code: 0, stdout: '[{"id":"jevris@jevris-local","enabled":true}]' };
      return { spawned: true, code: 0, stdout: '' };
    },
  };
}

/** Install hooks: a stub Claude Code, a fake PATH and SHELL, and a recording confirm. */
function hooksFor({ path = '/usr/bin:/bin', shell = '/bin/zsh', tty = false, answer = false, questions = [] } = {}) {
  return {
    harnessCli: claudeStub(),
    env: { PATH: path, SHELL: shell },
    isTTY: tty,
    confirm: async (question) => {
      questions.push(question);
      return answer;
    },
    ask: async () => '',
  };
}

const install = (home, hooks, extra = []) => run(['install', '--yes', '--home', home, '--harness', 'claude', '--no-smoke', '--no-certify', ...extra], hooks);
const commandPath = (home) => join(home, '.local', 'bin', 'jevris');
const receiptFile = (home) => join(jevrisPaths({ home }).data, 'jevris-command-receipt.json');
const pathQuestion = 'Add ~/.local/bin to your PATH in ~/.zprofile? [y/N] ';

test('install writes ~/.local/bin/jevris (0755, marked) that runs the installed runtime with the node that ran install', { skip: !POSIX }, async (t) => {
  const home = tempDir(t);
  const plan = await run(['install', '--dry-run', '--home', home, '--harness', 'claude'], hooksFor());
  assert.match(plan.text, /^ {2}create +~\/\.local\/bin\/jevris {2}\(jevris command\)$/m);
  assert.equal(existsSync(commandPath(home)), false, 'a dry run writes nothing');

  const result = await install(home, hooksFor());
  assert.equal(result.code, 0, result.text);
  const file = commandPath(home);
  assert.equal(statSync(file).mode & 0o777, 0o755);
  const text = readFileSync(file, 'utf8');
  assert.match(text, /^#!\/bin\/sh\n# jevris-launcher: written by jevris install; jevris uninstall removes it\n/);
  const receipt = JSON.parse(readFileSync(receiptFile(home), 'utf8'));
  assert.equal(receipt.launcher.path, file);
  assert.equal(receipt.launcher.node, process.execPath);
  assert.match(receipt.launcher.entry, /[\\/]runtime[\\/]\d+\.\d+\.\d+[^\\/]*[\\/]bin[\\/]jevris\.mjs$/);
  assert.ok(text.includes(`entry='${receipt.launcher.entry}'`));
  // Not on this PATH and no terminal: the exact line to add, and no profile is touched.
  assert.match(result.text, /^jevris command: not on PATH: to use jevris, add this line to ~\/\.zprofile, then open a new terminal: export PATH="\$HOME\/\.local\/bin:\$PATH"$/m);
  assert.equal(existsSync(join(home, '.zprofile')), false);

  // The launcher runs the runtime copy: arguments pass through untouched by the shell.
  const ran = spawnSync(file, ['--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home, JEVRIS_TEST: '1' } });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /\d+\.\d+\.\d+/);
});

test('the launcher says clearly when the node that ran install is gone, and doctor calls it broken', { skip: !POSIX }, async (t) => {
  const home = tempDir(t);
  const dataRoot = jevrisPaths({ home }).data;
  const place = { home, dataRoot, platform: process.platform, env: { PATH: '/usr/bin:/bin' } };
  const entry = join(home, 'entry.mjs');
  writeFileSync(entry, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
  const gone = join(home, 'no-such-node');
  const written = await launcher.writeLauncher(place, gone, entry);
  assert.equal(written.ok, true);
  const ran = spawnSync(written.path, ['a'], { encoding: 'utf8' });
  assert.equal(ran.status, 127);
  assert.match(ran.stderr, /^jevris: the Node\.js that installed Jevris is gone: .*no-such-node\. Install Node\.js again, then run: npx @webventures\/jevris install --yes$/m);
  assert.match(await launcher.commandDoctorLine(place, true), /^jevris command: broken: the Node\.js that installed Jevris \(.*\) is gone; fix: /);

  // With a real node, "$@" reaches the program as written: no word splitting, no expansion.
  await launcher.writeLauncher(place, process.execPath, entry);
  const args = ['a b', '$HOME', '`id`', "it's", '*'];
  const echoed = spawnSync(written.path, args, { encoding: 'utf8' });
  assert.equal(echoed.status, 0, echoed.stderr);
  assert.deepEqual(JSON.parse(echoed.stdout), args);
  // Paths with a quote are single-quoted safely.
  assert.match(launcher.launcherScript('linux', "/o'dd/node", '/x/entry.mjs'), /^node='\/o'\\''dd\/node'$/m);
});

test('on a terminal install asks once to add ~/.local/bin to PATH; yes appends one marked block, and it is not asked again', { skip: !POSIX }, async (t) => {
  const home = tempDir(t);
  writeFileSync(join(home, '.zprofile'), 'export EDITOR=vi\n');
  const questions = [];
  const first = await install(home, hooksFor({ tty: true, answer: true, questions }));
  assert.equal(first.code, 0, first.text);
  assert.deepEqual(questions, [pathQuestion]);
  assert.match(first.text, /^jevris command: ~\/\.local\/bin\/jevris; added ~\/\.local\/bin to PATH in ~\/\.zprofile, so open a new terminal to use jevris$/m);
  const profile = readFileSync(join(home, '.zprofile'), 'utf8');
  assert.equal(profile, `export EDITOR=vi\n\n${launcher.profileBlock('zsh').join('\n')}\n`);
  // The block works in sh and adds the folder once.
  const shown = spawnSync('/bin/sh', ['-c', `. "${join(home, '.zprofile')}"; . "${join(home, '.zprofile')}"; printf %s "$PATH"`], { encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin' } });
  assert.equal(shown.stdout, `${home}/.local/bin:/usr/bin:/bin`);

  const again = [];
  const second = await install(home, hooksFor({ tty: true, answer: true, questions: again }));
  assert.equal(second.code, 0, second.text);
  assert.deepEqual(again, []);
  assert.equal(readFileSync(join(home, '.zprofile'), 'utf8'), profile, 'one block only');
});

test('a no is remembered: the exact line is printed and the profile is never edited', { skip: !POSIX }, async (t) => {
  const home = tempDir(t);
  const questions = [];
  const first = await install(home, hooksFor({ shell: '/bin/bash', tty: true, answer: false, questions }));
  assert.deepEqual(questions, ['Add ~/.local/bin to your PATH in ~/.profile? [y/N] ']);
  assert.match(first.text, /^jevris command: not on PATH: to use jevris, add this line to ~\/\.profile, then open a new terminal: export PATH="\$HOME\/\.local\/bin:\$PATH"$/m);
  const again = [];
  await install(home, hooksFor({ shell: '/bin/bash', tty: true, answer: true, questions: again }));
  assert.deepEqual(again, []);
  assert.equal(existsSync(join(home, '.profile')), false);
  assert.equal(existsSync(join(home, '.bash_profile')), false);
});

// POSIX shells only: the product builds these with posix paths, and on Windows it offers the user
// PATH instead of a profile (never calling shellProfile there).
test('profile detection: zsh .zprofile, bash .bash_profile when present else .profile, fish conf.d, else .profile', { skip: POSIX ? false : 'POSIX shell profiles; Windows uses the user PATH' }, async (t) => {
  const home = tempDir(t);
  assert.deepEqual(await launcher.shellProfile(home, { SHELL: '/bin/zsh' }), { file: join(home, '.zprofile'), shell: 'zsh' });
  assert.deepEqual(await launcher.shellProfile(home, { SHELL: '/usr/local/bin/bash' }), { file: join(home, '.profile'), shell: 'bash' });
  writeFileSync(join(home, '.bash_profile'), '');
  assert.deepEqual(await launcher.shellProfile(home, { SHELL: '/bin/bash' }), { file: join(home, '.bash_profile'), shell: 'bash' });
  assert.deepEqual(await launcher.shellProfile(home, { SHELL: '/opt/homebrew/bin/fish' }), { file: join(home, '.config', 'fish', 'conf.d', 'jevris.fish'), shell: 'fish' });
  assert.deepEqual(await launcher.shellProfile(home, {}), { file: join(home, '.profile'), shell: 'sh' });
  assert.equal(launcher.pathLine('fish'), 'set -gx PATH $HOME/.local/bin $PATH');
  // fish: a conf.d file of its own, removed whole on uninstall.
  const fish = await launcher.shellProfile(home, { SHELL: '/usr/bin/fish' });
  assert.deepEqual(await launcher.addProfileBlock(fish), { added: true, created: true, createdDirs: [join(home, '.config'), join(home, '.config', 'fish'), join(home, '.config', 'fish', 'conf.d')] });
  assert.match(readFileSync(fish.file, 'utf8'), /^# >>> jevris PATH >>>\n.*\nif not contains -- "\$HOME\/\.local\/bin" \$PATH\n/);
  assert.equal(await launcher.removeProfileBlock(fish.file, true), 'removed');
  assert.equal(existsSync(fish.file), false);
});

test('when the folder is on PATH doctor and install say so; a global npm jevris that runs first is left alone and named', { skip: !POSIX }, async (t) => {
  const home = tempDir(t);
  const onPath = await install(home, hooksFor({ path: `${join(home, '.local', 'bin')}:/usr/bin:/bin`, tty: true, answer: true }));
  assert.match(onPath.text, /^jevris command: on PATH \(~\/\.local\/bin\/jevris\)$/m);
  const doctor = await run(['doctor', '--home', home, '--json'], { ...hooksFor({ path: `${join(home, '.local', 'bin')}:/usr/bin` }) });
  const line = JSON.parse(doctor.text).lines.find((item) => item.text.startsWith('jevris command: '));
  assert.deepEqual(line, { text: 'jevris command: on PATH (~/.local/bin/jevris)', severity: 'ok' });

  // A global npm install: <prefix>/bin/jevris -> <prefix>/lib/node_modules/@webventures/jevris/bin/jevris.mjs
  const prefix = tempDir(t, 'jevris-npm-prefix-');
  const pkgBin = join(prefix, 'lib', 'node_modules', '@webventures', 'jevris', 'bin');
  mkdirSync(pkgBin, { recursive: true });
  mkdirSync(join(prefix, 'bin'));
  writeFileSync(join(pkgBin, 'jevris.mjs'), '#!/usr/bin/env node\n');
  chmodSync(join(pkgBin, 'jevris.mjs'), 0o755);
  symlinkSync(join(pkgBin, 'jevris.mjs'), join(prefix, 'bin', 'jevris'));
  const home2 = tempDir(t);
  const questions = [];
  const npm = await install(home2, hooksFor({ path: `${join(prefix, 'bin')}:/usr/bin`, tty: true, answer: true, questions }));
  assert.equal(npm.code, 0, npm.text);
  assert.deepEqual(questions, [], 'no PATH question when a jevris already runs');
  assert.match(npm.text, new RegExp(`^jevris command: ${join(prefix, 'bin', 'jevris').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} runs when you type jevris \\(npm global install\\); Jevris left it alone\\. The launcher is ~/\\.local/bin/jevris, which is not on PATH$`, 'm'));
  assert.equal(readFileSync(join(pkgBin, 'jevris.mjs'), 'utf8'), '#!/usr/bin/env node\n');
  const doctor2 = JSON.parse((await run(['doctor', '--home', home2, '--json'], hooksFor({ path: `${join(prefix, 'bin')}:/usr/bin` }))).text);
  const line2 = doctor2.lines.find((item) => item.text.startsWith('jevris command: '));
  assert.equal(line2.severity, 'info');
  assert.match(line2.text, /\(npm global install\); the Jevris launcher is ~\/\.local\/bin\/jevris$/);
});

test('a jevris in ~/.local/bin that is not Jevris\'s own is never overwritten, and uninstall leaves it and says so', { skip: !POSIX }, async (t) => {
  const home = tempDir(t);
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(commandPath(home), '#!/bin/sh\necho mine\n', { mode: 0o755 });
  const plan = await run(['install', '--dry-run', '--home', home, '--harness', 'claude'], hooksFor());
  assert.match(plan.text, /^ {2}\S+ +~\/\.local\/bin\/jevris {2}\(~\/\.local\/bin\/jevris is not Jevris's own, so install leaves it alone\)$/m);
  const result = await install(home, hooksFor({ path: `${join(home, '.local', 'bin')}:/usr/bin` }));
  assert.equal(result.code, 0, result.text);
  assert.equal(readFileSync(commandPath(home), 'utf8'), '#!/bin/sh\necho mine\n');
  assert.match(result.text, /^jevris command: ~\/\.local\/bin\/jevris is not Jevris's own, so install left it alone/m);
  const removed = await run(['uninstall', '--home', home], hooksFor());
  assert.equal(removed.code, 0, removed.text);
  assert.equal(readFileSync(commandPath(home), 'utf8'), '#!/bin/sh\necho mine\n');
  assert.match(removed.text, /^next: ~\/\.local\/bin\/jevris is not Jevris's own, so uninstall left it alone\.$/m);
});

test('a new runtime re-points the launcher', { skip: !POSIX }, async (t) => {
  const home = tempDir(t);
  await install(home, hooksFor());
  const receipt = JSON.parse(readFileSync(receiptFile(home), 'utf8'));
  const old = receipt.launcher.entry.replace(/runtime[\\/][^\\/]+[\\/]/, 'runtime/0.0.1/');
  writeFileSync(commandPath(home), launcher.launcherScript(process.platform, process.execPath, old), { mode: 0o755 });
  writeFileSync(receiptFile(home), JSON.stringify({ ...receipt, launcher: { ...receipt.launcher, entry: old } }));
  await install(home, hooksFor());
  assert.ok(readFileSync(commandPath(home), 'utf8').includes(`entry='${receipt.launcher.entry}'`));
});

test('the last uninstall removes the launcher, the PATH block and the receipt; a partial one keeps them; doctor then shows no line', { skip: !POSIX }, async (t) => {
  const home = tempDir(t);
  writeFileSync(join(home, '.zprofile'), 'export EDITOR=vi\n');
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  await install(home, hooksFor({ tty: true, answer: true }));
  assert.ok(existsSync(commandPath(home)));

  // Codex is not installed, so Claude Code stays: the launcher stays.
  const partial = await run(['uninstall', '--home', home, '--harness', 'codex'], hooksFor());
  assert.equal(partial.code, 0, partial.text);
  assert.ok(existsSync(commandPath(home)));
  assert.match(readFileSync(join(home, '.zprofile'), 'utf8'), /# >>> jevris PATH >>>/);

  const plan = await run(['uninstall', '--home', home, '--dry-run'], hooksFor());
  assert.match(plan.text, /^ {2}\S+ +~\/\.local\/bin\/jevris {2}\(jevris command\)$/m);
  assert.match(plan.text, /^ {2}remove from ~\/\.zprofile {2}\(jevris PATH block\)$/m);
  assert.ok(existsSync(commandPath(home)), 'a dry run removes nothing');

  const full = await run(['uninstall', '--home', home], hooksFor());
  assert.equal(full.code, 0, full.text);
  assert.equal(existsSync(commandPath(home)), false);
  assert.ok(existsSync(join(home, '.local', 'bin')), 'a ~/.local/bin that was there before install stays');
  assert.equal(readFileSync(join(home, '.zprofile'), 'utf8'), 'export EDITOR=vi\n');
  assert.equal(existsSync(receiptFile(home)), false);
  const doctor = await run(['doctor', '--home', home], hooksFor());
  assert.doesNotMatch(doctor.text, /jevris command/);
});

test('a hand-edited PATH block is left alone and reported; an uninstall finds a launcher from an older runtime by its receipt', { skip: !POSIX }, async (t) => {
  const home = tempDir(t);
  await install(home, hooksFor({ tty: true, answer: true }));
  const profile = join(home, '.zprofile');
  const edited = readFileSync(profile, 'utf8').replace('esac', 'esac\nexport FOO=1');
  writeFileSync(profile, edited);
  // The receipt names a launcher an older runtime wrote, in another place, for a runtime that is gone.
  const older = join(home, 'old-bin', 'jevris');
  mkdirSync(join(home, 'old-bin'));
  writeFileSync(older, launcher.launcherScript(process.platform, process.execPath, join(home, 'runtime-0.9.0', 'bin', 'jevris.mjs')), { mode: 0o755 });
  const receipt = JSON.parse(readFileSync(receiptFile(home), 'utf8'));
  writeFileSync(receiptFile(home), JSON.stringify({ ...receipt, launcher: { ...receipt.launcher, path: older, entry: join(home, 'runtime-0.9.0', 'bin', 'jevris.mjs') } }));
  const removed = await run(['uninstall', '--home', home], hooksFor());
  assert.equal(removed.code, 0, removed.text);
  assert.equal(existsSync(older), false);
  assert.equal(readFileSync(profile, 'utf8'), edited);
  assert.match(removed.text, /^next: The Jevris PATH block in ~\/\.zprofile was changed by hand, so it was left alone; remove the lines from "# >>> jevris PATH >>>" to "# <<< jevris PATH <<<" yourself\.$/m);
});

test('doctor names the fix when the launcher folder is not on PATH, and says when install never wrote a launcher', { skip: !POSIX }, async (t) => {
  const home = tempDir(t);
  await install(home, hooksFor());
  const json = JSON.parse((await run(['doctor', '--home', home, '--json'], hooksFor())).text);
  const line = json.lines.find((item) => item.text.startsWith('jevris command: '));
  assert.deepEqual(line, { text: 'jevris command: not on PATH: add this line to ~/.zprofile, then open a new terminal: export PATH="$HOME/.local/bin:$PATH"', severity: 'action' });
  rmSync(commandPath(home));
  rmSync(receiptFile(home));
  const missing = JSON.parse((await run(['doctor', '--home', home, '--json'], hooksFor())).text).lines.find((item) => item.text.startsWith('jevris command: '));
  assert.equal(missing.severity, 'action');
  assert.match(missing.text, /^jevris command: not installed: run jevris install --yes/);
});

// Windows, with fixtures: the paths, the .cmd text and the user PATH in HKCU\Environment.

function fakeReg(initial) {
  const state = { value: initial, type: 'REG_EXPAND_SZ', calls: [] };
  const exec = async (args) => {
    state.calls.push(args);
    if (args[0] === 'query') {
      if (state.value === null) return { status: 1, stdout: '', stderr: 'ERROR: The system was unable to find the specified registry key or value.' };
      return { status: 0, stdout: `\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    ${state.type}    ${state.value}\r\n\r\n`, stderr: '' };
    }
    if (args[0] === 'add') {
      state.value = args[args.indexOf('/d') + 1];
      state.type = args[args.indexOf('/t') + 1];
      return { status: 0, stdout: 'The operation completed successfully.\r\n', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: '' };
  };
  return { state, exec };
}

test('Windows: the launcher is %LOCALAPPDATA%\\Jevris\\bin\\jevris.cmd, marked, with no shell interpolation of the paths', () => {
  const home = 'C:\\Users\\dev';
  const dataRoot = jevrisPaths({ home, platform: 'win32', env: {} }).data;
  const place = { home, dataRoot, platform: 'win32', env: {} };
  assert.equal(launcher.launcherPath(place), 'C:\\Users\\dev\\AppData\\Local\\Jevris\\bin\\jevris.cmd');
  const text = launcher.launcherScript('win32', 'C:\\Program Files (x86)\\node%1\\node.exe', 'C:\\Users\\dev\\AppData\\Local\\Jevris\\runtime\\1.2.0\\bin\\jevris.mjs');
  const lines = text.split('\r\n');
  assert.equal(lines[0], '@echo off');
  assert.equal(lines[1], 'rem jevris-launcher: written by jevris install; jevris uninstall removes it');
  assert.ok(lines.includes('set "JEVRIS_NODE=C:\\Program Files (x86)\\node%%1\\node.exe"'));
  assert.ok(lines.includes('"%JEVRIS_NODE%" "%JEVRIS_ENTRY%" %*'));
  assert.ok(lines.includes('exit /b 127'));
  assert.ok(!text.includes('\n(') && !/if not exist [^\r]*\(/.test(text), 'no parenthesised blocks a path with ) could break');
  assert.match(launcher.windowsPathLine('C:\\Users\\dev\\AppData\\Local\\Jevris\\bin'), /^\[Environment\]::SetEnvironmentVariable\('Path', .*';C:\\Users\\dev\\AppData\\Local\\Jevris\\bin', 'User'\)$/);
});

test('Windows: the user PATH entry is added once and removed exactly, keeping its type and every other entry', async () => {
  const dir = 'C:\\Users\\dev\\AppData\\Local\\Jevris\\bin';
  const reg = fakeReg('C:\\Tools;%USERPROFILE%\\bin');
  assert.equal(await launcher.addWindowsPath(reg.exec, dir), 'added');
  assert.equal(reg.state.value, `C:\\Tools;%USERPROFILE%\\bin;${dir}`);
  assert.equal(reg.state.type, 'REG_EXPAND_SZ');
  assert.equal(await launcher.addWindowsPath(reg.exec, `${dir.toLowerCase()}\\`), 'present');
  assert.equal(await launcher.removeWindowsPath(reg.exec, dir), 'removed');
  assert.equal(reg.state.value, 'C:\\Tools;%USERPROFILE%\\bin');
  assert.equal(await launcher.removeWindowsPath(reg.exec, dir), 'absent');
  const empty = fakeReg(null);
  assert.equal(await launcher.addWindowsPath(empty.exec, dir), 'added');
  assert.equal(empty.state.value, dir);
  // The real reg.exe is used only on Windows, for the account's own home, outside a test run.
  const place = { home: 'C:\\Users\\dev', dataRoot: 'C:\\Users\\dev\\AppData\\Local\\Jevris', platform: 'win32', env: {} };
  assert.equal(launcher.registryPort(place, { accountHome: false }), null);
  assert.equal(launcher.registryPort({ ...place, env: { JEVRIS_TEST: '1' } }, { accountHome: true }), null);
  if (process.platform !== 'win32') assert.equal(launcher.registryPort(place, { accountHome: true }), null);
});

test('Windows: uninstall removes the user PATH entry only when the receipt says install added it', async (t) => {
  const home = tempDir(t);
  const place = { home, dataRoot: jevrisPaths({ home }).data, platform: process.platform, env: {} };
  const dir = 'C:\\Users\\dev\\AppData\\Local\\Jevris\\bin';
  const reg = fakeReg(`C:\\Tools;${dir}`);
  // No receipt: nothing proves the entry is Jevris's, so reg.exe is not even asked.
  await launcher.removeCommand(place, { accountHome: true, regExec: reg.exec });
  assert.deepEqual(reg.state.calls, []);
  mkdirSync(place.dataRoot, { recursive: true });
  writeFileSync(launcher.commandReceiptPath(place), JSON.stringify({ schemaVersion: 1, launcher: { path: join(home, 'none'), node: 'node', entry: 'x', dirCreated: false }, profile: null, windowsPath: { dir }, pathOffer: 'accepted' }));
  const plan = await launcher.removeCommand(place, { accountHome: true, regExec: reg.exec, dryRun: true });
  assert.deepEqual(plan.steps, [{ action: 'edit', path: dir, detail: 'remove from the user PATH (HKCU\\Environment)' }]);
  assert.equal(reg.state.value, `C:\\Tools;${dir}`);
  const done = await launcher.removeCommand(place, { accountHome: true, regExec: reg.exec });
  assert.deepEqual(done.steps, [{ action: 'edit', path: dir, detail: 'removed from the user PATH (HKCU\\Environment)' }]);
  assert.equal(reg.state.value, 'C:\\Tools');
  assert.equal(existsSync(launcher.commandReceiptPath(place)), false);
  // Without a usable reg.exe (another home), the manual PowerShell line is the next step.
  writeFileSync(launcher.commandReceiptPath(place), JSON.stringify({ schemaVersion: 1, launcher: { path: join(home, 'none'), node: 'node', entry: 'x', dirCreated: false }, profile: null, windowsPath: { dir }, pathOffer: 'accepted' }));
  const manual = await launcher.removeCommand(place, { accountHome: false });
  assert.match(manual.nextSteps.join('\n'), /^Remove C:\\Users\\dev\\AppData\\Local\\Jevris\\bin from your user PATH \(it was added by jevris install\): \[Environment\]::SetEnvironmentVariable/m);
});

test('route learning: the last uninstall keeps <data>/route-learning (machine/ too) by default, and --delete-data removes all of it', async (t) => {
  const home = tempDir(t);
  const data = jevrisPaths({ home }).data;
  await install(home, hooksFor());
  const machine = join(data, 'route-learning', 'machine');
  mkdirSync(machine, { recursive: true });
  writeFileSync(join(machine, 'aggregate.json'), '{}\n');
  writeFileSync(join(data, 'route-learning', 'workspace.json'), '{}\n');
  const kept = await run(['uninstall', '--home', home], hooksFor());
  assert.equal(kept.code, 0, kept.text);
  assert.ok(existsSync(join(machine, 'aggregate.json')), '--keep-data is the default');
  await install(home, hooksFor());
  const removed = await run(['uninstall', '--home', home, '--delete-data'], hooksFor());
  assert.equal(removed.code, 0, removed.text);
  assert.equal(existsSync(join(data, 'route-learning')), false);
  assert.equal(existsSync(machine), false);
  assert.equal(existsSync(commandPath(home)), false);
  // FIX-16: the empty folders the launcher step created go too. On macOS that is ~/.local itself.
  // On Linux the data folder is ~/.local/share/jevris (XDG), so ~/.local and ~/.local/share existed
  // before the launcher step and are not in its receipt: they stay, and only jevris/ inside goes.
  if (POSIX) assert.equal(existsSync(join(home, '.local', 'bin')), false, 'the empty ~/.local/bin install created goes (FIX-16)');
  if (process.platform === 'darwin') assert.equal(existsSync(join(home, '.local')), false, 'the empty ~/.local install created goes (FIX-16)');
  if (process.platform === 'linux') assert.equal(existsSync(join(home, '.local', 'share', 'jevris')), false);
});

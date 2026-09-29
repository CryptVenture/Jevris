// The CLI's terminal look (owner request): colour, text styling and the Jevris logo, only on a
// real terminal. Pairs: the same command plain when stdout is not a TTY, with NO_COLOR, TERM=dumb,
// FORCE_COLOR=0 or --no-color, and styled on a terminal. The styled text, with its escape codes
// removed, keeps the plain text's words (restyle, never reword). --json, the doctor's
// JEVRIS_REPORT line and piped output are never styled. The logo is snapshotted here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sandbox as acceptanceSandbox } from '../../../test/acceptance/lib.mjs';

const term = await import('../dist/terminal.js');
const { doctorLineSeverity } = await import('../dist/doctor-severity.js');
const { jevrisVersion } = await import('../dist/public/help.js');
const cliUrl = pathToFileURL(fileURLToPath(new URL('../../../dist/cli.mjs', import.meta.url))).href;
const bin = fileURLToPath(new URL('../../../bin/jevris.mjs', import.meta.url));
const ESC = '\u001b[';

const LOGO = [
  '     ██╗███████╗██╗   ██╗██████╗ ██╗███████╗',
  '     ██║██╔════╝██║   ██║██╔══██╗██║██╔════╝',
  '     ██║█████╗  ██║   ██║██████╔╝██║███████╗',
  '██   ██║██╔══╝  ╚██╗ ██╔╝██╔══██╗██║╚════██║',
  '╚█████╔╝███████╗ ╚████╔╝ ██║  ██║██║███████║',
  ' ╚════╝ ╚══════╝  ╚═══╝  ╚═╝  ╚═╝╚═╝╚══════╝',
  '  v1.2.3 · decisions for coding agents',
  '',
].join('\n');

const tty = (extra = {}) => ({ isTTY: true, columns: 100, ...extra });

test('styling needs a terminal and yields to NO_COLOR, TERM=dumb, FORCE_COLOR=0 and --no-color', () => {
  const utf8 = { LANG: 'en_US.UTF-8' };
  assert.equal(term.terminalProfile({ isTTY: false }, utf8, 'linux'), null, 'a pipe is plain');
  assert.equal(term.terminalProfile({}, { ...utf8, FORCE_COLOR: '3' }, 'linux'), null, 'FORCE_COLOR does not style a pipe');
  assert.equal(term.terminalProfile(tty(), { ...utf8, NO_COLOR: '1' }, 'linux'), null);
  assert.equal(term.terminalProfile(tty(), { ...utf8, TERM: 'dumb' }, 'linux'), null);
  assert.equal(term.terminalProfile(tty(), { ...utf8, FORCE_COLOR: '0' }, 'linux'), null);
  assert.equal(term.terminalProfile(tty(), utf8, 'linux', true), null, '--no-color');
  assert.deepEqual(term.terminalProfile(tty(), { ...utf8, NO_COLOR: '' }, 'linux'), { depth: 4, utf8: true, columns: 100 }, 'an empty NO_COLOR is unset');
  assert.equal(term.terminalProfile(tty(), { ...utf8, FORCE_COLOR: '3' }, 'linux').depth, 24);
  assert.equal(term.terminalProfile(tty(), { ...utf8, FORCE_COLOR: '2' }, 'linux').depth, 8);
  assert.equal(term.terminalProfile(tty({ getColorDepth: () => 24 }), utf8, 'linux').depth, 24, 'the stream decides without FORCE_COLOR');
  assert.equal(term.terminalProfile(tty({ getColorDepth: () => 1 }), utf8, 'linux'), null, 'a monochrome terminal is plain');
  assert.equal(term.terminalProfile(tty(), { ...utf8, COLORTERM: 'truecolor' }, 'linux').depth, 24);
});

test('UTF-8 box and block characters only where the terminal shows them (Windows Terminal, PowerShell there, a UTF-8 locale)', () => {
  assert.equal(term.utf8Terminal({ WT_SESSION: 'x' }, 'win32'), true, 'Windows Terminal, PowerShell included');
  assert.equal(term.utf8Terminal({ TERM_PROGRAM: 'vscode' }, 'win32'), true);
  assert.equal(term.utf8Terminal({}, 'win32'), false, 'the legacy console gets ASCII');
  assert.equal(term.utf8Terminal({ LANG: 'en_GB.UTF-8' }, 'linux'), true);
  assert.equal(term.utf8Terminal({ LC_ALL: 'C' }, 'linux'), false);
  assert.equal(term.utf8Terminal({}, 'linux'), false);
  assert.equal(term.utf8Terminal({}, 'darwin'), true);
  assert.deepEqual(term.glyphs({ depth: 4, utf8: false, columns: 80 }), { ok: '+', info: 'i', warn: '!', error: 'x', rule: '-' });
});

test('the logo: six gradient rows and the version line; one line on a narrow or non-UTF-8 terminal', () => {
  const wide = term.logo({ depth: 24, utf8: true, columns: 80 }, '1.2.3');
  assert.equal(term.stripStyle(wide), LOGO);
  const rows = wide.split('\n').slice(0, 6);
  assert.match(rows[0], /38;2;20;184;166m/, 'the first row is teal');
  assert.match(rows[5], /38;2;59;130;246m/, 'the last row is blue');
  assert.equal(new Set(rows.map((row) => /38;2;[\d;]+m/.exec(row)[0])).size, 6, 'each row has its own colour');
  assert.match(term.logo({ depth: 8, utf8: true, columns: 80 }, '1.2.3'), /38;5;43m/, '256 colours');
  assert.match(term.logo({ depth: 4, utf8: true, columns: 80 }, '1.2.3'), /\u001b\[96m/, '16 colours');
  assert.equal(term.stripStyle(term.logo({ depth: 24, utf8: true, columns: 59 }, '1.2.3')), 'JEVRIS v1.2.3\n');
  assert.equal(term.stripStyle(term.logo({ depth: 24, utf8: false, columns: 120 }, '1.2.3')), 'JEVRIS v1.2.3\n');
});

test('only machine paths are exempt: --json, the MCP entry; the logo leads help, version, install and doctor', () => {
  assert.equal(term.styleFor(['status', '--json']), null);
  assert.equal(term.styleFor(['__surface', 'status']), null);
  assert.deepEqual(term.styleFor(['--help']), { presentation: 'auto', logoFirst: true });
  assert.deepEqual(term.styleFor(['doctor']), { presentation: 'doctor', logoFirst: true });
  assert.deepEqual(term.styleFor(['install', '--harness', 'codex']), { presentation: 'auto', logoFirst: true });
  assert.deepEqual(term.styleFor(['status']), { presentation: 'auto', logoFirst: false });
  assert.deepEqual(term.styleFor(['route', '--help']), { presentation: 'auto', logoFirst: false });
});

/**
 * The acceptance sandbox (temp HOME, harness stubs first on PATH, JEVRIS_NO_LIVE_HARNESS), with
 * the colour and locale variables set here rather than inherited.
 */
async function sandbox(t) {
  const box = await acceptanceSandbox(t);
  const env = {};
  for (const [key, value] of Object.entries(box.env)) {
    if (!/^(FORCE_COLOR|NO_COLOR|TERM|COLORTERM|LANG|WT_SESSION|TERM_PROGRAM)$|^LC_/.test(key)) env[key] = value;
  }
  Object.assign(env, { JEVRIS_SIDECAR_AUTOSTART: '0', LANG: 'en_US.UTF-8', WT_SESSION: '1' });
  // stdout as a terminal: the built CLI's main() with isTTY set, the way a terminal presents it.
  const onTerminal = (argv, extraEnv = {}, columns = 200) =>
    spawnSync(
      process.execPath,
      ['--input-type=module', '-e', "Object.defineProperty(process.stdout, 'isTTY', { value: true }); Object.defineProperty(process.stdout, 'columns', { value: Number(process.env.JEVRIS_TERMINAL_COLUMNS) }); const { main } = await import(process.env.JEVRIS_TERMINAL_CLI); process.exitCode = await main(JSON.parse(process.env.JEVRIS_TERMINAL_ARGV));"],
      { env: { ...env, JEVRIS_TERMINAL_CLI: cliUrl, JEVRIS_TERMINAL_ARGV: JSON.stringify(argv), JEVRIS_TERMINAL_COLUMNS: String(columns), ...extraEnv }, cwd: box.work, encoding: 'utf8' },
    );
  const piped = (argv, extraEnv = {}) => spawnSync(process.execPath, [bin, ...argv], { env: { ...env, ...extraEnv }, cwd: box.work, encoding: 'utf8' });
  return { home: box.home, onTerminal, piped };
}

const words = (text) => term.stripStyle(text).split(/\s+/).filter(Boolean);

test('help and version: styled with the logo on a terminal, plain and unchanged in a pipe (the pair)', async (t) => {
  const box = await sandbox(t);
  const plain = box.piped(['--help']);
  assert.equal(plain.status, 0);
  assert.ok(!plain.stdout.includes(ESC), 'piped help has no escape codes');
  assert.ok(!plain.stdout.includes('██'), 'piped help has no logo');
  for (const env of [{ FORCE_COLOR: '3' }, {}]) {
    const styled = box.onTerminal(['--help'], env);
    assert.equal(styled.status, 0, styled.stderr);
    assert.ok(styled.stdout.includes(ESC), 'help on a terminal is styled');
    const bare = term.stripStyle(styled.stdout);
    assert.ok(bare.startsWith(LOGO.replace('1.2.3', jevrisVersion())), 'the logo leads');
    assert.equal(bare.slice(LOGO.replace('1.2.3', jevrisVersion()).length + 1), plain.stdout, 'the help text itself is unchanged');
  }
  assert.equal(box.piped(['--version']).stdout, `jevris ${jevrisVersion()}\n`);
  assert.equal(term.stripStyle(box.onTerminal(['--version'], { FORCE_COLOR: '3' }).stdout), LOGO.replace('1.2.3', jevrisVersion()));
  // A command's help: coloured, same words, no logo.
  const route = box.onTerminal(['route', '--help'], { FORCE_COLOR: '3' });
  assert.ok(route.stdout.includes(ESC) && !route.stdout.includes('██'));
  assert.equal(term.stripStyle(route.stdout), box.piped(['route', '--help']).stdout);
  // Plain on a terminal when asked: NO_COLOR, TERM=dumb, FORCE_COLOR=0, --no-color.
  for (const [argv, env] of [[['--help'], { NO_COLOR: '1' }], [['--help'], { TERM: 'dumb' }], [['--help'], { FORCE_COLOR: '0' }], [['--help', '--no-color'], { FORCE_COLOR: '3' }]]) {
    const out = box.onTerminal(argv, env);
    assert.equal(out.stdout, plain.stdout, `${argv.join(' ')} ${JSON.stringify(env)}`);
  }
});

test('a command answer on a terminal: styled, the same words; --json and a pipe untouched', async (t) => {
  const box = await sandbox(t);
  const plain = box.piped(['status']);
  const styled = box.onTerminal(['status'], { FORCE_COLOR: '3' });
  assert.equal(styled.status, plain.status);
  assert.ok(styled.stdout.includes(ESC) && !plain.stdout.includes(ESC));
  assert.deepEqual(words(styled.stdout), words(plain.stdout), 'restyled, never reworded');
  const json = box.onTerminal(['status', '--json'], { FORCE_COLOR: '3' });
  assert.ok(!json.stdout.includes(ESC), '--json is never styled');
  assert.equal(JSON.parse(json.stdout).command, 'status');
  const noColor = box.onTerminal(['status', '--no-color'], { FORCE_COLOR: '3' });
  assert.equal(noColor.stdout, plain.stdout, '--no-color is accepted by any command and changes nothing else');
});

test('doctor on a terminal: the logo, grouped sections with a mark per line, and the JEVRIS_REPORT line plain', async (t) => {
  const box = await sandbox(t);
  const argv = ['doctor', '--harness-version', '2.1.280'];
  const plain = box.piped(argv);
  const styled = box.onTerminal(argv, { FORCE_COLOR: '3' });
  assert.equal(styled.status, plain.status);
  assert.ok(!plain.stdout.includes(ESC));
  const bare = term.stripStyle(styled.stdout);
  assert.ok(bare.startsWith(LOGO.replace('1.2.3', jevrisVersion())));
  assert.match(bare, /^actuator$/m, 'a section heading from the lines\' own leading word');
  assert.match(bare, /^ {2}[✓i!✗] \S/m, 'each item carries a mark');
  // Each mark is doctor's own severity for that line, in order (F's doctorLineSeverity): ✓ only
  // for ok, so a problem never shows as passing.
  const MARK = { ok: '✓', info: 'i', action: '!', broken: '✗' };
  const expected = plain.stdout
    .split('\n')
    .filter((line) => !line.startsWith('JEVRIS_REPORT '))
    .map((line) => doctorLineSeverity(line))
    .filter((severity) => severity !== null)
    .map((severity) => MARK[severity]);
  const shown = bare
    .split('\n')
    .map((line) => /^ {2}([✓i!✗]) /.exec(line)?.[1])
    .filter(Boolean);
  assert.ok(expected.length > 5, 'doctor printed keyed lines');
  assert.deepEqual(shown, expected, 'the marks are doctor\'s severities, line by line');
  const report = (text) => text.split('\n').find((line) => line.startsWith('JEVRIS_REPORT '));
  assert.equal(report(styled.stdout), report(plain.stdout), 'the machine line is byte-identical and unstyled');
  const plainWords = words(plain.stdout).filter((w) => !['actuator', 'harness', 'nativeAddon'].includes(w));
  for (const w of words(bare.slice(LOGO.replace('1.2.3', jevrisVersion()).length)).filter((x) => !['✓', 'i', '!', '✗', 'actuator', 'harness', 'nativeAddon'].includes(x))) {
    assert.ok(plainWords.includes(w), `doctor gained the word ${w}`);
  }
});

test('long text wraps at the terminal width with a hanging indent; words and quoted commands stay whole', async (t) => {
  const box = await sandbox(t);
  const plain = box.piped(['--help']);
  const narrow = box.onTerminal(['--help'], { FORCE_COLOR: '3' }, 80);
  const bare = term.stripStyle(narrow.stdout).split('\n').slice(8);
  for (const line of bare) assert.ok(line.length <= 79 || !line.trim().includes(' '), `too wide: ${line}`);
  assert.deepEqual(words(bare.join('\n')), words(plain.stdout), 'wrapping keeps every word');
  assert.match(term.stripStyle(narrow.stdout), /^ {2}advise {7}Orchestration .*\n {15}\S/m, 'a description continues under its column');
  const p = { depth: 24, utf8: true, columns: 50 };
  const report = term.stripStyle(term.presentReport(p, 'what to do: The Jevris sidecar is not running. Run `jevris sidecar start`, or retry: it starts on demand.\n'));
  assert.equal(report, 'what to do: The Jevris sidecar is not running.\n            Run `jevris sidecar start`, or retry:\n            it starts on demand.\n');
  const refusal = term.presentReport(p, 'refused (SCOPE_DENIED): the workspace is not granted for owned mode here\n');
  assert.match(refusal, /\u001b\[1m\u001b\[38;2;239;68;68mrefused/, 'the refusal is red and bold');
  assert.match(refusal, /\u001b\[38;2;239;68;68mSCOPE_DENIED/, 'its reason code is red');
  assert.equal(term.stripStyle(refusal), 'refused (SCOPE_DENIED): the workspace is not\n  granted for owned mode here\n');
});

test('doctor marks come from the item\'s status: ✓ only when doctor says ok, never for a problem', () => {
  const p = { depth: 24, utf8: true, columns: 200 };
  const problems = [
    'privateFiles: wide /Users/me/.jevris mode 0755',
    'harness kilo auth: subscription (auto: no vendor key in the environment; not detected)',
    'sidecar: not-running (degraded); kill switch clear.',
    'eventProbe: did-not-pass',
    'harness claude: not installed; version 2.1.283; certification records: 0',
    'egressReasonCode: EGRESS_NOT_APPROVED',
    'legacyLayout: leftovers /Users/me/.jevris-old',
  ];
  const marks = (text, severityOf) =>
    term
      .stripStyle(term.presentDoctor(p, text, severityOf))
      .split('\n')
      .map((line) => /^ {2}([✓i!✗]) /.exec(line)?.[1])
      .filter(Boolean);
  // Without doctor's classification, nothing is ✓, and every problem is ! or ✗.
  assert.deepEqual(marks(problems.join('\n')), ['!', '!', '!', '✗', '!', '!', '!']);
  assert.deepEqual(marks('nativeAddon keyring: loaded\nprivateFiles: ok'), ['i', 'i'], 'no ✓ by default');
  // With it, the mark is exactly doctor's: ok ✓, info i, action !, broken ✗; a null line is a note.
  const table = { 'a: 1': 'ok', 'b: 2': 'info', 'c: 3': 'action', 'd: 4': 'broken', 'e: 5': null };
  assert.deepEqual(marks(Object.keys(table).join('\n'), (line) => table[line]), ['✓', 'i', '!', '✗']);
  const styled = term.presentDoctor(p, 'c: 3', () => 'action');
  assert.match(styled, /\u001b\[38;2;245;158;11m!/, 'action is amber');
  assert.match(term.presentDoctor(p, 'd: 4', () => 'broken'), /\u001b\[38;2;239;68;68m✗/, 'broken is red');
  assert.match(term.presentDoctor(p, 'b: 2', () => 'info'), /\u001b\[2mi/, 'info is dim');
});

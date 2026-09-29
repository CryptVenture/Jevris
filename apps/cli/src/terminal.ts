/**
 * Terminal presentation for the jevris CLI: colour, text styling and the Jevris logo, applied
 * only when the output is a real terminal. It restyles the product's text and never rewords it:
 * with the colour stripped, the words are the plain output's words.
 *
 * Plain (no escape codes, byte-identical to before) whenever stdout is not a TTY, NO_COLOR is
 * set, TERM=dumb, FORCE_COLOR=0 or --no-color is given. JSON (--json, a JSON line, the doctor's
 * JEVRIS_REPORT line) is never styled. Hook stdout, MCP output and files written are separate
 * paths and never reach this module.
 *
 * FORCE_COLOR chooses the colour depth on a terminal (1: 16 colours, 2: 256, 3: true colour); it
 * does not push escape codes into a pipe, because node --test sets FORCE_COLOR=1 for every test
 * process and the product's piped output must stay plain.
 */

import type { DoctorSeverity } from './doctor-severity.js';

/** The logo, owner-chosen ("bold block letters"). The only copy of it in the product. */
const LOGO_ROWS: readonly string[] = [
  '     ██╗███████╗██╗   ██╗██████╗ ██╗███████╗',
  '     ██║██╔════╝██║   ██║██╔══██╗██║██╔════╝',
  '     ██║█████╗  ██║   ██║██████╔╝██║███████╗',
  '██   ██║██╔══╝  ╚██╗ ██╔╝██╔══██╗██║╚════██║',
  '╚█████╔╝███████╗ ╚████╔╝ ██║  ██║██║███████║',
  ' ╚════╝ ╚══════╝  ╚═══╝  ╚═╝  ╚═╝╚═╝╚══════╝',
];
const TAGLINE = 'decisions for coding agents';
/** Below this width the logo is one line. */
const LOGO_MIN_COLUMNS = 60;

export type ColorDepth = 4 | 8 | 24;

export interface TerminalProfile {
  readonly depth: ColorDepth;
  /** The terminal shows UTF-8 box, block and check characters; otherwise ASCII stand-ins. */
  readonly utf8: boolean;
  readonly columns: number;
}

type Env = { readonly [key: string]: string | undefined };

/**
 * Whether and how to style output written to `stream`. Null means plain. `noColorFlag` is the
 * --no-color option.
 */
export function terminalProfile(stream: unknown, env: Env, platform: string, noColorFlag = false): TerminalProfile | null {
  if (noColorFlag) return null;
  if (typeof env['NO_COLOR'] === 'string' && env['NO_COLOR'] !== '') return null;
  if (env['TERM'] === 'dumb') return null;
  const force = env['FORCE_COLOR'];
  if (force === '0' || force === 'false') return null;
  if (stream === null || typeof stream !== 'object' || Reflect.get(stream, 'isTTY') !== true) return null;
  const depth = colorDepth(stream, env);
  if (depth === null) return null;
  const rawColumns = Reflect.get(stream, 'columns');
  const columns = typeof rawColumns === 'number' && Number.isFinite(rawColumns) && rawColumns > 0 ? Math.floor(rawColumns) : 80;
  return { depth, utf8: utf8Terminal(env, platform), columns };
}

function colorDepth(stream: object, env: Env): ColorDepth | null {
  const force = env['FORCE_COLOR'];
  if (force === '3') return 24;
  if (force === '2') return 8;
  if (force === '1' || force === 'true' || force === '') return 4;
  const probe = Reflect.get(stream, 'getColorDepth');
  if (typeof probe === 'function') {
    try {
      const depth = Number(Reflect.apply(probe, stream, [env]));
      if (depth >= 24) return 24;
      if (depth >= 8) return 8;
      if (depth >= 4) return 4;
      return null;
    } catch {
      // fall through to the environment
    }
  }
  const colorterm = (env['COLORTERM'] ?? '').toLowerCase();
  if (colorterm === 'truecolor' || colorterm === '24bit') return 24;
  if (/256/.test(env['TERM'] ?? '')) return 8;
  return 4;
}

/**
 * Whether the terminal renders UTF-8 box and block characters. Windows: Windows Terminal
 * (WT_SESSION), an editor terminal (TERM_PROGRAM), ConEmu or an xterm-like TERM (mintty); the
 * legacy console gets ASCII. Elsewhere: the locale says UTF-8, or no locale is set on macOS.
 */
export function utf8Terminal(env: Env, platform: string): boolean {
  if (platform === 'win32') {
    return Boolean(env['WT_SESSION']) || Boolean(env['TERM_PROGRAM']) || env['ConEmuANSI'] === 'ON' || /xterm/i.test(env['TERM'] ?? '');
  }
  if (env['TERM'] === 'linux') return false;
  const locale = env['LC_ALL'] || env['LC_CTYPE'] || env['LANG'] || '';
  if (locale === '') return platform === 'darwin';
  return /utf-?8/i.test(locale);
}

// ---- colour ---------------------------------------------------------------------------------

export type Role = 'success' | 'warning' | 'error' | 'accent' | 'dim' | 'bold' | 'heading';

const RGB: { readonly [K in 'success' | 'warning' | 'error' | 'accent']: readonly [number, number, number] } = {
  success: [34, 197, 94],
  warning: [245, 158, 11],
  error: [239, 68, 68],
  accent: [20, 184, 166],
};
const ANSI256: { readonly [K in keyof typeof RGB]: number } = { success: 41, warning: 214, error: 203, accent: 37 };
const ANSI16: { readonly [K in keyof typeof RGB]: number } = { success: 32, warning: 33, error: 31, accent: 36 };

function sgrColor(rgb: readonly [number, number, number], c256: number, c16: number, depth: ColorDepth): string {
  if (depth === 24) return `38;2;${rgb[0]};${rgb[1]};${rgb[2]}`;
  if (depth === 8) return `38;5;${c256}`;
  return String(c16);
}

/** `text` in a semantic role. Resets only what it set, so roles nest. */
export function paint(profile: TerminalProfile, role: Role, text: string): string {
  if (text.length === 0) return text;
  switch (role) {
    case 'bold':
      return `\u001b[1m${text}\u001b[22m`;
    case 'dim':
      return `\u001b[2m${text}\u001b[22m`;
    case 'heading':
      return `\u001b[1m${paint(profile, 'accent', text)}\u001b[22m`;
    default:
      return `\u001b[${sgrColor(RGB[role], ANSI256[role], ANSI16[role], profile.depth)}m${text}\u001b[39m`;
  }
}

const ESCAPES = /\u001b\[[0-9;]*m/g;

/** The text without styling: what a pipe gets. */
export function stripStyle(text: string): string {
  return text.replace(ESCAPES, '');
}

// ---- glyphs and the logo --------------------------------------------------------------------

export interface Glyphs {
  readonly ok: string;
  readonly info: string;
  readonly warn: string;
  readonly error: string;
  readonly rule: string;
}

export function glyphs(profile: TerminalProfile): Glyphs {
  return profile.utf8 ? { ok: '✓', info: 'i', warn: '!', error: '✗', rule: '─' } : { ok: '+', info: 'i', warn: '!', error: 'x', rule: '-' };
}

const TEAL: readonly [number, number, number] = [20, 184, 166];
const BLUE: readonly [number, number, number] = [59, 130, 246];
const GRADIENT_256 = [43, 37, 38, 32, 33, 27];
const GRADIENT_16 = [96, 96, 36, 36, 94, 34];

function gradientRow(profile: TerminalProfile, row: number, text: string): string {
  const t = LOGO_ROWS.length === 1 ? 0 : row / (LOGO_ROWS.length - 1);
  const rgb: [number, number, number] = [0, 1, 2].map((i) => Math.round((TEAL[i] ?? 0) + ((BLUE[i] ?? 0) - (TEAL[i] ?? 0)) * t)) as [number, number, number];
  const code = sgrColor(rgb, GRADIENT_256[row] ?? 33, GRADIENT_16[row] ?? 36, profile.depth);
  return `\u001b[1m\u001b[${code}m${text}\u001b[39m\u001b[22m`;
}

/**
 * The logo block for a styled terminal, ending in a newline: six gradient rows (teal to blue)
 * and the version line, or one line "JEVRIS v<version>" on a non-UTF-8 or narrow terminal.
 */
export function logo(profile: TerminalProfile, version: string): string {
  if (!profile.utf8 || profile.columns < LOGO_MIN_COLUMNS) {
    return `${paint(profile, 'heading', 'JEVRIS')} ${paint(profile, 'dim', `v${version}`)}\n`;
  }
  const rows = LOGO_ROWS.map((row, i) => gradientRow(profile, i, row));
  return `${rows.join('\n')}\n  ${paint(profile, 'accent', `v${version}`)} ${paint(profile, 'dim', `· ${TAGLINE}`)}\n`;
}

// ---- presenters -----------------------------------------------------------------------------

const REASON_CODE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
const BROKEN_WORDS = /\b(did-not-pass|failed|failure|error|refused|corrupt|broken|tampered|invalid|blocked)\b/i;
const PROBLEM_WORDS = /\b(unsupported|not[ -][a-z]+|degraded|installation-only|unknown|deny|denied|missing|absent|disabled|stale|expired|pending|unverified|wide|leftovers?|[A-Z]+_NOT_[A-Z_]+|NOT_[A-Z_]+)\b/;

/** Status words as badges, reason codes in the warning colour (red on a refusal line). */
function badges(profile: TerminalProfile, text: string, refusal = false): string {
  return text
    .replace(REASON_CODE, (code) => paint(profile, refusal ? 'error' : 'warning', code))
    .replace(/\b(not certified|unverified)\b/g, (word) => paint(profile, 'warning', word))
    .replace(/(^|[^\w-])(certified)\b/g, (_m, lead: string, word: string) => `${lead}${paint(profile, 'success', word)}`)
    .replace(/\b(refused)\b/g, (word) => paint(profile, 'error', word));
}

/** The width text wraps at: one short of the terminal, never narrower than 40. */
function wrapWidth(profile: TerminalProfile): number {
  return Math.max(40, profile.columns - 1);
}

/**
 * `text` in lines of at most `width` columns: the first line starts after `firstUsed` columns,
 * the rest after `indent` spaces (a hanging indent). Breaks only at spaces outside backticks, so
 * a long path or a quoted command stays whole and copies cleanly. A line that fits is unchanged.
 */
export function wrapText(text: string, width: number, firstUsed: number, indent: number): string[] {
  if (firstUsed + text.length <= width) return [text];
  // A `quoted command` is one word: it never breaks across lines.
  const words = text.match(/(?:`[^`]*`|[^ `])+|`[^`]*$/g) ?? [''];
  const lines: string[] = [];
  let line = '';
  let used = firstUsed;
  for (const word of words) {
    if (line.length > 0 && used + 1 + word.length > width) {
      lines.push(line);
      line = word;
      used = indent + word.length;
      continue;
    }
    line = line.length === 0 ? word : `${line} ${word}`;
    used += (line === word ? 0 : 1) + word.length;
  }
  lines.push(line);
  return lines;
}

/** `prefix` then `text` wrapped with a hanging indent, each piece painted by `paintPiece`. */
function wrapped(profile: TerminalProfile, prefix: string, prefixWidth: number, text: string, indent: number, paintPiece: (piece: string) => string): string {
  const pad = ' '.repeat(indent);
  return wrapText(text, wrapWidth(profile), prefixWidth, indent)
    .map((piece, i) => (i === 0 ? `${prefix}${paintPiece(piece)}` : `${pad}${paintPiece(piece)}`))
    .join('\n');
}

/** Help text: a coloured command and option list with dim descriptions, bold headings. */
export function presentHelp(profile: TerminalProfile, text: string): string {
  let inExamples = false;
  return mapLines(text, (line) => {
    if (line.length === 0) return line;
    const usage = /^(Usage:)( .*)$/.exec(line);
    if (usage !== null) return `${paint(profile, 'bold', usage[1] ?? '')}${paint(profile, 'accent', usage[2] ?? '')}`;
    if (/^\S[^:]*:$/.test(line)) {
      inExamples = /^Examples?:$/.test(line);
      return wrapped(profile, '', 0, line, 2, (piece) => paint(profile, 'heading', piece));
    }
    const lead = /^(\S[^:]{0,40}:)( .*)$/.exec(line);
    if (lead !== null && !line.startsWith(' ')) {
      inExamples = false;
      const head = lead[1] ?? '';
      return wrapped(profile, `${paint(profile, 'bold', head)} `, head.length + 1, (lead[2] ?? '').slice(1), 2, (piece) => piece);
    }
    const row = /^( {2,})(\S(?:.*?\S)?)( {2,})(\S.*)$/.exec(line);
    if (row !== null && (row[1] ?? '').length <= 4) {
      const head = `${row[1]}${row[2]}${row[3]}`;
      return wrapped(profile, `${row[1]}${paint(profile, 'accent', row[2] ?? '')}${row[3]}`, head.length, row[4] ?? '', Math.min(head.length, 40), (piece) => paint(profile, 'dim', piece));
    }
    if (/^ {5,}\S/.test(line) && !/^ {5,}\[/.test(line)) {
      const indent = /^ */.exec(line)?.[0].length ?? 0;
      return wrapped(profile, ' '.repeat(indent), indent, line.slice(indent), Math.min(indent, 40), (piece) => paint(profile, 'dim', piece));
    }
    if (/^ +\[/.test(line) || (inExamples && /^ {2}\S/.test(line))) return paint(profile, 'accent', line);
    const indent = /^ */.exec(line)?.[0].length ?? 0;
    return wrapped(profile, ' '.repeat(indent), indent, line.slice(indent), Math.min(indent + 2, 40), (piece) => piece);
  });
}

const KEY_VALUE = /^([a-z][a-z0-9 ._/()-]{0,48}?): (.*)$/;

/**
 * A command's human answer: a bold first sentence, aligned dim keys, status badges, reason
 * codes, a red reason on a refusal, and long values wrapped under their value column.
 */
export function presentReport(profile: TerminalProfile, text: string, first = true): string {
  const lines = text.split('\n');
  // Align the keys of each run of key: value lines.
  const widths: number[] = new Array<number>(lines.length).fill(0);
  let runStart = 0;
  let width = 0;
  const closeRun = (end: number): void => {
    for (let i = runStart; i < end; i += 1) widths[i] = width;
  };
  lines.forEach((line, i) => {
    const kv = KEY_VALUE.exec(line);
    if (kv === null) {
      closeRun(i);
      runStart = i + 1;
      width = 0;
      return;
    }
    width = Math.max(width, (kv[1] ?? '').length);
  });
  closeRun(lines.length);
  const last = lines.length - 1;
  return lines
    .map((line, i) => {
      if (line.length === 0) return line;
      // A partial last line is a question waiting for an answer: styled, never wrapped.
      if (i === last && !text.endsWith('\n') && /[?:\]] ?$/.test(line)) return badges(profile, line);
      if (line.startsWith('JEVRIS_REPORT ')) return line;
      const refusal = /^refused\b/i.exec(line);
      if (refusal !== null) {
        const rest = line.slice(refusal[0].length);
        const gap = rest.startsWith(' ') ? ' ' : '';
        const head = `${paint(profile, 'bold', paint(profile, 'error', refusal[0]))}${gap}`;
        return wrapped(profile, head, refusal[0].length + gap.length, rest.slice(gap.length), 2, (piece) => badges(profile, piece, true));
      }
      if (/^(Unknown (option|command)|Give |Use )/.test(line)) return wrapped(profile, '', 0, line, 2, (piece) => paint(profile, 'error', piece));
      if (/^Run jevris .*--help/.test(line)) return paint(profile, 'dim', line);
      const kv = KEY_VALUE.exec(line);
      if (kv !== null) {
        const key = kv[1] ?? '';
        const column = (widths[i] ?? 0) + 2;
        const pad = ' '.repeat(Math.max(0, column - key.length - 2));
        const indent = column <= 40 ? column : 4;
        return wrapped(profile, `${paint(profile, 'dim', `${key}:`)}${pad} `, column, kv[2] ?? '', indent, (piece) => badges(profile, piece));
      }
      const leading = first && i === 0 && /[.)]$/.test(line);
      return wrapped(profile, '', 0, line, 2, (piece) => (leading ? paint(profile, 'bold', badges(profile, piece)) : badges(profile, piece)));
    })
    .join('\n');
}

/**
 * Doctor severities (F's doctor-severity.ts, agreed with E): ok ✓, info i (by design or
 * informational, dim), action ! (action needed, amber, with its fix), broken ✗ (red).
 */
export type { DoctorSeverity };

/** The severity of one doctor line, from doctor's own classification; null for a note line. */
export type DoctorSeverityOf = (line: string) => DoctorSeverity | null;

/**
 * Without doctor's classification a line is never shown as passing: a problem word makes it
 * action or broken, anything else is info. ✓ comes only from doctor saying ok.
 */
export function cautiousSeverity(line: string): DoctorSeverity | null {
  const m = DOCTOR_LINE.exec(line);
  if (m === null) return null;
  const value = m[3] ?? '';
  if (BROKEN_WORDS.test(value)) return 'broken';
  if (PROBLEM_WORDS.test(value)) return 'action';
  return 'info';
}

const DOCTOR_LINE = /^([A-Za-z][\w.-]*)((?: [\w.-]+){0,2}): (.*)$/;

/**
 * `jevris doctor`: the same lines grouped by their leading word (actuator, harness, nativeAddon)
 * under a heading, each with its severity mark, notes dimmed under their line, long text wrapped
 * with a hanging indent. The JEVRIS_REPORT line stays plain.
 */
export function presentDoctor(profile: TerminalProfile, text: string, severityOf: DoctorSeverityOf = cautiousSeverity): string {
  const g = glyphs(profile);
  const lines = text.split('\n');
  const parsed = lines.map((line) => {
    const m = DOCTOR_LINE.exec(line);
    return m === null ? null : { group: m[1] ?? '', rest: (m[2] ?? '').trim(), value: m[3] ?? '' };
  });
  /** The nearest keyed line before (-1) or after (+1) line i, skipping notes. */
  const neighbour = (i: number, step: -1 | 1) => {
    for (let j = i + step; j >= 0 && j < parsed.length; j += step) {
      const p = parsed[j];
      if (p !== null && p !== undefined) return p;
      if ((lines[j] ?? '').startsWith('JEVRIS_REPORT ')) return null;
    }
    return null;
  };
  const markText = (severity: DoctorSeverity): string => {
    switch (severity) {
      case 'ok':
        return paint(profile, 'success', g.ok);
      case 'info':
        return paint(profile, 'dim', g.info);
      case 'action':
        return paint(profile, 'warning', g.warn);
      default:
        return paint(profile, 'error', g.error);
    }
  };
  const out: string[] = [];
  let current: string | null = null;
  lines.forEach((line, i) => {
    const item = parsed[i];
    if (line.startsWith('JEVRIS_REPORT ')) {
      out.push('', line);
      current = null;
      return;
    }
    let severity: DoctorSeverity | null = null;
    try {
      severity = item === null || item === undefined ? null : severityOf(line);
    } catch {
      severity = null;
    }
    if (item === null || item === undefined || severity === null) {
      if (line.length === 0) out.push(line);
      else {
        const indent = current === null ? 2 : 6;
        out.push(wrapped(profile, ' '.repeat(indent), indent, line, indent, (piece) => paint(profile, 'dim', piece)));
      }
      return;
    }
    const grouped = item.rest.length > 0 && (neighbour(i, -1)?.group === item.group || neighbour(i, 1)?.group === item.group);
    const group = grouped ? item.group : '';
    if (group !== current) {
      if (group !== '') out.push('', paint(profile, 'heading', group));
      else if (current !== null && current !== '') out.push('');
      current = group;
    }
    const label = grouped ? item.rest : `${item.group}${item.rest.length > 0 ? ` ${item.rest}` : ''}`;
    const prefix = `  ${markText(severity)} ${paint(profile, 'bold', label)}: `;
    const value = (piece: string): string => (severity === 'info' ? paint(profile, 'dim', piece) : badges(profile, piece));
    out.push(wrapped(profile, prefix, 4 + label.length + 2, item.value, 6, value));
  });
  return out.join('\n');
}

function mapLines(text: string, fn: (line: string) => string): string {
  return text
    .split('\n')
    .map((line) => fn(line))
    .join('\n');
}

// ---- the writer -----------------------------------------------------------------------------

export type Presentation = 'auto' | 'doctor';

export interface WriterOptions {
  /** The version for a logo before the first chunk. */
  readonly logoFirst?: string;
  /** Doctor's own line classification; without it no doctor line shows ✓. */
  readonly doctorSeverity?: DoctorSeverityOf;
}

export interface StyledTerminal {
  readonly profile: TerminalProfile;
  /** A writer that styles each chunk for this command. */
  writer(presentation: Presentation, sink: (text: string) => void, options?: WriterOptions): (text: string) => void;
  logo(version: string): string;
}

export function styledTerminal(profile: TerminalProfile): StyledTerminal {
  return {
    profile,
    logo: (version) => logo(profile, version),
    writer(presentation, sink, options) {
      let pendingLogo = options?.logoFirst;
      let firstReport = true;
      return (text: string) => {
        const prefix = pendingLogo === undefined ? '' : `${logo(profile, pendingLogo)}\n`;
        pendingLogo = undefined;
        sink(`${prefix}${present(profile, presentation, text, firstReport, options?.doctorSeverity)}`);
        if (text.trim().length > 0) firstReport = false;
      };
    },
  };
}

function present(profile: TerminalProfile, presentation: Presentation, text: string, first: boolean, doctorSeverity: DoctorSeverityOf | undefined): string {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return text;
  if (text.startsWith('Usage:') || /\nUsage: /.test(text)) return presentHelp(profile, text);
  if (presentation === 'doctor' && /^[A-Za-z][\w.-]*(?: [\w.-]+){0,2}: /m.test(text)) return presentDoctor(profile, text, doctorSeverity);
  return presentReport(profile, text, first);
}

/** The option that turns styling off; main() removes it before any command parses argv. */
export const NO_COLOR_FLAG = '--no-color';

/**
 * How main() styles a command's output, or null for never: --json, the MCP server's internal
 * entry and the hook are machine paths. The logo leads --help, --version, install and doctor.
 */
export function styleFor(argv: readonly string[]): { readonly presentation: Presentation; readonly logoFirst: boolean } | null {
  if (argv.includes('--json')) return null;
  const first = argv[0];
  if (first !== undefined && first.startsWith('__')) return null;
  if (first === '--help' || first === '-h') return { presentation: 'auto', logoFirst: true };
  if (first === 'doctor') return { presentation: 'doctor', logoFirst: !argv.includes('--help') && !argv.includes('-h') };
  if (first === 'install') return { presentation: 'auto', logoFirst: !argv.includes('--help') && !argv.includes('-h') };
  return { presentation: 'auto', logoFirst: false };
}

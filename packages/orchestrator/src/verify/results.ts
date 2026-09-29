/**
 * Structured test results from runner output (VER-01, SSOT §9.4 "generate the test result from
 * the runner's structured receipt, not from the selected text").
 *
 * Supported: TAP (including node:test's TAP reporter), node:test's spec reporter summary, and
 * JUnit XML. A parser returns null when the text does not contain its format; the receipt then
 * records outcome `unknown` instead of guessing.
 */

export type ResultFormat = 'tap' | 'junit' | 'node-spec' | 'auto' | 'exit-code';

export interface TestFailure {
  readonly id: string;
  readonly name: string;
  readonly message: string | null;
}

export interface StructuredResults {
  readonly format: 'tap' | 'junit' | 'node-spec';
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly failures: readonly TestFailure[];
}

const MAX_FAILURES = 200;
const MAX_NAME = 300;

function clip(text: string, max = MAX_NAME): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function failureId(name: string, index: number): string {
  const slug = name
    .replace(/[^A-Za-z0-9_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return /^[A-Za-z]/.test(slug) ? slug : `t${String(index)}-${slug}`.slice(0, 120);
}

function summaryNumber(text: string, pattern: RegExp): number | undefined {
  let found: number | undefined;
  for (const match of text.matchAll(pattern)) {
    const value = Number(match[1]);
    if (Number.isInteger(value)) found = value;
  }
  return found;
}

export function parseTap(text: string): StructuredResults | null {
  const lines = text.split(/\r?\n/);
  let ok = 0;
  let notOk = 0;
  let skipped = 0;
  let sawPlan = false;
  const failures: TestFailure[] = [];
  for (const raw of lines) {
    const line = raw.trimStart();
    if (/^TAP version \d+/.test(line) || /^1\.\.\d+/.test(line)) sawPlan = true;
    const m = /^(not ok|ok)\s+(\d+)(?:\s+-)?\s*(.*)$/.exec(line);
    if (m === null) continue;
    const indent = raw.length - line.length;
    const directive = /#\s*(skip|todo)\b/i.test(m[3] ?? '');
    const name = clip((m[3] ?? '').replace(/\s*#\s*(skip|todo)\b.*$/i, ''));
    // Only leaf-level counting: top-level lines in node:test TAP also report suites; the
    // `# tests` summary, when present, wins below.
    if (directive) {
      skipped += 1;
      continue;
    }
    if (m[1] === 'ok') ok += 1;
    else {
      notOk += 1;
      if (failures.length < MAX_FAILURES) failures.push({ id: failureId(name, failures.length), name, message: indent > 0 ? 'subtest' : null });
    }
  }
  if (!sawPlan && ok + notOk + skipped === 0) return null;
  const tests = summaryNumber(text, /^# tests (\d+)/gm);
  const pass = summaryNumber(text, /^# pass (\d+)/gm);
  const fail = summaryNumber(text, /^# fail (\d+)/gm);
  const skip = (summaryNumber(text, /^# skipped (\d+)/gm) ?? 0) + (summaryNumber(text, /^# todo (\d+)/gm) ?? 0);
  if (tests !== undefined && pass !== undefined && fail !== undefined) {
    return { format: 'tap', total: tests, passed: pass, failed: fail, skipped: skip, failures };
  }
  return { format: 'tap', total: ok + notOk + skipped, passed: ok, failed: notOk, skipped, failures };
}

export function parseNodeSpec(text: string): StructuredResults | null {
  const tests = summaryNumber(text, /^[ \t]*ℹ tests (\d+)/gm);
  const pass = summaryNumber(text, /^[ \t]*ℹ pass (\d+)/gm);
  const fail = summaryNumber(text, /^[ \t]*ℹ fail (\d+)/gm);
  if (tests === undefined || pass === undefined || fail === undefined) return null;
  const skipped = (summaryNumber(text, /^[ \t]*ℹ skipped (\d+)/gm) ?? 0) + (summaryNumber(text, /^[ \t]*ℹ todo (\d+)/gm) ?? 0);
  const failures: TestFailure[] = [];
  const seen = new Set<string>();
  // The spec reporter lists failing tests again under "✖ failing tests:"; keep unique names.
  for (const match of text.matchAll(/^[ \t]*✖ (.+?)(?: \(\d+(?:\.\d+)?m?s\))?\s*$/gm)) {
    const name = clip(match[1] ?? '');
    if (name === 'failing tests:' || seen.has(name)) continue;
    seen.add(name);
    if (failures.length < MAX_FAILURES) failures.push({ id: failureId(name, failures.length), name, message: null });
  }
  return { format: 'node-spec', total: tests, passed: pass, failed: fail, skipped, failures };
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag) ?? new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`).exec(tag);
  return m?.[1];
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function isWordCode(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

/**
 * Each `<testcase …>` element: its attributes and body. Index scans, linear in the text (P6: the
 * earlier lazy regex rescanned to the end for every unclosed case). The same matches as
 * `/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g`.
 */
function testCases(text: string): { readonly tag: string; readonly body: string }[] {
  const out: { tag: string; body: string }[] = [];
  const OPEN = '<testcase';
  const CLOSE = '</testcase>';
  let noCloseAfter = Number.POSITIVE_INFINITY;
  let at = 0;
  for (;;) {
    const open = text.indexOf(OPEN, at);
    if (open === -1) break;
    at = open + 1;
    const next = open + OPEN.length;
    if (next < text.length && isWordCode(text.charCodeAt(next))) continue;
    const gt = text.indexOf('>', next);
    if (gt === -1) break;
    if (text.charCodeAt(gt - 1) === 47 && gt - 1 >= next) {
      out.push({ tag: text.slice(next, gt - 1), body: '' });
      at = gt + 1;
      continue;
    }
    // Once no closing tag follows some point, none follows any later point either.
    const end = gt + 1 >= noCloseAfter ? -1 : text.indexOf(CLOSE, gt + 1);
    if (end === -1) {
      noCloseAfter = Math.min(noCloseAfter, gt + 1);
      continue;
    }
    out.push({ tag: text.slice(next, gt), body: text.slice(gt + 1, end) });
    at = end + CLOSE.length;
  }
  return out;
}

export function parseJUnit(text: string): StructuredResults | null {
  if (!/<testsuites?\b|<testcase\b/.test(text)) return null;
  let total = 0;
  let failed = 0;
  let skipped = 0;
  const failures: TestFailure[] = [];
  for (const { tag, body } of testCases(text)) {
    total += 1;
    const name = clip(unescapeXml(`${attr(tag, 'classname') ?? ''}${attr(tag, 'classname') ? '.' : ''}${attr(tag, 'name') ?? 'unnamed'}`));
    if (/<skipped\b/.test(body)) {
      skipped += 1;
      continue;
    }
    const fail = /<(failure|error)\b([^>]*)/.exec(body);
    if (fail !== null) {
      failed += 1;
      const message = attr(fail[2] ?? '', 'message');
      if (failures.length < MAX_FAILURES) {
        failures.push({ id: failureId(name, failures.length), name, message: message === undefined ? null : clip(unescapeXml(message)) });
      }
    }
  }
  if (total === 0) {
    const suite = /<testsuites?\b([^>]*)>/.exec(text);
    if (suite === null) return null;
    const tests = Number(attr(suite[1] ?? '', 'tests') ?? 'NaN');
    const failuresN = Number(attr(suite[1] ?? '', 'failures') ?? '0') + Number(attr(suite[1] ?? '', 'errors') ?? '0');
    const skip = Number(attr(suite[1] ?? '', 'skipped') ?? '0');
    if (!Number.isInteger(tests)) return null;
    return { format: 'junit', total: tests, passed: tests - failuresN - skip, failed: failuresN, skipped: skip, failures: [] };
  }
  return { format: 'junit', total, passed: total - failed - skipped, failed, skipped, failures };
}

export function parseResults(format: ResultFormat, stdout: string, fileText: string | null): StructuredResults | null {
  switch (format) {
    case 'exit-code':
      return null;
    case 'tap':
      return parseTap(stdout);
    case 'node-spec':
      return parseNodeSpec(stdout);
    case 'junit':
      return fileText === null ? parseJUnit(stdout) : parseJUnit(fileText);
    case 'auto':
      return (fileText === null ? null : parseJUnit(fileText)) ?? parseNodeSpec(stdout) ?? parseTap(stdout) ?? parseJUnit(stdout);
  }
}

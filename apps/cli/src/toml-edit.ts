/**
 * Table-aware TOML editing for Codex `config.toml`.
 *
 * The scanner splits a document into statements (table headers, key/value pairs, and
 * comment or blank lines) while tracking basic, literal and multi-line strings and
 * multi-line arrays, so a line inside a value that starts with `[` is never taken as a
 * header. Only whole statements are removed; the rest of the file keeps its bytes.
 */

export interface TomlStatement {
  readonly kind: 'header' | 'keyval' | 'other';
  readonly start: number;
  readonly end: number;
  readonly path: readonly string[];
  readonly comment: boolean;
}

export interface TomlSplice {
  readonly at: number;
  readonly text: string;
}

class ScanError extends Error {}

const BARE = /[A-Za-z0-9_-]/;

function readKey(text: string, pos: number, stop: string): { path: string[]; pos: number } {
  const path: string[] = [];
  let i = pos;
  for (;;) {
    while (text[i] === ' ' || text[i] === '\t') i += 1;
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (text[j] !== '"') {
        if (text[j] === undefined || text[j] === '\n') throw new ScanError('key');
        j += text[j] === '\\' ? 2 : 1;
      }
      try {
        path.push(JSON.parse(text.slice(i, j + 1)) as string);
      } catch {
        throw new ScanError('key');
      }
      i = j + 1;
    } else if (ch === "'") {
      const j = text.indexOf("'", i + 1);
      if (j === -1 || text.slice(i + 1, j).includes('\n')) throw new ScanError('key');
      path.push(text.slice(i + 1, j));
      i = j + 1;
    } else {
      let j = i;
      while (j < text.length && BARE.test(text[j] ?? '')) j += 1;
      if (j === i) throw new ScanError('key');
      path.push(text.slice(i, j));
      i = j;
    }
    while (text[i] === ' ' || text[i] === '\t') i += 1;
    if (text[i] === '.') {
      i += 1;
      continue;
    }
    if (text.startsWith(stop, i)) return { path, pos: i + stop.length };
    throw new ScanError('key');
  }
}

function lineEnd(text: string, pos: number): number {
  const nl = text.indexOf('\n', pos);
  return nl === -1 ? text.length : nl + 1;
}

/** Scans a value starting at `pos` and returns the offset just after its statement's newline. */
function skipValue(text: string, pos: number): number {
  let i = pos;
  let depth = 0;
  for (;;) {
    const ch = text[i];
    if (ch === undefined) {
      if (depth !== 0) throw new ScanError('value');
      return text.length;
    }
    if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
      const quote = text.slice(i, i + 3);
      let j = i + 3;
      for (;;) {
        const close = text.indexOf(quote, j);
        if (close === -1) throw new ScanError('string');
        if (quote === '"""') {
          let slashes = 0;
          let k = close - 1;
          while (text[k] === '\\') {
            slashes += 1;
            k -= 1;
          }
          if (slashes % 2 === 1) {
            j = close + 1;
            continue;
          }
        }
        i = close + 3;
        while (text[i] === quote[0]) i += 1;
        break;
      }
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (text[j] !== '"') {
        if (text[j] === undefined || text[j] === '\n') throw new ScanError('string');
        j += text[j] === '\\' ? 2 : 1;
      }
      i = j + 1;
      continue;
    }
    if (ch === "'") {
      const j = text.indexOf("'", i + 1);
      if (j === -1 || text.slice(i + 1, j).includes('\n')) throw new ScanError('string');
      i = j + 1;
      continue;
    }
    if (ch === '#') {
      i = text.indexOf('\n', i);
      if (i === -1) i = text.length;
      continue;
    }
    if (ch === '[' || ch === '{') depth += 1;
    if (ch === ']' || ch === '}') {
      depth -= 1;
      if (depth < 0) throw new ScanError('bracket');
    }
    if (ch === '\n' && depth === 0) return i + 1;
    i += 1;
  }
}

export function scanToml(text: string): TomlStatement[] | null {
  const out: TomlStatement[] = [];
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  try {
    while (pos < text.length) {
      const start = pos;
      let i = pos;
      while (text[i] === ' ' || text[i] === '\t') i += 1;
      const ch = text[i];
      if (ch === undefined || ch === '\n' || ch === '\r' || ch === '#') {
        pos = lineEnd(text, i);
        out.push({ kind: 'other', start, end: pos, path: [], comment: ch === '#' });
        continue;
      }
      if (ch === '[') {
        const array = text[i + 1] === '[';
        const key = readKey(text, i + (array ? 2 : 1), array ? ']]' : ']');
        const rest = text.slice(key.pos, lineEnd(text, key.pos)).trim();
        if (rest.length > 0 && !rest.startsWith('#')) throw new ScanError('header');
        pos = lineEnd(text, key.pos);
        out.push({ kind: 'header', start, end: pos, path: key.path, comment: false });
        continue;
      }
      const key = readKey(text, i, '=');
      pos = skipValue(text, key.pos);
      out.push({ kind: 'keyval', start, end: pos, path: key.path, comment: false });
    }
  } catch {
    return null;
  }
  return out;
}

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  if (path.length < prefix.length) return false;
  return prefix.every((part, index) => path[index] === part);
}

/**
 * Removes every table whose header path starts with `prefix` (with all sub-tables and
 * array tables), and every key/value whose full dotted path starts with `prefix`
 * (inline tables and dotted keys under a parent table). Comment lines that directly
 * precede the next surviving header stay. Returns null when the file does not scan.
 */
export function removeTomlTables(text: string, prefix: readonly string[]): string | null {
  const statements = scanToml(text);
  if (statements === null) return null;
  const ranges: Array<[number, number]> = [];
  let table: readonly string[] = [];
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    if (statement === undefined) continue;
    if (statement.kind === 'header') {
      table = statement.path;
      if (!startsWith(statement.path, prefix)) continue;
      let next = index + 1;
      while (next < statements.length && statements[next]?.kind !== 'header') next += 1;
      let end = next < statements.length ? (statements[next]?.start ?? text.length) : text.length;
      if (next < statements.length) {
        let back = next - 1;
        let firstComment = -1;
        while (back > index && statements[back]?.kind === 'other') {
          if (statements[back]?.comment === true) firstComment = back;
          back -= 1;
        }
        if (firstComment !== -1) end = statements[firstComment]?.start ?? end;
      }
      ranges.push([statement.start, end]);
      index = next - 1;
      continue;
    }
    if (statement.kind === 'keyval' && startsWith([...table, ...statement.path], prefix)) {
      ranges.push([statement.start, statement.end]);
    }
  }
  let out = text;
  for (const [start, end] of ranges.reverse()) out = `${out.slice(0, start)}${out.slice(end)}`;
  if (out !== text && ranges.some(([, end]) => end === text.length)) {
    out = out.replace(/(\r?\n)(?:[ \t]*\r?\n)+$/, '$1');
  }
  return out;
}

export function hasTomlTable(text: string, prefix: readonly string[]): boolean {
  const statements = scanToml(text);
  if (statements === null) return false;
  let table: readonly string[] = [];
  for (const statement of statements) {
    if (statement.kind === 'header') {
      table = statement.path;
      if (startsWith(statement.path, prefix)) return true;
    } else if (statement.kind === 'keyval' && startsWith([...table, ...statement.path], prefix)) {
      return true;
    }
  }
  return false;
}

/** Appends `lines` as a new block at the end of the document, as one reversible splice. */
export function appendTomlBlock(text: string, lines: readonly string[]): { text: string; splice: TomlSplice } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const block = `${lines.join(eol)}${eol}`;
  let lead = '';
  if (text.length > 0) {
    if (!text.endsWith('\n')) lead = `${eol}${eol}`;
    else if (!/\n[ \t]*\r?\n$/.test(text)) lead = eol;
  }
  const insert = `${lead}${block}`;
  return { text: `${text}${insert}`, splice: { at: text.length, text: insert } };
}

/** A TOML basic string. JSON escapes are valid TOML escapes. */
export function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Minimal JSONC reader and editor for shared harness config files.
 *
 * - Parses JSON with comments and trailing commas into a tree with byte offsets.
 * - Inserts a property or an array item as one splice `{at, text}`, so the change is
 *   exactly reversible by removing that text again. Formatting (indent unit, line ending,
 *   compact or pretty layout) is taken from the file.
 * - Removes a property or an array item for the key-scoped path (the user edited the file
 *   after install). Comments outside the removed member are kept.
 *
 * It never re-serializes a whole document.
 */

export type JsonPath = readonly (string | number)[];

export interface JsoncNode {
  readonly type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  readonly offset: number;
  readonly end: number;
  readonly members?: readonly JsoncMember[];
  readonly items?: readonly JsoncNode[];
  readonly value?: string | number | boolean | null;
}

export interface JsoncMember {
  readonly key: string;
  readonly offset: number;
  readonly colon: number;
  readonly value: JsoncNode;
}

export interface Splice {
  readonly at: number;
  readonly text: string;
}

export interface Edited {
  readonly text: string;
  readonly splice: Splice;
}

const MAX_DEPTH = 64;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

class ParseError extends Error {}

class Parser {
  private pos = 0;
  constructor(private readonly text: string) {}

  parse(): JsoncNode {
    if (this.text.charCodeAt(0) === 0xfeff) this.pos = 1;
    this.skip();
    const node = this.value(0);
    this.skip();
    if (this.pos !== this.text.length) throw new ParseError('trailing');
    return node;
  }

  private skip(): void {
    const text = this.text;
    for (;;) {
      const ch = text[this.pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        this.pos += 1;
        continue;
      }
      if (ch === '/' && text[this.pos + 1] === '/') {
        const nl = text.indexOf('\n', this.pos + 2);
        this.pos = nl === -1 ? text.length : nl;
        continue;
      }
      if (ch === '/' && text[this.pos + 1] === '*') {
        const close = text.indexOf('*/', this.pos + 2);
        if (close === -1) throw new ParseError('comment');
        this.pos = close + 2;
        continue;
      }
      return;
    }
  }

  private value(depth: number): JsoncNode {
    if (depth > MAX_DEPTH) throw new ParseError('depth');
    const ch = this.text[this.pos];
    if (ch === '{') return this.object(depth);
    if (ch === '[') return this.array(depth);
    if (ch === '"') {
      const start = this.pos;
      const value = this.string();
      return { type: 'string', offset: start, end: this.pos, value };
    }
    const start = this.pos;
    const rest = this.text.slice(start, start + 400);
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (number !== null && number[0].length > 0) {
      this.pos += number[0].length;
      return { type: 'number', offset: start, end: this.pos, value: Number(number[0]) };
    }
    for (const [word, value] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (this.text.startsWith(word, start)) {
        this.pos += word.length;
        return { type: value === null ? 'null' : 'boolean', offset: start, end: this.pos, value };
      }
    }
    throw new ParseError('value');
  }

  private string(): string {
    const start = this.pos;
    let i = start + 1;
    const text = this.text;
    for (;;) {
      const ch = text[i];
      if (ch === undefined || ch === '\n') throw new ParseError('string');
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '"') break;
      i += 1;
    }
    this.pos = i + 1;
    try {
      const parsed: unknown = JSON.parse(text.slice(start, this.pos));
      if (typeof parsed !== 'string') throw new ParseError('string');
      return parsed;
    } catch {
      throw new ParseError('string');
    }
  }

  private object(depth: number): JsoncNode {
    const offset = this.pos;
    this.pos += 1;
    const members: JsoncMember[] = [];
    const seen = new Set<string>();
    this.skip();
    while (this.text[this.pos] !== '}') {
      if (this.text[this.pos] !== '"') throw new ParseError('key');
      const keyOffset = this.pos;
      const key = this.string();
      if (DANGEROUS_KEYS.has(key) || seen.has(key)) throw new ParseError('key');
      seen.add(key);
      this.skip();
      if (this.text[this.pos] !== ':') throw new ParseError('colon');
      const colon = this.pos;
      this.pos += 1;
      this.skip();
      const value = this.value(depth + 1);
      members.push({ key, offset: keyOffset, colon, value });
      this.skip();
      if (this.text[this.pos] === ',') {
        this.pos += 1;
        this.skip();
        continue;
      }
      if (this.text[this.pos] !== '}') throw new ParseError('object');
    }
    this.pos += 1;
    return { type: 'object', offset, end: this.pos, members };
  }

  private array(depth: number): JsoncNode {
    const offset = this.pos;
    this.pos += 1;
    const items: JsoncNode[] = [];
    this.skip();
    while (this.text[this.pos] !== ']') {
      items.push(this.value(depth + 1));
      this.skip();
      if (this.text[this.pos] === ',') {
        this.pos += 1;
        this.skip();
        continue;
      }
      if (this.text[this.pos] !== ']') throw new ParseError('array');
    }
    this.pos += 1;
    return { type: 'array', offset, end: this.pos, items };
  }
}

export function parseJsoncTree(text: string): JsoncNode | null {
  try {
    return new Parser(text).parse();
  } catch {
    return null;
  }
}

export function nodeValue(node: JsoncNode): unknown {
  if (node.type === 'object') {
    const out: Record<string, unknown> = {};
    for (const member of node.members ?? []) out[member.key] = nodeValue(member.value);
    return out;
  }
  if (node.type === 'array') return (node.items ?? []).map(nodeValue);
  return node.value;
}

/** Parses JSONC. Returns undefined on a syntax error, a duplicate key or a dangerous key. */
export function parseJsonc(text: string): unknown {
  const tree = parseJsoncTree(text);
  return tree === null ? undefined : nodeValue(tree);
}

export function findNode(root: JsoncNode, path: JsonPath): JsoncNode | undefined {
  let node: JsoncNode | undefined = root;
  for (const part of path) {
    if (node === undefined) return undefined;
    if (typeof part === 'number') {
      node = node.type === 'array' ? node.items?.[part] : undefined;
    } else {
      node = node.type === 'object' ? node.members?.find((member) => member.key === part)?.value : undefined;
    }
  }
  return node;
}

function eolOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function lineStart(text: string, offset: number): number {
  return text.lastIndexOf('\n', offset - 1) + 1;
}

function indentAt(text: string, offset: number): string {
  const start = lineStart(text, offset);
  const match = /^[ \t]*/.exec(text.slice(start, offset));
  return match === null ? '' : match[0];
}

export function indentUnit(text: string): string {
  let min = 0;
  for (const line of text.split('\n')) {
    const match = /^([ \t]+)\S/.exec(line);
    if (match === null || match[1] === undefined) continue;
    if (match[1].startsWith('\t')) return '\t';
    const width = match[1].length;
    if (min === 0 || width < min) min = width;
  }
  return min === 0 ? '  ' : ' '.repeat(Math.min(min, 8));
}

function serialize(value: unknown, unit: string, base: string, eol: string): string {
  return JSON.stringify(value, null, unit).split('\n').join(`${eol}${base}`);
}

function multiline(text: string, node: JsoncNode): boolean {
  return text.slice(node.offset, node.end).includes('\n');
}

function colonSpacing(text: string, member: JsoncMember): string {
  return text.slice(member.colon + 1, member.value.offset).includes(' ') ? ' ' : '';
}

function wrap(path: readonly (string | number)[], value: unknown): unknown {
  let out = value;
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const part = path[i];
    if (typeof part !== 'string') return undefined;
    out = { [part]: out };
  }
  return out;
}

/** The text inserted into `container` for a new entry; `entry` is `"key": value` or `value`. */
function insertInto(
  text: string,
  container: JsoncNode,
  render: (base: string, inline: boolean) => string,
  inlineSpace: string,
): Edited {
  const eol = eolOf(text);
  const unit = indentUnit(text);
  const children: readonly { offset: number; end: number }[] =
    container.type === 'object'
      ? (container.members ?? []).map((member) => ({ offset: member.offset, end: member.value.end }))
      : (container.items ?? []);
  const last = children[children.length - 1];
  if (last === undefined) {
    const inner = text.slice(container.offset + 1, container.end - 1);
    const outer = indentAt(text, container.offset);
    const base = `${outer}${unit}`;
    const body = `${eol}${base}${render(base, false)}`;
    const insert = inner.includes('\n') ? body : `${body}${eol}${outer}`;
    const at = container.offset + 1;
    return { text: `${text.slice(0, at)}${insert}${text.slice(at)}`, splice: { at, text: insert } };
  }
  if (!multiline(text, container)) {
    const first = children[0];
    const second = children[1];
    const space =
      first !== undefined && second !== undefined
        ? /,[ \t]/.test(text.slice(first.end, second.offset))
          ? ' '
          : ''
        : inlineSpace;
    const insert = `,${space}${render('', true)}`;
    const at = last.end;
    return { text: `${text.slice(0, at)}${insert}${text.slice(at)}`, splice: { at, text: insert } };
  }
  const base = indentAt(text, last.offset);
  const insert = `,${eol}${base}${render(base, false)}`;
  const at = last.end;
  return { text: `${text.slice(0, at)}${insert}${text.slice(at)}`, splice: { at, text: insert } };
}

/**
 * Adds `value` at `path`. The deepest existing ancestor must be an object; missing
 * intermediate objects are created in the same splice. Refuses (null) when the key
 * already exists, when an ancestor is not an object, or when the file does not parse.
 */
export function insertProperty(text: string, path: readonly string[], value: unknown): Edited | null {
  const root = parseJsoncTree(text);
  if (root === null || root.type !== 'object' || path.length === 0) return null;
  let node: JsoncNode = root;
  let depth = 0;
  for (; depth < path.length; depth += 1) {
    const key = path[depth];
    const found: JsoncMember | undefined = node.members?.find((member) => member.key === key);
    if (found === undefined) break;
    if (depth === path.length - 1) return null;
    if (found.value.type !== 'object') return null;
    node = found.value;
  }
  const key = path[depth];
  if (key === undefined) return null;
  const nested = wrap(path.slice(depth + 1), value);
  if (nested === undefined) return null;
  const eol = eolOf(text);
  const unit = indentUnit(text);
  const sample = node.members?.[0] ?? root.members?.[0];
  const space = sample === undefined ? ' ' : colonSpacing(text, sample);
  return insertInto(
    text,
    node,
    (base, inline) =>
      inline
        ? `${JSON.stringify(key)}:${space}${JSON.stringify(nested)}`
        : `${JSON.stringify(key)}:${space || ' '}${serialize(nested, unit, base, eol)}`,
    space,
  );
}

/** Appends `value` to the array at `path`. Refuses when the node is missing or not an array. */
export function appendItem(text: string, path: JsonPath, value: unknown): Edited | null {
  const root = parseJsoncTree(text);
  if (root === null) return null;
  const node = findNode(root, path);
  if (node === undefined || node.type !== 'array') return null;
  const eol = eolOf(text);
  const unit = indentUnit(text);
  return insertInto(
    text,
    node,
    (base, inline) => (inline ? JSON.stringify(value) : serialize(value, unit, base, eol)),
    '',
  );
}

/** Undoes splices (applied in order) from the edited text. Returns null when a splice does not match. */
export function undoSplices(text: string, splices: readonly Splice[]): string | null {
  let current = text;
  for (let i = splices.length - 1; i >= 0; i -= 1) {
    const splice = splices[i];
    if (splice === undefined) return null;
    if (current.slice(splice.at, splice.at + splice.text.length) !== splice.text) return null;
    current = `${current.slice(0, splice.at)}${current.slice(splice.at + splice.text.length)}`;
  }
  return current;
}

function nextSignificant(text: string, from: number): number {
  let i = from;
  for (;;) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i + 2);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? text.length : close + 2;
      continue;
    }
    return i;
  }
}

function spanStart(text: string, offset: number): number {
  const start = lineStart(text, offset);
  if (!/^[ \t]*$/.test(text.slice(start, offset)) || start === 0) return offset;
  const newline = start - 1;
  return text[newline - 1] === '\r' ? newline - 1 : newline;
}

function removeChild(
  text: string,
  children: readonly { offset: number; end: number }[],
  index: number,
): string {
  const child = children[index];
  if (child === undefined) return text;
  const after = nextSignificant(text, child.end);
  const ownComma = text[after] === ',' ? after : -1;
  const hasNext = index + 1 < children.length;
  if (ownComma !== -1 && (hasNext || index === 0)) {
    const start = spanStart(text, child.offset);
    return `${text.slice(0, start)}${text.slice(ownComma + 1)}`;
  }
  if (index > 0) {
    const prev = children[index - 1];
    if (prev === undefined) return text;
    const prevComma = nextSignificant(text, prev.end);
    if (text[prevComma] !== ',') return text;
    const start = spanStart(text, child.offset);
    const end = ownComma !== -1 ? ownComma + 1 : child.end;
    const middle = text.slice(prevComma + 1, start);
    return `${text.slice(0, prevComma)}${middle}${text.slice(end)}`;
  }
  const start = spanStart(text, child.offset);
  const end = ownComma !== -1 ? ownComma + 1 : child.end;
  return `${text.slice(0, start)}${text.slice(end)}`;
}

/** Removes the property or array item at `path`. Returns the text unchanged when absent, null on a parse error. */
export function removePath(text: string, path: JsonPath): string | null {
  const root = parseJsoncTree(text);
  if (root === null) return null;
  if (path.length === 0) return null;
  const parent = findNode(root, path.slice(0, -1));
  const last = path[path.length - 1];
  if (parent === undefined) return text;
  if (parent.type === 'object' && typeof last === 'string') {
    const members = parent.members ?? [];
    const index = members.findIndex((member) => member.key === last);
    if (index === -1) return text;
    return removeChild(
      text,
      members.map((member) => ({ offset: member.offset, end: member.value.end })),
      index,
    );
  }
  if (parent.type === 'array' && typeof last === 'number') {
    const items = parent.items ?? [];
    if (last < 0 || last >= items.length) return text;
    return removeChild(text, items, last);
  }
  return text;
}

/** RFC 6901 JSON pointer for receipts. */
export function toPointer(path: JsonPath): string {
  return path.map((part) => `/${String(part).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
}

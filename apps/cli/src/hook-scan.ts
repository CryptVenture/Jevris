import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

const BYTE_CAP = 131072;
const PLUGIN_NAME = 'jevris';

export interface ScanResult {
  readonly accepted: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function hasDangerousKey(value: object): boolean {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || key === '__proto__' || key === 'prototype' || key === 'constructor') {
      return true;
    }
  }
  return false;
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  const Ctor = (globalThis as unknown as {
    TextDecoder?: new (label: string, options: { fatal: boolean }) => { decode(input?: Uint8Array): string };
  }).TextDecoder;
  if (Ctor === undefined) return undefined;
  try {
    return new Ctor('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Programs a Jevris hook never runs: shells, inline interpreters and package runners. */
const REFUSED_PROGRAMS = new Set(['bash', 'sh', 'zsh', 'dash', 'fish', 'ksh', 'csh', 'tcsh', 'cmd', 'powershell', 'pwsh', 'jq', 'npx', 'npm', 'pnpm', 'yarn', 'bunx', 'env', 'eval', 'curl', 'wget']);
/** Interpreter flags that would run inline code instead of a file. */
const INLINE_FLAGS = new Set(['-c', '-e', '--eval', '-p', '--print', '-i', '--interactive', '/c', '/k']);

/** The file name of a program path, lower-cased, without a Windows executable extension. */
export function programName(command: string): string {
  const base = command.split(/[\\/]/).pop() ?? command;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
}

/**
 * One exec-form argument or program path (ADM-07). A path may contain `bash`, `sh` or `jq`
 * anywhere (`/Users/shelly/jq-tools/hook.mjs` is fine); what is refused is shell syntax:
 * pipes, separators, substitution, redirection and line breaks.
 */
export function unsafeText(text: string): boolean {
  if (text.length === 0 || text.length > 4096) return true;
  if (/[|;`<>\r\n\0]/.test(text)) return true;
  if (text.includes('$(') || text.includes('&&')) return true;
  return false;
}

export function validHandler(handler: Record<string, unknown>): boolean {
  if (handler.type !== 'command') return false;
  const command = handler.command;
  if (typeof command !== 'string' || unsafeText(command)) return false;
  if (REFUSED_PROGRAMS.has(programName(command))) return false;
  const args = handler.args;
  if (!Array.isArray(args)) return false;
  for (const arg of args) {
    if (typeof arg !== 'string' || unsafeText(arg)) return false;
    if (INLINE_FLAGS.has(arg.toLowerCase())) return false;
  }
  const timeout = handler.timeout;
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0 || timeout > 30) return false;
  return true;
}

function walkValues(value: unknown, handlers: Record<string, unknown>[]): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!walkValues(item, handlers)) return false;
    }
    return true;
  }
  if (!isPlainObject(value) || hasDangerousKey(value)) return false;
  if (Object.hasOwn(value, 'type')) handlers.push(value);
  for (const key of Object.keys(value)) {
    if (!walkValues(value[key], handlers)) return false;
  }
  return true;
}

function insideRoot(rootReal: string, candidate: string): boolean {
  const rel = relative(rootReal, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function symlinksStayInside(dir: string, rootReal: string): Promise<boolean> {
  const names = await readdir(dir);
  for (const name of names) {
    const path = join(dir, name);
    const st = await lstat(path);
    if (st.isSymbolicLink()) {
      let real: string;
      try {
        real = await realpath(path);
      } catch {
        return false;
      }
      if (!insideRoot(rootReal, real)) return false;
      continue;
    }
    if (st.isDirectory()) {
      if (!(await symlinksStayInside(path, rootReal))) return false;
    }
  }
  return true;
}

async function readCapped(path: string): Promise<unknown | undefined> {
  const bytes = await readFile(path);
  if (bytes.byteLength > BYTE_CAP) return undefined;
  const text = decodeUtf8(bytes);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function scanHooks(source: string): Promise<ScanResult> {
  if (typeof source !== 'string' || source.length === 0) return { accepted: false };
  let sourceRoot: string;
  try {
    sourceRoot = await realpath(source);
    const rootStat = await lstat(sourceRoot);
    if (!rootStat.isDirectory()) return { accepted: false };
    if (!(await symlinksStayInside(sourceRoot, sourceRoot))) return { accepted: false };
  } catch {
    return { accepted: false };
  }

  const pluginPath = join(sourceRoot, '.claude-plugin', 'plugin.json');
  let plugin: unknown;
  try {
    plugin = await readCapped(pluginPath);
  } catch {
    return { accepted: false };
  }
  if (!isPlainObject(plugin) || hasDangerousKey(plugin) || plugin.name !== PLUGIN_NAME) {
    return { accepted: false };
  }

  const hooksPath = join(sourceRoot, 'hooks', 'hooks.json');
  let hooksStat;
  try {
    hooksStat = await lstat(hooksPath);
  } catch {
    return { accepted: true };
  }
  if (hooksStat.isSymbolicLink() || !hooksStat.isFile()) return { accepted: false };
  let hooks: unknown;
  try {
    hooks = await readCapped(hooksPath);
  } catch {
    return { accepted: false };
  }
  if (!isPlainObject(hooks) || hasDangerousKey(hooks)) return { accepted: false };
  const handlers: Record<string, unknown>[] = [];
  if (!walkValues(hooks, handlers)) return { accepted: false };
  for (const handler of handlers) {
    if (!validHandler(handler)) return { accepted: false };
  }
  return { accepted: true };
}

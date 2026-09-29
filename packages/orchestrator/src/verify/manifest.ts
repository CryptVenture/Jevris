/**
 * Check manifests (SSOT §10.5, §15.3): id, argv, cwd, timeout, env allowlist, mandatory or
 * optional, runner id, result format and input scopes. Commands are argument vectors from a
 * trusted manifest, never shell strings; the approval registry records which manifest hashes
 * the user approved through a trusted channel (the CLI), and the runner runs nothing else.
 */
import { isAbsoluteFor } from '@jevris/platform';
import { allowableName } from './environment.js';
import type { ResultFormat } from './results.js';
import { ID_PATTERN } from '@jevris/contracts';
import { hashOf, isId, isPlain, own, type Rec } from '../util.js';

const CHECK_ID = new RegExp(ID_PATTERN);

export const DEFAULT_TIMEOUT_MS = 600_000;
export const MAX_TIMEOUT_MS = 6 * 3_600_000;
const FORMATS: readonly ResultFormat[] = ['tap', 'junit', 'node-spec', 'auto', 'exit-code'];
const MANIFEST_KEYS = new Set([
  'id',
  'argv',
  'cwd',
  'timeoutMs',
  'env',
  'mandatory',
  'runnerId',
  'resultFormat',
  'resultFile',
  'inputScopes',
  'requirementIds',
  'description',
  'hardware',
]);
const CLAIM_KEYS = /pass|verified|jev|shell/i;
const SHELL_META = /[|;`$&<>\n\r]/;
const REL_PATH = /^(?![/\\])(?![A-Za-z]:)(?!.*(?:^|[/\\])\.\.(?:[/\\]|$))[^\0]{1,512}$/;

export interface CheckManifest {
  readonly id: string;
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly env: readonly string[];
  readonly mandatory: boolean;
  readonly runnerId: string;
  readonly resultFormat: ResultFormat;
  readonly resultFile: string | null;
  readonly inputScopes: readonly string[];
  readonly requirementIds: readonly string[];
  readonly description: string;
  /** A hardware requirement: the check runs only on a runner declaring it (C72, W12). */
  readonly hardware: string | null;
}

export type ManifestResult =
  | { readonly ok: true; readonly manifest: CheckManifest; readonly hash: string }
  | { readonly ok: false; readonly reason: string; readonly field: string };

function bad(field: string, reason: string): ManifestResult {
  return { ok: false, reason, field };
}

function strings(value: unknown, max: number, pattern?: RegExp): readonly string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > 512 || item.includes('\0')) return undefined;
    if (pattern !== undefined && !pattern.test(item)) return undefined;
    out.push(item);
  }
  return out;
}

/**
 * Validates one manifest. The command (argv[0]) is either absolute for the target platform or a
 * bare program name resolved on PATH (PATHEXT on Windows). A relative path with separators, a
 * shell metacharacter in the command, or any field that claims a pass or names a shell is refused.
 */
export function parseManifest(input: unknown, platform: string = process.platform): ManifestResult {
  if (!isPlain(input)) return bad('', 'not-an-object');
  for (const key of Object.keys(input)) {
    if (!MANIFEST_KEYS.has(key)) return bad(key, CLAIM_KEYS.test(key) ? 'claim-field' : 'unknown-field');
  }
  const id = own(input, 'id');
  // Check ids appear in surface payloads, so they follow the contracts' opaque-id shape (no ':').
  if (!isId(id) || !CHECK_ID.test(id)) return bad('id', 'invalid-id');
  const argvRaw = own(input, 'argv');
  if (!Array.isArray(argvRaw) || argvRaw.length === 0 || argvRaw.length > 64) return bad('argv', 'invalid-argv');
  const argv: string[] = [];
  for (const item of argvRaw) {
    if (typeof item !== 'string' || item.length === 0 || item.length > 4096 || item.includes('\0')) return bad('argv', 'invalid-argv');
    argv.push(item);
  }
  const command = argv[0] as string;
  if (SHELL_META.test(command)) return bad('argv', 'shell-metacharacter');
  const hasSep = command.includes('/') || command.includes('\\');
  if (hasSep && !isAbsoluteFor(command, platform)) return bad('argv', 'relative-command');
  if (!hasSep && !/^[A-Za-z0-9_.+-]{1,128}$/.test(command)) return bad('argv', 'invalid-program');
  const cwd = own(input, 'cwd') ?? '.';
  if (typeof cwd !== 'string' || !(cwd === '.' || REL_PATH.test(cwd))) return bad('cwd', 'cwd-outside-workspace');
  const timeout = own(input, 'timeoutMs') ?? DEFAULT_TIMEOUT_MS;
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1000 || timeout > MAX_TIMEOUT_MS) return bad('timeoutMs', 'invalid-timeout');
  const env = strings(own(input, 'env'), 64);
  if (env === undefined || env.some((name) => !allowableName(name))) return bad('env', 'env-refused');
  const mandatory = own(input, 'mandatory') ?? true;
  if (typeof mandatory !== 'boolean') return bad('mandatory', 'invalid-mandatory');
  const runnerId = own(input, 'runnerId') ?? 'local';
  if (!isId(runnerId)) return bad('runnerId', 'invalid-runner');
  const format = own(input, 'resultFormat') ?? 'auto';
  if (typeof format !== 'string' || !FORMATS.includes(format as ResultFormat)) return bad('resultFormat', 'invalid-format');
  const resultFile = own(input, 'resultFile') ?? null;
  if (resultFile !== null && (typeof resultFile !== 'string' || !REL_PATH.test(resultFile))) return bad('resultFile', 'invalid-result-file');
  const scopes = strings(own(input, 'inputScopes'), 256, REL_PATH);
  if (scopes === undefined) return bad('inputScopes', 'invalid-scopes');
  const requirements = strings(own(input, 'requirementIds'), 256);
  if (requirements === undefined || requirements.some((r) => !isId(r))) return bad('requirementIds', 'invalid-requirements');
  const description = own(input, 'description') ?? '';
  if (typeof description !== 'string' || description.length > 500) return bad('description', 'invalid-description');
  const hardware = own(input, 'hardware') ?? null;
  if (hardware !== null && !isId(hardware)) return bad('hardware', 'invalid-hardware');
  const manifest: CheckManifest = {
    id,
    argv: argv as unknown as readonly [string, ...string[]],
    cwd,
    timeoutMs: timeout,
    env,
    mandatory,
    runnerId,
    resultFormat: format as ResultFormat,
    resultFile: resultFile as string | null,
    inputScopes: scopes.map((s) => s.split('\\').join('/')),
    requirementIds: requirements,
    description,
    hardware: hardware as string | null,
  };
  return { ok: true, manifest, hash: manifestHash(manifest) };
}

export function manifestHash(manifest: CheckManifest): string {
  return hashOf({ ...manifest, description: undefined });
}

export interface ManifestSet {
  readonly checks: readonly CheckManifest[];
  readonly hashes: { readonly [checkId: string]: string };
}

/** A manifest file: `{ "schemaVersion": "jevris-checks-1", "checks": [ ... ] }`. */
export function parseManifestFile(input: unknown, platform: string = process.platform): { readonly ok: true; readonly set: ManifestSet } | { readonly ok: false; readonly reason: string } {
  if (!isPlain(input)) return { ok: false, reason: 'not-an-object' };
  if (own(input, 'schemaVersion') !== 'jevris-checks-1') return { ok: false, reason: 'schema-version' };
  const checks = own(input, 'checks');
  if (!Array.isArray(checks) || checks.length === 0 || checks.length > 256) return { ok: false, reason: 'no-checks' };
  const out: CheckManifest[] = [];
  const hashes: { [id: string]: string } = {};
  for (const raw of checks) {
    const parsed = parseManifest(raw, platform);
    if (!parsed.ok) return { ok: false, reason: `${parsed.field}:${parsed.reason}` };
    if (hashes[parsed.manifest.id] !== undefined) return { ok: false, reason: 'duplicate-check' };
    hashes[parsed.manifest.id] = parsed.hash;
    out.push(parsed.manifest);
  }
  return { ok: true, set: { checks: out, hashes } };
}

export function asRec(value: unknown): Rec | undefined {
  return isPlain(value) ? value : undefined;
}

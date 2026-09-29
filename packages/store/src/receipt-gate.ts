import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsoluteFor, planSpawn } from '@jevris/platform';
import { putReceipt, reviseSource } from './invalidate.js';
import type { MutationResult } from './invalidate.js';
import type { OpenStoreResult } from './open.js';

/**
 * A receipt is current only after a declared runner binds it.
 * The frame is not a command source and is not a pass.
 * A passed claim on the frame is refused before the declared command runs.
 */

const BYTE_CAP = 131_072;
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const PRODUCED = Symbol('runDeclaredCheck');
const DANGEROUS = new Set(['__proto__', 'prototype', 'constructor']);
const RECEIPT_FIELDS = new Set([
  'workspaceId',
  'receiptId',
  'sourceRevision',
  'evidenceId',
  'runnerId',
  'commandHash',
]);
const MANIFEST_FIELDS = new Set([
  'runnerId',
  'command',
  'args',
  'commandHash',
  'workspaceId',
  'receiptId',
  'sourceRevision',
  'evidenceId',
  'currentRevision',
]);

interface BoundReceipt {
  readonly workspaceId: string;
  readonly receiptId: string;
  readonly sourceRevision: string;
  readonly evidenceId: string;
  readonly runnerId: string;
  readonly commandHash: string;
  readonly [PRODUCED]: true;
}

function refusal(): MutationResult {
  return { ok: false, reason: 'refused' };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isPlain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function dangerous(value: object): boolean {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string' && DANGEROUS.has(key)) return true;
  }
  return false;
}

function own(value: object, key: string): unknown {
  if (!Object.hasOwn(value, key)) return undefined;
  return Reflect.get(value, key);
}

function extraField(value: object, allowed: ReadonlySet<string>): boolean {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return true;
  }
  return false;
}

function passedClaim(value: object): boolean {
  if (Object.hasOwn(value, 'passed')) return true;
  const validity = own(value, 'validity');
  const status = own(value, 'status');
  const claim = own(value, 'claim');
  return validity === 'passed' || status === 'passed' || claim === 'passed';
}

function textRefused(text: string): boolean {
  if (byteLength(text) > BYTE_CAP) return true;
  if (text.includes('__proto__') || text.includes('"prototype"') || text.includes('"constructor"')) return true;
  if (text.includes('"passed"')) return true;
  return false;
}

function parseCapped(input: unknown): Record<string, unknown> | undefined {
  if (typeof input === 'string') {
    if (textRefused(input)) return undefined;
    try {
      const parsed: unknown = JSON.parse(input);
      if (!isPlain(parsed) || dangerous(parsed)) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }
  if (input instanceof Uint8Array) {
    if (input.byteLength > BYTE_CAP) return undefined;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(input);
    return parseCapped(text);
  }
  if (!isPlain(input) || dangerous(input)) return undefined;
  return input;
}

function isBound(value: object): value is BoundReceipt {
  return Reflect.get(value, PRODUCED) === true;
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isKey(value: unknown): value is string {
  return typeof value === 'string' && KEY_PATTERN.test(value);
}

export function invalidateForRevision(
  store: OpenStoreResult,
  previousRevision: unknown,
  nextRevision: unknown,
): MutationResult {
  return reviseSource(store, previousRevision, nextRevision);
}

export function acceptRunnerReceipt(
  store: OpenStoreResult,
  input: unknown,
  currentRevision: unknown,
): MutationResult {
  const parsed = parseCapped(input);
  if (parsed === undefined) return refusal();
  if (extraField(parsed, RECEIPT_FIELDS) || passedClaim(parsed)) return refusal();
  const runnerId = own(parsed, 'runnerId');
  const commandHash = own(parsed, 'commandHash');
  const sourceRevision = own(parsed, 'sourceRevision');
  if (typeof runnerId !== 'string' || runnerId.length === 0) return refusal();
  if (typeof commandHash !== 'string' || commandHash.length === 0) return refusal();
  if (!isKey(sourceRevision) || sourceRevision !== currentRevision) return refusal();
  if (!isBound(parsed)) return refusal();
  if (!isId(runnerId) || !HASH_PATTERN.test(commandHash)) return refusal();
  const workspaceId = own(parsed, 'workspaceId');
  const receiptId = own(parsed, 'receiptId');
  const evidenceId = own(parsed, 'evidenceId');
  if (!isId(workspaceId) || !isId(receiptId) || !isId(evidenceId)) return refusal();
  return putReceipt(store, {
    workspaceId,
    receiptId,
    sourceRevision,
    evidenceId,
  });
}

function readArgs(value: unknown): readonly string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) return undefined;
  const argv: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length > 4_096 || item.includes('\0')) return undefined;
    argv.push(item);
  }
  return argv;
}

function shellMetacharacter(command: string): boolean {
  // Parentheses are legal in C:\Program Files (x86); with no shell they are inert, and a
  // .cmd shim is caret-escaped by the spawn helper (BLD-06, BLD-07).
  return /[|;`$&<>\n\r]/.test(command);
}

export interface DeclaredCheckOptions {
  /** The platform whose absolute-path rule applies. Default: this process. */
  readonly platform?: string;
  /**
   * How long the declared command may run before it is stopped and refused, in ms. Default
   * 2,000. A caller whose host is loaded (a test suite beside others) may allow longer; a
   * command stopped by this bound is never accepted.
   */
  readonly timeoutMs?: number;
}

const DECLARED_CHECK_TIMEOUT_MS = 2_000;

export function runDeclaredCheck(
  store: OpenStoreResult,
  manifest: unknown,
  frame?: unknown,
  options: DeclaredCheckOptions = {},
): MutationResult {
  if (!isPlain(manifest) || dangerous(manifest) || extraField(manifest, MANIFEST_FIELDS)) return refusal();
  if (passedClaim(manifest)) return refusal();
  const command = own(manifest, 'command');
  const commandHash = own(manifest, 'commandHash');
  const runnerId = own(manifest, 'runnerId');
  const workspaceId = own(manifest, 'workspaceId');
  const receiptId = own(manifest, 'receiptId');
  const sourceRevision = own(manifest, 'sourceRevision');
  const evidenceId = own(manifest, 'evidenceId');
  const currentRevision = own(manifest, 'currentRevision');
  if (typeof command !== 'string' || !isAbsoluteFor(command, options.platform) || command.includes('\0')) return refusal();
  if (shellMetacharacter(command)) return refusal();
  if (typeof commandHash !== 'string' || commandHash !== sha256(command)) return refusal();
  if (!isId(runnerId) || !isId(workspaceId) || !isId(receiptId) || !isId(evidenceId)) return refusal();
  if (!isKey(sourceRevision) || !isKey(currentRevision) || sourceRevision !== currentRevision) return refusal();
  const argv = readArgs(own(manifest, 'args'));
  if (argv === undefined) return refusal();
  if (isPlain(frame) && passedClaim(frame)) return refusal();
  // PATHEXT and .cmd/.bat shims through cmd.exe with strict escaping; .exe directly (BLD-06).
  const plan = planSpawn(command, argv, options.platform === undefined ? {} : { platform: options.platform });
  if (!plan.ok) return refusal();
  const ran = spawnSync(plan.command, [...plan.args], {
    shell: false,
    timeout: options.timeoutMs !== undefined && Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DECLARED_CHECK_TIMEOUT_MS,
    stdio: 'ignore',
    env: {},
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
  });
  if (ran.status !== 0) return refusal();
  const binding: BoundReceipt = {
    workspaceId,
    receiptId,
    sourceRevision,
    evidenceId,
    runnerId,
    commandHash,
    [PRODUCED]: true,
  };
  return acceptRunnerReceipt(store, binding, currentRevision);
}

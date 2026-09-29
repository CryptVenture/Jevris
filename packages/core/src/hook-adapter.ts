import { MAX_REQUEST_BYTES } from '@jevris/contracts';
import type { HookResult } from '@jevris/contracts';
import { recordObservation } from './observe.js';

/**
 * Requested-switch check. The record is the only advice.
 * Every return is exit code 0 and empty stdout. This module does not start a switch.
 * Caller clocks are compared to the budget below. No stored advice is opened on a miss.
 */

export const HOOK_BUDGET_MS = 900;

function noDecision(): HookResult {
  return { exitCode: 0, stdout: '' };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function own(value: object, key: string): unknown {
  if (!Object.hasOwn(value, key)) return undefined;
  return Reflect.get(value, key);
}

function encodeUtf8(text: string): Uint8Array {
  const Ctor = (globalThis as unknown as {
    TextEncoder?: new () => { encode(input?: string): Uint8Array };
  }).TextEncoder;
  if (Ctor === undefined) return new Uint8Array();
  return new Ctor().encode(text);
}

function decodeUtf8Fatal(bytes: Uint8Array): string | undefined {
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

export function hookDeadlineMissed(nowMs: unknown, startedAtMs: unknown): boolean {
  if (typeof nowMs !== 'number' || typeof startedAtMs !== 'number') return true;
  if (!Number.isFinite(nowMs) || !Number.isFinite(startedAtMs)) return true;
  if (startedAtMs > nowMs) return true;
  return nowMs - startedAtMs >= HOOK_BUDGET_MS;
}

function stdinWithinCap(stdin: unknown): string | undefined {
  if (typeof stdin === 'string') {
    if (encodeUtf8(stdin).byteLength > MAX_REQUEST_BYTES) return undefined;
    return stdin;
  }
  if (stdin instanceof Uint8Array) {
    if (stdin.byteLength > MAX_REQUEST_BYTES) return undefined;
    return decodeUtf8Fatal(stdin);
  }
  return undefined;
}

export async function handleHookEvent(input: object): Promise<HookResult> {
  if (!isPlainObject(input)) return noDecision();
  if (own(input, 'launcher') !== 'present') return noDecision();
  if (hookDeadlineMissed(own(input, 'nowMs'), own(input, 'startedAtMs'))) return noDecision();

  const text = stdinWithinCap(own(input, 'stdin'));
  if (text === undefined) return noDecision();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return noDecision();
  }
  if (!isPlainObject(parsed) || own(parsed, 'hook_event_name') !== 'PreModelSwitch') {
    return noDecision();
  }

  const pin = own(input, 'pin');
  const recommendedModel = own(input, 'recommendedModel');
  const policyVersion = own(input, 'policyVersion');
  if (typeof pin !== 'string' || pin.length === 0) return noDecision();
  if (typeof recommendedModel !== 'string') return noDecision();
  if (typeof policyVersion !== 'string' || policyVersion.length === 0) return noDecision();

  const toModel = own(parsed, 'to_model');
  const args: {
    mode: 'observe';
    policyVersion: string;
    recommendedModel: string;
    actualModel: string;
    requestedModel: string | null;
    presented: unknown;
    expectedUser: unknown;
    expectedPid: unknown;
    credential: unknown;
    nowMs: unknown;
    replay: unknown;
    destination?: unknown;
    setting?: unknown;
    untrustedClaims?: unknown;
  } = {
    mode: 'observe',
    policyVersion,
    recommendedModel,
    actualModel: pin,
    requestedModel: typeof toModel === 'string' ? toModel : null,
    presented: own(input, 'presented'),
    expectedUser: own(input, 'expectedUser'),
    expectedPid: own(input, 'expectedPid'),
    credential: own(input, 'credential'),
    nowMs: own(input, 'nowMs'),
    replay: own(input, 'replay'),
  };
  if (Object.hasOwn(input, 'destination')) args.destination = own(input, 'destination');
  if (Object.hasOwn(input, 'setting')) args.setting = own(input, 'setting');
  if (Object.hasOwn(input, 'untrustedClaims')) args.untrustedClaims = own(input, 'untrustedClaims');

  await recordObservation(args);
  return noDecision();
}

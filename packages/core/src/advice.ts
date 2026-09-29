import { durableWrite } from '@jevris/platform';
import type { AdviceMode, AdviceRecord, AdviceResult } from '@jevris/contracts';

/**
 * Advise-only record. The coding-model pin is kept.
 * applied is assigned here. This module does not take a port.
 */

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const dangerous = new Set(['__proto__', 'prototype', 'constructor']);
const blockedLabels = ['accuracy', 'providerConfidence', 'route-worker', 'SOURCE_CANARY_do_not_store'];

interface AdviseRouteInput {
  readonly mode?: unknown;
  readonly policyVersion?: unknown;
  readonly evidenceRevision?: unknown;
  readonly pinnedModel?: unknown;
  readonly predictedModel?: unknown;
  readonly allowlist?: unknown;
  readonly priorRecords?: unknown;
  readonly destination?: unknown;
}

interface AdviceKey {
  readonly policy: string;
  readonly revision: string;
  readonly pin: string;
  readonly predicted: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function hasDangerousKey(value: object): boolean {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || dangerous.has(key)) return true;
  }
  return false;
}

function own(value: object, key: string): unknown {
  if (!Object.hasOwn(value, key)) return undefined;
  return Reflect.get(value, key);
}

function blocked(value: string): boolean {
  for (const label of blockedLabels) {
    if (value.includes(label)) return true;
  }
  return false;
}

function safeId(value: unknown): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value) || dangerous.has(value) || blocked(value)) {
    return 'rejected';
  }
  return value;
}

function safeRevision(value: unknown): string {
  if (typeof value !== 'string' || !REVISION_PATTERN.test(value) || dangerous.has(value) || blocked(value)) {
    return 'rejected';
  }
  return value;
}

function readMode(value: unknown): AdviceMode | 'unsupported' {
  if (value === 'off' || value === 'observe' || value === 'advise') return value;
  return 'unsupported';
}

function adviceText(policy: string): string {
  return [
    'Advice recorded.',
    `Policy: ${policy}`,
    'The pinned model was not overridden.',
    'Mandatory checks are unchanged.',
    'No action was applied.',
  ].join('\n') + '\n';
}

function encodeUtf8(text: string): Uint8Array {
  const Ctor = (globalThis as unknown as { TextEncoder?: new () => { encode(input?: string): Uint8Array } }).TextEncoder;
  if (Ctor === undefined) return new Uint8Array();
  return new Ctor().encode(text);
}

function permittedPin(pin: string, allowlist: unknown): boolean {
  if (pin === 'rejected' || !Array.isArray(allowlist)) return false;
  for (const entry of allowlist) {
    if (safeRevision(entry) !== entry) continue;
    if (entry === pin) return true;
  }
  return false;
}

function keptPin(pin: string, predicted: string, allowlist: unknown): string {
  if (permittedPin(pin, allowlist)) return pin;
  if (predicted === pin) return pin;
  return pin;
}

function recordFrom(
  key: AdviceKey,
  text: string,
  prompted: boolean,
  ignored: boolean,
): AdviceRecord {
  return {
    policyVersion: key.policy,
    evidenceRevision: key.revision,
    pinnedModel: key.pin,
    predictedModel: key.predicted,
    text,
    prompted,
    applied: false,
    ignored,
  };
}

function rebuildPrior(value: unknown): AdviceRecord[] {
  if (!Array.isArray(value)) return [];
  const records: AdviceRecord[] = [];
  for (const item of value) {
    if (!isPlainObject(item) || hasDangerousKey(item)) {
      const rejected: AdviceKey = {
        policy: 'rejected',
        revision: 'rejected',
        pin: 'rejected',
        predicted: 'rejected',
      };
      records.push(recordFrom(rejected, adviceText('rejected'), false, false));
      continue;
    }
    const key: AdviceKey = {
      policy: safeId(own(item, 'policyVersion')),
      revision: safeRevision(own(item, 'evidenceRevision')),
      pin: safeRevision(own(item, 'pinnedModel')),
      predicted: safeRevision(own(item, 'predictedModel')),
    };
    records.push(
      recordFrom(key, adviceText(key.policy), own(item, 'prompted') === true, own(item, 'ignored') === true),
    );
  }
  return records;
}

function sameKey(record: AdviceRecord, key: AdviceKey): boolean {
  return (
    record.policyVersion === key.policy &&
    record.evidenceRevision === key.revision &&
    record.pinnedModel === key.pin &&
    record.predictedModel === key.predicted
  );
}

function buildResult(
  prompted: boolean,
  ignored: boolean,
  text: string,
  pinnedModel: string,
  records: readonly AdviceRecord[],
  fileWritten: boolean,
): AdviceResult {
  return {
    applied: false,
    toolPermission: false,
    authorityGranted: false,
    consentFabricated: false,
    verified: false,
    providerCalls: 0,
    prompted,
    ignored,
    text,
    pinnedModel,
    records,
    fileWritten,
  };
}

function refused(): AdviceResult {
  return buildResult(false, false, adviceText('rejected'), 'rejected', [], false);
}

async function writeAdvice(destination: string, text: string): Promise<boolean> {
  return (await durableWrite(destination, encodeUtf8(text))).ok;
}

export async function adviseRoute(value: AdviseRouteInput): Promise<AdviceResult> {
  if (!isPlainObject(value) || hasDangerousKey(value)) return refused();
  const mode = readMode(own(value, 'mode'));
  const key: AdviceKey = {
    policy: safeId(own(value, 'policyVersion')),
    revision: safeRevision(own(value, 'evidenceRevision')),
    pin: safeRevision(own(value, 'pinnedModel')),
    predicted: safeRevision(own(value, 'predictedModel')),
  };
  const pin = keptPin(key.pin, key.predicted, own(value, 'allowlist'));
  const text = adviceText(key.policy);
  const priors = rebuildPrior(own(value, 'priorRecords'));
  const duplicate = priors.some((record) => sameKey(record, key));
  const known = mode !== 'unsupported';
  const prompted = known && mode !== 'off' && !duplicate;
  const records = !known || duplicate ? priors : [...priors, recordFrom(key, text, prompted, false)];
  const destination = own(value, 'destination');
  const canWrite = known && !duplicate && typeof destination === 'string' && destination.length > 0;
  const fileWritten = canWrite ? await writeAdvice(destination, text) : false;
  return buildResult(prompted, false, text, pin, records, fileWritten);
}

export function ignoreAdvice(value: AdviceResult): AdviceResult {
  if (!isPlainObject(value) || hasDangerousKey(value)) {
    return buildResult(false, true, adviceText('rejected'), 'rejected', [], false);
  }
  const records = rebuildPrior(own(value, 'records'));
  const kept = records.map((record) => {
    const key: AdviceKey = {
      policy: record.policyVersion,
      revision: record.evidenceRevision,
      pin: record.pinnedModel,
      predicted: record.predictedModel,
    };
    return recordFrom(key, adviceText(key.policy), false, true);
  });
  const latest = kept[kept.length - 1];
  const text = latest === undefined ? adviceText('rejected') : latest.text;
  const pin = safeRevision(own(value, 'pinnedModel'));
  return buildResult(false, true, text, pin, kept, false);
}

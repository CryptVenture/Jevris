import type { LoopAdviceResult } from '@jevris/contracts';

/**
 * Synchronous failure-loop advice. No port, no store, no provider request.
 * Authority flags are assigned here. They are not read from the caller.
 */

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const dangerous = new Set(['__proto__', 'prototype', 'constructor']);
const REFUSED_TEXT = 'Recovery advice refused. No action was applied.';

const READ_FIELDS = [
  'diagnostic',
  'sourceEvidence',
  'fingerprint',
  'sameFingerprintCount',
  'commandHashRepeated',
  'relevantDiff',
  'rejectedApproaches',
  'proposedCause',
  'maxRepairAttempts',
  'repairAttemptsUsed',
] as const;

type Diagnostic = 'missing-service' | 'source-defect' | 'unknown';
type SourceEvidence = 'absent' | 'present';
type RelevantDiff = 'none' | 'present';

interface ClosedInput {
  readonly diagnostic: Diagnostic;
  readonly sourceEvidence: SourceEvidence;
  readonly sameFingerprintCount: number;
  readonly commandHashRepeated: boolean;
  readonly relevantDiff: RelevantDiff;
  readonly rejectedApproaches: readonly string[];
  readonly proposedCause: string | null;
  readonly maxRepairAttempts: number;
  readonly repairAttemptsUsed: number;
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

function safeId(value: unknown): string | undefined {
  if (typeof value !== 'string' || !ID_PATTERN.test(value) || dangerous.has(value)) return undefined;
  return value;
}

function boundedInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  if (value < 0 || value > 10) return undefined;
  return value;
}

function approachesLine(approaches: readonly string[]): string {
  if (approaches.length === 0) return 'Rejected approaches: none.';
  return `Rejected approaches: ${approaches.join(', ')}.`;
}

function record(
  disposition: LoopAdviceResult['disposition'],
  reasonCode: LoopAdviceResult['reasonCode'],
  nextStep: LoopAdviceResult['nextStep'],
  text: string,
  rejectedApproaches: readonly string[],
  hypothesis: string | null,
): LoopAdviceResult {
  return {
    disposition,
    reasonCode,
    nextStep,
    escalated: false,
    applied: false,
    verified: false,
    testsPassed: false,
    authorityGranted: false,
    consentFabricated: false,
    providerCalls: 0,
    text,
    rejectedApproaches,
    hypothesis,
  };
}

function refused(): LoopAdviceResult {
  return record('refused', 'INVALID_REQUEST', 'abstain', REFUSED_TEXT, [], null);
}

function environmentText(approaches: readonly string[]): string {
  return [
    'Next step: request environment evidence.',
    'Do not escalate the coding model.',
    'Diagnostic: missing-service.',
    'Source evidence: absent.',
    approachesLine(approaches),
    'Proposed cause is not a passing test.',
  ].join('\n');
}

function abstainText(approaches: readonly string[]): string {
  return [
    'Next step: abstain.',
    'Do not escalate the coding model.',
    approachesLine(approaches),
    'Proposed cause is not a passing test.',
  ].join('\n');
}

function cappedText(
  diagnostic: Diagnostic,
  sourceEvidence: SourceEvidence,
  approaches: readonly string[],
): string {
  const lines = ['Next step: stop with a clear report.'];
  if (diagnostic === 'missing-service' && sourceEvidence === 'absent') {
    lines.push('Environment evidence is still missing.');
  }
  lines.push(
    'Do not escalate the coding model.',
    'Recovery advice is capped.',
    approachesLine(approaches),
    'Proposed cause is not a passing test.',
  );
  return lines.join('\n');
}

function readApproaches(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > 10) return undefined;
  const copied: string[] = [];
  for (const entry of value) {
    const id = safeId(entry);
    if (id === undefined) return undefined;
    copied.push(id);
  }
  return copied;
}

function readCause(value: unknown): string | null | undefined {
  if (value === null) return null;
  return safeId(value);
}

function readClosed(value: object): ClosedInput | undefined {
  for (const field of READ_FIELDS) {
    if (!Object.hasOwn(value, field)) return undefined;
  }

  const diagnostic = own(value, 'diagnostic');
  const sourceEvidence = own(value, 'sourceEvidence');
  const fingerprint = safeId(own(value, 'fingerprint'));
  const sameFingerprintCount = boundedInteger(own(value, 'sameFingerprintCount'));
  const commandHashRepeated = own(value, 'commandHashRepeated');
  const relevantDiff = own(value, 'relevantDiff');
  const rejectedApproaches = readApproaches(own(value, 'rejectedApproaches'));
  const proposedCause = readCause(own(value, 'proposedCause'));
  const maxRepairAttempts = boundedInteger(own(value, 'maxRepairAttempts'));
  const repairAttemptsUsed = boundedInteger(own(value, 'repairAttemptsUsed'));

  if (diagnostic !== 'missing-service' && diagnostic !== 'source-defect' && diagnostic !== 'unknown') {
    return undefined;
  }
  if (sourceEvidence !== 'absent' && sourceEvidence !== 'present') return undefined;
  if (fingerprint === undefined || sameFingerprintCount === undefined) return undefined;
  if (typeof commandHashRepeated !== 'boolean') return undefined;
  if (relevantDiff !== 'none' && relevantDiff !== 'present') return undefined;
  if (rejectedApproaches === undefined || proposedCause === undefined) return undefined;
  if (maxRepairAttempts === undefined || repairAttemptsUsed === undefined) return undefined;

  return {
    diagnostic,
    sourceEvidence,
    sameFingerprintCount,
    commandHashRepeated,
    relevantDiff,
    rejectedApproaches,
    proposedCause,
    maxRepairAttempts,
    repairAttemptsUsed,
  };
}

export function adviseFailureLoop(input: unknown): LoopAdviceResult {
  if (!isPlainObject(input) || hasDangerousKey(input)) return refused();
  const closed = readClosed(input);
  if (closed === undefined) return refused();

  const repeated =
    closed.sameFingerprintCount >= 3 && closed.commandHashRepeated === true && closed.relevantDiff === 'none';
  const environmentCase = repeated && closed.diagnostic === 'missing-service' && closed.sourceEvidence === 'absent';
  const capped = closed.repairAttemptsUsed >= closed.maxRepairAttempts;

  if (environmentCase && !capped) {
    return record(
      'advice',
      'LOOP_ADVICE',
      'request-environment-evidence',
      environmentText(closed.rejectedApproaches),
      closed.rejectedApproaches,
      closed.proposedCause,
    );
  }

  if (repeated && capped) {
    return record(
      'advice',
      'LOOP_CAPPED',
      'stop-with-report',
      cappedText(closed.diagnostic, closed.sourceEvidence, closed.rejectedApproaches),
      closed.rejectedApproaches,
      closed.proposedCause,
    );
  }

  return record(
    'abstained',
    'NOT_A_LOOP',
    'abstain',
    abstainText(closed.rejectedApproaches),
    closed.rejectedApproaches,
    closed.proposedCause,
  );
}

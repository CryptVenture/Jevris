/**
 * Shadow report printer. Closed literals only. A banned ratio token refuses
 * the print. This module does not import the runtime, a hook, or a process.
 */

const BANNED_RATIO_TOKENS = [
  '193.6',
  '444.6',
  '23.8',
  '47.6',
  '119.0',
  '238.1',
  '1.247',
  '4.81',
  '26.6',
  '13.4',
] as const;

const SHADOW_PREFIX = 'JEVRIS_SHADOW ';

function containsBannedRatio(serialized: string): boolean {
  for (const token of BANNED_RATIO_TOKENS) {
    if (serialized.includes(token)) return true;
  }
  return false;
}

function recordCountOf(argument: unknown): number {
  if (argument === null || typeof argument !== 'object' || Array.isArray(argument)) return 0;
  if (!Object.hasOwn(argument, 'recordCount')) return 0;
  const count = (argument as { readonly recordCount?: unknown }).recordCount;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return 0;
  return count;
}

function closedReport(recordCount: number): {
  readonly schemaVersion: '1.0';
  readonly kind: 'shadow-report';
  readonly baselines: readonly ['rules-only', 'native', 'jev'];
  readonly recordCount: number;
  readonly actuationCount: 0;
  readonly measuredSpeedRatio: null;
  readonly measuredCostRatio: null;
  readonly vendorSpeedClaim: 'not-a-jevris-result';
  readonly vendorCostClaim: 'not-a-jevris-result';
  readonly fullCostPerVerifiedTask: 'unmeasured';
} {
  return {
    schemaVersion: '1.0',
    kind: 'shadow-report',
    baselines: ['rules-only', 'native', 'jev'],
    recordCount,
    actuationCount: 0,
    measuredSpeedRatio: null,
    measuredCostRatio: null,
    vendorSpeedClaim: 'not-a-jevris-result',
    vendorCostClaim: 'not-a-jevris-result',
    fullCostPerVerifiedTask: 'unmeasured',
  };
}

export function formatShadowReport(argument: unknown): string {
  const serialized = JSON.stringify(argument);
  if (typeof serialized !== 'string' || containsBannedRatio(serialized)) return 'refused\n';
  const report = closedReport(recordCountOf(argument));
  const printed = JSON.stringify(report);
  if (containsBannedRatio(printed)) return 'refused\n';
  const lines = [
    'Shadow report.',
    'Baselines: rules-only, native, jev',
    `Records: ${report.recordCount}`,
    'Actuation count: 0',
    'Measured speed ratio: not-a-jevris-result',
    'Measured cost ratio: not-a-jevris-result',
    'Vendor speed claim: not-a-jevris-result',
    'Vendor cost claim: not-a-jevris-result',
    'Full cost per verified task: unmeasured',
    `${SHADOW_PREFIX}${printed}`,
  ];
  return `${lines.join('\n')}\n`;
}

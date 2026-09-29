import { Ajv2020 } from 'ajv/dist/2020.js';
import { HOST_SECRET_REF } from './credential-broker.js';

/**
 * Administrator host document. Provenance is not a field. A repository
 * file cannot satisfy this schema and become consent.
 */

export const hostPolicySchema: { readonly [key: string]: unknown } = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'mode',
    'egress',
    'retention',
    'budget',
    'pin',
    'packPrivileges',
    'credentialRef',
    'installerEnvName',
    'allowUncalibratedActuation',
  ],
  properties: {
    schemaVersion: { const: '1.0' },
    mode: { enum: ['off', 'observe', 'advise', 'bounded-auto'] },
    egress: { enum: ['deny-until-approved', 'approved-scoped'] },
    retention: {
      type: 'object',
      additionalProperties: false,
      required: ['rawArtifactRetentionDays', 'decisionRetentionDays'],
      properties: {
        rawArtifactRetentionDays: { type: 'integer', minimum: 0, maximum: 365 },
        decisionRetentionDays: { type: 'integer', minimum: 0, maximum: 3650 },
      },
    },
    budget: {
      type: 'object',
      additionalProperties: false,
      required: ['maxRequestBytes'],
      properties: {
        maxRequestBytes: { type: 'integer', minimum: 1024, maximum: 16777216 },
      },
    },
    pin: {
      type: 'object',
      additionalProperties: false,
      required: ['model', 'respectHumanPins'],
      properties: {
        model: { type: 'string', pattern: '^jev-\\d+\\.\\d+\\.\\d+$' },
        respectHumanPins: { const: true },
      },
    },
    packPrivileges: {
      type: 'array',
      items: { type: 'string' },
      uniqueItems: true,
      maxItems: 256,
    },
    credentialRef: { const: HOST_SECRET_REF },
    installerEnvName: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,63}$' },
    allowUncalibratedActuation: { const: false },
  },
};

export type HostMode = 'off' | 'observe' | 'advise' | 'bounded-auto';
export type HostEgress = 'deny-until-approved' | 'approved-scoped';

export interface HostDocument {
  readonly schemaVersion: '1.0';
  readonly mode: HostMode;
  readonly egress: HostEgress;
  readonly retention: {
    readonly rawArtifactRetentionDays: number;
    readonly decisionRetentionDays: number;
  };
  readonly budget: {
    readonly maxRequestBytes: number;
  };
  readonly pin: {
    readonly model: string;
    readonly respectHumanPins: true;
  };
  readonly packPrivileges: readonly string[];
  readonly credentialRef: typeof HOST_SECRET_REF;
  readonly installerEnvName: string;
  readonly allowUncalibratedActuation: false;
}

const ajv = new Ajv2020({
  allErrors: false,
  strict: true,
  removeAdditional: false,
  useDefaults: false,
  coerceTypes: false,
});

const compiled = ajv.compile(hostPolicySchema);

const MODES = new Set<HostMode>(['off', 'observe', 'advise', 'bounded-auto']);
const EGRESS = new Set<HostEgress>(['deny-until-approved', 'approved-scoped']);
const MODEL = /^jev-\d+\.\d+\.\d+$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

function isPlain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function readInteger(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  if (value < min || value > max) return undefined;
  return value;
}

function readMode(value: unknown): HostMode | undefined {
  if (value === 'off' || value === 'observe' || value === 'advise' || value === 'bounded-auto') {
    if (!MODES.has(value)) return undefined;
    return value;
  }
  return undefined;
}

function readEgress(value: unknown): HostEgress | undefined {
  if (value === 'deny-until-approved' || value === 'approved-scoped') {
    if (!EGRESS.has(value)) return undefined;
    return value;
  }
  return undefined;
}

function readPrivileges(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > 256) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || seen.has(item)) return undefined;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function copyDocument(value: Record<string, unknown>): HostDocument | undefined {
  if (value.schemaVersion !== '1.0') return undefined;
  const mode = readMode(value.mode);
  const egress = readEgress(value.egress);
  if (mode === undefined || egress === undefined) return undefined;
  if (!isPlain(value.retention) || !isPlain(value.budget) || !isPlain(value.pin)) return undefined;
  const rawArtifactRetentionDays = readInteger(value.retention.rawArtifactRetentionDays, 0, 365);
  const decisionRetentionDays = readInteger(value.retention.decisionRetentionDays, 0, 3650);
  const maxRequestBytes = readInteger(value.budget.maxRequestBytes, 1024, 16777216);
  if (
    rawArtifactRetentionDays === undefined ||
    decisionRetentionDays === undefined ||
    maxRequestBytes === undefined
  ) {
    return undefined;
  }
  const model = value.pin.model;
  if (typeof model !== 'string' || !MODEL.test(model) || value.pin.respectHumanPins !== true) return undefined;
  const packPrivileges = readPrivileges(value.packPrivileges);
  const installerEnvName = value.installerEnvName;
  if (packPrivileges === undefined) return undefined;
  if (typeof installerEnvName !== 'string' || !ENV_NAME.test(installerEnvName)) return undefined;
  if (value.credentialRef !== HOST_SECRET_REF || value.allowUncalibratedActuation !== false) return undefined;
  return {
    schemaVersion: '1.0',
    mode,
    egress,
    retention: { rawArtifactRetentionDays, decisionRetentionDays },
    budget: { maxRequestBytes },
    pin: { model, respectHumanPins: true },
    packPrivileges,
    credentialRef: HOST_SECRET_REF,
    installerEnvName,
    allowUncalibratedActuation: false,
  };
}

/**
 * True only after Ajv2020 accepts the document and a field copy succeeds.
 * Does not assign provenance. Does not read secret values into an error.
 */
export function copyHostDocument(value: unknown): HostDocument | undefined {
  if (!isPlain(value)) return undefined;
  if (compiled(value) !== true) return undefined;
  return copyDocument(value);
}

export function validateHostDocument(value: unknown): value is HostDocument {
  return copyHostDocument(value) !== undefined;
}

const RAW_KEYS = new Set(['apiKey', 'token', 'secret', 'secretText', 'password', 'TYPESAFE_API_KEY']);
const DANGEROUS = new Set(['__proto__', 'prototype', 'constructor']);
const MODE_RANK: { readonly [key in HostMode]: number } = {
  off: 0,
  observe: 1,
  advise: 2,
  'bounded-auto': 3,
};
const EGRESS_RANK: { readonly [key in HostEgress]: number } = {
  'deny-until-approved': 0,
  'approved-scoped': 1,
};

export interface PolicyMergeOk {
  readonly ok: true;
  readonly document: HostDocument;
}

export interface PolicyMergeFail {
  readonly ok: false;
  readonly reasonCode: 'POLICY_WIDEN';
}

export type PolicyMerge = PolicyMergeOk | PolicyMergeFail;

export interface ProjectNarrowOk {
  readonly ok: true;
  readonly document: HostDocument;
}

export interface ProjectNarrowFail {
  readonly ok: false;
  readonly reasonCode: 'POLICY_WIDEN' | 'RAW_KEY_REFUSED';
}

export type ProjectNarrow = ProjectNarrowOk | ProjectNarrowFail;

function scanRaw(value: unknown, seen: WeakSet<object>): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return true;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (scanRaw(item, seen)) return true;
    }
    return false;
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || DANGEROUS.has(key) || RAW_KEYS.has(key)) return true;
    if (scanRaw(Reflect.get(value, key), seen)) return true;
  }
  return false;
}

/** True when a raw-key name is an own property. The property value is not returned. */
export function hasRawKeyProperty(value: unknown): boolean {
  return scanRaw(value, new WeakSet());
}

function widen(): PolicyMergeFail {
  return { ok: false, reasonCode: 'POLICY_WIDEN' };
}

function replaceMode(document: HostDocument, mode: HostMode): HostDocument {
  return {
    schemaVersion: '1.0',
    mode,
    egress: document.egress,
    retention: {
      rawArtifactRetentionDays: document.retention.rawArtifactRetentionDays,
      decisionRetentionDays: document.retention.decisionRetentionDays,
    },
    budget: { maxRequestBytes: document.budget.maxRequestBytes },
    pin: { model: document.pin.model, respectHumanPins: true },
    packPrivileges: [...document.packPrivileges],
    credentialRef: HOST_SECRET_REF,
    installerEnvName: document.installerEnvName,
    allowUncalibratedActuation: false,
  };
}

/**
 * Intersection only. A widen does not produce a merged document.
 * Provenance is not read and is not copied.
 */
export function mergeOrganization(host: HostDocument, organization: HostDocument): PolicyMerge {
  if (host.credentialRef !== HOST_SECRET_REF || organization.credentialRef !== HOST_SECRET_REF) return widen();
  if (host.installerEnvName !== organization.installerEnvName) return widen();
  if (host.pin.model !== organization.pin.model || host.pin.respectHumanPins !== true) return widen();
  if (host.allowUncalibratedActuation !== false || organization.allowUncalibratedActuation !== false) return widen();
  if (MODE_RANK[organization.mode] > MODE_RANK[host.mode]) return widen();
  if (EGRESS_RANK[organization.egress] > EGRESS_RANK[host.egress]) return widen();
  if (organization.retention.rawArtifactRetentionDays > host.retention.rawArtifactRetentionDays) return widen();
  if (organization.retention.decisionRetentionDays > host.retention.decisionRetentionDays) return widen();
  if (organization.budget.maxRequestBytes > host.budget.maxRequestBytes) return widen();
  const hostPrivileges = new Set(host.packPrivileges);
  for (const privilege of organization.packPrivileges) {
    if (!hostPrivileges.has(privilege)) return widen();
  }
  const organizationPrivileges = new Set(organization.packPrivileges);
  const packPrivileges = host.packPrivileges.filter((privilege) => organizationPrivileges.has(privilege));
  const mode = MODE_RANK[organization.mode] < MODE_RANK[host.mode] ? organization.mode : host.mode;
  const egress = EGRESS_RANK[organization.egress] < EGRESS_RANK[host.egress] ? organization.egress : host.egress;
  return {
    ok: true,
    document: {
      schemaVersion: '1.0',
      mode,
      egress,
      retention: {
        rawArtifactRetentionDays: Math.min(
          host.retention.rawArtifactRetentionDays,
          organization.retention.rawArtifactRetentionDays,
        ),
        decisionRetentionDays: Math.min(
          host.retention.decisionRetentionDays,
          organization.retention.decisionRetentionDays,
        ),
      },
      budget: {
        maxRequestBytes: Math.min(host.budget.maxRequestBytes, organization.budget.maxRequestBytes),
      },
      pin: { model: host.pin.model, respectHumanPins: true },
      packPrivileges,
      credentialRef: HOST_SECRET_REF,
      installerEnvName: host.installerEnvName,
      allowUncalibratedActuation: false,
    },
  };
}

/**
 * Reads mode only. A missing project is unchanged. Egress, provenance, and
 * privileges from the project are ignored.
 */
export function applyProjectNarrowing(host: HostDocument, project: unknown): ProjectNarrow {
  if (project === undefined) return { ok: true, document: host };
  if (hasRawKeyProperty(project)) return { ok: false, reasonCode: 'RAW_KEY_REFUSED' };
  if (!isPlain(project) || !Object.hasOwn(project, 'mode')) return { ok: true, document: host };
  const mode = readMode(project.mode);
  if (mode === undefined) return { ok: true, document: host };
  if (MODE_RANK[mode] > MODE_RANK[host.mode]) return { ok: false, reasonCode: 'POLICY_WIDEN' };
  if (mode === host.mode) return { ok: true, document: host };
  return { ok: true, document: replaceMode(host, mode) };
}

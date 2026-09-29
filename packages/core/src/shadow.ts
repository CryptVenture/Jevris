import { readFile } from 'node:fs/promises';
import { durableWrite, isPacksPath } from '@jevris/platform';
import {
  FEEDBACK_REASONS,
  FULL_COST_UNMEASURED,
  MAX_REQUEST_BYTES,
  NOT_A_JEVRIS_RESULT,
  SHADOW_BASELINES,
  SHADOW_COMPARISON_KEYS,
  SHADOW_COMPARISON_SCHEMA_VERSION,
  SHADOW_RECORDED_EXPLANATION,
  SHADOW_REPORT_KIND,
} from '@jevris/contracts';
import type {
  CalibrationDraftFile,
  FeedbackReason,
  RecommendationFeedbackFile,
  ShadowComparisonFile,
  ShadowReport,
} from '@jevris/contracts';
import { decideEgress, type EgressRequest } from './egress.js';
import { applyRules } from './rules.js';

/**
 * Shadow comparison. Named fields only. The three arms stay in the file.
 * This module does not bind a listener and does not send.
 */

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const dangerous = new Set(['__proto__', 'prototype', 'constructor']);
const forbidden = new Set([
  'source',
  'sourceText',
  'token',
  'body',
  'message',
  'secret',
  'secretText',
  'port',
]);

export type RecordShadowComparisonResult =
  | {
      readonly accepted: false;
      readonly fileWritten: false;
      readonly applied: false;
      readonly sent: false;
      readonly actuationCount: 0;
    }
  | {
      readonly accepted: true;
      readonly fileWritten: boolean;
      readonly applied: false;
      readonly sent: false;
      readonly actuationCount: 0;
      readonly file: ShadowComparisonFile;
    };

export type ReadShadowComparisonResult =
  | { readonly ok: true; readonly file: ShadowComparisonFile }
  | { readonly ok: false; readonly reasonCode: 'SCHEMA_FAILURE' };

export type RecordRecommendationFeedbackResult =
  | {
      readonly accepted: false;
      readonly fileWritten: false;
      readonly draftWritten: false;
      readonly applied: false;
      readonly sent: false;
      readonly actuationCount: 0;
    }
  | {
      readonly accepted: true;
      readonly fileWritten: boolean;
      readonly draftWritten: false;
      readonly applied: false;
      readonly sent: false;
      readonly actuationCount: 0;
      readonly file: RecommendationFeedbackFile;
    }
  | {
      readonly accepted: true;
      readonly fileWritten: boolean;
      readonly draftWritten: boolean;
      readonly applied: false;
      readonly sent: false;
      readonly actuationCount: 0;
      readonly file: RecommendationFeedbackFile;
      readonly draft: CalibrationDraftFile;
    };

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

function hasForbiddenKey(value: object): boolean {
  for (const key of forbidden) {
    if (Object.hasOwn(value, key)) return true;
  }
  return false;
}

function own(value: object, key: string): unknown {
  if (!Object.hasOwn(value, key)) return undefined;
  return Reflect.get(value, key);
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value) && !dangerous.has(value);
}

function safeRevision(value: unknown): value is string {
  return typeof value === 'string' && REVISION_PATTERN.test(value) && !dangerous.has(value);
}

function reject(): RecordShadowComparisonResult {
  return {
    accepted: false,
    fileWritten: false,
    applied: false,
    sent: false,
    actuationCount: 0,
  };
}

function recorded(file: ShadowComparisonFile, fileWritten: boolean): RecordShadowComparisonResult {
  return {
    accepted: true,
    fileWritten,
    applied: false,
    sent: false,
    actuationCount: 0,
    file,
  };
}

function schemaFailure(): ReadShadowComparisonResult {
  return { ok: false, reasonCode: 'SCHEMA_FAILURE' };
}

function exactKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  if (keys.length !== SHADOW_COMPARISON_KEYS.length) return false;
  for (let i = 0; i < SHADOW_COMPARISON_KEYS.length; i += 1) {
    if (keys[i] !== SHADOW_COMPARISON_KEYS[i]) return false;
  }
  return true;
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

function egressRequest(hasSetting: boolean, setting: unknown, hasClaims: boolean, claims: unknown): EgressRequest {
  if (hasSetting && hasClaims) return { setting, untrustedClaims: claims };
  if (hasSetting) return { setting };
  if (hasClaims) return { untrustedClaims: claims };
  return {};
}

function rulesArm(input: unknown): string | null {
  let hit: ReturnType<typeof applyRules>;
  try {
    hit = applyRules(input);
  } catch {
    return null;
  }
  if (hit === null) return null;
  return safeId(hit.reasonCode) ? hit.reasonCode : null;
}

function jevArm(hasSetting: boolean, setting: unknown, hasClaims: boolean, claims: unknown, label: unknown): string | null {
  let decision: ReturnType<typeof decideEgress>;
  try {
    decision = decideEgress(egressRequest(hasSetting, setting, hasClaims, claims));
  } catch {
    return null;
  }
  if (decision.decision !== 'allow') return null;
  return safeRevision(label) ? label : null;
}

function nullableId(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (safeId(value)) return value;
  return undefined;
}

function nullableRevision(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (safeRevision(value)) return value;
  return undefined;
}

function fileFromParsed(value: unknown): ShadowComparisonFile | undefined {
  if (!isPlainObject(value) || hasDangerousKey(value) || !exactKeys(value)) return undefined;
  if (value.schemaVersion !== SHADOW_COMPARISON_SCHEMA_VERSION) return undefined;
  if (value.mode !== 'shadow') return undefined;
  if (!safeId(value.policyVersion) || !safeRevision(value.actualModel)) return undefined;
  if (value.nativeRecommendation !== value.actualModel) return undefined;
  const rulesRecommendation = nullableId(value.rulesRecommendation);
  const jevRecommendation = nullableRevision(value.jevRecommendation);
  if (rulesRecommendation === undefined || jevRecommendation === undefined) return undefined;
  if (value.actualWorker !== null || value.appliedAction !== null) return undefined;
  if (value.applied !== false || value.sent !== false || value.actuationCount !== 0) return undefined;
  if (value.explanation !== SHADOW_RECORDED_EXPLANATION) return undefined;
  return {
    schemaVersion: SHADOW_COMPARISON_SCHEMA_VERSION,
    mode: 'shadow',
    policyVersion: value.policyVersion,
    rulesRecommendation,
    nativeRecommendation: value.actualModel,
    jevRecommendation,
    actualModel: value.actualModel,
    actualWorker: null,
    applied: false,
    appliedAction: null,
    actuationCount: 0,
    sent: false,
    explanation: SHADOW_RECORDED_EXPLANATION,
  };
}

function isJevrisPacksPath(destination: string): boolean {
  return isPacksPath(destination);
}

async function writeClosed(
  destination: string,
  suffix: '.shadow.tmp' | '.feedback.tmp' | '.draft.tmp',
  bytes: Uint8Array,
): Promise<boolean> {
  return (await durableWrite(destination, bytes)).ok;
}

async function writeComparison(destination: string, file: ShadowComparisonFile): Promise<boolean> {
  return writeClosed(destination, '.shadow.tmp', encodeUtf8(JSON.stringify(file)));
}

function rejectFeedback(): RecordRecommendationFeedbackResult {
  return {
    accepted: false,
    fileWritten: false,
    draftWritten: false,
    applied: false,
    sent: false,
    actuationCount: 0,
  };
}

function recordedFeedback(
  file: RecommendationFeedbackFile,
  fileWritten: boolean,
): RecordRecommendationFeedbackResult {
  return {
    accepted: true,
    fileWritten,
    draftWritten: false,
    applied: false,
    sent: false,
    actuationCount: 0,
    file,
  };
}

function recordedDraft(
  file: RecommendationFeedbackFile,
  fileWritten: boolean,
  draft: CalibrationDraftFile,
  draftWritten: boolean,
): RecordRecommendationFeedbackResult {
  return {
    accepted: true,
    fileWritten,
    draftWritten,
    applied: false,
    sent: false,
    actuationCount: 0,
    file,
    draft,
  };
}

function draftFile(policyVersion: string): CalibrationDraftFile {
  return {
    schemaVersion: SHADOW_COMPARISON_SCHEMA_VERSION,
    kind: 'calibration-proposal',
    policyVersion,
    published: false,
    loaded: false,
  };
}

function closedReason(input: object): FeedbackReason | undefined {
  if (!Object.hasOwn(input, 'reason')) return 'unspecified';
  const reason = own(input, 'reason');
  if (typeof reason !== 'string') return undefined;
  for (const token of FEEDBACK_REASONS) {
    if (reason === token) return token;
  }
  return undefined;
}

function feedbackFile(
  policyVersion: string,
  recommendationId: string,
  reason: FeedbackReason,
): RecommendationFeedbackFile {
  return {
    schemaVersion: SHADOW_COMPARISON_SCHEMA_VERSION,
    kind: 'recommendation-feedback',
    policyVersion,
    recommendationId,
    decision: 'rejected',
    reason,
    published: false,
    policyChanged: false,
  };
}

export async function recordShadowComparison(input: object): Promise<RecordShadowComparisonResult> {
  if (!isPlainObject(input) || hasDangerousKey(input) || hasForbiddenKey(input)) return reject();
  const policyVersion = own(input, 'policyVersion');
  const actualModel = own(input, 'actualModel');
  if (!safeId(policyVersion) || !safeRevision(actualModel)) return reject();

  const hasSetting = Object.hasOwn(input, 'setting');
  const hasClaims = Object.hasOwn(input, 'untrustedClaims');
  const file: ShadowComparisonFile = {
    schemaVersion: SHADOW_COMPARISON_SCHEMA_VERSION,
    mode: 'shadow',
    policyVersion,
    rulesRecommendation: rulesArm(own(input, 'rulesInput')),
    nativeRecommendation: actualModel,
    jevRecommendation: jevArm(hasSetting, own(input, 'setting'), hasClaims, own(input, 'untrustedClaims'), own(input, 'jevLabel')),
    actualModel,
    actualWorker: null,
    applied: false,
    appliedAction: null,
    actuationCount: 0,
    sent: false,
    explanation: SHADOW_RECORDED_EXPLANATION,
  };

  const destination = own(input, 'destination');
  if (typeof destination !== 'string' || destination.length === 0) return recorded(file, false);
  const written = await writeComparison(destination, file);
  return recorded(file, written);
}

export async function recordRecommendationFeedback(input: object): Promise<RecordRecommendationFeedbackResult> {
  if (!isPlainObject(input) || hasDangerousKey(input) || hasForbiddenKey(input)) return rejectFeedback();
  if (Object.hasOwn(input, 'decision') && own(input, 'decision') !== 'rejected') return rejectFeedback();
  const policyVersion = own(input, 'policyVersion');
  const recommendationId = own(input, 'recommendationId');
  if (!safeId(policyVersion) || !safeId(recommendationId)) return rejectFeedback();
  const reason = closedReason(input);
  if (reason === undefined) return rejectFeedback();

  const destination = own(input, 'destination');
  const draftDestination = own(input, 'draftDestination');
  if (typeof destination === 'string' && destination.length > 0 && isJevrisPacksPath(destination)) {
    return rejectFeedback();
  }
  if (
    typeof draftDestination === 'string' &&
    draftDestination.length > 0 &&
    isJevrisPacksPath(draftDestination)
  ) {
    return rejectFeedback();
  }

  const file = feedbackFile(policyVersion, recommendationId, reason);
  let fileWritten = false;
  if (typeof destination === 'string' && destination.length > 0) {
    fileWritten = await writeClosed(destination, '.feedback.tmp', encodeUtf8(JSON.stringify(file)));
  }
  if (typeof draftDestination !== 'string' || draftDestination.length === 0) {
    return recordedFeedback(file, fileWritten);
  }
  const draft = draftFile(policyVersion);
  const draftWritten = await writeClosed(draftDestination, '.draft.tmp', encodeUtf8(JSON.stringify(draft)));
  return recordedDraft(file, fileWritten, draft, draftWritten);
}

export type BuildShadowReportResult = ShadowReport | { readonly refused: true };

function reportRefused(): { readonly refused: true } {
  return { refused: true };
}

function closedReport(recordCount: number): ShadowReport {
  return {
    schemaVersion: SHADOW_COMPARISON_SCHEMA_VERSION,
    kind: SHADOW_REPORT_KIND,
    baselines: SHADOW_BASELINES,
    recordCount,
    actuationCount: 0,
    measuredSpeedRatio: null,
    measuredCostRatio: null,
    vendorSpeedClaim: NOT_A_JEVRIS_RESULT,
    vendorCostClaim: NOT_A_JEVRIS_RESULT,
    fullCostPerVerifiedTask: FULL_COST_UNMEASURED,
  };
}

export function buildShadowReport(files: readonly object[]): BuildShadowReportResult {
  if (!Array.isArray(files)) return reportRefused();
  for (const file of files) {
    if (!isPlainObject(file)) return reportRefused();
    if (file.actuationCount !== 0 || file.applied !== false || file.sent !== false) return reportRefused();
    if (file.actualWorker !== null) return reportRefused();
  }
  return closedReport(files.length);
}

export async function readShadowComparison(destination: string): Promise<ReadShadowComparisonResult> {
  if (typeof destination !== 'string' || destination.length === 0) return schemaFailure();
  let bytes: Uint8Array;
  try {
    bytes = await readFile(destination);
  } catch {
    return schemaFailure();
  }
  if (bytes.byteLength > MAX_REQUEST_BYTES) return schemaFailure();
  const text = decodeUtf8Fatal(bytes);
  if (text === undefined) return schemaFailure();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return schemaFailure();
  }
  const file = fileFromParsed(parsed);
  if (file === undefined) return schemaFailure();
  return { ok: true, file };
}

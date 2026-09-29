/**
 * The contract catalogue: every contract with a generated JSON Schema, keyed by contract name.
 * Schema generation, the drift check and durable-envelope lookup all read this one list.
 */
import {
  ActionContract,
  ActionIntentContract,
  ActionReceiptContract,
  AuthorizationReceiptContract,
  CapabilityContract,
  RecommendationTemplateContract,
} from './actions.js';
import { JevRequestContract, JevrisConfigContract, PackManifestContract } from './boundary.js';
import { CalibrationArtifactContract } from './calibration.js';
import { CertificationRecordContract } from './certification.js';
import type { Contract } from './contract.js';
import { DecisionResultContract, DecisionSpecContract } from './decision.js';
import { DecisionRecordContract } from './decision-record.js';
import { ModelRegistryContract, RouteAdviceContract } from './routing.js';
import { CorpusSummaryContract, EvaluationProtocolContract, HoldoutManifestContract, QualityMeasurementContract } from './evaluation.js';
import {
  AuthorityContract,
  EventEnvelopeContract,
  EvidenceRefContract,
  JsonContract,
  ModeContract,
  RiskContract,
  SessionSnapshotContract,
} from './domain.js';
import { DurableEnvelopeContract, openDurable, type Durable } from './durable.js';
import { HookOutcomeContract } from './harness-event.js';
import type { ValidationResult } from './contract.js';
import { AgentLeaseContract, BudgetReservationContract, TaskNodeContract } from './orchestration.js';
import { ModelRegistryEntryContract } from './registry.js';
import { MemoryCapsuleContract, VerificationReceiptContract } from './receipts.js';
import { jsonSchemaOf } from './schema.js';

const list: readonly Contract<unknown>[] = [
  ModeContract,
  AuthorityContract,
  RiskContract,
  JsonContract,
  EvidenceRefContract,
  EventEnvelopeContract,
  ActionContract,
  ActionIntentContract,
  CapabilityContract,
  SessionSnapshotContract,
  DecisionSpecContract,
  DecisionResultContract,
  ModelRegistryEntryContract,
  TaskNodeContract,
  AgentLeaseContract,
  BudgetReservationContract,
  VerificationReceiptContract,
  MemoryCapsuleContract,
  AuthorizationReceiptContract,
  ActionReceiptContract,
  RecommendationTemplateContract,
  DurableEnvelopeContract,
  CalibrationArtifactContract,
  CertificationRecordContract,
  JevrisConfigContract,
  PackManifestContract,
  JevRequestContract,
  DecisionRecordContract,
  ModelRegistryContract,
  RouteAdviceContract,
  EvaluationProtocolContract,
  HoldoutManifestContract,
  CorpusSummaryContract,
  QualityMeasurementContract,
  HookOutcomeContract,
] as readonly Contract<unknown>[];

export const CONTRACTS: ReadonlyMap<string, Contract<unknown>> = new Map(list.map((contract) => [contract.name, contract]));

/** Contracts whose values are stored durably and so may be sealed in a DurableEnvelope. */
export const DURABLE_CONTRACT_NAMES: readonly string[] = Object.freeze([
  'EvidenceRef',
  'EventEnvelope',
  'ActionIntent',
  'Capability',
  'SessionSnapshot',
  'DecisionSpec',
  'DecisionResult',
  'ModelRegistryEntry',
  'TaskNode',
  'AgentLease',
  'BudgetReservation',
  'VerificationReceipt',
  'MemoryCapsule',
  'AuthorizationReceipt',
  'ActionReceipt',
  'CalibrationArtifact',
  'CertificationRecord',
  'DecisionRecord',
  'ModelRegistry',
]);

/** Opens a durable envelope whose body is any catalogued durable contract. */
export function openCataloguedDurable(value: unknown): ValidationResult<Durable<unknown>> {
  return openDurable(value, (name) => (DURABLE_CONTRACT_NAMES.includes(name) ? CONTRACTS.get(name) : undefined));
}

/** kebab-case file stem for a contract name: `EventEnvelope` -> `event-envelope`. */
export function schemaFileStem(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').toLowerCase();
}

export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

/** The `$id` of a generated contract schema. */
export function schemaId(name: string): string {
  return `urn:jevris:contract:${schemaFileStem(name)}:1.0`;
}

/**
 * The generated JSON Schema documents, keyed by file name (`<stem>.schema.json`), each a
 * standalone JSON Schema 2020-12 document. Serialised with two-space indentation and a final
 * newline; this map is what `scripts/generate-schemas.mjs` writes and the drift check compares.
 */
export function schemaDocuments(): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const contract of CONTRACTS.values()) {
    const { title: _title, description: _description, ...rest } = jsonSchemaOf(contract.schema) as Record<string, unknown>;
    const document = {
      $schema: JSON_SCHEMA_DIALECT,
      $id: schemaId(contract.name),
      title: contract.name,
      description: contract.description,
      ...rest,
    };
    out.set(`${schemaFileStem(contract.name)}.schema.json`, `${JSON.stringify(document, null, 2)}\n`);
  }
  return out;
}

/**
 * The shared conformance suite (PRV-04, PRV-06): one list of cases, run through the engine's
 * `JevClient` over any transport. The SDK transport and the native reference check must produce
 * identical outcomes for every case.
 */
import { PINNED_MODEL, type JevTransport, type JevWireRequest } from '@jevris/contracts';
import { JevClient, type AskResult } from '@jevris/core';
import { createDeadline } from '@jevris/platform';
import { createMockFetch, type ConformanceScenario, type MockFetch } from './conformance-mock.js';
import type { FetchLike } from './sdk-transport.js';

/** A fixed, non-sensitive request: the §23.2 example shape with all three primitives. */
export const CONFORMANCE_REQUEST: JevWireRequest = Object.freeze({
  model: PINNED_MODEL,
  state: {
    task: 'Add an optional display label to an existing response',
    facts: { publicApiChanged: true, compatibilityRequired: true, migrationPresent: false },
    missingEvidence: ['consumer compatibility test result'],
    untrustedEvidence: [{ id: 'e1', text: 'Existing consumers deserialize this response.' }],
  },
  questions: {
    taskFamily: {
      type: 'choice',
      instructions: 'Which listed task family best describes this request?',
      criteria: {
        documentation: 'Only documentation text changes.',
        compatible_api_change: 'An existing API changes while compatibility is required.',
        data_migration: 'Stored data must be transformed.',
        unknown: 'The evidence is insufficient or another family fits.',
      },
    },
    changeRisk: {
      type: 'score',
      instructions: 'How far does this change reach?',
      criteria: [
        'Documentation only, no executable behaviour.',
        'A local, reversible implementation change.',
        'Crosses a public interface or persistence.',
        'Touches authorization, destructive migration or critical availability.',
      ],
    },
    compatibilityEvidenceMissing: {
      type: 'noul',
      instructions: 'Is required compatibility evidence missing from the supplied packet?',
    },
  },
}) as JevWireRequest;

export interface ConformanceExpectation {
  readonly ok: boolean;
  readonly reasonCode?: string;
  readonly failure?: string;
  readonly schemaFailure?: string;
}

export const CONFORMANCE_CASES: ReadonlyArray<{ readonly scenario: ConformanceScenario; readonly expect: ConformanceExpectation }> = Object.freeze([
  { scenario: 'valid', expect: { ok: true } },
  { scenario: 'tie', expect: { ok: true } },
  { scenario: 'confident', expect: { ok: true } },
  { scenario: 'invalid-distribution', expect: { ok: false, reasonCode: 'INVALID_RESPONSE', schemaFailure: 'non-normalized-distribution' } },
  { scenario: 'model-mismatch', expect: { ok: false, reasonCode: 'MODEL_MISMATCH', schemaFailure: 'model-mismatch' } },
  { scenario: 'noul-confidence', expect: { ok: false, reasonCode: 'INVALID_RESPONSE', schemaFailure: 'noul-confidence' } },
  { scenario: 'extra-field', expect: { ok: false, reasonCode: 'INVALID_RESPONSE', schemaFailure: 'unexpected-field' } },
  { scenario: 'unknown-candidate', expect: { ok: false, reasonCode: 'INVALID_RESPONSE', schemaFailure: 'unknown-candidate' } },
  { scenario: 'not-json', expect: { ok: false, reasonCode: 'INVALID_RESPONSE', schemaFailure: 'not-json' } },
  { scenario: 'late', expect: { ok: false, reasonCode: 'DEADLINE', failure: 'timeout' } },
  { scenario: 'late-body', expect: { ok: false, reasonCode: 'DEADLINE', failure: 'timeout' } },
  { scenario: 'late-deaf', expect: { ok: false, reasonCode: 'DEADLINE', failure: 'timeout' } },
  { scenario: 'http-400', expect: { ok: false, reasonCode: 'INVALID_REQUEST', failure: 'invalid-request' } },
  { scenario: 'http-401', expect: { ok: false, reasonCode: 'PROVIDER_ERROR', failure: 'auth' } },
  { scenario: 'http-403', expect: { ok: false, reasonCode: 'PROVIDER_ERROR', failure: 'forbidden' } },
  { scenario: 'http-422', expect: { ok: false, reasonCode: 'INVALID_REQUEST', failure: 'invalid-request' } },
  { scenario: 'http-429', expect: { ok: false, reasonCode: 'PROVIDER_ERROR', failure: 'rate-limited' } },
  { scenario: 'http-500', expect: { ok: false, reasonCode: 'PROVIDER_ERROR', failure: 'server' } },
  { scenario: 'http-529', expect: { ok: false, reasonCode: 'PROVIDER_ERROR', failure: 'overloaded' } },
  { scenario: 'aborted', expect: { ok: false, reasonCode: 'CANCELLED', failure: 'cancelled' } },
  { scenario: 'oversize', expect: { ok: false, reasonCode: 'INVALID_RESPONSE', failure: 'response-too-large' } },
  { scenario: 'connection', expect: { ok: false, reasonCode: 'PROVIDER_ERROR', failure: 'connection' } },
]);

export interface ConformanceOutcome {
  readonly scenario: ConformanceScenario;
  readonly ok: boolean;
  readonly reasonCode: string | null;
  readonly failure: string | null;
  readonly schemaFailure: string | null;
  readonly sent: boolean;
  readonly passed: boolean;
}

export function summarize(scenario: ConformanceScenario, result: AskResult, expect: ConformanceExpectation): ConformanceOutcome {
  const outcome = {
    scenario,
    ok: result.ok,
    reasonCode: result.ok ? null : result.reasonCode,
    failure: result.ok ? null : result.failure,
    schemaFailure: result.ok ? null : result.schemaFailure?.kind ?? null,
    sent: result.ok ? true : result.sent,
  };
  const passed =
    outcome.ok === expect.ok &&
    (expect.reasonCode === undefined || outcome.reasonCode === expect.reasonCode) &&
    (expect.failure === undefined || outcome.failure === expect.failure) &&
    (expect.schemaFailure === undefined || outcome.schemaFailure === expect.schemaFailure);
  return { ...outcome, passed };
}

/** Runs every case through `makeTransport(fetch)` with a hot-path budget. */
export async function runConformance(makeTransport: (fetch: FetchLike) => JevTransport, budgetMs = 400): Promise<readonly ConformanceOutcome[]> {
  const out: ConformanceOutcome[] = [];
  for (const { scenario, expect } of CONFORMANCE_CASES) {
    const fetch: MockFetch = createMockFetch({ scenario, lateMs: budgetMs * 10 });
    const client = new JevClient({ transport: makeTransport(fetch) });
    const controller = new AbortController();
    const timer = scenario === 'aborted' ? setTimeout(() => controller.abort(), 20) : undefined;
    const result = await client.ask({
      request: CONFORMANCE_REQUEST,
      lane: 'interactive',
      deadline: createDeadline(budgetMs),
      signal: controller.signal,
    });
    if (timer !== undefined) clearTimeout(timer);
    out.push(summarize(scenario, result, expect));
  }
  return out;
}

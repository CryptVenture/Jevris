/**
 * The inventory of every place the product asks Jev (read from the source on 2026-10-03, checked
 * against it by `features-inventory.test.mjs`). The feature suite covers each entry once; the report
 * says which entries are live on a hook or an op, which run only when a caller asks, and which no code
 * path reaches.
 *
 * `wiring`:
 *  - `hot`: runs inside a hook or op a person waits for, with a Jev wait of at most 700 ms;
 *  - `detached`: runs after the hook has answered; its line waits for the session's next event;
 *  - `on-demand`: runs only when an agent or a person calls the op or the tool (`capability.advise`,
 *    `checkpoint`, `recover`, `plan` with requirements or candidates);
 *  - `dormant`: the code exists and is tested, but no hook or op supplies what it needs, so it never runs;
 *  - `not-asked`: a question is defined and nothing asks it.
 * `egress`: `features` (counts, categories and codes only: allowed with egress denied) or `text`
 * (the question carries workspace text: asked only with source egress approved).
 */
export type InventoryWiring = 'hot' | 'detached' | 'on-demand' | 'dormant' | 'not-asked';

export interface InventoryEntry {
  readonly spec: string;
  readonly kind: string;
  /** Repository path of the source that asks. */
  readonly file: string;
  /** A string the file must contain: the spec id, or the capability's own `id: 'Cnn'`. */
  readonly needle: string;
  readonly wiring: InventoryWiring;
  readonly egress: 'features' | 'text';
  readonly note: string;
}

const CORE = 'packages/core/src/';
const PROV = 'packages/provider-typesafe/src/';
const ORCH = 'packages/orchestrator/src/';

function capability(id: string, kind: string, file: string, note: string, egress: 'features' | 'text' = 'features', wiring: InventoryWiring = 'on-demand'): InventoryEntry {
  return { spec: `d-${id.toLowerCase()}`, kind, file: `${ORCH}${file}`, needle: `id: '${id}'`, wiring, egress, note };
}

export const FEATURE_INVENTORY: readonly InventoryEntry[] = [
  { spec: 'slice-classify', kind: 'Choice (11 slices + unknown) and Score (risk, 5 anchors)', file: `${CORE}slice-classifier.ts`, needle: 'sliceQuestions', wiring: 'hot', egress: 'features', note: 'route op, plan op, plan submit; rules first, Jev only when they are not sure and no protected path is touched' },
  { spec: 'check-relevance', kind: 'N Score (one per open check, at most 12)', file: `${CORE}check-relevance.ts`, needle: 'CHECK_RELEVANCE_SPEC_ID', wiring: 'hot', egress: 'features', note: 'Stop hook and verify; the Jev wait is the time left minus 450 ms, at most 700 ms' },
  { spec: 'repeated-failure', kind: 'Noul (same failure) and Choice (next artifact)', file: `${PROV}failure-advice.ts`, needle: 'REPEATED_FAILURE_SPEC_ID', wiring: 'detached', egress: 'features', note: 'repeated-failure trigger; one line for the next event; 1500 ms detached deadline' },
  { spec: 'new-task', kind: 'two Choices (workflow family, open question)', file: `${PROV}new-task-advice.ts`, needle: 'NEW_TASK_SPEC_ID', wiring: 'detached', egress: 'text', note: 'reads the prompt as one screened span: asked only with source egress approved' },
  { spec: 'c01-task-family', kind: 'Choice', file: `${CORE}intent-decisions.ts`, needle: "'c01-task-family'", wiring: 'dormant', egress: 'text', note: 'triageTaskFamily: reached only by the older new-task handler when the event body carries task templates; no adapter supplies them' },
  { spec: 'c02-ambiguity', kind: 'Noul per explicit unknown', file: `${CORE}intent-decisions.ts`, needle: "'c02-ambiguity'", wiring: 'dormant', egress: 'text', note: 'detectAmbiguity: needs explicit unknowns in the event body; no adapter supplies them' },
  { spec: 'c03-decomposition', kind: 'Score per requirement', file: `${CORE}intent-decisions.ts`, needle: "'c03-decomposition'", wiring: 'on-demand', egress: 'text', note: 'plan op with requirements' },
  { spec: 'c04-template', kind: 'Choice', file: `${CORE}intent-decisions.ts`, needle: "'c04-template'", wiring: 'dormant', egress: 'features', note: 'shortlistTemplates: needs trusted installed templates; none ship' },
  { spec: 'c05-evidence', kind: 'Noul + Choice', file: `${CORE}intent-decisions.ts`, needle: "'c05-evidence'", wiring: 'dormant', egress: 'text', note: 'checkEvidenceSufficiency: needs a required-artifact list from the event body; no adapter supplies it' },
  { spec: 'c06-scope', kind: 'Noul per requested effect', file: `${CORE}intent-decisions.ts`, needle: "'c06-scope'", wiring: 'dormant', egress: 'text', note: 'detectScopeChange: needs a scope object in the event body; no adapter supplies it' },
  { spec: 'c07-plan-rank', kind: 'Score per candidate plan', file: `${CORE}intent-decisions.ts`, needle: "'c07-plan-rank'", wiring: 'on-demand', egress: 'text', note: 'plan op with candidates' },
  { spec: 'c51-injection-suspicion', kind: 'Noul', file: `${CORE}security-advice.ts`, needle: "'c51-injection-suspicion'", wiring: 'detached', egress: 'features', note: 'security subscriber on every tool result; asked only when the rules found a partial signal' },
  { spec: 'c49-permission-triage', kind: 'Score', file: `${CORE}security-advice.ts`, needle: "'c49-permission-triage'", wiring: 'detached', egress: 'features', note: 'security subscriber before a tool call; Jev can only raise the rules level' },
  { spec: 'worker-readiness', kind: 'Noul', file: `${CORE}route-worker.ts`, needle: 'WORKER_READINESS_QUESTIONS', wiring: 'not-asked', egress: 'features', note: 'defined as the calibration key of worker routing; no code path asks it' },
  { spec: 'health-probe', kind: 'Noul (fixed question, no content)', file: `${CORE}decision-engine.ts`, needle: 'PROBE_QUESTIONS', wiring: 'hot', egress: 'features', note: 'one bounded probe while the circuit is half-open' },
  capability('C25', 'Choice per task pair', 'capabilities/orchestration.ts', 'dependency suggestion for a plan', 'text'),
  { ...capability('C26', 'Choice', 'capabilities/orchestration.ts', 'worker-role allocation; option texts quote installed agent descriptions', 'text'), wiring: 'on-demand' },
  capability('C28', 'Noul per active task pair', 'capabilities/orchestration.ts', 'duplicate work; needs two active owned tasks', 'text'),
  capability('C30', 'Noul', 'capabilities/orchestration.ts', 'handoff readiness', 'text'),
  capability('C32', 'Choice', 'capabilities/research.ts', 'workflow-surface recommendation; a Choice only for the Claude harness (the others have one option)'),
  capability('C33', 'Choice', 'capabilities/retrieval.ts', 'skill shortlist; option texts quote installed skill descriptions', 'text'),
  capability('C34', 'Score per candidate span', 'capabilities/retrieval.ts', 'repository evidence retrieval', 'text'),
  capability('C35', 'Score', 'capabilities/retrieval.ts', 'documentation relevance', 'text'),
  capability('C36', 'Choice', 'capabilities/retrieval.ts', 'tool selection; option texts quote tool descriptions', 'text'),
  capability('C37', 'Noul', 'capabilities/retrieval.ts', 'argument preflight', 'text'),
  capability('C38', 'Choice', 'capabilities/retrieval.ts', 'environment triage of a recorded output', 'text'),
  capability('C40', 'Score', 'capabilities/research.ts', 'visual finding severity', 'text'),
  capability('C41', 'Score per optional check', 'capabilities/verification.ts', 'test-impact ranking'),
  capability('C42', 'Choice', 'capabilities/verification.ts', 'failure-cluster ranking; option texts quote failure lines', 'text'),
  capability('C43', 'Score per patch', 'capabilities/verification.ts', 'patch ranking', 'text'),
  capability('C44', 'Score per area', 'capabilities/verification.ts', 'review-area ranking'),
  capability('C45', 'Noul per requirement', 'capabilities/verification.ts', 'requirements audit', 'text'),
  capability('C46', 'Choice', 'capabilities/verification.ts', 'flaky-test advice'),
  capability('C47', 'Noul', 'capabilities/verification.ts', 'security escalation'),
  capability('C57', 'Score', 'capabilities/delivery.ts', 'PR readiness; asked only when every other readiness fact holds'),
  capability('C58', 'Choice', 'capabilities/delivery.ts', 'CI failure triage', 'text'),
  capability('C59', 'Score per dependency upgrade', 'capabilities/delivery.ts', 'dependency-upgrade risk; the package name goes out only with egress approved'),
  capability('C60', 'Noul', 'capabilities/delivery.ts', 'migration rehearsal', 'text'),
  capability('C61', 'Score', 'capabilities/delivery.ts', 'documentation drift', 'text'),
  capability('C62', 'Score', 'capabilities/research.ts', 'release evidence risk'),
  capability('C64', 'Choice', 'capabilities/delivery.ts', 'team policy reuse'),
  capability('C67', 'Score', 'capabilities/research.ts', 'prompt-revision clarity', 'text'),
  capability('C68', 'Choice', 'capabilities/research.ts', 'isolated candidate selection'),
  capability('C69', 'Score', 'capabilities/research.ts', 'evidence-conflict materiality', 'text'),
  capability('C70', 'Choice', 'capabilities/research.ts', 'canary module for a staged migration; option texts are module paths', 'text'),
  capability('C72', 'Choice', 'capabilities/research.ts', 'host-triage recommendation'),
  { spec: 'd-c18', kind: 'Score per optional capsule item', file: `${ORCH}memory/capsule.ts`, needle: "capabilityId: 'C18'", wiring: 'on-demand', egress: 'text', note: 'checkpoint op; needs the user preference privacy.sourceEgress approved-scoped and 1.5 s left' },
  { spec: 'd-c19', kind: 'Noul', file: `${ORCH}memory/readiness.ts`, needle: "capabilityId: 'C19'", wiring: 'dormant', egress: 'text', note: 'compactionReadiness has no caller' },
  { spec: 'd-c20', kind: 'Noul', file: `${ORCH}memory/audit.ts`, needle: "capabilityId: 'C20'", wiring: 'dormant', egress: 'text', note: 'auditOmissions has no caller outside tests' },
  { spec: 'd-c21', kind: 'Choice', file: `${ORCH}memory/rehydrate.ts`, needle: "capabilityId: 'C21'", wiring: 'dormant', egress: 'text', note: 'the only caller passes a capsule id, so the Choice never fires' },
  { spec: 'd-c22', kind: 'Score per span', file: `${ORCH}memory/distill.ts`, needle: "capabilityId: 'C22'", wiring: 'dormant', egress: 'text', note: 'verify passes no engine to the distiller' },
  { spec: 'd-c23', kind: 'Noul', file: `${ORCH}memory/facts.ts`, needle: "capabilityId: 'C23'", wiring: 'dormant', egress: 'text', note: 'triageContradictions has no caller' },
  { spec: 'd-c24', kind: 'Score per memory item', file: `${ORCH}memory/facts.ts`, needle: "capabilityId: 'C24'", wiring: 'dormant', egress: 'text', note: 'retrieveProjectMemory has no caller' },
  { spec: 'd-c29', kind: 'Choice', file: `${ORCH}orchestration/loops.ts`, needle: "capabilityId: 'C29'", wiring: 'on-demand', egress: 'text', note: 'recover op: loop advice when two different failures were each seen once' },
];

/** The count by wiring, for the report. */
export function inventoryByWiring(): Readonly<Record<InventoryWiring, number>> {
  const out: Record<InventoryWiring, number> = { hot: 0, detached: 0, 'on-demand': 0, dormant: 0, 'not-asked': 0 };
  for (const entry of FEATURE_INVENTORY) out[entry.wiring] += 1;
  return out;
}

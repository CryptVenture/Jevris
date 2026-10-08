import { ADVISE_CAPABILITY_IDS, DELIVERY_REPORTS } from '@jevris/contracts';

/**
 * The inventory of every place the product asks Jev (read from the source on 2026-10-03 and rewired on 2026-10-04, checked
 * against it by `features-inventory.test.mjs`). The feature suite covers each entry once; the report says which entries
 * are live on a hook or an op, which run only when a caller asks, and which no code path reaches. The test fails on any entry
 * that is `dormant` or `not-asked`, on any file or consult site that asks Jev and is not listed, and on a capability that no
 * command, tool or op can reach.
 *
 * `wiring`:
 *  - `hot`: runs inside a hook or op a person waits for, with a Jev wait of at most 700 ms;
 *  - `detached`: runs after the hook or op has answered (a line waits for the session's next event, or the work goes on in
 *    the background); nothing waits on it;
 *  - `on-demand`: runs only when an agent or a person calls the op or the tool (`capability.advise`, `checkpoint`, `recover`,
 *    `plan` with requirements or candidates);
 *  - `dormant`: the code exists and is tested, but no hook, op, command or tool supplies what it needs, so it never runs;
 *  - `not-asked`: a question is defined and nothing asks it.
 * `egress`: `features` (counts, categories and codes only: allowed with egress denied) or `text` (the question carries
 * workspace text or is about it, a query, a span, a diff, a requirement, a name or an id a person gave: asked only with source
 * egress approved, by the administrator and by the person's own preference). With egress denied the packet builder withholds
 * evidence text and sends a salted hash and a length, which Jev cannot judge, so a `text` capability's consult sets
 * `sendsWorkspaceText` and is not asked: the rules answer, no request, no decision. A `features` entry holds everything its
 * question needs in `facts`, so the evidence it also carries (withheld) adds nothing. `jev-feature-egress.test.mjs` checks the
 * field against the feature cases, which run each capability with egress denied and approved.
 * `entry`: where in the product it is reached (a hook event, an op, a command or a tool), named so a reader can find it.
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
  /** The real entry that reaches it: a hook event, an op, a command or a tool. */
  readonly entry: string;
  readonly note: string;
}

const CORE = 'packages/core/src/';
const PROV = 'packages/provider-typesafe/src/';
const ORCH = 'packages/orchestrator/src/';

/** The capability ids a command and a tool name: `jevris advise <id>` with `jevris_advise`, and `jevris delivery <name>` with `jevris_delivery_report`. */
const ADVISE_IDS: readonly string[] = ADVISE_CAPABILITY_IDS;
const REPORT_IDS: readonly string[] = Object.values(DELIVERY_REPORTS);

/** The entry of a capability that no command or tool names: only the `capability.advise` op reaches it. */
export const OP_ONLY_ENTRY = 'the capability.advise op (no command or tool names this id)';

function capability(id: string, kind: string, file: string, note: string, egress: 'features' | 'text' = 'features', wiring: InventoryWiring = 'on-demand', entryOverride?: string): InventoryEntry {
  const entry = entryOverride ?? (ADVISE_IDS.includes(id) ? `jevris advise ${id} and the jevris_advise tool (the capability.advise op)` : REPORT_IDS.includes(id) ? `jevris delivery and the jevris_delivery_report tool (the capability.advise op)` : OP_ONLY_ENTRY);
  return { spec: `d-${id.toLowerCase()}`, kind, file: `${ORCH}${file}`, needle: `id: '${id}'`, wiring, egress, entry, note };
}

export const FEATURE_INVENTORY: readonly InventoryEntry[] = [
  { spec: 'slice-classify', kind: 'Choice (11 slices + unknown) and Score (risk, 5 anchors)', file: `${CORE}slice-classifier.ts`, needle: 'sliceQuestions', wiring: 'hot', egress: 'features', entry: 'the route op (jevris route), the plan op and plan submit', note: 'rules first; Jev only when they are not sure and no protected path is touched' },
  { spec: 'check-relevance', kind: 'N Score (one per open check, at most 12)', file: `${CORE}check-relevance.ts`, needle: 'CHECK_RELEVANCE_SPEC_ID', wiring: 'hot', egress: 'features', entry: 'the Stop hook and the verify op (jevris verify)', note: 'the Jev wait is the time left minus 450 ms, at most 700 ms' },
  { spec: 'repeated-failure', kind: 'Noul (same failure)', file: `${PROV}failure-advice.ts`, needle: 'REPEATED_FAILURE_SPEC_ID', wiring: 'detached', egress: 'features', entry: 'the repeated-failure trigger on a failed tool call (PostToolUseFailure and its equivalents)', note: 'one line for the next event; 1500 ms detached deadline; asked only when the signatures differ but the same call ran again with nothing edited; which artifact to get next is the rules\' priority pick and is not asked (measured live 2026-10-04: a Choice on the failure\'s first line cleared the floors in 2 of 24 answers; C05 asks Jev nothing)' },
  { spec: 'new-task', kind: 'C01, C04 and C02 over the request, one line', file: `${PROV}new-task-advice.ts`, needle: 'NEW_TASK_SPEC_ID', wiring: 'detached', egress: 'text', entry: 'the new-task trigger on a prompt (UserPromptSubmit and its equivalents)', note: 'reads the prompt as one screened span: asked only with source egress approved; the trigger and the line, the decisions are the three below' },
  { spec: 'c01-task-family', kind: 'Choice over the trusted workflow families', file: `${CORE}intent-decisions.ts`, needle: "'c01-task-family'", wiring: 'detached', egress: 'text', entry: 'the new-task trigger (newTaskAdvice runs triageTaskFamily)', note: 'the eight families that ship with Jevris, one built-in template each, unless the caller names installed templates; the request is one screened span' },
  { spec: 'c02-ambiguity', kind: 'Noul per open point', file: `${CORE}intent-decisions.ts`, needle: "'c02-ambiguity'", wiring: 'detached', egress: 'text', entry: 'the new-task trigger (newTaskAdvice runs detectAmbiguity)', note: 'five fixed open points (scope, acceptance, target, edge cases, compatibility), or the caller\'s own unknowns; at most one becomes the question' },
  { spec: 'c03-decomposition', kind: 'Score per requirement', file: `${CORE}intent-decisions.ts`, needle: "'c03-decomposition'", wiring: 'on-demand', egress: 'text', entry: 'the plan op with requirements (jevris plan --graph with a requirements list, and the jevris_plan tool)', note: 'one Score per requirement; the requirement text is evidence, so only with source egress approved; the result is a review score, never a feasibility verdict' },
  { spec: 'c04-template', kind: 'Choice over the matching trusted templates', file: `${CORE}intent-decisions.ts`, needle: "'c04-template'", wiring: 'detached', egress: 'features', entry: 'the new-task trigger (newTaskAdvice runs shortlistTemplates for the chosen family)', note: 'asked only when more than one trusted installed template matches the family; the built-in set has one per family, so it settles by rules' },
  { spec: 'c06-scope', kind: 'Noul per requested effect', file: `${CORE}intent-decisions.ts`, needle: "'c06-scope'", wiring: 'detached', egress: 'features', entry: 'the diff-boundary trigger (scopeChangeAdvice runs detectScopeChange)', note: 'a path outside the approved paths pauses by rule at once; the effect classes the permission triage saw (codes only) are the Jev question; a caller\'s free-text effect is text and needs egress approved' },
  { spec: 'c07-plan-rank', kind: 'Score per candidate plan', file: `${CORE}intent-decisions.ts`, needle: "'c07-plan-rank'", wiring: 'on-demand', egress: 'text', entry: 'the plan op with candidates (jevris plan --graph with a candidates list, and the jevris_plan tool)', note: 'one Score per candidate plan; the summaries are evidence, so only with source egress approved; the result is a review score, never a feasibility verdict' },
  { spec: 'c51-injection-suspicion', kind: 'Noul', file: `${CORE}security-advice.ts`, needle: "'c51-injection-suspicion'", wiring: 'detached', egress: 'features', entry: 'the security subscriber on every tool result', note: 'asked only when the rules found a partial signal' },
  { spec: 'c49-permission-triage', kind: 'Score', file: `${CORE}security-advice.ts`, needle: "'c49-permission-triage'", wiring: 'detached', egress: 'features', entry: 'the security subscriber before a tool call', note: 'Jev can only raise the rules level' },
  { spec: 'worker-readiness', kind: 'Noul', file: `${CORE}worker-readiness.ts`, needle: 'WORKER_READINESS_ADVICE_SPEC_ID', wiring: 'detached', egress: 'features', entry: 'the owned-worker launch (plan.submit, task.submit) and its counterfactual in observe and advise', note: 'advice recorded with the launch and shown by jevris explain and task.get; the launch never depends on it; the question is route-worker.ts WORKER_READINESS_QUESTIONS' },
  { spec: 'subagent-risk', kind: 'Choice (low, medium, high, unknown)', file: `${CORE}subagent-risk.ts`, needle: 'SUBAGENT_RISK_SPEC_ID', wiring: 'hot', egress: 'features', entry: 'the worker-creation trigger on a Claude Code PreToolUse Agent or Task call (subagentRouteAdvice)', note: 'rules first: a read-only built-in type is low risk and is never asked; a general-purpose or custom type is high by the rules and Jev is asked, from the type class and the input size bucket (no prompt or description), and may lower it to medium or low at the floors (the one question where Jev lowers); the wait is the time left minus 300 ms, at most 700 ms' },
  { spec: 'health-probe', kind: 'Noul (fixed question, no content)', file: `${CORE}decision-engine.ts`, needle: 'PROBE_QUESTIONS', wiring: 'hot', egress: 'features', entry: 'the decision engine while the circuit is half-open', note: 'one bounded probe while the circuit is half-open' },
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
  capability('C41', 'Score per optional check', 'capabilities/verification.ts', 'test-impact ranking; the test names, changed files and symbols are the evidence', 'text'),
  capability('C42', 'Choice', 'capabilities/verification.ts', 'failure-cluster ranking; option texts quote failure lines', 'text'),
  capability('C43', 'Score per patch', 'capabilities/verification.ts', 'patch ranking', 'text'),
  capability('C44', 'Score per area', 'capabilities/verification.ts', 'review-area ranking'),
  capability('C45', 'Noul per requirement', 'capabilities/verification.ts', 'requirements audit', 'text'),
  capability('C46', 'Choice', 'capabilities/verification.ts', 'flaky-test advice'),
  capability('C47', 'Noul', 'capabilities/verification.ts', 'security escalation'),
  capability('C57', 'Score', 'capabilities/delivery.ts', 'PR readiness; asked only when every other readiness fact holds; the changed file names are the evidence', 'text'),
  capability('C58', 'Choice', 'capabilities/delivery.ts', 'CI failure triage', 'text'),
  capability('C59', 'Score per dependency upgrade', 'capabilities/delivery.ts', 'dependency-upgrade risk; the package name goes out only with egress approved'),
  capability('C60', 'Noul', 'capabilities/delivery.ts', 'migration rehearsal', 'text'),
  capability('C61', 'Score', 'capabilities/delivery.ts', 'documentation drift', 'text'),
  capability('C62', 'Score', 'capabilities/research.ts', 'release evidence risk; the incident, check and exception ids and statuses a person named are the evidence', 'text'),
  capability('C64', 'Choice', 'capabilities/delivery.ts', 'team policy reuse'),
  capability('C67', 'Score', 'capabilities/research.ts', 'prompt-revision clarity', 'text'),
  capability('C68', 'Choice', 'capabilities/research.ts', 'isolated candidate selection; reachable only through the raw capability.advise op on purpose: it creates and removes git worktrees and applies candidate patches in them, which a tool that is read-only advice (jevris_advise) must not do, so exposing it needs its own design'),
  capability('C69', 'Score', 'capabilities/research.ts', 'evidence-conflict materiality; counts of conclusions and independent sources only'),
  capability('C70', 'Choice', 'capabilities/research.ts', 'canary module for a staged migration; option texts are module paths', 'text'),
  capability('C72', 'Choice', 'capabilities/research.ts', 'host-triage recommendation'),
  { spec: 'd-c18', kind: 'Score per optional capsule item', file: `${ORCH}memory/capsule.ts`, needle: "capabilityId: 'C18'", wiring: 'on-demand', egress: 'text', entry: 'the checkpoint op (jevris checkpoint, jevris_checkpoint)', note: 'needs the person\'s preference privacy.sourceEgress approved-scoped and the administrator\'s approval, and 1.5 s left' },
  { spec: 'd-c19', kind: 'Noul', file: `${ORCH}memory/readiness.ts`, needle: "capabilityId: 'C19'", wiring: 'on-demand', egress: 'features', entry: 'the checkpoint op with contextPercent (jevris checkpoint --context-percent, jevris_checkpoint)', note: 'asked only between 70 and 90 percent of the context, from counts and flags; native compaction is never deferred or started. No harness hook reports context use, so a caller says it' },
  { spec: 'd-c20', kind: 'Noul per unmatched optional decision', file: `${ORCH}memory/audit.ts`, needle: "capabilityId: 'C20'", wiring: 'hot', egress: 'text', entry: 'the PostCompact event, where the harness sends the compaction summary (Claude Code does; Codex when its event carries one)', note: 'exact items are matched by rules; a decision is judged by Jev only with egress approved; what was left out is restored first at the next SessionStart' },
  { spec: 'd-c21', kind: 'Choice over saved capsules', file: `${ORCH}memory/rehydrate.ts`, needle: "capabilityId: 'C21'", wiring: 'hot', egress: 'features', entry: 'the SessionStart(resume) event, when more than one capsule could continue the session', note: 'rules are sure when the newest capsule holds the most unfinished work; otherwise Jev picks from counts and an age bucket, with no text of any capsule' },
  { spec: 'd-c22', kind: 'Score per span of a long check output', file: `${ORCH}memory/distill.ts`, needle: "capabilityId: 'C22'", wiring: 'detached', egress: 'text', entry: 'the verify op (jevris verify), in the check run', note: 'at most 8 spans, asked together as one request of up to 8 questions (each span keeps its own answer, floor and fallback), only with egress approved by the administrator and the person; the check result is the runner\'s and is untouched' },
  { spec: 'd-c23', kind: 'Noul per constraint pair', file: `${ORCH}memory/facts.ts`, needle: "capabilityId: 'C23'", wiring: 'on-demand', egress: 'text', entry: 'the checkpoint op with new constraints (jevris checkpoint --constraint)', note: 'a new constraint against the held ones, at most 8 pairs, only with egress approved by both; a pair found contradictory becomes a hypothesis line, never a finding' },
  { spec: 'd-c24', kind: 'Score per project-memory entry', file: `${ORCH}memory/facts.ts`, needle: "capabilityId: 'C24'", wiring: 'hot', egress: 'text', entry: 'the SessionStart restore (compact and resume)', note: 'inert on purpose: entries are only those admitted by passing receipts or a named person (admitProjectMemory), and no command admits one in 1.2.0 because admitting an entry is a provenance and consent question (a repository file is not consent) that needs its own design, so nothing is asked until some exist; Jev rescores only more than 5 entries, twelve to a request, with egress approved' },
  { spec: 'd-c29', kind: 'Choice', file: `${ORCH}orchestration/loops.ts`, needle: "capabilityId: 'C29'", wiring: 'on-demand', egress: 'features', entry: 'the recover op (jevris recover, jevris_recover)', note: 'loop advice when two different failures were each seen once; the facts hold closed family codes, counts, flags and artifact vocabulary ids, and the failure text is withheld evidence, so it is asked with egress denied too' },
];

/** The count by wiring, for the report. */
export function inventoryByWiring(): Readonly<Record<InventoryWiring, number>> {
  const out: Record<InventoryWiring, number> = { hot: 0, detached: 0, 'on-demand': 0, dormant: 0, 'not-asked': 0 };
  for (const entry of FEATURE_INVENTORY) out[entry.wiring] += 1;
  return out;
}

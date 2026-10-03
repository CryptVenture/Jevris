/**
 * Intent and planning decisions (INT-01..INT-07, §12.1 C01..C07).
 *
 * Each capability runs deterministic checks first and asks Jev only the bounded question the
 * catalogue names: a Choice for triage and template selection, a Noul for ambiguity, evidence
 * sufficiency and scope change, a Score for the decomposition audit and plan ranking. Question
 * text and rubric anchors are fixed templates; untrusted text (the objective, requirements,
 * diffs) travels only as packet evidence, never as a question or an option key.
 *
 * Every result is advice. Nothing here installs a template, invents an answer, approves a scope
 * change, marks unavailable evidence as absent behaviour, or calls a Score feasibility.
 */
import { isAbsoluteOnAnyPlatform } from '@jevris/platform';
import { FAILURE_ARTIFACT_IDS, type JevQuestions, type TaskNode } from '@jevris/contracts';
import { JEV_TARIFF, decide, type DecideOptions, type DecideOutcome, type DecideRequest, type DecisionEngine } from './decision-engine.js';
import { jevCostMicroUsd } from './decision-budget.js';
import { DecisionRescheduler } from './decision-reschedule.js';
import { estimateRequest } from './decision-tokens.js';
import { compileDecisionSpec } from './decision-question-lint.js';
import { planTaskGraph } from './decision-plan.js';
import type { PacketEvidence, PacketInput } from './packet.js';

const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_ITEMS = 12;

export interface IntentContext {
  readonly workspaceId: string;
  readonly evidenceRevision: string;
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly deadlineMs?: number;
  readonly options?: DecideOptions;
  /**
   * DEC-12, US31: the repository revision now. A result that arrives after it moved is stale:
   * recorded for analysis, never acted on.
   */
  readonly currentRevision?: () => string | null;
  /**
   * Whether a fresh decision on the new revision is still worth making (for example no newer
   * event superseded this one). Absent: never rescheduled.
   */
  readonly stillUseful?: () => boolean;
}

/** One rescheduler per process: a stale decision is rescheduled at most once. */
const RESCHEDULER = new DecisionRescheduler();

type Answers = Readonly<Record<string, { readonly type: string; readonly [key: string]: unknown }>>;
type Asked = { readonly ok: true; readonly answers: Answers; readonly decisionId: string } | { readonly ok: false; readonly reasonCode: string; readonly decisionId: string | null };

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

function safeId(value: string, fallback: string): string {
  return EVIDENCE_ID.test(value) ? value : fallback;
}

/**
 * One bounded Jev call through the engine; any failure is a named abstention. A question that
 * is only meaningful with evidence text is not asked while source egress is not approved: the
 * packet would carry structured features only (GOV-01), so the capability stays rules-only.
 */
async function ask(engine: DecisionEngine | null, specId: string, questions: JevQuestions, packet: PacketInput, ctx: IntentContext, needsEvidenceText = true): Promise<Asked> {
  if (engine === null) return { ok: false, reasonCode: 'PROVIDER_NOT_CONFIGURED', decisionId: null };
  if (needsEvidenceText && packet.evidence.length > 0 && (engine.sourceEgress?.() ?? 'denied') !== 'approved') return { ok: false, reasonCode: 'EGRESS_NOT_APPROVED', decisionId: null };
  const mandatory = packet.evidence.filter((e) => e.priority === 'mandatory').map((e) => e.id);
  const compiled = compileDecisionSpec({ id: specId, version: 'v1', questions, evidenceRequirements: mandatory, deadlineMs: ctx.deadlineMs ?? 2000, fallback: 'rules-only' });
  if (!compiled.ok) return { ok: false, reasonCode: 'QUESTION_LINT', decisionId: null };
  const request: DecideRequest = {
    spec: compiled.spec,
    questions,
    packet,
    workspaceId: ctx.workspaceId,
    evidenceRevision: ctx.evidenceRevision,
    ...(ctx.taskId === undefined ? {} : { taskId: ctx.taskId }),
    ...(ctx.sessionId === undefined ? {} : { sessionId: ctx.sessionId }),
  };
  const options: DecideOptions = { ...(ctx.options ?? {}), ...(ctx.currentRevision === undefined ? {} : { currentRevision: ctx.currentRevision }) };
  let outcome: DecideOutcome = await decide(request, engine, options);
  if (outcome.abstained && outcome.reasonCode === 'STALE_REVISION' && ctx.currentRevision !== undefined && ctx.stillUseful !== undefined) {
    // US31: the late result stays in the journal as stale. A fresh decision on the new revision
    // runs once, only if still useful and affordable (core DecisionRescheduler).
    const currentRevision = ctx.currentRevision;
    const stillUseful = ctx.stillUseful;
    const estimate = estimateRequest({ model: 'jev-estimate', state: packet, questions } as unknown as Parameters<typeof estimateRequest>[0]);
    const [result] = await RESCHEDULER.run({
      engine,
      stale: [{ decisionId: outcome.decisionId, evidenceRevision: ctx.evidenceRevision, specId, workspaceId: ctx.workspaceId, taskId: ctx.taskId ?? null }],
      currentRevision: () => currentRevision(),
      stillUseful: () => stillUseful(),
      rebuild: (_stale, revision) => ({ ...request, evidenceRevision: revision }),
      estimateMicroUsd: jevCostMicroUsd(estimate.totalTokens, 0, JEV_TARIFF),
      options,
    });
    if (result !== undefined && result.rescheduled) outcome = result.outcome;
  }
  if (outcome.abstained) return { ok: false, reasonCode: outcome.reasonCode, decisionId: outcome.decisionId };
  return { ok: true, answers: outcome.result.answers as Answers, decisionId: outcome.decisionId };
}

function choiceOf(answers: Answers, id: string): { choice: string; confidence: number; margin: number; probabilities: Readonly<Record<string, number>> } | null {
  const a = answers[id];
  if (a === undefined || a.type !== 'choice') return null;
  const probabilities = a['probabilities'] as Record<string, number>;
  const sorted = Object.values(probabilities).sort((x, y) => y - x);
  return { choice: String(a['choice']), confidence: Number(a['confidence']), margin: (sorted[0] ?? 0) - (sorted[1] ?? 0), probabilities };
}

function noulOf(answers: Answers, id: string): number | null {
  const a = answers[id];
  return a !== undefined && a.type === 'noul' && typeof a['noul'] === 'number' ? a['noul'] : null;
}

function scoreOf(answers: Answers, id: string): { score: number; anchor: string | null } | null {
  const a = answers[id];
  if (a === undefined || a.type !== 'score' || typeof a['score'] !== 'number') return null;
  const legend = a['legend'] as Record<string, string> | undefined;
  return { score: a['score'], anchor: legend?.[String(Math.round(a['score']))] ?? null };
}

/** The bounded-question helpers, shared with the security advice (C49, C51). */
export { ask as askBoundedDecision, noulOf as noulAnswer, scoreOf as scoreAnswer };

// ------------------------------------------------------------------------ INT-01 triage (C01)

export interface TemplateMeta {
  readonly id: string;
  readonly family: string;
  readonly summary: string;
  readonly tags?: readonly string[];
  /** Installed by the user or an admin, from a trusted source. */
  readonly trusted: boolean;
  readonly source: 'installed' | 'external';
}

export type TriageResult =
  | { readonly outcome: 'selected'; readonly family: string; readonly templateIds: readonly string[]; readonly confidence: number; readonly originalRequest: string; readonly decisionId: string }
  | { readonly outcome: 'abstain'; readonly reasonCode: string; readonly family: null; readonly originalRequest: string; readonly decisionId: string | null };

function usable(templates: readonly TemplateMeta[]): readonly TemplateMeta[] {
  return templates.filter((t) => t.trusted && t.source === 'installed' && EVIDENCE_ID.test(t.id));
}

/**
 * C01: a Choice over the families of trusted installed templates, plus `none` and `unknown`.
 * `none`, `unknown`, low confidence or a thin margin abstain; the request is always preserved.
 */
export async function triageTaskFamily(engine: DecisionEngine | null, input: { readonly objective: string; readonly templates: readonly TemplateMeta[]; readonly minConfidence?: number; readonly minMargin?: number }, ctx: IntentContext): Promise<TriageResult> {
  const originalRequest = input.objective;
  const templates = usable(input.templates);
  const families = [...new Set(templates.map((t) => t.family))].sort().slice(0, 30);
  if (families.length === 0) return { outcome: 'abstain', reasonCode: 'NO_TRUSTED_TEMPLATES', family: null, originalRequest, decisionId: null };
  const criteria: Record<string, string> = {};
  families.forEach((family, i) => {
    const summaries = templates.filter((t) => t.family === family).map((t) => t.summary);
    criteria[`f${i}`] = clip(`Workflow family ${family}: ${summaries.join('; ')}`, 400);
  });
  criteria['none'] = 'No listed workflow family fits this request.';
  criteria['unknown'] = 'The evidence is insufficient to choose a family.';
  const questions = { taskFamily: { type: 'choice', instructions: 'Which listed workflow family fits the objective?', criteria } } as unknown as JevQuestions;
  // The request is the person's own words: it travels as ONE screened evidence span, never in the
  // packet's objective, which is caller-authored and not screened. With source egress not approved
  // `ask` abstains (`EGRESS_NOT_APPROVED`) before anything is built or sent.
  const packet: PacketInput = {
    objective: 'Choose the workflow family that fits the request in the evidence item request.',
    trustedPolicy: { templateFamilies: families },
    facts: { templates: templates.length },
    evidence: [{ id: 'request', text: clip(input.objective, 2000), sourceKind: 'user', priority: 'mandatory' }],
  };
  const asked = await ask(engine, 'c01-task-family', questions, packet, ctx);
  if (!asked.ok) return { outcome: 'abstain', reasonCode: asked.reasonCode, family: null, originalRequest, decisionId: asked.decisionId };
  const c = choiceOf(asked.answers, 'taskFamily');
  if (c === null) return { outcome: 'abstain', reasonCode: 'NO_ANSWER', family: null, originalRequest, decisionId: asked.decisionId };
  if (c.choice === 'none') return { outcome: 'abstain', reasonCode: 'NO_TEMPLATE_FITS', family: null, originalRequest, decisionId: asked.decisionId };
  if (c.choice === 'unknown') return { outcome: 'abstain', reasonCode: 'FAMILY_UNKNOWN', family: null, originalRequest, decisionId: asked.decisionId };
  if (c.confidence < (input.minConfidence ?? 0.5) || c.margin < (input.minMargin ?? 0.15)) return { outcome: 'abstain', reasonCode: 'LOW_CONFIDENCE', family: null, originalRequest, decisionId: asked.decisionId };
  const family = families[Number(c.choice.slice(1))];
  if (family === undefined) return { outcome: 'abstain', reasonCode: 'UNKNOWN_OPTION', family: null, originalRequest, decisionId: asked.decisionId };
  return { outcome: 'selected', family, templateIds: templates.filter((t) => t.family === family).map((t) => t.id), confidence: c.confidence, originalRequest, decisionId: asked.decisionId };
}

// ------------------------------------------------------------- INT-02 template selection (C04)

export interface TemplateShortlist {
  readonly shortlist: readonly string[];
  /** External or untrusted suggestions: shown for manual review, never installed. */
  readonly external: readonly { readonly id: string; readonly action: 'review-manually' }[];
  readonly installActions: readonly never[];
  readonly reasonCode: string;
  readonly decisionId: string | null;
}

/**
 * C04: metadata only (id, family, summary, tags; there is no body field to load). A deterministic
 * tag and family prefilter keeps at most eight trusted installed candidates; a Choice orders them
 * when more than one remains.
 */
export async function shortlistTemplates(engine: DecisionEngine | null, input: { readonly taskProfile: { readonly family?: string; readonly tags: readonly string[] }; readonly templates: readonly TemplateMeta[]; readonly maxShortlist?: number }, ctx: IntentContext): Promise<TemplateShortlist> {
  const external = input.templates.filter((t) => !(t.trusted && t.source === 'installed')).map((t) => ({ id: clip(t.id, 128), action: 'review-manually' as const }));
  const tags = new Set(input.taskProfile.tags.map((t) => t.toLowerCase()));
  const scored = usable(input.templates)
    .map((t) => ({ t, s: (t.family === input.taskProfile.family ? 2 : 0) + (t.tags ?? []).filter((x) => tags.has(x.toLowerCase())).length }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (a.t.id < b.t.id ? -1 : 1))
    .slice(0, 8);
  const max = input.maxShortlist ?? 5;
  if (scored.length <= 1) return { shortlist: scored.map((x) => x.t.id), external, installActions: [], reasonCode: scored.length === 0 ? 'NO_MATCHING_TEMPLATE' : 'SINGLE_MATCH', decisionId: null };
  const criteria: Record<string, string> = {};
  scored.forEach((x, i) => (criteria[`t${i}`] = clip(`Template ${x.t.id} (${x.t.family}): ${x.t.summary}`, 400)));
  criteria['none'] = 'None of the listed templates fits this task.';
  criteria['unknown'] = 'The metadata is insufficient to choose.';
  const questions = { template: { type: 'choice', instructions: 'Which listed template best fits the task profile?', criteria } } as unknown as JevQuestions;
  const packet: PacketInput = { objective: 'Select a workflow template for the task profile.', trustedPolicy: {}, facts: { family: input.taskProfile.family ?? null, tags: [...tags].slice(0, 32) }, evidence: [] };
  const asked = await ask(engine, 'c04-template', questions, packet, ctx);
  const deterministic = scored.slice(0, max).map((x) => x.t.id);
  if (!asked.ok) return { shortlist: deterministic, external, installActions: [], reasonCode: asked.reasonCode, decisionId: asked.decisionId };
  const c = choiceOf(asked.answers, 'template');
  if (c === null) return { shortlist: deterministic, external, installActions: [], reasonCode: 'NO_ANSWER', decisionId: asked.decisionId };
  if (c.choice === 'none') return { shortlist: [], external, installActions: [], reasonCode: 'NO_TEMPLATE_FITS', decisionId: asked.decisionId };
  const ranked = scored
    .map((x, i) => ({ id: x.t.id, p: c.probabilities[`t${i}`] ?? 0 }))
    .filter((x) => x.p >= 0.05)
    .sort((a, b) => b.p - a.p || (a.id < b.id ? -1 : 1))
    .slice(0, max)
    .map((x) => x.id);
  return { shortlist: ranked, external, installActions: [], reasonCode: 'RANKED', decisionId: asked.decisionId };
}

// ------------------------------------------------------------------- INT-03 ambiguity (C02)

export interface ExplicitUnknown {
  readonly id: string;
  /** What is undecided, e.g. "Should the label be localized". */
  readonly topic: string;
  readonly options: readonly string[];
  /** What the choice decides, e.g. "the response schema and every consumer". */
  readonly consequence: string;
}

export type AmbiguityResult =
  | { readonly outcome: 'ask'; readonly question: { readonly unknownId: string; readonly text: string; readonly options: readonly string[] }; readonly answer: null; readonly materiality: number; readonly decisionId: string }
  | { readonly outcome: 'proceed'; readonly question: null; readonly answer: null; readonly reasonCode: string; readonly decisionId: string | null };

/**
 * C02: one Noul per explicit unknown ("does it materially change the implementation?"). At most
 * one consequence-focused question is asked, for the most material unknown above the threshold.
 * The answer is always left to the person.
 */
export async function detectAmbiguity(engine: DecisionEngine | null, input: { readonly objective: string; readonly unknowns: readonly ExplicitUnknown[]; readonly acceptanceCriteria?: readonly string[]; readonly interfaceContracts?: readonly string[]; readonly threshold?: number }, ctx: IntentContext): Promise<AmbiguityResult> {
  const unknowns = input.unknowns.filter((u) => u.topic.trim().length > 0).slice(0, MAX_ITEMS);
  if (unknowns.length === 0) return { outcome: 'proceed', question: null, answer: null, reasonCode: 'NO_EXPLICIT_UNKNOWNS', decisionId: null };
  const evidence: PacketEvidence[] = unknowns.map((u, i) => ({ id: `unknown-${i}`, text: clip(`${u.topic}. Options: ${u.options.join(' | ')}. Decides: ${u.consequence}.`, 1000), sourceKind: 'user', priority: 'mandatory' }));
  (input.acceptanceCriteria ?? []).slice(0, 16).forEach((text, i) => evidence.push({ id: `acceptance-${i}`, text: clip(text, 1000), sourceKind: 'user', priority: 'high' }));
  (input.interfaceContracts ?? []).slice(0, 8).forEach((text, i) => evidence.push({ id: `contract-${i}`, text: clip(text, 2000), sourceKind: 'file', priority: 'optional' }));
  const questions: Record<string, unknown> = {};
  unknowns.forEach((_, i) => {
    questions[`material${i}`] = {
      type: 'noul',
      instructions: `Would the options in evidence item unknown-${i} lead to different implementations?`,
      criteria: { true: 'The options lead to different code, interfaces or stored data.', false: 'Every listed option leads to the same implementation.' },
    };
  });
  const asked = await ask(engine, 'c02-ambiguity', questions as unknown as JevQuestions, { objective: clip(input.objective, 2000), trustedPolicy: {}, facts: { unknowns: unknowns.length }, evidence }, ctx);
  if (!asked.ok) return { outcome: 'proceed', question: null, answer: null, reasonCode: asked.reasonCode, decisionId: asked.decisionId };
  let best = -1;
  let bestP = -1;
  unknowns.forEach((_, i) => {
    const p = noulOf(asked.answers, `material${i}`) ?? -1;
    if (p > bestP) {
      bestP = p;
      best = i;
    }
  });
  const threshold = input.threshold ?? 0.6;
  const chosen = unknowns[best];
  if (chosen === undefined || bestP < threshold) return { outcome: 'proceed', question: null, answer: null, reasonCode: 'NOT_MATERIAL', decisionId: asked.decisionId };
  const text = clip(`${chosen.topic.replace(/[?.\s]+$/, '')}? This decides ${chosen.consequence.replace(/[.\s]+$/, '')}.${chosen.options.length > 0 ? ` Options: ${chosen.options.join(', ')}.` : ''}`, 500);
  return { outcome: 'ask', question: { unknownId: chosen.id, text, options: [...chosen.options] }, answer: null, materiality: bestP, decisionId: asked.decisionId };
}

// ---------------------------------------------------------- INT-04 evidence sufficiency (C05)

export interface RequiredArtifact {
  readonly id: string;
  readonly description: string;
  readonly available: boolean;
  /** null when freshness is not known. */
  readonly fresh: boolean | null;
  /** Where it can be read, when known. Used only inside an approved root. */
  readonly location?: string;
}

export type SufficiencyResult =
  | { readonly outcome: 'sufficient'; readonly notObserved: readonly string[]; readonly escalate: false; readonly reasonCode: string; readonly decisionId: string | null }
  /** Not assessed (no provider, egress not approved, abstention) or no artifact named: never claimed sufficient. */
  | { readonly outcome: 'undetermined'; readonly notObserved: readonly string[]; readonly escalate: false; readonly reasonCode: string; readonly decisionId: string | null }
  | {
      readonly outcome: 'request-artifact';
      readonly artifact: { readonly id: string; readonly description: string; readonly location: string | null };
      /** Evidence that could not be read: not observed, never "absent behaviour". */
      readonly notObserved: readonly string[];
      /** Always false: the artifact comes before stronger reasoning. */
      readonly escalate: false;
      readonly reasonCode: string;
      readonly decisionId: string | null;
    };

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Whether `location` is inside one of the approved roots (no traversal). */
/**
 * INT-05: whether a changed path is inside a task's write scopes. A scope is a
 * workspace-relative pattern (the TaskNode write-scope form): a directory or file covers itself
 * and everything below it, `*` matches within one path segment and `**` across segments. An
 * absolute path, a `..` segment or an empty scope never matches.
 */
export function withinWriteScopes(location: string, scopes: readonly string[]): boolean {
  const target = normalizePath(location).replace(/^\.\//, '');
  if (target.length === 0 || isAbsoluteOnAnyPlatform(target) || /^[A-Za-z]:/.test(target) || target.split('/').includes('..')) return false;
  return scopes.some((scope) => {
    const pattern = normalizePath(scope).replace(/^\.\//, '').replace(/\/+$/, '');
    if (pattern.length === 0 || isAbsoluteOnAnyPlatform(pattern) || /^[A-Za-z]:/.test(pattern) || pattern.split('/').includes('..')) return false;
    if (pattern === '.' || pattern === '**') return true;
    if (!pattern.includes('*')) return target === pattern || target.startsWith(`${pattern}/`);
    const source = pattern
      .split(/(\*\*|\*)/)
      .map((part) => (part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
      .join('');
    return new RegExp(`^${source}(?:/.*)?$`).test(target);
  });
}

export function withinApprovedRoots(location: string, roots: readonly string[]): boolean {
  const target = normalizePath(location);
  if (target.split('/').includes('..')) return false;
  return roots.some((root) => {
    const r = normalizePath(root);
    return r.length > 0 && (target === r || target.startsWith(`${r}/`));
  });
}

/**
 * C05: missing or stale required artifacts are requested first, by rule, with no call. When all
 * are present, a Noul asks whether the evidence suffices; if not, a Choice names the obtainable
 * artifact to fetch next. A location outside the approved roots is never suggested.
 */
export async function checkEvidenceSufficiency(
  engine: DecisionEngine | null,
  input: { readonly objective: string; readonly required: readonly RequiredArtifact[]; readonly obtainable?: readonly RequiredArtifact[]; readonly diagnostics?: readonly { readonly id: string; readonly text: string }[]; readonly approvedRoots: readonly string[]; readonly threshold?: number },
  ctx: IntentContext,
): Promise<SufficiencyResult> {
  const notObserved = input.required.filter((a) => !a.available).map((a) => a.id);
  const locate = (a: RequiredArtifact) => (a.location !== undefined && withinApprovedRoots(a.location, input.approvedRoots) ? a.location : null);
  const request = (a: RequiredArtifact, reasonCode: string, decisionId: string | null): SufficiencyResult => ({ outcome: 'request-artifact', artifact: { id: a.id, description: a.description, location: locate(a) }, notObserved, escalate: false, reasonCode, decisionId });
  const missing = input.required.find((a) => !a.available);
  if (missing !== undefined) return request(missing, 'MISSING_REQUIRED_ARTIFACT', null);
  const stale = input.required.find((a) => a.fresh === false);
  if (stale !== undefined) return request(stale, 'STALE_ARTIFACT', null);
  const obtainable = (input.obtainable ?? []).slice(0, 10);
  // An artifact of the fixed vocabulary (failing-test-output, stack-trace, ...) is named by its id
  // alone. A free-text description of any other artifact is the caller's text: it is read into a
  // request only with source egress approved, and is never put in a question.
  const known = new Set<string>(FAILURE_ARTIFACT_IDS);
  const approved = (engine?.sourceEgress?.() ?? 'denied') === 'approved';
  const evidence: PacketEvidence[] = [
    ...input.required.slice(0, 32).map((a, i) => ({ id: safeId(a.id, `artifact-${i}`), text: clip(known.has(a.id) ? a.id : a.description, 1000), sourceKind: 'tool' as const, priority: 'mandatory' as const })),
    ...(input.diagnostics ?? []).slice(0, 16).map((d, i) => ({ id: safeId(d.id, `diagnostic-${i}`), text: clip(d.text, 2000), sourceKind: 'tool' as const, priority: 'high' as const })),
  ];
  const questions: Record<string, unknown> = {
    sufficient: { type: 'noul', instructions: 'Does the supplied evidence identify the cause well enough to choose a fix?', criteria: { true: 'The evidence points to one cause and a fix can be chosen.', false: 'More evidence is needed before a fix can be chosen.' } },
  };
  if (obtainable.length > 0) {
    const criteria: Record<string, string> = {};
    obtainable.forEach((a, i) => (criteria[`a${i}`] = clip(known.has(a.id) ? `Artifact ${a.id}` : approved ? `Artifact ${a.id}: ${a.description}` : `Artifact number ${i + 1} in the list`, 300)));
    criteria['none'] = 'None of the listed artifacts would reduce the uncertainty.';
    criteria['unknown'] = 'The evidence is insufficient to tell which artifact helps.';
    questions['nextArtifact'] = { type: 'choice', instructions: 'Which listed artifact would most reduce the uncertainty about the cause?', criteria };
  }
  const asked = await ask(engine, 'c05-evidence', questions as unknown as JevQuestions, { objective: clip(input.objective, 2000), trustedPolicy: {}, facts: { required: input.required.length, obtainable: obtainable.length }, evidence }, ctx);
  if (!asked.ok) return { outcome: 'undetermined', notObserved, escalate: false, reasonCode: asked.reasonCode, decisionId: asked.decisionId };
  const p = noulOf(asked.answers, 'sufficient');
  if (p !== null && p >= (input.threshold ?? 0.5)) return { outcome: 'sufficient', notObserved, escalate: false, reasonCode: 'EVIDENCE_SUFFICIENT', decisionId: asked.decisionId };
  const next = obtainable.length === 0 ? null : choiceOf(asked.answers, 'nextArtifact');
  const pick = next === null || !/^a\d+$/.test(next.choice) ? undefined : obtainable[Number(next.choice.slice(1))];
  if (pick === undefined) return { outcome: 'undetermined', notObserved, escalate: false, reasonCode: 'INSUFFICIENT_NO_ARTIFACT_NAMED', decisionId: asked.decisionId };
  return request(pick, 'REQUEST_BEFORE_ESCALATION', asked.decisionId);
}

// -------------------------------------------------------------- INT-05 scope change (C06)

/** Channels an approval may come from. Repository text, tool output and web content never approve. */
export const TRUSTED_APPROVAL_CHANNELS = ['user-prompt', 'harness-approval', 'admin-cli'] as const;

export interface ScopeItem {
  readonly kind: 'path' | 'effect';
  readonly item: string;
}

export interface ScopeResult {
  readonly continue: readonly ScopeItem[];
  readonly paused: readonly (ScopeItem & { readonly explanation: string })[];
  readonly ignoredApprovals: readonly { readonly effect: string; readonly channel: string; readonly reasonCode: 'UNTRUSTED_APPROVAL_CHANNEL' }[];
  readonly decisionId: string | null;
}

/**
 * C06: a changed path outside the approved paths pauses by rule. A new requested effect that is
 * neither approved nor approved later through a trusted channel gets a Noul; above the threshold
 * it pauses, with an explanation. Only the out-of-scope portion pauses; the rest continues.
 */
export async function detectScopeChange(
  engine: DecisionEngine | null,
  input: {
    readonly approvedScope: { readonly paths: readonly string[]; readonly effects: readonly string[] };
    readonly diff: readonly { readonly path: string }[];
    readonly requestedEffects: readonly string[];
    readonly approvals?: readonly { readonly effect: string; readonly channel: string }[];
    readonly threshold?: number;
  },
  ctx: IntentContext,
): Promise<ScopeResult> {
  const trusted = new Set<string>(TRUSTED_APPROVAL_CHANNELS);
  const ignoredApprovals = (input.approvals ?? []).filter((a) => !trusted.has(a.channel)).map((a) => ({ effect: clip(a.effect, 200), channel: clip(a.channel, 64), reasonCode: 'UNTRUSTED_APPROVAL_CHANNEL' as const }));
  const approvedEffects = new Set([...input.approvedScope.effects, ...(input.approvals ?? []).filter((a) => trusted.has(a.channel)).map((a) => a.effect)].map((e) => e.trim().toLowerCase()));
  const cont: ScopeItem[] = [];
  const paused: (ScopeItem & { explanation: string })[] = [];
  for (const change of input.diff) {
    if (withinWriteScopes(change.path, input.approvedScope.paths)) cont.push({ kind: 'path', item: change.path });
    else paused.push({ kind: 'path', item: change.path, explanation: `${change.path} is outside the approved paths (${input.approvedScope.paths.join(', ')}); approve it in the session to continue this part.` });
  }
  const open: string[] = [];
  for (const effect of input.requestedEffects) {
    if (approvedEffects.has(effect.trim().toLowerCase())) cont.push({ kind: 'effect', item: effect });
    else open.push(effect);
  }
  const judged = open.slice(0, MAX_ITEMS);
  // Beyond the question limit, an unjudged new effect pauses: it was never approved.
  for (const effect of open.slice(MAX_ITEMS)) paused.push({ kind: 'effect', item: effect, explanation: 'This new effect was not approved and was not assessed; approve it in the session to continue.' });
  if (judged.length === 0) return { continue: cont, paused, ignoredApprovals, decisionId: null };
  const evidence: PacketEvidence[] = judged.map((effect, i) => ({ id: `effect-${i}`, text: clip(effect, 1000), sourceKind: 'user', priority: 'mandatory' }));
  const questions: Record<string, unknown> = {};
  judged.forEach((_, i) => {
    questions[`outside${i}`] = {
      type: 'noul',
      instructions: `Does the requested effect in evidence item effect-${i} go beyond the approved scope?`,
      criteria: { true: 'The effect adds behaviour, data or access the approved scope does not cover.', false: 'The effect is part of what the approved scope already covers.' },
    };
  });
  const asked = await ask(engine, 'c06-scope', questions as unknown as JevQuestions, { objective: 'Check new requested effects against the approved scope.', trustedPolicy: { approvedEffects: input.approvedScope.effects.slice(0, 32), approvedPaths: input.approvedScope.paths.slice(0, 32) }, facts: { newEffects: judged.length }, evidence }, ctx);
  const threshold = input.threshold ?? 0.5;
  judged.forEach((effect, i) => {
    const p = asked.ok ? noulOf(asked.answers, `outside${i}`) : null;
    // Without an answer the effect is still unapproved, so it pauses rather than proceeding.
    if (p === null || p >= threshold) paused.push({ kind: 'effect', item: effect, explanation: p === null ? `"${clip(effect, 120)}" was not approved and could not be assessed; approve it in the session to continue.` : `"${clip(effect, 120)}" goes beyond the approved scope; approve it in the session to continue this part.` });
    else cont.push({ kind: 'effect', item: effect });
  });
  return { continue: cont, paused, ignoredApprovals, decisionId: asked.decisionId };
}

// ------------------------------------------------------- INT-06 decomposition audit (C03)

export const COVERAGE_RUBRIC = [
  'No listed task addresses this requirement.',
  'A task mentions it but leaves most acceptance criteria unaddressed.',
  'Tasks address it but one acceptance criterion or an edge case is missing.',
  'Tasks address every acceptance criterion of this requirement.',
  'Tasks address every criterion, each in a task small enough to verify alone.',
] as const;

export interface DecompositionAudit {
  readonly valid: boolean;
  /** Deterministic findings: graph issues, uncovered requirements, oversized tasks. */
  readonly issues: readonly { readonly id: string; readonly code: string }[];
  /** The Score review; a review aid, never a feasibility verdict. */
  readonly coverageReview: readonly { readonly requirementId: string; readonly score: number; readonly anchor: string | null }[];
  readonly label: 'decomposition-review-score';
  readonly isFeasibility: false;
  readonly decisionId: string | null;
  readonly reasonCode: string;
}

/**
 * C03: ids, dependencies, cycles and write overlaps are checked in code first; an invalid graph
 * is reported without any call. Uncovered requirements and tasks spanning many requirements are
 * deterministic findings. A Score per requirement is added on top for review.
 */
export async function auditDecomposition(engine: DecisionEngine | null, input: { readonly requirements: readonly { readonly id: string; readonly text: string }[]; readonly tasks: readonly TaskNode[]; readonly maxRequirementsPerTask?: number }, ctx: IntentContext): Promise<DecompositionAudit> {
  const plan = planTaskGraph(input.tasks);
  const base = { label: 'decomposition-review-score' as const, isFeasibility: false as const };
  if (!plan.valid) return { ...base, valid: false, issues: plan.issues.map((i) => ({ id: i.taskId, code: i.code })), coverageReview: [], decisionId: null, reasonCode: 'GRAPH_INVALID' };
  const issues: { id: string; code: string }[] = plan.issues.map((i) => ({ id: i.taskId, code: i.code }));
  const covered = new Set(input.tasks.flatMap((t) => t.requirementIds));
  for (const r of input.requirements) if (!covered.has(r.id)) issues.push({ id: r.id, code: 'UNCOVERED_REQUIREMENT' });
  const max = input.maxRequirementsPerTask ?? 5;
  for (const t of input.tasks) if (t.requirementIds.length > max) issues.push({ id: t.id, code: 'OVERSIZED_TASK' });
  const reviewed = input.requirements.filter((r) => covered.has(r.id)).slice(0, MAX_ITEMS);
  if (reviewed.length === 0) return { ...base, valid: true, issues, coverageReview: [], decisionId: null, reasonCode: 'NOTHING_TO_SCORE' };
  const evidence: PacketEvidence[] = [
    ...reviewed.map((r, i) => ({ id: `requirement-${i}`, text: clip(`${r.id}: ${r.text}`, 1500), sourceKind: 'user' as const, priority: 'mandatory' as const })),
    { id: 'tasks', text: clip(input.tasks.map((t) => `${t.id} covers ${t.requirementIds.join(', ')}; checks ${t.acceptanceCheckIds.join(', ')}`).join('\n'), 4000), sourceKind: 'user', priority: 'mandatory' },
  ];
  const questions: Record<string, unknown> = {};
  reviewed.forEach((_, i) => (questions[`coverage${i}`] = { type: 'score', instructions: `How completely do the tasks in evidence item tasks cover the requirement in evidence item requirement-${i}?`, criteria: [...COVERAGE_RUBRIC] }));
  const asked = await ask(engine, 'c03-decomposition', questions as unknown as JevQuestions, { objective: 'Review how the task list covers each requirement.', trustedPolicy: {}, facts: { tasks: input.tasks.length, requirements: input.requirements.length }, evidence }, ctx);
  if (!asked.ok) return { ...base, valid: true, issues, coverageReview: [], decisionId: asked.decisionId, reasonCode: asked.reasonCode };
  const coverageReview: { requirementId: string; score: number; anchor: string | null }[] = [];
  reviewed.forEach((r, i) => {
    const s = scoreOf(asked.answers, `coverage${i}`);
    if (s === null) return;
    coverageReview.push({ requirementId: r.id, score: s.score, anchor: s.anchor });
    if (s.score < 2) issues.push({ id: r.id, code: 'REVIEW_COVERAGE' });
  });
  return { ...base, valid: true, issues, coverageReview, decisionId: asked.decisionId, reasonCode: 'SCORED' };
}

// ------------------------------------------------------------ INT-07 plan ranking (C07)

export const PLAN_RUBRIC = [
  'The plan ignores a stated constraint or names no trade-off.',
  'The plan meets some constraints; its trade-offs are vague.',
  'The plan meets the constraints with one unexplained trade-off.',
  'The plan meets every constraint and explains each trade-off.',
  'The plan meets every constraint, explains trade-offs and names how to check each step.',
] as const;

export interface PlanRanking {
  readonly ranking: readonly { readonly planId: string; readonly score: number | null; readonly rank: number; readonly anchor: string | null }[];
  /** Always true: the ranking is for a planner or strong-model review, not a selection. */
  readonly reviewRequired: true;
  readonly reviewStep: 'planner-review';
  readonly label: 'plan-review-score';
  readonly isFeasibility: false;
  readonly note: string;
  readonly decisionId: string | null;
  readonly reasonCode: string;
}

/** C07: a Score per bounded plan with ordinal anchors; ranked for review, never proof of feasibility. */
export async function rankPlanCandidates(engine: DecisionEngine | null, input: { readonly plans: readonly { readonly id: string; readonly summary: string; readonly constraints: readonly string[]; readonly tradeoffs: readonly string[] }[] }, ctx: IntentContext): Promise<PlanRanking> {
  const base = { reviewRequired: true as const, reviewStep: 'planner-review' as const, label: 'plan-review-score' as const, isFeasibility: false as const, note: 'A higher score is not evidence that a plan is feasible; review before choosing.' };
  const plans = input.plans.slice(0, MAX_ITEMS);
  const unranked = (reasonCode: string, decisionId: string | null): PlanRanking => ({ ...base, ranking: plans.map((p, i) => ({ planId: p.id, score: null, rank: i + 1, anchor: null })), decisionId, reasonCode });
  if (plans.length < 2) return unranked('FEWER_THAN_TWO_PLANS', null);
  const evidence: PacketEvidence[] = plans.map((p, i) => ({ id: `plan-${i}`, text: clip(`${p.summary}\nConstraints: ${p.constraints.join('; ')}\nTrade-offs: ${p.tradeoffs.join('; ')}`, 3000), sourceKind: 'user', priority: 'mandatory' }));
  const questions: Record<string, unknown> = {};
  plans.forEach((_, i) => (questions[`plan${i}`] = { type: 'score', instructions: `How well does the plan in evidence item plan-${i} meet its constraints with explained trade-offs?`, criteria: [...PLAN_RUBRIC] }));
  const asked = await ask(engine, 'c07-plan-rank', questions as unknown as JevQuestions, { objective: 'Rank bounded plan candidates for review.', trustedPolicy: {}, facts: { plans: plans.length }, evidence }, ctx);
  if (!asked.ok) return unranked(asked.reasonCode, asked.decisionId);
  const scored = plans.map((p, i) => ({ planId: p.id, ...(scoreOf(asked.answers, `plan${i}`) ?? { score: null, anchor: null }) }));
  scored.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || (a.planId < b.planId ? -1 : 1));
  return { ...base, ranking: scored.map((s, i) => ({ planId: s.planId, score: s.score, rank: i + 1, anchor: s.anchor })), decisionId: asked.decisionId, reasonCode: 'SCORED' };
}

/**
 * The fixed vocabulary of the new-task decisions (C01 task-family triage, C04 template selection and
 * C02 ambiguity detection). Everything here is written by Jevris and carries no text from the person,
 * the workspace or a tool: the workflow families that ship with Jevris, the one template each stands
 * for, and the open points a request can leave undecided. A question built from them is a fixed
 * template, so the only user text a new-task decision sends is the request itself, as one screened
 * evidence span, and only while source egress is approved.
 */
import type { ExplicitUnknown, TemplateMeta } from './intent-decisions.js';

/** The workflow families that ship with Jevris. No installed template catalogue exists beyond them. */
export const TASK_FAMILIES = ['bugfix', 'feature', 'refactor', 'tests', 'docs', 'investigation', 'config', 'dependency'] as const;
export type TaskFamily = (typeof TASK_FAMILIES)[number];

export const TASK_FAMILY_TEXT: Readonly<Record<TaskFamily, string>> = {
  bugfix: 'Fix a defect: something that should work does not, and the change restores the intended behaviour.',
  feature: 'Add new behaviour: a capability, option or interface that does not exist yet.',
  refactor: 'Restructure existing code without changing what it does.',
  tests: 'Add or repair tests without changing the behaviour under test.',
  docs: 'Write or correct documentation, comments or messages shown to people.',
  investigation: 'Find out how something works or why it behaves as it does, without changing code.',
  config: 'Change build, CI, tooling or settings files.',
  dependency: 'Add, remove or upgrade a dependency or a platform version.',
};

/** The id prefix of the templates that ship with Jevris; an advice line never names them (they are the families). */
export const BUILT_IN_TEMPLATE_PREFIX = 'jevris-';

/**
 * One trusted, installed template per family: Jevris's own. A caller that holds installed templates
 * of its own passes them instead (they are trusted only when they say so and are installed).
 */
export const BUILT_IN_TEMPLATES: readonly TemplateMeta[] = Object.freeze(
  TASK_FAMILIES.map((family) => Object.freeze({ id: `${BUILT_IN_TEMPLATE_PREFIX}${family}`, family, summary: TASK_FAMILY_TEXT[family], tags: [family], trusted: true, source: 'installed' as const })),
);

/** The kinds of open point, from a fixed list. */
export const OPEN_KINDS = ['scope', 'acceptance', 'target', 'edge-cases', 'compatibility'] as const;
export type OpenKind = (typeof OPEN_KINDS)[number];

/**
 * The open points C02 asks about when the caller names none: each one an explicit unknown a request
 * can leave undecided, with fixed options and a fixed consequence. C02 asks, for each, whether the
 * request leaves it open in a way that would change the implementation, and puts at most the most
 * material one to the person.
 */
export const OPEN_POINTS: readonly (ExplicitUnknown & { readonly id: OpenKind })[] = Object.freeze([
  { id: 'scope', topic: 'What is in scope, and what must stay as it is', options: [], consequence: 'which files and behaviours the change may touch' },
  { id: 'acceptance', topic: 'How will the result be shown to be correct', options: [], consequence: 'which check says that the task is done' },
  { id: 'target', topic: 'Which file, component or interface should change', options: [], consequence: 'where the change is made' },
  { id: 'edge-cases', topic: 'What should happen in the cases the request does not mention', options: [], consequence: 'how the change behaves outside the stated cases' },
  { id: 'compatibility', topic: 'Must existing behaviour or an interface stay compatible', options: [], consequence: 'whether callers and stored data may break' },
] as const);

/**
 * The effect classes a tool call can request (the permission triage's vocabulary, `EFFECT_CLASSES` of
 * `security-advice.ts`), each with one fixed phrase. `outside-scope-write` is left out: a write outside the
 * task's paths is judged by path, deterministically. C06 judges the rest against a task's approved scope.
 */
export const EFFECT_CLASS_TEXT = Object.freeze({
  'credential-access': 'Read or change a credential or secret location',
  'network-egress': 'Contact a network host outside the workspace policy',
  destructive: 'Delete or rewrite data that is hard to recover',
  privileged: 'Change privileges or system configuration',
  'package-install': 'Install or run third-party code',
  'ci-secrets': 'Touch CI secrets',
} as const);
export type ScopeEffectClass = keyof typeof EFFECT_CLASS_TEXT;

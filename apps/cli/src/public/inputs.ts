/**
 * Bounded, validated inputs for every surface operation. CLI flags and MCP arguments both end
 * up here; anything unexpected is refused before a sidecar call or a local read. No input is
 * ever a filesystem root, a home directory or a shell string.
 */
import { ADVISE_CAPABILITIES, AUTH_MODES, DELIVERY_REPORTS, HARNESS_IDS, HARNESS_MODEL_ID_PATTERN, type AuthMode, type HarnessId, type SurfaceOperation } from '@jevris/contracts';

export interface RouteTask {
  readonly title: string | null;
  readonly paths: readonly string[];
  readonly checkIds: readonly string[];
}

export interface OpInputs {
  readonly status: Record<string, never>;
  /** sliceId asks for that slice's route learning in the trace; absent, the op gets decisionId alone. */
  readonly explain: { readonly decisionId: string; readonly sliceId?: string };
  readonly route: {
    /** A harness model id (G20): `provider/model`, `[1m]` and a registry id are all accepted. */
    readonly currentModel: string | null;
    readonly modelPin: string | null;
    /** The harness the session runs in (G20), so main advice names only models it can run; null is unscoped. */
    readonly harness: HarnessId | null;
    /** The session's sign-in (G20); null leaves it to the session's own, `unknown` scopes nothing. */
    readonly authMode: AuthMode | null;
    readonly effortPin: string | null;
    readonly taskId: string | null;
    /** The task slice, so a released calibration for it can apply to worker advice. */
    readonly sliceId: string | null;
    /**
     * What the caller knows of the task (title, paths it will touch, check ids), so the slice can be
     * classified when no sliceId is given. Reduced to structured features before anything is sent.
     */
    readonly task?: RouteTask;
    /** The work left in the task, so the saving of a switch can be priced. */
    readonly remaining: RouteRemaining | null;
    /** The context the task needs, in tokens. */
    readonly contextTokens: number | null;
    /** The running session's switch facts: without a warm prefix a switch cannot be priced. */
    readonly session: RouteSession | null;
  };
  /** `requirements` and `candidates` (optional, checked by the op): what C03 reviews the task list against and the plans C07 ranks. */
  readonly plan: { readonly tasks: readonly unknown[]; readonly requirements?: readonly unknown[]; readonly candidates?: readonly unknown[] };
  /** `contextPercent`: how much of the context window is in use, 0 to 100, for compaction-readiness advice; null says nothing. */
  readonly checkpoint: { readonly objective: string | null; readonly constraints: readonly string[]; readonly decisions: readonly string[]; readonly taskId: string | null; readonly contextPercent: number | null };
  readonly recover: {
    readonly taskId: string | null;
    readonly signals: { readonly fingerprints: readonly string[]; readonly environment: readonly boolean[] };
    readonly rejectedApproaches: readonly string[];
  };
  readonly verify: { readonly taskId: string | null; readonly checkIds: readonly string[] };
  /** `confirmed`: the person confirmed a value that needs it (a terminal answer or --yes; CLI only). */
  readonly configure: { readonly set: { readonly key: string; readonly value: string } | null; readonly dryRun: boolean; readonly confirmed: boolean };
  readonly 'task.get': { readonly taskId: string };
  readonly 'evidence.select': { readonly intent: string; readonly maxItems: number };
  /** `selectionId`: the evidence selection that listed the handle (P10), or null. */
  readonly 'evidence.get': { readonly handle: string; readonly selectionId: string | null };
  readonly 'verification.record': { readonly receiptId: string; readonly checkId: string; readonly taskId: string | null };
  readonly 'task.submit': { readonly task: unknown };
  readonly 'handoff.export': { readonly capsuleId: string | null; readonly taskId: string | null };
  readonly 'handoff.import': { readonly capsule: unknown };
  readonly 'capability.advise': {
    /** One of the delivery capabilities (DELIVERY_REPORTS). */
    readonly capabilityId: string;
    readonly taskId: string | null;
    readonly input: DeliveryInput | AdviseInput;
  };
}

/** A plain JSON value, as a capability's input holds it. */
export type AdviseValue = string | number | boolean | readonly AdviseValue[] | { readonly [key: string]: AdviseValue };

/** What an orchestration, retrieval, verification or research capability may be told: only its own keys, each checked and bounded. */
export type AdviseInput = { readonly [key: string]: AdviseValue };

/** What a delivery report may be told; each field reaches only the capability that reads it. */
export interface DeliveryInput {
  /** The revision the change is measured from (C57, C59, C60, C61); default HEAD. */
  readonly base?: string;
  /** Unresolved review comments the caller counted (C57). */
  readonly unresolvedComments?: number;
  /** Migration files to check (C60), relative to the workspace; default the changed ones. */
  readonly migrations?: readonly string[];
  /** The backward-compatibility contract the migration must keep (C60). */
  readonly compatibility?: string;
}

export interface RouteRemaining {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface RouteSession {
  readonly warmPrefixTokens: number;
  readonly cacheWarm?: boolean;
  readonly atBoundary?: boolean;
  readonly unitsSinceLastSwitch?: number;
  readonly switchesThisTask?: number;
  /** How the session's harness is billed, so the transition cost carries the right label (owner 8703ab6). */
  readonly authMode?: AuthMode;
}

export type InputResult<K extends SurfaceOperation> =
  | { readonly ok: true; readonly input: OpInputs[K] }
  | { readonly ok: false; readonly message: string };

export const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** A route-learning key (JEV-0055): a slice id, or `<slice>::<baseline model>` as `jevris route learning status` lists it. */
export const LEARNING_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** An evidence selection id as the store names it (P10, D). */
export const SELECTION_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?::[0-9]{1,8})?$/;
/** A model id as a harness reports it (G20, contracts HARNESS_MODEL_ID_PATTERN). */
export const HARNESS_MODEL = new RegExp(HARNESS_MODEL_ID_PATTERN);
/** An evidence handle: the only kind Jevris issues (contracts EVIDENCE_HANDLE_PATTERN). */
const HANDLE = /^ev:[0-9a-f]{64}$/;
const CONFIG_KEY = /^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*){0,3}$/;

type Raw = { readonly [key: string]: unknown };

function isRaw(value: unknown): value is Raw {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

class Refusal extends Error {}

function refuse(message: string): never {
  throw new Refusal(message);
}

function onlyKeys(raw: Raw, allowed: readonly string[]): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) refuse(`Unknown argument "${key.slice(0, 40)}". Allowed: ${allowed.length > 0 ? allowed.join(', ') : 'none'}.`);
  }
}

function text(raw: Raw, key: string, max: number, required: true): string;
function text(raw: Raw, key: string, max: number, required: false): string | null;
function text(raw: Raw, key: string, max: number, required: boolean): string | null {
  const value = raw[key];
  if (value === undefined || value === null) {
    if (required) refuse(`"${key}" is required.`);
    return null;
  }
  if (typeof value !== 'string' || value.trim().length === 0) refuse(`"${key}" must be non-empty text.`);
  if (value.length > max) refuse(`"${key}" is longer than ${max} characters.`);
  if (value.includes('\0')) refuse(`"${key}" contains a NUL character.`);
  return value;
}

function pattern(raw: Raw, key: string, re: RegExp, what: string, required: true): string;
function pattern(raw: Raw, key: string, re: RegExp, what: string, required: false): string | null;
function pattern(raw: Raw, key: string, re: RegExp, what: string, required: boolean): string | null {
  const value = required ? text(raw, key, 200, true) : text(raw, key, 200, false);
  if (value === null) return null;
  if (!re.test(value)) refuse(`"${key}" must be ${what}.`);
  return value;
}

function list(raw: Raw, key: string, max: number, each: (value: unknown, index: number) => string): string[] {
  const value = raw[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) refuse(`"${key}" must be a list.`);
  if (value.length > max) refuse(`"${key}" has more than ${max} items.`);
  return value.map(each);
}

function idItem(key: string) {
  return (value: unknown): string => {
    if (typeof value !== 'string' || !ID.test(value)) refuse(`Every "${key}" item must be an id (letters, digits, dot, dash, underscore).`);
    return value;
  };
}

function textItem(key: string, max: number) {
  return (value: unknown): string => {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || value.includes('\0')) {
      refuse(`Every "${key}" item must be non-empty text of at most ${max} characters.`);
    }
    return value;
  };
}

function taskField(value: unknown): { readonly task?: RouteTask } {
  const task = routeTaskOf(value);
  return task === null ? {} : { task };
}

function routeTaskOf(value: unknown): RouteTask | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) refuse('"task" must be an object with optional title, paths and checkIds.');
  const raw = value as Raw;
  for (const key of Object.keys(raw)) if (!['title', 'paths', 'checkIds'].includes(key)) refuse(`Unknown "task" field "${key.slice(0, 40)}". Allowed: title, paths, checkIds.`);
  const task = { title: text(raw, 'title', 2000, false), paths: list(raw, 'paths', 64, textItem('paths', 512)), checkIds: list(raw, 'checkIds', 64, idItem('checkIds')) };
  return task.title === null && task.paths.length === 0 && task.checkIds.length === 0 ? null : task;
}

const MAX_TOKENS = 100_000_000;
const MAX_SWITCH_COUNT = 1_000_000;

function count(value: unknown, what: string, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) refuse(`${what} must be a whole number from 0 to ${max}.`);
  return value;
}

function remainingOf(value: unknown): RouteRemaining | null {
  if (value === undefined || value === null) return null;
  if (!isRaw(value)) refuse('"remaining" must be an object with inputTokens and outputTokens.');
  onlyKeys(value, ['inputTokens', 'outputTokens']);
  return { inputTokens: count(value['inputTokens'], '"remaining.inputTokens"', MAX_TOKENS), outputTokens: count(value['outputTokens'], '"remaining.outputTokens"', MAX_TOKENS) };
}

function sessionOf(value: unknown): RouteSession | null {
  if (value === undefined || value === null) return null;
  if (!isRaw(value)) refuse('"session" must be an object with warmPrefixTokens.');
  onlyKeys(value, ['warmPrefixTokens', 'cacheWarm', 'atBoundary', 'unitsSinceLastSwitch', 'switchesThisTask', 'authMode']);
  const flag = (key: string): boolean | undefined => {
    const v = value[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'boolean') refuse(`"session.${key}" must be true or false.`);
    return v;
  };
  const cacheWarm = flag('cacheWarm');
  const atBoundary = flag('atBoundary');
  const units = value['unitsSinceLastSwitch'];
  const switches = value['switchesThisTask'];
  const auth = value['authMode'];
  if (auth !== undefined && !(AUTH_MODES as readonly unknown[]).includes(auth)) refuse(`"session.authMode" must be one of ${AUTH_MODES.join(', ')}.`);
  return {
    warmPrefixTokens: count(value['warmPrefixTokens'], '"session.warmPrefixTokens"', MAX_TOKENS),
    ...(cacheWarm === undefined ? {} : { cacheWarm }),
    ...(atBoundary === undefined ? {} : { atBoundary }),
    ...(units === undefined ? {} : { unitsSinceLastSwitch: count(units, '"session.unitsSinceLastSwitch"', MAX_SWITCH_COUNT) }),
    ...(switches === undefined ? {} : { switchesThisTask: count(switches, '"session.switchesThisTask"', MAX_SWITCH_COUNT) }),
    ...(auth === undefined ? {} : { authMode: auth as AuthMode }),
  };
}

function bounded(value: unknown, what: string, maxBytes: number): unknown {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    refuse(`${what} is not plain JSON.`);
  }
  if (json === undefined) refuse(`${what} is required.`);
  if (json.length > maxBytes) refuse(`${what} is larger than ${maxBytes} bytes.`);
  return JSON.parse(json) as unknown;
}

const DELIVERY_IDS: readonly string[] = Object.values(DELIVERY_REPORTS);
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._\/@^~-]{0,199}$/;
const RELATIVE_FILE = /^(?![\/\\])(?![A-Za-z]:)[^\0]{1,512}$/;

const ADVISE_IDS: readonly string[] = Object.keys(ADVISE_CAPABILITIES);
const ROLE_PHASES = ['explorer', 'implementer', 'verifier', 'reviewer'];

function words(value: unknown, what: string, maxItems: number, maxLength: number, re?: RegExp): readonly string[] {
  if (!Array.isArray(value) || value.length > maxItems) refuse(`${what} must list at most ${maxItems} items.`);
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > maxLength || item.includes('\0') || (re !== undefined && !re.test(item))) refuse(`${what} has an item that is not ${re === undefined ? `text up to ${maxLength} characters` : 'a valid id'}.`);
  }
  return value as string[];
}

const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const EFFECT_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,31}$/;
const SPEC_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CAMPAIGN_ID = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;
const FINDING_SOURCES = ['screenshot', 'accessibility-tree', 'vision-model'];
const INCIDENT_SEVERITIES = ['low', 'medium', 'high', 'critical'];
/** The largest `args` object a tool-call preflight (C37) takes, as JSON. */
const ARGS_MAX_BYTES = 16_384;

/** A list of 'min' to 'max' plain objects; the caller reads each item with its own keys. */
function objects(v: unknown, what: string, min: number, max: number): readonly Raw[] {
  if (!Array.isArray(v) || v.length < min || v.length > max) refuse(`${what} must list ${min === 0 ? 'at most' : `${min} to`} ${max} items.`);
  for (const item of v) if (!isRaw(item)) refuse(`${what} items must be objects.`);
  return v as readonly Raw[];
}

function flag(raw: Raw, key: string, what: string): boolean | null {
  const v = raw[key];
  if (v === undefined) return null;
  if (typeof v !== 'boolean') refuse(`${what} must be true or false.`);
  return v;
}

function relativePath(v: unknown, what: string): string {
  if (typeof v !== 'string' || !RELATIVE_FILE.test(v) || v.split(/[\/]/).includes('..')) refuse(`${what} must be a path relative to the workspace, without "..".`);
  return v;
}

/**
 * A question draft (C67): instructions, at least two options, mandatory evidence ids and an optional threshold. The threshold is a number
 * from 0 to 1, or `null` (or left out) for none: the op reads all three the same way, and a candidate that has none where the live
 * question has one lowers the threshold, which the op refuses as a weaker safety check.
 */
function specDraft(v: unknown, what: string): AdviseValue {
  if (!isRaw(v)) refuse(`${what} must be an object { instructions, options, mandatoryEvidence, threshold }.`);
  onlyKeys(v, ['instructions', 'options', 'mandatoryEvidence', 'threshold']);
  const options = v['options'];
  if (!isRaw(options) || Object.keys(options).length < 2 || Object.keys(options).length > 32) refuse(`${what}.options must map 2 to 32 option ids to text.`);
  const outOptions: { [id: string]: string } = {};
  for (const [id, t] of Object.entries(options)) {
    if (!ID.test(id) || typeof t !== 'string' || t.trim().length === 0 || t.length > 300 || t.includes('\0')) refuse(`${what}.options maps ids to text of at most 300 characters.`);
    outOptions[id] = t;
  }
  const threshold = v['threshold'];
  if (threshold !== undefined && threshold !== null && (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1)) refuse(`${what}.threshold must be a number from 0 to 1, or null for none.`);
  return {
    instructions: text(v, 'instructions', 600, true),
    options: outOptions,
    mandatoryEvidence: v['mandatoryEvidence'] === undefined ? [] : words(v['mandatoryEvidence'], `${what}.mandatoryEvidence`, 32, 64),
    ...(typeof threshold === 'number' ? { threshold } : {}),
  };
}

/** The input of one of D's advice capabilities: its own keys only, each shape-checked and bounded. */
function adviseInput(capabilityId: string, value: unknown): AdviseInput {
  if (value === undefined || value === null) return {};
  if (!isRaw(value)) refuse('"input" must be an object.');
  const allowed = (ADVISE_CAPABILITIES as { readonly [id: string]: { readonly inputs: readonly string[] } })[capabilityId]?.inputs ?? [];
  onlyKeys(value, allowed);
  const out: { [key: string]: AdviseInput[string] } = {};
  for (const [key, v] of Object.entries(value)) {
    const what = `"input.${key}"`;
    switch (key) {
      case 'base':
        if (typeof v !== 'string' || !REVISION.test(v) || v.includes('..')) refuse(`${what} must be a revision such as HEAD~1, main or a commit hash.`);
        out[key] = v;
        break;
      case 'phase':
        if (typeof v !== 'string' || !ROLE_PHASES.includes(v)) refuse(`${what} must be one of ${ROLE_PHASES.join(', ')}.`);
        out[key] = v;
        break;
      case 'planId':
      case 'taskId':
      case 'checkId':
        if (typeof v !== 'string' || !ID.test(v)) refuse(`${what} must be an id.`);
        out[key] = v;
        break;
      case 'diffHandle':
        if (typeof v !== 'string' || !/^[a-z]+:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v)) refuse(`${what} must be an evidence handle.`);
        out[key] = v;
        break;
      case 'intent':
      case 'requirement': {
        const t = text(value, key, 1000, true);
        out[key] = t;
        break;
      }
      case 'requiredTools':
        out[key] = words(v, what, 32, 64, /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/);
        break;
      case 'taskIds':
        out[key] = words(v, what, 8, 128, ID);
        break;
      case 'requirementIds':
        out[key] = words(v, what, 256, 128, ID);
        break;
      case 'sourceRefs':
      case 'protectedPaths':
        out[key] = words(v, what, 64, 300);
        break;
      case 'patches': {
        if (!Array.isArray(v) || v.length === 0 || v.length > 8) refuse(`${what} must list 1 to 8 patches.`);
        out[key] = v.map((patch) => {
          if (!isRaw(patch)) refuse(`${what} items must be {id, diff}.`);
          onlyKeys(patch, ['id', 'diff']);
          const id = patch['id'];
          const diff = patch['diff'];
          if (typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(id) || typeof diff !== 'string' || diff.length === 0 || diff.length > 65_536) refuse(`${what} items need an id and a diff up to 64 KiB.`);
          return { id, diff };
        });
        break;
      }
      case 'requirementTexts': {
        if (!isRaw(v) || Object.keys(v).length > 256) refuse(`${what} must map at most 256 requirement ids to text.`);
        const texts: { [id: string]: string } = {};
        for (const [id, t] of Object.entries(v)) {
          if (!ID.test(id) || typeof t !== 'string' || t.length === 0 || t.length > 1000 || t.includes('\0')) refuse(`${what} maps requirement ids to text up to 1000 characters.`);
          texts[id] = t;
        }
        out[key] = texts;
        break;
      }
      case 'harness':
        if (typeof v !== 'string' || !(HARNESS_IDS as readonly string[]).includes(v)) refuse(`${what} must be one of ${HARNESS_IDS.join(', ')}.`);
        out[key] = v;
        break;
      case 'collaborative':
        if (typeof v !== 'boolean') refuse(`${what} must be true or false.`);
        out[key] = v;
        break;
      case 'maxItems':
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 16) refuse(`${what} must be a whole number from 1 to 16.`);
        out[key] = v;
        break;
      case 'query':
        out[key] = text(value, key, 500, true);
        break;
      case 'tools': {
        out[key] = objects(v, what, 1, 128).map((tool) => {
          onlyKeys(tool, ['id', 'description', 'effects']);
          const id = tool['id'];
          if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(id)) refuse(`${what} items need an id of letters, digits, dot, dash, colon or underscore.`);
          const description = tool['description'];
          if (description !== undefined && (typeof description !== 'string' || description.length > 300 || description.includes('\0'))) refuse(`${what} descriptions are text up to 300 characters.`);
          return { id, ...(description === undefined ? {} : { description }), effects: tool['effects'] === undefined ? [] : words(tool['effects'], `${what} effects`, 8, 32, EFFECT_NAME) };
        });
        break;
      }
      case 'allowlist':
        out[key] = words(v, what, 256, 64, /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/);
        break;
      case 'permittedEffects':
        out[key] = words(v, what, 8, 32, EFFECT_NAME);
        break;
      case 'tool':
        if (typeof v !== 'string' || !TOOL_NAME.test(v)) refuse(`${what} must be a tool name.`);
        out[key] = v;
        break;
      case 'args': {
        if (!isRaw(v)) refuse(`${what} must be the tool's arguments as an object.`);
        out[key] = bounded(v, what, ARGS_MAX_BYTES) as AdviseValue;
        break;
      }
      case 'writeScopes':
        out[key] = words(v, what, 64, 400);
        break;
      case 'receiptId':
        if (typeof v !== 'string' || !ID.test(v)) refuse(`${what} must be a receipt id.`);
        out[key] = v;
        break;
      case 'handle':
        if (typeof v !== 'string' || !HANDLE.test(v)) refuse(`${what} must be an evidence handle (ev: and 64 hex characters).`);
        out[key] = v;
        break;
      case 'findings':
        out[key] = objects(v, what, 1, 64).map((f) => {
          onlyKeys(f, ['id', 'text', 'source']);
          const id = f['id'];
          const source = f['source'];
          if (typeof id !== 'string' || !ID.test(id)) refuse(`${what} items need an id.`);
          if (typeof source !== 'string' || !FINDING_SOURCES.includes(source)) refuse(`${what} sources are ${FINDING_SOURCES.join(', ')}.`);
          return { id, text: text(f, 'text', 500, true), source };
        });
        break;
      case 'assertions':
        out[key] = objects(v, what, 1, 32).map((a) => {
          onlyKeys(a, ['id', 'claim', 'toolReceiptId', 'verification']);
          const id = a['id'];
          const toolReceiptId = a['toolReceiptId'];
          if (typeof id !== 'string' || !ID.test(id)) refuse(`${what} items need an id.`);
          if (toolReceiptId !== undefined && (typeof toolReceiptId !== 'string' || !ID.test(toolReceiptId))) refuse(`${what} toolReceiptId must be a receipt id.`);
          let verification: AdviseValue | null = null;
          if (a['verification'] !== undefined) {
            const ver = a['verification'];
            if (!isRaw(ver)) refuse(`${what} verification must be an object { kind, receiptId, reviewer, reviewedAt }.`);
            onlyKeys(ver, ['kind', 'receiptId', 'reviewer', 'reviewedAt']);
            if (ver['kind'] !== 'vision' && ver['kind'] !== 'human') refuse(`${what} verification.kind is vision or human.`);
            const receiptId = ver['receiptId'];
            if (receiptId !== undefined && (typeof receiptId !== 'string' || !ID.test(receiptId))) refuse(`${what} verification.receiptId must be a receipt id.`);
            verification = {
              kind: ver['kind'],
              ...(receiptId === undefined ? {} : { receiptId }),
              ...(ver['reviewer'] === undefined ? {} : { reviewer: text(ver, 'reviewer', 80, true) }),
              ...(ver['reviewedAt'] === undefined ? {} : { reviewedAt: text(ver, 'reviewedAt', 40, true) }),
            };
          }
          return { id, claim: a['claim'] === undefined ? '' : text(a, 'claim', 300, true), ...(toolReceiptId === undefined ? {} : { toolReceiptId }), ...(verification === null ? {} : { verification }) };
        });
        break;
      case 'incidents':
        out[key] = objects(v, what, 1, 64).map((i) => {
          onlyKeys(i, ['id', 'severity', 'resolved']);
          const id = i['id'];
          const severity = i['severity'];
          if (typeof id !== 'string' || !ID.test(id)) refuse(`${what} items need an id.`);
          if (typeof severity !== 'string' || !INCIDENT_SEVERITIES.includes(severity)) refuse(`${what} severities are ${INCIDENT_SEVERITIES.join(', ')}.`);
          const resolved = flag(i, 'resolved', `${what} resolved`);
          return { id, severity, ...(resolved === null ? {} : { resolved }) };
        });
        break;
      case 'rollout': {
        if (!isRaw(v)) refuse(`${what} must be an object { stages, rollbackPlan }.`);
        onlyKeys(v, ['stages', 'rollbackPlan']);
        out[key] = {
          stages: v['stages'] === undefined ? [] : words(v['stages'], `${what}.stages`, 16, 80),
          ...(v['rollbackPlan'] === undefined ? {} : { rollbackPlan: text(v, 'rollbackPlan', 500, true) }),
        };
        break;
      }
      case 'exceptions':
        out[key] = objects(v, what, 1, 32).map((e) => {
          onlyKeys(e, ['id', 'resolved']);
          const id = e['id'];
          if (typeof id !== 'string' || !ID.test(id)) refuse(`${what} items need an id.`);
          const resolved = flag(e, 'resolved', `${what} resolved`);
          return { id, ...(resolved === null ? {} : { resolved }) };
        });
        break;
      case 'specId':
        if (typeof v !== 'string' || !SPEC_ID.test(v)) refuse(`${what} must be a decision spec id.`);
        out[key] = v;
        break;
      case 'current':
      case 'candidate':
        out[key] = specDraft(v, what);
        break;
      case 'misclassifications':
        out[key] = objects(v, what, 1, 128).map((m) => {
          onlyKeys(m, ['expected', 'got']);
          const expected = m['expected'];
          const got = m['got'];
          if (typeof expected !== 'string' || !ID.test(expected)) refuse(`${what} items need an expected option id.`);
          if (got !== undefined && (typeof got !== 'string' || !ID.test(got))) refuse(`${what} got must be an option id.`);
          return { expected, ...(got === undefined ? {} : { got }) };
        });
        break;
      case 'reports':
        out[key] = objects(v, what, 2, 16).map((r) => {
          onlyKeys(r, ['id', 'model', 'conclusion', 'evidenceIds', 'sources']);
          const id = r['id'];
          const conclusion = r['conclusion'];
          if (typeof id !== 'string' || !ID.test(id)) refuse(`${what} items need an id.`);
          if (typeof conclusion !== 'string' || !ID.test(conclusion)) refuse(`${what} conclusions are ids (a short label of what the report concludes).`);
          return {
            id,
            model: text(r, 'model', 128, true),
            conclusion,
            evidenceIds: r['evidenceIds'] === undefined ? [] : words(r['evidenceIds'], `${what} evidenceIds`, 32, 140),
            sources: r['sources'] === undefined ? [] : words(r['sources'], `${what} sources`, 64, 300),
          };
        });
        break;
      case 'campaignId':
        if (typeof v !== 'string' || !CAMPAIGN_ID.test(v)) refuse(`${what} must start with a letter and use at most 48 letters, digits, dash or underscore.`);
        out[key] = v;
        break;
      case 'modules': {
        if (!Array.isArray(v) || v.length === 0 || v.length > 200) refuse(`${what} must list 1 to 200 modules.`);
        out[key] = v.map((m) => relativePath(m, `${what} items`));
        break;
      }
      case 'contract':
        out[key] = text(value, key, 1500, true);
        break;
      case 'canary':
        out[key] = relativePath(v, what);
        break;
      case 'waveSize':
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 8) refuse(`${what} must be a whole number from 1 to 8.`);
        out[key] = v;
        break;
      default:
        refuse(`Unknown argument "${key.slice(0, 40)}".`);
    }
  }
  bounded(out, '"input"', 262_144);
  return out;
}

function deliveryInput(capabilityId: string, value: unknown): DeliveryInput {
  if (value === undefined || value === null) return {};
  if (!isRaw(value)) refuse('"input" must be an object.');
  // Only the fields the named capability reads are accepted.
  const allowed: { readonly [id: string]: readonly string[] } = {
    C57: ['base', 'unresolvedComments'],
    C58: [],
    C59: ['base'],
    C60: ['base', 'migrations', 'compatibility'],
    C61: ['base'],
    C64: [],
  };
  onlyKeys(value, allowed[capabilityId] ?? []);
  const base = value['base'];
  if (base !== undefined && (typeof base !== 'string' || !REVISION.test(base) || base.includes('..'))) refuse('"input.base" must be a revision such as HEAD~1, main or a commit hash.');
  const comments = value['unresolvedComments'];
  const migrations = value['migrations'];
  if (migrations !== undefined) {
    if (!Array.isArray(migrations) || migrations.length === 0 || migrations.length > 32) refuse('"input.migrations" must list 1 to 32 files.');
    for (const file of migrations) {
      if (typeof file !== 'string' || !RELATIVE_FILE.test(file) || file.split(/[\/\\]/).includes('..')) refuse('"input.migrations" must be files relative to the workspace, without "..".');
    }
  }
  const compatibility = text(value, 'compatibility', 2000, false);
  return {
    ...(typeof base === 'string' ? { base } : {}),
    ...(comments === undefined ? {} : { unresolvedComments: count(comments, '"input.unresolvedComments"', 100_000) }),
    ...(migrations === undefined ? {} : { migrations: migrations as string[] }),
    ...(compatibility === null ? {} : { compatibility }),
  };
}

const PARSERS: { readonly [K in SurfaceOperation]: (raw: Raw) => OpInputs[K] } = {
  status(raw) {
    onlyKeys(raw, []);
    return {};
  },
  explain(raw) {
    onlyKeys(raw, ['decisionId', 'sliceId']);
    const decisionId = pattern(raw, 'decisionId', ID, 'a decision id', true);
    const sliceId = pattern(raw, 'sliceId', LEARNING_KEY, 'a slice id or a learning key (<slice>::<model>)', false);
    return sliceId === null ? { decisionId } : { decisionId, sliceId };
  },
  route(raw) {
    onlyKeys(raw, ['currentModel', 'modelPin', 'effortPin', 'taskId', 'sliceId', 'task', 'remaining', 'contextTokens', 'session', 'harness', 'authMode']);
    const harness = raw['harness'] ?? null;
    if (harness !== null && !(HARNESS_IDS as readonly unknown[]).includes(harness)) refuse(`"harness" must be one of ${HARNESS_IDS.join(', ')}.`);
    const authMode = raw['authMode'] ?? null;
    if (authMode !== null && !(AUTH_MODES as readonly unknown[]).includes(authMode)) refuse(`"authMode" must be one of ${AUTH_MODES.join(', ')}.`);
    return {
      currentModel: pattern(raw, 'currentModel', HARNESS_MODEL, 'a model id (optionally provider/model, or with [1m])', false),
      modelPin: pattern(raw, 'modelPin', HARNESS_MODEL, 'a model id (optionally provider/model, or with [1m])', false),
      harness: harness as HarnessId | null,
      authMode: authMode as AuthMode | null,
      effortPin: pattern(raw, 'effortPin', ID, 'an effort id', false),
      taskId: pattern(raw, 'taskId', ID, 'a task id', false),
      sliceId: pattern(raw, 'sliceId', ID, 'a slice id', false),
      ...taskField(raw['task']),
      remaining: remainingOf(raw['remaining']),
      contextTokens: raw['contextTokens'] === undefined || raw['contextTokens'] === null ? null : count(raw['contextTokens'], '"contextTokens"', MAX_TOKENS),
      session: sessionOf(raw['session']),
    };
  },
  plan(raw) {
    onlyKeys(raw, ['tasks', 'requirements', 'candidates']);
    const tasks = raw['tasks'];
    if (!Array.isArray(tasks) || tasks.length === 0) refuse('"tasks" must be a non-empty list of task nodes.');
    if (tasks.length > 1024) refuse('"tasks" has more than 1024 nodes.');
    const optionalList = (key: 'requirements' | 'candidates', max: number): { readonly requirements?: readonly unknown[]; readonly candidates?: readonly unknown[] } => {
      const value = raw[key];
      if (value === undefined || value === null) return {};
      if (!Array.isArray(value)) refuse(`"${key}" must be a list.`);
      if (value.length > max) refuse(`"${key}" has more than ${max} items.`);
      return { [key]: bounded(value, `"${key}"`, 262_144) as readonly unknown[] };
    };
    return { tasks: bounded(tasks, '"tasks"', 1_048_576) as readonly unknown[], ...optionalList('requirements', 64), ...optionalList('candidates', 12) };
  },
  checkpoint(raw) {
    onlyKeys(raw, ['objective', 'constraints', 'decisions', 'taskId', 'contextPercent']);
    return {
      objective: text(raw, 'objective', 4000, false),
      constraints: list(raw, 'constraints', 64, textItem('constraints', 1000)),
      decisions: list(raw, 'decisions', 64, textItem('decisions', 1000)),
      taskId: pattern(raw, 'taskId', ID, 'a task id', false),
      contextPercent: raw['contextPercent'] === undefined || raw['contextPercent'] === null ? null : count(raw['contextPercent'], '"contextPercent"', 100),
    };
  },
  recover(raw) {
    onlyKeys(raw, ['taskId', 'fingerprints', 'environment', 'rejectedApproaches']);
    const fingerprints = list(raw, 'fingerprints', 256, textItem('fingerprints', 200));
    const envRaw = raw['environment'];
    let environment: boolean[] = [];
    if (envRaw !== undefined && envRaw !== null) {
      if (!Array.isArray(envRaw) || envRaw.length > 256 || !envRaw.every((v) => typeof v === 'boolean')) {
        refuse('"environment" must be a list of true or false, one per fingerprint.');
      }
      environment = envRaw as boolean[];
    }
    if (environment.length > 0 && environment.length !== fingerprints.length) {
      refuse('"environment" must have one entry per fingerprint.');
    }
    return {
      taskId: pattern(raw, 'taskId', ID, 'a task id', false),
      signals: { fingerprints, environment },
      rejectedApproaches: list(raw, 'rejectedApproaches', 32, textItem('rejectedApproaches', 500)),
    };
  },
  verify(raw) {
    onlyKeys(raw, ['taskId', 'checkIds']);
    return { taskId: pattern(raw, 'taskId', ID, 'a task id', false), checkIds: list(raw, 'checkIds', 512, idItem('checkIds')) };
  },
  configure(raw) {
    onlyKeys(raw, ['key', 'value', 'dryRun', 'confirmed']);
    const key = pattern(raw, 'key', CONFIG_KEY, 'a dotted configuration key such as mode', false);
    const value = text(raw, 'value', 128, false);
    if ((key === null) !== (value === null)) refuse('Give both "key" and "value" to change a setting, or neither to show it.');
    const dryRun = raw['dryRun'];
    if (dryRun !== undefined && typeof dryRun !== 'boolean') refuse('"dryRun" must be true or false.');
    const confirmed = raw['confirmed'];
    if (confirmed !== undefined && typeof confirmed !== 'boolean') refuse('"confirmed" must be true or false.');
    return { set: key !== null && value !== null ? { key, value } : null, dryRun: dryRun === true, confirmed: confirmed === true };
  },
  'task.get'(raw) {
    onlyKeys(raw, ['taskId']);
    return { taskId: pattern(raw, 'taskId', ID, 'a task id', true) };
  },
  'evidence.select'(raw) {
    onlyKeys(raw, ['intent', 'maxItems']);
    const max = raw['maxItems'];
    if (max !== undefined && (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > 64)) {
      refuse('"maxItems" must be a whole number from 1 to 64.');
    }
    return { intent: text(raw, 'intent', 500, true), maxItems: typeof max === 'number' ? max : 16 };
  },
  'evidence.get'(raw) {
    onlyKeys(raw, ['handle', 'selectionId']);
    return {
      handle: pattern(raw, 'handle', HANDLE, 'an evidence handle, ev:<64 hex> with lower-case hex digits (jevris verify names it)', true),
      selectionId: pattern(raw, 'selectionId', SELECTION_ID, 'the selectionId an evidence selection returned', false),
    };
  },
  'verification.record'(raw) {
    onlyKeys(raw, ['receiptId', 'checkId', 'taskId']);
    return {
      receiptId: pattern(raw, 'receiptId', ID, 'a receipt id', true),
      checkId: pattern(raw, 'checkId', ID, 'a check id', true),
      taskId: pattern(raw, 'taskId', ID, 'a task id', false),
    };
  },
  'task.submit'(raw) {
    onlyKeys(raw, ['task']);
    if (!isRaw(raw['task'])) refuse('"task" must be a task node object.');
    return { task: bounded(raw['task'], '"task"', 65_536) };
  },
  'handoff.export'(raw) {
    onlyKeys(raw, ['capsuleId', 'taskId']);
    return { capsuleId: pattern(raw, 'capsuleId', ID, 'a capsule id', false), taskId: pattern(raw, 'taskId', ID, 'a task id', false) };
  },
  'handoff.import'(raw) {
    onlyKeys(raw, ['capsule']);
    if (!isRaw(raw['capsule'])) refuse('"capsule" must be a capsule object.');
    return { capsule: bounded(raw['capsule'], '"capsule"', 262_144) };
  },
  'capability.advise'(raw) {
    onlyKeys(raw, ['capabilityId', 'taskId', 'input']);
    const capabilityId = raw['capabilityId'];
    const known = [...DELIVERY_IDS, ...ADVISE_IDS];
    if (typeof capabilityId !== 'string' || !known.includes(capabilityId)) refuse(`"capabilityId" must be one of ${known.join(', ')}.`);
    const input = DELIVERY_IDS.includes(capabilityId) ? deliveryInput(capabilityId, raw['input']) : adviseInput(capabilityId, raw['input']);
    return { capabilityId, taskId: pattern(raw, 'taskId', ID, 'a task id', false), input };
  },
};

export function parseOpInput<K extends SurfaceOperation>(op: K, raw: unknown): InputResult<K> {
  if (raw === undefined || raw === null) raw = {};
  if (!isRaw(raw)) return { ok: false, message: 'Arguments must be an object.' };
  for (const key of Object.keys(raw)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return { ok: false, message: 'Arguments contain a forbidden key.' };
  }
  try {
    return { ok: true, input: PARSERS[op](raw) as OpInputs[K] };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, message: error.message };
    return { ok: false, message: 'The arguments could not be read.' };
  }
}

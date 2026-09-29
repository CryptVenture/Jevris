/**
 * Bounded, validated inputs for every surface operation. CLI flags and MCP arguments both end
 * up here; anything unexpected is refused before a sidecar call or a local read. No input is
 * ever a filesystem root, a home directory or a shell string.
 */
import { ADVISE_CAPABILITIES, AUTH_MODES, DELIVERY_REPORTS, HARNESS_IDS, HARNESS_MODEL_ID_PATTERN, type AuthMode, type HarnessId, type SurfaceOperation } from '@jevris/contracts';

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
    /** The work left in the task, so the saving of a switch can be priced. */
    readonly remaining: RouteRemaining | null;
    /** The context the task needs, in tokens. */
    readonly contextTokens: number | null;
    /** The running session's switch facts: without a warm prefix a switch cannot be priced. */
    readonly session: RouteSession | null;
  };
  readonly plan: { readonly tasks: readonly unknown[] };
  readonly checkpoint: { readonly objective: string | null; readonly constraints: readonly string[]; readonly taskId: string | null };
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

/** What an orchestration or verification capability may be told: only its own keys, bounded. */
export type AdviseInput = { readonly [key: string]: string | readonly string[] | readonly { readonly id: string; readonly diff: string }[] | { readonly [id: string]: string } };

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
/** An evidence selection id as the store names it (P10, D). */
export const SELECTION_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?::[0-9]{1,8})?$/;
/** A model id as a harness reports it (G20, contracts HARNESS_MODEL_ID_PATTERN). */
export const HARNESS_MODEL = new RegExp(HARNESS_MODEL_ID_PATTERN);
const HANDLE = /^[a-z]+:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
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
    const sliceId = pattern(raw, 'sliceId', ID, 'a slice id', false);
    return sliceId === null ? { decisionId } : { decisionId, sliceId };
  },
  route(raw) {
    onlyKeys(raw, ['currentModel', 'modelPin', 'effortPin', 'taskId', 'sliceId', 'remaining', 'contextTokens', 'session', 'harness', 'authMode']);
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
      remaining: remainingOf(raw['remaining']),
      contextTokens: raw['contextTokens'] === undefined || raw['contextTokens'] === null ? null : count(raw['contextTokens'], '"contextTokens"', MAX_TOKENS),
      session: sessionOf(raw['session']),
    };
  },
  plan(raw) {
    onlyKeys(raw, ['tasks']);
    const tasks = raw['tasks'];
    if (!Array.isArray(tasks) || tasks.length === 0) refuse('"tasks" must be a non-empty list of task nodes.');
    if (tasks.length > 1024) refuse('"tasks" has more than 1024 nodes.');
    return { tasks: bounded(tasks, '"tasks"', 1_048_576) as readonly unknown[] };
  },
  checkpoint(raw) {
    onlyKeys(raw, ['objective', 'constraints', 'taskId']);
    return {
      objective: text(raw, 'objective', 4000, false),
      constraints: list(raw, 'constraints', 64, textItem('constraints', 1000)),
      taskId: pattern(raw, 'taskId', ID, 'a task id', false),
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
      handle: pattern(raw, 'handle', HANDLE, 'a handle such as ev:<64 hex> (jevris verify names it)', true),
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

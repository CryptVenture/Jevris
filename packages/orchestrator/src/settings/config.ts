/**
 * Product settings (SET-02, SET-03, SSOT §23.1, §16.2, §4.2).
 *
 * Effective configuration = defaults, then the user's `jevris.config.json` (validated by the
 * JevrisConfig contract; unknown keys are refused), then two narrowing layers that can only
 * tighten: the workspace's `.jevris/config.json` (repository content, so it may only lower
 * limits and switch features off) and the administrator's `organization.json` (host policy:
 * mode ceiling, source egress, retention, request bytes and the provider pin).
 *
 * `setConfigValue` changes only product keys through the CLI, supports `dryRun`, reports a
 * key-by-key diff and never touches native harness permissions.
 */
import { randomBytes } from 'node:crypto';
import { linkSync, lstatSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { JevrisConfigContract, MODEL_LISTING_DEFAULT, MODEL_LISTING_VALUES, copyHostDocument, lowerMode, modeAllows, type HostDocument, type JevrisConfig, type ModeSource } from '@jevris/contracts';
import { authorityFileRefusal, ensurePrivateDir, jevrisPaths, readFileNoFollow, renameWithRetry, writePrivateFile, type DurableWriteResult, type PrivateResult } from '@jevris/platform';
import { isPlain } from '../util.js';
import { readManagedPolicy } from './managed-policy.js';

export const CONFIG_FILE = 'jevris.config.json';
export const WORKSPACE_CONFIG = join('.jevris', 'config.json'); // path-hygiene: allow workspace-relative config location
const MAX_BYTES = 262_144;

export const DEFAULT_CONFIG: JevrisConfig = Object.freeze({
  schemaVersion: '1.0',
  // The single ceiling (owner decision 0eb319de): bounded-auto from install. `modeAllows` in
  // @jevris/contracts says what each mode permits; mainSession, managedWorkers and orchestration
  // may only narrow it (readEffectiveConfig applies that).
  mode: 'bounded-auto',
  provider: { kind: 'typesafe-direct', model: 'jev-1.13.0', credentialRef: 'host-secret:typesafe-primary' },
  decisions: { hotPathDeadlineMs: 900, backgroundDeadlineMs: 5000, maxRequestBytes: 131072, maxQuestions: 12, allowUncalibratedActuation: false },
  privacy: { sourceEgress: 'deny-until-approved', remoteTelemetry: 'off', rawArtifactRetentionDays: 7, decisionRetentionDays: 30 },
  // Managed-worker routing is bounded-auto from install (owner decision 7922ee3): route learning acts only on
  // low-risk slices after 12 local outcomes per arm; other slices stay advise. The Kilo and OpenCode
  // main session is plugin-bounded-auto from install too (owner decision OD-8, DOMAINS f294e43): a turn
  // is switched only under D's gate (approved-scope.ts) and C's route-learning rules; every other
  // harness's main session stays advice-only.
  routing: { mainSession: 'plugin-bounded-auto', managedWorkers: 'bounded-auto', respectHumanPins: true, calibrationArtifact: null, modelListing: MODEL_LISTING_DEFAULT },
  // Orchestration is on from install (owner decision 5f7053f): owned workers still start only when a person
  // submits a plan, bounded by its budget, the kill switch, native permissions and worker.route certification.
  orchestration: { enabled: true, maxConcurrentWorkers: 2, maxWorkerDepth: 1, maxRepairAttempts: 2, maxStopContinuationsPerCondition: 1 },
  compaction: { nativeAutoDeferral: false, preserveMandatoryFacts: true, rawTranscriptEditing: false },
  packs: ['jevris.observability', 'jevris.memory', 'jevris.skill-advice'],
}) as JevrisConfig;

const MODE_RANK: { readonly [mode: string]: number } = { off: 0, observe: 1, advise: 2, 'bounded-auto': 3 };
/**
 * The mode an administrator ceiling that cannot be used safely (a link, an invalid file, a refused
 * managed policy) caps at: observe records and shows nothing. It is not the defaults' mode, which
 * is bounded-auto and would cap nothing.
 */
export const FAIL_CLOSED_MODE: JevrisConfig['mode'] = 'observe';
const EGRESS_RANK: { readonly [e: string]: number } = { 'deny-until-approved': 0, 'approved-scoped': 1 };
const TELEMETRY_RANK: { readonly [t: string]: number } = { off: 0, 'approved-aggregates': 1 };

export interface ConfigIssue {
  readonly path: string;
  readonly code: string;
}

export interface LayerNote {
  readonly layer: 'defaults' | 'user' | 'workspace' | 'organization' | 'host' | 'managed';
  readonly key: string;
  readonly from: string;
  readonly to: string;
}

export interface EffectiveConfig {
  readonly config: JevrisConfig;
  readonly source: 'defaults' | 'file';
  readonly path: string;
  readonly valid: boolean;
  readonly issues: readonly ConfigIssue[];
  /** What each narrowing layer changed. */
  readonly narrowed: readonly LayerNote[];
  /**
   * Where the effective `mode` comes from: the defaults, your file, or the layer whose ceiling
   * set it (the workspace file, organization.json, host.json or the managed policy).
   */
  readonly modeSource: ModeSource;
}


type Read = { readonly kind: 'missing' } | { readonly kind: 'invalid'; readonly code: string } | { readonly kind: 'ok'; readonly value: unknown };

function readJson(path: string): Read {
  try {
    const st = statSync(path);
    // Something is there that is not a file: it is not missing, and it cannot be used.
    if (!st.isFile()) return { kind: 'invalid', code: 'NOT_REGULAR' };
    if (st.size > MAX_BYTES) return { kind: 'invalid', code: 'TOO_LARGE' };
    return { kind: 'ok', value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (error) {
    const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
    return { kind: 'invalid', code: code === 'EACCES' || code === 'EPERM' ? 'UNREADABLE' : 'INVALID_JSON' };
  }
}

function getKey(config: unknown, key: string): unknown {
  let value: unknown = config;
  for (const part of key.split('.')) value = isPlain(value) ? value[part] : undefined;
  return value;
}

function setKey<T>(config: T, key: string, value: unknown): T {
  const copy = JSON.parse(JSON.stringify(config)) as { [k: string]: unknown };
  const parts = key.split('.');
  let target = copy;
  for (const part of parts.slice(0, -1)) target = target[part] as { [k: string]: unknown };
  target[parts[parts.length - 1] as string] = value;
  return copy as T;
}

/** Keys a workspace file may lower; anything else in it is refused. */
const WORKSPACE_NARROWABLE: { readonly [key: string]: 'min' | 'off' | 'mode' | 'switch' } = {
  mode: 'mode',
  'routing.managedWorkers': 'mode',
  // An on/off switch: a workspace may only turn it off.
  'routing.modelListing': 'switch',
  'orchestration.enabled': 'off',
  'orchestration.maxConcurrentWorkers': 'min',
  'orchestration.maxWorkerDepth': 'min',
  'orchestration.maxRepairAttempts': 'min',
  'decisions.maxQuestions': 'min',
  'decisions.hotPathDeadlineMs': 'min',
  'decisions.backgroundDeadlineMs': 'min',
};

function flatten(value: unknown, prefix = ''): { [key: string]: unknown } {
  const out: { [key: string]: unknown } = {};
  if (!isPlain(value)) return out;
  for (const [k, v] of Object.entries(value)) {
    const key = prefix === '' ? k : `${prefix}.${k}`;
    if (isPlain(v)) Object.assign(out, flatten(v, key));
    else out[key] = v;
  }
  return out;
}

function narrowWorkspace(config: JevrisConfig, raw: unknown, notes: LayerNote[], issues: ConfigIssue[]): JevrisConfig {
  let next = config;
  for (const [key, value] of Object.entries(flatten(raw))) {
    if (key === 'schemaVersion') continue;
    const rule = WORKSPACE_NARROWABLE[key];
    if (rule === undefined) {
      issues.push({ path: `workspace:${key}`.slice(0, 256), code: 'NOT_NARROWABLE' });
      continue;
    }
    const current = getKey(next, key);
    let lowered: unknown;
    if (rule === 'min' && typeof value === 'number' && typeof current === 'number' && Number.isInteger(value) && value >= 0) lowered = Math.min(current, value);
    else if (rule === 'off' && value === false) lowered = false;
    else if (rule === 'switch' && (value === 'off' || value === 'on')) lowered = value === 'off' ? 'off' : current;
    else if (rule === 'mode' && typeof value === 'string' && value in MODE_RANK && typeof current === 'string') lowered = (MODE_RANK[value] ?? 9) < (MODE_RANK[current] ?? 0) ? value : current;
    else {
      issues.push({ path: `workspace:${key}`.slice(0, 256), code: 'INVALID_VALUE' });
      continue;
    }
    if (lowered !== current) {
      notes.push({ layer: 'workspace', key, from: String(current), to: String(lowered) });
      next = setKey(next, key, lowered);
    }
  }
  return next;
}

/**
 * An administrator policy file (host.json, organization.json) read for its ceilings. A ceiling
 * only narrows and grants nothing, so a file SR-4 would refuse as an authority (not yours, shared
 * write, inside a work tree) still caps, with its reason code as an issue. A file that cannot be
 * read safely (a symbolic link, not a regular file, too large) or that fails the host-policy
 * contract caps at the defaults instead (`unusable`), as an invalid policy caps retention.
 */
type PolicyCeilingRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'unusable'; readonly code: string }
  | { readonly kind: 'ok'; readonly doc: HostDocument; readonly refusal: string | null };

const NO_FOLLOW_CODES = { link: 'AUTHORITY_FILE_SYMLINK', 'not-regular': 'AUTHORITY_FILE_NOT_REGULAR', 'too-large': 'TOO_LARGE', unreadable: 'UNREADABLE' } as const;

function readPolicyCeiling(path: string, home: string): PolicyCeilingRead {
  const read = readFileNoFollow(path, MAX_BYTES);
  if (read.kind === 'missing') return { kind: 'missing' };
  if (read.kind !== 'ok') return { kind: 'unusable', code: NO_FOLLOW_CODES[read.kind] };
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read.bytes));
  } catch {
    return { kind: 'unusable', code: 'INVALID_JSON' };
  }
  const doc = copyHostDocument(value);
  if (doc === undefined) return { kind: 'unusable', code: 'INVALID_POLICY' };
  let refusal: string | null = null;
  try {
    refusal = authorityFileRefusal(path, { home });
  } catch {
    refusal = null;
  }
  return { kind: 'ok', doc, refusal };
}

/** Lowers `mode` (and `routing.managedWorkers`, which never exceeds it) to a ceiling, noting the layer. */
function capMode(config: JevrisConfig, ceiling: JevrisConfig['mode'], layer: LayerNote['layer'], notes: LayerNote[]): JevrisConfig {
  let next = config;
  for (const key of ['mode', 'routing.managedWorkers'] as const) {
    const current = getKey(next, key);
    if (typeof current === 'string' && (MODE_RANK[current] ?? 0) > (MODE_RANK[ceiling] ?? 0)) {
      notes.push({ layer, key, from: current, to: ceiling });
      next = setKey(next, key, ceiling);
    }
  }
  return next;
}

function narrowOrganization(config: JevrisConfig, org: HostDocument, notes: LayerNote[]): JevrisConfig {
  let next = config;
  const lower = (key: string, value: unknown) => {
    const current = getKey(next, key);
    if (current !== value) {
      notes.push({ layer: 'organization', key, from: String(current), to: String(value) });
      next = setKey(next, key, value);
    }
  };
  next = capMode(next, org.mode, 'organization', notes);
  if ((EGRESS_RANK[next.privacy.sourceEgress] ?? 0) > (EGRESS_RANK[org.egress] ?? 0)) lower('privacy.sourceEgress', org.egress);
  if (org.egress === 'deny-until-approved' && (TELEMETRY_RANK[next.privacy.remoteTelemetry] ?? 0) > 0) lower('privacy.remoteTelemetry', 'off');
  if (next.privacy.rawArtifactRetentionDays > org.retention.rawArtifactRetentionDays) lower('privacy.rawArtifactRetentionDays', org.retention.rawArtifactRetentionDays);
  if (next.privacy.decisionRetentionDays > org.retention.decisionRetentionDays) lower('privacy.decisionRetentionDays', org.retention.decisionRetentionDays);
  if (next.decisions.maxRequestBytes > org.budget.maxRequestBytes) lower('decisions.maxRequestBytes', org.budget.maxRequestBytes);
  if (next.provider.model !== org.pin.model) lower('provider.model', org.pin.model);
  return next;
}

export interface ConfigLocation {
  readonly home?: string;
  readonly workspaceRoot?: string | null;
  readonly env?: { readonly [key: string]: string | undefined };
}

export function configFilePath(input: ConfigLocation): string {
  return join(jevrisPaths({ ...(input.home === undefined ? {} : { home: input.home }), ...(input.env === undefined ? {} : { env: input.env }) }).config, CONFIG_FILE);
}

export function readEffectiveConfig(input: ConfigLocation): EffectiveConfig {
  const paths = jevrisPaths({ ...(input.home === undefined ? {} : { home: input.home }), ...(input.env === undefined ? {} : { env: input.env }) });
  const path = join(paths.config, CONFIG_FILE);
  const issues: ConfigIssue[] = [];
  const notes: LayerNote[] = [];
  let config = DEFAULT_CONFIG;
  let source: EffectiveConfig['source'] = 'defaults';
  let valid = true;
  const user = readJson(path);
  if (user.kind === 'invalid') {
    source = 'file';
    valid = false;
    issues.push({ path: '', code: user.code });
  } else if (user.kind === 'ok') {
    source = 'file';
    const checked = JevrisConfigContract.validate(user.value);
    if (checked.ok) config = checked.value;
    else {
      valid = false;
      for (const i of checked.issues.slice(0, 32)) issues.push({ path: i.path.slice(0, 256), code: i.code.slice(0, 64) });
    }
  }
  // SR-20: a file that is there but cannot be used never falls back to the defaults' mode
  // (bounded-auto): it may have said off or observe. The mode is capped at observe until it is
  // fixed, and the problem is a `user:` issue that status and doctor show. No file: the defaults.
  if (!valid) {
    issues.push({ path: 'user:', code: user.kind === 'invalid' ? user.code : 'INVALID_CONFIG' });
    config = capMode(config, FAIL_CLOSED_MODE, 'user', notes);
  }
  if (input.workspaceRoot !== undefined && input.workspaceRoot !== null) {
    const ws = readJson(join(input.workspaceRoot, WORKSPACE_CONFIG));
    if (ws.kind === 'ok') config = narrowWorkspace(config, ws.value, notes, issues);
    else if (ws.kind === 'invalid') issues.push({ path: 'workspace:', code: ws.code });
  }
  // The administrator ceilings (SSOT §4.2 "Managed policy": they intersect, the lowest wins):
  // organization.json narrows every key it caps; host.json and the managed policy cap the mode.
  const org = readPolicyCeiling(join(paths.config, 'organization.json'), paths.home);
  if (org.kind === 'ok') {
    config = narrowOrganization(config, org.doc, notes);
    if (org.refusal !== null) issues.push({ path: 'organization:', code: org.refusal });
  } else if (org.kind === 'unusable') {
    issues.push({ path: 'organization:', code: org.code });
    config = capMode(config, FAIL_CLOSED_MODE, 'organization', notes);
  }
  const host = readPolicyCeiling(join(paths.config, 'host.json'), paths.home);
  if (host.kind === 'ok') {
    config = capMode(config, host.doc.mode, 'host', notes);
    if (host.refusal !== null) issues.push({ path: 'host:', code: host.refusal });
  } else if (host.kind === 'unusable') {
    issues.push({ path: 'host:', code: host.code });
    config = capMode(config, FAIL_CLOSED_MODE, 'host', notes);
  }
  // GOV-05: a refused managed policy fails closed, to observe.
  const managed = readManagedPolicy();
  if (managed.state === 'ok') config = capMode(config, managed.document.mode, 'managed', notes);
  else if (managed.state === 'refused') {
    issues.push({ path: 'managed:', code: managed.reasonCode });
    config = capMode(config, FAIL_CLOSED_MODE, 'managed', notes);
  }
  const modeSource = modeSourceOf(notes, source, valid, config);
  config = boundByMode(config, modeSource, notes);
  return { config, source, path, valid, issues, narrowed: notes, modeSource };
}

/**
 * The mode is the single ceiling (owner decision 0eb319de): routing.managedWorkers never exceeds
 * it, and below bounded-auto (no `actuate`) the main session is advice-only. The note names the
 * layer that set the mode.
 */
function boundByMode(config: JevrisConfig, layer: ModeSource, notes: LayerNote[]): JevrisConfig {
  let next = config;
  const workers = lowerMode(next.routing.managedWorkers, next.mode);
  if (workers !== next.routing.managedWorkers) {
    notes.push({ layer, key: 'routing.managedWorkers', from: next.routing.managedWorkers, to: workers });
    next = setKey(next, 'routing.managedWorkers', workers);
  }
  if (!modeAllows(next.mode, 'actuate') && next.routing.mainSession !== 'advice-only') {
    notes.push({ layer, key: 'routing.mainSession', from: next.routing.mainSession, to: 'advice-only' });
    next = setKey(next, 'routing.mainSession', 'advice-only');
  }
  return next;
}

/**
 * The issues of the layers that narrow the settings (the workspace file and the administrator
 * ceilings), not the user file's own: status and configure show them with the mode's source.
 */
export function layerIssues(issues: readonly ConfigIssue[]): readonly ConfigIssue[] {
  return issues.filter((issue) => /^(user|workspace|organization|host|managed):/.test(issue.path));
}

/** The layer that set the effective mode: the last ceiling that lowered it, else your file or the defaults. */
function modeSourceOf(notes: readonly LayerNote[], source: EffectiveConfig['source'], valid: boolean, config: JevrisConfig): ModeSource {
  for (let i = notes.length - 1; i >= 0; i -= 1) {
    const note = notes[i] as LayerNote;
    if (note.key === 'mode' && note.to === config.mode) return note.layer;
  }
  return source === 'file' && valid ? 'user' : 'defaults';
}

type SourceEgressSetting = JevrisConfig['privacy']['sourceEgress'];

/** The `privacy.sourceEgress` preference a valid user file states, or null (no file, or an invalid one). */
function userEgressPreference(path: string): SourceEgressSetting | null {
  const user = readJson(path);
  if (user.kind !== 'ok') return null;
  const checked = JevrisConfigContract.validate(user.value);
  return checked.ok ? checked.value.privacy.sourceEgress : null;
}

function payloadOf(
  eff: EffectiveConfig,
  changed: readonly { readonly key: string; readonly from: string; readonly to: string }[],
  egress: { readonly decision: SourceEgressDecision; readonly preference: SourceEgressSetting | null },
) {
  return {
    source: eff.source,
    path: eff.path,
    valid: eff.valid,
    issues: eff.issues.slice(0, 64),
    effective: {
      mode: eff.config.mode,
      // Which layer set the mode: the defaults, your file, or the ceiling that lowered it.
      modeSource: eff.modeSource,
      // The host decision the egress guard enforces, with its provenance; the user file's value is
      // only a preference, shown apart (E beb0359).
      sourceEgress: egress.decision === 'approved' ? ('approved-scoped' as const) : ('deny-until-approved' as const),
      sourceEgressSource: 'host-policy' as const,
      sourceEgressPreference: egress.preference,
      remoteTelemetry: eff.config.privacy.remoteTelemetry,
      mainSession: eff.config.routing.mainSession,
      managedWorkers: eff.config.routing.managedWorkers,
      orchestrationEnabled: eff.config.orchestration.enabled,
    },
    changed: changed.slice(0, 32).map((c) => ({ key: c.key.slice(0, 128), from: c.from.slice(0, 128), to: c.to.slice(0, 128) })),
    nativePermissionsChanged: false as const,
  };
}

/** The host's source-egress decision: approved by administrator policy, or not. */
export type SourceEgressDecision = 'approved' | 'not-approved';

/**
 * B's resolver (`@jevris/sidecar` `resolveSourceEgress`, a0d0b99): the same function the provider
 * transport's egress guard asks, over host.json, organization.json and a managed policy. When it
 * cannot load, egress is not approved (the guard would not approve either).
 */
export async function hostSourceEgress(home: string): Promise<SourceEgressDecision> {
  try {
    const sidecar = await import('@jevris/sidecar');
    return sidecar.resolveSourceEgress({ home }) === 'approved' ? 'approved' : 'not-approved';
  } catch {
    return 'not-approved';
  }
}

/**
 * The configure payload (E's `configure` contract) for the effective configuration.
 *
 * `effective.sourceEgress` is the host decision the egress guard enforces (`jevris egress
 * status`), not the `privacy.sourceEgress` preference in jevris.config.json: only administrator
 * host policy approves egress, so after `jevris egress approve` configure show agrees with
 * egress status, and a user file saying approved-scoped never shows as approved on its own.
 */
export async function loadEffectiveConfig(input: {
  readonly home: string;
  readonly workspaceRoot: string | null;
  /** The host decision (test seam). Default: B's resolveSourceEgress. */
  readonly sourceEgress?: (home: string) => Promise<SourceEgressDecision>;
}) {
  const eff = readEffectiveConfig(input);
  const decision = await (input.sourceEgress ?? hostSourceEgress)(input.home).catch((): SourceEgressDecision => 'not-approved');
  return payloadOf(eff, [], { decision, preference: userEgressPreference(eff.path) });
}

type Parser = (value: string) => unknown;
const int = (min: number, max: number): Parser => (v) => (/^\d+$/.test(v) && Number(v) >= min && Number(v) <= max ? Number(v) : undefined);
const oneOf = (...values: readonly string[]): Parser => (v) => (values.includes(v) ? v : undefined);
const bool: Parser = (v) => (v === 'true' ? true : v === 'false' ? false : undefined);

/** Product keys the CLI may set. */
export const SETTABLE_KEYS: { readonly [key: string]: Parser } = {
  // SR-19: a value that raises mode, routing.managedWorkers or routing.mainSession above its
  // effective value needs a person at an interactive terminal (`raisesAuthority`).
  mode: oneOf('off', 'observe', 'advise', 'bounded-auto'),
  'routing.managedWorkers': oneOf('off', 'observe', 'advise', 'bounded-auto'),
  // F's harness model listing (owner decision 3f090fa): model ids only, no model call.
  'routing.modelListing': oneOf(...MODEL_LISTING_VALUES),
  // OD-8: `advice-only` turns the per-turn main-session switch off. `owned-sdk-approved` is an
  // administrator's value (ADMIN_VALUES), never set here.
  'routing.mainSession': oneOf('advice-only', 'plugin-bounded-auto'),
  'orchestration.enabled': bool,
  'orchestration.maxConcurrentWorkers': int(1, 32),
  'orchestration.maxWorkerDepth': int(0, 4),
  'orchestration.maxRepairAttempts': int(0, 10),
  'decisions.hotPathDeadlineMs': int(100, 30_000),
  'decisions.backgroundDeadlineMs': int(500, 120_000),
  'decisions.maxQuestions': int(1, 12),
  'privacy.remoteTelemetry': oneOf('off'),
  'privacy.rawArtifactRetentionDays': int(0, 365),
  'privacy.decisionRetentionDays': int(0, 3650),
  'compaction.nativeAutoDeferral': oneOf('false'),
};

/** Keys that need an administrator or a certified adapter; configure refuses them with a reason. */
export const ADMIN_KEYS: { readonly [key: string]: string } = {
  'privacy.sourceEgress': 'Source egress needs administrator consent through host policy, not configure.',
  'decisions.allowUncalibratedActuation': 'Uncalibrated actuation is never allowed.',
  'provider.model': 'The provider pin is set by host policy.',
  'provider.credentialRef': 'Credentials are managed with `jevris credential`, never in configuration.',
  'compaction.nativeAutoDeferral': 'Native compaction deferral needs a certified adapter.',
};

/**
 * Values of a settable key that only an administrator may set; configure refuses them with the
 * reason, and accepts the key's other values (OD-8: `routing.mainSession`).
 */
export const ADMIN_VALUES: { readonly [key: string]: { readonly value: string; readonly message: string } } = {
  'routing.mainSession': { value: 'owned-sdk-approved', message: 'Owned main-session routing needs an administrator-approved SDK host.' },
};

/** How each authority key ranks its values; a higher rank lets Jevris do more. */
const AUTHORITY_RANK: { readonly [key: string]: { readonly [value: string]: number } } = {
  mode: MODE_RANK,
  'routing.managedWorkers': MODE_RANK,
  'routing.mainSession': { 'advice-only': 0, 'plugin-bounded-auto': 1, 'owned-sdk-approved': 2 },
};

/** The keys whose raise needs a person at an interactive terminal (SR-19). */
export const AUTHORITY_KEYS: readonly string[] = Object.freeze(Object.keys(AUTHORITY_RANK));

/**
 * SR-19 (owner decision 2e13b6fe): whether `configure set <key> <value>` raises what Jevris may do:
 * `mode`, `routing.managedWorkers` or `routing.mainSession` above its current effective value (your
 * file under the administrator ceilings; the repository file is not asked). Such a change needs a
 * person at an interactive terminal: the CLI asks B's personAtTerminal and never takes --yes,
 * --json, a pipe, MCP or a test run. Lowering, and setting the same value, are free.
 */
export function raisesAuthority(input: ConfigLocation, key: string, value: string): boolean {
  const rank = AUTHORITY_RANK[key];
  if (rank === undefined) return false;
  // A value the setter refuses anyway (an administrator's value, or not a value at all) is not asked.
  if (ADMIN_VALUES[key]?.value === value || SETTABLE_KEYS[key]?.(value) === undefined) return false;
  let current: unknown;
  try {
    current = getKey(readEffectiveConfig({ ...input, workspaceRoot: null }).config, key);
  } catch {
    return true;
  }
  const next = rank[value];
  const now = typeof current === 'string' ? rank[current] : undefined;
  return next !== undefined && (now === undefined || next > now);
}

/** The refusal a raise gets without a person: B's CHANNEL_REFUSED wording (verify-admin.ts personAtTerminal). */
export function raiseRefusal(key: string, value: string): string {
  return `raising ${key} to ${value} widens what Jevris may do, so it needs a person at an interactive terminal who answers y (never --yes, --json, MCP, a hook, a script, a pipe or a model's shell). Nothing was changed.`;
}

/** SR-20: what `configure set` says while your file cannot be used, naming it and the fix. */
export function invalidUserFileMessage(path: string, canReplace = true): string {
  const head = `${path} cannot be used (it is unreadable or does not match the configuration contract; jevris configure lists the problems), so the mode is capped at observe and nothing else is written. Fix the file by hand`;
  return canReplace ? `${head}, or run jevris configure set mode off (or observe): that moves it aside to ${path}.invalid and writes a fresh file with that mode.` : `${head}.`;
}

export async function setConfigValue(input: {
  readonly home: string;
  readonly key: string;
  readonly value: string;
  readonly dryRun: boolean;
  /** The host decision (test seam). Default: B's resolveSourceEgress. */
  readonly sourceEgress?: (home: string) => Promise<SourceEgressDecision>;
  /**
   * A person at an interactive terminal answered y (B's personAtTerminal; never --yes): required
   * for a change that raises authority (`raisesAuthority`, SR-19).
   */
  readonly confirmed?: boolean;
}) {
  const parse = SETTABLE_KEYS[input.key];
  if (parse === undefined) {
    const admin = ADMIN_KEYS[input.key];
    return { ok: false as const, message: admin ?? `"${input.key}" is not a setting. Settable: ${Object.keys(SETTABLE_KEYS).join(', ')}.` };
  }
  const adminValue = ADMIN_VALUES[input.key];
  if (adminValue !== undefined && adminValue.value === input.value) return { ok: false as const, message: adminValue.message };
  const value = parse(input.value);
  if (value === undefined) return { ok: false as const, message: `"${input.value}" is not a valid value for ${input.key}.` };
  // A dry run writes nothing, not even the migration.
  if (!input.dryRun) await migrateModeDefault({ home: input.home }).catch(() => 'not-now' as const);
  const current = readEffectiveConfig({ home: input.home });
  // SR-19: a raise needs a person at a terminal; a dry run shows it and writes nothing.
  if (!input.dryRun && input.confirmed !== true && raisesAuthority({ home: input.home }, input.key, input.value)) return { ok: false as const, message: raiseRefusal(input.key, input.value), reasonCode: 'CHANNEL_REFUSED' as const };
  if (!current.valid) {
    // SR-20: a mode that raises nothing (off, observe) replaces the unusable file with a fresh one.
    if (!input.dryRun && input.key === 'mode' && !raisesAuthority({ home: input.home }, 'mode', input.value)) return replaceUnusableUserFile({ home: input.home, mode: value, ...(input.sourceEgress === undefined ? {} : { sourceEgress: input.sourceEgress }) });
    return { ok: false as const, message: invalidUserFileMessage(current.path), reasonCode: 'CONFIG_INVALID' as const };
  }
  // Read the user's own layer (not the narrowed view) so a narrowing never gets written back.
  const userRead = readJson(current.path);
  const userConfig = userRead.kind === 'ok' ? (userRead.value as JevrisConfig) : DEFAULT_CONFIG;
  const before = getKey(userConfig, input.key);
  const next = setKey(userConfig, input.key, value);
  const checked = JevrisConfigContract.validate(next);
  if (!checked.ok) return { ok: false as const, message: 'The change would make the configuration invalid.' };
  const changed = before === value ? [] : [{ key: input.key, from: String(before), to: String(value) }];
  if (!input.dryRun && changed.length > 0) {
    const dir = jevrisPaths({ home: input.home }).config;
    const made = await ensurePrivateDir(dir);
    const written = made.ok ? await writePrivateFile(current.path, `${JSON.stringify(checked.value, null, 2)}\n`) : { ok: false };
    if (!written.ok) return { ok: false as const, message: `Could not write ${current.path}.` };
  }
  // Any `configure set mode` is the person's own choice: the upgrade notice has been read.
  if (!input.dryRun && input.key === 'mode') await clearModeMigrationNotice({ home: input.home });
  const after = input.dryRun ? { ...current, config: checked.value, source: 'file' as const } : readEffectiveConfig({ home: input.home });
  const decision = await (input.sourceEgress ?? hostSourceEgress)(input.home).catch((): SourceEgressDecision => 'not-approved');
  const preference = input.dryRun ? checked.value.privacy.sourceEgress : userEgressPreference(after.path);
  return payloadOf(after, changed, { decision, preference });
}

/** The marker that says the mode-default migration has run for this home (under the state directory). */
export const MODE_DEFAULT_MARKER = join('migrations', 'mode-default-bounded-auto.json');

export type ModeDefaultMigration = 'migrated' | 'unchanged' | 'already-done' | 'not-now';

/**
 * One-time migration for owner decision 0eb319de (the default mode became bounded-auto).
 *
 * The configuration contract requires `mode`, so every user file `jevris configure set` wrote
 * while observe was the default says `mode: "observe"`, whether or not the person chose it. Once
 * per home, a valid user file that says observe is taken as the old default and rewritten to
 * bounded-auto; every other key is kept. A marker under the state directory records that the
 * migration ran, so an observe set after it is never touched. No file: only the marker is
 * written. An invalid or unreadable file is left alone and the migration tries again next time.
 * The sidecar runs it at start, and both configure setters before they read the file.
 */
export async function migrateModeDefault(input: { readonly home: string; readonly env?: { readonly [key: string]: string | undefined }; readonly nowMs?: number }): Promise<ModeDefaultMigration> {
  const paths = jevrisPaths({ home: input.home, ...(input.env === undefined ? {} : { env: input.env }) });
  const marker = join(paths.state, MODE_DEFAULT_MARKER);
  try {
    if (statSync(marker).isFile()) return 'already-done';
  } catch {
    // No marker yet.
  }
  const path = join(paths.config, CONFIG_FILE);
  const user = readJson(path);
  if (user.kind === 'invalid') return 'not-now';
  let outcome: ModeDefaultMigration = 'unchanged';
  if (user.kind === 'ok') {
    const checked = JevrisConfigContract.validate(user.value);
    if (!checked.ok) return 'not-now';
    if (checked.value.mode === 'observe') {
      const next = JevrisConfigContract.validate(setKey(checked.value, 'mode', 'bounded-auto'));
      if (!next.ok) return 'not-now';
      const written = await writePrivateFile(path, `${JSON.stringify(next.value, null, 2)}\n`);
      if (!written.ok) return 'not-now';
      outcome = 'migrated';
    }
  }
  const dir = join(paths.state, 'migrations');
  const made = await ensurePrivateDir(dir);
  // A move is written as a fact (from, to, when), so status and doctor can tell the person once.
  const record = outcome === 'migrated' ? { migration: 'mode-default-bounded-auto', outcome, from: 'observe', to: 'bounded-auto', atMs: input.nowMs ?? Date.now(), noticeCleared: false } : { migration: 'mode-default-bounded-auto', outcome };
  if (made.ok) await writePrivateFile(marker, `${JSON.stringify(record)}\n`);
  return outcome;
}

/** The line status and doctor show after the migration moved a user's mode. */
export const MODE_MIGRATION_NOTICE = 'Mode moved from observe (the old default) to bounded-auto by the 1.2 upgrade; run `jevris configure set mode observe` to go back.';
/** How long the notice is shown at most. */
export const MODE_MIGRATION_NOTICE_MS = 30 * 86_400_000;

type MarkerLocation = { readonly home: string; readonly env?: { readonly [key: string]: string | undefined } };

function markerPath(input: MarkerLocation): string {
  return join(jevrisPaths({ home: input.home, ...(input.env === undefined ? {} : { env: input.env }) }).state, MODE_DEFAULT_MARKER);
}

function readMarker(path: string): { readonly [key: string]: unknown } | null {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > 4096) return null;
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isPlain(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * MODE_MIGRATION_NOTICE while it applies: the migration moved this home's mode, less than 30 days
 * ago, and no `jevris configure set mode` ran since. Otherwise null. Never throws.
 */
export function modeMigrationNotice(input: MarkerLocation & { readonly nowMs?: number }): string | null {
  const marker = readMarker(markerPath(input));
  if (marker === null || marker['outcome'] !== 'migrated' || marker['noticeCleared'] === true) return null;
  const atMs = marker['atMs'];
  if (typeof atMs !== 'number' || !Number.isFinite(atMs)) return null;
  const age = (input.nowMs ?? Date.now()) - atMs;
  return age >= 0 && age < MODE_MIGRATION_NOTICE_MS ? MODE_MIGRATION_NOTICE : null;
}

/** Ends the notice: the person ran `jevris configure set mode`. The fact stays in the marker. */
export async function clearModeMigrationNotice(input: MarkerLocation): Promise<void> {
  const path = markerPath(input);
  const marker = readMarker(path);
  if (marker === null || marker['outcome'] !== 'migrated' || marker['noticeCleared'] === true) return;
  await writePrivateFile(path, `${JSON.stringify({ ...marker, noticeCleared: true })}\n`).catch(() => undefined);
}

/** The file operations `replaceUnusableUserFile` uses; tests inject failures (SR-23). */
export interface ReplaceUserFilePorts {
  /** The folder check (default @jevris/platform ensurePrivateDir: no link, yours, owner-only). */
  readonly ensureDir?: (dir: string) => Promise<PrivateResult>;
  /** An owner-only durable write: temp, fsync, atomic rename (default writePrivateFile). */
  readonly writeFile?: (path: string, data: string) => Promise<DurableWriteResult>;
  /** A rename (default renameWithRetry). */
  readonly rename?: (from: string, to: string) => Promise<DurableWriteResult>;
  /** A hard link (default linkSync); throws when the file system has none. */
  readonly link?: (from: string, to: string) => void;
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Only this call's own temporary name is removed.
  }
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * SR-20's way out: `configure set mode off|observe` while your file cannot be used. A fresh file
 * (the defaults with that mode) replaces it, and the unusable one is kept as `<path>.invalid`
 * (replacing an earlier one). Nothing it said is carried over, since none of it was in effect.
 *
 * SR-23: the unusable file stays in place until the fresh one is safely there, so a failure never
 * leaves no file (which would mean the bounded-auto defaults) and the observe cap holds:
 * 1. The folder check runs first. If the folder is a link, not yours, or its ACL cannot be set,
 *    nothing is touched and the refusal names the folder, the file and the fix.
 * 2. A regular file is kept as `.invalid` through a hard link (it need not be readable), and the
 *    fresh file is written by the owner-only durable write: a temp, fsync, then one atomic rename
 *    straight over the unusable file. If that write fails, the unusable file is still there.
 * 3. Anything else (a folder or link in its place, or no hard links): the fresh file is written
 *    under a temporary name first, the unusable one is moved to `.invalid`, and the fresh one is
 *    moved in. If that last move fails, the unusable one is moved back.
 */
export async function replaceUnusableUserFile(input: {
  readonly home: string;
  readonly mode: unknown;
  readonly sourceEgress?: (home: string) => Promise<SourceEgressDecision>;
  readonly ports?: ReplaceUserFilePorts;
}) {
  const { home, mode } = input;
  const ports = input.ports ?? {};
  const ensureDir = ports.ensureDir ?? ((dir: string) => ensurePrivateDir(dir));
  const writeFile = ports.writeFile ?? ((path: string, data: string) => writePrivateFile(path, data));
  const rename = ports.rename ?? ((from: string, to: string) => renameWithRetry(from, to));
  const link = ports.link ?? linkSync;
  const current = readEffectiveConfig({ home });
  const path = current.path;
  const fresh = JevrisConfigContract.validate(setKey(DEFAULT_CONFIG, 'mode', mode));
  if (!fresh.ok) return { ok: false as const, message: 'The change would make the configuration invalid.' };
  const text = `${JSON.stringify(fresh.value, null, 2)}\n`;
  const dir = dirname(path);
  const backup = `${path}.invalid`;
  const failed = (code: string, state: 'kept' | 'restored' | 'lost') => ({
    ok: false as const,
    reasonCode: state === 'lost' ? ('CONFIG_RESTORE_FAILED' as const) : ('CONFIG_WRITE_FAILED' as const),
    message:
      state === 'lost'
        ? `Could not write a fresh ${path} (${code}), and the unusable file could not be moved back: it is at ${backup}. Move it back to ${path}, or fix the folder and run jevris configure set mode ${String(mode)} again.`
        : `Nothing was changed: could not write a fresh ${path} (${code}). The unusable file is ${state === 'kept' ? 'still' : 'back'} in place, so the mode stays capped at observe. Fix the folder or the disk, then run jevris configure set mode ${String(mode)} again, or fix the file by hand.`,
  });
  // 1. The folder check, before anything is touched.
  const folder = await ensureDir(dir);
  if (!folder.ok) {
    return {
      ok: false as const,
      reasonCode: 'CONFIG_DIR_REFUSED' as const,
      message: `Nothing was changed: ${dir} is not a private folder Jevris can write (${folder.code}), so ${path} stays as it is and the mode stays capped at observe. Make ${dir} a real folder that you own (not a link), then run jevris configure set mode ${String(mode)} again.`,
    };
  }
  const unique = `${process.pid}.${randomBytes(6).toString('hex')}`;
  let replaced = false;
  // 2. A regular file: keep it as .invalid through a hard link, then replace it atomically.
  if (isRegularFile(path)) {
    const kept = `${path}.${unique}.invalid-tmp`;
    let backedUp = false;
    try {
      link(path, kept);
      backedUp = (await rename(kept, backup)).ok;
    } catch {
      backedUp = false;
    }
    if (!backedUp) removeQuietly(kept);
    if (backedUp) {
      const written = await writeFile(path, text);
      if (!written.ok) return failed(written.code, 'kept');
      replaced = true;
    }
  }
  // 3. Otherwise: the fresh file first under a temporary name, then two moves, undone on failure.
  if (!replaced) {
    const staged = `${path}.${unique}.new`;
    const written = await writeFile(staged, text);
    if (!written.ok) {
      removeQuietly(staged);
      return failed(written.code, 'kept');
    }
    const aside = await rename(path, backup);
    if (!aside.ok) {
      removeQuietly(staged);
      return failed(aside.code, 'kept');
    }
    const placed = await rename(staged, path);
    if (!placed.ok) {
      const restored = await rename(backup, path);
      removeQuietly(staged);
      return failed(placed.code, restored.ok ? 'restored' : 'lost');
    }
  }
  await clearModeMigrationNotice({ home });
  const after = readEffectiveConfig({ home });
  const decision = await (input.sourceEgress ?? hostSourceEgress)(home).catch((): SourceEgressDecision => 'not-approved');
  return payloadOf(after, [{ key: 'mode', from: 'unusable file', to: String(mode) }], { decision, preference: userEgressPreference(after.path) });
}

/** A plain-text diff for `jevris configure set --dry-run` (SET-03). */
export function renderConfigDiff(changed: readonly { readonly key: string; readonly from: string; readonly to: string }[], dryRun: boolean): string {
  if (changed.length === 0) return 'No change.';
  const lines = changed.map((c) => `- ${c.key}: ${c.from}\n+ ${c.key}: ${c.to}`);
  return `${lines.join('\n')}\n${dryRun ? 'Dry run: nothing was written. Native harness permissions are unchanged.' : 'Saved. Native harness permissions are unchanged.'}`;
}

/**
 * The organization policy (`<config>/organization.json`), parsed with the contracts'
 * HostDocument validator. The one parser for that file: the sidecar reads it through here.
 */
export function readOrganizationPolicy(input: ConfigLocation): { readonly state: 'absent' } | { readonly state: 'invalid'; readonly code: string } | { readonly state: 'ok'; readonly policy: HostDocument } {
  const paths = jevrisPaths({ ...(input.home === undefined ? {} : { home: input.home }), ...(input.env === undefined ? {} : { env: input.env }) });
  const raw = readJson(join(paths.config, 'organization.json'));
  if (raw.kind === 'missing') return { state: 'absent' };
  if (raw.kind === 'invalid') return { state: 'invalid', code: raw.code };
  const doc = copyHostDocument(raw.value);
  return doc === undefined ? { state: 'invalid', code: 'INVALID_POLICY' } : { state: 'ok', policy: doc };
}

/**
 * Effective retention in days (SSOT §16.3, §23.1): the user's settings, capped by the
 * organization's `retention.rawArtifactRetentionDays` and `retention.decisionRetentionDays`
 * (maximums). An invalid organization file is reported and the defaults' stricter bound holds.
 */
export function effectiveRetention(input: ConfigLocation): { readonly rawArtifactRetentionDays: number; readonly decisionRetentionDays: number; readonly organization: 'absent' | 'invalid' | 'ok' } {
  const eff = readEffectiveConfig(input);
  const org = readOrganizationPolicy(input);
  const raw = eff.config.privacy.rawArtifactRetentionDays;
  const decisions = eff.config.privacy.decisionRetentionDays;
  if (org.state === 'invalid') {
    return {
      rawArtifactRetentionDays: Math.min(raw, DEFAULT_CONFIG.privacy.rawArtifactRetentionDays),
      decisionRetentionDays: Math.min(decisions, DEFAULT_CONFIG.privacy.decisionRetentionDays),
      organization: 'invalid',
    };
  }
  return { rawArtifactRetentionDays: raw, decisionRetentionDays: decisions, organization: org.state };
}

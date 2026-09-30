/**
 * Reduced-mode answers (§17.3, CMD-04): deterministic results computed from local state when
 * the sidecar cannot answer. They never claim what only the sidecar knows. A reduced status
 * says the decision health is unknown; a reduced verify says nothing ran; a reduced task
 * lookup says the task store is not reachable.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  HARNESS_IDS,
  JevrisConfigContract,
  MemoryCapsuleContract,
  canonicalJson,
  containsSecret,
  type CheckpointPayload,
  type ConfigurePayload,
  type EvidenceSelectPayload,
  type ExplainPayload,
  type HandoffExportPayload,
  type HandoffImportPayload,
  type JevrisConfig,
  type MemoryCapsule,
  type ModeSource,
  type RecoverPayload,
  type RoutePayload,
  type StatusPayload,
  type VerifyPayload,
} from '@jevris/contracts';
import { DecisionBudget, UNKNOWN_BUDGET_STATUS, budgetStatusView, harnessModelRef } from '@jevris/core';
import { ADMIN_KEYS, ADMIN_VALUES, DEFAULT_CONFIG, SETTABLE_KEYS, backgroundAtStopOf, firstTryOf, jevBudgetOf, machineJevBudget, workspaceJevBudget, clearModeMigrationNotice, invalidUserFileMessage, raiseRefusal, raisesAuthority, layerIssues, mainSessionView, migrateModeDefault, modeMigrationNotice, readEffectiveConfig } from '@jevris/orchestrator';
import { ensurePrivateDir, runSync, writePrivateFile } from '@jevris/platform';
import { resolveHostSourceEgress, type HostEgressDecision } from '../host-policy.js';
import { readKillSwitchStopped } from '../kill-switch.js';
import type { SurfaceContext } from './context.js';
import type { OpInputs } from './inputs.js';
import { MODEL } from './inputs.js';

/** D's install defaults: one source, so the local fallback never shows a different default. */
export { DEFAULT_CONFIG };

const CONFIG_BYTE_CAP = 262_144;
const CAPSULE_BYTE_CAP = 524_288;

export function configPath(ctx: SurfaceContext): string {
  return join(ctx.paths.config, 'jevris.config.json');
}

function readCapped(path: string, cap: number): string | 'missing' | 'over' {
  try {
    const info = statSync(path);
    if (!info.isFile()) return 'missing';
    if (info.size > cap) return 'over';
    return readFileSync(path, 'utf8');
  } catch {
    return 'missing';
  }
}

export interface LocalConfig {
  readonly config: JevrisConfig;
  readonly source: 'defaults' | 'file';
  readonly path: string | null;
  readonly valid: boolean;
  readonly issues: readonly { readonly path: string; readonly code: string }[];
}

/** The configuration file, validated. An invalid or unreadable file falls back to defaults and says so. */
export function readLocalConfig(ctx: SurfaceContext): LocalConfig {
  const path = configPath(ctx);
  const raw = readCapped(path, CONFIG_BYTE_CAP);
  if (raw === 'missing') return { config: DEFAULT_CONFIG, source: 'defaults', path: null, valid: true, issues: [] };
  if (raw === 'over') return { config: DEFAULT_CONFIG, source: 'file', path, valid: false, issues: [{ path: '', code: 'TOO_LARGE' }] };
  const checked = JevrisConfigContract.parse(raw);
  if (!checked.ok) return { config: DEFAULT_CONFIG, source: 'file', path, valid: false, issues: checked.issues.slice(0, 64) };
  return { config: checked.value, source: 'file', path, valid: true, issues: [] };
}

function sha256(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('hex');
}

// ------------------------------------------------------------------------------------ status

function storeState(ctx: SurfaceContext): StatusPayload['store'] {
  const db = join(ctx.paths.data, 'jevris.db');
  if (!existsSync(db)) return { state: 'absent', diagnostic: null };
  return { state: 'ok', diagnostic: null };
}

/**
 * The effective settings for this workspace: D's one resolver (`readEffectiveConfig`: defaults,
 * `jevris.config.json`, the workspace's `.jevris/config.json` lowering, the `organization.json`
 * ceiling), the same one the sidecar's status and `jevris configure` read. An unreadable or
 * invalid file gives the defaults, as there.
 */
export function effectiveSettings(ctx: SurfaceContext): { readonly config: JevrisConfig; readonly modeSource: ModeSource; readonly issues: readonly { readonly path: string; readonly code: string }[] } {
  try {
    const eff = readEffectiveConfig({ home: ctx.home, env: ctx.env, workspaceRoot: ctx.workspaceRoot });
    return { config: eff.config, modeSource: eff.modeSource, issues: eff.issues };
  } catch {
    return { config: DEFAULT_CONFIG, modeSource: 'defaults', issues: [] };
  }
}

/** The effective settings' values alone (see effectiveSettings). */
export function effectiveConfig(ctx: SurfaceContext): JevrisConfig {
  return effectiveSettings(ctx).config;
}


/**
 * The model the person pinned in the harness (`ANTHROPIC_MODEL`), which Jevris never changes, as
 * a contract ModelId, or null. The local status shows it, and the CLI sends it with a status
 * request, since the sidecar cannot read the session's environment.
 */
export function harnessModelPin(env: SurfaceContext['env']): string | null {
  const pin = env['ANTHROPIC_MODEL'];
  return typeof pin === 'string' && MODEL.test(pin) && !containsSecret(pin) ? pin : null;
}

export async function localStatus(ctx: SurfaceContext, degradedReason: string): Promise<StatusPayload> {
  const { config, modeSource, issues } = effectiveSettings(ctx);
  const stopped = await readKillSwitchStopped(ctx.home);
  // OD-8: without the sidecar no certification is read, so no harness shows turns as switchable.
  const mainSessions = HARNESS_IDS.map((harness) => ({ harness, ...mainSessionView(config.routing.mainSession, harness, { certified: false, killSwitchStopped: stopped }) }));
  const modelPin = harnessModelPin(ctx.env);
  return {
    jevrisMode: config.mode,
    killSwitch: stopped ? 'stopped' : 'clear',
    decisionHealth: config.mode === 'off' ? 'off' : stopped ? 'degraded' : 'unknown',
    degradedReason,
    routing: { modelPin, pinned: modelPin !== null },
    activeWorkers: [],
    budget: await localJevBudget(ctx),
    recentDecisions: [],
    unknownSlices: [],
    store: storeState(ctx),
    mainSessions,
    backgroundVerifyAtStop: backgroundAtStopOf(config),
    firstTryRouting: firstTryOf(config),
    modeSource,
    settingsIssues: layerIssues(issues).slice(0, 16).map((issue) => ({ path: issue.path.slice(0, 256), code: issue.code.slice(0, 64) })),
    ...modeNoticeOf(ctx),
  };
}

/**
 * The Jev decision budget without the sidecar (owner decision 2026-09-29): the same shared budget
 * file the sidecar's engine reserves against, read without its lock (a read never changes it),
 * with the same limits. Unknown when it cannot be read.
 */
async function localJevBudget(ctx: SurfaceContext): Promise<StatusPayload['budget']> {
  try {
    const workspaceId = ctx.workspaceRoot === null ? undefined : ctx.workspaceId;
    const cap = workspaceId === undefined ? null : workspaceJevBudget({ home: ctx.home, env: ctx.env, workspaceId, workspaceRoot: ctx.workspaceRoot });
    const budget = DecisionBudget.open(join(ctx.paths.data, 'decision-budget.json'), {
      limitMicroUsd: machineJevBudget({ home: ctx.home, env: ctx.env }),
      workspaceLimit: () => cap?.capMicroUsd ?? null,
      period: 'month',
      now: () => ctx.nowMs(),
    });
    return budgetStatusView(await budget.snapshot(workspaceId), cap?.source ?? 'cap');
  } catch {
    return UNKNOWN_BUDGET_STATUS;
  }
}

/** The upgrade's mode notice while it applies (D's modeMigrationNotice), as the status field. */
function modeNoticeOf(ctx: SurfaceContext): { readonly modeNotice?: string } {
  try {
    const notice = modeMigrationNotice({ home: ctx.home, env: ctx.env });
    return notice === null ? {} : { modeNotice: notice };
  } catch {
    return {};
  }
}

// ----------------------------------------------------------------------------------- explain

export function explainNotFound(decisionId: string): ExplainPayload {
  return { decisionId, found: false, trace: null };
}

// ------------------------------------------------------------------------------------- route

/** G20: a harness model id as the bare model id the route answer carries (no registry here). */
function bareModel(raw: string | null): string | null {
  return raw === null ? null : (harnessModelRef(null, raw)?.modelId ?? null);
}

export function localRoute(route: OpInputs['route'], reason: string): RoutePayload {
  const input = { ...route, currentModel: bareModel(route.currentModel), modelPin: bareModel(route.modelPin) };
  const pinned = input.modelPin !== null;
  const mainText = pinned
    ? `Keep ${input.modelPin}. It is pinned, and Jevris never changes a pinned model.`
    : 'Keep the current model. Jevris has no calibrated routing evidence here, so it does not recommend a switch.';
  return {
    main: {
      currentModel: input.currentModel,
      modelPin: input.modelPin,
      pinState: pinned ? 'pinned' : 'unpinned',
      outcome: pinned ? 'keep' : 'abstain',
      recommendedModel: null,
      reasonCode: pinned ? 'PIN_RESPECTED' : 'ROUTER_UNAVAILABLE',
      costBasis: 'unknown',
      text: `${mainText} ${reason}`.slice(0, 1000),
      adviceKey: null,
    },
    worker: {
      outcome: 'abstain',
      recommendedModel: null,
      reasonCode: 'NO_CALIBRATION',
      text: 'No managed-worker recommendation: worker routing needs a released calibration artifact.',
    },
    applied: false,
  };
}

// -------------------------------------------------------------------------------- checkpoint

interface LocalCapsuleFile {
  readonly schemaVersion: 'jevris-local-capsule-1';
  readonly capsule: MemoryCapsule;
  readonly items: CheckpointPayload['items'];
}

function capsuleDir(ctx: SurfaceContext): string {
  return join(ctx.paths.data, 'capsules', ctx.workspaceId);
}

function gitLines(ctx: SurfaceContext, args: readonly string[]): string | null {
  if (ctx.workspaceRoot === null) return null;
  const result = runSync('git', ['-C', ctx.workspaceRoot, ...args], { timeoutMs: 3000 });
  return result.ok && result.status === 0 ? result.stdout : null;
}

function changedFiles(ctx: SurfaceContext): { readonly path: string; readonly hash: string | null }[] {
  const out = gitLines(ctx, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  if (out === null || ctx.workspaceRoot === null) return [];
  const root = ctx.workspaceRoot;
  const entries = out.split('\0').filter((entry) => entry.length > 3);
  const files: { path: string; hash: string | null }[] = [];
  for (const entry of entries.slice(0, 256)) {
    const rel = entry.slice(3);
    if (rel.includes('..')) continue;
    let hash: string | null = null;
    try {
      const full = join(root, rel);
      const info = statSync(full);
      if (info.isFile() && info.size <= 1_048_576) hash = sha256(readFileSync(full));
    } catch {
      hash = null;
    }
    files.push({ path: rel, hash });
  }
  return files;
}

function isoNow(ctx: SurfaceContext, offsetMs = 0): string {
  return new Date(ctx.nowMs() + offsetMs).toISOString();
}

function revision(ctx: SurfaceContext): string {
  const head = gitLines(ctx, ['rev-parse', '--short=12', 'HEAD']);
  const value = head?.trim() ?? '';
  return /^[0-9a-f]{7,40}$/.test(value) ? value : 'no-git';
}

/**
 * JEV-0022, GOV-02..04: a stopped Jevris writes no capsule. The sidecar refuses `checkpoint` and
 * `handoff.import` while the kill switch is on; without a sidecar these two commands write the
 * capsule file from here, so the same refusal is made here, before anything is written.
 */
export async function killSwitchWriteRefusal(
  ctx: SurfaceContext,
  op: 'checkpoint' | 'handoff.import',
): Promise<{ readonly ok: false; readonly message: string; readonly reasonCode: 'KILL_SWITCH' } | null> {
  if (!(await readKillSwitchStopped(ctx.home))) return null;
  const what = op === 'checkpoint' ? 'no checkpoint is written' : 'no handoff is imported';
  return { ok: false, reasonCode: 'KILL_SWITCH', message: `The kill switch is on, so ${what}. Clear the kill switch first (jevris kill-switch clear), then run this again.` };
}

export async function localCheckpoint(ctx: SurfaceContext, input: OpInputs['checkpoint']): Promise<CheckpointPayload> {
  const id = `cap-${ctx.nowMs().toString(36)}-${randomBytes(4).toString('hex')}`;
  const observedAt = isoNow(ctx);
  const rev = revision(ctx);
  const items: CheckpointPayload['items'][number][] = [];
  const objective = input.objective ?? 'No objective was declared for this checkpoint.';
  items.push({ kind: 'objective', text: objective.slice(0, 1000) });
  const pinned: MemoryCapsule['pinnedEvidence'][number][] = input.constraints.map((constraint, index) => {
    items.push({ kind: 'constraint', text: constraint });
    return {
      id: `constraint-${index + 1}`,
      workspaceId: ctx.workspaceId,
      contentHash: `sha256:${sha256(constraint)}`,
      sourceKind: 'user',
      trust: 'human-input',
      observedAt,
      revision: rev,
    };
  });
  const files = changedFiles(ctx);
  const optional: MemoryCapsule['optionalEvidence'][number][] = [];
  files.forEach((file, index) => {
    items.push({ kind: 'changed-file', text: `${file.path}${file.hash === null ? ' (not hashed)' : ` sha256:${file.hash.slice(0, 12)}`}`.slice(0, 1000) });
    if (file.hash !== null) {
      optional.push({
        id: `file-${index + 1}`,
        workspaceId: ctx.workspaceId,
        contentHash: `sha256:${file.hash}`,
        sourceKind: 'file',
        trust: 'untrusted-content',
        observedAt,
        revision: rev,
      });
    }
  });
  const capsule: MemoryCapsule = {
    id,
    schemaVersion: '1.0',
    workspaceId: ctx.workspaceId,
    revision: rev,
    objective: objective.slice(0, 4000),
    pinnedEvidence: pinned,
    optionalEvidence: optional.slice(0, 1024),
    taskIds: input.taskId === null ? [] : [input.taskId],
    unresolvedItems: [],
    hypotheses: [],
    authorizationHistoryRefs: [],
    validUntil: isoNow(ctx, 7 * 24 * 3600 * 1000),
  };
  const checked = MemoryCapsuleContract.validate(capsule);
  let written = false;
  if (checked.ok) {
    const dir = capsuleDir(ctx);
    const made = await ensurePrivateDir(dir);
    if (made.ok) {
      const file: LocalCapsuleFile = { schemaVersion: 'jevris-local-capsule-1', capsule, items: items.slice(0, 128) };
      const result = await writePrivateFile(join(dir, `${id}.json`), `${canonicalJson(file)}\n`);
      written = result.ok;
    }
  }
  return {
    capsuleId: id,
    handle: `capsule:${id}`,
    written,
    retained: { constraints: input.constraints.length, changedFiles: files.length, openChecks: 0, unresolved: 0, hypotheses: 0 },
    items: items.slice(0, 128),
    compactionTriggered: false,
  };
}

function readCapsuleFile(path: string): LocalCapsuleFile | null {
  const raw = readCapped(path, CAPSULE_BYTE_CAP);
  if (raw === 'missing' || raw === 'over') return null;
  try {
    const parsed = JSON.parse(raw) as { schemaVersion?: unknown; capsule?: unknown; items?: unknown };
    if (parsed.schemaVersion !== 'jevris-local-capsule-1') return null;
    const checked = MemoryCapsuleContract.validate(parsed.capsule);
    if (!checked.ok) return null;
    return { schemaVersion: 'jevris-local-capsule-1', capsule: checked.value, items: Array.isArray(parsed.items) ? (parsed.items as LocalCapsuleFile['items']) : [] };
  } catch {
    return null;
  }
}

export function localHandoffExport(ctx: SurfaceContext, input: OpInputs['handoff.export']): HandoffExportPayload {
  const dir = capsuleDir(ctx);
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((name: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(name));
  } catch {
    names = [];
  }
  let chosen: LocalCapsuleFile | null = null;
  if (input.capsuleId !== null) {
    chosen = names.includes(`${input.capsuleId}.json`) ? readCapsuleFile(join(dir, `${input.capsuleId}.json`)) : null;
  } else {
    let newest = -1;
    for (const name of names) {
      const file = readCapsuleFile(join(dir, name));
      if (file === null) continue;
      if (input.taskId !== null && !file.capsule.taskIds.includes(input.taskId)) continue;
      const at = Date.parse(file.capsule.pinnedEvidence[0]?.observedAt ?? file.capsule.validUntil);
      let mtime = 0;
      try {
        mtime = statSync(join(dir, name)).mtimeMs;
      } catch {
        mtime = 0;
      }
      const key = Math.max(Number.isFinite(at) ? at : 0, mtime);
      if (key > newest) {
        newest = key;
        chosen = file;
      }
    }
  }
  if (chosen === null) return { capsuleId: input.capsuleId, found: false, capsule: null, contentHash: null };
  return {
    capsuleId: chosen.capsule.id,
    found: true,
    capsule: chosen.capsule,
    contentHash: `sha256:${sha256(canonicalJson(chosen.capsule))}`,
  };
}

/**
 * The v1 MemoryCapsule inside an import: D's `jevris-portable-capsule-2` envelope (what
 * handoff.export returns in full mode) carries it at `.capsule`; a bare v1 capsule is itself.
 */
export function portableCapsule(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as { readonly [key: string]: unknown };
  if (Object.hasOwn(record, 'schemaVersion') && record['schemaVersion'] === 'jevris-portable-capsule-2') {
    return Object.hasOwn(record, 'capsule') ? record['capsule'] : undefined;
  }
  return value;
}

export async function localHandoffImport(ctx: SurfaceContext, input: OpInputs['handoff.import']): Promise<HandoffImportPayload> {
  const refused = (reasonCode: string): HandoffImportPayload => ({
    accepted: false,
    reasonCode,
    capsuleId: null,
    facts: 0,
    unresolved: [],
    authorityGranted: false,
  });
  const checked = MemoryCapsuleContract.validate(portableCapsule(input.capsule));
  if (!checked.ok) return refused('CAPSULE_INVALID');
  const capsule = checked.value;
  if (capsule.workspaceId !== ctx.workspaceId) return refused('WORKSPACE_MISMATCH');
  if (Date.parse(capsule.validUntil) <= ctx.nowMs()) return refused('CAPSULE_EXPIRED');
  const dir = capsuleDir(ctx);
  const made = await ensurePrivateDir(dir);
  if (!made.ok) return refused('STORE_UNAVAILABLE');
  const file: LocalCapsuleFile = {
    schemaVersion: 'jevris-local-capsule-1',
    capsule,
    items: [{ kind: 'objective', text: capsule.objective.slice(0, 1000) }],
  };
  const written = await writePrivateFile(join(dir, `${capsule.id}.json`), `${canonicalJson(file)}\n`);
  if (!written.ok) return refused('STORE_UNAVAILABLE');
  return {
    accepted: true,
    reasonCode: 'IMPORTED',
    capsuleId: capsule.id,
    facts: capsule.pinnedEvidence.length,
    unresolved: capsule.unresolvedItems.slice(0, 64).map((item) => item.slice(0, 500)),
    authorityGranted: false,
  };
}

// ----------------------------------------------------------------------------------- recover

/**
 * §10.4 deterministic loop signals. The action comes from the recovery allowlist; nothing is
 * retried or changed here.
 */
export function localRecover(input: OpInputs['recover']): RecoverPayload {
  const prints = input.signals.fingerprints;
  const env = input.signals.environment;
  const counts = new Map<string, number>();
  for (const print of prints) counts.set(print, (counts.get(print) ?? 0) + 1);
  const maxRepeat = counts.size === 0 ? 0 : Math.max(...counts.values());
  const environmentFailures = env.filter(Boolean).length;
  const signals = { failures: prints.length, distinctFingerprints: counts.size, maxRepeat, environmentFailures };
  const last = prints.slice(-4);
  const oscillating = last.length === 4 && last[0] === last[2] && last[1] === last[3] && last[0] !== last[1];
  const rejectedApproaches = input.rejectedApproaches.slice(0, 32);
  const answer = (classification: RecoverPayload['classification'], action: RecoverPayload['action'], advice: string): RecoverPayload => ({
    classification,
    action,
    advice,
    signals,
    rejectedApproaches,
  });
  if (prints.length === 0) {
    return answer('no-signal', 'continue', 'No failure signals were given. Continue, and run recover again with the failing check fingerprints if work stalls.');
  }
  if (environmentFailures * 2 >= prints.length && environmentFailures >= 2) {
    return answer(
      'environment-failure',
      'ask-focused-question',
      'Most failures come from the environment, not the code. Ask one focused question about the missing service or tool before changing source.',
    );
  }
  if (oscillating) {
    return answer(
      'patch-oscillation',
      'restore-checkpoint-with-approval',
      'The last attempts alternate between two failures. Stop patching; with the user\'s approval, restore the last good checkpoint and record both approaches as rejected.',
    );
  }
  if (maxRepeat >= 4) {
    return answer(
      'repeated-failure',
      'stop-and-report',
      `The same failure repeated ${maxRepeat} times. Stop and report what was tried, the failing check and the open question; do not try random changes.`,
    );
  }
  if (maxRepeat === 3) {
    return answer(
      'repeated-failure',
      'route-stronger-worker',
      'The same failure repeated 3 times. Hand the task, the capsule and the rejected approaches to a stronger worker, or ask the user for guidance.',
    );
  }
  if (maxRepeat === 2 && counts.size === 1) {
    return answer('flaky-suspected', 'rerun-check-once', 'One failure repeated twice. Rerun the check once in the same environment to separate a flake from a real defect.');
  }
  return answer('progress', 'continue', 'Failures are changing, which suggests progress. Continue, and record each rejected approach in the capsule.');
}

// ------------------------------------------------------------------------------------ verify

export function localVerify(input: OpInputs['verify']): VerifyPayload {
  const checks = input.checkIds.map((checkId) => ({ checkId, mandatory: true, outcome: 'not-run' as const, receiptId: null, fresh: false }));
  return { ran: false, readiness: checks.length === 0 ? 'no-checks' : 'not-verified', checks, missing: [...input.checkIds] };
}

// --------------------------------------------------------------------------------- configure


/**
 * The effective settings. `sourceEgress` is the host decision the egress guard enforces (the same
 * one `jevris egress status` shows), never the file's `privacy.sourceEgress`: that is only a
 * preference, reported apart, so a user file saying approved-scoped never shows as approved.
 */
export function effectiveView(config: JevrisConfig, egress: HostEgressDecision, preference: JevrisConfig['privacy']['sourceEgress'] | null, modeSource: ModeSource): Required<ConfigurePayload['effective']> {
  return {
    mode: config.mode,
    modeSource,
    sourceEgress: egress === 'approved' ? 'approved-scoped' : 'deny-until-approved',
    sourceEgressSource: 'host-policy',
    sourceEgressPreference: preference,
    remoteTelemetry: config.privacy.remoteTelemetry,
    mainSession: config.routing.mainSession,
    managedWorkers: config.routing.managedWorkers,
    orchestrationEnabled: config.orchestration.enabled,
    monthlyBudgetMicroUsd: jevBudgetOf(config),
    backgroundVerifyAtStop: backgroundAtStopOf(config),
    firstTryRouting: firstTryOf(config),
  };
}

/** The host decision through the port's seam or the guard's resolver; anything but approved is not approved. */
async function hostEgress(ctx: SurfaceContext): Promise<HostEgressDecision> {
  const resolve = ctx.ports.config.sourceEgress ?? resolveHostSourceEgress;
  return (await resolve(ctx.home).catch((): HostEgressDecision => 'not-approved')) === 'approved' ? 'approved' : 'not-approved';
}

/** The jevris.config.json `privacy.sourceEgress` preference; null when no valid file sets it. */
function egressPreference(local: LocalConfig): JevrisConfig['privacy']['sourceEgress'] | null {
  return local.source === 'file' && local.valid ? local.config.privacy.sourceEgress : null;
}

/**
 * D's configure answer with source egress as the host decision: kept when D already reports it
 * from host policy, otherwise resolved here, so no path shows a user file's value as approved.
 */
export async function withHostSourceEgress(ctx: SurfaceContext, payload: ConfigurePayload): Promise<ConfigurePayload> {
  if (payload.effective.sourceEgressSource === 'host-policy') return payload;
  const local = readLocalConfig(ctx);
  const { sourceEgress, sourceEgressSource, sourceEgressPreference } = effectiveView(local.config, await hostEgress(ctx), egressPreference(local), 'defaults');
  return { ...payload, effective: { ...payload.effective, sourceEgress, sourceEgressSource, sourceEgressPreference } };
}

function getKey(config: JevrisConfig, key: string): string {
  let value: unknown = config;
  for (const part of key.split('.')) value = value === undefined || value === null ? undefined : (value as Record<string, unknown>)[part];
  // An optional key the file leaves out (decisions.monthlyBudgetMicroUsd) has its default.
  if (value === undefined && config !== DEFAULT_CONFIG) return getKey(DEFAULT_CONFIG, key);
  return String(value);
}

function setKey(config: JevrisConfig, key: string, value: unknown): JevrisConfig {
  const copy = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  const parts = key.split('.');
  let target = copy;
  for (const part of parts.slice(0, -1)) {
    // An optional group the file leaves out (verification) is created so a key inside it can be set.
    if (typeof target[part] !== 'object' || target[part] === null) target[part] = {};
    target = target[part] as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1] as string;
  target[leaf] = value;
  return copy as unknown as JevrisConfig;
}

export type ConfigureAnswer = { readonly ok: true; readonly payload: ConfigurePayload } | { readonly ok: false; readonly message: string; readonly reasonCode?: string };

export async function localConfigure(ctx: SurfaceContext, input: OpInputs['configure']): Promise<ConfigureAnswer> {
  // D's one-time mode-default migration (owner decision 0eb319de) runs before a write reads the file.
  if (input.set !== null && !input.dryRun && ctx.scope === 'cli') await migrateModeDefault({ home: ctx.home, env: ctx.env }).catch(() => 'not-now');
  const local = readLocalConfig(ctx);
  const egress = await hostEgress(ctx);
  // The effective values (D's resolver: the workspace lowering and the administrator ceilings),
  // with the layer issues after the user file's own.
  const effective = effectiveSettings(ctx);
  const issues = [...local.issues, ...layerIssues(effective.issues)].slice(0, 64);
  const base: ConfigurePayload = {
    source: local.source,
    path: local.path ?? configPath(ctx),
    valid: local.valid,
    issues: issues.map((issue) => ({ path: issue.path.slice(0, 256), code: issue.code.slice(0, 64) })),
    effective: effectiveView(effective.config, egress, egressPreference(local), effective.modeSource),
    changed: [],
    nativePermissionsChanged: false,
  };
  if (input.set === null) return { ok: true, payload: base };
  const { key, value } = input.set;
  if (ctx.scope !== 'cli') return { ok: false, message: 'Settings change only from the jevris CLI, never from a model tool call.' };
  // D's one list of settable keys and their parsers, and of the keys an administrator owns: the
  // same checks as D's setConfigValue, so this fallback and the help cannot drift from it.
  const parse = SETTABLE_KEYS[key];
  if (parse === undefined) return { ok: false, message: ADMIN_KEYS[key] ?? `"${key}" is not a setting. Settable: ${Object.keys(SETTABLE_KEYS).join(', ')}.` };
  // A value only an administrator sets (D's ADMIN_VALUES, e.g. routing.mainSession owned-sdk-approved) gives D's message.
  const adminValue = ADMIN_VALUES[key];
  if (adminValue !== undefined && adminValue.value === value) return { ok: false, message: adminValue.message };
  const parsed = parse(value);
  if (parsed === undefined) return { ok: false, message: `"${value}" is not a valid value for ${key}.` };
  // SR-19: a raise needs a person at a terminal (the CLI asked B's personAtTerminal and set `confirmed`).
  if (!input.dryRun && !input.confirmed && raisesAuthority({ home: ctx.home, env: ctx.env }, key, value)) return { ok: false, message: raiseRefusal(key, value), reasonCode: 'CHANNEL_REFUSED' };
  // SR-20: D's setter can replace an unusable file; this reduced fallback names the file and the fix.
  if (!local.valid) return { ok: false, message: invalidUserFileMessage(configPath(ctx), false), reasonCode: 'CONFIG_INVALID' };
  const before = getKey(local.config, key);
  const next = setKey(local.config, key, parsed);
  const checked = JevrisConfigContract.validate(next);
  if (!checked.ok) return { ok: false, message: 'The change would make the configuration invalid.' };
  const after = String(parsed);
  const changed = before === after ? [] : [{ key, from: before, to: after }];
  if (!input.dryRun && changed.length > 0) {
    const made = await ensurePrivateDir(ctx.paths.config);
    const written = made.ok ? await writePrivateFile(configPath(ctx), `${JSON.stringify(checked.value, null, 2)}\n`) : { ok: false };
    if (!written.ok) return { ok: false, message: `Could not write ${configPath(ctx)}. Check that the directory is yours and writable.` };
  }
  // Any `configure set mode` is the person's own choice: the upgrade notice has been read.
  if (!input.dryRun && key === 'mode') await clearModeMigrationNotice({ home: ctx.home, env: ctx.env });
  // A dry run shows the file's new values; a written change shows the effective ones again.
  const now = input.dryRun ? { config: checked.value, modeSource: 'user' as const } : effectiveSettings(ctx);
  return {
    ok: true,
    payload: { ...base, source: 'file', path: configPath(ctx), valid: true, effective: effectiveView(now.config, egress, checked.value.privacy.sourceEgress, now.modeSource), changed, ...(input.dryRun ? { dryRun: true as const } : {}) },
  };
}

// ------------------------------------------------------------------------- evidence (reduced)

export function localEvidenceSelect(input: OpInputs['evidence.select']): EvidenceSelectPayload {
  return {
    intent: input.intent,
    items: [],
    missing: ['The evidence index lives in the sidecar, which is not answering.'],
    truncated: false,
  };
}

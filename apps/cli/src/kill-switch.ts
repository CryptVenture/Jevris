import { open, unlink, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { jevrisPaths, writePrivateFile } from '@jevris/platform';
import { MAX_REQUEST_BYTES } from '@jevris/contracts';
import { closeStore, effectDisposition, openStore, publishCurrent, type OpenStoreResult } from '@jevris/store';
import { rollbackPolicy } from './pack-policy.js';
import { readManagedKillSwitch, type ManagedKillSwitch, type ManagedOptions } from './enterprise-policy.js';

/**
 * Host kill-switch drill. The flag is a file under the home config directory.
 * A project file is not the previous policy and is not a clear. The fixture
 * is not a detector. rollbackPolicy is a restore step, not this drill.
 */

export interface KillSwitchFixture {
  readonly canary?: string;
  readonly source?: string;
}

export interface UnknownOwnedWork {
  readonly operationId: string;
  readonly decisionId: string;
}

export interface KillSwitchDrillInput {
  readonly home: string;
  readonly workspace: string;
  readonly ledgerPath: string;
  readonly workspaceId: string;
  readonly hostScope: string;
  readonly fixture?: KillSwitchFixture;
  readonly unknownOwned?: readonly UnknownOwnedWork[];
  readonly acknowledgedOperationIds?: readonly string[];
  readonly effect?: () => void;
}

export type KillSwitchDrillResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false };

export function killSwitchPath(home: string): string {
  return join(jevrisPaths({ home }).config, 'kill-switch.json');
}

export function drillRecordPath(home: string): string {
  return join(jevrisPaths({ home }).config, 'kill-switch-drill.json');
}

export function auditPath(home: string): string {
  return join(jevrisPaths({ home }).config, 'kill-switch-audit.txt');
}

/**
 * Every file the kill-switch commands write under the config folder: the flag, the drill
 * record, the activation log and the legacy drill audit text. `jevris data delete` removes
 * them through purgeKillSwitchData.
 */
export function killSwitchDataPaths(home: string): readonly string[] {
  return [killSwitchPath(home), drillRecordPath(home), killSwitchLogPath(home), auditPath(home)];
}

export type PurgeKillSwitchResult =
  | { readonly ok: true; readonly removed: readonly string[] }
  | { readonly ok: false; readonly reasonCode: 'KILL_SWITCH_ACTIVE' | 'PURGE_FAILED'; readonly message: string; readonly removed: readonly string[] };

/**
 * Removes the kill-switch files for a data delete. Refused while the switch is stopped (a
 * damaged flag counts as stopped): deleting data never lifts a stop. The user clears it first
 * with `jevris kill-switch clear`, which needs an interactive terminal.
 */
export async function purgeKillSwitchData(home: string): Promise<PurgeKillSwitchResult> {
  if (await readKillSwitchStopped(home)) {
    return {
      ok: false,
      reasonCode: 'KILL_SWITCH_ACTIVE',
      message: 'The kill switch is stopped, so its files were kept. Run `jevris kill-switch clear` in a terminal first, then delete the data again.',
      removed: [],
    };
  }
  const removed: string[] = [];
  for (const path of killSwitchDataPaths(home)) {
    try {
      await unlink(path);
      removed.push(path);
    } catch (error) {
      const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
      if (code === 'ENOENT') continue;
      return { ok: false, reasonCode: 'PURGE_FAILED', message: `A kill-switch file could not be removed (${typeof code === 'string' ? code : 'error'}).`, removed };
    }
  }
  return { ok: true, removed };
}

/**
 * The kill switch: the enterprise one (GOV-05, an administrator's managed file or policy
 * registry value, read on every call) or the user's own flag. Either stops Jevris; the user's
 * clear never lifts the enterprise one. `managed` lets the sidecar pass its cached Windows
 * registry reader (P8); the CLI reads directly.
 */
export async function readKillSwitchStopped(home: string, managed: ManagedOptions = {}): Promise<boolean> {
  if (readManagedKillSwitch(managed).stopped) return true;
  return readUserKillSwitchStopped(home);
}

/**
 * The user's flag fails closed (GOV-02): only a missing flag file reads as running. A flag
 * that is oversize, unreadable, not UTF-8, not JSON, not an object or without a boolean
 * `stopped` reads as stopped.
 */
export async function readUserKillSwitchStopped(home: string): Promise<boolean> {
  let capped: Uint8Array | 'missing' | 'over';
  try {
    capped = await readCapped(killSwitchPath(home));
  } catch {
    return true;
  }
  if (capped === 'missing') return false;
  if (capped === 'over') return true;
  const decoded = decodeUtf8(capped);
  if (decoded === undefined) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    return true;
  }
  if (!isPlain(parsed)) return true;
  const stopped = parsed['stopped'];
  return typeof stopped === 'boolean' ? stopped : true;
}

export async function runKillSwitchDrill(input: KillSwitchDrillInput): Promise<KillSwitchDrillResult> {
  if (!requiredStrings(input)) return { ok: false };
  if (input.effect !== undefined && typeof input.effect !== 'function') return { ok: false };
  // A fixture canary is not fetched and is not a skip. Its fields are not copied.
  if (input.fixture !== undefined && input.fixture.canary !== undefined && typeof input.fixture.canary !== 'string') {
    return { ok: false };
  }
  const flagged = await writePrivate(killSwitchPath(input.home), '{"stopped":true}\n');
  if (!flagged) return { ok: false };
  const restored = await rollbackPolicy({ home: input.home, workspace: input.workspace });
  if (!restored.ok) return { ok: false };
  const opened = openStore({
    path: input.ledgerPath,
    role: 'sidecar',
    workspaceId: input.workspaceId,
    hostScope: input.hostScope,
  });
  if (!opened.ok) return { ok: false };
  let held = false;
  try {
    held = reconcileHeld(opened, input);
  } catch {
    held = false;
  } finally {
    closeStore(opened);
  }
  if (!held) return { ok: false };
  const text = auditText();
  const audited = await writePrivate(auditPath(input.home), text);
  if (!audited) return { ok: false };
  const recorded = await writePrivate(drillRecordPath(input.home), '{"passed":true}\n');
  if (!recorded) return { ok: false };
  return { ok: true, text };
}

function requiredStrings(input: KillSwitchDrillInput): boolean {
  return (
    input.home.length > 0 &&
    input.workspace.length > 0 &&
    input.ledgerPath.length > 0 &&
    input.workspaceId.length > 0 &&
    input.hostScope.length > 0
  );
}

function reconcileHeld(opened: OpenStoreResult, input: KillSwitchDrillInput): boolean {
  const unknown = input.unknownOwned;
  if (unknown !== undefined) {
    for (const item of unknown) {
      const disposition = effectDisposition(opened, item.operationId);
      if (disposition === undefined) return false;
      if (disposition.effectStatus !== 'needs-reconciliation') return false;
      if (disposition.repeatable !== false) return false;
      if (disposition.outboxCount !== 1) return false;
      const published = publishCurrent(opened, item.decisionId);
      if (published.ok) return false;
    }
  }
  const acknowledged = input.acknowledgedOperationIds;
  if (acknowledged !== undefined) {
    for (const operationId of acknowledged) {
      const disposition = effectDisposition(opened, operationId);
      if (disposition === undefined) return false;
      if (disposition.effectStatus !== 'acknowledged') return false;
      if (disposition.repeatable !== false) return false;
      if (disposition.outboxCount !== 1) return false;
    }
  }
  return true;
}

function auditText(): string {
  return [
    'JEVRIS_KILL_SWITCH stopped',
    'restored policy-previous.json',
    'reconciled needs-reconciliation',
    'repeatable false',
    'owner platform-maintainer',
    'canary fixture not a detector',
    '',
  ].join('\n');
}

function isPlain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  const Ctor = (globalThis as unknown as {
    TextDecoder?: new (label: string, options: { fatal: boolean }) => { decode(input?: Uint8Array): string };
  }).TextDecoder;
  if (Ctor === undefined) return undefined;
  try {
    return new Ctor('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

async function readCapped(path: string): Promise<Uint8Array | 'over' | 'missing'> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, 'r');
    const buffer = new Uint8Array(MAX_REQUEST_BYTES + 1);
    const result = await handle.read(buffer, 0, buffer.length, 0);
    await handle.close();
    handle = undefined;
    if (result.bytesRead > MAX_REQUEST_BYTES) return 'over';
    return buffer.subarray(0, result.bytesRead);
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // The error text is not stored.
      }
    }
    // Only an absent file is "missing"; any other read failure is reported as oversize, so
    // the kill switch reads it as stopped (fail closed).
    const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
    return code === 'ENOENT' ? 'missing' : 'over';
  }
}

async function writePrivate(path: string, text: string): Promise<boolean> {
  // Exclusive 0600 temp (owner-only ACL on Windows), then an atomic replace (BLD-01, BLD-08).
  return (await writePrivateFile(path, text)).ok;
}

// ------------------------------------------------------------------ GOV-03, GOV-04

export type KillSwitchChannel = 'terminal' | 'cli';

export interface KillSwitchFlag {
  readonly stopped: boolean;
  readonly at: string | null;
  readonly channel: string | null;
  readonly actor: string | null;
  readonly reason: string | null;
}

export function killSwitchLogPath(home: string): string {
  return join(jevrisPaths({ home }).config, 'kill-switch-log.jsonl');
}

const SAFE_TEXT = /[^A-Za-z0-9 _.:/@+,=-]/g;

function safeText(value: string | undefined, max = 160): string | null {
  if (value === undefined) return null;
  const cleaned = value.replace(SAFE_TEXT, ' ').trim().slice(0, max);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * The flag with its recorded details; a flag that fails to read is stopped with no details.
 * `managed` is the enterprise kill switch (GOV-05); `stopped` covers both.
 */
export async function readKillSwitchFlag(home: string): Promise<KillSwitchFlag & { readonly state: 'absent' | 'readable' | 'unreadable'; readonly recorded?: 'set' | 'cleared'; readonly managed: ManagedKillSwitch }> {
  const managed = readManagedKillSwitch();
  const stopped = managed.stopped || (await readUserKillSwitchStopped(home));
  let capped: Uint8Array | 'missing' | 'over';
  try {
    capped = await readCapped(killSwitchPath(home));
  } catch {
    capped = 'over';
  }
  if (capped === 'missing') return { state: 'absent', stopped, at: null, channel: null, actor: null, reason: null, managed };
  const text = capped === 'over' ? undefined : decodeUtf8(capped);
  let parsed: unknown;
  try {
    parsed = text === undefined ? undefined : (JSON.parse(text) as unknown);
  } catch {
    parsed = undefined;
  }
  if (!isPlain(parsed)) return { state: 'unreadable', stopped, at: null, channel: null, actor: null, reason: null, managed };
  const str = (key: string): string | null => (typeof parsed[key] === 'string' ? safeText(parsed[key] as string) : null);
  // The record is the last activate (stopped true) or the audited clear (stopped false).
  const recorded = parsed['stopped'] === false ? 'cleared' : 'set';
  return { state: 'readable', stopped, recorded, at: str('at'), channel: str('channel'), actor: str('actor'), reason: str('reason'), managed };
}

async function appendLog(home: string, entry: Record<string, string | boolean | number | null>): Promise<boolean> {
  const path = killSwitchLogPath(home);
  let previous = '';
  const capped = await readCapped(path);
  if (capped !== 'missing' && capped !== 'over') previous = decodeUtf8(capped) ?? '';
  // Keep the log bounded: the newest lines win.
  const lines = `${previous}${JSON.stringify(entry)}\n`.split('\n').filter((line) => line.length > 0).slice(-500);
  return writePrivate(path, `${lines.join('\n')}\n`);
}

export interface KillSwitchStep {
  readonly step: string;
  readonly ok: boolean;
  readonly detail?: string;
}

/**
 * Activation (GOV-03): writes the flag first (it alone stops every hook, sidecar op and CLI
 * effect), then the local log. It never needs a rollback file and never writes a drill record.
 * `afterFlag` lets the caller hold pending effects and audit in the store; its steps are
 * reported as they happened, so a partial success says what did not complete.
 */
export async function activateKillSwitch(input: {
  readonly home: string;
  readonly actor: string;
  readonly channel: KillSwitchChannel;
  readonly reason?: string;
  readonly nowMs?: number;
  readonly afterFlag?: (context: { readonly policyRestored: string | null }) => Promise<readonly KillSwitchStep[]>;
}): Promise<{ readonly stopped: boolean; readonly steps: readonly KillSwitchStep[]; readonly policyRestored: string | null }> {
  const at = new Date(input.nowMs ?? Date.now()).toISOString();
  const flag = { stopped: true, at, channel: input.channel, actor: safeText(input.actor, 64), reason: safeText(input.reason) };
  const steps: KillSwitchStep[] = [];
  const flagged = await writePrivate(killSwitchPath(input.home), `${JSON.stringify(flag)}\n`);
  steps.push({ step: 'flag', ok: flagged });
  if (!flagged) return { stopped: await readKillSwitchStopped(input.home), steps, policyRestored: null };
  // US40: the previous compatible host policy is restored when one was staged; without one
  // there is nothing to restore and the step is still done (GOV-03 needs no rollback file).
  const policy = await restorePreviousPolicy(input.home);
  steps.push(policy.step);
  steps.push({ step: 'log', ok: await appendLog(input.home, { event: 'activate', ...flag, policyRestored: policy.id }) });
  if (input.afterFlag !== undefined) {
    try {
      steps.push(...(await input.afterFlag({ policyRestored: policy.id })));
    } catch {
      steps.push({ step: 'store', ok: false, detail: 'failed' });
    }
  }
  return { stopped: await readKillSwitchStopped(input.home), steps, policyRestored: policy.id };
}

/** Restores `policy-previous.json` as the active host policy when it is present and compatible. */
async function restorePreviousPolicy(home: string): Promise<{ readonly step: KillSwitchStep; readonly id: string | null }> {
  const previousPath = join(jevrisPaths({ home }).config, 'policy-previous.json');
  const previous = await readRaw(previousPath);
  if (previous === 'missing') return { step: { step: 'policy', ok: true, detail: 'no previous policy' }, id: null };
  if (previous === 'over') return { step: { step: 'policy', ok: false, detail: 'previous policy unreadable; active policy kept' }, id: null };
  const id = `sha256:${createHash('sha256').update(previous).digest('hex').slice(0, 16)}`;
  const restored = await rollbackPolicy({ home, workspace: home });
  return restored.ok
    ? { step: { step: 'policy', ok: true, detail: `restored previous policy ${id}` }, id }
    : { step: { step: 'policy', ok: false, detail: 'previous policy is not compatible with host.json; active policy kept' }, id: null };
}

/**
 * Clear (GOV-04): the caller has already checked for an interactive terminal. It clears the
 * user's flag only; while the enterprise kill switch is stopped Jevris stays stopped
 * (`managedStopped`), and only the administrator can lift it (GOV-05).
 */
export async function clearKillSwitch(input: { readonly home: string; readonly actor: string; readonly nowMs?: number }): Promise<{ readonly cleared: boolean; readonly managedStopped: boolean }> {
  const at = new Date(input.nowMs ?? Date.now()).toISOString();
  const flag = { stopped: false, at, channel: 'terminal', actor: safeText(input.actor, 64), reason: null };
  const written = await writePrivate(killSwitchPath(input.home), `${JSON.stringify(flag)}\n`);
  if (written) await appendLog(input.home, { event: 'clear', ...flag });
  const managedStopped = readManagedKillSwitch().stopped;
  return { cleared: written && !managedStopped && !(await readUserKillSwitchStopped(input.home)), managedStopped };
}

async function readRaw(path: string): Promise<Uint8Array | 'missing' | 'over'> {
  try {
    return await readCapped(path);
  } catch {
    return 'over';
  }
}

/**
 * The drill (GOV-04): runs its checks, restores the previous flag, and writes the drill record
 * only when every check passed. `probe` answers whether a running sidecar reports the switch
 * as stopped (null when no sidecar is running, which is recorded, not failed).
 */
export async function drillKillSwitch(input: {
  readonly home: string;
  readonly actor: string;
  readonly scratchHome: string;
  readonly probe?: () => Promise<boolean | null>;
  readonly nowMs?: number;
}): Promise<{ readonly passed: boolean; readonly checks: readonly KillSwitchStep[]; readonly recorded: boolean }> {
  const checks: KillSwitchStep[] = [];
  const flagPath = killSwitchPath(input.home);
  const previous = await readRaw(flagPath);
  const at = new Date(input.nowMs ?? Date.now()).toISOString();
  // 1. Activation writes the flag and the reader sees it stopped.
  const wrote = await writePrivate(flagPath, `${JSON.stringify({ stopped: true, at, channel: 'terminal', actor: safeText(input.actor, 64), reason: 'drill' })}\n`);
  checks.push({ step: 'activate', ok: wrote && (await readKillSwitchStopped(input.home)) });
  // 2. A running sidecar honours it on its next request.
  if (input.probe !== undefined) {
    let answer: boolean | null = null;
    try {
      answer = await input.probe();
    } catch {
      answer = false;
    }
    checks.push(answer === null ? { step: 'sidecar', ok: true, detail: 'not running' } : { step: 'sidecar', ok: answer });
  }
  // 3. A damaged flag fails closed (checked in a scratch home, never on the real flag).
  let failClosed = true;
  for (const bad of ['{not json', '[]', '{"stopped":"no"}']) {
    if (!(await writePrivate(killSwitchPath(input.scratchHome), bad))) failClosed = false;
    else if (!(await readUserKillSwitchStopped(input.scratchHome))) failClosed = false;
  }
  checks.push({ step: 'fail-closed', ok: failClosed });
  // 4. Restore the previous state exactly.
  let restored: boolean;
  if (previous === 'missing') restored = await writePrivate(flagPath, `${JSON.stringify({ stopped: false, at, channel: 'terminal', actor: safeText(input.actor, 64), reason: 'drill restored' })}\n`);
  else if (previous === 'over') restored = true;
  else restored = await writePrivate(flagPath, decodeUtf8(previous) ?? '{"stopped":true}\n');
  checks.push({ step: 'restore', ok: restored });
  const passed = checks.every((check) => check.ok);
  let recorded = false;
  if (passed) {
    recorded = await writePrivate(drillRecordPath(input.home), `${JSON.stringify({ passed: true, at, actor: safeText(input.actor, 64), checks: checks.map((c) => c.step) })}\n`);
    await appendLog(input.home, { event: 'drill', at, passed: true });
  } else {
    await appendLog(input.home, { event: 'drill', at, passed: false });
  }
  return { passed, checks, recorded };
}

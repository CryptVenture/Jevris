import type { HarnessId } from '@jevris/contracts';

/**
 * Live certification evidence and background re-checks (F's HCF work, owner 2026-09-26), wired
 * into the sidecar by B:
 * - every recorded hook delivery is one live event for its harness and version, feature
 *   `hooks.observe`: conforming when the normalized envelope has the shape every adapter
 *   produces, else malformed with a reason code (F's recordLiveEvent demotes the feature);
 * - at sidecar start and on each SessionStart, F's maybeReverify starts at most one background
 *   `jevris certify --reverify` for a version outside its record's range or after a demotion.
 *   It refuses in a test run and under a foreign HOME, and makes no model call.
 * Nothing here blocks an answer or throws: the calls run after the event is recorded, in the
 * background, and a failure only loses a hint. Only names, versions and counts are passed on,
 * never event content.
 */

export const LIVE_HARNESSES = ['claude', 'kilocode', 'codex', 'opencode', 'antigravity'] as const;
export type LiveHarness = (typeof LIVE_HARNESSES)[number];

export type EnvelopeShape = { readonly conforming: true } | { readonly conforming: false; readonly reasonCode: string };

const DEDUP_KEY = /^[0-9a-f]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,32})?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

export function liveHarnessOf(envelope: unknown): LiveHarness | undefined {
  if (!isRecord(envelope)) return undefined;
  const harness = envelope['harness'];
  return typeof harness === 'string' && (LIVE_HARNESSES as readonly string[]).includes(harness) ? (harness as LiveHarness) : undefined;
}

/** Whether a normalized envelope has the fields every adapter sets (contracts NormalizedHarnessEvent). */
export function envelopeShape(envelope: unknown): EnvelopeShape {
  if (!isRecord(envelope)) return { conforming: false, reasonCode: 'EVENT_NOT_OBJECT' };
  if (envelope['schemaVersion'] !== '1.0') return { conforming: false, reasonCode: 'EVENT_SCHEMA_VERSION' };
  if (typeof envelope['kind'] !== 'string' || envelope['kind'].length === 0) return { conforming: false, reasonCode: 'EVENT_KIND' };
  if (typeof envelope['nativeEventName'] !== 'string' || envelope['nativeEventName'].length === 0) return { conforming: false, reasonCode: 'EVENT_NATIVE_NAME' };
  if (typeof envelope['blocking'] !== 'boolean' || typeof envelope['responseRequired'] !== 'boolean') return { conforming: false, reasonCode: 'EVENT_FLAGS' };
  if (!isRecord(envelope['payload'])) return { conforming: false, reasonCode: 'EVENT_PAYLOAD' };
  for (const key of ['sessionId', 'turnId', 'toolUseId', 'toolName', 'agentId', 'model', 'permissionMode', 'cwd', 'trigger']) {
    if (!nullableString(envelope[key])) return { conforming: false, reasonCode: 'EVENT_FIELDS' };
  }
  // Only a subagent's event carries parentSessionId, and then as a string.
  if (envelope['parentSessionId'] !== undefined && typeof envelope['parentSessionId'] !== 'string') return { conforming: false, reasonCode: 'EVENT_FIELDS' };
  if (typeof envelope['dedupKey'] !== 'string' || !DEDUP_KEY.test(envelope['dedupKey'])) return { conforming: false, reasonCode: 'EVENT_DEDUP_KEY' };
  return { conforming: true };
}

export interface LiveCertificationPorts {
  /** F's recordLiveEvent (default: `@jevris/cli/live-evidence`). */
  readonly record?: (home: string, event: { readonly harness: LiveHarness; readonly version: string; readonly featureId: 'hooks.observe'; readonly conforming: boolean; readonly reasonCode?: string }) => Promise<unknown>;
  /** F's maybeReverify (default: `@jevris/cli/reverify`). */
  readonly reverify?: (options: { readonly home: string; readonly root: string; readonly installed: readonly LiveHarness[]; readonly versions: Partial<Record<LiveHarness, string>> }) => Promise<unknown>;
  /** The installed version the host ledger recorded (D's harnessVersionOf). */
  readonly versionOf?: (home: string, harness: HarnessId) => string | null;
  /** The installed package root (for `bin/jevris.mjs certify`); null in an unusual layout. */
  readonly root?: () => string | null;
}

async function defaultRecord(home: string, event: Parameters<NonNullable<LiveCertificationPorts['record']>>[1]): Promise<unknown> {
  const module = await import('@jevris/cli/live-evidence');
  return module.recordLiveEvent(home, event);
}

async function defaultReverify(options: Parameters<NonNullable<LiveCertificationPorts['reverify']>>[0]): Promise<unknown> {
  const module = await import('@jevris/cli/reverify');
  return module.maybeReverify(options);
}

async function defaultVersionOf(home: string, harness: HarnessId): Promise<string | null> {
  const { harnessVersionOf } = await import('@jevris/orchestrator');
  return harnessVersionOf(home, harness);
}

async function versionFor(ports: LiveCertificationPorts, home: string, harness: LiveHarness, supplied: unknown): Promise<string | null> {
  if (typeof supplied === 'string' && VERSION.test(supplied)) return supplied;
  try {
    const version = ports.versionOf !== undefined ? ports.versionOf(home, harness) : await defaultVersionOf(home, harness);
    return typeof version === 'string' && VERSION.test(version) ? version : null;
  } catch {
    return null;
  }
}

/** One recorded delivery as live evidence. Never throws; resolves false when nothing was recorded. */
export async function recordDelivery(home: string, envelope: unknown, suppliedVersion: unknown, ports: LiveCertificationPorts = {}): Promise<boolean> {
  try {
    const harness = liveHarnessOf(envelope);
    if (harness === undefined) return false;
    const version = await versionFor(ports, home, harness, suppliedVersion);
    if (version === null) return false;
    const shape = envelopeShape(envelope);
    const event = shape.conforming
      ? { harness, version, featureId: 'hooks.observe' as const, conforming: true }
      : { harness, version, featureId: 'hooks.observe' as const, conforming: false, reasonCode: shape.reasonCode };
    await (ports.record ?? defaultRecord)(home, event);
    return true;
  } catch {
    return false;
  }
}

/**
 * The background re-check for the given harnesses (every harness with a recorded version when
 * none is named). Never throws; resolves false when it did not ask.
 */
export async function reverifyHarnesses(home: string, harnesses: readonly LiveHarness[] | undefined, ports: LiveCertificationPorts = {}, supplied: Partial<Record<LiveHarness, unknown>> = {}): Promise<boolean> {
  try {
    const root = ports.root !== undefined ? ports.root() : null;
    if (root === null) return false;
    const versions: Partial<Record<LiveHarness, string>> = {};
    for (const harness of harnesses ?? LIVE_HARNESSES) {
      const version = await versionFor(ports, home, harness, supplied[harness]);
      if (version !== null) versions[harness] = version;
    }
    const installed = LIVE_HARNESSES.filter((harness) => versions[harness] !== undefined);
    if (installed.length === 0) return false;
    await (ports.reverify ?? defaultReverify)({ home, root, installed, versions });
    return true;
  } catch {
    return false;
  }
}

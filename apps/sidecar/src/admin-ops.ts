import { closeSync, constants, lstatSync, openSync, realpathSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SidecarOpContext, SidecarOpDefinition, SidecarOpOutcome } from '@jevris/contracts';
import { isAbsoluteOnAnyPlatform, isInsideOrSame, type JevrisPaths } from '@jevris/platform';
import type { OpenedStore } from '@jevris/store';
import { bodyRecord, ok, refuse } from './ops.js';
import { resolveRetention } from './retention-policy.js';
import { sweepFileRetention } from './file-retention.js';

/**
 * Administration ops (CLI key only: the `admin` scope). They act on the host store the sidecar
 * holds as its single writer, so a backup, export or purge never needs a second writer.
 *
 * Output paths are confined (GOV-11): absolute, inside the user's home directory, the parent
 * a real directory reached without a symlink, and the file new (created owner-only with
 * O_EXCL and O_NOFOLLOW).
 */

type StoreModule = typeof import('@jevris/store');

export interface AdminOpsDeps {
  readonly home: string;
  readonly paths: JevrisPaths;
  readonly store: () => { readonly store: OpenedStore; readonly api: StoreModule } | undefined;
}

export const ADMIN_OP_NAMES = ['store.backup', 'store.export', 'audit.export', 'audit.verify', 'audit.record', 'data.purge', 'learning.purge', 'kill-switch.activate', 'authorization.mint'] as const;

const ACTOR = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,63}$/;
const RECORDABLE = new Set(['kill-switch.clear', 'kill-switch.drill', 'data.delete', 'credential.set', 'credential.remove', 'policy.change', 'store.restore', 'store.migrate', 'egress.enable', 'egress.revoke']);

function stringField(ctx: SidecarOpContext, key: string): string | undefined {
  const value = bodyRecord(ctx)[key];
  return typeof value === 'string' ? value : undefined;
}

function actorOf(ctx: SidecarOpContext): string {
  const actor = stringField(ctx, 'actor');
  return actor !== undefined && ACTOR.test(actor) ? actor : 'cli';
}

/** Confines an output path (GOV-11); returns a refusal code or undefined when acceptable. */
export function outputPathRefusal(home: string, path: string | undefined): string | undefined {
  if (path === undefined || path.length === 0 || path.length > 4096 || !isAbsoluteOnAnyPlatform(path)) return 'PATH_NOT_ABSOLUTE';
  let realHome: string;
  let parent: string;
  try {
    realHome = realpathSync(home);
    parent = dirname(path);
    const st = lstatSync(parent);
    if (!st.isDirectory()) return 'PATH_PARENT_NOT_DIRECTORY';
    // The parent must be reached without a symlink: its real path is the path given.
    if (realpathSync(parent) !== parent) return 'PATH_SYMLINK';
  } catch {
    return 'PATH_PARENT_MISSING';
  }
  if (!isInsideOrSame(realHome, parent)) return 'PATH_OUTSIDE_HOME';
  if (lstatSync(path, { throwIfNoEntry: false }) !== undefined) return 'PATH_EXISTS';
  return undefined;
}

function writeNewPrivate(path: string, text: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  } catch {
    return false;
  }
  try {
    writeSync(fd, text);
    return true;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

function refusal(result: { readonly reason: string }): SidecarOpOutcome {
  return refuse(`STORE_${result.reason.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`.slice(0, 64));
}

export function adminOps(deps: AdminOpsDeps): SidecarOpDefinition[] {
  const withStore = (fn: (store: OpenedStore, api: StoreModule, ctx: SidecarOpContext) => SidecarOpOutcome | Promise<SidecarOpOutcome>) => (ctx: SidecarOpContext) => {
    const held = deps.store();
    if (held === undefined) return refuse('STORE_UNAVAILABLE', 'The Jevris store is not open; run `jevris sidecar status` for the reason.');
    return fn(held.store, held.api, ctx);
  };
  const outputOp = (op: string, run: (store: OpenedStore, api: StoreModule, path: string, ctx: SidecarOpContext) => SidecarOpOutcome | Promise<SidecarOpOutcome>): SidecarOpDefinition => ({
    op,
    scope: 'admin',
    budget: 'background',
    workspace: 'optional',
    handle: withStore((store, api, ctx) => {
      const path = stringField(ctx, 'path');
      const refused = outputPathRefusal(deps.home, path);
      if (refused !== undefined || path === undefined) return refuse(refused ?? 'PATH_NOT_ABSOLUTE');
      return run(store, api, path, ctx);
    }),
  });
  return [
    outputOp('store.backup', async (store, api, path, ctx) => {
      const result = await api.backupStore(store, path, { nowMs: Date.now(), actor: actorOf(ctx) });
      return result.ok ? ok({ path: result.path }) : refusal(result);
    }),
    outputOp('store.export', (store, api, path) => {
      const result = api.exportStoreJsonl(store, path);
      return result.ok ? ok({ path, rows: result.rows, tables: result.tables }) : refusal(result);
    }),
    outputOp('audit.export', (store, api, path) => {
      const text = api.exportAuditJsonl(store);
      if (!writeNewPrivate(path, text)) return refuse('PATH_REFUSED');
      const rows = text.length === 0 ? 0 : text.trimEnd().split('\n').length;
      return ok({ path, rows });
    }),
    {
      op: 'audit.verify',
      scope: 'admin',
      budget: 'background',
      workspace: 'optional',
      handle: withStore((store, api) => {
        const result = api.verifyAuditChain(store);
        if ('brokenAt' in result) return ok({ intact: false, brokenAt: result.brokenAt });
        if (!result.ok) return refusal(result);
        return ok({ intact: true, count: result.count, head: result.head });
      }),
    },
    {
      op: 'audit.record',
      scope: 'admin',
      budget: 'hot',
      workspace: 'optional',
      handle: withStore((store, api, ctx) => {
        const kind = stringField(ctx, 'kind');
        if (kind === undefined || !RECORDABLE.has(kind)) return refuse('INVALID_REQUEST');
        const channel = stringField(ctx, 'channel') === 'terminal' ? 'terminal' : 'cli';
        const rawDetail = bodyRecord(ctx)['detail'];
        const detail = rawDetail !== null && typeof rawDetail === 'object' && !Array.isArray(rawDetail) ? (rawDetail as { readonly [key: string]: string | number | boolean | null }) : {};
        const result = api.appendAudit(store, { kind: kind as 'kill-switch.clear', actor: actorOf(ctx), channel, atMs: Date.now(), detail });
        return result.ok ? ok({ seq: result.seq }) : refusal(result);
      }),
    },
    {
      // Learning records (decision outcomes, model changes, advice adherence, latency counters):
      // `jevris data delete --scope learning` and `jevris route learning reset --clear-evidence`.
      op: 'learning.purge',
      scope: 'admin',
      budget: 'background',
      workspace: 'optional',
      handle: withStore((store, api, ctx) => {
        const workspaceId = stringField(ctx, 'workspaceId');
        if (workspaceId !== undefined && !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(workspaceId)) return refuse('INVALID_REQUEST');
        const result = api.deleteLearningRecords(store, workspaceId === undefined ? {} : { workspaceId });
        if (!result.ok) return refusal(result);
        const removed = Object.values(result.removed).reduce((a, b) => a + b, 0);
        const audited = api.appendAudit(store, { kind: 'data.delete', actor: actorOf(ctx), channel: 'cli', atMs: Date.now(), detail: { scope: 'learning', removed, ...(workspaceId !== undefined ? { workspace: workspaceId } : {}) } });
        if (!audited.ok) return refusal(audited);
        return ok({ removed: result.removed });
      }),
    },
    {
      op: 'data.purge',
      scope: 'admin',
      budget: 'background',
      workspace: 'optional',
      handle: withStore(async (store, api, ctx) => {
        const dryRun = bodyRecord(ctx)['dryRun'] === true;
        const resolved = resolveRetention({ home: deps.home });
        const nowMs = Date.now();
        const result = api.sweepRetention(store, { policy: resolved.policy, nowMs, rawDir: join(deps.paths.data, 'evidence'), dryRun, actor: actorOf(ctx), channel: 'cli' });
        if (!result.ok) return refusal(result);
        // DATA-11: the orchestration ledger's history and worker runs, live evidence, and calibration cases.
        const files = await sweepFileRetention({ home: deps.home, dataDir: deps.paths.data, policy: resolved.policy, nowMs, dryRun });
        return ok({ dryRun: result.dryRun, policy: resolved.policy, removed: result.removed, rawFiles: result.rawFiles, orchestration: files.orchestration, liveEvidence: files.liveEvidence, calibrationCases: files.calibrationCases, keptPinned: result.keptPinned, vacuumed: result.vacuumed, issues: resolved.issues });
      }),
    },
    {
      op: 'kill-switch.activate',
      scope: 'admin',
      budget: 'hot',
      workspace: 'optional',
      handle: withStore((store, api, ctx) => {
        const reason = stringField(ctx, 'reason');
        const channel = stringField(ctx, 'channel') === 'terminal' ? 'terminal' : 'cli';
        const policyRestored = stringField(ctx, 'policyRestored');
        const result = api.holdPendingEffects(store, { nowMs: Date.now(), actor: actorOf(ctx), channel, ...(reason !== undefined ? { reason } : {}), ...(policyRestored !== undefined && /^sha256:[a-f0-9]{16}$/.test(policyRestored) ? { policyRestored } : {}) });
        return result.ok ? ok({ held: result.held, auditSeq: result.auditSeq }) : refusal(result);
      }),
    },
    {
      op: 'authorization.mint',
      scope: 'admin',
      budget: 'hot',
      workspace: 'optional',
      handle: withStore((store, api, ctx) => {
        // The CLI mints only from an interactive terminal and says so; the sidecar accepts the
        // request only on the CLI key and records the terminal channel (GOV-09).
        if (stringField(ctx, 'channel') !== 'terminal') return refuse('CHANNEL_REFUSED');
        const body = bodyRecord(ctx);
        const actionClass = stringField(ctx, 'actionClass');
        const scope = stringField(ctx, 'scope');
        const ttlMs = body['ttlMs'];
        if (actionClass === undefined || scope === undefined || typeof ttlMs !== 'number') return refuse('INVALID_REQUEST');
        const result = api.mintAuthorization(store, { principal: actorOf(ctx), actionClass: actionClass as 'data.delete', scope, ttlMs, nowMs: Date.now(), channel: 'terminal' });
        return result.ok ? ok({ authorizationId: result.authorizationId, expiresAtMs: result.expiresAtMs }) : refusal(result);
      }),
    },
  ];
}

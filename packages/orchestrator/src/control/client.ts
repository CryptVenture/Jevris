/**
 * The control service client (ORC-12): `remoteLeaseAuthority` is the scheduler's
 * `LeaseAuthority` over the multi-host service, so workers, budgets and the reconciler do not
 * change between one host and many.
 *
 * - The service decides; this host follows. A grant moves the local task to `leased`; if the
 *   local task changed meanwhile, the lease is released at once with no spend. An expired lease
 *   the service reports moves the local task to `blocked` for reconciliation.
 * - Fenced publication asks the service whether the token is still current and active, then
 *   runs the local write in the host ledger's transaction.
 * - Failure is closed: when the service cannot be reached nothing is granted, a heartbeat or a
 *   fenced write is refused, and a sweep changes nothing.
 * - The bearer token comes from an owner-only file named in `<config>/control.json`, is read
 *   when first needed, travels only in the Authorization header, and is never logged or
 *   passed on a command line.
 */
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertOwnerOnly, isAbsoluteOnAnyPlatform } from '@jevris/platform';
import type { RecordLedger } from '../ledger.js';
import type { AcquireResult, BudgetRecord, FenceResult, LeaseAuthority, LeaseGrant, LeaseRecord, LeaseRefusalCode, ReservationRecord } from '../orchestration/leases.js';
import { hostIdentity, isThisHost, livenessOf } from '../orchestration/liveness.js';
import { listTasks, type LeaseTaskPort } from '../orchestration/tasks.js';
import type { WorkspaceServices } from '../workspace.js';
import { isPlain, own, recordKey, type Rec } from '../util.js';
import { CONTROL_SCHEMA, MAX_RESPONSE_BYTES, MIN_TOKEN_CHARS, concatBytes, isLoopbackHost, type ControlOp } from './protocol.js';

export const CONTROL_CLIENT_SCHEMA = 'jevris-control-client-1';
export const CONTROL_SETTINGS_FILE = 'control.json';

export type ControlCallResult =
  | { readonly ok: true; readonly result: Rec }
  | { readonly ok: false; readonly reason: 'unavailable' | 'unauthorized' | 'refused' | 'token'; readonly status?: number | undefined; readonly code?: string };

export interface ControlClient {
  readonly url: string;
  call(op: ControlOp, body: Rec): Promise<ControlCallResult>;
}

export interface ControlClientOptions {
  readonly url: string;
  readonly token: () => string | Promise<string>;
  readonly ca?: string | Uint8Array;
  readonly allowPlaintext?: boolean;
  readonly timeoutMs?: number;
}

export function controlClient(options: ControlClientOptions): ControlClient {
  const base = new URL(options.url);
  if (base.username !== '' || base.password !== '') throw new Error('control: the service URL must not carry credentials');
  if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new Error('control: the service URL must be http(s)');
  if (base.protocol === 'http:' && !isLoopbackHost(base.hostname) && options.allowPlaintext !== true) {
    throw new Error('control: a non-loopback service needs https (bearer tokens never travel in plain text)');
  }
  const prefix = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    url: `${base.protocol}//${base.host}${prefix}`,
    async call(op, body) {
      let token: string;
      try {
        token = await options.token();
      } catch {
        return { ok: false, reason: 'token' };
      }
      const bytes = new TextEncoder().encode(JSON.stringify(body));
      return new Promise<ControlCallResult>((resolve) => {
        const send = base.protocol === 'https:' ? httpsRequest : httpRequest;
        const req = send(
          {
            protocol: base.protocol,
            hostname: base.hostname.replace(/^\[|\]$/g, ''),
            ...(base.port === '' ? {} : { port: Number(base.port) }),
            path: `${prefix}v1/${op}`,
            method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': bytes.length, authorization: `Bearer ${token}` },
            ...(options.ca === undefined ? {} : { ca: options.ca }),
            timeout: timeoutMs,
          },
          (res: IncomingMessage) => {
            const chunks: Uint8Array[] = [];
            let size = 0;
            res.on('data', (c: Uint8Array) => {
              size += c.length;
              if (size > MAX_RESPONSE_BYTES) {
                req.destroy();
                resolve({ ok: false, reason: 'unavailable' });
              } else chunks.push(c);
            });
            res.on('end', () => {
              let parsed: unknown;
              try {
                parsed = JSON.parse(new TextDecoder().decode(concatBytes(chunks)));
              } catch {
                return resolve({ ok: false, reason: 'unavailable', status: res.statusCode });
              }
              if (!isPlain(parsed) || own(parsed, 'schemaVersion') !== CONTROL_SCHEMA) return resolve({ ok: false, reason: 'unavailable', status: res.statusCode });
              if (res.statusCode === 401) return resolve({ ok: false, reason: 'unauthorized', status: 401 });
              const result = own(parsed, 'result');
              if (res.statusCode !== 200 || !isPlain(result)) {
                const code = own(parsed, 'error');
                return resolve({ ok: false, reason: 'refused', status: res.statusCode, ...(typeof code === 'string' ? { code } : {}) });
              }
              resolve({ ok: true, result });
            });
            res.on('error', () => resolve({ ok: false, reason: 'unavailable' }));
          },
        );
        req.on('timeout', () => req.destroy());
        req.on('error', () => resolve({ ok: false, reason: 'unavailable' }));
        req.end(bytes);
      });
    },
  };
}

export interface RemoteAuthorityOptions {
  readonly client: ControlClient;
  /** This host's ledger: budgets are read from it and fenced writes run in its transaction. */
  readonly ledger: RecordLedger;
  readonly tasksFor: (workspaceId: string) => LeaseTaskPort | undefined;
  readonly hostId?: string;
}

const FENCE_CODES = new Set(['STALE_TOKEN', 'LEASE_NOT_ACTIVE', 'UNKNOWN_LEASE']);

function leasesOf(value: unknown): readonly LeaseRecord[] {
  return Array.isArray(value) ? (value.filter((l) => isPlain(l) && isPlain(own(l, 'lease'))) as LeaseRecord[]) : [];
}

export function remoteLeaseAuthority(options: RemoteAuthorityOptions): LeaseAuthority {
  const { client, ledger } = options;
  const hostId = options.hostId ?? hostIdentity();
  /** Active leases per workspace as the service last reported them (`activeLeases` is synchronous). */
  const cache = new Map<string, readonly LeaseRecord[]>();
  const remember = (workspaceId: string, result: Rec): void => {
    if (Array.isArray(own(result, 'active'))) cache.set(workspaceId, leasesOf(own(result, 'active')));
  };

  return {
    async acquire(workspaceId, requests, { cap, nowMs }): Promise<AcquireResult> {
      const port = options.tasksFor(workspaceId);
      const refused: { taskId: string; reasonCode: LeaseRefusalCode }[] = [];
      const wire: Rec[] = [];
      const budgetIds = new Set<string>();
      for (const req of requests) {
        const task = port?.get(req.taskId);
        if (task === undefined) {
          refused.push({ taskId: req.taskId, reasonCode: 'UNKNOWN_TASK' });
          continue;
        }
        budgetIds.add(task.node.rootBudgetId);
        wire.push({ ...req, task: { state: task.node.state, rootBudgetId: task.node.rootBudgetId, resourceKeys: task.resourceKeys } });
      }
      if (wire.length === 0) return { granted: [], refused };
      const budgets = [...budgetIds].map((id) => ledger.get<BudgetRecord>('budgets', id)).filter((b): b is BudgetRecord => b !== undefined && b.workspaceId === workspaceId);
      const answer = await client.call('acquire', { workspaceId, cap, requests: wire, budgets });
      if (!answer.ok) return { granted: [], refused: [...refused, ...wire.map((r) => ({ taskId: r['taskId'] as string, reasonCode: 'CONTROL_UNAVAILABLE' as const }))] };
      remember(workspaceId, answer.result);
      const granted: LeaseGrant[] = [];
      for (const g of Array.isArray(own(answer.result, 'granted')) ? (own(answer.result, 'granted') as LeaseGrant[]) : []) {
        // The local task moves only after the service granted; a refused move gives the lease back unspent.
        if (port !== undefined && port.leased(g.lease.taskId, g.lease.id, nowMs)) granted.push(g);
        else {
          await client.call('release', { workspaceId, leaseId: g.lease.id, fencingToken: g.lease.fencingToken, actualMicroUsd: 0, reason: 'local task changed' });
          refused.push({ taskId: g.lease.taskId, reasonCode: 'NOT_READY' });
        }
      }
      for (const r of Array.isArray(own(answer.result, 'refused')) ? (own(answer.result, 'refused') as { taskId: string; reasonCode: LeaseRefusalCode }[]) : []) refused.push(r);
      return { granted, refused };
    },

    async heartbeat(workspaceId, leaseId, fencingToken) {
      const answer = await client.call('heartbeat', { workspaceId, leaseId, fencingToken });
      if (!answer.ok) return { ok: false, reasonCode: 'CONTROL_UNAVAILABLE' };
      const expiresAt = own(answer.result, 'expiresAt');
      const reasonCode = own(answer.result, 'reasonCode');
      return {
        ok: own(answer.result, 'ok') === true,
        ...(typeof expiresAt === 'string' ? { expiresAt } : {}),
        ...(typeof reasonCode === 'string' ? { reasonCode } : {}),
      };
    },

    async release(workspaceId, leaseId, fencingToken, spend, _nowMs, reason = 'released') {
      const answer = await client.call('release', { workspaceId, leaseId, fencingToken, actualMicroUsd: spend.actualMicroUsd === null ? null : Math.max(0, Math.trunc(spend.actualMicroUsd)), reason });
      if (!answer.ok) return { ok: false, reasonCode: 'CONTROL_UNAVAILABLE' };
      remember(workspaceId, answer.result);
      const reasonCode = own(answer.result, 'reasonCode');
      return { ok: own(answer.result, 'ok') === true, ...(typeof reasonCode === 'string' ? { reasonCode } : {}) };
    },

    async sweep(workspaceId, nowMs, liveness = (h) => livenessOf(h)) {
      const listed = await client.call('leases', { workspaceId });
      if (!listed.ok) return [];
      // Only this host can judge its own processes; the service expires the rest by heartbeat TTL.
      // A holder stamped with this machine's earlier host-name id is still this host's (DATA-10):
      // its dead holders are reported under the id they were recorded with.
      const mine = (id: string): boolean => (options.hostId !== undefined ? id === options.hostId : isThisHost(id));
      const deadBy = new Map<string, { pid: number; startedAtMs: number | null }[]>([[hostId, []]]);
      for (const l of leasesOf(own(listed.result, 'active'))) {
        if (!mine(l.holder.hostId) || liveness(l.holder) !== 'dead') continue;
        const list = deadBy.get(l.holder.hostId) ?? [];
        list.push({ pid: l.holder.pid, startedAtMs: l.holder.startedAtMs });
        deadBy.set(l.holder.hostId, list);
      }
      const port = options.tasksFor(workspaceId);
      const ids: string[] = [];
      let answered = false;
      for (const [id, dead] of deadBy) {
        if (id !== hostId && dead.length === 0) continue;
        const answer = await client.call('sweep', { workspaceId, hostId: id, deadHolders: dead });
        if (!answer.ok) continue;
        answered = true;
        remember(workspaceId, answer.result);
        for (const e of Array.isArray(own(answer.result, 'expired')) ? (own(answer.result, 'expired') as { leaseId: string; taskId: string | null }[]) : []) {
          if (ids.includes(e.leaseId)) continue;
          if (e.taskId !== null) port?.expired(e.taskId, e.leaseId, nowMs);
          ids.push(e.leaseId);
        }
      }
      if (!answered) return [];
      // Orphans: a local task that records a lease the service does not hold as active.
      if (port !== undefined) {
        const active = new Set((cache.get(workspaceId) ?? []).map((l) => l.lease.id));
        for (const held of port.holding()) if (!active.has(held.leaseId)) port.expired(held.taskId, held.leaseId, nowMs);
      }
      return ids;
    },

    async reconcile(workspaceId, taskId, decision, nowMs) {
      const port = options.tasksFor(workspaceId);
      const task = port?.get(taskId);
      if (port === undefined || task === undefined) return { ok: false, reasonCode: 'UNKNOWN_TASK' };
      if (task.node.state !== 'blocked') return { ok: false, reasonCode: 'NOT_BLOCKED' };
      const answer = await client.call('reconcile', { workspaceId, taskId, spentMicroUsd: decision.spentMicroUsd, resume: decision.resume });
      if (!answer.ok) return { ok: false, reasonCode: 'CONTROL_UNAVAILABLE' };
      remember(workspaceId, answer.result);
      const code = own(answer.result, 'reasonCode');
      // The service has nothing to settle when it never saw the lease expire (a local orphan).
      if (own(answer.result, 'ok') !== true && code !== 'NOT_BLOCKED' && code !== 'UNKNOWN_TASK') return { ok: false, reasonCode: typeof code === 'string' ? code : 'CONTROL_REFUSED' };
      const moved = port.reconciled(taskId, decision.resume, nowMs);
      return moved.ok ? { ok: true } : { ok: false, reasonCode: moved.reasonCode };
    },

    async publishFenced<R>(workspaceId: string, taskId: string, fencingToken: number, fn: Parameters<LeaseAuthority['publishFenced']>[3], _nowMs: number): Promise<FenceResult<R>> {
      const answer = await client.call('fence', { workspaceId, taskId, fencingToken });
      if (!answer.ok) return { ok: false, reasonCode: 'LEASE_NOT_ACTIVE' };
      if (own(answer.result, 'ok') !== true) {
        const code = own(answer.result, 'reasonCode');
        return { ok: false, reasonCode: typeof code === 'string' && FENCE_CODES.has(code) ? (code as 'STALE_TOKEN') : 'LEASE_NOT_ACTIVE' };
      }
      return { ok: true, value: (await ledger.transact(fn)) as R };
    },

    activeLeases(workspaceId) {
      if (workspaceId !== null) return cache.get(workspaceId) ?? [];
      return [...cache.values()].flat();
    },
  };
}

// ------------------------------------------------------------------ host settings

export interface ControlSettings {
  readonly url: string;
  readonly tokenFile: string;
  readonly caFile?: string;
}

export type ControlSettingsResult = { readonly configured: false } | { readonly configured: true; readonly settings: ControlSettings } | { readonly configured: true; readonly problem: string };

/** Reads `<config>/control.json`: `{ schemaVersion, url, tokenFile, caFile? }`. Never the token itself. */
export function readControlSettings(configDir: string): ControlSettingsResult {
  let text: string;
  try {
    text = readFileSync(join(configDir, CONTROL_SETTINGS_FILE), 'utf8');
  } catch {
    return { configured: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { configured: true, problem: 'control.json is not JSON' };
  }
  if (!isPlain(parsed) || own(parsed, 'schemaVersion') !== CONTROL_CLIENT_SCHEMA) return { configured: true, problem: `control.json needs schemaVersion ${CONTROL_CLIENT_SCHEMA}` };
  const url = own(parsed, 'url');
  const tokenFile = own(parsed, 'tokenFile');
  const caFile = own(parsed, 'caFile');
  if (typeof url !== 'string' || url.length > 2048) return { configured: true, problem: 'control.json needs a url' };
  if (typeof tokenFile !== 'string' || !isAbsoluteOnAnyPlatform(tokenFile)) return { configured: true, problem: 'control.json needs an absolute tokenFile' };
  if (caFile !== undefined && (typeof caFile !== 'string' || !isAbsoluteOnAnyPlatform(caFile))) return { configured: true, problem: 'control.json caFile must be an absolute path' };
  return { configured: true, settings: { url, tokenFile, ...(caFile === undefined ? {} : { caFile: caFile as string }) } };
}

/** Reads the bearer token from an owner-only file; a group- or world-readable file is refused. */
export async function readTokenFile(path: string): Promise<string> {
  const check = await assertOwnerOnly(path);
  if (!check.ok) throw new Error(`control: the token file is not owner-only (${check.reason})`);
  const token = readFileSync(path, 'utf8').trim();
  if (token.length < MIN_TOKEN_CHARS || !/^[\x21-\x7e]+$/.test(token)) throw new Error('control: the token file does not hold a usable token');
  return token;
}

const authorities = new Map<string, { readonly key: string; readonly authority: LeaseAuthority }>();

/**
 * The remote authority for a workspace when this host is configured for a control service,
 * undefined when it is not, and an error string when the settings are unusable (the caller
 * refuses to lease rather than silently falling back to a host-local authority).
 */
export function configuredRemoteAuthority(ws: WorkspaceServices, tasksFor: (workspaceId: string) => LeaseTaskPort | undefined): LeaseAuthority | string | undefined {
  const read = readControlSettings(ws.configDir);
  if (!read.configured) return undefined;
  if ('problem' in read) return read.problem;
  const { settings } = read;
  const key = JSON.stringify([settings.url, settings.tokenFile, settings.caFile ?? null, ws.workspaceId, ws.host.root]);
  const cached = authorities.get(ws.workspaceId);
  if (cached !== undefined && cached.key === key) return cached.authority;
  let client: ControlClient;
  try {
    let token: Promise<string> | undefined;
    client = controlClient({
      url: settings.url,
      token: () => (token ??= readTokenFile(settings.tokenFile).catch((error: unknown) => {
        token = undefined;
        throw error;
      })),
      ...(settings.caFile === undefined ? {} : { ca: readFileSync(settings.caFile) }),
    });
  } catch (error) {
    return error instanceof Error ? error.message : 'control: unusable settings';
  }
  const authority = remoteLeaseAuthority({ client, ledger: ws.host, tasksFor });
  authorities.set(ws.workspaceId, { key, authority });
  return authority;
}

// ------------------------------------------------------------------ migration

export const CONTROL_MIGRATIONS = 'control-migrations';

export interface ControlMigration {
  readonly workspaceId: string;
  readonly url: string;
  readonly atMs: number;
}

/**
 * Moves a workspace's single-host lease state (budgets, reservations, fences and active leases)
 * to the control service, once. On success the host ledger records the move, and from then on
 * the host-local authority refuses new leases for the workspace (`CONTROL_SERVICE_REQUIRED`),
 * so two authorities never lease the same tasks.
 */
export async function migrateToControlService(
  ws: WorkspaceServices,
  client: ControlClient,
  nowMs = Date.now(),
): Promise<{ readonly ok: true; readonly imported: Rec } | { readonly ok: false; readonly reasonCode: string }> {
  const workspaceId = ws.workspaceId;
  if (ws.host.get<ControlMigration>(CONTROL_MIGRATIONS, workspaceId) !== undefined) return { ok: false, reasonCode: 'ALREADY_MIGRATED' };
  const budgets = ws.host.list<BudgetRecord>('budgets').filter((b) => b.workspaceId === workspaceId);
  const leases = ws.host.list<LeaseRecord>('leases').filter((l) => l.lease.workspaceId === workspaceId && l.state === 'active');
  const reservations = ws.host.list<ReservationRecord>('reservations').filter((r) => r.workspaceId === workspaceId);
  const fences = listTasks(ws)
    .map((t) => ({ taskId: t.node.id, token: ws.host.get<number>('fences', recordKey(workspaceId, t.node.id)) }))
    .filter((f): f is { taskId: string; token: number } => typeof f.token === 'number');
  const answer = await client.call('import', { workspaceId, budgets, leases, reservations, fences });
  if (!answer.ok) return { ok: false, reasonCode: answer.reason === 'unauthorized' ? 'CONTROL_UNAUTHORIZED' : 'CONTROL_UNAVAILABLE' };
  if (own(answer.result, 'ok') !== true) {
    const code = own(answer.result, 'reasonCode');
    return { ok: false, reasonCode: typeof code === 'string' ? code : 'CONTROL_REFUSED' };
  }
  await ws.host.transact((tx) => tx.put(CONTROL_MIGRATIONS, workspaceId, { workspaceId, url: client.url, atMs: nowMs } satisfies ControlMigration));
  const imported = own(answer.result, 'imported');
  return { ok: true, imported: isPlain(imported) ? imported : {} };
}

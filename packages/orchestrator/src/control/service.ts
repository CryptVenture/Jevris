/**
 * The multi-host control service (ORC-12, SSOT §10.2, §17.1, E31).
 *
 * One transactional lease authority for several hosts. Hosts never share the SQLite store or a
 * ledger directory over a network drive: each host keeps its own store and asks this service
 * for leases, reservations and fencing tokens over HTTP(S).
 *
 * - Tenants: each bearer token maps to one tenant (the service keeps only sha256 digests and
 *   compares them in constant time). Each tenant has its own ledger directory under `root`, so
 *   tenant isolation does not depend on filtering rows.
 * - Semantics: the service runs the same `ledgerLeaseAuthority` as a single host, over a task
 *   mirror (state, budget, resource keys and lease id per task) kept in the tenant ledger and
 *   changed in the same transaction as the lease. A host sends its task's snapshot with each
 *   acquire; the snapshot is used only while no active lease holds the task, so a second host
 *   cannot take a task another host holds. Global cap, resource keys, budgets and fences are
 *   therefore enforced across hosts.
 * - Time: the service clock decides expiry. Liveness: the service cannot see another host's
 *   processes, so a sweep expires leases by heartbeat TTL, plus holders the calling host says
 *   are dead on that same host.
 * - Transport: plain HTTP only on a loopback address unless `allowPlaintext` is set for an
 *   isolated network (test containers); otherwise TLS. Request bodies are capped at 1 MiB and
 *   error answers carry a code, never internal detail or the token.
 */
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { AgentLeaseContract, BudgetReservationContract, type TaskState } from '@jevris/contracts';
import { openLedger, type LedgerTx, type RecordLedger } from '../ledger.js';
import { ledgerLeaseAuthority, type BudgetRecord, type LeaseAuthority, type LeaseRecord, type LeaseRequest, type ReservationRecord } from '../orchestration/leases.js';
import type { LeaseTaskPort, LeaseTaskView } from '../orchestration/tasks.js';
import type { Liveness, ProcessIdentity } from '../orchestration/liveness.js';
import { isPlain, own, recordKey, type Rec } from '../util.js';
import {
  CONTROL_OPS,
  CONTROL_SCHEMA,
  MAX_REQUEST_BYTES,
  ProtocolError,
  TENANT_PATTERN,
  budgetOf,
  concatBytes,
  hexBytes,
  budgetRevision,
  holderOf,
  intOrNull,
  isLoopbackHost,
  optInt,
  reqArray,
  reqInt,
  reqRecord,
  reqString,
  snapshotOf,
  tokenDigest,
  workspaceOf,
  type ControlOp,
  type TaskSnapshot,
} from './protocol.js';

export interface ControlTenant {
  readonly id: string;
  /** sha256 hex of the tenant's bearer token (see `tokenDigest`). */
  readonly tokenSha256: string;
}

export interface ControlServiceOptions {
  /** The service's data directory: one ledger per tenant under `<root>/tenants/<id>`. */
  readonly root: string;
  readonly tenants: readonly ControlTenant[];
  readonly host?: string;
  readonly port?: number;
  readonly tls?: { readonly key: string | Uint8Array; readonly cert: string | Uint8Array };
  /** Plain HTTP on a non-loopback address; only for an isolated network such as test containers. */
  readonly allowPlaintext?: boolean;
  /** The most leases one tenant may hold at once across all hosts (default 64). */
  readonly maxCap?: number;
  readonly clock?: () => number;
}

export interface ControlService {
  readonly url: string;
  close(): Promise<void>;
}

interface MirrorRow {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly state: TaskState;
  readonly rootBudgetId: string;
  readonly resourceKeys: readonly string[];
  readonly leaseId: string | null;
}

const MIRROR = 'task-mirror';
const DIGEST = /^[0-9a-f]{64}$/;

function activeFor(tx: LedgerTx, workspaceId: string, taskId: string): LeaseRecord | undefined {
  return tx.list<LeaseRecord>('leases').find((l) => l.state === 'active' && l.lease.workspaceId === workspaceId && l.lease.taskId === taskId);
}

/** The task port the service's lease authority reads: the tenant's task mirror, in the lease transaction. */
function mirrorPort(workspaceId: string, tx: LedgerTx, snapshots: ReadonlyMap<string, TaskSnapshot>): LeaseTaskPort {
  const key = (taskId: string) => recordKey(workspaceId, taskId);
  // Budget ids are chosen by people, so two workspaces of a tenant may pick the same one: a task
  // never reserves against another workspace's budget (the sentinel id can never exist).
  const budgetFor = (id: string): string => {
    const b = tx.get<BudgetRecord>('budgets', id);
    return b !== undefined && b.workspaceId !== workspaceId ? '#foreign-budget' : id;
  };
  const view = (s: { readonly state: TaskState; readonly rootBudgetId: string; readonly resourceKeys: readonly string[] }): LeaseTaskView => ({
    node: { state: s.state, rootBudgetId: budgetFor(s.rootBudgetId) },
    resourceKeys: s.resourceKeys,
  });
  return {
    get(taskId) {
      const row = tx.get<MirrorRow>(MIRROR, key(taskId));
      // A task an active lease holds is leased, whatever a host's snapshot says.
      if (activeFor(tx, workspaceId, taskId) !== undefined) return view({ ...(row ?? snapshots.get(taskId) ?? { rootBudgetId: '-', resourceKeys: [] }), state: 'leased' });
      const snap = snapshots.get(taskId);
      if (snap !== undefined) return view(snap);
      return row === undefined ? undefined : view(row);
    },
    leased(taskId, leaseId) {
      const base = snapshots.get(taskId) ?? tx.get<MirrorRow>(MIRROR, key(taskId));
      if (base === undefined) return false;
      tx.put(MIRROR, key(taskId), { workspaceId, taskId, state: 'leased', rootBudgetId: base.rootBudgetId, resourceKeys: base.resourceKeys, leaseId } satisfies MirrorRow);
      return true;
    },
    expired(taskId, leaseId) {
      const row = tx.get<MirrorRow>(MIRROR, key(taskId));
      if (row === undefined || row.leaseId !== leaseId || row.state !== 'leased') return false;
      tx.put(MIRROR, key(taskId), { ...row, state: 'blocked', leaseId: null } satisfies MirrorRow);
      return true;
    },
    reconciled(taskId, resume) {
      const row = tx.get<MirrorRow>(MIRROR, key(taskId));
      if (row === undefined || row.state !== 'blocked') return { ok: false, reasonCode: 'NOT_BLOCKED' };
      tx.put(MIRROR, key(taskId), { ...row, state: resume ? 'ready' : 'cancelled' } satisfies MirrorRow);
      return { ok: true };
    },
    holding() {
      return tx
        .list<MirrorRow>(MIRROR)
        .filter((r) => r.workspaceId === workspaceId && r.state === 'leased' && r.leaseId !== null)
        .map((r) => ({ taskId: r.taskId, leaseId: r.leaseId as string }));
    },
  };
}

function checkTenants(tenants: readonly ControlTenant[]): void {
  if (tenants.length === 0) throw new Error('control: at least one tenant is required');
  const ids = new Set<string>();
  const digests = new Set<string>();
  for (const t of tenants) {
    if (!TENANT_PATTERN.test(t.id)) throw new Error('control: a tenant id must match [a-z0-9][a-z0-9-]{0,62}');
    if (!DIGEST.test(t.tokenSha256)) throw new Error(`control: tenant ${t.id} needs a sha256 hex token digest`);
    if (ids.has(t.id) || digests.has(t.tokenSha256)) throw new Error('control: tenant ids and tokens must be unique');
    ids.add(t.id);
    digests.add(t.tokenSha256);
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function readBody(req: IncomingMessage): Promise<Rec> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new HttpError(413, 'TOO_LARGE');
    chunks.push(chunk);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(concatBytes(chunks)));
  } catch {
    throw new HttpError(400, 'INVALID_JSON');
  }
  if (!isPlain(parsed)) throw new HttpError(400, 'INVALID_JSON');
  return parsed;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': bytes.length, 'cache-control': 'no-store' });
  res.end(bytes);
}

export async function startControlService(options: ControlServiceOptions): Promise<ControlService> {
  checkTenants(options.tenants);
  const host = options.host ?? '127.0.0.1';
  if (options.tls === undefined && !isLoopbackHost(host) && options.allowPlaintext !== true) {
    throw new Error('control: a non-loopback address needs TLS (bearer tokens never travel in plain text)');
  }
  const clock = options.clock ?? (() => Date.now());
  const maxCap = Math.max(1, Math.min(options.maxCap ?? 64, 1024));
  const ledgers = new Map<string, RecordLedger>();
  const ledgerOf = (tenant: string): RecordLedger => {
    let l = ledgers.get(tenant);
    if (l === undefined) {
      l = openLedger(join(options.root, 'tenants', tenant));
      ledgers.set(tenant, l);
    }
    return l;
  };
  const digests = options.tenants.map((t) => ({ id: t.id, digest: hexBytes(t.tokenSha256) }));

  function authenticate(header: string | undefined): string | undefined {
    const m = header === undefined ? null : /^Bearer ([\x21-\x7e]{1,512})$/.exec(header);
    if (m === null) return undefined;
    const presented = hexBytes(tokenDigest(m[1] as string));
    let found: string | undefined;
    // Every digest is compared, so timing says nothing about which tenant matched.
    for (const t of digests) if (timingSafeEqual(presented, t.digest) && found === undefined) found = t.id;
    return found;
  }

  const authorityOf = (ledger: RecordLedger, snapshots: ReadonlyMap<string, TaskSnapshot> = new Map()): LeaseAuthority =>
    ledgerLeaseAuthority(ledger, (workspaceId, tx) => mirrorPort(workspaceId, tx, snapshots));
  const active = (ledger: RecordLedger, workspaceId: string | null) => authorityOf(ledger).activeLeases(workspaceId);

  async function dispatch(tenant: string, op: ControlOp, body: Rec): Promise<unknown> {
    const ledger = ledgerOf(tenant);
    const now = clock();
    switch (op) {
      case 'acquire': {
        const workspaceId = workspaceOf(body);
        const cap = Math.min(reqInt(body, 'cap', 0, 1024), maxCap);
        const snapshots = new Map<string, TaskSnapshot>();
        const requests: LeaseRequest[] = reqArray(body, 'requests', 256).map((value) => {
          const r = reqRecord(value, 'request');
          const taskId = reqString(r, 'taskId');
          snapshots.set(taskId, snapshotOf(own(r, 'task')));
          const ttlMs = optInt(r, 'ttlMs', 1, 3_600_000);
          const ownerId = own(r, 'ownerId');
          if (typeof ownerId !== 'string' || ownerId.length === 0 || ownerId.length > 256) throw new ProtocolError('ownerId');
          return {
            taskId,
            ownerId,
            worktreeId: reqString(r, 'worktreeId'),
            reserveMicroUsd: reqInt(r, 'reserveMicroUsd', 0),
            holder: holderOf(own(r, 'holder')),
            ...(ttlMs === undefined ? {} : { ttlMs }),
          };
        });
        const budgets = reqArray(body, 'budgets', 64).map((b) => budgetOf(b, workspaceId));
        if (budgets.length > 0) {
          await ledger.transact((tx) => {
            for (const b of budgets) {
              const existing = tx.get<BudgetRecord>('budgets', b.id);
              if (existing !== undefined && existing.workspaceId !== workspaceId) continue;
              if (existing === undefined || budgetRevision(b) > budgetRevision(existing)) tx.put('budgets', b.id, b);
            }
          });
        }
        const result = await authorityOf(ledger, snapshots).acquire(workspaceId, requests, { cap, nowMs: now });
        return { ...result, active: active(ledger, workspaceId) };
      }
      case 'heartbeat':
        return authorityOf(ledger).heartbeat(workspaceOf(body), reqString(body, 'leaseId'), reqInt(body, 'fencingToken', 0), now);
      case 'release': {
        const workspaceId = workspaceOf(body);
        const reason = own(body, 'reason');
        const result = await authorityOf(ledger).release(
          workspaceId,
          reqString(body, 'leaseId'),
          reqInt(body, 'fencingToken', 0),
          { actualMicroUsd: intOrNull(body, 'actualMicroUsd', 0) },
          now,
          typeof reason === 'string' ? reason.slice(0, 200) : 'released',
        );
        return { ...result, active: active(ledger, workspaceId) };
      }
      case 'sweep': {
        const workspaceId = workspaceOf(body);
        const hostId = reqString(body, 'hostId');
        const dead = new Set(
          reqArray(body, 'deadHolders', 1024).map((v) => {
            const d = reqRecord(v, 'deadHolder');
            return `${String(reqInt(d, 'pid', 0))}:${String(intOrNull(d, 'startedAtMs', 0))}`;
          }),
        );
        const liveness = (h: ProcessIdentity): Liveness => (h.hostId === hostId && dead.has(`${String(h.pid)}:${String(h.startedAtMs)}`) ? 'dead' : 'other-host');
        const ids = await authorityOf(ledger).sweep(workspaceId, now, liveness);
        const expired = ids.map((leaseId) => ({ leaseId, taskId: ledger.get<LeaseRecord>('leases', recordKey(workspaceId, leaseId))?.lease.taskId ?? null }));
        return { expired, active: active(ledger, workspaceId) };
      }
      case 'reconcile': {
        const workspaceId = workspaceOf(body);
        const resume = own(body, 'resume');
        if (typeof resume !== 'boolean') throw new ProtocolError('resume');
        const result = await authorityOf(ledger).reconcile(workspaceId, reqString(body, 'taskId'), { spentMicroUsd: intOrNull(body, 'spentMicroUsd', 0), resume }, now);
        return { ...result, active: active(ledger, workspaceId) };
      }
      case 'fence': {
        const result = await authorityOf(ledger).publishFenced(workspaceOf(body), reqString(body, 'taskId'), reqInt(body, 'fencingToken', 0), () => true, now);
        return result.ok ? { ok: true } : { ok: false, reasonCode: result.reasonCode };
      }
      case 'leases':
        return { active: active(ledger, own(body, 'workspaceId') === null ? null : workspaceOf(body)) };
      case 'import':
        return importWorkspace(ledger, body);
    }
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      try {
        const path = (req.url ?? '').split('?')[0] ?? '';
        if (req.method === 'GET' && path === '/v1/health') return send(res, 200, { schemaVersion: CONTROL_SCHEMA });
        const m = /^\/v1\/([a-z]+)$/.exec(path);
        const op = m?.[1];
        if (op === undefined || !(CONTROL_OPS as readonly string[]).includes(op)) throw new HttpError(404, 'UNKNOWN_OP');
        if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
        const tenant = authenticate(req.headers.authorization);
        if (tenant === undefined) throw new HttpError(401, 'UNAUTHORIZED');
        const body = await readBody(req);
        send(res, 200, { schemaVersion: CONTROL_SCHEMA, result: await dispatch(tenant, op as ControlOp, body) });
      } catch (error) {
        if (error instanceof HttpError) return send(res, error.status, { schemaVersion: CONTROL_SCHEMA, error: error.code });
        if (error instanceof ProtocolError) return send(res, 400, { schemaVersion: CONTROL_SCHEMA, error: 'INVALID_REQUEST', field: error.field });
        send(res, 500, { schemaVersion: CONTROL_SCHEMA, error: 'INTERNAL' });
      }
    })();
  };

  const server: Server = options.tls === undefined ? createHttpServer(handler) : createHttpsServer({ key: options.tls.key, cert: options.tls.cert }, handler);
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('control: the service has no TCP address');
  const shown = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return {
    url: `${options.tls === undefined ? 'http' : 'https'}://${shown}:${String(address.port)}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/**
 * Migration (ORC-12): a workspace's single-host lease state moves to the service once. The
 * import is refused when the tenant already holds any lease, fence or task mirror row for the
 * workspace, so two imports never merge two histories.
 */
async function importWorkspace(ledger: RecordLedger, body: Rec): Promise<unknown> {
  const workspaceId = workspaceOf(body);
  const budgets = reqArray(body, 'budgets', 256).map((b) => budgetOf(b, workspaceId));
  const leases = reqArray(body, 'leases', 4096).map((v) => {
    const r = reqRecord(v, 'lease');
    const lease = own(r, 'lease');
    if (!AgentLeaseContract.validate(lease).ok || !isPlain(lease) || own(lease, 'workspaceId') !== workspaceId) throw new ProtocolError('lease.lease');
    if (own(r, 'state') !== 'active') throw new ProtocolError('lease.state');
    const keys = reqArray(r, 'resourceKeys', 64);
    if (!keys.every((k) => typeof k === 'string' && k.length <= 512)) throw new ProtocolError('lease.resourceKeys');
    return {
      lease: lease as unknown as LeaseRecord['lease'],
      state: 'active',
      holder: holderOf(own(r, 'holder')),
      reservationId: reqString(r, 'reservationId'),
      resourceKeys: keys as string[],
      ttlMs: reqInt(r, 'ttlMs', 1, 3_600_000),
      issuedAtMs: reqInt(r, 'issuedAtMs', 0),
      endedAtMs: null,
      endReason: null,
    } satisfies LeaseRecord;
  });
  const reservations = reqArray(body, 'reservations', 65_536).map((v) => {
    const r = reqRecord(v, 'reservation');
    const reservation = own(r, 'reservation');
    if (!BudgetReservationContract.validate(reservation).ok) throw new ProtocolError('reservation.reservation');
    if (own(r, 'workspaceId') !== workspaceId) throw new ProtocolError('reservation.workspaceId');
    return {
      reservation: reservation as unknown as ReservationRecord['reservation'],
      workspaceId,
      taskId: reqString(r, 'taskId'),
      leaseId: reqString(r, 'leaseId'),
      updatedAtMs: reqInt(r, 'updatedAtMs', 0),
    } satisfies ReservationRecord;
  });
  const fences = reqArray(body, 'fences', 65_536).map((v) => {
    const f = reqRecord(v, 'fence');
    return { taskId: reqString(f, 'taskId'), token: reqInt(f, 'token', 0) };
  });
  const rootOf = new Map(reservations.map((r) => [r.reservation.id, r.reservation.budgetId]));
  return ledger.transact((tx) => {
    const taken =
      tx.list<LeaseRecord>('leases').some((l) => l.lease.workspaceId === workspaceId) ||
      tx.list<MirrorRow>(MIRROR).some((r) => r.workspaceId === workspaceId) ||
      fences.some((f) => tx.get<number>('fences', recordKey(workspaceId, f.taskId)) !== undefined) ||
      reservations.some((r) => tx.get<ReservationRecord>('reservations', r.reservation.id) !== undefined);
    if (taken) return { ok: false, reasonCode: 'IMPORT_CONFLICT' };
    for (const b of budgets) if (tx.get<BudgetRecord>('budgets', b.id) === undefined) tx.put('budgets', b.id, b);
    for (const r of reservations) tx.put('reservations', r.reservation.id, r);
    for (const f of fences) tx.put('fences', recordKey(workspaceId, f.taskId), f.token);
    for (const l of leases) {
      tx.put('leases', recordKey(workspaceId, l.lease.id), l);
      tx.put(MIRROR, recordKey(workspaceId, l.lease.taskId), {
        workspaceId,
        taskId: l.lease.taskId,
        state: 'leased',
        rootBudgetId: rootOf.get(l.reservationId) ?? '-',
        resourceKeys: l.resourceKeys,
        leaseId: l.lease.id,
      } satisfies MirrorRow);
    }
    return { ok: true, imported: { budgets: budgets.length, leases: leases.length, reservations: reservations.length, fences: fences.length } };
  });
}

/** Tenants for the service from a JSON file `{ tenants: [{ id, tokenSha256 }] }` (no tokens at rest). */
export function tenantsFromJson(text: string): readonly ControlTenant[] {
  const parsed: unknown = JSON.parse(text);
  if (!isPlain(parsed) || !Array.isArray(own(parsed, 'tenants'))) throw new Error('control: tenants file needs { "tenants": [...] }');
  const tenants = (own(parsed, 'tenants') as unknown[]).map((t) => {
    if (!isPlain(t) || typeof own(t, 'id') !== 'string' || typeof own(t, 'tokenSha256') !== 'string') throw new Error('control: each tenant needs id and tokenSha256');
    return { id: own(t, 'id') as string, tokenSha256: own(t, 'tokenSha256') as string };
  });
  checkTenants(tenants);
  return tenants;
}


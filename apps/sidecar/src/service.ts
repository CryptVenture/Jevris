import { randomBytes } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import {
  MODE_OFF_REASON,
  MODE_OFF_REFUSED_OPS,
  SIDECAR_BUDGET_MS,
  SIDECAR_CLIENT_DEADLINE_MARGIN_MS,
  SIDECAR_CLIENT_SCOPES,
  sidecarBudgetsMs,
  testBudgetScale,
  testScaledMs,
  type SidecarAdviceAdherence,
  type SidecarBudgetClass,
  type SidecarClientKind,
  type SidecarOpContext,
  type SidecarOpDefinition,
  type SidecarOpOutcome,
  type SidecarScope,
  type SidecarTraceEvent,
  type SidecarWorkspace,
  modeAllows,
  modeOffMessage,
  type Mode,
} from '@jevris/contracts';
import { createDeadline, elapsedSinceForeignStart, monotonicClock } from '@jevris/platform';
import {
  ANSWER_EVENT_KINDS,
  ANSWER_PRIORITY,
  LineReader,
  MAX_BODY_BYTES,
  NONCE_PATTERN,
  NonceCache,
  OP_PATTERN,
  PROTOCOL,
  SKEW_MS,
  b64url,
  clientKey,
  compareVersions,
  isClientKind,
  isNamedPipe,
  macEquals,
  newNonce,
  parseLine,
  requestMac,
  responseMac,
  serverProof,
  writeLine,
} from './protocol.js';
import { createAdmission, type Admission, type AdmissionClass, type AdmissionSlot } from './admission.js';
import { engineWhenOff } from './mode-off.js';

/**
 * The sidecar service: private IPC with per-request authentication (IPC-01..IPC-04),
 * capability scopes per client kind (IPC-10), workspaces by root identity (IPC-09) and
 * deadlines from event receipt on the monotonic clock with a real AbortSignal (IPC-15).
 * A request is authenticated, fresh, in scope and inside its workspace before any handler runs.
 */

export interface ServiceLimits {
  readonly maxConnections: number;
  readonly maxInFlight: number;
  readonly helloMs: number;
  readonly idleMs: number;
  readonly frameMs: number;
  readonly budgetMs: { readonly [K in SidecarBudgetClass]: number };
  /**
   * The answer lane's budget (ANSWER_BUDGET_MS by default). Limits that set `budgetMs` and not this
   * give the answer lane the hot budget, so a caller that sets the hot budget sets it for every
   * hot request.
   */
  readonly answerBudgetMs?: number;
}

/** How long a refused socket may wait for its last line to flush before it is closed. */
const FLUSH_GUARD_MS = 1_000;
/** Connections past the served cap that may still be open while they read BUSY. */
const REFUSAL_HEADROOM = 256;
/**
 * Connections past the served cap kept for the answer lane (owner decision ededdba, K3): one is
 * accepted, and its request is served only if it is on the answer lane (a SessionStart restore, a
 * Stop reminder, a PreCompact capsule); any other request on it reads BUSY, and one that sends no
 * hello reads BUSY at the hello timeout. The cap therefore never turns a lifecycle answer into
 * BUSY, also where closed connections leave slowly (Windows named pipes under load). As many as
 * the admission's kept answer slots.
 */
const ANSWER_CONNECTIONS = 8;
/**
 * The listen backlog: connections the OS holds until the loop accepts them. The OS may cap it
 * (macOS kern.ipc.somaxconn is 128 by default); a hook that still meets a full backlog retries
 * within its deadline (client.ts).
 */
const LISTEN_BACKLOG = 511;
/**
 * Windows ignores the backlog for a named pipe: what holds connections the loop has not accepted
 * yet is the server's pending pipe instances, 4 by default in libuv. A burst of hooks past four
 * then waits in the client for a free instance (CONNECT_TIMEOUT under 50 subagents, K3). Node
 * reads NODE_PENDING_PIPE_INSTANCES when it creates the pipe server, so it is set around listen.
 */
const PIPE_PENDING_INSTANCES = 128;
/**
 * The budget of an answer-lane request (owner decision ededdba, K3): a SessionStart restore, a Stop
 * reminder or a PreCompact capsule is not a Jev decision, and the harness waits the hook's whole
 * deadline for it, so it may use that deadline (the launcher's longest is 4000 ms) instead of the
 * 900 ms hot budget. The budget counts from the hook's start, and on a loaded host starting the
 * hook process alone can take most of 900 ms, which left a restore a slice too short to answer
 * (SUBSCRIBER_QUEUED). The client's deadline still shortens it, as for every request.
 */
const ANSWER_BUDGET_MS = 4000;

export const DEFAULT_LIMITS: ServiceLimits = {
  maxConnections: 64,
  maxInFlight: 32,
  helloMs: 2000,
  idleMs: 10_000,
  frameMs: 2000,
  budgetMs: SIDECAR_BUDGET_MS,
};

/** The op budgets a service runs with, and the test scale that produced them (1 outside a test run). */
export interface EffectiveBudgets {
  readonly hot: number;
  readonly background: number;
  readonly answer: number;
  readonly scale: number;
}

/**
 * The limits a service runs with. A caller's explicit `limits` win. Of the rest, the op budgets
 * (900 ms hot, 5 s background, 4 s on the answer lane) and the hello and frame timers are the
 * product's, times the test budget scale under a test run (JEVRIS_TEST=1 and JEVRIS_TEST_BUDGET_SCALE;
 * `testBudgetScale` in contracts): a runner that stalls for seconds must not turn a stall into a
 * closed connection or a DEADLINE the product was right to answer. Setting `limits.budgetMs` pins the
 * op budgets exactly (the scale is then not applied to them, and the answer lane follows the hot
 * budget, as it always did, unless `answerBudgetMs` is set); `helloMs` and `frameMs` pin themselves.
 */
export function effectiveLimits(explicit: Partial<ServiceLimits> | undefined, env: { readonly [key: string]: string | undefined }): { readonly limits: ServiceLimits; readonly budgets: EffectiveBudgets } {
  const scale = testBudgetScale(env);
  const limits: ServiceLimits = {
    ...DEFAULT_LIMITS,
    helloMs: testScaledMs(DEFAULT_LIMITS.helloMs, env),
    frameMs: testScaledMs(DEFAULT_LIMITS.frameMs, env),
    budgetMs: sidecarBudgetsMs(env),
    ...(explicit ?? {}),
  };
  const pinned = explicit?.budgetMs !== undefined;
  const answer = explicit?.answerBudgetMs ?? (pinned ? limits.budgetMs.hot : testScaledMs(ANSWER_BUDGET_MS, env));
  return { limits, budgets: { hot: limits.budgetMs.hot, background: limits.budgetMs.background, answer, scale: pinned ? 1 : scale } };
}

export interface LogEntry {
  readonly level: 'info' | 'warn' | 'error';
  readonly event: string;
  readonly [key: string]: string | number | boolean | null | undefined;
}

export interface WorkspaceResolver {
  /** Resolves a frame's `ws`. `undefined` means unknown (refused). */
  resolve(ws: string, register: boolean): Promise<SidecarWorkspace | 'unknown' | 'refused'>;
}

export interface ServiceHooks {
  /** Reads the kill switch for this request; it fails closed (GOV-02). */
  killSwitchStopped(): Promise<boolean>;
  /** The store view for a workspace, or undefined (rules-only). */
  storeFor(workspace: SidecarWorkspace): unknown;
  /** P5: the advice-adherence port for a workspace, or undefined (rules-only). */
  adviceAdherenceFor?(workspace: SidecarWorkspace): SidecarAdviceAdherence | undefined;
  readonly engine: unknown;
  /**
   * The effective mode for a workspace (owner decision 0eb319de), read per request. In off the
   * ops in MODE_OFF_REFUSED_OPS are refused and every op sees an engine that never calls Jev.
   * Absent: not narrowed here.
   */
  modeOf?(workspace: SidecarWorkspace): Mode;
  /**
   * The effective `jev.assist` for a workspace (owner decision 2026-10-01), read per request.
   * Absent: not narrowed here (ops treat it as `classify`).
   */
  jevAssistOf?(workspace: SidecarWorkspace): 'off' | 'classify';
  trace(entry: SidecarTraceEvent & { readonly ws: string; readonly op: string }): void;
  /**
   * OBS-01, OBS-02: a request's receipt (after authentication) and its outcome, rejected
   * frames included, so a trace follows each request from receipt to outcome.
   */
  requestReceived?(entry: { readonly rid: string; readonly op: string; readonly client: SidecarClientKind; readonly budget: SidecarBudgetClass; readonly bytes: number }): void;
  requestDone?(entry: { readonly rid: string; readonly op: string; readonly client: SidecarClientKind; readonly ok: boolean; readonly reasonCode: string | null; readonly ms: number; readonly budget: SidecarBudgetClass; readonly ws?: string; readonly late?: boolean }): void;
  /**
   * The owned-mode grant (IPC-10, TOOL-10, SSOT §16.2): the one submit-scope op an mcp client
   * may call for a workspace whose owned mode is stored as enabled. Read on every request, so
   * turning it off revokes the grant at the next request. Absent: no grant.
   */
  readonly ownedModeGrant?: {
    readonly op: string;
    enabled(workspace: SidecarWorkspace): boolean | Promise<boolean>;
  };
}

export interface ServiceOptions {
  readonly home: string;
  readonly endpoint: string;
  readonly version: string;
  readonly bootKey?: Uint8Array;
  readonly ops: ReadonlyMap<string, SidecarOpDefinition>;
  readonly workspaces: WorkspaceResolver;
  readonly hooks: ServiceHooks;
  readonly limits?: Partial<ServiceLimits>;
  readonly log?: (entry: LogEntry) => void;
  /** Wall clock for the skew check. */
  readonly now?: () => number;
  /** Any authenticated request (idle timer). */
  readonly onActivity?: () => void;
  /** A client runs a newer Jevris: finish and exit so the next start is current (IPC-14). */
  readonly onNewerClient?: () => void;
  /** Listen hook for tests and for the Windows pipe ACL step. */
  readonly afterListen?: (server: Server) => Promise<void> | void;
  /**
   * Hot and background admission (audit P4, K1). Without it the service makes its own, with the
   * hot pool at limits.maxInFlight less a quarter for background work.
   */
  readonly admission?: Admission;
}

export interface SidecarService {
  readonly endpoint: string;
  readonly bootId: string;
  readonly server: Server;
  readonly keys: { readonly [K in SidecarClientKind]: Uint8Array };
  readonly startedAtMs: number;
  connections(): number;
  inFlight(): number;
  nonceCacheSize(): number;
  /** Stops accepting, waits up to drainMs for in-flight work, then aborts it. */
  close(drainMs?: number): Promise<void>;
  readonly closing: boolean;
  /** The op budgets in force (the product's, or the test run's scaled ones; see effectiveLimits). */
  readonly budgets: EffectiveBudgets;
}

interface Pending {
  readonly controller: AbortController;
}

function outcomeFail(reasonCode: string, message?: string): SidecarOpOutcome {
  return message === undefined ? { ok: false, reasonCode } : { ok: false, reasonCode, message };
}

export async function startService(options: ServiceOptions): Promise<SidecarService> {
  const { limits, budgets } = effectiveLimits(options.limits, process.env);
  const answerBudgetMs = budgets.answer;
  const admission: Admission =
    options.admission ?? createAdmission({ hot: Math.max(1, limits.maxInFlight - Math.floor(limits.maxInFlight / 4)), background: Math.max(1, Math.floor(limits.maxInFlight / 4)) });
  const bootKey = options.bootKey ?? new Uint8Array(randomBytes(32));
  const bootId = b64url(randomBytes(12));
  const keys = {
    cli: clientKey(bootKey, 'cli'),
    hook: clientKey(bootKey, 'hook'),
    mcp: clientKey(bootKey, 'mcp'),
  };
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const nonces = new NonceCache(SKEW_MS * 2, 100_000);
  const sockets = new Set<Socket>();
  const answerOnly = new WeakSet<Socket>();
  const pending = new Set<Pending>();
  const background = new Set<Promise<unknown>>();
  let closing = false;

  const server = createServer({ allowHalfOpen: false, pauseOnConnect: true }, (socket) => {
    if (closing) {
      writeLine(socket, { t: 'error', reasonCode: 'SHUTTING_DOWN' });
      endAfterFlush(socket);
      return;
    }
    if (sockets.size >= limits.maxConnections + ANSWER_CONNECTIONS) {
      // Connection cap (IPC-04): refuse at once rather than queue. The BUSY line is flushed
      // before the socket closes, so the client reads BUSY, never CLOSED (audit K7).
      writeLine(socket, { t: 'error', reasonCode: 'BUSY' });
      endAfterFlush(socket);
      return;
    }
    // Past the served cap, only the answer lane is served on this connection.
    if (sockets.size >= limits.maxConnections) answerOnly.add(socket);
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
    socket.on('error', () => {
      sockets.delete(socket);
    });
    void serveConnection(socket).catch((error: unknown) => {
      log({ level: 'error', event: 'connection-error', code: errorName(error) });
      socket.destroy();
    });
  });
  server.on('error', (error) => {
    // Logged, never swallowed (IPC-11).
    log({ level: 'error', event: 'server-error', code: errorName(error) });
  });

  /**
   * Ends the socket once its last line is handed to the OS, then closes it; a peer that never
   * reads cannot hold it open for longer than FLUSH_GUARD_MS (audit K7: a destroy right after the
   * write could drop the BUSY line, which the client then saw as CLOSED).
   */
  function endAfterFlush(socket: Socket): void {
    const guard = setTimeout(() => socket.destroy(), FLUSH_GUARD_MS);
    guard.unref?.();
    socket.once('close', () => clearTimeout(guard));
    // end's callback runs on 'finish': every queued byte has been handed to the OS.
    socket.end(undefined, () => socket.destroy());
  }

  async function serveConnection(socket: Socket): Promise<void> {
    const reader = new LineReader(socket, { idleMs: limits.helloMs, frameMs: limits.frameMs });
    const helloLine = await reader.next();
    if (helloLine.kind !== 'line') {
      if (helloLine.kind === 'oversize') {
        writeLine(socket, { t: 'error', reasonCode: 'OVERSIZE' });
        endAfterFlush(socket);
      } else if (answerOnly.has(socket)) {
        // A connection past the cap that asked nothing reads BUSY, as one refused at once does (K7).
        writeLine(socket, { t: 'error', reasonCode: 'BUSY' });
        endAfterFlush(socket);
      } else socket.destroy();
      return;
    }
    const hello = parseLine(helloLine.text);
    const kind = hello?.['client'];
    const cnonce = hello?.['cnonce'];
    if (hello === undefined || hello['t'] !== 'hello' || hello['v'] !== PROTOCOL || typeof cnonce !== 'string' || !NONCE_PATTERN.test(cnonce)) {
      writeLine(socket, { t: 'error', reasonCode: 'MALFORMED' });
      socket.end();
      return;
    }
    if (!isClientKind(kind)) {
      writeLine(socket, { t: 'error', reasonCode: 'UNKNOWN_CLIENT' });
      socket.end();
      return;
    }
    const clientVersion = hello['runtimeVersion'];
    if (typeof clientVersion === 'string' && clientVersion.length <= 64 && compareVersions(clientVersion, options.version) > 0) {
      // A newer runtime is installed: answer, then drain and exit so the next start is current.
      writeLine(socket, { t: 'error', reasonCode: 'VERSION_MISMATCH' });
      socket.end();
      log({ level: 'info', event: 'version-skew', client: clientVersion, server: options.version });
      options.onNewerClient?.();
      return;
    }
    const key = keys[kind];
    const snonce = newNonce();
    writeLine(socket, {
      t: 'challenge',
      v: PROTOCOL,
      protocol: PROTOCOL,
      version: options.version,
      bootId,
      snonce,
      proof: serverProof(key, cnonce, snonce, bootId),
    });
    reader.setIdle(limits.idleMs);
    for (;;) {
      const next = await reader.next();
      if (next.kind !== 'line') {
        if (next.kind === 'oversize') {
          writeLine(socket, { t: 'error', reasonCode: 'OVERSIZE' });
          endAfterFlush(socket);
        } else socket.destroy();
        return;
      }
      const keep = await serveRequest(socket, next.text, kind, key, snonce);
      if (!keep) {
        socket.end();
        return;
      }
    }
  }

  function reject(socket: Socket, id: unknown, reasonCode: string, kind: SidecarClientKind, op: unknown): false {
    writeLine(socket, typeof id === 'string' && NONCE_PATTERN.test(id) ? { t: 'error', id, reasonCode } : { t: 'error', reasonCode });
    const opName = typeof op === 'string' && OP_PATTERN.test(op) ? op : null;
    log({ level: 'warn', event: 'reject', reasonCode, client: kind, op: opName });
    options.hooks.trace({ event: 'request.rejected', ws: '', op: opName ?? 'unknown', client: kind, reasonCode, ...(typeof id === 'string' && NONCE_PATTERN.test(id) ? { rid: id } : {}) });
    return false;
  }

  async function serveRequest(socket: Socket, text: string, kind: SidecarClientKind, key: Uint8Array, snonce: string): Promise<boolean> {
    const frame = parseLine(text);
    if (frame === undefined || frame['t'] !== 'req' || frame['v'] !== PROTOCOL) return reject(socket, undefined, 'MALFORMED', kind, undefined);
    const id = frame['id'];
    const ws = frame['ws'];
    const op = frame['op'];
    const ts = frame['ts'];
    const eventAtRaw = frame['eventAtMs'];
    const budget = frame['budget'];
    const body = frame['body'];
    const deadlineRaw = frame['deadlineAtMs'];
    const priorityRaw = frame['priority'];
    if (
      typeof id !== 'string' ||
      !NONCE_PATTERN.test(id) ||
      typeof ws !== 'string' ||
      ws.length > 4096 ||
      typeof op !== 'string' ||
      !OP_PATTERN.test(op) ||
      typeof ts !== 'number' ||
      !Number.isSafeInteger(ts) ||
      (eventAtRaw !== null && (typeof eventAtRaw !== 'number' || !Number.isSafeInteger(eventAtRaw))) ||
      (budget !== 'hot' && budget !== 'background') ||
      typeof body !== 'string' ||
      (deadlineRaw !== undefined && deadlineRaw !== null && (typeof deadlineRaw !== 'number' || !Number.isSafeInteger(deadlineRaw))) ||
      (priorityRaw !== undefined && priorityRaw !== null && priorityRaw !== ANSWER_PRIORITY)
    ) {
      return reject(socket, id, 'MALFORMED', kind, op);
    }
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return reject(socket, id, 'OVERSIZE', kind, op);
    const eventAtMs = eventAtRaw === null ? null : (eventAtRaw as number);
    const deadlineAtMs = typeof deadlineRaw === 'number' ? deadlineRaw : null;
    const priority = priorityRaw === ANSWER_PRIORITY ? ANSWER_PRIORITY : null;
    const expected = requestMac(key, { snonce, id, ws, op, ts, eventAtMs, budget, body, deadlineAtMs, priority });
    if (!macEquals(expected, frame['mac'])) return reject(socket, id, 'BAD_MAC', kind, op);
    const wall = now();
    if (ts < wall - SKEW_MS) return reject(socket, id, 'EXPIRED', kind, op);
    if (ts > wall + SKEW_MS) return reject(socket, id, 'CLOCK_SKEW', kind, op);
    // The nonce is consumed before dispatch for every op (IPC-02).
    const fresh = nonces.consume(`${kind}:${id}`, wall);
    if (fresh === 'replayed') return reject(socket, id, 'REPLAYED', kind, op);
    if (fresh === 'full') return reject(socket, id, 'BUSY', kind, op);
    options.onActivity?.();
    if (closing) return reject(socket, id, 'SHUTTING_DOWN', kind, op);
    // P4: hot and background requests have separate pools; a background op never takes a hot
    // slot, and a full pool answers BUSY at once rather than letting the client time out.
    const cls: AdmissionClass = options.ops.get(op)?.budget === 'background' || budget === 'background' ? 'background' : 'hot';
    // The answer lane (ededdba, K3): only a hook's hot `event` may ask for it; the event kind is
    // checked in dispatch once the body is parsed, before anything runs.
    if (priority !== null && (kind !== 'hook' || op !== 'event' || cls !== 'hot')) return reject(socket, id, 'PRIORITY_REFUSED', kind, op);
    // A connection accepted past the cap serves the answer lane only (ANSWER_CONNECTIONS).
    if (priority === null && answerOnly.has(socket)) return reject(socket, id, 'BUSY', kind, op);
    const slot = admission.admit(cls, priority === null ? {} : { answer: true });
    if (slot === undefined) {
      options.hooks.requestDone?.({ rid: id, op, client: kind, ok: false, reasonCode: 'BUSY', ms: 0, budget });
      return reject(socket, id, 'BUSY', kind, op);
    }

    const started = monotonicClock.now();
    options.hooks.requestReceived?.({ rid: id, op, client: kind, budget, bytes: Buffer.byteLength(body, 'utf8') });
    const resolved: { ws?: string } = {};
    let outcome: SidecarOpOutcome;
    try {
      outcome = await dispatch({ id, kind, op, ws, body, budget, eventAtMs: eventAtMs ?? ts, deadlineAtMs, wall, socket, resolved, slot, answer: priority !== null });
    } finally {
      // Idempotent: work that outlived its deadline already moved to an overrun slot.
      slot.release();
    }
    const payload = JSON.stringify(outcome);
    writeLine(socket, { t: 'res', v: PROTOCOL, id, payload, mac: responseMac(key, snonce, id, payload) });
    const ms = Math.round(monotonicClock.now() - started);
    log({
      level: 'info',
      event: 'request',
      op,
      client: kind,
      ok: outcome.ok,
      reasonCode: outcome.ok ? null : outcome.reasonCode,
      ms,
    });
    // P8: an answer written after the client's own deadline reached a client that had given up.
    const late = deadlineAtMs !== null && now() > deadlineAtMs;
    options.hooks.requestDone?.({ rid: id, op, client: kind, ok: outcome.ok, reasonCode: outcome.ok ? null : outcome.reasonCode, ms, budget, ...(resolved.ws !== undefined ? { ws: resolved.ws } : {}), ...(late ? { late: true } : {}) });
    return true;
  }

  interface DispatchInput {
    readonly id: string;
    readonly kind: SidecarClientKind;
    readonly op: string;
    readonly ws: string;
    readonly body: string;
    readonly budget: SidecarBudgetClass;
    readonly eventAtMs: number;
    /** The client's own deadline (wall ms), or null when it sent none. */
    readonly deadlineAtMs: number | null;
    readonly wall: number;
    readonly socket: Socket;
    /** The workspace the request resolved to, for the outcome trace. */
    readonly resolved: { ws?: string };
    /** The admission slot this request holds. */
    readonly slot: AdmissionSlot;
    /** Whether the request came in on the answer lane (its event kind is checked after parsing). */
    readonly answer: boolean;
  }

  async function dispatch(input: DispatchInput): Promise<SidecarOpOutcome> {
    const definition = options.ops.get(input.op);
    if (definition === undefined) return outcomeFail('UNKNOWN_OP');
    const scopes: readonly SidecarScope[] = SIDECAR_CLIENT_SCOPES[input.kind];
    const grant = options.hooks.ownedModeGrant;
    // Only mcp, only the granted op, only a submit-scope op (never admin), only with a workspace.
    const grantCandidate = !scopes.includes(definition.scope) && input.kind === 'mcp' && grant !== undefined && input.op === grant.op && definition.scope === 'submit' && input.ws.length > 0;
    if (!scopes.includes(definition.scope) && !grantCandidate) return outcomeFail('SCOPE_DENIED');
    let workspace: SidecarWorkspace = { id: 'global', root: null };
    if (input.ws.length > 0) {
      const resolved = await options.workspaces.resolve(input.ws, true);
      if (resolved === 'unknown') return outcomeFail('UNKNOWN_WORKSPACE');
      if (resolved === 'refused') return outcomeFail('CROSS_WORKSPACE');
      workspace = resolved;
      input.resolved.ws = resolved.id;
    } else if ((definition.workspace ?? 'required') === 'required') {
      return outcomeFail('UNKNOWN_WORKSPACE');
    }
    if (grantCandidate) {
      let enabled = false;
      try {
        enabled = (await grant.enabled(workspace)) === true;
      } catch {
        enabled = false;
      }
      if (!enabled) return outcomeFail('SCOPE_DENIED');
      // The kill switch revokes the grant whatever the op declares.
      if (await options.hooks.killSwitchStopped()) return outcomeFail('KILL_SWITCH');
      options.hooks.trace({ event: 'owned-mode-grant', ws: workspace.id, op: input.op, rid: input.id, client: input.kind });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.body);
    } catch {
      return outcomeFail('MALFORMED');
    }
    // A request on the answer lane must be the event it claimed: otherwise nothing runs.
    if (input.answer && !answerEvent(parsed)) return outcomeFail('PRIORITY_REFUSED');
    // SSOT §4.2: in off, no Jev call. The explicit asks for Jev are refused; the rest run without one.
    const mode = options.hooks.modeOf?.(workspace);
    const jevAssist = options.hooks.jevAssistOf?.(workspace);
    const off = mode !== undefined && !modeAllows(mode, 'record');
    if (off && MODE_OFF_REFUSED_OPS.includes(input.op)) return outcomeFail(MODE_OFF_REASON, modeOffMessage(input.op));
    const budgetMs = input.answer ? answerBudgetMs : limits.budgetMs[definition.budget === 'background' ? 'background' : input.budget];
    const alreadyElapsed = elapsedSinceForeignStart(input.eventAtMs, input.wall, budgetMs);
    // IPC-15: the sidecar stops when the client stops waiting, less a margin for the answer to
    // travel. A client deadline can only shorten the budget, never extend it.
    const clientLeftMs = input.deadlineAtMs === null ? Number.POSITIVE_INFINITY : input.deadlineAtMs - input.wall - SIDECAR_CLIENT_DEADLINE_MARGIN_MS;
    const effectiveBudgetMs = Math.min(budgetMs, alreadyElapsed + Math.max(0, clientLeftMs));
    const deadline = createDeadline(effectiveBudgetMs, monotonicClock, alreadyElapsed);
    if (deadline.expired()) return outcomeFail('DEADLINE');
    const killSwitchStopped = await options.hooks.killSwitchStopped();
    if (definition.stoppedByKillSwitch === true && killSwitchStopped) return outcomeFail('KILL_SWITCH');

    const controller = new AbortController();
    const entry: Pending = { controller };
    pending.add(entry);
    const onClose = (): void => {
      // A client that goes away cancels its in-flight work (IPC-15).
      if (!controller.signal.aborted) controller.abort(new Error('CANCELLED'));
    };
    input.socket.once('close', onClose);
    const timer = setTimeout(() => {
      if (!controller.signal.aborted) controller.abort(new Error('DEADLINE'));
    }, Math.max(1, deadline.remainingMs()));
    timer.unref();
    const adherence = options.hooks.adviceAdherenceFor?.(workspace);
    const context: SidecarOpContext = {
      op: input.op,
      client: input.kind,
      scopes,
      workspace,
      body: parsed,
      home: options.home,
      signal: controller.signal,
      deadline,
      // The hot budget in force, so an op that waits for Jev inside a person's request (a route) holds to it, not to the 5 s of the background class.
      hotBudgetMs: limits.budgetMs.hot,
      store: options.hooks.storeFor(workspace),
      killSwitchStopped,
      killSwitchNow: () => options.hooks.killSwitchStopped(),
      ...(adherence !== undefined ? { adviceAdherence: adherence } : {}),
      ...(mode !== undefined ? { mode } : {}),
      ...(jevAssist !== undefined ? { jevAssist } : {}),
      engine: off ? engineWhenOff(options.hooks.engine) : options.hooks.engine,
      trace(event) {
        options.hooks.trace({ ...event, ws: workspace.id, op: input.op, rid: input.id, client: input.kind });
      },
    };
    const aborted = new Promise<SidecarOpOutcome>((resolve) => {
      const done = (): void => {
        const reason = controller.signal.reason;
        resolve(outcomeFail(reason instanceof Error && reason.message === 'CANCELLED' ? 'CANCELLED' : 'DEADLINE'));
      };
      if (controller.signal.aborted) done();
      else controller.signal.addEventListener('abort', done, { once: true });
    });
    const work = (async (): Promise<SidecarOpOutcome> => {
      try {
        const result = await definition.handle(context);
        return normalizeOutcome(result);
      } catch (error) {
        log({ level: 'error', event: 'handler-error', op: input.op, code: errorName(error) });
        return outcomeFail('INTERNAL', 'The sidecar hit an internal error; the call ran rules-only. See the sidecar log.');
      }
    })();
    try {
      const winner = await Promise.race([work, aborted]);
      if (!winner.ok && (winner.reasonCode === 'DEADLINE' || winner.reasonCode === 'CANCELLED')) {
        // K1: the work runs on (its effect may be half done), but it gives back its slot and holds
        // an overrun slot until it settles, so work past its deadline stays bounded.
        const tail = work.catch(() => undefined);
        background.add(tail);
        void tail.finally(() => background.delete(tail));
        input.slot.overrun(tail);
      }
      return winner;
    } finally {
      clearTimeout(timer);
      input.socket.removeListener('close', onClose);
      pending.delete(entry);
    }
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    server.once('error', onError);
    const pipe = process.platform === 'win32' && isNamedPipe(options.endpoint);
    const previous = process.env['NODE_PENDING_PIPE_INSTANCES'];
    if (pipe) process.env['NODE_PENDING_PIPE_INSTANCES'] = String(PIPE_PENDING_INSTANCES);
    try {
      server.listen({ path: options.endpoint, readableAll: false, writableAll: false, backlog: LISTEN_BACKLOG }, () => {
        server.removeListener('error', onError);
        resolve();
      });
    } finally {
      if (pipe) {
        if (previous === undefined) delete process.env['NODE_PENDING_PIPE_INSTANCES'];
        else process.env['NODE_PENDING_PIPE_INSTANCES'] = previous;
      }
    }
  });
  // The OS-level ceiling sits above the served cap, so a connection past the cap still reaches
  // the handler and reads BUSY; at the ceiling itself Node closes it unread (audit K7).
  server.maxConnections = limits.maxConnections + REFUSAL_HEADROOM;
  if (options.afterListen !== undefined) await options.afterListen(server);
  const startedAtMs = Date.now();

  const service: SidecarService = {
    endpoint: options.endpoint,
    bootId,
    server,
    keys,
    startedAtMs,
    connections: () => sockets.size,
    inFlight: () => pending.size + admission.counts().overrun,
    budgets,
    nonceCacheSize: () => nonces.size,
    get closing() {
      return closing;
    },
    async close(drainMs = 5000): Promise<void> {
      if (closing) return;
      closing = true;
      const closed = new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      const until = Date.now() + drainMs;
      while (pending.size > 0 && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      for (const entry of pending) {
        if (!entry.controller.signal.aborted) entry.controller.abort(new Error('SHUTTING_DOWN'));
      }
      for (const socket of sockets) socket.destroy();
      await Promise.race([Promise.allSettled([...background]), new Promise((resolve) => setTimeout(resolve, 250))]);
      await closed;
    },
  };
  return service;
}

function normalizeOutcome(value: unknown): SidecarOpOutcome {
  if (value === null || typeof value !== 'object') return outcomeFail('INTERNAL');
  const record = value as { readonly ok?: unknown; readonly body?: unknown; readonly reasonCode?: unknown; readonly message?: unknown };
  if (record.ok === true) return { ok: true, body: record.body ?? null };
  if (record.ok === false && typeof record.reasonCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(record.reasonCode)) {
    return typeof record.message === 'string' ? { ok: false, reasonCode: record.reasonCode, message: record.message.slice(0, 500) } : { ok: false, reasonCode: record.reasonCode };
  }
  return outcomeFail('INTERNAL');
}

function errorName(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = Reflect.get(error, 'code');
    if (typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code)) return code;
    const name = Reflect.get(error, 'name');
    if (typeof name === 'string' && /^[A-Za-z]{1,40}$/.test(name)) return name;
  }
  return 'Error';
}

/** Whether a parsed `event` body is one whose answer rides the answer lane (ANSWER_EVENT_KINDS). */
function answerEvent(body: unknown): boolean {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false;
  const envelope: unknown = Reflect.get(body, 'envelope');
  const kind: unknown = envelope !== null && typeof envelope === 'object' && !Array.isArray(envelope) ? Reflect.get(envelope, 'kind') : undefined;
  return typeof kind === 'string' && ANSWER_EVENT_KINDS.includes(kind);
}

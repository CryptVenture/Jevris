/**
 * The production `fetch` of the Jev transport, over `node:https` (and `node:http` for the loopback
 * test provider), with a keep-alive agent of several sockets.
 *
 * Why not the global `fetch`. Node's `fetch` (undici) negotiates HTTP/2 with api.typesafe.ai and then
 * runs concurrent requests to it ONE AT A TIME: measured live on 2026-10-03, four parallel requests
 * of the same size came back at 201, 389, 573 and 776 ms, while the same four over `node:https` on
 * separate sockets, and over four streams of one `node:http2` session, all came back in about 240 ms.
 * So the API itself answers in parallel; the global fetch did not send in parallel. A sidecar that
 * serves several sessions at once, and a plan that asks several questions inside one deadline, were
 * queueing behind each other. This adapter sends each request on its own socket from a small pool.
 *
 * It is a minimal `fetch`: one request, no redirect following (a 3xx comes back as it is), the
 * response body as a web stream, the caller's AbortSignal honoured, a failed connection reported as a
 * `TypeError('fetch failed')` the way undici does. It adds no header, reads no environment (no proxy
 * variable), and never logs. The transport above it (`sdk-transport.ts`) still owns the size cap,
 * the deadline and the error taxonomy.
 */
import { Agent as HttpAgent, request as httpRequest, type PoolSocket } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

/** The most sockets one origin may use at once: more than a hook burst or a plan needs. */
export const MAX_SOCKETS = 8;
/**
 * An idle socket is closed after this long, so a connection the other end has dropped is not handed back for long.
 * Measured live (2026-10-04): api.typesafe.ai kept an idle connection for at least 120 s, and a request on a
 * connection that was already open answered 50 to 110 ms sooner than one that had to connect (TCP and TLS). With
 * 10 s every request after a pause longer than that paid for a new connection. 30 s covers a pause between a
 * person's prompts, and `dropIdleIfSlept` closes what a sleeping machine leaves half-open.
 */
export const IDLE_SOCKET_MS = 30_000;
/** A connection opened ahead of a request (`prewarmConnection`) is closed if no request took it within this long. */
export const SPARE_SOCKET_MS = 20_000;
/** A gap between the wall clock and the monotonic clock longer than this means the machine slept (or its clock was set). */
const SLEEP_GAP_MS = 2_000;

let httpsAgent: HttpsAgent | undefined;
let httpAgent: HttpAgent | undefined;

function agentFor(protocol: string): HttpsAgent | HttpAgent {
  if (protocol === 'https:') {
    httpsAgent ??= new HttpsAgent({ keepAlive: true, maxSockets: MAX_SOCKETS, maxFreeSockets: MAX_SOCKETS, timeout: IDLE_SOCKET_MS });
    return httpsAgent;
  }
  httpAgent ??= new HttpAgent({ keepAlive: true, maxSockets: MAX_SOCKETS, maxFreeSockets: MAX_SOCKETS, timeout: IDLE_SOCKET_MS });
  return httpAgent;
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

type CreateConnection = HttpAgent['createConnection'];

/** The wall and the monotonic time of the last request: a sleep moves the first and not (on most hosts) the second. */
let lastActive: { readonly wall: number; readonly mono: number } | null = null;

function touch(): void {
  lastActive = { wall: Date.now(), mono: performance.now() };
}

/**
 * After the machine slept, every idle socket is suspect: the other end closed it long ago and this end was not awake to
 * see it, so a request on it would hang until its deadline. They are closed, and the next request opens a new connection.
 * The time of an idle socket's timeout is monotonic, so it does not notice the sleep by itself.
 */
function dropIdleIfSlept(): void {
  if (lastActive === null) return;
  const slept = Date.now() - lastActive.wall - (performance.now() - lastActive.mono);
  if (slept <= SLEEP_GAP_MS) return;
  for (const agent of [httpsAgent, httpAgent]) {
    if (agent === undefined) continue;
    for (const list of Object.values(agent.freeSockets)) for (const socket of list ?? []) socket.destroy();
  }
  closePrewarmed();
}

// ------------------------------------------------------------------------------------------ a connection ahead of a request

interface Spare {
  readonly socket: PoolSocket;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly gone: () => void;
}

/** Connections opened ahead of a request, by `protocol//host:port`. One per origin. */
const spares = new Map<string, Spare>();
/** Each agent's own connection function, which the agent was given before the spare hand-out wrapped it. */
const originals = new WeakMap<object, CreateConnection>();

/** A timer that does not keep the process alive (Node's timers have `unref`; the package compiles without Node types). */
function unrefTimer(handle: unknown): void {
  (handle as { unref?: () => void }).unref?.();
}

function spareKey(protocol: string, host: string, port: number | string | undefined): string {
  return `${protocol}//${host.toLowerCase()}:${String(port)}`;
}

function dropSpare(key: string, destroy: boolean): void {
  const spare = spares.get(key);
  if (spare === undefined) return;
  spares.delete(key);
  clearTimeout(spare.timer);
  spare.socket.off('close', spare.gone);
  spare.socket.off('error', spare.gone);
  if (destroy) spare.socket.destroy();
}

/** Makes the agent's next new connection the spare one, when there is one for that origin and it is still open. */
function installSpareHandOut(agent: HttpAgent, protocol: string): CreateConnection {
  const known = originals.get(agent);
  if (known !== undefined) return known;
  const original = agent.createConnection.bind(agent) as CreateConnection;
  originals.set(agent, original);
  agent.createConnection = (options, callback) => {
    const key = spareKey(protocol, String(options.host ?? ''), options.port);
    const spare = spares.get(key);
    if (spare !== undefined && !spare.socket.destroyed) {
      dropSpare(key, false);
      // The pool counts a request on it as in use, which keeps the process alive like any other.
      spare.socket.ref();
      return spare.socket;
    }
    if (spare !== undefined) dropSpare(key, true);
    return original(options, callback);
  };
  return original;
}

/** Closes every connection that was opened ahead of a request and never taken. */
export function closePrewarmed(): void {
  for (const key of [...spares.keys()]) dropSpare(key, true);
}

/** How many connections wait, opened ahead of a request and not taken yet. */
export function prewarmedConnections(): number {
  return spares.size;
}

/**
 * Opens one connection to the origin of `input` (TCP, and TLS for https, verified as any request's would be) and keeps
 * it for the next request to that origin, so that request does not pay for the handshake (50 to 110 ms measured live).
 * It sends no request and no data: the connection is idle until a request takes it, and is closed when none does
 * within `SPARE_SOCKET_MS`, or when the other end closes it. It never keeps the process alive. Returns whether a
 * connection is ready (already waiting, already idle in the pool, or opened now); never throws and never rejects.
 */
export function prewarmConnection(input: string, options: { readonly timeoutMs?: number } = {}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      resolve(false);
      return;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      resolve(false);
      return;
    }
    const agent = agentFor(url.protocol);
    const open = installSpareHandOut(agent, url.protocol);
    const host = url.hostname;
    const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
    const key = spareKey(url.protocol, host, port);
    const waiting = spares.get(key);
    if (waiting !== undefined && !waiting.socket.destroyed) {
      resolve(true);
      return;
    }
    if (Object.entries(agent.freeSockets).some(([name, list]) => name.startsWith(`${host}:${String(port)}:`) && (list?.length ?? 0) > 0)) {
      resolve(true);
      return;
    }
    let socket: PoolSocket;
    try {
      // Through the agent's own connection function, so the TLS settings are the pool's.
      socket = open({ host, port, ...(url.protocol === 'https:' && !/^[0-9.]+$|:/.test(host) ? { servername: host } : {}) });
    } catch {
      resolve(false);
      return;
    }
    const ready = url.protocol === 'https:' ? 'secureConnect' : 'connect';
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(opening);
      socket.off(ready, onReady);
      if (!ok) {
        socket.off('error', onFailed);
        socket.destroy();
      }
      resolve(ok);
    };
    const onFailed = (): void => finish(false);
    const onReady = (): void => {
      socket.unref();
      const gone = (): void => dropSpare(key, true);
      const timer = setTimeout(gone, SPARE_SOCKET_MS);
      unrefTimer(timer);
      socket.off('error', onFailed);
      // Waiting for a request, a socket that errors or closes is dropped, and its error is not left unhandled.
      socket.on('close', gone);
      socket.on('error', gone);
      spares.set(key, { socket, timer, gone });
      finish(true);
    };
    const opening = setTimeout(() => finish(false), Math.max(100, Math.floor(options.timeoutMs ?? 3000)));
    unrefTimer(opening);
    socket.once(ready, onReady);
    socket.once('error', onFailed);
  });
}

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function fetchFailed(): TypeError {
  return new TypeError('fetch failed');
}

/** A `fetch` with the semantics the Jev transport needs. Throws (rejects) like fetch: only for a failed or aborted request. */
export function nodeFetch(input: string, init?: RequestInit): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      reject(fetchFailed());
      return;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      reject(fetchFailed());
      return;
    }
    const signal = init?.signal ?? undefined;
    if (signal?.aborted === true) {
      reject(abortError());
      return;
    }
    dropIdleIfSlept();
    touch();
    const headers: { [name: string]: string } = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const body = typeof init?.body === 'string' ? new TextEncoder().encode(init.body) : init?.body instanceof Uint8Array ? init.body : undefined;
    if (body !== undefined && headers['content-length'] === undefined) headers['content-length'] = String(body.byteLength);
    const method = (init?.method ?? 'GET').toUpperCase();
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      action();
    };
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(url, { method, headers, agent: agentFor(url.protocol) }, (res) => {
      finish(() => {
        const responseHeaders = new Headers();
        for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
          const name = res.rawHeaders[i];
          const value = res.rawHeaders[i + 1];
          if (name !== undefined && value !== undefined) responseHeaders.append(name, value);
        }
        res.on('close', touch);
        const status = res.statusCode ?? 0;
        const payload = NULL_BODY_STATUSES.has(status) || method === 'HEAD' ? null : (Readable.toWeb(res) as unknown as BodyInit);
        if (payload === null) res.destroy();
        resolve(new Response(payload, { status, statusText: res.statusMessage ?? '', headers: responseHeaders }));
      });
    });
    const onAbort = (): void => {
      finish(() => {
        req.destroy(abortError());
        reject(abortError());
      });
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', () => {
      finish(() => reject(fetchFailed()));
    });
    if (body === undefined) req.end();
    else req.end(body);
  });
}

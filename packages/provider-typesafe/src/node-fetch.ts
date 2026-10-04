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
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

/** The most sockets one origin may use at once: more than a hook burst or a plan needs. */
export const MAX_SOCKETS = 8;
/** An idle socket is closed after this long, so a server-side close cannot hand back a dead one. */
export const IDLE_SOCKET_MS = 10_000;

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

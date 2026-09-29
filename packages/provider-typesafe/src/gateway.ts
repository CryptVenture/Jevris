/**
 * Gateway adapters (PRV-09, §2.6): Vercel AI Gateway, Cloudflare AI and Netlify AI Gateway.
 *
 * Each adapter turns a gateway's result into the native Jev response shape so the engine's §7.5
 * validator applies unchanged, and keeps every native meaning:
 * - Noul is never flattened to a Boolean: Vercel's `probability` becomes `noul`, and a result
 *   without a probability is refused.
 * - The resolved model id is kept. A gateway that cannot reveal it makes the call advisory-only
 *   (the engine never automates on it).
 * - Probabilities are passed through untouched (the validator rejects a truncated distribution),
 *   and usage and error provenance are kept.
 * - Cloudflare's discovered 32,000-token context is enforced as the stricter request limit.
 *
 * Gateways ship disabled by default (E-25): the sidecar uses the direct SDK transport unless an
 * administrator enables a certified gateway.
 */
import type { JevCallOptions, JevTransport, JevTransportResult, JevWireRequest, ProviderFailureKind } from '@jevris/contracts';
import { callDeadline } from './call-deadline.js';
import { statusFailure } from './sdk-transport.js';

function aborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted === true;
}

export const GATEWAY_IDS = ['vercel', 'cloudflare', 'netlify'] as const;
export type GatewayId = (typeof GATEWAY_IDS)[number];

export interface GatewayDescriptor {
  readonly id: GatewayId;
  readonly route: string;
  readonly enabledByDefault: false;
  /** The stricter request-token limit discovered for this gateway, or null for the native limit. */
  readonly requestTokenLimit: number | null;
  readonly billing: 'gateway-credits' | 'provider-direct';
}

export const GATEWAYS: Readonly<Record<GatewayId, GatewayDescriptor>> = Object.freeze({
  vercel: { id: 'vercel', route: 'gateway-vercel', enabledByDefault: false, requestTokenLimit: null, billing: 'gateway-credits' },
  cloudflare: { id: 'cloudflare', route: 'gateway-cloudflare', enabledByDefault: false, requestTokenLimit: 32_000, billing: 'gateway-credits' },
  netlify: { id: 'netlify', route: 'gateway-netlify', enabledByDefault: false, requestTokenLimit: null, billing: 'gateway-credits' },
});

/** What a gateway client returns. `model` is null when the gateway does not reveal it. */
export interface GatewayRawResult {
  readonly status: number;
  readonly model: string | null;
  readonly answers: Readonly<Record<string, unknown>> | null;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number } | null;
  readonly retryAfterMs?: number | null;
}

export type GatewayInvoke = (request: JevWireRequest, options: JevCallOptions) => Promise<GatewayRawResult>;

export type NormalizeResult =
  | { readonly ok: true; readonly answers: Record<string, unknown> }
  | { readonly ok: false; readonly reasonCode: 'GATEWAY_NOUL_FLATTENED' | 'GATEWAY_SHAPE' };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Normalizes one gateway's answers to native shapes, keyed by the request's question types. */
export function normalizeGatewayAnswers(gateway: GatewayId, request: JevWireRequest, answers: Readonly<Record<string, unknown>>): NormalizeResult {
  const out: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(answers)) {
    const question = request.questions[id];
    if (!record(raw) || question === undefined) {
      out[id] = raw;
      continue;
    }
    if (question.type === 'noul') {
      if (Object.hasOwn(raw, 'noul')) {
        out[id] = raw;
        continue;
      }
      // Vercel's evaluate API reports the yes probability as `probability`.
      const probability = raw['probability'];
      if (typeof probability !== 'number') return { ok: false, reasonCode: 'GATEWAY_NOUL_FLATTENED' };
      const { probability: _dropped, result: _flattened, ...rest } = raw as Record<string, unknown> & { result?: unknown };
      out[id] = { ...rest, type: 'noul', noul: probability };
      continue;
    }
    out[id] = gateway === 'vercel' && !Object.hasOwn(raw, 'type') ? { type: question.type, ...raw } : raw;
  }
  return { ok: true, answers: out };
}

export class GatewayTransport implements JevTransport {
  readonly route: string;
  readonly providerId: string;
  readonly accountId: string;
  readonly descriptor: GatewayDescriptor;
  readonly #invoke: GatewayInvoke;
  #calls = 0;

  constructor(gateway: GatewayId, invoke: GatewayInvoke, accountId = 'primary') {
    this.descriptor = GATEWAYS[gateway];
    this.route = this.descriptor.route;
    this.providerId = `gateway-${gateway}`;
    this.accountId = accountId;
    this.#invoke = invoke;
  }

  get calls(): number {
    return this.#calls;
  }

  async call(request: JevWireRequest, options: JevCallOptions): Promise<JevTransportResult> {
    const started = performance.now();
    const elapsedMs = (): number => Math.max(0, Math.round(performance.now() - started));
    const failed = (failure: ProviderFailureKind, status: number | null, sent: boolean, retryAfterMs: number | null = null): JevTransportResult => ({
      ok: false,
      failure,
      status,
      retryAfterMs,
      sent,
      requestId: null,
      elapsedMs: elapsedMs(),
    });
    if (aborted(options.signal)) return failed('cancelled', null, false);
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) return failed('deadline', null, false);
    // The gateway client gets the combined signal, and the call ends at the deadline even if the
    // client ignores it: the transport owns the total deadline, not the gateway SDK.
    const deadline = callDeadline(options.timeoutMs, options.signal);
    let raw: GatewayRawResult;
    try {
      this.#calls += 1;
      raw = await deadline.guard(this.#invoke(request, { timeoutMs: Math.max(1, Math.floor(options.timeoutMs)), signal: deadline.signal }));
    } catch (error) {
      if (deadline.state === 'expired') return failed('timeout', null, true);
      if (deadline.state === 'cancelled' || aborted(options.signal)) return failed('cancelled', null, true);
      return failed(error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'connection', null, true);
    } finally {
      deadline.dispose();
    }
    if (aborted(options.signal)) return failed('cancelled', null, true);
    if (raw.status < 200 || raw.status > 299) return failed(statusFailure(raw.status), raw.status, true, raw.retryAfterMs ?? null);
    if (raw.answers === null) return failed('invalid-response', raw.status, true);
    const normalized = normalizeGatewayAnswers(this.descriptor.id, request, raw.answers);
    if (!normalized.ok) return failed('invalid-response', raw.status, true);
    const advisoryOnly = raw.model === null;
    const body = {
      // Without a visible model the pinned id stands in only so the shape validates; the result is advisory-only.
      model: raw.model ?? request.model,
      answers: normalized.answers,
      usage: raw.usage ?? { input_tokens: 0, output_tokens: 0 },
    };
    return {
      ok: true,
      status: raw.status,
      body: new TextEncoder().encode(JSON.stringify(body)),
      requestId: null,
      elapsedMs: elapsedMs(),
      ...(advisoryOnly ? { advisoryOnly: true } : {}),
      ...(raw.usage === null ? { usageUnknown: true } : {}),
    };
  }
}

export function createGatewayTransport(gateway: GatewayId, invoke: GatewayInvoke, options: { readonly enabled: boolean; readonly accountId?: string }): GatewayTransport {
  if (options.enabled !== true) throw new Error('GATEWAY_DISABLED');
  return new GatewayTransport(gateway, invoke, options.accountId);
}

/**
 * D's capability registry and the `capability.advise` entry point (SSOT §12; C17-C48, C57-C72).
 *
 * `adviseCapability` resolves a capability id (`C33`, `c33` or the legacy `CAP-33`), runs the
 * capability against the workspace with the sidecar's decision engine, and returns the advice
 * envelope. An id that is not D's, or not built yet, is refused with UNKNOWN_CAPABILITY. The
 * capabilities with their own product ops (C17-C24 memory through checkpoint/recover, C27 and
 * C31 through leases, C29 through recover, C39 and C48 through verify, C63 through handoff) are
 * mapped to those ops so a caller is pointed at the real path instead of a second copy.
 */
import type { WorkspaceServices } from '../workspace.js';
import { nodeGit, type GitPort } from '../verify/revision.js';
import { isPlain, type Rec } from '../util.js';
import { abstainAdvice, type CapabilityAdvice, type CapabilityContext, type CapabilityDefinition } from './advice.js';
import { RETRIEVAL_CAPABILITIES } from './retrieval.js';
import { VERIFICATION_CAPABILITIES } from './verification.js';
import { ORCHESTRATION_CAPABILITIES } from './orchestration.js';
import { DELIVERY_CAPABILITIES } from './delivery.js';
import { RESEARCH_CAPABILITIES } from './research.js';

const DEFINITIONS: readonly CapabilityDefinition[] = [...ORCHESTRATION_CAPABILITIES, ...RETRIEVAL_CAPABILITIES, ...VERIFICATION_CAPABILITIES, ...DELIVERY_CAPABILITIES, ...RESEARCH_CAPABILITIES];

export const CAPABILITIES: ReadonlyMap<string, CapabilityDefinition> = new Map(DEFINITIONS.map((d) => [d.id, d]));

/** Capabilities that already run through their own product op; advise points there. */
export const CAPABILITY_OPS: { readonly [id: string]: string } = Object.freeze({
  C17: 'checkpoint',
  C18: 'checkpoint',
  C19: 'checkpoint',
  C20: 'checkpoint',
  C21: 'handoff.import',
  C22: 'evidence.get',
  C23: 'checkpoint',
  C24: 'checkpoint',
  C27: 'task.submit',
  C29: 'recover',
  C31: 'task.get',
  C39: 'verify',
  C48: 'verify',
  C63: 'handoff.export',
});

/** Normalises `C33`, `c33`, `CAP-33` and `CAP-033` to `C33`; undefined for anything else. */
export function capabilityKey(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const m = /^(?:C|CAP-?)0*(\d{1,3})$/i.exec(raw.trim());
  return m === null ? undefined : `C${String(Number(m[1]))}`;
}

/** D owns C17-C48 and C57-C72. */
export function isDomainCapability(key: string): boolean {
  const n = Number(key.slice(1));
  return (n >= 17 && n <= 48) || (n >= 57 && n <= 72);
}

export interface AdviseCapabilityInput {
  readonly capabilityId: unknown;
  readonly input?: unknown;
  readonly taskId?: string | null;
  readonly engine?: unknown;
  readonly egressApproved?: boolean;
  readonly remainingMs?: number;
  readonly nowMs?: number;
  readonly git?: GitPort;
  readonly platform?: string;
  readonly home: string;
  readonly env?: { readonly [key: string]: string | undefined };
}

export type AdviseCapabilityResult =
  | { readonly ok: true; readonly advice: CapabilityAdvice }
  | { readonly ok: false; readonly reasonCode: 'UNKNOWN_CAPABILITY' | 'NOT_DOMAIN_CAPABILITY' | 'USE_PRODUCT_OP'; readonly op?: string };

export async function adviseCapability(ws: WorkspaceServices, request: AdviseCapabilityInput): Promise<AdviseCapabilityResult> {
  const key = capabilityKey(request.capabilityId);
  if (key === undefined) return { ok: false, reasonCode: 'UNKNOWN_CAPABILITY' };
  if (!isDomainCapability(key)) return { ok: false, reasonCode: 'NOT_DOMAIN_CAPABILITY' };
  const op = CAPABILITY_OPS[key];
  if (op !== undefined) return { ok: false, reasonCode: 'USE_PRODUCT_OP', op };
  const def = CAPABILITIES.get(key);
  if (def === undefined) return { ok: false, reasonCode: 'UNKNOWN_CAPABILITY' };
  // The time left counts down while the capability runs. A capability that consults Jev several times in
  // a row (C34 asks per candidate, C25 per pair) reads it afresh before each ask, so it stops asking when
  // the time is gone and the rules answer the rest. Measured: with a fixed figure, C34 made seven asks in
  // a row and answered DEADLINE with no advice at all.
  const startedAt = Date.now();
  const budgetMs = request.remainingMs;
  const cx: CapabilityContext = {
    ws,
    engine: request.engine,
    egressApproved: request.egressApproved === true,
    get remainingMs(): number | undefined {
      return budgetMs === undefined ? undefined : Math.max(0, budgetMs - (Date.now() - startedAt));
    },
    nowMs: request.nowMs ?? Date.now(),
    git: request.git ?? nodeGit(),
    platform: request.platform ?? process.platform,
    taskId: request.taskId ?? null,
    home: request.home,
    env: request.env ?? process.env,
  };
  const input: Rec = isPlain(request.input) ? request.input : {};
  try {
    return { ok: true, advice: await def.handle(cx, input) };
  } catch {
    // A capability never throws past the op: a failure abstains and the rules path is intact.
    return { ok: true, advice: abstainAdvice(def, 'CAPABILITY_ERROR', 'The capability could not run on this workspace.') };
  }
}

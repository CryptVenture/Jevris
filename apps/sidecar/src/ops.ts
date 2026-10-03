import type {
  SidecarEventSubscriber,
  SidecarOpContext,
  SidecarOpDefinition,
  SidecarOpOutcome,
} from '@jevris/contracts';
import { HARNESS_IDS, type HarnessId } from '@jevris/contracts';
import { firstTryOf, harnessVersionOf, readEffectiveConfig, withFirstTryExplain } from '@jevris/orchestrator';

/**
 * The op registry. Built-in ops (domain B) plus `sidecarOps` exported by the op packages
 * (SIDECAR_OP_PACKAGES). Every package import is a literal dynamic import, so the bundle keeps
 * it. Two sources claiming one op name refuse the start, naming both.
 */

export const BUILTIN_OP_NAMES: readonly string[] = [
  'ping',
  'health',
  'status',
  'event',
  'shutdown',
  'workspace.register',
  'workspace.list',
  'egress.check',
  'kill-switch.status',
  'kill-switch.activate',
  'store.health',
  'store.backup',
  'store.export',
  'audit.export',
  'audit.verify',
  'audit.record',
  'data.purge',
  'authorization.mint',
  'metrics',
  'diagnostic.set',
  'latency.counters',
  'learning.purge',
  'provider.consent.status',
  'provider.consent.grant',
  'provider.consent.revoke',
  'route.turn',
  'session.link',
  'session.unlink',
  'access-limits.clear',
  'jev.reenable',
];

export const BUILTIN_SOURCE = '@jevris/sidecar (built-in)';

export interface OpSource {
  readonly name: string;
  readonly ops: readonly SidecarOpDefinition[];
  readonly subscribers: readonly SidecarEventSubscriber[];
}

export interface LoadedOps {
  /** Package and extra ops, without the built-ins (added by the runtime state). */
  readonly ops: ReadonlyMap<string, SidecarOpDefinition>;
  readonly owners: ReadonlyMap<string, string>;
  readonly subscribers: readonly (SidecarEventSubscriber & { readonly source: string })[];
  readonly sources: readonly string[];
}

export class DuplicateOpError extends Error {
  readonly op: string;
  readonly first: string;
  readonly second: string;
  constructor(op: string, first: string, second: string) {
    super(`Sidecar op "${op}" is exported by both ${first} and ${second}; the sidecar refuses to start until one of them renames it.`);
    this.name = 'DuplicateOpError';
    this.op = op;
    this.first = first;
    this.second = second;
  }
}

function isDefinition(value: unknown): value is SidecarOpDefinition {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['op'] === 'string' &&
    /^[a-z][a-z0-9._-]{0,63}$/.test(v['op']) &&
    (v['scope'] === 'status' || v['scope'] === 'advice' || v['scope'] === 'checkpoint' || v['scope'] === 'submit' || v['scope'] === 'admin') &&
    (v['budget'] === 'hot' || v['budget'] === 'background') &&
    typeof v['handle'] === 'function'
  );
}

function isSubscriber(value: unknown): value is SidecarEventSubscriber {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v['name'] === 'string' && v['name'].length > 0 && v['name'].length <= 64 && typeof v['handle'] === 'function';
}

function sourceFrom(name: string, loaded: unknown): OpSource | undefined {
  if (loaded === null || typeof loaded !== 'object') return undefined;
  const rawOps = Reflect.get(loaded, 'sidecarOps');
  const rawSubs = Reflect.get(loaded, 'sidecarEventSubscribers');
  const ops = Array.isArray(rawOps) ? rawOps.filter(isDefinition) : [];
  const subscribers = Array.isArray(rawSubs) ? rawSubs.filter(isSubscriber) : [];
  if (ops.length === 0 && subscribers.length === 0) return undefined;
  return { name, ops, subscribers };
}

async function tryImport(name: string, load: () => Promise<unknown>): Promise<OpSource | undefined> {
  try {
    return sourceFrom(name, await load());
  } catch {
    return undefined;
  }
}

type HarnessVersionOf = (home: string, harness: string) => string | null;

function isHarnessId(value: unknown): value is HarnessId {
  return typeof value === 'string' && (HARNESS_IDS as readonly string[]).includes(value);
}

/**
 * The installed harness version source for C's decision subscriber: D's host-ledger
 * `harnessVersionOf` (the launcher no longer forwards a recorded version). A harness outside
 * HARNESS_IDS or a ledger failure answers null, and an unknown version is never certified.
 */
export function harnessVersionSource(versionOf: (home: string, harness: HarnessId) => string | null = harnessVersionOf): HarnessVersionOf {
  return (home, harness) => {
    if (!isHarnessId(harness)) return null;
    try {
      const version: unknown = versionOf(home, harness);
      return typeof version === 'string' && version.length > 0 && version.length <= 64 ? version : null;
    } catch {
      return null;
    }
  };
}

/**
 * C's decision subscriber rebuilt with the host harness-version source, replacing the default
 * instance of the same name that the package exports without one.
 */
export function withHarnessVersions(provider: unknown, versionOf: HarnessVersionOf | undefined): unknown {
  if (versionOf === undefined || provider === null || typeof provider !== 'object') return provider;
  const create = Reflect.get(provider, 'createDecisionSubscriber');
  const handlers = Reflect.get(provider, 'DEFAULT_TRIGGER_HANDLERS');
  const defaults = Reflect.get(provider, 'sidecarEventSubscribers');
  if (typeof create !== 'function' || !Array.isArray(defaults)) return provider;
  let rebuilt: unknown;
  try {
    rebuilt = Reflect.apply(create, undefined, [{ ...(handlers !== undefined ? { handlers } : {}), harnessVersionOf: versionOf }]);
  } catch {
    return provider;
  }
  if (!isSubscriber(rebuilt)) return provider;
  const name = rebuilt.name;
  const subscribers = defaults.map((sub: unknown) => (isSubscriber(sub) && sub.name === name ? rebuilt : sub));
  return { sidecarOps: Reflect.get(provider, 'sidecarOps'), sidecarEventSubscribers: subscribers };
}

/**
 * The decision package's `explain` op with the slice's Sonnet-first view added to the trace when the
 * request names a slice: the ledger is the orchestrator's, so the composition lives here, where both
 * packages are known. The setting is the effective `routing.firstTry` for the request's workspace.
 */
export function withFirstTryTrace(provider: unknown): unknown {
  if (provider === null || typeof provider !== 'object') return provider;
  const ops = Reflect.get(provider, 'sidecarOps');
  if (!Array.isArray(ops)) return provider;
  const setting = (ctx: SidecarOpContext): 'auto' | 'baseline' => {
    try {
      return firstTryOf(readEffectiveConfig({ home: ctx.home, workspaceRoot: ctx.workspace.root }).config);
    } catch {
      return 'auto';
    }
  };
  const wrapped = ops.map((op: unknown) => (isDefinition(op) && op.op === 'explain' ? withFirstTryExplain(op, setting) : op));
  return { sidecarOps: wrapped, sidecarEventSubscribers: Reflect.get(provider, 'sidecarEventSubscribers') };
}

/** Literal imports, one per op package, so a bundler keeps each (PKG-07). */
export async function packageSources(): Promise<readonly OpSource[]> {
  const versionOf = harnessVersionSource();
  const found = await Promise.all([
    tryImport('@jevris/core', () => import('@jevris/core')),
    tryImport('@jevris/provider-typesafe', async () => withFirstTryTrace(withHarnessVersions(await import('@jevris/provider-typesafe'), versionOf))),
    tryImport('@jevris/orchestrator', () => import('@jevris/orchestrator')),
    tryImport('@jevris/evals', () => import('@jevris/evals')),
    tryImport('@jevris/languages', () => import('@jevris/languages')),
  ]);
  const sources = found.filter((source): source is OpSource => source !== undefined);
  // GOV-12, GOV-13: the sidecar's own `security` subscriber, built on C's rules in @jevris/core
  // (which exports no ops of its own, so it is not among the sources above).
  const security = await tryImport('@jevris/sidecar', async () => {
    const { createSecuritySubscriber } = await import('./security-subscriber.js');
    return { sidecarEventSubscribers: [createSecuritySubscriber()] };
  });
  if (security !== undefined) sources.push(security);
  return sources;
}

export interface LoadOpsInput {
  readonly packages?: boolean;
  readonly extraOps?: readonly SidecarOpDefinition[];
  readonly extraSubscribers?: readonly SidecarEventSubscriber[];
  /** Injected package sources (tests). */
  readonly sources?: readonly OpSource[];
}

/** Merges op sources; throws DuplicateOpError on any name claimed twice or a built-in name. */
export async function loadOps(input: LoadOpsInput = {}): Promise<LoadedOps> {
  const sources: OpSource[] = [];
  if (input.sources !== undefined) sources.push(...input.sources);
  else if (input.packages !== false) sources.push(...(await packageSources()));
  if (input.extraOps !== undefined || input.extraSubscribers !== undefined) {
    sources.push({ name: 'extra', ops: input.extraOps ?? [], subscribers: input.extraSubscribers ?? [] });
  }
  const owners = new Map<string, string>();
  for (const name of BUILTIN_OP_NAMES) owners.set(name, BUILTIN_SOURCE);
  const ops = new Map<string, SidecarOpDefinition>();
  const subscribers: (SidecarEventSubscriber & { readonly source: string })[] = [];
  for (const source of sources) {
    for (const definition of source.ops) {
      const first = owners.get(definition.op);
      if (first !== undefined) throw new DuplicateOpError(definition.op, first, source.name);
      owners.set(definition.op, source.name);
      ops.set(definition.op, definition);
    }
    for (const subscriber of source.subscribers) subscribers.push({ name: subscriber.name, source: source.name, handle: (ctx) => subscriber.handle(ctx) });
  }
  return { ops, owners, subscribers, sources: sources.map((source) => source.name) };
}

/**
 * The daemon's answer to a `shutdown` frame, decided in the step that accepts it: refused while
 * `runs` verification runs are under way (unless the frame forces it), else accepted.
 */
export type ShutdownDecision = { readonly accepted: true } | { readonly accepted: false; readonly runs: number };

export function ok(body: unknown): SidecarOpOutcome {
  return { ok: true, body };
}

export function refuse(reasonCode: string, message?: string): SidecarOpOutcome {
  return message === undefined ? { ok: false, reasonCode } : { ok: false, reasonCode, message };
}

export function bodyRecord(context: SidecarOpContext): Record<string, unknown> {
  const body = context.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return {};
  return body as Record<string, unknown>;
}

/**
 * Parsing for the route inputs the `route` op and the model-switch hook share: the remaining
 * work, the context the task needs and the running session's switch facts.
 */
import { DEFAULT_SWITCH_POLICY, taskVolume, type SliceTaskHints, type SwitchContext, type TokenVolume } from '@jevris/core';

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(body).every((key) => allowed.includes(key));
}

export const ROUTE_KEYS = ['currentModel', 'modelPin', 'effortPin', 'taskId', 'sliceId', 'sessionId', 'remaining', 'contextTokens', 'session', 'harness', 'authMode', 'task'];
const TASK_KEYS = ['title', 'paths', 'checkIds'];
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SESSION_KEYS = ['warmPrefixTokens', 'cacheWarm', 'atBoundary', 'unitsSinceLastSwitch', 'switchesThisTask', 'cacheTtl', 'authMode'];

export function count(value: unknown, max: number): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : undefined;
}

/**
 * `session: { warmPrefixTokens, cacheWarm?, atBoundary?, unitsSinceLastSwitch?, switchesThisTask?, cacheTtl? }`:
 * only `warmPrefixTokens` is required. The defaults (a warm cache, at a boundary, past the dwell,
 * no switch yet) are the ones a person asking `jevris route` between tasks is in. `cacheTtl` is
 * `5m` (the default) or `1h` (a Claude Code subscription main conversation writes the 1-hour
 * cache, so a switch there costs the 1-hour write). `authMode` is `api-key`, `subscription` or
 * `unknown` (the default): it labels the transition cost as billed dollars or as an
 * API-equivalent estimate.
 */
export function switchContextOf(value: unknown): SwitchContext | null | undefined {
  if (value === undefined || value === null) return null;
  if (!plain(value) || !onlyKeys(value, SESSION_KEYS)) return undefined;
  const warm = count(value['warmPrefixTokens'], 10_000_000);
  const flag = (key: string, fallback: boolean): boolean | undefined => (value[key] === undefined ? fallback : typeof value[key] === 'boolean' ? (value[key] as boolean) : undefined);
  const cacheWarm = flag('cacheWarm', true);
  const atBoundary = flag('atBoundary', true);
  const units = value['unitsSinceLastSwitch'] === undefined ? DEFAULT_SWITCH_POLICY.dwellUnits : count(value['unitsSinceLastSwitch'], 1_000_000);
  const switches = value['switchesThisTask'] === undefined ? 0 : count(value['switchesThisTask'], 1_000);
  const ttl = value['cacheTtl'];
  if (ttl !== undefined && ttl !== '5m' && ttl !== '1h') return undefined;
  const auth = value['authMode'];
  if (auth !== undefined && auth !== 'api-key' && auth !== 'subscription' && auth !== 'unknown') return undefined;
  if (warm === undefined || cacheWarm === undefined || atBoundary === undefined || units === undefined || switches === undefined) return undefined;
  return { warmPrefixTokens: warm, cacheWarm, atBoundary, unitsSinceLastSwitch: units, switchesThisTask: switches, ...(ttl === undefined ? {} : { cacheTtl: ttl }), ...(auth === undefined ? {} : { authMode: auth }) };
}


export interface RouteFacts {
  readonly remaining: TokenVolume | null;
  readonly contextTokens: number | null;
  readonly switchContext: SwitchContext | null;
}

/** `remaining`, `contextTokens` and `session` from a body; undefined when any is malformed. */
export function routeFactsOf(body: Record<string, unknown>): RouteFacts | undefined {
  const rawRemaining = body['remaining'];
  const remaining = rawRemaining === undefined || rawRemaining === null ? null : taskVolume(rawRemaining);
  if (remaining === null && rawRemaining !== undefined && rawRemaining !== null) return undefined;
  const rawContext = body['contextTokens'];
  const contextTokens = rawContext === undefined || rawContext === null ? null : count(rawContext, 10_000_000);
  if (contextTokens === undefined) return undefined;
  const switchContext = switchContextOf(body['session']);
  if (switchContext === undefined) return undefined;
  return { remaining, contextTokens, switchContext };
}

function stringList(value: unknown, maxItems: number, accept: (item: string) => boolean): string[] | null | undefined {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > maxItems) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !accept(item)) return undefined;
    out.push(item);
  }
  return out;
}

/**
 * `task: { title?, paths?, checkIds? }`: what the caller knows about the task, for the slice
 * classifier when no `sliceId` is given. Bounds only; undefined when malformed, null when absent.
 * The classifier reduces it to features before anything leaves the machine.
 */
export function taskHintsOf(value: unknown): SliceTaskHints | null | undefined {
  if (value === undefined || value === null) return null;
  if (!plain(value) || !onlyKeys(value, TASK_KEYS)) return undefined;
  const rawTitle = value['title'];
  if (rawTitle !== undefined && rawTitle !== null && (typeof rawTitle !== 'string' || rawTitle.length > 2000)) return undefined;
  const paths = stringList(value['paths'], 64, (p) => p.length > 0 && p.length <= 512 && !p.includes('\0'));
  const checkIds = stringList(value['checkIds'], 64, (c) => TASK_ID.test(c));
  if (paths === undefined || checkIds === undefined) return undefined;
  return { title: typeof rawTitle === 'string' ? rawTitle : null, paths, checkIds };
}

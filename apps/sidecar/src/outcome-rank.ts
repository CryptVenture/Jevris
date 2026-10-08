/**
 * Which subscribers' proposals the hook launcher renders from one `event` answer.
 *
 * Every subscriber answers `{ hookOutcome, certified }` on its own, and the launcher (`chooseOutcome`
 * in `apps/hook/src/launcher.ts`) renders the strongest of them: route over context over explain over
 * observe, a `context` or `route` only when its subscriber marks it certified, a tie to the first
 * subscriber by name, except that when the strongest is an `explain` the explains of every subscriber
 * are shown together. A subscriber whose answer takes something off a queue when it is shown (a
 * waiting advice line) must not take it when the launcher drops its answer for a stronger one, so the
 * sidecar asks here, after every subscriber has answered. This reads a proposal exactly as the launcher
 * does (the same checks on the outcome, the same ranking), and a test keeps the two in step.
 */
import { HookOutcomeContract, type HookOutcome } from '@jevris/contracts';

const RANK: Readonly<Record<HookOutcome['kind'], number>> = { observe: 0, explain: 1, context: 2, route: 3 };

function isPlain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

/** One subscriber's proposal as the launcher reads it (`outcomeOf`), or null when it proposes nothing usable. */
function proposalOf(value: unknown): { readonly kind: HookOutcome['kind']; readonly certified: boolean } | null {
  if (!isPlain(value)) return null;
  const proposed = own(value, 'hookOutcome');
  if (!isPlain(proposed)) return null;
  const certified = own(value, 'certified') === true;
  const kind = own(proposed, 'kind');
  if (kind === 'observe') return { kind, certified };
  if (kind === 'context' || kind === 'explain') {
    const text = own(proposed, 'text');
    return typeof text === 'string' && text.trim().length > 0 ? { kind, certified } : null;
  }
  if (kind === 'route') {
    const variant = own(proposed, 'variant');
    const note = own(proposed, 'context');
    const checked = HookOutcomeContract.validate({ kind, model: own(proposed, 'model'), ...(variant === undefined ? {} : { variant }), ...(note === undefined ? {} : { context: note }) });
    return checked.ok && checked.value.kind === 'route' ? { kind, certified } : null;
  }
  return null;
}

/**
 * The names of the subscribers whose proposal the launcher renders from these `event` results: the
 * one subscriber whose certified context or route is the strongest, or every subscriber with an
 * explain when no certified context or route outranks them. Empty when nothing is rendered.
 */
export function renderedSubscribers(results: Readonly<Record<string, unknown>>): ReadonlySet<string> {
  let best: HookOutcome['kind'] = 'observe';
  let winner: string | null = null;
  const explains: string[] = [];
  for (const name of Object.keys(results).sort()) {
    const proposal = proposalOf(results[name]);
    if (proposal === null) continue;
    if ((proposal.kind === 'context' || proposal.kind === 'route') && !proposal.certified) continue;
    if (proposal.kind === 'explain') explains.push(name);
    if (RANK[proposal.kind] > RANK[best]) {
      best = proposal.kind;
      winner = name;
    }
  }
  if (best === 'explain') return new Set(explains);
  return winner === null ? new Set() : new Set([winner]);
}

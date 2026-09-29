/**
 * Doctor's `hostTariffs` line (serving hosts R56, design 8): what the model registry routing reads
 * says about the serving hosts' own prices. A route through a host is priced at the host's tariff
 * only where the registry records one; a free-tier or unknown serving gives advice only (C's
 * HOST_TARIFF_UNKNOWN), so the counts say how much of the offer can be routed.
 */
import type { Serving } from '@jevris/contracts';

type Sources = Readonly<Record<string, { readonly fetchedOn: string }>>;

/** One line: counts per basis and host, and the sources with the day each was read. */
export function hostTariffsDoctorLine(servings: readonly Serving[] | undefined, sources: Sources): string {
  if (servings === undefined || servings.length === 0) return 'hostTariffs: none in the model registry routing reads, so a route through a serving host gives advice only';
  const perHost = new Map<string, number>();
  const basis = { host: 0, 'free-tier': 0, unknown: 0 };
  const ids = new Set<string>();
  for (const s of servings) {
    perHost.set(s.host, (perHost.get(s.host) ?? 0) + 1);
    basis[s.tariffBasis] += 1;
    for (const id of s.sourceIds) ids.add(id);
  }
  const hosts = [...perHost].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([host, n]) => `${host} ${String(n)}`);
  const from = [...ids].sort().map((id) => {
    const read = Object.hasOwn(sources, id) ? sources[id]?.fetchedOn : undefined;
    return read === undefined ? id : `${id} (${read.slice(0, 10)})`;
  });
  const advice = basis['free-tier'] + basis.unknown > 0 ? ' (routes through a free-tier or unknown tariff give advice only)' : '';
  const count = (n: number, word: string): string => `${String(n)} ${word}${n === 1 ? '' : 's'}`;
  return `hostTariffs: ${count(servings.length, 'serving')} on ${count(perHost.size, 'host')} (${hosts.join(', ')}): ${String(basis.host)} at the host's tariff, ${String(basis['free-tier'])} free-tier, ${String(basis.unknown)} unknown${advice}; from ${from.join(', ')}`;
}

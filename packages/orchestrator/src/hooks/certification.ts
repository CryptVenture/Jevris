/**
 * Certification gate for hook outcomes that change what the model sees (§15.4, HCF-02).
 *
 * A `context` outcome (for example a capsule restored after compaction) renders only when a
 * signed certification record covers this harness, its installed version, this OS, now, and
 * the feature. The records come from F's loader (`@jevris/cli/certifications`), loaded
 * dynamically so the orchestrator has no build-time dependency on the CLI. The installed
 * harness version comes from the host ledger, where `jevris doctor` or the installer records
 * it (`recordHarnessVersion`); an unknown version is never certified.
 *
 * The sidecar or a test may replace the gate with `setCertificationGate`. The default without
 * records, or on any error, is uncertified.
 */
import { certificationCovers, type CertificationRecord, type HarnessId } from '@jevris/contracts';
import { jevrisPaths } from '@jevris/platform';
import { join } from 'node:path';
import { openLedger } from '../ledger.js';

/** The feature a certified adapter needs before Jevris adds model-visible context. */
export const CONTEXT_FEATURE = 'hooks.context';

export interface CertificationQuery {
  readonly home: string;
  readonly harness: HarnessId;
  readonly featureId: string;
  readonly nowMs: number;
  /** A version the harness payload itself supplied (forwarded by the launcher), when any. */
  readonly harnessVersion?: string | null;
}

export interface CertificationAnswer {
  readonly certified: boolean;
  readonly reasonCode: string | null;
}

export type CertificationGate = (query: CertificationQuery) => Promise<CertificationAnswer>;

/** The certification record's OS id is the Node platform name (darwin, linux, win32). */
export function operatingSystemOf(platform: string): string {
  return platform;
}

function hostLedger(home: string) {
  return openLedger(join(jevrisPaths({ home }).data, 'orchestration', 'host'));
}

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** Records the installed harness version (called by doctor or install after a probe). */
export async function recordHarnessVersion(home: string, harness: HarnessId, version: string, nowMs = Date.now()): Promise<void> {
  if (!SEMVER.test(version)) return;
  await hostLedger(home).transact((tx) => tx.put('harness-versions', harness, { version, probedAtMs: nowMs }));
}

export function harnessVersionOf(home: string, harness: HarnessId): string | null {
  const row = hostLedger(home).get<{ readonly version: string }>('harness-versions', harness);
  return row?.version ?? null;
}

type Loader = (home: string) => Promise<readonly CertificationRecord[]>;

/** Records through F's loader: contract- and signature-checked. Null when it is not installed. */
async function loadWithCliLoader(home: string): Promise<readonly CertificationRecord[] | null> {
  try {
    const mod = (await import('@jevris/cli/certifications')) as unknown as {
      loadCertifications?: (home: string) => Promise<{ readonly records: readonly { readonly record: CertificationRecord }[] }>;
    };
    if (typeof mod.loadCertifications !== 'function') return null;
    const load = await mod.loadCertifications(home);
    return load.records.map((r) => r.record);
  } catch {
    return null;
  }
}

/** A gate over a record loader and a version source, using `certificationCovers`. */
export function certificationGateFrom(
  load: Loader,
  versionOf: (home: string, harness: HarnessId) => string | null = harnessVersionOf,
  platform: string = process.platform,
): CertificationGate {
  return async (q) => {
    const version = q.harnessVersion !== undefined && q.harnessVersion !== null && SEMVER.test(q.harnessVersion) ? q.harnessVersion : versionOf(q.home, q.harness);
    if (version === null) return { certified: false, reasonCode: 'HARNESS_VERSION_UNKNOWN' };
    let records: readonly CertificationRecord[];
    try {
      records = await load(q.home);
    } catch {
      return { certified: false, reasonCode: 'CERTIFICATIONS_UNAVAILABLE' };
    }
    let reason = 'NO_RECORD';
    for (const record of records) {
      const check = certificationCovers(record, { harness: q.harness, harnessVersion: version, operatingSystem: operatingSystemOf(platform), nowMs: q.nowMs, featureId: q.featureId });
      if (check.ok) return { certified: true, reasonCode: null };
      if (record.harness === q.harness) reason = check.reasonCode;
    }
    return { certified: false, reasonCode: reason };
  };
}

const defaultGate: CertificationGate = certificationGateFrom(async (home) => (await loadWithCliLoader(home)) ?? []);

let gate: CertificationGate = defaultGate;

export function setCertificationGate(next: CertificationGate | null): void {
  gate = next ?? defaultGate;
}

export async function isCertified(query: CertificationQuery): Promise<CertificationAnswer> {
  try {
    return await gate(query);
  } catch {
    return { certified: false, reasonCode: 'GATE_FAILED' };
  }
}

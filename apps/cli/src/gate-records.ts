/**
 * `jevris gates`: loads release evidence and judges the chapter 22 gates (RLS-01, RLS-12).
 *
 *   jevris gates [--evidence <dir>] [--home <dir>] [--commit <sha>] [--json] [--out <dir>]
 *
 * Evidence defaults to `<data>/evidence` (per-OS data directory). Every `*.json` file below it
 * is parsed and validated as a ReleaseEvidence record; invalid files are listed as rejected with a
 * reason code and never count. Trusted signer keys and the advertised support matrix ship with
 * the package (`assets/trust/release-keys.json`, `assets/support-matrix.json`). Nothing here reads
 * `fixtures/` or `ssot_docs/`.
 *
 * Exit codes (COMMAND_EXIT_CODES): 0 every gate passes, 1 not a release pass, 2 usage error.
 */
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeConfinedOutput } from './host-policy.js';
import { parseArgs } from 'node:util';
import { COMMAND_EXIT_CODES, ReleaseEvidenceContract } from '@jevris/contracts';
import { jevrisPaths, packageRoot } from '@jevris/platform';
import { BUNDLED_MODEL_REGISTRY, shippedModelReferences } from '@jevris/core';
import type { ModelRegistry } from '@jevris/contracts';
import {
  BUNDLED_BASELINE_PATH,
  ROUTED_FEATURES,
  WORKER_ROUTE_FEATURE,
  evaluateGates,
  formatGatesReport,
  type GatesReport,
  type KeyRole,
  type LoadedEvidence,
  type ModelLifecycleFact,
  type SupportMatrixEntry,
  type TrustedKey,
} from './release-gates.js';

export {
  BUNDLED_BASELINE_PATH,
  GATES,
  MODEL_REFRESH_POINTER,
  MODEL_RETIREMENT_WINDOW_DAYS,
  describeRetiring,
  inconsistentModels,
  retiredAt,
  staleAt,
  retiringModels,
  type ModelLifecycleFact,
  type RetiringModel,
  RUNTIME_GATE_TESTS,
  KIND_POLICY,
  SIDECAR_LOAD_REFERENCE,
  SIDECAR_LOAD_TARGETS,
  describeLoadMachine,
  judgeSidecarLoad,
  type LoadMachine,
  type SidecarLoadTarget,
  type SidecarLoadVerdict,
  ROUTED_FEATURES,
  STORY_IDS,
  WORKER_ROUTE_FEATURE,
  WORKFLOW_IDS,
  evaluateGates,
  exclusionReason,
  formatGatesReport,
  type GateContext,
  type GateResult,
  type GatesReport,
  type LoadedEvidence,
  type PredicateResult,
  type RuntimeGateTest,
  type SupportMatrixEntry,
  type TrustedKey,
} from './release-gates.js';

export const EVIDENCE_FILE_BYTES = 4 * 1024 * 1024;
export const EVIDENCE_MAX_FILES = 5000;
const MAX_DEPTH = 6;

export const GATES_USAGE = [
  'Usage: jevris gates [--evidence <dir>] [--home <dir>] [--commit <sha>] [--json] [--out <dir>]',
  '',
  'Judges the chapter 22 release gates (api, harness, security, quality, economics, operations,',
  'portability) and the perf gate (the sidecar load targets on the reference machine), and the',
  'story and workflow acceptance suites from evidence records.',
  'Exit 0: every gate passes. Exit 1: not a release pass. Exit 2: usage error.',
  '',
].join('\n');

export interface Rejected {
  readonly file: string;
  readonly reasonCode: string;
}

export interface LoadResult {
  readonly accepted: readonly LoadedEvidence[];
  readonly rejected: readonly Rejected[];
}

/** Loads every `*.json` below `dir` as release evidence. A missing directory is empty. */
export async function loadEvidence(dir: string): Promise<LoadResult> {
  const accepted: LoadedEvidence[] = [];
  const rejected: Rejected[] = [];
  const files: string[] = [];
  const walk = async (current: string, rel: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || files.length >= EVIDENCE_MAX_FILES) return;
    let names: readonly string[];
    try {
      names = await readdir(current);
    } catch {
      return;
    }
    for (const name of [...names].sort()) {
      const full = join(current, name);
      const relName = rel.length === 0 ? name : `${rel}/${name}`; // path-hygiene: allow portable report id, never opened
      let st;
      try {
        st = await lstat(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        if (name.endsWith('.json')) rejected.push({ file: relName, reasonCode: 'SYMLINK' });
        continue;
      }
      if (st.isDirectory()) await walk(full, relName, depth + 1);
      else if (name.endsWith('.json')) {
        if (st.size > EVIDENCE_FILE_BYTES) rejected.push({ file: relName, reasonCode: 'OVERSIZE' });
        else files.push(relName);
      }
      if (files.length >= EVIDENCE_MAX_FILES) return;
    }
  };
  await walk(dir, '', 0);
  for (const rel of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(dir, ...rel.split('/')), 'utf8'));
    } catch {
      rejected.push({ file: rel, reasonCode: 'NOT_JSON' });
      continue;
    }
    const checked = ReleaseEvidenceContract.validate(parsed);
    if (!checked.ok) {
      const first = checked.issues[0];
      rejected.push({ file: rel, reasonCode: first === undefined ? 'INVALID' : `INVALID_${first.code.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}` });
      continue;
    }
    accepted.push({ file: rel, record: checked.value });
  }
  return { accepted, rejected };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

const ROLES: readonly KeyRole[] = ['owner', 'security-reviewer', 'certification', 'calibration'];

/** The shipped signer keys. A malformed entry is skipped, never trusted. */
export async function loadTrust(path: string): Promise<readonly TrustedKey[]> {
  try {
    const parsed = (await readJson(path)) as { readonly keys?: unknown };
    if (!Array.isArray(parsed.keys)) return [];
    return parsed.keys.flatMap((key: unknown) => {
      const k = key as Partial<TrustedKey>;
      if (typeof k.keyId !== 'string' || typeof k.publicKeyPem !== 'string' || !ROLES.includes(k.role as KeyRole)) return [];
      return [{ keyId: k.keyId, role: k.role as KeyRole, publicKeyPem: k.publicKeyPem }];
    });
  } catch {
    return [];
  }
}

/**
 * The advertised harness and OS combinations. With `root` (the package), each entry also says
 * whether the harness is advertised with owned-worker routing: its `plugins/<harness>/harness.json`
 * lists `worker.route` in `features`.
 */
export async function loadMatrix(path: string, root?: string): Promise<readonly SupportMatrixEntry[]> {
  let entries: SupportMatrixEntry[] = [];
  try {
    const parsed = (await readJson(path)) as { readonly advertised?: unknown };
    if (!Array.isArray(parsed.advertised)) return [];
    entries = parsed.advertised.flatMap((entry: unknown) => {
      const e = entry as Partial<SupportMatrixEntry>;
      if (typeof e.harness !== 'string' || !Array.isArray(e.os)) return [];
      return [{ harness: e.harness, os: e.os.filter((os): os is string => typeof os === 'string') }];
    });
  } catch {
    return [];
  }
  if (root === undefined) return entries;
  const out: SupportMatrixEntry[] = [];
  for (const entry of entries) out.push({ ...entry, routing: await advertisesRouting(root, entry.harness) });
  return out;
}

async function advertisesRouting(root: string, harness: string): Promise<boolean> {
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(harness)) return false;
  try {
    const manifest = (await readJson(join(root, 'plugins', harness, 'harness.json'))) as { readonly features?: unknown };
    return Array.isArray(manifest.features) && manifest.features.includes(WORKER_ROUTE_FEATURE);
  } catch {
    return false;
  }
}

/** The package's shipped day-1 baseline, parsed; null when it ships none or it does not parse. */
export async function loadBundledBaseline(root: string): Promise<unknown> {
  try {
    return await readJson(join(root, ...BUNDLED_BASELINE_PATH.split('/')));
  } catch {
    return null;
  }
}

/**
 * The lifecycle facts of every model in a registry, and whether shipped data names it. The
 * references are core's own list (shippedModelReferences: the registry's baseline model and every
 * bundled public prior), so a reference core adds reaches the gate without a change here. The
 * release gate and registry:check compare the facts with the release time.
 */
export function modelLifecycleFacts(registry: ModelRegistry = BUNDLED_MODEL_REGISTRY, referencedIds: readonly string[] = shippedModelReferences(registry).map((ref) => ref.modelId)): readonly ModelLifecycleFact[] {
  const named = new Set([registry.baselineModelId, ...referencedIds]);
  return registry.entries.map((model) => ({
    modelId: model.modelId,
    displayName: model.displayName ?? model.modelId,
    status: model.lifecycle?.status ?? null,
    notBefore: model.lifecycle?.retirementNotBefore ?? null,
    retiresOn: model.lifecycle?.retiresOn ?? null,
    referenced: named.has(model.modelId),
  }));
}

/** Pack ids shipped under `<package>/packs/<dir>/pack.json`. */
export async function loadPackIds(root: string): Promise<readonly string[]> {
  const ids: string[] = [];
  let names: readonly string[] = [];
  try {
    names = await readdir(join(root, 'packs'));
  } catch {
    return [];
  }
  for (const name of [...names].sort()) {
    try {
      const pack = (await readJson(join(root, 'packs', name, 'pack.json'))) as { readonly id?: unknown };
      ids.push(typeof pack.id === 'string' ? pack.id : name);
    } catch {
      // Not a pack directory.
    }
  }
  return ids;
}

export interface GatesCommandDeps {
  readonly nowMs?: number;
  readonly env?: { readonly [key: string]: string | undefined };
  /** The package root holding package.json, assets/ and packs/. */
  readonly root?: string;
  /** Overrides the shipped trust file (tests only; the CLI has no flag for it). */
  readonly trust?: readonly TrustedKey[];
  /** Overrides the package's shipped baseline (tests only; the CLI reads it from the package root). */
  readonly bundledBaseline?: unknown;
  /** Overrides the bundled model registry's lifecycle facts (tests only). */
  readonly models?: readonly ModelLifecycleFact[];
  /** Where a refusal is written. Default stderr. */
  readonly err?: (text: string) => void;
  /** The working directory --out is resolved against. Default process.cwd(). */
  readonly cwd?: string;
}

export async function runGatesCommand(
  argv: readonly string[],
  write: ((text: string) => void) | undefined,
  deps: GatesCommandDeps = {},
): Promise<number> {
  const out = write ?? ((text: string) => void process.stdout.write(text));
  let values: { readonly [key: string]: string | boolean | undefined };
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        evidence: { type: 'string' },
        home: { type: 'string' },
        commit: { type: 'string' },
        json: { type: 'boolean' },
        out: { type: 'string' },
        help: { type: 'boolean' },
      },
    });
    values = parsed.values;
  } catch {
    out(GATES_USAGE);
    return COMMAND_EXIT_CODES.usage;
  }
  if (values['help'] === true) {
    out(GATES_USAGE);
    return COMMAND_EXIT_CODES.ok;
  }
  const commit = values['commit'];
  if (commit !== undefined && (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit))) {
    out('gates: --commit takes a full 40-character lowercase git SHA.\n');
    return COMMAND_EXIT_CODES.usage;
  }
  for (const flag of ['evidence', 'home', 'out']) {
    const value = values[flag];
    if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
      out(`gates: --${flag} needs a directory.\n`);
      return COMMAND_EXIT_CODES.usage;
    }
  }
  const env = deps.env ?? process.env;
  const root = deps.root ?? packageRoot();
  const home = typeof values['home'] === 'string' ? values['home'] : undefined;
  const paths = jevrisPaths({ ...(home === undefined ? {} : { home }), env });
  const evidenceDir = typeof values['evidence'] === 'string' ? values['evidence'] : join(paths.data, 'evidence');
  const pkg = (await readJson(join(root, 'package.json'))) as { readonly version?: unknown };
  const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  const loaded = await loadEvidence(evidenceDir);
  const nowMs = deps.nowMs ?? Date.now();
  const report: GatesReport = evaluateGates(
    {
      version,
      commit: typeof commit === 'string' ? commit : null,
      nowMs,
      evidence: loaded.accepted,
      trust: deps.trust ?? (await loadTrust(join(root, 'assets', 'trust', 'release-keys.json'))),
      matrix: await loadMatrix(join(root, 'assets', 'support-matrix.json'), root),
      packs: await loadPackIds(root),
      bundledBaseline: deps.bundledBaseline !== undefined ? deps.bundledBaseline : await loadBundledBaseline(root),
      models: deps.models ?? modelLifecycleFacts(),
    },
    loaded.rejected,
  );
  const text = formatGatesReport(report);
  const outDir = values['out'];
  if (typeof outDir === 'string') {
    // GOV-11: a user-named output path is confined (approved roots, never a Jevris private
    // directory, .git, .ssh or .gnupg, no symlink below the root) and written owner-only.
    const err = deps.err ?? ((line: string) => void process.stderr.write(line));
    const options = { ...(home === undefined ? {} : { jevrisHome: home }), env, ...(deps.cwd === undefined ? {} : { cwd: deps.cwd }) };
    for (const [name, data] of [
      ['gates-report.json', `${JSON.stringify(report, null, 2)}\n`],
      ['gates-report.txt', text],
    ] as const) {
      const written = await writeConfinedOutput(join(outDir, name), data, options);
      if (!written.ok) {
        err(`gates: --out refused (${written.reasonCode}): ${join(outDir, name)}\n`);
        return COMMAND_EXIT_CODES.usage;
      }
    }
  }
  out(values['json'] === true ? `${JSON.stringify(report, null, 2)}\n` : text);
  return report.verdict === 'pass' ? COMMAND_EXIT_CODES.ok : COMMAND_EXIT_CODES.negative;
}

/**
 * The extended pack manifest (PAK-01, PAK-03, PAK-06, PAK-08; SSOT §11.1, §11.4).
 *
 * It is a superset of the SSOT v1 handoff subset (`ssot_docs/schemas/pack-manifest.schema.json`,
 * the contracts' PackManifest): every SSOT field keeps its meaning, and the extension fields are
 * optional, so the SSOT `routing.pack.json` example loads unchanged. The extensions declare what
 * the pack may touch (supported adapters, required toolchains, settings, effects, storage,
 * network destinations, tool access and executables), its declarative behavior (decision specs,
 * evidence selectors drawn from an approved builder allowlist, and policy rules that map an
 * outcome to one declared action), its calibration bindings, and its provenance (the publisher,
 * a file list pinned by sha256 and an Ed25519 signature over the manifest).
 *
 * Declarative is the default: a pack without `executables` runs no code of its own, imports
 * nothing and has no filesystem or network access. It selects approved evidence builders and
 * declared actions only.
 */
import {
  ACTION_KINDS,
  HARNESS_IDS,
  HASH_PATTERN,
  ID_PATTERN,
  MODEL_ID_PATTERN,
  MODES,
  PACK_DATA_SCOPES,
  contentHash,
  defineContract,
  schema as S,
  type ActionKind,
  type ContentHash,
} from '@jevris/contracts';

/** Evidence builders a declarative pack may select (PAK-01), with the data scope each reads. */
export const PACK_EVIDENCE_BUILDERS = {
  'task-objective': 'task-metadata',
  'task-profile': 'task-metadata',
  'diff-inventory': 'task-metadata',
  'capsule-items': 'task-metadata',
  'source-spans': 'approved-source-spans',
  diagnostics: 'approved-tool-output',
  'tool-output-digest': 'approved-tool-output',
  'verification-receipts': 'verification-receipts',
  'policy-summary': 'policy-metadata',
} as const satisfies Readonly<Record<string, (typeof PACK_DATA_SCOPES)[number]>>;
export type PackEvidenceBuilder = keyof typeof PACK_EVIDENCE_BUILDERS;
const BUILDER_NAMES = Object.keys(PACK_EVIDENCE_BUILDERS) as PackEvidenceBuilder[];

/** Effects a pack may declare. Each new one is a privilege delta (PAK-02). */
export const PACK_EFFECTS = ['read-workspace', 'write-workspace', 'run-command', 'start-worker', 'write-pack-data'] as const;

const Entry = S.string({ minLength: 1, maxLength: 256 });
const EntryList = S.array(Entry, { maxItems: 256, uniqueItems: true });
const Name = S.string({ pattern: '^[a-z][a-z0-9._-]{0,63}$' });
const SpecId = S.string({ pattern: ID_PATTERN });
const Version = S.string({ pattern: '^\\d{1,9}\\.\\d{1,9}\\.\\d{1,9}$' });
/** A relative path inside the pack: forward slashes, no empty, `.` or `..` segment, no hidden name. */
const RelPath = S.string({ pattern: '^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}(?:/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}){0,7}$', maxLength: 512 });
const Sha256Hex = S.string({ pattern: '^[0-9a-f]{64}$' });
const Host = S.string({ pattern: '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?){1,8}$', maxLength: 253 });

export const PackManifestSchema = S.object(
  {
    schemaVersion: S.literal('1.0'),
    id: S.string({ pattern: '^jevris\\.[a-z][a-z0-9.-]+$', maxLength: 128 }),
    version: Version,
    maturity: S.enumOf(['experimental', 'canary', 'stable']),
    description: S.string({ minLength: 1, maxLength: 1000 }),
    requiresCapabilities: EntryList,
    fallbackCapabilities: EntryList,
    decisionSpecs: EntryList,
    actions: S.array(S.enumOf(ACTION_KINDS), { maxItems: 256, uniqueItems: true }),
    dataScopes: S.array(S.enumOf(PACK_DATA_SCOPES), { maxItems: 256, uniqueItems: true }),
    defaultMode: S.enumOf(MODES),
    conflicts: EntryList,
    fixtures: EntryList,
  },
  {
    adapters: S.array(S.enumOf(HARNESS_IDS), { maxItems: HARNESS_IDS.length, uniqueItems: true }),
    toolchains: S.array(S.object({ id: Name }, { versionRange: S.string({ pattern: '^[0-9A-Za-z .<>=~^*|-]{1,64}$' }) }), { maxItems: 64 }),
    settings: S.array(
      S.object(
        { key: Name, type: S.enumOf(['boolean', 'integer', 'string', 'enum']), default: S.custom<string | number | boolean>({ anyOf: [{ type: 'string', maxLength: 256 }, { type: 'number' }, { type: 'boolean' }] }) },
        { values: S.array(S.string({ minLength: 1, maxLength: 64 }), { minItems: 1, maxItems: 64, uniqueItems: true }), minimum: S.number(), maximum: S.number(), description: S.string({ maxLength: 500 }) },
      ),
      { maxItems: 128 },
    ),
    effects: S.array(S.enumOf(PACK_EFFECTS), { maxItems: PACK_EFFECTS.length, uniqueItems: true }),
    storage: S.object(
      { retentionDays: S.integer({ minimum: 0, maximum: 3650 }) },
      { migrations: S.array(S.object({ id: Name, fromVersion: Version, toVersion: Version, reversible: S.boolean() }), { maxItems: 64 }) },
    ),
    network: S.array(S.object({ host: Host, purpose: S.string({ minLength: 1, maxLength: 200 }) }), { maxItems: 64 }),
    tools: S.array(S.string({ pattern: '^(?:mcp|native):[A-Za-z0-9_.*-]{1,128}$' }), { maxItems: 128, uniqueItems: true }),
    executables: S.array(
      S.object({ id: Name, path: RelPath, sha256: Sha256Hex, runtime: S.literal('node'), writesPackData: S.boolean(), timeoutMs: S.integer({ minimum: 100, maximum: 60_000 }) }),
      { maxItems: 16 },
    ),
    evidenceSelectors: S.array(
      S.object({ id: Name, builder: S.enumOf(BUILDER_NAMES), priority: S.enumOf(['mandatory', 'high', 'optional']), maxItems: S.integer({ minimum: 1, maximum: 128 }) }),
      { maxItems: 64 },
    ),
    decisions: S.array(
      S.object(
        { id: SpecId, kind: S.enumOf(['choice', 'score', 'noul']), domain: Name, question: S.string({ minLength: 1, maxLength: 2000 }), evidence: S.array(Name, { maxItems: 32, uniqueItems: true }) },
        { options: S.array(Name, { minItems: 2, maxItems: 12, uniqueItems: true }) },
      ),
      { maxItems: 64 },
    ),
    rules: S.array(
      S.object(
        { id: Name, decision: SpecId, action: S.enumOf(ACTION_KINDS) },
        { selected: Name, scoreAtLeast: S.number({ minimum: 0, maximum: 9 }), scoreBelow: S.number({ minimum: 0, maximum: 9 }), noul: S.boolean() },
      ),
      { maxItems: 128 },
    ),
    calibration: S.array(
      S.object({ decisionSpecId: SpecId, modelId: S.string({ pattern: MODEL_ID_PATTERN }), encoderHash: S.string({ pattern: HASH_PATTERN }), artifact: RelPath, artifactHash: S.string({ pattern: HASH_PATTERN }) }),
      { maxItems: 64 },
    ),
    files: S.array(S.object({ path: RelPath, sha256: Sha256Hex }), { maxItems: 1024 }),
    publisher: Name,
    signature: S.object({ algorithm: S.literal('ed25519'), keyId: S.string({ pattern: ID_PATTERN }), value: S.string({ pattern: '^[A-Za-z0-9+/]{86}==$' }) }),
  },
);
export type PackManifest = S.Static<typeof PackManifestSchema>;

/** A JSON pointer into the manifest (issue paths, not file paths). */
function at(...parts: readonly (string | number)[]): string {
  return ['', ...parts].join('/');
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export const PackManifestContract = defineContract<PackManifest>({
  name: 'PackManifestExtended',
  description: 'Extended pack manifest: the SSOT v1 subset plus declared adapters, toolchains, settings, effects, storage, egress, tools, executables, declarative decisions, evidence selectors, rules, calibration bindings, pinned files and an Ed25519 signature (PAK-01, PAK-03).',
  schema: PackManifestSchema,
  refine: (m, issue) => {
    const specs = new Set(m.decisionSpecs);
    const actions = new Set<string>(m.actions);
    const scopes = new Set<string>(m.dataScopes);
    m.conflicts.forEach((conflict, index) => {
      if (!/^exclusive:[a-z][a-z0-9._-]{0,63}$/.test(conflict) && !/^jevris\.[a-z][a-z0-9.-]+$/.test(conflict)) issue(at('conflicts', index), 'CONFLICT_FORM');
    });
    const selectors = m.evidenceSelectors ?? [];
    if (!unique(selectors.map((item) => item.id))) issue('/evidenceSelectors', 'DUPLICATE_ID');
    selectors.forEach((selector, index) => {
      if (!scopes.has(PACK_EVIDENCE_BUILDERS[selector.builder])) issue(at('evidenceSelectors', index, 'builder'), 'EVIDENCE_SCOPE_NOT_DECLARED');
    });
    const selectorIds = new Set(selectors.map((item) => item.id));
    const decisions = m.decisions ?? [];
    if (!unique(decisions.map((item) => item.id))) issue('/decisions', 'DUPLICATE_ID');
    decisions.forEach((decision, index) => {
      if (!specs.has(decision.id)) issue(at('decisions', index, 'id'), 'DECISION_NOT_DECLARED');
      decision.evidence.forEach((ref, position) => {
        if (!selectorIds.has(ref)) issue(at('decisions', index, 'evidence', position), 'SELECTOR_UNKNOWN');
      });
      if ((decision.kind === 'choice') !== (decision.options !== undefined)) issue(at('decisions', index, 'options'), 'OPTIONS_FOR_CHOICE_ONLY');
    });
    const byId = new Map(decisions.map((item) => [item.id, item]));
    const rules = m.rules ?? [];
    if (!unique(rules.map((item) => item.id))) issue('/rules', 'DUPLICATE_ID');
    rules.forEach((rule, index) => {
      const decision = byId.get(rule.decision);
      if (decision === undefined) issue(at('rules', index, 'decision'), 'DECISION_UNKNOWN');
      if (!actions.has(rule.action)) issue(at('rules', index, 'action'), 'ACTION_NOT_DECLARED');
      if (decision === undefined) return;
      if (rule.selected !== undefined && (decision.kind !== 'choice' || !(decision.options ?? []).includes(rule.selected))) issue(at('rules', index, 'selected'), 'OPTION_UNKNOWN');
      if ((rule.scoreAtLeast !== undefined || rule.scoreBelow !== undefined) && decision.kind !== 'score') issue(at('rules', index), 'SCORE_FOR_SCORE_ONLY');
      if (rule.noul !== undefined && decision.kind !== 'noul') issue(at('rules', index, 'noul'), 'NOUL_FOR_NOUL_ONLY');
    });
    (m.settings ?? []).forEach((setting, index) => {
      const value = setting.default;
      const ok =
        setting.type === 'boolean'
          ? typeof value === 'boolean'
          : setting.type === 'integer'
            ? typeof value === 'number' && Number.isInteger(value) && (setting.minimum === undefined || value >= setting.minimum) && (setting.maximum === undefined || value <= setting.maximum)
            : setting.type === 'enum'
              ? typeof value === 'string' && (setting.values ?? []).includes(value)
              : typeof value === 'string';
      if (!ok) issue(at('settings', index, 'default'), 'SETTING_DEFAULT_TYPE');
    });
    if (!unique((m.settings ?? []).map((item) => item.key))) issue('/settings', 'DUPLICATE_ID');
    const files = m.files ?? [];
    if (!unique(files.map((item) => item.path.toLowerCase()))) issue('/files', 'DUPLICATE_PATH');
    const pinned = new Map(files.map((item) => [item.path, item.sha256]));
    const executables = m.executables ?? [];
    if (!unique(executables.map((item) => item.id)) || !unique(executables.map((item) => item.path))) issue('/executables', 'DUPLICATE_ID');
    executables.forEach((exec, index) => {
      if (m.files !== undefined && pinned.get(exec.path) !== exec.sha256) issue(at('executables', index, 'sha256'), 'EXECUTABLE_NOT_PINNED');
    });
    (m.storage?.migrations ?? []).forEach((migration, index) => {
      if (compareVersions(migration.fromVersion, migration.toVersion) >= 0) issue(at('storage', 'migrations', index), 'MIGRATION_ORDER');
    });
    const bindings = m.calibration ?? [];
    bindings.forEach((binding, index) => {
      if (!specs.has(binding.decisionSpecId)) issue(at('calibration', index, 'decisionSpecId'), 'DECISION_NOT_DECLARED');
    });
    if (!unique(bindings.map((item) => `${item.decisionSpecId}\u0000${item.modelId}\u0000${item.encoderHash}`))) issue('/calibration', 'DUPLICATE_BINDING');
    if (m.signature !== undefined && (m.publisher === undefined || m.files === undefined)) issue('/signature', 'SIGNATURE_NEEDS_PUBLISHER_AND_FILES');
  },
});

/** -1, 0 or 1 for two `x.y.z` versions. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** The decision domains a pack claims exclusively (`exclusive:<domain>` conflicts; DEC-13). */
export function packOwns(manifest: PackManifest): readonly string[] {
  return manifest.conflicts.filter((item) => item.startsWith('exclusive:')).map((item) => item.slice('exclusive:'.length));
}

/** True when the pack only advises: advise or abstain actions, and no automatic mode. */
export function adviseOnly(manifest: PackManifest): boolean {
  return manifest.actions.every((action) => action === 'advise' || action === 'abstain') && manifest.defaultMode !== 'bounded-auto' && (manifest.executables ?? []).length === 0;
}

/** Content hash of the manifest without its signature: what the signature and deltas bind. */
export function manifestHash(manifest: PackManifest): ContentHash {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(manifest)) if (key !== 'signature') rest[key] = value;
  return contentHash(rest);
}

export interface DecisionOutcome {
  readonly decision: string;
  readonly selected?: string;
  readonly score?: number;
  readonly noul?: boolean;
  /** Jev or the rules abstained: only an `abstain` follows. */
  readonly abstained?: boolean;
}

/**
 * The declared action for an outcome: the first rule of that decision whose conditions all hold,
 * else `abstain`. Pure and deterministic; the pack runs no code of its own.
 */
export function evaluateRules(manifest: PackManifest, outcome: DecisionOutcome): { readonly action: ActionKind; readonly ruleId: string | null } {
  if (outcome.abstained === true) return { action: 'abstain', ruleId: null };
  for (const rule of manifest.rules ?? []) {
    if (rule.decision !== outcome.decision) continue;
    if (rule.selected !== undefined && rule.selected !== outcome.selected) continue;
    if (rule.scoreAtLeast !== undefined && !(typeof outcome.score === 'number' && outcome.score >= rule.scoreAtLeast)) continue;
    if (rule.scoreBelow !== undefined && !(typeof outcome.score === 'number' && outcome.score < rule.scoreBelow)) continue;
    if (rule.noul !== undefined && rule.noul !== outcome.noul) continue;
    return { action: rule.action, ruleId: rule.id };
  }
  return { action: 'abstain', ruleId: null };
}

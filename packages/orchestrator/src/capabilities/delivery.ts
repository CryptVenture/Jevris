/**
 * Delivery and team-workflow capabilities (SSOT §12.8): C57 pull-request readiness, C58 CI
 * failure triage, C59 dependency-upgrade planning, C60 migration rehearsal, C61 documentation
 * drift, C64 team policy reuse.
 *
 * Each one reports; none acts. Creating or merging a PR needs explicit user or organization
 * authority; CI secrets and required checks are never touched; nothing is installed and no
 * package script runs; no migration runs anywhere, least of all in production, because of a
 * score; documentation is suggested, not rewritten; a recommended configuration is not
 * activated, and repository exceptions and managed restrictions are kept.
 */
import { profileWorkspace } from '@jevris/languages';
import { approvedManifests, verificationStatus, verificationSupport } from '../verify/service.js';
import { inScopes } from '../verify/revision.js';
import { listTasks } from '../orchestration/tasks.js';
import { readEffectiveConfig } from '../settings/config.js';
import { containsToken, sha256, type Rec } from '../util.js';
import { consultChoice, consultNoul, consultScore } from './consult.js';
import { abstainAdvice, advice, byScore, type CapabilityContext, type CapabilityDefinition, type RankedItem } from './advice.js';
import { changedFiles, diffLines, diffText, listFiles, readBounded } from './repo.js';
import { triageEnvironmentText } from './retrieval.js';

function strOf(input: Rec, key: string, max = 500): string {
  const v = input[key];
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function baseOf(input: Rec): string {
  const b = strOf(input, 'base', 200);
  return /^[A-Za-z0-9][A-Za-z0-9._/@^~-]{0,199}$/.test(b) && !b.includes('..') ? b : 'HEAD';
}

type Consulted = { source: 'jev' | 'rules'; reasonCode: string; decisionId: string | null };

// ------------------------------------------------------------------ C57 PR readiness

const C57: CapabilityDefinition = {
  id: 'C57',
  title: 'Pull-request readiness',
  primitive: 'Rules+Score',
  async handle(cx, input) {
    const report = await verificationStatus(cx.ws, { taskId: cx.taskId, checkIds: [], git: cx.git, ...(cx.ws.store === undefined ? {} : { store: cx.ws.store }) });
    const open = listTasks(cx.ws).filter((t) => !['verified', 'cancelled'].includes(t.node.state));
    const changed = await changedFiles(cx.git, cx.ws.workspaceRoot, baseOf(input)) ?? [];
    const comments = typeof input['unresolvedComments'] === 'number' && Number.isInteger(input['unresolvedComments']) ? Math.max(0, input['unresolvedComments']) : null;
    // With no mandatory check nothing can be verified, so the report is never ready; say that
    // rather than answer "0 blockers" (an unapproved repository reads the doctor's own fix).
    const support = report.mandatoryCheckIds.length === 0 ? verificationSupport(cx.ws) : null;
    const blockers: RankedItem[] = [
      ...(support === null
        ? []
        : [
            {
              id: 'verification:unsupported',
              label: 'no mandatory check to verify against',
              score: 1,
              reason: support.state === 'unsupported' ? support.reason : 'no approved check is mandatory and no acceptance check or requirement was named',
            },
          ]),
      ...report.checks.filter((c) => c.mandatory && c.status !== 'passed').map((c) => ({ id: `check:${c.checkId}`, label: `${c.checkId}: ${c.status}`, score: 1, reason: 'mandatory check without a current pass' })),
      ...report.uncoveredRequirements.map((r) => ({ id: `requirement:${r}`, label: `${r}: no check`, score: 0.9, reason: 'uncovered requirement' })),
      ...open.slice(0, 32).map((t) => ({ id: `task:${t.node.id}`, label: `${t.node.id}: ${t.node.state}`, score: 0.7, reason: 'task not verified' })),
      ...(comments !== null && comments > 0 ? [{ id: 'comments', label: `${String(comments)} unresolved review comments`, score: 0.6, reason: 'reported by the caller' }] : []),
    ];
    const ready = blockers.length === 0 && report.verified;
    let consult: Consulted = { source: 'rules', reasonCode: ready ? 'READY' : 'BLOCKERS', decisionId: null };
    if (ready && cx.engine !== undefined) {
      const got = await consultScore(cx.engine, {
        capabilityId: 'C57',
        specVersion: '1',
        sendsWorkspaceText: true,
        objective: 'Rate how reviewable the change is. It does not create or merge anything.',
        workspaceId: cx.ws.workspaceId,
        evidenceRevision: report.revision.slice(0, 64),
        evidence: [{ id: 'scope', text: `changed files: ${changed.slice(0, 60).join(', ')}`, sourceKind: 'tool', priority: 'high' }],
        facts: { changedFiles: changed.length, checks: report.checks.length },
        instructions: 'How focused and reviewable is this change?',
        anchors: ['Sprawling: it should be split into smaller changes.', 'Broad: it touches many areas and needs careful review.', 'Focused: it stays within a few related areas.', 'Small and focused: one clear change that is easy to review.'],
        rules: () => ({ score: changed.length <= 20 ? 3 : changed.length <= 60 ? 2 : 1, reasonCode: 'CHANGE_SIZE' }),
        ...(cx.remainingMs === undefined ? {} : { remainingMs: cx.remainingMs }),
      });
      consult = got;
    }
    return advice(
      C57,
      {
        verb: 'report',
        summary: ready ? `Ready for a pull request: every mandatory check passes on ${report.revision.slice(0, 12)} and every task is verified. Opening or merging it is yours to do.` : `Not ready: ${String(blockers.length)} blockers.`,
        recommendation: ready ? 'ready' : 'not-ready',
        ranked: blockers.sort(byScore),
        kept: report.mandatoryCheckIds,
        validation: report.missingEvidence.slice(0, 32),
        requiresApproval: true,
        notes: [`${String(changed.length)} files changed.`, 'Creating or merging a pull request needs explicit user or organization authority.'],
      },
      consult,
    );
  },
};

// ------------------------------------------------------------------ C58 CI triage

const C58: CapabilityDefinition = {
  id: 'C58',
  title: 'CI failure triage',
  primitive: 'Choice',
  async handle(cx) {
    const all = cx.ws.receipts.list(cx.ws.workspaceId);
    const ciFailed = [...cx.ws.receipts.latest(cx.ws.workspaceId, cx.taskId).values()].filter((r) => r.receipt.issuer === 'ci-import' && r.validity === 'current' && r.receipt.outcome === 'failed');
    const byCheck = all.filter((r) => r.receipt.issuer === 'ci-import' && r.receipt.outcome === 'failed' && r.validity === 'current');
    const failures = ciFailed.length > 0 ? ciFailed : byCheck.slice(-8);
    if (failures.length === 0) return advice(C58, { verb: 'report', summary: 'No current failing CI receipt to triage.', reasonCode: 'NO_CI_FAILURES' });
    const ranked: RankedItem[] = [];
    let consult: Consulted = { source: 'rules', reasonCode: 'RECEIPT_EVIDENCE', decisionId: null };
    for (const f of failures.slice(0, 8)) {
      const history = all.filter((r) => r.receipt.checkId === f.receipt.checkId);
      const localPass = history.some((r) => r.receipt.issuer === 'local-runner' && r.receipt.outcome === 'passed' && r.receipt.inputRevision.head === f.receipt.inputRevision.head);
      const ciSameRev = history.filter((r) => r.receipt.issuer === 'ci-import' && r.receipt.inputRevision.head === f.receipt.inputRevision.head);
      const flip = ciSameRev.some((r) => r.receipt.outcome === 'passed') && ciSameRev.some((r) => r.receipt.outcome === 'failed');
      const text = (f.receipt.results?.failures ?? []).map((x) => `${x.name} ${x.message ?? ''}`).join('\n') || f.receipt.outcomeReason;
      const env = triageEnvironmentText(text);
      const rules = () => (flip ? { choice: 'flaky-investigation', reasonCode: 'CI_FLIP' } : localPass || env.length > 0 ? { choice: 'infra', reasonCode: localPass ? 'PASSES_LOCALLY' : 'ENVIRONMENT_SIGNATURE' } : { choice: 'source', reasonCode: 'CONSISTENT_FAILURE' });
      const got = await consultChoice(cx.engine, {
        capabilityId: 'C58',
        specVersion: '1',
        sendsWorkspaceText: true,
        objective: 'Route a CI failure to source, infrastructure or flaky investigation. Nothing in CI is changed.',
        workspaceId: cx.ws.workspaceId,
        evidenceRevision: f.receipt.id,
        evidence: [{ id: 'failure', text: text.slice(0, 2000), sourceKind: 'receipt', priority: 'high' }],
        facts: { passesLocallyAtSameRevision: localPass, ciOutcomeFlipsAtSameRevision: flip, environmentSignals: env.length, ciRuns: ciSameRev.length },
        instructions: 'Where should the diagnosis of this CI failure start?',
        options: { source: 'A defect in the change.', infra: 'The CI environment or infrastructure.', 'flaky-investigation': 'A nondeterministic test.' },
        rules,
        ...(cx.remainingMs === undefined ? {} : { remainingMs: cx.remainingMs }),
      });
      if (got.source === 'jev') consult = got;
      ranked.push({ id: f.receipt.checkId, label: `${f.receipt.checkId}: ${got.value}`, score: null, reason: [localPass ? 'passes locally at the same revision' : null, flip ? 'CI result flips at the same revision' : null, env[0] !== undefined ? `${env[0].kind}: ${env[0].subject}` : null].filter((x) => x !== null).join('; ') || 'fails consistently' });
    }
    const routes = [...new Set(ranked.map((r) => r.label.split(': ')[1] ?? ''))];
    return advice(
      C58,
      {
        verb: 'rank',
        summary: `${String(ranked.length)} CI failures routed: ${routes.join(', ')}.`,
        recommendation: routes.length === 1 ? (routes[0] ?? null) : 'mixed',
        ranked,
        evidenceIds: failures.map((f) => f.receipt.id),
        notes: ['CI secrets, required checks and receipt imports are not changed by triage.'],
      },
      consult,
    );
  },
};

// ------------------------------------------------------------------ C59 dependency upgrades

export interface Upgrade {
  readonly name: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly bump: 'major' | 'minor' | 'patch' | 'added' | 'removed' | 'other';
}

function npmLockVersions(text: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const j = JSON.parse(text) as { packages?: { [k: string]: { version?: string } }; dependencies?: { [k: string]: { version?: string } } };
    for (const [k, v] of Object.entries(j.packages ?? {})) {
      if (k === '' || typeof v.version !== 'string') continue;
      const name = k.replace(/^.*node_modules\//, '');
      if (!out.has(name)) out.set(name, v.version);
    }
    for (const [k, v] of Object.entries(j.dependencies ?? {})) if (typeof v.version === 'string' && !out.has(k)) out.set(k, v.version);
  } catch {
    // an unparsable lockfile contributes nothing
  }
  return out;
}

function tomlLockVersions(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const block of text.split(/\n\[\[package\]\]\n/)) {
    const name = /^name = "([^"]+)"/m.exec(block)?.[1];
    const version = /^version = "([^"]+)"/m.exec(block)?.[1];
    if (name !== undefined && version !== undefined) out.set(name, version);
  }
  return out;
}

function bumpOf(from: string | null, to: string | null): Upgrade['bump'] {
  if (from === null) return 'added';
  if (to === null) return 'removed';
  const a = /^(\d+)\.(\d+)\.(\d+)/.exec(from);
  const b = /^(\d+)\.(\d+)\.(\d+)/.exec(to);
  if (a === null || b === null) return 'other';
  if (a[1] !== b[1]) return 'major';
  if (a[2] !== b[2]) return 'minor';
  return 'patch';
}

/** Upgrades between the base and the working lockfiles (npm, Cargo, Poetry), from real files. */
export async function lockfileUpgrades(cx: Pick<CapabilityContext, 'git' | 'ws'>, base: string): Promise<readonly Upgrade[]> {
  const root = cx.ws.workspaceRoot;
  const out: Upgrade[] = [];
  for (const [file, parse] of [['package-lock.json', npmLockVersions], ['Cargo.lock', tomlLockVersions], ['poetry.lock', tomlLockVersions]] as const) {
    const now = readBounded(root, file, 32 * 1024 * 1024);
    const before = await cx.git.run(['show', `${base}:${file}`], root);
    if (now === null && !before.ok) continue;
    const a = before.ok ? parse(before.stdout) : new Map<string, string>();
    const b = now === null ? new Map<string, string>() : parse(now.text);
    for (const name of new Set([...a.keys(), ...b.keys()])) {
      const from = a.get(name) ?? null;
      const to = b.get(name) ?? null;
      if (from === to) continue;
      out.push({ name, from, to, bump: bumpOf(from, to) });
    }
  }
  return out.sort((x, y) => (x.name < y.name ? -1 : 1)).slice(0, 500);
}

const C59: CapabilityDefinition = {
  id: 'C59',
  title: 'Dependency-upgrade planning',
  primitive: 'Score',
  async handle(cx, input) {
    const root = cx.ws.workspaceRoot;
    const upgrades = await lockfileUpgrades(cx, baseOf(input));
    if (upgrades.length === 0) return advice(C59, { verb: 'report', summary: 'No lockfile change to plan for.', reasonCode: 'NO_UPGRADES' });
    const files = (await listFiles(cx.git, root) ?? []).filter((f) => /\.(m?[jt]sx?|cjs|py|rs)$/.test(f) && !/(^|\/)(node_modules|dist|vendor)\//.test(f)).slice(0, 400);
    const texts = files.map((f) => ({ f, t: readBounded(root, f, 128 * 1024)?.text ?? '' }));
    const manifests = approvedManifests(cx.ws);
    const ranked: RankedItem[] = [];
    const tests = new Set<string>();
    let consult: Consulted = { source: 'rules', reasonCode: 'SEMVER_RISK', decisionId: null };
    const direct = upgrades.filter((u) => u.bump !== 'patch' || texts.some((x) => x.t.includes(u.name))).slice(0, 40);
    for (const [i, u] of direct.entries()) {
      const importers = texts.filter((x) => new RegExp(`(from\\s+['"]${u.name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(/[^'"]*)?['"]|require\\(['"]${u.name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}['"]|^\\s*(import|from)\\s+${u.name.replace(/-/g, '_').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\b|\\buse\\s+${u.name.replace(/-/g, '_').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}::)`, 'm').test(x.t)).map((x) => x.f);
      const changelog = readBounded(root, `node_modules/${u.name}/CHANGELOG.md`, 256 * 1024); // path-hygiene: allow git-style relative path, joined by underRoot
      const breaking = changelog !== null && u.to !== null && new RegExp(`${u.to.replace(/\./g, '\\.')}[\\s\\S]{0,4000}?breaking`, 'i').test(changelog.text);
      const rulesScore = Math.min(1, (u.bump === 'major' ? 0.6 : u.bump === 'minor' ? 0.25 : u.bump === 'removed' ? 0.4 : 0.1) + Math.min(0.3, importers.length * 0.03) + (breaking ? 0.3 : 0));
      let score = rulesScore;
      if (i < 4 && cx.engine !== undefined && (u.bump === 'major' || breaking)) {
        const got = await consultScore(cx.engine, {
          capabilityId: 'C59',
          specVersion: '1',
          objective: 'Rate the risk of a dependency upgrade. Nothing is installed.',
          workspaceId: cx.ws.workspaceId,
          evidenceRevision: sha256(`${u.name}:${u.from ?? ''}:${u.to ?? ''}`).slice(0, 32),
          evidence: changelog === null ? [] : [{ id: 'changelog', text: changelog.text.slice(0, 3000), sourceKind: 'file', priority: 'high' }],
          facts: { from: u.from, to: u.to, bump: u.bump, importers: importers.length, breakingMentioned: breaking },
          // The package name is read from the workspace's lockfile: it goes out only with source egress approved.
          approvedFacts: { package: u.name },
          instructions: 'How risky is this upgrade for the code that imports it?',
          anchors: ['Negligible: no change in behaviour is expected.', 'Low: a small risk that the importers can absorb.', 'Moderate: test the importers.', 'High: expect breaking changes.'],
          rules: () => ({ score: Math.round(rulesScore * 3), reasonCode: 'SEMVER_RISK' }),
          ...(cx.remainingMs === undefined ? {} : { remainingMs: cx.remainingMs }),
        });
        if (got.source === 'jev') {
          score = Math.max(rulesScore, got.value / 3);
          consult = got;
        }
      }
      for (const m of manifests) if (m.mandatory || importers.some((f) => inScopes(f, m.inputScopes))) tests.add(m.id);
      ranked.push({ id: u.name, label: `${u.name} ${u.from ?? '-'} -> ${u.to ?? '-'} (${u.bump})`, score, reason: `${String(importers.length)} importing files${breaking ? '; the changelog mentions a breaking change' : ''}` });
    }
    ranked.sort(byScore);
    return advice(
      C59,
      {
        verb: 'rank',
        summary: `${String(upgrades.length)} lockfile changes; ${String(ranked.filter((r) => (r.score ?? 0) >= 0.5).length)} need attention.`,
        ranked,
        validation: tests.size > 0 ? [...tests] : manifests.map((m) => m.id),
        notes: ['Installing packages or running their scripts needs the normal permissions; this plan does neither.'],
      },
      consult,
    );
  },
};

// ------------------------------------------------------------------ C60 migrations

const MIGRATION_FILE = /(^|\/)(migrations?|migrate|db\/migrate|alembic\/versions|prisma\/migrations|flyway|liquibase)\/|\.(sql)$/i;
const DESTRUCTIVE = /\b(DROP\s+(TABLE|COLUMN|INDEX|SCHEMA|DATABASE)|TRUNCATE\b|DELETE\s+FROM\s+\w+\s*;|ALTER\s+TABLE\s+\S+\s+(DROP|RENAME)|RENAME\s+(TABLE|COLUMN)|drop_table|remove_column|dropColumn|dropTable|op\.drop_)/i;
const REHEARSAL = /rehears|migration|migrate|dry.?run/i;

const C60: CapabilityDefinition = {
  id: 'C60',
  title: 'Migration rehearsal',
  primitive: 'Rules+Noul',
  async handle(cx, input) {
    const root = cx.ws.workspaceRoot;
    const named = Array.isArray(input['migrations']) ? (input['migrations'] as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 32) : [];
    const files = named.length > 0 ? named : (await changedFiles(cx.git, root, baseOf(input)) ?? []).filter((f) => MIGRATION_FILE.test(f));
    if (files.length === 0) return advice(C60, { verb: 'report', summary: 'No migration in the change.', reasonCode: 'NO_MIGRATION' });
    const destructive: RankedItem[] = [];
    for (const f of files) {
      const read = readBounded(root, f, 512 * 1024);
      if (read === null) continue;
      const lines = read.text.split(/\r?\n/);
      lines.forEach((l, i) => {
        if (DESTRUCTIVE.test(l) && destructive.length < 64) destructive.push({ id: `${f}:${String(i + 1)}`, label: `${f}:${String(i + 1)}`, score: null, reason: 'destructive statement' });
      });
    }
    const latest = cx.ws.receipts.latest(cx.ws.workspaceId, cx.taskId);
    const rehearsal = approvedManifests(cx.ws)
      .filter((m) => REHEARSAL.test(`${m.id} ${m.description}`))
      .map((m) => latest.get(m.id))
      .find((r) => r !== undefined && r.validity === 'current' && r.receipt.outcome === 'passed');
    let consult: Consulted = { source: 'rules', reasonCode: rehearsal === undefined ? 'NO_REHEARSAL' : 'REHEARSED', decisionId: null };
    let compatibilityConcern = false;
    const contract = strOf(input, 'compatibility', 2000);
    if (contract !== '' && cx.engine !== undefined) {
      const got = await consultNoul(cx.engine, {
        capabilityId: 'C60',
        specVersion: '1',
        sendsWorkspaceText: true,
        objective: 'Flag a migration that may break the stated backward-compatibility contract. Nothing runs.',
        workspaceId: cx.ws.workspaceId,
        evidenceRevision: sha256(files.join(',')).slice(0, 32),
        evidence: [
          { id: 'contract', text: contract, sourceKind: 'user', priority: 'mandatory' },
          { id: 'migration', text: files.map((f) => readBounded(root, f, 4096)?.text ?? '').join('\n').slice(0, 3000), sourceKind: 'file', priority: 'high' },
        ],
        instructions: 'Could this migration break the compatibility contract?',
        whenTrue: 'Old readers or writers could fail after it.',
        whenFalse: 'The contract holds.',
        rules: () => ({ value: destructive.length > 0, reasonCode: 'DESTRUCTIVE_STATEMENTS' }),
        ...(cx.remainingMs === undefined ? {} : { remainingMs: cx.remainingMs }),
      });
      consult = got;
      compatibilityConcern = got.value;
    }
    const needApproval = destructive.length > 0;
    return advice(
      C60,
      {
        verb: rehearsal === undefined || needApproval || compatibilityConcern ? 'pause' : 'report',
        summary: `${String(files.length)} migrations; ${rehearsal === undefined ? 'no current rehearsal record' : `rehearsed by ${rehearsal.receipt.checkId}`}; ${String(destructive.length)} destructive statements.${needApproval ? ' Destructive steps need explicit approval.' : ''}`,
        recommendation: rehearsal === undefined ? 'rehearse' : needApproval ? 'approve-destructive' : 'ready-for-review',
        ranked: destructive,
        kept: ['rehearsal-required', ...(needApproval ? ['destructive-approval-required'] : [])],
        validation: rehearsal === undefined ? ['Run a rehearsal check (id or description naming a migration rehearsal) on a disposable database.'] : [rehearsal.receipt.checkId],
        requiresApproval: needApproval,
        evidenceIds: rehearsal === undefined ? [] : [rehearsal.receipt.id],
        notes: [compatibilityConcern ? 'Jev flagged a possible compatibility break; review it.' : 'No migration was run. Nothing runs in production from a score.'],
      },
      consult,
    );
  },
};

// ------------------------------------------------------------------ C61 documentation drift

const EXPORT_DECL = /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)|^\s*pub\s+(?:fn|struct|enum|trait)\s+([A-Za-z_][A-Za-z0-9_]*)|^def\s+([A-Za-z][A-Za-z0-9_]*)/;

export function changedExports(diff: string): readonly string[] {
  const out = new Set<string>();
  for (const { added, removed } of diffLines(diff).values()) {
    for (const line of [...added, ...removed]) {
      const m = EXPORT_DECL.exec(line);
      const name = m?.[1] ?? m?.[2] ?? m?.[3];
      if (name !== undefined && name.length >= 3) out.add(name);
    }
  }
  return [...out].slice(0, 200);
}

const C61: CapabilityDefinition = {
  id: 'C61',
  title: 'Documentation drift',
  primitive: 'Score',
  async handle(cx, input) {
    const root = cx.ws.workspaceRoot;
    const diff = await diffText(cx.git, root, [], baseOf(input));
    if (diff === null) return abstainAdvice(C61, 'NO_DIFF', 'Git could not produce the change.');
    const names = changedExports(diff);
    if (names.length === 0) return advice(C61, { verb: 'report', summary: 'No exported interface changed.', reasonCode: 'NO_INTERFACE_CHANGE' });
    const docs = (await listFiles(cx.git, root) ?? []).filter((f) => /\.(md|mdx|rst|adoc|txt)$/i.test(f) && !/(^|\/)(node_modules|dist|vendor)\//.test(f)).slice(0, 1000);
    const ranked: RankedItem[] = [];
    for (const d of docs) {
      const text = readBounded(root, d, 256 * 1024)?.text;
      if (text === undefined) continue;
      const refs = names.filter((n) => containsToken(text, n));
      if (refs.length === 0) continue;
      ranked.push({ id: d, label: d, score: Math.min(1, refs.length / Math.max(1, names.length) + 0.2), reason: `references ${refs.slice(0, 6).join(', ')}` });
    }
    ranked.sort(byScore);
    let consult: Consulted = { source: 'rules', reasonCode: 'REFERENCE_MATCH', decisionId: null };
    const first = ranked[0];
    if (first !== undefined && cx.engine !== undefined) {
      consult = await consultScore(cx.engine, {
        capabilityId: 'C61',
        specVersion: '1',
        sendsWorkspaceText: true,
        objective: 'Rate how likely a document is outdated by the interface change. Do not assert behavior the code does not show.',
        workspaceId: cx.ws.workspaceId,
        evidenceRevision: sha256(`${first.id}:${names.join(',')}`).slice(0, 32),
        evidence: [
          { id: 'doc', text: readBounded(root, first.id, 8192)?.text.slice(0, 3000) ?? '', sourceKind: 'file', priority: 'high' },
          { id: 'change', text: diff.slice(0, 3000), sourceKind: 'tool', priority: 'high' },
        ],
        instructions: 'How likely is this document out of date after the change?',
        anchors: ['Unaffected: the documentation does not mention the change.', 'Possibly stale: it mentions the changed code in passing.', 'Likely stale: it describes the old behaviour of the changed code.', 'Certainly contradicts the change.'],
        rules: () => ({ score: Math.round((first.score ?? 0) * 3), reasonCode: 'REFERENCE_MATCH' }),
        ...(cx.remainingMs === undefined ? {} : { remainingMs: cx.remainingMs }),
      });
    }
    const examples = approvedManifests(cx.ws).filter((m) => /doc|example|readme|snippet/i.test(`${m.id} ${m.description}`)).map((m) => m.id);
    return advice(
      C61,
      {
        verb: ranked.length > 0 ? 'rank' : 'report',
        summary: ranked.length > 0 ? `${String(ranked.length)} documents reference changed interfaces (${names.slice(0, 5).join(', ')}).` : `Changed interfaces (${names.slice(0, 5).join(', ')}) are not referenced in any document.`,
        ranked,
        validation: examples,
        notes: [examples.length > 0 ? 'Run the executable-example checks listed under validation.' : 'No executable-example check is approved.', 'Suggestions only: no behavior is asserted beyond the diff.'],
      },
      consult,
    );
  },
};

// ------------------------------------------------------------------ C64 team policy reuse

interface Preset {
  readonly id: string;
  readonly description: string;
  readonly fits: (languages: ReadonlySet<string>, projects: ReadonlySet<string>) => boolean;
  readonly settings: readonly string[];
}

const PRESETS: readonly Preset[] = [
  { id: 'node-service', description: 'Node or TypeScript project: npm test and lint as mandatory checks.', fits: (l) => l.has('typescript') || l.has('javascript'), settings: ['checks: npm test (mandatory), npm run lint (mandatory)', 'routing.mode: advise'] },
  { id: 'python-service', description: 'Python project: pytest mandatory, ruff optional.', fits: (l) => l.has('python'), settings: ['checks: pytest (mandatory), ruff check (optional)', 'routing.mode: advise'] },
  { id: 'rust-crate', description: 'Rust crate: cargo test mandatory, clippy optional.', fits: (l) => l.has('rust'), settings: ['checks: cargo test (mandatory), cargo clippy (optional)'] },
  { id: 'go-module', description: 'Go module: go test mandatory, go vet optional.', fits: (l) => l.has('go'), settings: ['checks: go test ./... (mandatory), go vet ./... (optional)'] },
  { id: 'embedded-firmware', description: 'Firmware: host builds verified; device checks need declared hardware runners.', fits: (l, p) => l.has('c') || p.has('keil-uvision') || p.has('iar') || p.has('stm32cube') || p.has('platformio'), settings: ['checks: host build (mandatory), device tests with hardware tags', 'orchestration.enabled: false'] },
  { id: 'polyglot-monorepo', description: 'Several stacks: one check per stack, per-package input scopes.', fits: (l) => l.size >= 3, settings: ['checks: one per stack with inputScopes', 'orchestration.maxConcurrentWorkers: 2'] },
];

const C64: CapabilityDefinition = {
  id: 'C64',
  title: 'Team policy reuse',
  primitive: 'Rules+Choice',
  async handle(cx) {
    const profile = profileWorkspace(cx.ws.workspaceRoot, { platform: cx.platform });
    const languages = new Set(profile.metadata.filter((m) => m.kind === 'language').map((m) => m.id));
    const projects = new Set(profile.metadata.filter((m) => m.kind === 'project').map((m) => m.id));
    for (const s of profile.stacks) languages.add(s.stack === 'npm' || s.stack === 'pnpm' || s.stack === 'yarn' || s.stack === 'bun' ? 'javascript' : s.stack === 'cargo' ? 'rust' : s.stack);
    const effective = readEffectiveConfig({ home: cx.home, workspaceRoot: cx.ws.workspaceRoot });
    const compatible = PRESETS.filter((p) => p.fits(languages, projects));
    // Kept: every repository exception (workspace layer) and managed restriction (organization layer).
    const kept = effective.narrowed.filter((n) => n.layer === 'workspace' || n.layer === 'organization').map((n) => `${n.layer}:${n.key}=${n.to}`);
    const options: { [key: string]: string } = { 'keep-current': 'Keep the current configuration.' };
    for (const p of compatible) options[p.id] = p.description;
    const got = await consultChoice(cx.engine, {
      capabilityId: 'C64',
      specVersion: '1',
      objective: 'Recommend a compatible team configuration for this repository. Nothing is activated.',
      workspaceId: cx.ws.workspaceId,
      evidenceRevision: sha256([...languages, ...projects].sort().join(',')).slice(0, 32),
      evidence: [],
      facts: { languages: [...languages].sort().join(',').slice(0, 64), projects: [...projects].sort().join(',').slice(0, 64), approvedChecks: approvedManifests(cx.ws).length, packs: effective.config.packs.length },
      instructions: 'Which listed configuration fits this repository best?',
      options,
      rules: () => ({ choice: compatible[0]?.id ?? 'keep-current', reasonCode: compatible.length > 0 ? 'STACK_MATCH' : 'NO_COMPATIBLE_PRESET' }),
      ...(cx.remainingMs === undefined ? {} : { remainingMs: cx.remainingMs }),
    });
    const chosen = PRESETS.find((p) => p.id === got.value);
    return advice(
      C64,
      {
        verb: 'rank',
        summary: chosen === undefined ? 'Keep the current configuration: no compatible team preset.' : `Recommended: ${chosen.id}. It is not activated; apply it with jevris configure after review.`,
        recommendation: got.value,
        ranked: compatible.map((p) => ({ id: p.id, label: p.description, score: p.id === got.value ? 1 : 0.5, reason: p.settings.join('; ') })),
        kept,
        requiresApproval: chosen !== undefined,
        notes: [`Detected: ${[...languages, ...projects].sort().join(', ') || 'nothing'}.`, 'Repository exceptions and managed restrictions stay as they are.'],
      },
      got,
    );
  },
};

export const DELIVERY_CAPABILITIES: readonly CapabilityDefinition[] = [C57, C58, C59, C60, C61, C64];

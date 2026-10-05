/**
 * Verification and code-quality capabilities (SSOT §12.6): C41 test-impact prioritization,
 * C42 failure-cluster ranking, C43 patch-candidate ranking, C44 review-area prioritization,
 * C45 requirements-to-evidence audit, C46 flaky-test investigation, C47 security-review
 * escalation.
 *
 * None of them changes what completion needs: mandatory checks stay fixed and first, a ranking
 * accepts no patch, a proposed cause is validated only by running checks, mandatory reviewers
 * and protected areas are always kept, a failing test is never disabled, and a negative
 * security answer never certifies the absence of vulnerabilities. Completion is decided by
 * store receipts alone (VER-04).
 */
import { approvedManifests, verificationStatus } from '../verify/service.js';
import { inScopes } from '../verify/revision.js';
import type { StoredReceipt } from '../verify/receipts.js';
import { getTask } from '../orchestration/tasks.js';
import { workerRuns } from '../orchestration/workers.js';
import { getWorktree } from '../worktree.js';
import { diagnosticFingerprint } from '../orchestration/loops.js';
import { safeText, sha256, type Rec } from '../util.js';
import { consultChoice, consultNoul, consultScore } from './consult.js';
import { abstainAdvice, advice, byScore, type CapabilityContext, type CapabilityDefinition, type RankedItem } from './advice.js';
import { changedFiles, diffLines, diffText, moduleOf, readBounded } from './repo.js';
import { words } from './retrieval.js';

function strOf(input: Rec, key: string, max = 500): string {
  const v = input[key];
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function strsOf(input: Rec, key: string, maxItems = 64, maxLen = 500): string[] {
  const v = input[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, maxItems).map((x) => x.slice(0, maxLen)) : [];
}

function baseOf(input: Rec): string {
  const b = strOf(input, 'base', 200);
  return /^[A-Za-z0-9][A-Za-z0-9._/@^~-]{0,199}$/.test(b) && !b.includes('..') ? b : 'HEAD';
}

const SYMBOL = /\b(?:function|class|def|fn|func|interface|type|struct|enum|trait|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;

/** Symbols defined on changed lines of a diff. */
export function changedSymbols(diff: string): readonly string[] {
  const out = new Set<string>();
  for (const { added, removed } of diffLines(diff).values()) {
    for (const line of [...added, ...removed]) {
      SYMBOL.lastIndex = 0;
      for (let m = SYMBOL.exec(line); m !== null; m = SYMBOL.exec(line)) if ((m[1] ?? '').length >= 3) out.add(m[1] ?? '');
    }
  }
  return [...out].slice(0, 256);
}

// ------------------------------------------------------------------ C41 test impact

const CONFIG_FILE = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|tsconfig[^/]*\.json|pyproject\.toml|poetry\.lock|Cargo\.(toml|lock)|go\.(mod|sum)|pom\.xml|build\.gradle(\.kts)?|CMakeLists\.txt|Makefile|\.github\/workflows\/.*)$/;

const C41: CapabilityDefinition = {
  id: 'C41',
  title: 'Test-impact prioritization',
  primitive: 'Score',
  async handle(cx, input) {
    const manifests = approvedManifests(cx.ws);
    if (manifests.length === 0) return abstainAdvice(C41, 'NO_CHECKS', 'No approved checks: add jevris.checks.json and approve it first.');
    const root = cx.ws.workspaceRoot;
    const base = baseOf(input);
    const changed = await changedFiles(cx.git, root, base);
    const diff = changed === null ? null : await diffText(cx.git, root, [], base);
    const symbols = diff === null ? [] : changedSymbols(diff);
    const mandatory = manifests.filter((m) => m.mandatory);
    const optional = manifests.filter((m) => !m.mandatory);
    // Unknown impact (git cannot answer, or a build or dependency file changed) runs the broader suite.
    const unknown = changed === null || changed.some((f) => CONFIG_FILE.test(f));
    const symbolWords = new Set(symbols.flatMap((s) => words(s)));
    const ranked: RankedItem[] = optional.map((m) => {
      if (unknown) return { id: m.id, label: m.description || m.id, score: 1, reason: 'impact unknown: the broader suite runs' };
      const scoped = m.inputScopes.length === 0;
      const hits = (changed ?? []).filter((f) => inScopes(f, m.inputScopes)).length;
      const mention = words(`${m.id} ${m.description}`).filter((w) => symbolWords.has(w)).length;
      const score = scoped ? 0.5 : Math.min(1, (hits > 0 ? 0.6 : 0) + Math.min(0.3, hits * 0.05) + Math.min(0.2, mention * 0.1));
      return { id: m.id, label: m.description || m.id, score, reason: scoped ? 'no declared input scope: impact unknown, kept in the run' : hits > 0 ? `${String(hits)} changed files in its inputs` : mention > 0 ? 'names a changed symbol' : 'no changed input' };
    });
    let consult: { source: 'jev' | 'rules'; reasonCode: string; decisionId: string | null } = { source: 'rules', reasonCode: unknown ? 'IMPACT_UNKNOWN' : 'SCOPE_IMPACT', decisionId: null };
    if (!unknown && cx.engine !== undefined) {
      for (const [i, r] of ranked.entries()) {
        if (i >= 4 || r.score === null || r.score <= 0 || r.score >= 1) continue;
        const got = await consultScore(cx.engine, {
          capabilityId: 'C41',
          specVersion: '1',
          sendsWorkspaceText: true,
          objective: 'Order optional tests by how likely the change affects them.',
          workspaceId: cx.ws.workspaceId,
          evidenceRevision: sha256(`${r.id}:${(changed ?? []).join(',')}`).slice(0, 32),
          evidence: [
            { id: 'test', text: `${r.id}: ${r.label}`, sourceKind: 'policy', priority: 'high' },
            { id: 'changes', text: `changed files: ${(changed ?? []).slice(0, 40).join(', ')}; symbols: ${symbols.slice(0, 40).join(', ')}`, sourceKind: 'tool', priority: 'high' },
          ],
          instructions: 'How likely is this optional test to be affected by the change?',
          anchors: ['Unaffected: the change cannot reach what the check covers.', 'Possibly affected.', 'Likely affected.', 'Directly exercises the change.'],
          rules: () => ({ score: Math.round((r.score ?? 0) * 3), reasonCode: 'SCOPE_IMPACT' }),
          ...(cx.remainingMs === undefined ? {} : { remainingMs: cx.remainingMs }),
        });
        if (got.source === 'jev') {
          ranked[i] = { ...r, score: Math.max(r.score, got.value / 3), reason: `${r.reason}; Jev rated ${String(got.value)} of 3` };
          consult = got;
        }
      }
    }
    ranked.sort(byScore);
    return advice(
      C41,
      {
        verb: 'rank',
        summary: unknown ? 'Impact is unknown, so every check runs; mandatory checks first.' : `Mandatory checks run first and unchanged; ${String(ranked.filter((r) => (r.score ?? 0) > 0).length)} optional checks are affected.`,
        ranked,
        kept: mandatory.map((m) => m.id),
        validation: [...mandatory.map((m) => m.id), ...ranked.filter((r) => (r.score ?? 0) > 0).map((r) => r.id)],
        notes: [unknown ? 'A build, dependency or workflow file changed, or git could not answer: nothing optional is skipped.' : `${String((changed ?? []).length)} changed files, ${String(symbols.length)} changed symbols.`],
      },
      consult,
    );
  },
};

// ------------------------------------------------------------------ C42 failure clusters

const FRAME = /(?:\(|\s|^)((?:[A-Za-z]:)?[A-Za-z0-9_./\\-]+\.[A-Za-z0-9]{1,6}):(\d+)(?::\d+)?\)?/;

export interface FailureCluster {
  readonly id: string;
  readonly fingerprint: string;
  readonly checks: readonly string[];
  readonly failures: number;
  readonly sample: string;
  readonly frame: string | null;
}

function firstErrorLine(text: string): string {
  const lines = text.split(/\r?\n/);
  return lines.find((l) => /error|fail|assert|exception|panic|not ok/i.test(l)) ?? lines.find((l) => l.trim() !== '') ?? '';
}

/** Structured failures of the current failed receipts, clustered by fingerprint and top frame. */
export function clusterFailures(cx: Pick<CapabilityContext, 'ws' | 'taskId'>, rows: readonly StoredReceipt[]): readonly FailureCluster[] {
  const clusters = new Map<string, { fingerprint: string; checks: Set<string>; failures: number; sample: string; frame: string | null }>();
  const add = (checkId: string, text: string) => {
    const fp = diagnosticFingerprint(text);
    const frameM = FRAME.exec(text);
    const frame = frameM === null ? null : (frameM[1] ?? '').split('\\').join('/').replace(/^.*?(?=(src|lib|test|tests|packages|apps)\/)/, '');
    const key = frame ?? fp;
    const c = clusters.get(key) ?? { fingerprint: fp, checks: new Set<string>(), failures: 0, sample: safeText(text, 240), frame };
    c.checks.add(checkId);
    c.failures += 1;
    clusters.set(key, c);
  };
  for (const row of rows) {
    const failures = row.receipt.results?.failures ?? [];
    if (failures.length > 0) {
      for (const f of failures.slice(0, 50)) add(row.receipt.checkId, `${f.name} ${f.message ?? ''}`);
      continue;
    }
    const handle = row.receipt.rawOutputHandle;
    const bytes = handle === null ? undefined : cx.ws.evidence.get(handle, cx.ws.workspaceId);
    add(row.receipt.checkId, bytes === undefined ? row.receipt.outcomeReason : firstErrorLine(new TextDecoder().decode(bytes.subarray(0, 256 * 1024))));
  }
  return [...clusters.values()]
    .map((c, i) => ({ id: `cluster-${String(i + 1)}`, fingerprint: c.fingerprint, checks: [...c.checks].sort(), failures: c.failures, sample: c.sample, frame: c.frame }))
    .sort((a, b) => b.failures - a.failures || b.checks.length - a.checks.length || (a.fingerprint < b.fingerprint ? -1 : 1))
    .map((c, i) => ({ ...c, id: `cluster-${String(i + 1)}` }));
}

const C42: CapabilityDefinition = {
  id: 'C42',
  title: 'Failure-cluster ranking',
  primitive: 'Choice',
  async handle(cx, input) {
    const latest = cx.ws.receipts.latest(cx.ws.workspaceId, cx.taskId);
    const failed = [...latest.values()].filter((r) => r.validity === 'current' && r.receipt.outcome === 'failed');
    if (failed.length === 0) return advice(C42, { verb: 'report', summary: 'No current failing receipt to cluster.', reasonCode: 'NO_FAILURES' });
    const clusters = clusterFailures(cx, failed).slice(0, 12);
    const changed = await changedFiles(cx.git, cx.ws.workspaceRoot, baseOf(input)) ?? [];
    const changedModules = new Set(changed.map(moduleOf));
    const ranked: RankedItem[] = clusters.map((c) => {
      const near = c.frame !== null && changedModules.has(moduleOf(c.frame));
      const score = Math.min(1, c.failures / Math.max(1, failed.length * 2) + c.checks.length * 0.1 + (near ? 0.3 : 0));
      return { id: c.id, label: c.frame === null ? c.sample : `${c.frame}: ${c.sample}`, score, reason: `${String(c.failures)} failures in ${c.checks.join(', ')}${near ? '; in a changed module' : ''}` };
    });
    ranked.sort(byScore);
    const options: { [key: string]: string } = {};
    for (const r of ranked.slice(0, 6)) options[r.id] = r.label.slice(0, 300);
    options['none'] = 'No cluster is a plausible shared cause.';
    const top = ranked[0];
    const got = await consultChoice(cx.engine, {
      capabilityId: 'C42',
      specVersion: '1',
      sendsWorkspaceText: true,
      objective: 'Pick the failure cluster most likely to share one cause; checks will validate it.',
      workspaceId: cx.ws.workspaceId,
      evidenceRevision: sha256(clusters.map((c) => c.fingerprint).join(',')).slice(0, 32),
      evidence: ranked.slice(0, 6).map((r) => ({ id: r.id, text: `${r.label} (${r.reason})`, sourceKind: 'receipt' as const, priority: 'high' as const })),
      facts: { failedChecks: failed.length, clusters: clusters.length, changedFiles: changed.length },
      instructions: 'Which cluster most likely shares a single root cause?',
      options,
      rules: () => ({ choice: top?.id ?? 'none', reasonCode: 'LARGEST_CLUSTER' }),
      ...(cx.remainingMs === undefined ? {} : { remainingMs: cx.remainingMs }),
    });
    const chosen = clusters.find((c) => c.id === got.value);
    return advice(
      C42,
      {
        verb: 'rank',
        summary: chosen === undefined ? 'No shared cause stands out; treat the failures separately.' : `Investigate ${chosen.id} first (${String(chosen.failures)} failures across ${chosen.checks.join(', ')}). It is a hypothesis until those checks pass again.`,
        recommendation: got.value,
        ranked,
        validation: chosen === undefined ? failed.map((r) => r.receipt.checkId) : [...chosen.checks],
        evidenceIds: failed.map((r) => r.receipt.id).slice(0, 32),
        notes: ['A proposed cause is confirmed only by rerunning the listed checks.'],
      },
      got,
    );
  },
};

// ------------------------------------------------------------------ C43 patch ranking

interface PatchCandidate {
  readonly id: string;
  readonly diff: string;
  readonly passing: number;
  readonly failing: number;
}

async function patchesOf(cx: CapabilityContext, input: Rec): Promise<PatchCandidate[]> {
  const out: PatchCandidate[] = [];
  const raw = input['patches'];
  if (Array.isArray(raw)) {
    for (const p of raw.slice(0, 8)) {
      if (p === null || typeof p !== 'object') continue;
      const r = p as Rec;
      const id = typeof r['id'] === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(r['id']) ? r['id'] : null;
      const diff = typeof r['diff'] === 'string' ? r['diff'].slice(0, 64 * 1024) : null;
      if (id !== null && diff !== null) out.push({ id, diff, passing: 0, failing: 0 });
    }
  }
  // Worker patches: the diff of each named task's retained worktree against its base.
  for (const taskId of strsOf(input, 'taskIds', 8, 130)) {
    const run = workerRuns(cx.ws, taskId).at(-1);
    const wt = run?.worktreeId === null || run?.worktreeId === undefined ? undefined : getWorktree(cx.ws, run.worktreeId);
    if (wt === undefined) continue;
    const d = await diffText(cx.git, wt.path, [], wt.baseCommit, 64 * 1024);
    if (d === null) continue;
    const latest = cx.ws.receipts.latest(cx.ws.workspaceId, taskId);
    const rows = [...latest.values()].filter((r) => r.validity === 'current');
    out.push({ id: taskId, diff: d, passing: rows.filter((r) => r.receipt.outcome === 'passed').length, failing: rows.filter((r) => r.receipt.outcome === 'failed').length });
  }
  return out;
}

const C43: CapabilityDefinition = {
  id: 'C43',
  title: 'Patch-candidate ranking',
  primitive: 'Score',
  async handle(cx, input) {
    const patches = await patchesOf(cx, input);
    if (patches.length === 0) return abstainAdvice(C43, 'NO_PATCHES', 'Name candidate patches (bounded diffs) or tasks with worker worktrees.');
    const requirement = strOf(input, 'requirement', 1000);
    const ranked: RankedItem[] = [];
    let consult: { source: 'jev' | 'rules'; reasonCode: string; decisionId: string | null } = { source: 'rules', reasonCode: 'STATIC_SCORE', decisionId: null };
    for (const p of patches) {
      const lines = diffLines(p.diff);
      const size = [...lines.values()].reduce((n, l) => n + l.added.length + l.removed.length, 0);
      const staticScore = Math.max(0, Math.min(1, 0.5 + p.passing * 0.1 - p.failing * 0.25 - Math.min(0.3, size / 2000)));
      let score = staticScore;
      if (cx.engine !== undefined && requirement !== '') {
        const got = await consultScore(cx.engine, {
          capabilityId: 'C43',
          specVersion: '1',
          sendsWorkspaceText: true,
          objective: 'Choose which patch to verify first. The score accepts nothing; checks decide.',
          workspaceId: cx.ws.workspaceId,
          evidenceRevision: sha256(p.diff).slice(0, 32),
          evidence: [
            { id: 'requirement', text: requirement, sourceKind: 'user', priority: 'mandatory' },
            { id: 'diff', text: p.diff.slice(0, 3000), sourceKind: 'tool', priority: 'high' },
          ],
          facts: { linesChanged: size, filesChanged: lines.size, passingChecks: p.passing, failingChecks: p.failing },
          instructions: 'How likely is this patch to satisfy the requirement?',
          anchors: ['Unlikely to satisfy the requirement.', 'Partly addresses it.', 'Likely satisfies it.', 'Clearly satisfies it with a minimal change.'],
          rules: () => ({ score: Math.round(staticScore * 3), reasonCode: 'STATIC_SCORE' }),
          ...(cx.remainingMs === undefined ? {} : { remainingMs: cx.remainingMs }),
        });
        if (got.source === 'jev') {
          score = (got.value / 3) * 0.6 + staticScore * 0.4;
          consult = got;
        }
      }
      ranked.push({ id: p.id, label: `${p.id}: ${String(lines.size)} files, ${String(size)} lines`, score, reason: `${String(p.passing)} passing and ${String(p.failing)} failing current checks` });
    }
    ranked.sort(byScore);
    return advice(
      C43,
      {
        verb: 'rank',
        summary: `Verify ${ranked[0]?.id ?? 'none'} first. Ranking accepts no patch; its acceptance checks decide.`,
        recommendation: ranked[0]?.id ?? null,
        ranked,
        validation: ['Run the acceptance checks against the first patch before any other.'],
      },
      consult,
    );
  },
};

// ------------------------------------------------------------------ C44 review areas

export interface CodeOwnerRule {
  readonly pattern: string;
  readonly owners: readonly string[];
}

export function parseCodeOwners(text: string): readonly CodeOwnerRule[] {
  const out: CodeOwnerRule[] = [];
  for (const raw of text.split(/\r?\n/).slice(0, 2000)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (pattern === undefined || owners.length === 0) continue;
    out.push({ pattern, owners: owners.filter((o) => /^@?[A-Za-z0-9][A-Za-z0-9_.@/-]{0,99}$/.test(o)).slice(0, 16) });
  }
  return out;
}

function globRe(pattern: string): RegExp {
  // CODEOWNERS pattern syntax (a leading slash anchors at the root); not a filesystem path.
  const anchored = pattern.startsWith('/'); // path-hygiene: allow CODEOWNERS pattern syntax
  const escaped = (anchored ? pattern.slice(1) : pattern).replace(/\/+$/, '').replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const glob = escaped.replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '[^/]'); // path-hygiene: allow regular-expression text for CODEOWNERS globs
  const p = `${anchored ? '' : '(?:.*/)?'}${glob}`; // path-hygiene: allow regular-expression text for CODEOWNERS globs
  return new RegExp(`^${p}${pattern.endsWith('/') ? '/.*' : '(?:/.*)?'}$`);
}

/** CODEOWNERS owners for a path: the last matching rule wins (GitHub semantics). */
export function ownersOf(rules: readonly CodeOwnerRule[], path: string): readonly string[] {
  let owners: readonly string[] = [];
  for (const r of rules) if (globRe(r.pattern).test(path)) owners = r.owners;
  return owners;
}

const SENSITIVE = /(^|\/)(auth|authn|authz|security|crypto|secrets?|permissions?|acl|rbac|oauth|session|payments?|billing|migrations?|\.github\/workflows|Dockerfile|infra|terraform|k8s|helm)(\/|\.|$)/i;

const C44: CapabilityDefinition = {
  id: 'C44',
  title: 'Review-area prioritization',
  primitive: 'Score',
  async handle(cx, input) {
    const root = cx.ws.workspaceRoot;
    const base = baseOf(input);
    const changed = await changedFiles(cx.git, root, base);
    if (changed === null) return abstainAdvice(C44, 'NO_DIFF', 'Git could not list the change; nothing to prioritise.');
    const diff = await diffText(cx.git, root, [], base) ?? '';
    const lines = diffLines(diff);
    const co = ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'].map((p) => readBounded(root, p, 128 * 1024)).find((r) => r !== null);
    const rules = co === undefined || co === null ? [] : parseCodeOwners(co.text);
    const protectedExtra = strsOf(input, 'protectedPaths', 64, 300);
    const areas = new Map<string, { files: string[]; owners: Set<string>; sensitive: boolean; iface: number; size: number }>();
    for (const f of changed) {
      const a = areas.get(moduleOf(f)) ?? { files: [], owners: new Set<string>(), sensitive: false, iface: 0, size: 0 };
      a.files.push(f);
      for (const o of ownersOf(rules, f)) a.owners.add(o);
      if (SENSITIVE.test(f) || protectedExtra.some((p) => inScopes(f, [p]))) a.sensitive = true;
      const l = lines.get(f);
      if (l !== undefined) {
        a.size += l.added.length + l.removed.length;
        a.iface += [...l.added, ...l.removed].filter((x) => /^\s*(export|public|pub |def |func [A-Z]|interface |abstract )/.test(x)).length;
      }
      areas.set(moduleOf(f), a);
    }
    const ranked: RankedItem[] = [...areas.entries()].map(([id, a]) => ({
      id,
      label: `${id} (${String(a.files.length)} files)`,
      score: Math.min(1, (a.sensitive ? 0.5 : 0) + Math.min(0.3, a.iface * 0.05) + Math.min(0.2, a.size / 1000)),
      reason: [a.sensitive ? 'protected or sensitive area' : null, a.iface > 0 ? `${String(a.iface)} interface lines changed` : null, a.owners.size > 0 ? `owners ${[...a.owners].join(' ')}` : null].filter((x) => x !== null).join('; ') || 'routine change',
    }));
    let consult: { source: 'jev' | 'rules'; reasonCode: string; decisionId: string | null } = { source: 'rules', reasonCode: 'RISK_FACTS', decisionId: null };
    if (cx.engine !== undefined) {
      for (const [i, r] of ranked.slice(0, 3).entries()) {
        const a = areas.get(r.id);
        if (a === undefined) continue;
        const got = await consultScore(cx.engine, {
          capabilityId: 'C44',
          specVersion: '1',
          objective: 'Rate how consequential a changed area is for a reviewer. Mandatory reviewers stay regardless.',
          workspaceId: cx.ws.workspaceId,
          evidenceRevision: sha256(`${r.id}:${a.files.join(',')}`).slice(0, 32),
          evidence: [{ id: 'area', text: `${r.id}: ${a.files.slice(0, 30).join(', ')}`, sourceKind: 'tool', priority: 'high' }],
          facts: { sensitive: a.sensitive, interfaceLines: a.iface, linesChanged: a.size },
          instructions: 'How consequential is this change area for review?',
          anchors: ['Cosmetic: formatting, wording or comments only.', 'Routine: an ordinary change with no special risk.', 'Consequential: it changes behaviour that others rely on.', 'Critical: security, data or public interface.'],
          rules: () => ({ score: Math.round((r.score ?? 0) * 3), reasonCode: 'RISK_FACTS' }),
          ...(cx.remainingMs === undefined ? {} : { remainingMs: cx.remainingMs }),
        });
        if (got.source === 'jev') {
          ranked[i] = { ...r, score: Math.max(a.sensitive ? 0.5 : 0, got.value / 3) };
          consult = got;
        }
      }
    }
    ranked.sort(byScore);
    const mandatory = [...new Set([...areas.values()].flatMap((a) => [...a.owners]))].sort();
    const protectedAreas = [...areas.entries()].filter(([, a]) => a.sensitive).map(([id]) => `protected:${id}`);
    return advice(
      C44,
      {
        verb: 'rank',
        summary: `${String(ranked.length)} changed areas ranked for review; ${String(mandatory.length)} mandatory reviewers and ${String(protectedAreas.length)} protected areas are kept.`,
        ranked,
        kept: [...mandatory, ...protectedAreas],
        notes: rules.length === 0 ? ['No CODEOWNERS file: no mandatory reviewer is known.'] : [],
      },
      consult,
    );
  },
};

// ------------------------------------------------------------------ C45 requirements audit

const C45: CapabilityDefinition = {
  id: 'C45',
  title: 'Requirements-to-evidence audit',
  primitive: 'Rules+Noul',
  async handle(cx, input) {
    const task = cx.taskId === null ? undefined : getTask(cx.ws, cx.taskId);
    const requirementIds = task?.node.requirementIds ?? strsOf(input, 'requirementIds', 256, 128);
    const report = await verificationStatus(cx.ws, {
      taskId: cx.taskId,
      checkIds: [],
      ...(task === undefined ? {} : { acceptanceCheckIds: task.node.acceptanceCheckIds }),
      requirementIds,
      git: cx.git,
      ...(cx.ws.store === undefined ? {} : { store: cx.ws.store }),
    });
    const texts = input['requirementTexts'];
    const textOf = (id: string): string | null => (texts !== null && typeof texts === 'object' && typeof (texts as Rec)[id] === 'string' ? ((texts as Rec)[id] as string).slice(0, 1000) : null);
    const manifests = approvedManifests(cx.ws);
    const weak: string[] = [];
    let consult: { source: 'jev' | 'rules'; reasonCode: string; decisionId: string | null } = { source: 'rules', reasonCode: 'RECEIPT_MAPPING', decisionId: null };
    if (cx.engine !== undefined) {
      for (const id of requirementIds.filter((r) => !report.uncoveredRequirements.includes(r)).slice(0, 6)) {
        const text = textOf(id);
        if (text === null) continue;
        const checks = manifests.filter((m) => m.requirementIds.includes(id));
        const got = await consultNoul(cx.engine, {
          capabilityId: 'C45',
          specVersion: '1',
          sendsWorkspaceText: true,
          objective: 'Highlight a requirement whose mapped checks may not really cover it. Receipts still decide completion.',
          workspaceId: cx.ws.workspaceId,
          evidenceRevision: sha256(`${id}:${checks.map((c) => c.id).join(',')}`).slice(0, 32),
          evidence: [
            { id: 'requirement', text, sourceKind: 'user', priority: 'mandatory' },
            { id: 'checks', text: checks.map((c) => `${c.id}: ${c.description}`).join('; '), sourceKind: 'policy', priority: 'high' },
          ],
          instructions: 'Do the mapped checks leave part of this requirement untested?',
          whenTrue: 'Part of the requirement has no check that would fail if it broke.',
          whenFalse: 'The checks cover the requirement.',
          rules: () => ({ value: false, reasonCode: 'RECEIPT_MAPPING' }),
          ...(cx.remainingMs === undefined ? {} : { remainingMs: cx.remainingMs }),
        });
        if (got.source === 'jev') consult = got;
        if (got.value) weak.push(id);
      }
    }
    const ranked: RankedItem[] = [
      ...report.uncoveredRequirements.map((id) => ({ id, label: `${id}: no check maps to it`, score: 1, reason: 'uncovered (deterministic)' })),
      ...weak.map((id) => ({ id, label: `${id}: mapped checks may leave part untested`, score: 0.5, reason: 'highlighted for review' })),
    ];
    return advice(
      C45,
      {
        verb: ranked.length > 0 ? 'ask' : 'report',
        summary: report.uncoveredRequirements.length > 0 ? `${String(report.uncoveredRequirements.length)} requirements have no mapped check.` : weak.length > 0 ? 'Every requirement maps to a check; some mappings deserve a look.' : 'Every requirement maps to at least one check.',
        ranked,
        question: report.uncoveredRequirements[0] === undefined ? null : `Which check should prove ${report.uncoveredRequirements[0]}?`,
        kept: report.mandatoryCheckIds,
        validation: report.missingEvidence.slice(0, 32),
        notes: [`Completion stays with the receipts: ${report.verified ? 'verified' : 'not verified'}.`],
      },
      consult,
    );
  },
};

// ------------------------------------------------------------------ C46 flaky tests

const C46: CapabilityDefinition = {
  id: 'C46',
  title: 'Flaky-test investigation',
  primitive: 'Choice',
  async handle(cx, input) {
    const checkId = strOf(input, 'checkId', 128);
    if (checkId === '') return abstainAdvice(C46, 'CHECK_REQUIRED', 'Name the check to investigate.');
    const rows = cx.ws.receipts.list(cx.ws.workspaceId, { checkId }).filter((r) => r.receipt.outcome === 'passed' || r.receipt.outcome === 'failed');
    // Controlled runs: the same scoped input revision and the same environment fingerprint.
    const groups = new Map<string, { passed: number; failed: number }>();
    for (const r of rows) {
      const key = `${r.receipt.inputRevision.scopeRevision}|${r.receipt.environmentHash}`;
      const g = groups.get(key) ?? { passed: 0, failed: 0 };
      if (r.receipt.outcome === 'passed') g.passed += 1;
      else g.failed += 1;
      groups.set(key, g);
    }
    const controlled = [...groups.values()].filter((g) => g.passed + g.failed >= 2);
    const flips = controlled.filter((g) => g.passed > 0 && g.failed > 0);
    const envVariation = new Set(rows.map((r) => r.receipt.environmentHash)).size > 1 && [...groups.values()].some((g) => g.failed > 0) && [...groups.values()].some((g) => g.passed > 0);
    const rules = () =>
      flips.length > 0
        ? { choice: flips.reduce((n, g) => n + Math.min(g.passed, g.failed), 0) >= 2 ? 'quarantine-review' : 'investigate', reasonCode: 'CONTROLLED_FLIP' }
        : controlled.length === 0
          ? { choice: 'rerun-controlled', reasonCode: 'TOO_FEW_RUNS' }
          : controlled.every((g) => g.passed === 0)
            ? { choice: 'deterministic-failure', reasonCode: 'CONSISTENT_FAILURE' }
            : { choice: 'investigate', reasonCode: envVariation ? 'ENVIRONMENT_VARIATION' : 'NO_FLIP' };
    const got = await consultChoice(cx.engine, {
      capabilityId: 'C46',
      specVersion: '1',
      objective: 'Recommend how to handle a possibly flaky test from repeated controlled runs. Never disable it.',
      workspaceId: cx.ws.workspaceId,
      evidenceRevision: sha256(rows.map((r) => r.receipt.id).join(',')).slice(0, 32),
      evidence: [],
      facts: { runs: rows.length, controlledGroups: controlled.length, flippingGroups: flips.length, environmentVariation: envVariation },
      instructions: 'What should happen next with this test?',
      options: {
        investigate: 'Investigate the cause of the changing result.',
        'quarantine-review': 'Ask the owners to review a quarantine; the test keeps running.',
        'rerun-controlled': 'Rerun in the same environment to get controlled evidence.',
        'deterministic-failure': 'The failure is consistent: treat it as a real defect.',
      },
      rules,
      ...(cx.remainingMs === undefined ? {} : { remainingMs: cx.remainingMs }),
    });
    const mandatory = approvedManifests(cx.ws).find((m) => m.id === checkId)?.mandatory ?? false;
    return advice(
      C46,
      {
        verb: got.value === 'rerun-controlled' ? 'ask' : 'rank',
        summary: `${checkId}: ${got.value}. ${String(rows.length)} runs, ${String(flips.length)} controlled groups with both outcomes. The test is not disabled.`,
        recommendation: got.value,
        ranked: [...groups.entries()].map(([k, g], i) => ({ id: `group-${String(i + 1)}`, label: `${String(g.passed)} passed, ${String(g.failed)} failed`, score: null, reason: `revision and environment ${sha256(k).slice(0, 8)}` })),
        kept: mandatory ? [checkId] : [],
        validation: [`Rerun ${checkId} in the same environment at least twice.`],
        requiresApproval: got.value === 'quarantine-review',
        notes: ['A failing test is never disabled because it was called flaky; a quarantine needs its owners.'],
      },
      got,
    );
  },
};

// ------------------------------------------------------------------ C47 security escalation

const AUTH_CHANGE = /\b(auth|authori[sz]|permission|role|token|password|passwd|secret|crypto|cipher|jwt|oauth|session|csrf|cors|sanitiz|escape|eval\(|exec\(|child_process|subprocess|innerHTML|dangerouslySetInnerHTML|deserializ|pickle|yaml\.load|sql)/i;
const SCANNER = /security|audit|scan|sast|codeql|semgrep|snyk|bandit|gosec|trivy|dependency-check/i;

const C47: CapabilityDefinition = {
  id: 'C47',
  title: 'Security-review escalation',
  primitive: 'Noul',
  async handle(cx, input) {
    const root = cx.ws.workspaceRoot;
    const base = baseOf(input);
    const changed = await changedFiles(cx.git, root, base) ?? [];
    const diff = await diffText(cx.git, root, [], base) ?? '';
    const markers: RankedItem[] = [];
    for (const f of changed) if (SENSITIVE.test(f)) markers.push({ id: `path:${f}`, label: f, score: null, reason: 'sensitive path' });
    for (const [f, l] of diffLines(diff)) {
      const hits = [...l.added, ...l.removed].filter((x) => AUTH_CHANGE.test(x)).length;
      if (hits > 0) markers.push({ id: `change:${f}`, label: f, score: null, reason: `${String(hits)} authorization or unsafe-API lines changed` });
    }
    const latest = cx.ws.receipts.latest(cx.ws.workspaceId, cx.taskId);
    const manifests = approvedManifests(cx.ws);
    for (const m of manifests.filter((x) => SCANNER.test(`${x.id} ${x.description}`))) {
      const row = latest.get(m.id);
      if (row !== undefined && row.receipt.outcome === 'failed') markers.push({ id: `scanner:${m.id}`, label: m.id, score: null, reason: 'a security scanner check failed' });
    }
    const got = await consultNoul(cx.engine, {
      capabilityId: 'C47',
      specVersion: '1',
      objective: 'Decide whether a change should go to qualified security review. A no is not a certification.',
      workspaceId: cx.ws.workspaceId,
      evidenceRevision: sha256(diff.slice(0, 64 * 1024)).slice(0, 32),
      evidence: markers.slice(0, 16).map((m, i) => ({ id: `m${String(i)}`, text: `${m.label}: ${m.reason}`, sourceKind: 'tool' as const, priority: 'high' as const })),
      facts: { sensitivePaths: markers.filter((m) => m.id.startsWith('path:')).length, authorizationChanges: markers.filter((m) => m.id.startsWith('change:')).length, scannerFailures: markers.filter((m) => m.id.startsWith('scanner:')).length, changedFiles: changed.length },
      instructions: 'Should this change be escalated to qualified security review?',
      whenTrue: 'The change touches security-relevant code or a scanner found something.',
      whenFalse: 'Nothing here calls for a security reviewer.',
      // Rules escalate on any marker; Jev may add an escalation but a Jev "no" never removes a marker.
      rules: () => ({ value: markers.length > 0, reasonCode: markers.length > 0 ? 'SECURITY_MARKERS' : 'NO_MARKERS' }),
      ...(cx.remainingMs === undefined ? {} : { remainingMs: cx.remainingMs }),
    });
    const escalate = got.value || markers.length > 0;
    return advice(
      C47,
      {
        verb: escalate ? 'ask' : 'report',
        summary: escalate ? `Escalate to qualified security review: ${String(markers.length)} markers.` : 'No escalation recommended. This does not certify that the change is free of vulnerabilities.',
        recommendation: escalate ? 'security-review' : 'no-escalation',
        ranked: markers.slice(0, 64),
        requiresApproval: escalate,
        notes: ['A negative answer never certifies the absence of vulnerabilities.'],
      },
      got,
    );
  },
};

export const VERIFICATION_CAPABILITIES: readonly CapabilityDefinition[] = [C41, C42, C43, C44, C45, C46, C47];

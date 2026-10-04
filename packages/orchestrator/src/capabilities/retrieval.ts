/**
 * Tools, retrieval and environment capabilities (SSOT §12.5): C33 installed-skill shortlist,
 * C34 repository evidence retrieval, C35 documentation relevance and freshness, C36
 * tool-candidate selection, C37 tool-argument preflight, C38 environment failure triage.
 *
 * - C33 reads only trusted skill metadata (SKILL.md frontmatter name and description) from each
 *   harness's skill roots and from the workspace roots a client sends; it never loads or runs a
 *   skill body, and `none` is always offered.
 * - C34 works inside the approved workspace root, ranks lexical and symbol candidates, stores
 *   bounded original spans as evidence handles, and never reads or sends the whole repository.
 * - C35 takes freshness from metadata (git commit dates, declared versions), never a guess.
 * - C36 ranks only tools that are both available and allowlisted; invocation stays native.
 * - C37 parses arguments exactly; a parse failure or a semantic anomaly asks for review and
 *   nothing is ever auto-approved.
 * - C38 derives diagnostics from real tool output (a receipt's raw output or the loop ledger),
 *   never from caller-asserted fields, and redacts credentials from every span it shows.
 */
import { readdirSync, statSync } from 'node:fs';
import { isAbsoluteOnAnyPlatform } from '@jevris/platform';
import { isAbsolute, join, relative, sep } from 'node:path';
import { WRITE_TOOL_NAMES, withinWriteScopes } from '@jevris/core';
import { redactSecrets, safeText, sha256, tokens, type Rec } from '../util.js';
import { consultChoice, consultNoul, consultScore, type EvidenceItem } from './consult.js';
import { abstainAdvice, advice, byScore, type CapabilityContext, type CapabilityDefinition, type RankedItem } from './advice.js';
import { listFiles, pathKey, readBounded, spanAround, within } from './repo.js';

// ------------------------------------------------------------------------------ helpers

/** Words for matching: camelCase and snake_case split, lower-cased, 2+ characters. */
export function words(text: string): readonly string[] {
  return tokens(text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' '));
}

function overlap(want: ReadonlySet<string>, have: readonly string[]): number {
  if (want.size === 0) return 0;
  const seen = new Set(have);
  let n = 0;
  for (const w of want) if (seen.has(w)) n += 1;
  return n / want.size;
}

function strOf(input: Rec, key: string, max = 500): string {
  const v = input[key];
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function strsOf(input: Rec, key: string, maxItems = 64, maxLen = 500): string[] {
  const v = input[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, maxItems).map((x) => x.slice(0, maxLen)) : [];
}

function intOf(input: Rec, key: string, min: number, max: number, fallback: number): number {
  const v = input[key];
  return typeof v === 'number' && Number.isInteger(v) ? Math.max(min, Math.min(max, v)) : fallback;
}

// ------------------------------------------------------------------------ C33 skills

export interface SkillRoot {
  readonly harness: 'claude' | 'codex' | 'kilocode' | 'opencode' | 'antigravity' | 'workspace';
  readonly path: string;
}

export interface SkillEntry {
  readonly id: string;
  readonly description: string;
  readonly harnesses: readonly string[];
  readonly path: string;
}

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const WORKSPACE_SKILL_DIRS = [
  ['.claude', 'skills'],
  ['.agents', 'skills'],
  ['.agent', 'skills'],
  ['.codex', 'skills'],
  ['.kilo', 'skills'],
  ['.kilocode', 'skills'],
  ['.opencode', 'skills'],
  ['.opencode', 'skill'],
] as const;

function configHome(home: string, env: CapabilityContext['env']): string {
  const xdg = env['XDG_CONFIG_HOME'];
  return typeof xdg === 'string' && isAbsolute(xdg) ? xdg : join(home, '.config');
}

/** Codex's home: CODEX_HOME when it is an absolute path, as Codex reads it, else ~/.codex (G11). */
function codexHome(home: string, env: CapabilityContext['env']): string {
  const value = env['CODEX_HOME'];
  return typeof value === 'string' && isAbsolute(value) ? value : join(home, '.codex');
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** `skills` folders under a plugin tree, depth-bounded (plugin caches nest a few levels). */
function pluginSkillDirs(root: string, depth = 5, found: string[] = []): string[] {
  if (depth < 0 || found.length >= 64 || !isDir(root)) return found;
  let names: string[] = [];
  try {
    names = readdirSync(root).slice(0, 256);
  } catch {
    return found;
  }
  for (const name of names) {
    if (name === 'node_modules' || name.startsWith('.git')) continue;
    const full = join(root, name);
    if (!isDir(full)) continue;
    if (name === 'skills') found.push(full);
    else pluginSkillDirs(full, depth - 1, found);
  }
  return found;
}

/**
 * Each harness's native skill roots, plus the project skill folders of every workspace root
 * (the workspace itself and any roots a client sent over MCP). Duplicates are folded with the
 * platform's path case rules.
 */
export function skillRoots(home: string, env: CapabilityContext['env'], workspaceRoots: readonly string[], platform: string = process.platform): readonly SkillRoot[] {
  const config = configHome(home, env);
  const codex = codexHome(home, env);
  const roots: SkillRoot[] = [
    { harness: 'claude', path: join(home, '.claude', 'skills') },
    ...pluginSkillDirs(join(home, '.claude', 'plugins')).map((path) => ({ harness: 'claude' as const, path })),
    { harness: 'codex', path: join(codex, 'skills') },
    { harness: 'codex', path: join(home, '.agents', 'skills') },
    ...pluginSkillDirs(join(codex, 'plugins')).map((path) => ({ harness: 'codex' as const, path })),
    { harness: 'kilocode', path: join(config, 'kilo', 'skills') },
    { harness: 'kilocode', path: join(home, '.kilocode', 'skills') },
    { harness: 'opencode', path: join(config, 'opencode', 'skills') },
    { harness: 'opencode', path: join(config, 'opencode', 'skill') },
    { harness: 'antigravity', path: join(home, '.gemini', 'antigravity', 'skills') },
    ...pluginSkillDirs(join(home, '.gemini', 'antigravity', 'plugins')).map((path) => ({ harness: 'antigravity' as const, path })),
    // Where the installer puts Antigravity plugins: the IDE imports ~/.gemini/config/plugins, the
    // CLI reads ~/.gemini/antigravity-cli/plugins (G11).
    ...pluginSkillDirs(join(home, '.gemini', 'config', 'plugins')).map((path) => ({ harness: 'antigravity' as const, path })),
    ...pluginSkillDirs(join(home, '.gemini', 'antigravity-cli', 'plugins')).map((path) => ({ harness: 'antigravity' as const, path })),
  ];
  for (const root of workspaceRoots.slice(0, 8)) {
    if (!isAbsolute(root)) continue;
    for (const parts of WORKSPACE_SKILL_DIRS) roots.push({ harness: 'workspace', path: join(root, ...parts) });
  }
  const seen = new Set<string>();
  return roots.filter((r) => {
    const key = pathKey(r.path, platform);
    if (seen.has(key) || !isDir(r.path)) return false;
    seen.add(key);
    return true;
  });
}

/** SKILL.md frontmatter `name` and `description` only; the body is never read past 8 KiB. */
export function parseSkillMeta(text: string): { readonly name: string | null; readonly description: string | null } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (m === null) return { name: null, description: null };
  const field = (key: string): string | null => {
    const line = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(m[1] ?? '');
    if (line === null) return null;
    const v = (line[1] ?? '').trim().replace(/^["']|["']$/g, '');
    return v.length > 0 ? v : null;
  };
  return { name: field('name'), description: field('description') };
}

/** Installed skills from the roots, metadata only, bounded to 256 entries. */
export function discoverSkills(roots: readonly SkillRoot[], platform: string = process.platform): readonly SkillEntry[] {
  const byId = new Map<string, { id: string; description: string; harnesses: Set<string>; path: string }>();
  const seenPaths = new Set<string>();
  for (const root of roots) {
    let names: string[] = [];
    try {
      names = readdirSync(root.path).slice(0, 512);
    } catch {
      continue;
    }
    for (const dir of names.sort()) {
      if (byId.size >= 256) break;
      const read = readBounded(root.path, `${dir}/SKILL.md`, 8 * 1024); // path-hygiene: allow git-style relative path, joined by underRoot
      if (read === null) continue;
      const key = pathKey(join(root.path, dir), platform);
      if (seenPaths.has(key)) continue;
      seenPaths.add(key);
      const meta = parseSkillMeta(read.text);
      const id = meta.name !== null && SKILL_NAME.test(meta.name) ? meta.name : SKILL_NAME.test(dir) ? dir : null;
      if (id === null || id === 'none') continue;
      const existing = byId.get(id.toLowerCase());
      if (existing !== undefined) {
        existing.harnesses.add(root.harness);
        continue;
      }
      byId.set(id.toLowerCase(), { id, description: safeText(meta.description ?? '', 400), harnesses: new Set([root.harness]), path: join(root.path, dir) });
    }
  }
  return [...byId.values()].map((e) => ({ id: e.id, description: e.description, harnesses: [...e.harnesses].sort(), path: e.path }));
}

export interface SkillShortlist {
  readonly ranked: readonly (RankedItem & { readonly harnesses: readonly string[] })[];
  readonly choice: string;
  readonly source: 'jev' | 'rules';
  readonly reasonCode: string;
  readonly decisionId: string | null;
  readonly discovered: number;
}

/** Ranks installed skills for an intent; `none` is always the last option (C33). */
export async function shortlistSkills(cx: Pick<CapabilityContext, 'home' | 'env' | 'platform' | 'engine' | 'remainingMs' | 'ws'>, intent: string, clientRoots: readonly string[] = [], max = 8, useEngine = true): Promise<SkillShortlist> {
  const roots = skillRoots(cx.home, cx.env, [cx.ws.workspaceRoot, ...clientRoots.filter((r) => isAbsolute(r))], cx.platform);
  const skills = discoverSkills(roots, cx.platform);
  const want = new Set(words(intent));
  const scored = skills
    .map((s) => {
      const nameHit = words(s.id).some((w) => want.has(w)) ? 0.25 : 0;
      return { id: s.id, label: s.description === '-' ? s.id : `${s.id}: ${s.description}`, score: Math.min(1, overlap(want, words(`${s.id} ${s.description}`)) + nameHit), reason: `installed for ${s.harnesses.join(', ')}`, harnesses: s.harnesses };
    })
    .filter((s) => s.score > 0)
    .sort(byScore)
    .slice(0, Math.max(1, Math.min(max, 16)));
  const none = { id: 'none', label: 'none: no installed skill fits', score: null, reason: 'always offered', harnesses: [] as string[] };
  const top = scored[0];
  const rules = () => (top !== undefined && top.score >= 0.34 ? { choice: top.id, reasonCode: 'LEXICAL_MATCH' } : { choice: 'none', reasonCode: 'NO_SKILL_MATCH' });
  if (!useEngine || scored.length === 0) {
    const r = rules();
    return { ranked: [...scored, none], choice: r.choice, source: 'rules', reasonCode: r.reasonCode, decisionId: null, discovered: skills.length };
  }
  const options: { [key: string]: string } = { none: 'No listed skill applies to the intent.' };
  for (const s of scored) options[s.id] = s.label.slice(0, 300);
  const got = await consultChoice(cx.engine, {
    capabilityId: 'C33',
    specVersion: '1',
    sendsWorkspaceText: true,
    objective: 'Suggest the installed skill that applies to the stated intent, or none.',
    workspaceId: cx.ws.workspaceId,
    evidenceRevision: sha256(scored.map((s) => s.id).join('\n')).slice(0, 32),
    evidence: [{ id: 'intent', text: intent, sourceKind: 'user', priority: 'mandatory' }],
    instructions: 'Which listed skill applies to the intent? Choose none when no skill clearly applies.',
    options,
    rules,
    ...(cx.remainingMs === undefined ? {} : { remainingMs: cx.remainingMs }),
  });
  return { ranked: [...scored, none], choice: got.value, source: got.source, reasonCode: got.reasonCode, decisionId: got.decisionId, discovered: skills.length };
}

const C33: CapabilityDefinition = {
  id: 'C33',
  title: 'Installed-skill shortlist',
  primitive: 'Choice',
  async handle(cx, input) {
    const intent = strOf(input, 'intent');
    if (intent.trim() === '') return abstainAdvice(C33, 'INTENT_REQUIRED', 'Name the intent to shortlist skills for.');
    const list = await shortlistSkills(cx, intent, strsOf(input, 'roots', 8, 4096), intOf(input, 'maxItems', 1, 16, 8));
    return advice(
      C33,
      {
        verb: 'rank',
        summary: list.choice === 'none' ? `None of ${String(list.discovered)} installed skills clearly fits.` : `Suggested skill: ${list.choice}. Loading it stays with the harness and the user.`,
        recommendation: list.choice,
        ranked: list.ranked,
        notes: ['Only skill metadata was read; no skill body was loaded or run.'],
        reasonCode: list.reasonCode,
      },
      list,
    );
  },
};

// ------------------------------------------------------------------ C34 repository evidence

const TEXT_EXT = /\.(c|cc|cpp|cs|css|cxx|go|gradle|h|hpp|html|java|js|json|jsx|kt|kts|lua|m|md|mjs|cjs|php|proto|py|rb|rs|scala|sh|sql|swift|toml|ts|tsx|txt|vue|xml|ya?ml)$/i;
const SYMBOL_DEF = /\b(?:function|class|def|fn|func|interface|type|struct|enum|trait|impl|module|const|let|var|export)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
const SCAN_FILES = 600;
const SCAN_BYTES = 12 * 1024 * 1024;

export interface SpanCandidate {
  readonly path: string;
  readonly line: number;
  readonly score: number;
  readonly symbol: string | null;
  readonly reason: string;
}

/** Lexical (path and line) and symbol candidates for a query, inside the root, bounded. */
export async function repositoryCandidates(cx: Pick<CapabilityContext, 'git'>, root: string, query: string, limit = 24): Promise<{ readonly candidates: readonly SpanCandidate[]; readonly scannedFiles: number; readonly scannedBytes: number; readonly listed: boolean }> {
  const want = new Set(words(query));
  const files = await listFiles(cx.git, root) ?? [];
  const pathScore = (p: string) => overlap(want, words(p));
  const ordered = files.filter((f) => TEXT_EXT.test(f) && !/(^|\/)(node_modules|dist|build|vendor|\.git)\//.test(f)).sort((a, b) => pathScore(b) - pathScore(a) || (a < b ? -1 : 1));
  const out: SpanCandidate[] = [];
  let bytes = 0;
  let scanned = 0;
  for (const file of ordered) {
    if (scanned >= SCAN_FILES || bytes >= SCAN_BYTES) break;
    const read = readBounded(root, file);
    if (read === null) continue;
    scanned += 1;
    bytes += read.text.length;
    const lines = read.text.split(/\r?\n/);
    const ps = pathScore(file);
    let best: SpanCandidate | null = null;
    for (let i = 0; i < lines.length && i < 20_000; i += 1) {
      const text = lines[i] ?? '';
      if (text.length > 2000) continue;
      const lw = words(text);
      const lex = overlap(want, lw);
      let symbol: string | null = null;
      SYMBOL_DEF.lastIndex = 0;
      for (let m = SYMBOL_DEF.exec(text); m !== null; m = SYMBOL_DEF.exec(text)) {
        const name = m[1] ?? '';
        if (words(name).some((w) => want.has(w))) symbol = name;
      }
      const score = lex * 0.6 + ps * 0.25 + (symbol === null ? 0 : 0.35);
      if (score <= 0.15) continue;
      if (best === null || score > best.score) best = { path: file, line: i + 1, score: Math.min(1, score), symbol, reason: symbol !== null ? `defines ${symbol}` : ps > 0 ? 'path and text match' : 'text match' };
    }
    if (best !== null) out.push(best);
  }
  out.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));
  return { candidates: out.slice(0, limit), scannedFiles: scanned, scannedBytes: bytes, listed: files.length > 0 };
}

const C34: CapabilityDefinition = {
  id: 'C34',
  title: 'Repository evidence retrieval',
  primitive: 'Score',
  async handle(cx, input) {
    const query = strOf(input, 'query') || strOf(input, 'intent');
    if (query.trim() === '') return abstainAdvice(C34, 'QUERY_REQUIRED', 'Name what the evidence is for.');
    const root = cx.ws.workspaceRoot;
    const maxItems = intOf(input, 'maxItems', 1, 16, 6);
    const found = await repositoryCandidates(cx, root, query);
    if (found.candidates.length === 0) {
      return advice(C34, { verb: 'report', summary: found.listed ? 'No span in the approved workspace matches the query.' : 'The workspace could not be listed through git; nothing was read.', reasonCode: found.listed ? 'NO_MATCH' : 'NOT_LISTED' });
    }
    // Jev scores the top candidates' spans when time allows; the rules score stays otherwise.
    const pool = found.candidates.slice(0, Math.min(8, maxItems * 2));
    const ranked: (RankedItem & { readonly path: string; readonly line: number })[] = [];
    let source: 'jev' | 'rules' = 'rules';
    let decisionId: string | null = null;
    for (const c of pool) {
      const read = readBounded(root, c.path);
      const span = read === null ? null : spanAround(read.text, c.line);
      let score = c.score;
      if (span !== null && cx.engine !== undefined && (cx.remainingMs === undefined || cx.remainingMs > 2_000)) {
        const r = await consultScore(cx.engine, {
          capabilityId: 'C34',
          specVersion: '1',
          objective: 'Rank a repository span as evidence for the stated task.',
          workspaceId: cx.ws.workspaceId,
          evidenceRevision: sha256(`${c.path}:${String(c.line)}:${span.text}`).slice(0, 32),
          evidence: [
            { id: 'task', text: query, sourceKind: 'user', priority: 'mandatory' },
            { id: 'span', text: span.text, sourceKind: 'file', priority: 'high' },
          ],
          instructions: 'How relevant is this source span to the task?',
          anchors: ['Unrelated to the task.', 'Mentions the topic only.', 'Relevant context for the task.', 'Directly shows the code the task is about.'],
          rules: () => ({ score: Math.round(c.score * 3), reasonCode: 'LEXICAL_SCORE' }),
          ...(cx.remainingMs === undefined ? {} : { remainingMs: cx.remainingMs }),
        });
        if (r.source === 'jev') {
          source = 'jev';
          decisionId = decisionId ?? r.decisionId;
          score = r.value / 3;
        }
      }
      ranked.push({ id: `${c.path}#L${String(span?.start ?? c.line)}-${String(span?.end ?? c.line)}`, label: `${c.path}:${String(c.line)}`, score, reason: c.reason, path: c.path, line: c.line });
    }
    ranked.sort(byScore);
    // Bounded originals: each chosen span is stored as an evidence handle (redacted, <= 4 KiB).
    const handles: string[] = [];
    const items: RankedItem[] = [];
    for (const r of ranked.slice(0, maxItems)) {
      const read = readBounded(root, r.path);
      if (read === null) continue;
      const span = spanAround(read.text, r.line);
      const meta = await cx.ws.evidence.put({ workspaceId: cx.ws.workspaceId, kind: 'source-span', bytes: new TextEncoder().encode(redactSecrets(`${r.path}:${String(span.start)}-${String(span.end)}\n${span.text}`)), truncated: read.truncated, nowMs: cx.nowMs });
      handles.push(meta.handle);
      items.push({ id: meta.handle, label: r.label, score: r.score, reason: r.reason });
    }
    return advice(
      C34,
      {
        verb: 'rank',
        summary: `${String(items.length)} bounded spans from ${String(found.scannedFiles)} scanned files in the approved workspace; fetch each with evidence.get.`,
        ranked: items,
        evidenceIds: handles,
        notes: [`Scanned ${String(found.scannedFiles)} files (${String(Math.round(found.scannedBytes / 1024))} KiB) inside the workspace root; the repository was not uploaded.`],
        reasonCode: source === 'jev' ? 'JEV_SCORE' : 'LEXICAL_SCORE',
      },
      { source, reasonCode: source === 'jev' ? 'JEV_SCORE' : 'LEXICAL_SCORE', decisionId },
    );
  },
};

// ------------------------------------------------------------------ C35 documentation

const DOC_FILE = /(^|\/)(readme|changelog|contributing|docs?\/[^/]+|[^/]+\.(md|mdx|rst|adoc))$/i;

const C35: CapabilityDefinition = {
  id: 'C35',
  title: 'Documentation relevance and freshness',
  primitive: 'Score',
  async handle(cx, input) {
    const query = strOf(input, 'query') || strOf(input, 'intent');
    if (query.trim() === '') return abstainAdvice(C35, 'QUERY_REQUIRED', 'Name what the documentation is for.');
    const root = cx.ws.workspaceRoot;
    const want = new Set(words(query));
    const files = (await listFiles(cx.git, root) ?? []).filter((f) => DOC_FILE.test(f)).slice(0, 2000);
    const pkg = readBounded(root, 'package.json', 64 * 1024);
    const deps = new Map<string, string>();
    if (pkg !== null) {
      try {
        const j = JSON.parse(pkg.text) as { dependencies?: Rec; devDependencies?: Rec };
        for (const [k, v] of Object.entries({ ...(j.devDependencies ?? {}), ...(j.dependencies ?? {}) })) if (typeof v === 'string') deps.set(k, v);
      } catch {
        // an unreadable manifest gives no version metadata
      }
    }
    const scored: (RankedItem & { readonly lastChanged: string | null })[] = [];
    for (const f of files) {
      const read = readBounded(root, f, 128 * 1024);
      if (read === null) continue;
      const s = overlap(want, words(`${f} ${read.text.slice(0, 32 * 1024)}`));
      if (s <= 0) continue;
      // Freshness is metadata: the file's last commit date from git, or unknown. Never guessed.
      const log = await cx.git.run(['log', '-1', '--format=%cI', '--', f], root);
      const lastChanged = log.ok && /^\d{4}-\d{2}-\d{2}T/.test(log.stdout.trim()) ? log.stdout.trim() : null;
      const versions = [...deps.entries()].filter(([name]) => read.text.includes(name)).slice(0, 3).map(([n, v]) => `${n}@${v}`);
      scored.push({ id: f, label: f, score: s, reason: `${lastChanged === null ? 'freshness unknown (no commit metadata)' : `last changed ${lastChanged}`}${versions.length > 0 ? `; mentions ${versions.join(', ')}` : ''}`, lastChanged });
    }
    scored.sort(byScore);
    const top = scored.slice(0, intOf(input, 'maxItems', 1, 16, 6));
    let consult: { source: 'jev' | 'rules'; reasonCode: string; decisionId: string | null } = { source: 'rules', reasonCode: 'LEXICAL_SCORE', decisionId: null };
    const first = top[0];
    if (first !== undefined && cx.engine !== undefined) {
      const text = readBounded(root, first.id, 8 * 1024)?.text ?? '';
      const r = await consultScore(cx.engine, {
        capabilityId: 'C35',
        specVersion: '1',
        objective: 'Rate how authoritative and relevant the top document is for the task. Do not estimate dates.',
        workspaceId: cx.ws.workspaceId,
        evidenceRevision: sha256(`${first.id}:${first.lastChanged ?? ''}`).slice(0, 32),
        evidence: [
          { id: 'task', text: query, sourceKind: 'user', priority: 'mandatory' },
          { id: 'doc', text: text.slice(0, 3000), sourceKind: 'file', priority: 'high' },
        ],
        instructions: 'How relevant is this document to the task?',
        anchors: ['Not relevant to the task.', 'Background only.', 'Relevant to the task.', 'The authoritative reference for the task.'],
        rules: () => ({ score: Math.round((first.score ?? 0) * 3), reasonCode: 'LEXICAL_SCORE' }),
        ...(cx.remainingMs === undefined ? {} : { remainingMs: cx.remainingMs }),
      });
      consult = r;
    }
    return advice(
      C35,
      {
        verb: top.length === 0 ? 'report' : 'rank',
        summary: top.length === 0 ? 'No workspace document matches.' : `${String(top.length)} documents ranked; freshness is from git metadata only.`,
        ranked: top,
        notes: ['Dates come from commit metadata; a document without metadata is marked unknown, never guessed.'],
      },
      consult,
    );
  },
};

// ------------------------------------------------------------------ C36 tool selection

interface ToolCandidate {
  readonly id: string;
  readonly description: string;
  readonly effects: readonly string[];
}

function toolsOf(input: Rec): readonly ToolCandidate[] {
  const raw = input['tools'];
  if (!Array.isArray(raw)) return [];
  const out: ToolCandidate[] = [];
  for (const t of raw.slice(0, 128)) {
    if (t === null || typeof t !== 'object') continue;
    const r = t as Rec;
    const id = typeof r['id'] === 'string' && SKILL_NAME.test(r['id']) ? r['id'] : null;
    if (id === null) continue;
    out.push({ id, description: typeof r['description'] === 'string' ? r['description'].slice(0, 300) : '', effects: strsOf(r, 'effects', 8, 32) });
  }
  return out;
}

const C36: CapabilityDefinition = {
  id: 'C36',
  title: 'Tool-candidate selection',
  primitive: 'Choice',
  async handle(cx, input) {
    const intent = strOf(input, 'intent');
    const allow = new Set(strsOf(input, 'allowlist', 256, 64));
    const permitted = new Set(strsOf(input, 'permittedEffects', 8, 32));
    const tools = toolsOf(input);
    // Eligible: available, on the allowlist, and every effect permitted in this phase.
    const eligible = tools.filter((t) => allow.has(t.id) && (permitted.size === 0 || t.effects.every((e) => permitted.has(e))));
    const refused = tools.filter((t) => !eligible.includes(t)).map((t) => t.id);
    const want = new Set(words(intent));
    const ranked = eligible.map((t) => ({ id: t.id, label: `${t.id}: ${t.description}`, score: overlap(want, words(`${t.id} ${t.description}`)), reason: t.effects.length === 0 ? 'no declared effects' : `effects: ${t.effects.join(', ')}` })).sort(byScore);
    if (ranked.length === 0) return advice(C36, { verb: 'pause', summary: 'No available tool is on the allowlist for this phase; the allowlist was not expanded.', recommendation: 'none', notes: refused.length > 0 ? [`Not eligible: ${refused.slice(0, 16).join(', ')}`] : [], reasonCode: 'NO_ELIGIBLE_TOOL' });
    const options: { [key: string]: string } = { none: 'No eligible tool fits the intent.' };
    for (const r of ranked.slice(0, 12)) options[r.id] = r.label;
    const top = ranked[0];
    const got = await consultChoice(cx.engine, {
      capabilityId: 'C36',
      specVersion: '1',
      sendsWorkspaceText: true,
      objective: 'Rank eligible tools for the next step. Only the listed tools may be chosen.',
      workspaceId: cx.ws.workspaceId,
      evidenceRevision: sha256(ranked.map((r) => r.id).join(',')).slice(0, 32),
      evidence: [{ id: 'intent', text: intent, sourceKind: 'user', priority: 'mandatory' }],
      instructions: 'Which eligible tool best fits the next step? Choose none if none fits.',
      options,
      rules: () => (top !== undefined && (top.score ?? 0) > 0 ? { choice: top.id, reasonCode: 'LEXICAL_MATCH' } : { choice: 'none', reasonCode: 'NO_TOOL_MATCH' }),
      ...(cx.remainingMs === undefined ? {} : { remainingMs: cx.remainingMs }),
    });
    return advice(
      C36,
      {
        verb: 'rank',
        summary: got.value === 'none' ? 'No eligible tool clearly fits.' : `Suggested tool: ${got.value}. Invoking it stays behind the harness's native permissions.`,
        recommendation: got.value,
        ranked,
        notes: refused.length > 0 ? [`Not eligible (not allowlisted or effect not permitted): ${refused.slice(0, 16).join(', ')}`] : [],
      },
      got,
    );
  },
};

// ------------------------------------------------------------------ C37 argument preflight

export interface ParsedCommand {
  readonly ok: boolean;
  readonly argv: readonly string[];
  readonly operators: readonly string[];
  readonly error: string | null;
}

/** An exact POSIX-shell-style word parser: quotes, escapes and control operators. */
export function parseShell(command: string): ParsedCommand {
  const argv: string[] = [];
  const operators: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] ?? '';
    if (quote !== null) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < command.length) cur += command[++i] ?? '';
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      cur += command[++i] ?? '';
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has || cur.length > 0) argv.push(cur);
      cur = '';
      has = false;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === '>>' || two === '$(') {
      if (has || cur.length > 0) argv.push(cur);
      cur = '';
      has = false;
      operators.push(two);
      i += 1;
      continue;
    }
    if (ch === '|' || ch === ';' || ch === '>' || ch === '<' || ch === '&' || ch === '`') {
      if (has || cur.length > 0) argv.push(cur);
      cur = '';
      has = false;
      operators.push(ch);
      continue;
    }
    cur += ch;
  }
  if (quote !== null) return { ok: false, argv, operators, error: 'unterminated quote' };
  if (has || cur.length > 0) argv.push(cur);
  return { ok: argv.length > 0, argv, operators, error: argv.length > 0 ? null : 'empty command' };
}

const SENSITIVE_PATH = /(^|[\\/])(\.ssh|\.aws|\.gnupg|\.git[\\/]config|\.env(\.|$)|id_rsa|id_ed25519|credentials|\.npmrc|\.netrc|\.docker[\\/]config\.json)/i;

/** Deterministic anomalies in a parsed command or file-tool path; each one asks for review. */
export function argumentAnomalies(tool: string, args: Rec, root: string, writeScopes: readonly string[]): readonly string[] {
  const out: string[] = [];
  const pathArg = ['file_path', 'filePath', 'path', 'notebook_path', 'TargetFile', 'target_file'].map((k) => args[k]).find((v): v is string => typeof v === 'string');
  if (pathArg !== undefined) {
    const abs = isAbsolute(pathArg) ? pathArg : join(root, pathArg);
    if (!within(root, abs)) out.push('the path is outside the workspace');
    if (SENSITIVE_PATH.test(pathArg)) out.push('the path names credentials or secrets');
    // Every harness's write tools (Claude, Codex, OpenCode, Kilo, Antigravity); scopes are the
    // TaskNode write-scope patterns (a directory covers what is below it, * and ** globs).
    if (WRITE_TOOL_NAMES.has(tool) && writeScopes.length > 0 && within(root, abs)) {
      const rel = relative(root, abs).split(sep).join('/');
      if (!withinWriteScopes(rel, writeScopes)) out.push('the write is outside the task write scopes');
    }
  }
  const command = typeof args['command'] === 'string' ? args['command'] : null;
  if (command !== null) {
    const p = parseShell(command);
    if (!p.ok) out.push(`the command does not parse: ${p.error ?? 'unknown'}`);
    const head = (p.argv[0] ?? '').replace(/^.*[\\/]/, '');
    if (/^(rm|rmdir|del|shred)$/.test(head) && p.argv.some((a) => /^-[a-zA-Z]*[rf]/.test(a)) && p.argv.slice(1).some((a) => a === '/' || a === '~' || a === '*' || isAbsoluteOnAnyPlatform(a) || a.startsWith('~') || a.includes('..'))) out.push('a recursive delete reaches outside the workspace');
    if (p.operators.includes('|') && p.argv.some((a) => /^(sh|bash|zsh|pwsh|powershell|python3?|node)$/.test(a)) && p.argv.some((a) => /^(curl|wget|iwr|Invoke-WebRequest)$/i.test(a))) out.push('downloaded content is piped into an interpreter');
    if (p.argv.some((a) => SENSITIVE_PATH.test(a))) out.push('the command touches credentials or secrets');
    if (/^git$/.test(head) && p.argv.includes('push') && p.argv.some((a) => a === '--force' || a === '-f' || a.startsWith('+'))) out.push('a force push rewrites shared history');
    if (p.operators.includes('$(') || p.operators.includes('`')) out.push('the command substitutes another command');
  }
  return out;
}

const C37: CapabilityDefinition = {
  id: 'C37',
  title: 'Tool-argument preflight',
  primitive: 'Rules+Noul',
  async handle(cx, input) {
    const tool = strOf(input, 'tool', 64);
    const args = input['args'];
    if (tool === '' || args === null || typeof args !== 'object' || Array.isArray(args)) return abstainAdvice(C37, 'ARGUMENTS_REQUIRED', 'Pass the tool name and its parsed arguments.');
    const scopes = strsOf(input, 'writeScopes', 64, 400);
    const anomalies = argumentAnomalies(tool, args as Rec, cx.ws.workspaceRoot, scopes);
    let semantic = false;
    let consult: { source: 'jev' | 'rules'; reasonCode: string; decisionId: string | null } = { source: 'rules', reasonCode: anomalies.length > 0 ? 'PARSER_ANOMALY' : 'PARSED_CLEAN', decisionId: null };
    if (anomalies.length === 0 && cx.engine !== undefined) {
      // Jev can only add a reason to review; it never approves anything.
      const r = await consultNoul(cx.engine, {
        capabilityId: 'C37',
        specVersion: '1',
        objective: 'Flag a tool call whose arguments look semantically out of place for the task.',
        workspaceId: cx.ws.workspaceId,
        evidenceRevision: sha256(JSON.stringify(args).slice(0, 4000)).slice(0, 32),
        evidence: [{ id: 'call', text: `${tool} ${JSON.stringify(args).slice(0, 2000)}`, sourceKind: 'tool', priority: 'mandatory' }],
        instructions: 'Do these arguments look anomalous for a routine development step?',
        whenTrue: 'Something about the arguments is unusual and a person should look.',
        whenFalse: 'Nothing unusual stands out.',
        rules: () => ({ value: false, reasonCode: 'PARSED_CLEAN' }),
        ...(cx.remainingMs === undefined ? {} : { remainingMs: cx.remainingMs }),
      });
      semantic = r.value;
      consult = r;
    }
    const review = anomalies.length > 0 || semantic;
    return advice(
      C37,
      {
        verb: review ? 'pause' : 'report',
        summary: review ? 'Review this tool call before it runs.' : 'The arguments parse and no anomaly was found. This is not an approval; the harness still asks as it normally would.',
        recommendation: review ? 'review' : 'native-permission',
        ranked: anomalies.map((a, i) => ({ id: `anomaly-${String(i + 1)}`, label: a, score: null, reason: 'deterministic parser rule' })),
        notes: semantic ? ['Jev flagged a semantic anomaly; a person reviews it.'] : [],
        requiresApproval: review,
      },
      consult,
    );
  },
};

// ------------------------------------------------------------------ C38 environment triage

export type EnvironmentKind = 'missing-command' | 'missing-service' | 'network' | 'permission' | 'missing-variable' | 'package-manager' | 'toolchain-version' | 'container-runtime';

export interface EnvironmentDiagnostic {
  readonly kind: EnvironmentKind;
  readonly subject: string;
  readonly line: number;
  readonly excerpt: string;
}

const ENV_RULES: readonly { readonly kind: EnvironmentKind; readonly re: RegExp }[] = [
  { kind: 'missing-command', re: /(?:command not found:?\s*([A-Za-z0-9_.+-]+)|([A-Za-z0-9_.+-]+): command not found|'([^']+)' is not recognized as an internal or external command|spawn ([^\s]+) ENOENT)/i },
  { kind: 'container-runtime', re: /(cannot connect to the docker daemon|docker daemon is not running|error during connect.*docker)/i },
  { kind: 'missing-service', re: /(?:ECONNREFUSED\s*([0-9a-z.:[\]-]+)?|connection refused|could not connect to (?:server|database)|service unavailable|redis.*(?:connection|refused))/i },
  { kind: 'network', re: /(?:ENOTFOUND\s*([A-Za-z0-9.-]+)?|EAI_AGAIN|getaddrinfo|could not resolve host:?\s*([A-Za-z0-9.-]+)?|network is unreachable|ETIMEDOUT)/i },
  { kind: 'permission', re: /(EACCES|EPERM|permission denied)/i },
  { kind: 'missing-variable', re: /(?:environment variable ([A-Z][A-Z0-9_]{1,63}) (?:is )?(?:not set|missing|required)|([A-Z][A-Z0-9_]{1,63}) (?:is )?not set|missing required env(?:ironment)? var(?:iable)?:?\s*([A-Z][A-Z0-9_]{1,63})?)/ },
  { kind: 'package-manager', re: /(npm ERR! code (E404|ERESOLVE|ENOTFOUND|EINTEGRITY)|No matching distribution found for ([^\s]+)|Could not resolve dependencies|error: failed to download|could not find a version that satisfies)/i },
  { kind: 'toolchain-version', re: /(engine "?node"? is incompatible|requires? (?:node|python|go|java|rustc) ?(?:version )?[>=^~]+ ?[0-9.]+|unsupported (?:engine|platform)|unsupported class file major version)/i },
];

/** Diagnostics from real tool output, credentials redacted from every excerpt. */
export function triageEnvironmentText(text: string): readonly EnvironmentDiagnostic[] {
  const out: EnvironmentDiagnostic[] = [];
  const lines = text.split(/\r?\n/).slice(0, 20_000);
  for (let i = 0; i < lines.length && out.length < 32; i += 1) {
    const line = lines[i] ?? '';
    for (const rule of ENV_RULES) {
      const m = rule.re.exec(line);
      if (m === null) continue;
      const subject = (m.slice(1).find((g) => typeof g === 'string' && g.length > 0 && g.length <= 128) ?? rule.kind).replace(/[^A-Za-z0-9_.:@[\]/+-]/g, '');
      const excerpt = safeText(redactSecrets(line.replace(/:\/\/[^/\s:@]+:[^@\s]+@/g, '://[redacted]@')), 240);
      out.push({ kind: rule.kind, subject: subject.length > 0 ? subject.slice(0, 80) : rule.kind, line: i + 1, excerpt });
      break;
    }
  }
  return out;
}

const SOURCE_DEFECT = /\berror ts\d+|\berror\[e\d+\]|syntaxerror|typeerror|referenceerror|assertionerror|expected .* (?:to|but)|\bnot ok \d+|compil(?:e|ation) (?:error|failed)|undefined reference|cannot find symbol/i;

/** The real output a triage reads: a receipt's raw output, or an evidence handle, never caller text. */
function outputFor(cx: CapabilityContext, input: Rec): { readonly text: string; readonly ref: string } | null {
  const receiptId = strOf(input, 'receiptId', 64);
  const checkId = strOf(input, 'checkId', 128);
  const handleIn = strOf(input, 'handle', 140);
  let handle: string | null = handleIn !== '' ? handleIn : null;
  let ref = handle ?? '';
  if (handle === null) {
    const row = receiptId !== '' ? cx.ws.receipts.get(cx.ws.workspaceId, receiptId) : checkId !== '' ? cx.ws.receipts.latest(cx.ws.workspaceId, cx.taskId).get(checkId) : [...cx.ws.receipts.latest(cx.ws.workspaceId, cx.taskId).values()].filter((r) => r.receipt.outcome !== 'passed').sort((a, b) => b.recordedAtMs - a.recordedAtMs)[0];
    if (row === undefined) return null;
    handle = row.receipt.rawOutputHandle;
    ref = row.receipt.id;
    if (handle === null) return { text: `${row.receipt.outcomeReason}`, ref };
  }
  const bytes = cx.ws.evidence.get(handle, cx.ws.workspaceId);
  return bytes === undefined ? null : { text: new TextDecoder().decode(bytes.subarray(0, 2 * 1024 * 1024)), ref };
}

const C38: CapabilityDefinition = {
  id: 'C38',
  title: 'Environment failure triage',
  primitive: 'Choice',
  async handle(cx, input) {
    const out = outputFor(cx, input);
    if (out === null) return abstainAdvice(C38, 'NO_TOOL_OUTPUT', 'No recorded tool output to triage: run the check first, or name a receipt or evidence handle.');
    const diags = triageEnvironmentText(out.text);
    const sourceLines = out.text.split(/\r?\n/).filter((l) => SOURCE_DEFECT.test(l)).length;
    const rules = () =>
      diags.length > 0 && diags.length >= sourceLines ? { choice: 'environment', reasonCode: 'ENVIRONMENT_SIGNATURE' } : sourceLines > 0 ? { choice: 'source', reasonCode: 'SOURCE_SIGNATURE' } : { choice: 'unclear', reasonCode: 'NO_SIGNATURE' };
    const evidence: EvidenceItem[] = diags.slice(0, 8).map((d, i) => ({ id: `d${String(i)}`, text: `${d.kind} ${d.subject}: ${d.excerpt}`, sourceKind: 'tool', priority: 'high' }));
    const got = await consultChoice(cx.engine, {
      capabilityId: 'C38',
      specVersion: '1',
      objective: 'Tell a source defect from missing tooling or an unavailable service.',
      workspaceId: cx.ws.workspaceId,
      evidenceRevision: sha256(out.text.slice(0, 64 * 1024)).slice(0, 32),
      evidence,
      facts: { environmentSignals: diags.length, sourceSignals: sourceLines },
      instructions: 'Is this failure caused by the environment, by the source code, or is it unclear?',
      options: { environment: 'A missing tool, service, variable, permission or network.', source: 'A defect in the code or tests.', unclear: 'The output does not show which.' },
      rules,
      ...(cx.remainingMs === undefined ? {} : { remainingMs: cx.remainingMs }),
    });
    const kinds = [...new Set(diags.map((d) => d.kind))];
    return advice(
      C38,
      {
        verb: 'rank',
        summary: got.value === 'environment' ? `The failure looks environmental (${kinds.join(', ')}). Fix the environment before changing code.` : got.value === 'source' ? 'The failure looks like a source defect.' : 'The output does not show whether the environment or the source is at fault.',
        recommendation: got.value,
        ranked: diags.slice(0, 16).map((d, i) => ({ id: `${d.kind}-${String(i + 1)}`, label: `${d.kind}: ${d.subject}`, score: null, reason: `line ${String(d.line)}: ${d.excerpt}` })),
        question: got.value === 'environment' && kinds.includes('missing-service') ? 'Is the required service meant to be running locally for this check?' : null,
        validation: ['Rerun the check once after fixing the environment.'],
        evidenceIds: [out.ref],
        notes: ['Diagnostics come from the recorded tool output; credentials are redacted from every excerpt.'],
      },
      got,
    );
  },
};

export const RETRIEVAL_CAPABILITIES: readonly CapabilityDefinition[] = [C33, C34, C35, C36, C37, C38];

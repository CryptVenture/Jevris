/**
 * Jev capability cases, part A: the orchestration capabilities (C25 dependency suggestions, C26
 * worker-role allocation, C28 duplicate-work detection, C30 handoff readiness) and the tools and
 * retrieval capabilities (C33 skill shortlist, C34 repository evidence, C35 documentation, C36 tool
 * selection, C37 argument preflight, C38 environment triage).
 *
 * Each case names the Jev consult it reaches (`site`), the setup that makes the handler get there
 * (`steps`: ops and workspace edits, run in order against one sidecar and one workspace) and the one
 * call that asks. The driver is `jev-feature-driver.mjs`; the offline proof is
 * `apps/sidecar/test/jev-feature-cases-a.test.mjs`, which runs these cases against the Jev stub.
 *
 * Every free-text field carries a case-specific `ZZMARKER-<id>` string, so a test can prove that no
 * request carries it while source egress is denied.
 *
 * Setup that is not an op is `preparePart`, which a runner calls after it wrote `FILES` into the
 * workspace and before it starts the sidecar:
 *   - it writes the host policy (`host.json`) with the egress decision and the mode;
 *   - it writes `jevris.checks.json` (`CHECKS`) and approves it as a person's `verify approve` does,
 *     because a plan accepts only approved runner checks. The plan steps use `channel: 'terminal'`
 *     (what the CLI sends after a person answers y), which creates the root budget.
 * Owned workers must not start: run with the mode `advise` (or `routing.managedWorkers` below
 * `bounded-auto`), or `plan.submit` leases the tasks and a worker port may launch a real harness.
 * `preparePart` uses only the product's built packages, so it also runs outside `node:test`.
 */
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------- workspace files

/** The log C38 triages. Six lines, so the span C34 stores is the whole file (see `LOG_HANDLE`). */
const LOG_PATH = 'caseA/c38/ci-output.txt';
const LOG_TEXT = [
  '> caseA-app@1.0.0 test',
  '> node --test caseA',
  'sh: 1: vitest: command not found',
  'Error: connect ECONNREFUSED 127.0.0.1:5432 ZZMARKER-C38',
  'npm error code ELIFECYCLE',
  'zzc38uniq end of the recorded output',
].join('\n');

/**
 * The evidence handle of the span C34 stores for the log (`ev:` and the sha256 of the stored
 * bytes, `<path>:<first line>-<last line>` then the span). C38 reads a recorded output by handle, and
 * no op stores caller text, so the C38 case first asks C34 for the one file that holds `zzc38uniq`.
 */
export const LOG_HANDLE = `ev:${createHash('sha256').update(`${LOG_PATH}:1-${String(LOG_TEXT.split('\n').length)}\n${LOG_TEXT}`).digest('hex')}`;

export const FILES = {
  'caseA/README.md': '# Case A fixtures\n\nSmall files the part A capability cases read. Nothing here is a real project.\n',
  // C34: the file the retrieval query is about, and a weaker neighbour.
  'caseA/c34/payment-client.ts': [
    '// ZZMARKER-C34 internal note: do not copy this file out of the repository',
    'export interface PaymentRequest { amountCents: number; currency: string }',
    '',
    'export async function retryWithBackoff(send: () => Promise<number>, attempts = 4): Promise<number> {',
    '  let delayMs = 100;',
    '  for (let attempt = 1; attempt <= attempts; attempt += 1) {',
    '    try {',
    '      return await send();',
    '    } catch (error) {',
    '      if (attempt === attempts) throw error;',
    '      await new Promise((resolve) => setTimeout(resolve, delayMs));',
    '      delayMs *= 2; // exponential backoff between payment attempts',
    '    }',
    '  }',
    '  return 0;',
    '}',
    '',
  ].join('\n'),
  'caseA/c34/notes.md': '# Payment notes\n\nThe payment client retries with backoff. See retryWithBackoff.\n',
  // C35: documentation the freshness read ranks.
  'caseA/docs/retry-policy.md': [
    '# Retry policy',
    '',
    'Payment calls retry with exponential backoff, at most four attempts. ZZMARKER-C35 maintainer note.',
    'A call that still fails is reported to the caller; nothing retries forever.',
    '',
  ].join('\n'),
  // C37: a file the previewed tool call would touch.
  'caseA/c37/config.json': '{ "retries": 4 }\n',
  // C38: tool output kept as evidence.
  [LOG_PATH]: LOG_TEXT,
  // C33: installed skills (project skill folders are read as metadata only).
  '.claude/skills/casea-review/SKILL.md': '---\nname: casea-review\ndescription: Review a pull request diff for correctness bugs and style. ZZMARKER-C33\n---\n\nReview the diff.\n',
  '.claude/skills/casea-security/SKILL.md': '---\nname: casea-security\ndescription: Review code changes for security problems such as injection. ZZMARKER-C33\n---\n\nLook for unsafe input handling.\n',
  '.claude/skills/casea-docs/SKILL.md': '---\nname: casea-docs\ndescription: Write documentation pages and changelog entries\n---\n\nWrite docs.\n',
  // C26: installed agents. The first two inherit every tool; the others list theirs.
  '.claude/agents/casea-helper-one.md': '---\nname: casea-helper-one\ndescription: General helper agent for review work ZZMARKER-C26\n---\n\nHelp.\n',
  '.claude/agents/casea-helper-two.md': '---\nname: casea-helper-two\ndescription: Second general helper agent for review work\n---\n\nHelp.\n',
  '.claude/agents/casea-reviewer.md': '---\nname: casea-reviewer\ndescription: Reviews a change for correctness\ntools: Read, Grep\n---\n\nReview.\n',
  '.claude/agents/casea-implementer.md': '---\nname: casea-implementer\ndescription: Implements a change\ntools: Read, Edit, Write\n---\n\nImplement.\n',
};

// ---------------------------------------------------------------------------- checks and plan steps

/** The acceptance checks the plan steps name (see the file comment: approved outside the ops). */
export const CHECKS = [
  { id: 'casea-unit', argv: ['node', '--version'], mandatory: true, resultFormat: 'exit-code', requirementIds: ['REQ-CASEA'], description: 'part A placeholder check; it is approved so a plan may name it and is never run' },
];

const OWNER = 'casea';
const BUDGET = { id: 'casea-budget', limitMicroUsd: 5_000_000 };

/** A `plan.submit` step: tasks under the part A root budget, created by the person's terminal channel. */
function planStep(tasks) {
  return { op: 'plan.submit', scope: 'cli', body: { plan: { tasks }, ownerId: OWNER, rootBudget: BUDGET, channel: 'terminal' } };
}

function taskOf(id, fields) {
  return { acceptanceCheckIds: ['casea-unit'], ...fields, id };
}

const advise = (capabilityId, input, taskId) => ({ op: 'capability.advise', scope: 'mcp', body: { capabilityId, input, ...(taskId === undefined ? {} : { taskId }) } });

// ---------------------------------------------------------------------------- the runner's hooks

const HOST_MODES = ['off', 'observe', 'advise', 'bounded-auto'];

/**
 * Prepares a sandbox home and workspace for this part: the host policy (`egress` is `denied` or
 * `approved`, the only thing that approves source egress, plus the host `mode`) and the approved
 * checks the plan steps name. Call it after `writeWorkspace(work, FILES)` and before the sidecar
 * starts. It does nothing else.
 *
 * @param {{ home: string, work: string, egress: 'denied' | 'approved', mode: string }} input
 */
export async function preparePart({ home, work, egress, mode }) {
  if (egress !== 'denied' && egress !== 'approved') throw new Error(`preparePart: egress must be denied or approved, not ${String(egress)}`);
  if (!HOST_MODES.includes(mode)) throw new Error(`preparePart: mode must be one of ${HOST_MODES.join(', ')}`);
  const { jevrisPaths } = await import('@jevris/platform');
  const { approveManifests, openWorkspace, readProposedManifests } = await import('@jevris/orchestrator');
  const config = jevrisPaths({ home }).config;
  mkdirSync(config, { recursive: true });
  const policy = {
    schemaVersion: '1.0',
    mode,
    egress: egress === 'approved' ? 'approved-scoped' : 'deny-until-approved',
    retention: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 },
    budget: { maxRequestBytes: 65536 },
    pin: { model: 'jev-1.13.0', respectHumanPins: true },
    packPrivileges: [],
    credentialRef: 'host-secret:typesafe-primary',
    installerEnvName: 'JEVRIS_INSTALLER_KEY',
    allowUncalibratedActuation: false,
  };
  const file = join(config, 'host.json');
  writeFileSync(file, `${JSON.stringify(policy, null, 2)}\n`);
  chmodSync(file, 0o600);
  writeFileSync(join(work, 'jevris.checks.json'), `${JSON.stringify({ schemaVersion: 'jevris-checks-1', checks: CHECKS }, null, 2)}\n`);
  const proposed = readProposedManifests(work, process.platform);
  if (!proposed.ok) throw new Error(`preparePart: the checks manifest was refused: ${proposed.reason}`);
  const ws = openWorkspace({ home, workspaceRoot: work, platform: process.platform });
  await approveManifests(ws, proposed.manifests, proposed.hashes, 'cli', Date.now());
}

/** The sidecar client this part's cases use: it needs no pseudo-ops, so it is the client itself. */
export function wrapSidecar(sidecar) {
  return sidecar;
}

// ---------------------------------------------------------------------------- the cases

/**
 * Privacy findings the offline run measured: a request that carried a marker while source egress
 * was denied, case id to the field and the place in the product. The test exempts exactly these ids
 * and fails when one stops leaking, so the fix removes the entry. Empty: C26, C33 and C36 leaked
 * workspace and caller text in the options and facts until a consult that sends such text was made to
 * wait for egress approval.
 */
export const KNOWN_LEAKS = {};

/**
 * Cases that cannot reach Jev today because of a defect the offline run measured, case id to the
 * cause. The test asserts the symptom (no request, answered by rules) and fails when it changes, so
 * the fix removes the entry. Empty: C35's rubric anchor was too short for the question lint.
 */
export const KNOWN_DEFECTS = {};

/**
 * Cases that need the scripted test worker port (`JEVRIS_TEST=1`, a test-home marker and a worker
 * script naming `workerRuns`), which stands in for an owned-worker run. They cost nothing and start
 * no harness, but they exist only in a test home, so a live suite cannot run them: the offline test
 * does. They are not part of `CASES`.
 */
export const OWNED_CASES = [
  {
    id: 'C28-owned',
    title: 'Detect duplicate work among active tasks (scripted workers)',
    site: 'packages/orchestrator/src/capabilities/orchestration.ts:311',
    workerRuns: [
      { taskId: 'a28o-one', writes: [{ path: 'caseA/c28/one/output.ts', text: 'export const one = 1;\n' }], status: 'completed', costUsd: 0.01, reason: 'done' },
      { taskId: 'a28o-two', writes: [{ path: 'caseA/c28/two/output.ts', text: 'export const two = 2;\n' }], status: 'completed', costUsd: 0.01, reason: 'done' },
    ],
    steps: [
      planStep([
        taskOf('a28o-one', { title: 'Add retry backoff to the payment client ZZMARKER-C28', requirementIds: ['REQ-A28-ZZMARKER-C28'], writeScopes: ['caseA/c28/one'], expectedOutputs: ['backoffone'], models: ['claude-sonnet-4-5'], labels: ['security'] }),
        taskOf('a28o-two', { title: 'Add retry backoff to the payment client again ZZMARKER-C28', requirementIds: ['REQ-A28-ZZMARKER-C28'], writeScopes: ['caseA/c28/two'], expectedOutputs: ['backofftwo'], models: ['claude-sonnet-4-5'], labels: ['security'] }),
      ]),
    ],
    waitFor: [{ taskId: 'a28o-one', state: 'awaiting-evidence' }, { taskId: 'a28o-two', state: 'awaiting-evidence' }],
    call: advise('C28', {}),
    expectAsked: true,
    egressNeeded: false,
    notes: 'The tasks carry the label security (a high-risk task has no first-try slice, so a worker that leaves no receipt is not handed off and failed before the call), and each worker writes inside the write scope of its task (a write outside it fails the task). Two owned tasks whose scripted workers finished (awaiting evidence, which counts as active), in the same top-level folder with near-identical titles: the pair scores about 0.57, between 0.3 and 0.7, so the rules defer to Jev. A score of 0.7 or more is a duplicate by rules, below 0.3 is not one.',
  },
];

export const CASES = [
  {
    id: 'C25',
    title: 'Suggest a dependency between two planned tasks',
    site: 'packages/orchestrator/src/capabilities/orchestration.ts:109',
    steps: [
      planStep([
        taskOf('a25-parser', { title: 'Build the tokenstream parser ZZMARKER-C25', requirementIds: ['REQ-A25-ZZMARKER-C25'], writeScopes: ['caseA/c25/parser'], expectedOutputs: ['tokenstream'] }),
        taskOf('a25-cli', { title: 'Wire the tokenstream into the CLI ZZMARKER-C25', requirementIds: ['REQ-A25-ZZMARKER-C25'], writeScopes: ['caseA/c25/cli'], expectedOutputs: ['cliwiring'] }),
      ]),
    ],
    call: advise('C25', {}),
    expectAsked: true,
    egressNeeded: false,
    notes: 'Needs two tasks in proposed, validated, ready or blocked. The CLI task names the parser task\'s output (tokenstream) in its title, so one candidate pair exists (a25-cli after a25-parser); the reverse pair and a write-scope overlap do not (a plan refuses overlapping scopes between independent tasks). Without a planId every unfinished task of the workspace is a candidate, one Jev question each (at most 12): the titles and outputs here share no word with other cases\' tasks. The evidence is the two task titles and scopes (withheld without egress approval).',
  },
  {
    id: 'C26',
    title: 'Choose the least-privileged agent for a phase',
    site: 'packages/orchestrator/src/capabilities/orchestration.ts:232',
    steps: [],
    call: advise('C26', { phase: 'reviewer', intent: 'ZZMARKER-C26 review the parser change', requiredTools: ['ZZMARKER-C26'] }),
    expectAsked: true,
    egressNeeded: true,
    notes: 'Needs at least two installed agents whose tool allowlists cover the phase (a Choice question needs two options; with one, nothing is asked): .claude/agents holds two that inherit every tool. The question carries workspace and caller text outside the evidence (the caller\'s required tool names in the facts, the agent descriptions in the options), so the handler does not ask unless source egress is approved: with egress denied it answers from rules without a request or a decision.',
  },
  {
    id: 'C28',
    title: 'Detect duplicate work among active tasks',
    site: 'packages/orchestrator/src/capabilities/orchestration.ts:311',
    steps: [
      planStep([
        taskOf('a28-one', { title: 'Add retry backoff to the payment client ZZMARKER-C28', requirementIds: ['REQ-A28-ZZMARKER-C28'], writeScopes: ['caseA/c28/one'], expectedOutputs: ['backoffone'] }),
        taskOf('a28-two', { title: 'Add retry backoff to the payment client again ZZMARKER-C28', requirementIds: ['REQ-A28-ZZMARKER-C28'], writeScopes: ['caseA/c28/two'], expectedOutputs: ['backofftwo'] }),
      ]),
    ],
    call: advise('C28', {}),
    expectAsked: false,
    egressNeeded: false,
    notes: 'The consult needs two tasks that are active (leased, running or awaiting evidence), which only a worker run produces, and a pair score between 0.3 and 0.7 (shared top-level folder and similar titles). A run is an owned-worker run, which costs money and needs a harness: no op reaches that state, so the handler answers "fewer than two active tasks" from rules, which is what this case proves. The test also reaches the consult with the scripted test worker port (case C28-owned, offline only).',
  },
  {
    id: 'C30',
    title: 'Check whether a worker handoff lacks context',
    site: 'packages/orchestrator/src/capabilities/orchestration.ts:400',
    steps: [
      planStep([
        taskOf('a30-handoff', { title: 'Prepare the handoff notes ZZMARKER-C30', requirementIds: ['REQ-A30-ZZMARKER-C30'], writeScopes: ['caseA/c30'], expectedOutputs: ['handoffdoc'] }),
      ]),
    ],
    call: advise('C30', { sourceRefs: ['caseA/c30/handoff.ts', 'ZZMARKER-C30 handoffSymbol'] }, 'a30-handoff'),
    expectAsked: true,
    egressNeeded: false,
    notes: 'The consult runs only when the rules find nothing missing: the task has requirement ids, an acceptance check, expected outputs and write scopes, the call names source references, and no earlier worker run changed files (that would also need a diff handle). Any gap is answered by rules (CONTRACT_INCOMPLETE).',
  },
  {
    id: 'C33',
    title: 'Shortlist installed skills for an intent',
    site: 'packages/orchestrator/src/capabilities/retrieval.ts:235',
    steps: [],
    call: advise('C33', { intent: 'ZZMARKER-C33 review the pull request for correctness' }),
    expectAsked: true,
    egressNeeded: true,
    notes: 'Needs at least one installed skill whose name or description shares a word with the intent (otherwise the rules answer none): .claude/skills holds two reviewing skills. The question lists none and every matching skill, so it always has two or more options. The skill descriptions (workspace text) are the option text, so the handler does not ask unless source egress is approved: with egress denied it answers from rules without a request or a decision.',
  },
  {
    id: 'C34',
    title: 'Rank repository spans as evidence for a task',
    site: 'packages/orchestrator/src/capabilities/retrieval.ts:350',
    steps: [],
    call: advise('C34', { query: 'ZZMARKER-C34 retry backoff in the payment client', maxItems: 1 }),
    expectAsked: true,
    egressNeeded: false,
    notes: 'Needs git to list the workspace and a file whose text or path matches the query, and more than 2000 ms left of the op budget. One Jev score question per candidate span, at most two here because maxItems is 1. The span text is the evidence (withheld without egress approval); the chosen spans are also stored as evidence handles.',
  },
  {
    id: 'C35',
    title: 'Rate the top document for a task',
    site: 'packages/orchestrator/src/capabilities/retrieval.ts:442',
    steps: [],
    call: advise('C35', { query: 'ZZMARKER-C35 how payment retries and backoff work' }),
    expectAsked: true,
    egressNeeded: false,
    notes: 'Needs a documentation file (README, CHANGELOG, a docs folder or any .md) whose text shares a word with the query. One Jev score question for the top document.',
  },
  {
    id: 'C36',
    title: 'Pick the best eligible tool for a step',
    site: 'packages/orchestrator/src/capabilities/retrieval.ts:512',
    steps: [],
    call: advise('C36', {
      intent: 'ZZMARKER-C36 find where the retry backoff is defined',
      allowlist: ['casea-grep', 'casea-read'],
      permittedEffects: ['read'],
      tools: [
        { id: 'casea-grep', description: 'Search files for a pattern ZZMARKER-C36', effects: ['read'] },
        { id: 'casea-read', description: 'Read one file', effects: ['read'] },
        { id: 'casea-write', description: 'Write one file', effects: ['write'] },
      ],
    }),
    expectAsked: true,
    egressNeeded: true,
    notes: 'Needs at least one tool that is both listed as available and on the allowlist with every effect permitted (otherwise NO_ELIGIBLE_TOOL, from rules). The question lists none and every eligible tool. The tool descriptions (caller text) are the option text, so the handler does not ask unless source egress is approved: with egress denied it answers from rules without a request or a decision.',
  },
  {
    id: 'C37',
    title: 'Preflight a tool call\'s arguments',
    site: 'packages/orchestrator/src/capabilities/retrieval.ts:646',
    steps: [],
    call: advise('C37', { tool: 'Bash', args: { command: 'npm run build ZZMARKER-C37' }, writeScopes: ['caseA/'] }),
    expectAsked: true,
    egressNeeded: false,
    notes: 'The consult runs only when the deterministic parser finds no anomaly (a parse failure, a path outside the workspace, a credential path, a recursive delete, a piped download, a force push, a command substitution all stop at review without asking Jev). The command text is the evidence (withheld without egress approval).',
  },
  {
    id: 'C38',
    title: 'Tell an environment failure from a source defect',
    site: 'packages/orchestrator/src/capabilities/retrieval.ts:750',
    steps: [
      // The recorded output is an evidence handle: no op stores caller text, so C34 stores the span of the log (the file is six lines, so the span is all of it).
      advise('C34', { query: 'zzc38uniq', maxItems: 1 }),
    ],
    call: advise('C38', { handle: LOG_HANDLE }),
    expectAsked: true,
    egressNeeded: false,
    notes: 'Needs recorded tool output: a receipt of a failed check, or an evidence handle. A handle is content-addressed, so the setup step lets C34 store the span of ci-output.txt and the call names that handle (LOG_HANDLE, computed from the file text). The question always has three options; the evidence is one line per diagnostic found (withheld without egress approval).',
  },
];

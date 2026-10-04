/**
 * Jev feature cases, part B: the verification and delivery capabilities (C41 to C47 and C57 to
 * C61, C64), the Jev consults in `packages/orchestrator/src/capabilities/verification.ts` and
 * `delivery.ts`. The driver is `jev-feature-driver.mjs`; the offline proof is
 * `apps/sidecar/test/jev-feature-cases-b.test.mjs`.
 *
 * Each case sets up the workspace state its handler needs before it reaches a Jev question, then
 * makes one `capability.advise` call. Three setups are a person's work in the product (approving
 * checks, trusting a CI issuer) or have no op of their own (clearing open tasks), so the cases
 * name them as part B ops (`caseB.approve-checks`, `caseB.ci-import`, `caseB.cancel-open-tasks`)
 * that `wrapSidecar` serves in process with the orchestrator library, the way `jevris verify
 * approve` does; every other op goes to the real sidecar. Its ops are only the `caseB.*` ones, so it
 * composes with the other parts' wrappers in either order.
 *
 * A runner outside node:test runs a part in a fresh home with a fresh sidecar, once per egress mode:
 * it writes the workspace (`writeWorkspace(work, FILES)`), calls `preparePart` before the sidecar
 * starts, and wraps its sidecar client with `wrapSidecar`.
 *
 * Every free-text field a handler might forward carries a marker (`ZZMARKER-<case>`), so a run can
 * prove that none of it leaves the machine while source egress is denied. Findings the offline run
 * measures are exported beside the cases: KNOWN_LEAKS (a request carried the marker while egress was
 * denied) and KNOWN_DEFECTS (the question is refused before any request, `{ codes, detail }`). Both
 * are empty now that the product asks every question of this part and sends no workspace text while
 * egress is denied. The offline test asserts each entry as it is and fails when it changes.
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MARKER } from './jev-feature-driver.mjs';

const tag = (id) => `${MARKER}-${id}`;

/** File paths that carry the marker in their names, so a path that leaks shows. */
const PATH = {
  c41: `caseB/c41/widgets/button-${tag('C41')}.ts`,
  c43: `caseB/c43/label-${tag('C43')}.ts`,
  c44Auth: `caseB/c44/auth/login-${tag('C44')}.ts`,
  c44Ui: `caseB/c44/ui/panel-${tag('C44')}.ts`,
  c47: `caseB/c47/auth/token-${tag('C47')}.ts`,
  c57: `caseB/c57-notes/review-${tag('C57')}.txt`,
  c60: `caseB/c60/migrations/001_drop_legacy-${tag('C60')}.sql`,
  c61Code: `caseB/c61/widget-${tag('C61')}.ts`,
  c61Doc: `caseB/c61/README-${tag('C61')}.md`,
  c64: `caseB/c64/app-${tag('C64')}.ts`,
};

/** A check that does nothing and passes; `node` becomes the running node binary when approved. */
const PASS = ['node', '-e', '0'];

/** The ids of every check of this part start with this, so approving them never touches another part's checks. */
const CHECK_PREFIX = 'b-';

// ------------------------------------------------------------------ workspace files

/**
 * The files the aggregator commits before any case runs. All of them sit under `caseB/`; no case
 * of this part needs a root file here (the lockfile of C59 is written by its own steps).
 */
export const FILES = {
  // C41: a source file in the scope of an optional check.
  [PATH.c41]: `export function drawButton(label: string): string {\n  return label;\n}\n`,
  // C44: a sensitive area (auth) and a routine one.
  [PATH.c44Auth]: `export function login(user: string): boolean {\n  return user.length > 0;\n}\n`,
  [PATH.c44Ui]: `export const panelTitle = 'Panel';\n`,
  // C47: a security-relevant file.
  [PATH.c47]: `export function issue(user: string): string {\n  return user;\n}\n`,
  // C57: the scope of the mandatory check.
  'caseB/c57/status.txt': 'ready\n',
  // C60: a migration with a destructive statement.
  [PATH.c60]: `-- ${tag('C60')}\nALTER TABLE accounts DROP COLUMN legacy_flag;\n`,
  // C61: an exported function and a document that names it.
  [PATH.c61Code]: `export function renderWidget(name: string): string {\n  return name;\n}\n`,
  [PATH.c61Doc]: `# Widget ${tag('C61')}\n\nCall renderWidget with the widget name to draw it.\n`,
  // C64: a TypeScript file, so the workspace profile finds a stack and a team preset fits.
  [PATH.c64]: `export const appName = 'app';\n`,
};

const edit = (files) => ({ files, commit: true });

// ------------------------------------------------------------------ the cases

/** The unified diff the C43 patch candidates carry. */
const patchDiff = (file, from, to) => `--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${from}\n+${to}\n`;

/** A check that fails with a failure line, as a runner would show it. */
const failingCheck = (id, line) => ({
  id,
  argv: ['node', '-e', `console.error(${JSON.stringify(line)}); process.exit(1)`],
  mandatory: false,
  resultFormat: 'exit-code',
  inputScopes: ['caseB/c42'],
  description: `Parser unit tests ${tag('C42')}`,
});

export const CASES = [
  {
    id: 'C41',
    title: 'Test-impact prioritization: order the optional checks by the change',
    site: 'packages/orchestrator/src/capabilities/verification.ts:88',
    steps: [
      {
        op: 'caseB.approve-checks',
        body: {
          checks: [
            { id: 'b-unit-core', argv: PASS, mandatory: true, resultFormat: 'exit-code', description: `Core unit tests ${tag('C41')}` },
            { id: 'b-ui-widgets', argv: PASS, mandatory: false, resultFormat: 'exit-code', inputScopes: ['caseB/c41/widgets'], description: `Widget tests for drawButton ${tag('C41')}` },
          ],
        },
      },
      edit({ [PATH.c41]: `export function drawButton(label: string, width: number): string {\n  return label.padEnd(width);\n}\n` }),
    ],
    call: { op: 'capability.advise', scope: 'mcp', body: { capabilityId: 'C41', input: { base: 'HEAD~1' } } },
    expectAsked: true,
    egressNeeded: false,
    notes:
      'Needs an approved manifest with an optional check that has an input scope, and a change that touches that scope without touching a build or dependency file (that would make the impact unknown and run the broad suite). The first step approves the checks (a person does that with `jevris verify approve`); the second commits a change to a scoped file, and `base: HEAD~1` makes that the diff. The optional check scores strictly between 0 and 1, so the handler asks one Score question. The test text, the changed file names and the symbols go to Jev only as evidence, which is withheld while egress is denied.',
  },
  {
    id: 'C42',
    title: 'Failure-cluster ranking: pick the cluster most likely to share one cause',
    site: 'packages/orchestrator/src/capabilities/verification.ts:193',
    steps: [
      { op: 'caseB.approve-checks', body: { checks: [failingCheck('b-unit-parse', `AssertionError: parse failed at caseB/c42/src/parse.ts:14 ${tag('C42')}`)] } },
      { op: 'verify', scope: 'cli', body: { taskId: null, checkIds: ['b-unit-parse'] } },
    ],
    call: { op: 'capability.advise', scope: 'mcp', body: { capabilityId: 'C42', input: {} } },
    expectAsked: true,
    egressNeeded: true,
    notes:
      'Needs a current failed receipt. The steps approve one check that prints a failure line and exits 1, then run it through the `verify` op, which records the failed receipt. The handler clusters the failure by its top frame and asks one Choice question whose options are the clusters plus "none". The option TEXT is the cluster label, built from the failure line and frame (verification.ts:186 and :190), so the question itself carries workspace text, which the transport guard does not watch. The consult is therefore flagged `sendsWorkspaceText` and is asked only while source egress is approved: with egress denied the handler sends nothing and the rules answer (egressNeeded is true).',
  },
  {
    id: 'C43',
    title: 'Patch-candidate ranking: which patch to verify first',
    site: 'packages/orchestrator/src/capabilities/verification.ts:275',
    steps: [],
    call: {
      op: 'capability.advise',
      scope: 'mcp',
      body: {
        capabilityId: 'C43',
        input: {
          requirement: `Reject an empty label ${tag('C43')}`,
          patches: [
            { id: 'patch-a', diff: patchDiff(PATH.c43, 'export const ok = (s) => true;', `export const ok = (s) => s.length > 0; // ${tag('C43')}`) },
            { id: 'patch-b', diff: patchDiff(PATH.c43, 'export const ok = (s) => true;', `export const ok = (s) => s !== ''; // ${tag('C43')}`) },
          ],
        },
      },
    },
    expectAsked: true,
    egressNeeded: false,
    notes: 'No workspace state: two bounded diffs in the input and a non-empty requirement are enough (the handler consults once per patch when it has an engine and a requirement). The requirement and the diffs go to Jev only as evidence.',
  },
  {
    id: 'C44',
    title: 'Review-area prioritization: rate a changed area for a reviewer',
    site: 'packages/orchestrator/src/capabilities/verification.ts:388',
    steps: [
      edit({
        [PATH.c44Auth]: `export function login(user: string, password: string): boolean {\n  return user.length > 0 && password.length > 8;\n}\n`,
        [PATH.c44Ui]: `export const panelTitle = 'Settings panel';\n`,
      }),
    ],
    call: { op: 'capability.advise', scope: 'mcp', body: { capabilityId: 'C44', input: { base: 'HEAD~1', protectedPaths: ['caseB/c44/auth'] } } },
    expectAsked: true,
    egressNeeded: false,
    notes: 'Needs git to list a change: the step commits an edit to a sensitive file and a routine one, and `base: HEAD~1` makes it the diff. The handler groups changed files by module and asks one Score question for each of the first three areas (here one area, because `caseB` is the module of both files). No CODEOWNERS file is needed.',
  },
  {
    id: 'C45',
    title: 'Requirements-to-evidence audit: do the mapped checks really cover a requirement',
    site: 'packages/orchestrator/src/capabilities/verification.ts:451',
    steps: [
      {
        op: 'caseB.approve-checks',
        body: { checks: [{ id: 'b-login-check', argv: PASS, mandatory: false, resultFormat: 'exit-code', requirementIds: ['REQ-B1'], description: `Login form accepts a valid user ${tag('C45')}` }] },
      },
    ],
    call: { op: 'capability.advise', scope: 'mcp', body: { capabilityId: 'C45', input: { requirementIds: ['REQ-B1'], requirementTexts: { 'REQ-B1': `A signed-in user can reach the dashboard ${tag('C45')}` } } } },
    expectAsked: true,
    egressNeeded: false,
    notes: 'The Noul question is asked only for a requirement that IS covered (an uncovered one is reported by rules) and whose text the caller supplied. So one approved check names REQ-B1 in its requirementIds, and the input names the requirement and gives its text. No task is needed: the ids come from the input when there is no task.',
  },
  {
    id: 'C46',
    title: 'Flaky-test investigation: how to handle a changing test result',
    site: 'packages/orchestrator/src/capabilities/verification.ts:521',
    steps: [],
    call: { op: 'capability.advise', scope: 'mcp', body: { capabilityId: 'C46', input: { checkId: `unit-flaky-${tag('C46')}` } } },
    expectAsked: true,
    egressNeeded: false,
    notes: 'A check id is the only precondition: with no receipts the handler still asks one Choice question over fixed options, with numeric facts only (runs, groups, flips). The check id is the marker-bearing field; it appears only in the local advice text, never in the question.',
  },
  {
    id: 'C47',
    title: 'Security-review escalation: should this change go to a security reviewer',
    site: 'packages/orchestrator/src/capabilities/verification.ts:583',
    steps: [
      edit({
        [PATH.c47]: `export function issue(user: string, ttlSeconds: number): string {\n  const session = { user, ttlSeconds };\n  return JSON.stringify(session);\n}\n`,
      }),
    ],
    call: { op: 'capability.advise', scope: 'mcp', body: { capabilityId: 'C47', input: { base: 'HEAD~1' } } },
    expectAsked: true,
    egressNeeded: false,
    notes: 'The handler always asks its Noul question; the step gives it something to see: a committed change to a file under `auth/` (a sensitive path) with a session line (an authorization marker). Rules escalate on any marker whatever Jev says.',
  },
  {
    id: 'C57',
    title: 'Pull-request readiness: how reviewable is a change that is ready',
    site: 'packages/orchestrator/src/capabilities/delivery.ts:68',
    steps: [
      { op: 'caseB.cancel-open-tasks' },
      edit({ [PATH.c57]: 'Review notes\n' }),
      { op: 'caseB.approve-checks', body: { checks: [{ id: 'b-unit-ready', argv: PASS, mandatory: true, resultFormat: 'exit-code', inputScopes: ['caseB/c57'], description: `Unit tests for the status page ${tag('C57')}` }] } },
      { op: 'verify', scope: 'cli', body: { taskId: null, checkIds: [] } },
    ],
    call: { op: 'capability.advise', scope: 'mcp', body: { capabilityId: 'C57', input: { base: 'HEAD~1' } } },
    expectAsked: true,
    egressNeeded: false,
    notes:
      'The Score question is asked only when the report is READY: every mandatory check has a current passing receipt, no requirement is uncovered, no task is open and no review comment is reported. So the steps clear any open task (other cases may have left some in a shared workspace), commit a notes file outside the check\'s scope (its name carries the marker, and `base: HEAD~1` makes it the change that goes to Jev as evidence), approve one mandatory check scoped to caseB/c57 (so edits elsewhere do not make its receipt stale) and run every approved check through `verify` (readiness needs EVERY mandatory check approved in the workspace to pass, not only this one).',
  },
  {
    id: 'C58',
    title: 'CI failure triage: where should the diagnosis of a CI failure start',
    site: 'packages/orchestrator/src/capabilities/delivery.ts:122',
    steps: [
      { op: 'caseB.approve-checks', body: { checks: [{ id: 'b-unit-ci', argv: PASS, mandatory: false, resultFormat: 'exit-code', inputScopes: ['caseB/c58'], description: `CI unit tests ${tag('C58')}` }] } },
      { op: 'caseB.ci-import', body: { checkId: 'b-unit-ci', name: `login test ${tag('C58')}`, message: `timeout after 30000 ms ${tag('C58')}` } },
    ],
    call: { op: 'capability.advise', scope: 'mcp', body: { capabilityId: 'C58', input: {} } },
    expectAsked: true,
    egressNeeded: false,
    notes: 'Needs a current failed receipt issued by a CI import. The local op `caseB.ci-import` registers a throwaway signing key as a trusted issuer (a person does that with `jevris verify issuer add`), signs a bundle for the current HEAD with one failed check, and sends it to the real `verify.import-ci` op. The handler asks one Choice question per failure (here one).',
  },
  {
    id: 'C59',
    title: 'Dependency-upgrade planning: rate the risk of a major upgrade',
    site: 'packages/orchestrator/src/capabilities/delivery.ts:242',
    steps: [
      edit({ 'package-lock.json': lockfile('1.4.2') }),
      edit({ 'package-lock.json': lockfile('2.0.0') }),
    ],
    call: { op: 'capability.advise', scope: 'mcp', body: { capabilityId: 'C59', input: { base: 'HEAD~1' } } },
    expectAsked: true,
    egressNeeded: false,
    notes:
      'Needs a lockfile change between the base and the work tree: two commits of the root package-lock.json, a major bump of one package, and `base: HEAD~1`. A major bump (or a changelog that mentions a breaking change) is what makes the handler ask. The package name carries the marker: it goes out as the `package` fact only while egress is approved (`approvedFacts`, delivery.ts:251); with egress denied the facts hold the versions, the bump and counts only. This case leaves a lockfile in the workspace root, which changes the lockfile hash and so makes earlier receipts stale: run it after cases that need current receipts.',
  },
  {
    id: 'C60',
    title: 'Migration rehearsal: could a migration break the compatibility contract',
    site: 'packages/orchestrator/src/capabilities/delivery.ts:313',
    steps: [],
    call: {
      op: 'capability.advise',
      scope: 'mcp',
      body: { capabilityId: 'C60', input: { migrations: [PATH.c60], compatibility: `Old readers still select legacy_flag ${tag('C60')}` } },
    },
    expectAsked: true,
    egressNeeded: false,
    notes: 'Needs a migration file (named in the input, so no git change is needed) and a non-empty backward-compatibility statement; then it asks one Noul question. The file holds a destructive statement, which rules report on their own. Nothing is run.',
  },
  {
    id: 'C61',
    title: 'Documentation drift: how likely a document is outdated by an interface change',
    site: 'packages/orchestrator/src/capabilities/delivery.ts:390',
    steps: [
      edit({ [PATH.c61Code]: `export function renderWidget(name: string, size: number): string {\n  return name.padEnd(size);\n}\n` }),
    ],
    call: { op: 'capability.advise', scope: 'mcp', body: { capabilityId: 'C61', input: { base: 'HEAD~1' } } },
    expectAsked: true,
    egressNeeded: false,
    notes: 'Needs a committed change to an exported declaration (here the signature of renderWidget) and a document that names it (the README in the same folder). The handler ranks the documents that reference a changed export and asks one Score question about the first. The document text and the diff go to Jev only as evidence.',
  },
  {
    id: 'C64',
    title: 'Team policy reuse: which listed configuration fits this repository',
    site: 'packages/orchestrator/src/capabilities/delivery.ts:454',
    steps: [],
    call: { op: 'capability.advise', scope: 'mcp', body: { capabilityId: 'C64', input: {} } },
    expectAsked: true,
    egressNeeded: false,
    notes: 'The handler always asks, but a Choice needs at least two options. "keep-current" is always one; the second comes from a preset that fits the workspace profile, which needs a detected stack: a TypeScript file under caseB/c64 (within two folders of the root, where the profile looks) makes the node-service preset fit. In a workspace with no detectable stack the question would have one option, and `consultChoice` does not ask a question with fewer than two options (the rules answer).',
  },
];

function lockfile(version) {
  return `${JSON.stringify({ name: 'caseB', lockfileVersion: 3, packages: { '': { name: 'caseB' }, [`node_modules/${tag('C59')}-lib`]: { version } } }, null, 2)}\n`;
}

// ------------------------------------------------------------------ known findings

/**
 * Cases whose Jev request carries a marker while source egress is denied: `{ id: 'where, file:line' }`.
 * The test exempts exactly these ids from the strict check, prints them, and fails when one stops
 * leaking. Empty: C42 (failure text in the option texts) is not asked at all while egress is denied,
 * and C59 (package name) sends it only with egress approved.
 */
export const KNOWN_LEAKS = {};

/**
 * Cases whose handler reaches its consult but cannot reach Jev, because the engine refuses the
 * question before any provider call: `{ id: { codes, detail } }`, `codes` being the reason codes of the
 * decision record. The test asserts the refusal as it is and fails when it changes. Empty: the Score
 * rubric anchors of C41, C43, C44, C57, C59 and C61 now pass the question lint.
 */
export const KNOWN_DEFECTS = {};

// ------------------------------------------------------------------ part B ops

function git(cwd, ...args) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (out.status !== 0) throw new Error(`git ${args[0]} failed`);
  return out.stdout ?? '';
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function openWorkspaceOf(request) {
  const orchestrator = await import('@jevris/orchestrator');
  const ws = orchestrator.openWorkspace({ home: request.home, workspaceRoot: request.workspace, platform: process.platform });
  return { orchestrator, ws };
}

/**
 * Approves the given checks as `jevris verify approve` does (a person's step; the ledger is shared
 * with the sidecar). Approval replaces the whole approved set, so this keeps every approved check
 * that is not this part's and replaces this part's own (ids start with `b-`) by the given ones: it
 * never drops a check another part approved, and it leaves at most the last case's checks behind.
 */
async function approveChecks({ request, body }) {
  const { orchestrator, ws } = await openWorkspaceOf(request);
  const parsed = (Array.isArray(body.checks) ? body.checks : []).map((raw) => orchestrator.parseManifest({ ...raw, argv: raw.argv.map((part, i) => (i === 0 && part === 'node' ? process.execPath : part)) }));
  const bad = parsed.findIndex((p) => !p.ok || !p.manifest.id.startsWith(CHECK_PREFIX));
  if (parsed.length === 0 || bad >= 0) throw new Error(`check ${String(bad)}: ${bad >= 0 ? (parsed[bad].ok ? 'id must start with b-' : `${parsed[bad].field}: ${parsed[bad].reason}`) : 'none given'}`);
  const others = orchestrator.approvedManifests(ws).filter((m) => !m.id.startsWith(CHECK_PREFIX));
  const manifests = [...others, ...parsed.map((p) => p.manifest)];
  await orchestrator.approveManifests(ws, manifests, Object.fromEntries(manifests.map((m) => [m.id, orchestrator.manifestHash(m)])), 'jev-features', Date.now());
  return { approved: parsed.map((p) => p.manifest.id).sort(), kept: others.length };
}

/**
 * Imports one failed CI check for the current HEAD: trusts a throwaway issuer key (a person's step,
 * `jevris verify issuer add`), signs a bundle and sends it through the real `verify.import-ci` op.
 */
async function ciImport({ request, body, sidecar }) {
  const { signRecord } = await import('@jevris/contracts');
  const { orchestrator, ws } = await openWorkspaceOf(request);
  const keys = generateKeyPairSync('ed25519');
  const issuerId = 'jev-features-ci';
  const repository = 'example/jev-features';
  await orchestrator.addTrustedIssuer(ws, { issuerId, keys: { k1: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }, repository }, Date.now());
  const artifact = Buffer.from(`TAP version 13\nnot ok 1 - ${String(body.name)}\n1..1\n`);
  const hash = sha256(artifact);
  const bundle = signRecord(
    {
      schemaVersion: 'jevris-ci-receipts-1',
      issuerId,
      jobId: 'run-1',
      repository,
      revision: git(request.workspace, 'rev-parse', 'HEAD').trim(),
      createdAt: new Date().toISOString(),
      checks: [
        {
          checkId: String(body.checkId),
          outcome: 'failed',
          results: { format: 'tap', total: 1, passed: 0, failed: 1, skipped: 0, failures: [{ id: 'login-test', name: String(body.name), message: String(body.message) }] },
          rawOutputHash: hash,
          artifact: { name: 'unit.tap', sha256: hash },
        },
      ],
    },
    keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    'k1',
  );
  const answer = await sidecar.sidecarRequest({ ...request, op: 'verify.import-ci', scope: 'cli', body: { bundle, artifacts: [{ name: 'unit.tap', base64: artifact.toString('base64') }] } });
  if (!answer.ok) throw new Error(`verify.import-ci: ${answer.reasonCode ?? answer.reason}`);
  if (answer.result?.accepted !== true || answer.result?.binding !== 'current') throw new Error(`verify.import-ci: ${String(answer.result?.reasonCode)}`);
  return { receipts: answer.result.receiptIds.length };
}

/** The ids of the open tasks a C57 advice lists as blockers (`task:<id>`). */
export function openTaskIds(advice) {
  const ranked = Array.isArray(advice?.ranked) ? advice.ranked : [];
  return ranked.map((item) => (typeof item?.id === 'string' && item.id.startsWith('task:') ? item.id.slice('task:'.length) : null)).filter((id) => id !== null);
}

/**
 * Cancels every open task of the workspace, so a pull-request readiness report is not blocked by
 * work other cases left. It lists them from a C57 advice that reports an unresolved comment (that
 * blocks readiness, so no Jev question is asked while listing) and cancels each through `task.cancel`.
 */
async function cancelOpenTasks({ request, sidecar }) {
  let cancelled = 0;
  for (let pass = 0; pass < 3; pass += 1) {
    const listing = await sidecar.sidecarRequest({ ...request, op: 'capability.advise', scope: 'cli', body: { capabilityId: 'C57', input: { unresolvedComments: 1 } } });
    if (!listing.ok) throw new Error(`capability.advise: ${listing.reasonCode ?? listing.reason}`);
    const ids = openTaskIds(listing.result);
    if (ids.length === 0) return { cancelled };
    for (const taskId of ids) {
      const done = await sidecar.sidecarRequest({ ...request, op: 'task.cancel', scope: 'cli', body: { taskId } });
      if (done.ok) cancelled += 1;
    }
  }
  return { cancelled };
}

export const CASE_B_OPS = Object.freeze({
  'caseB.approve-checks': approveChecks,
  'caseB.ci-import': ciImport,
  'caseB.cancel-open-tasks': cancelOpenTasks,
});

/**
 * Wraps a sidecar client (`{ sidecarRequest }`) so the `caseB.*` ops of these cases run in process and
 * every other op goes to the sidecar. Answers like the sidecar does: `{ ok: true, result }` or
 * `{ ok: false, reasonCode, reason }`. Only `caseB.*` ops are handled, so it composes with other
 * parts' wrappers in either order.
 */
export function withCaseBOps(sidecar) {
  return {
    ...sidecar,
    async sidecarRequest(request) {
      const run = CASE_B_OPS[request.op];
      if (run === undefined) return sidecar.sidecarRequest(request);
      try {
        return { ok: true, result: await run({ request, body: request.body ?? {}, sidecar }) };
      } catch (error) {
        return { ok: false, reasonCode: 'CASE_B_OP_FAILED', reason: String(error?.message ?? error).slice(0, 160) };
      }
    },
  };
}

// ------------------------------------------------------------------ the runner's entry points

/** The sidecar client wrapper a runner uses for this part (`caseB.*` ops in process, the rest to the sidecar). */
export function wrapSidecar(sidecar) {
  return withCaseBOps(sidecar);
}

const HOST_MODES = ['off', 'observe', 'advise', 'bounded-auto'];
const EGRESS = { denied: 'deny-until-approved', approved: 'approved-scoped' };

/**
 * What this part needs in process BEFORE its sidecar starts, outside any op: the administrator's host
 * policy in the (temporary) Jevris home, which is the only thing that approves source egress.
 *
 * - `home` the Jevris home the sidecar will run in (a temporary one: this writes only there).
 * - `work` the workspace root; the caller has already written `FILES` into it with `writeWorkspace`.
 * - `egress` `'denied'` or `'approved'`; `mode` the host mode (`'advise'` for the live suite).
 *
 * It uses only the product's built packages and node built-ins, so a script outside node:test can call
 * it. Anything that is not a file in `home` (the checks and the CI issuer these cases need) is done by
 * the `caseB.*` ops while the cases run.
 */
export async function preparePart({ home, work, egress, mode }) {
  if (!Object.hasOwn(EGRESS, egress)) throw new Error(`preparePart: egress must be 'denied' or 'approved', not ${String(egress)}`);
  if (!HOST_MODES.includes(mode)) throw new Error(`preparePart: mode must be one of ${HOST_MODES.join(', ')}, not ${String(mode)}`);
  if (typeof home !== 'string' || home === '' || typeof work !== 'string' || work === '') throw new Error('preparePart: home and work are paths');
  if (!existsSync(join(work, 'caseB'))) throw new Error('preparePart: the workspace has no caseB folder; write FILES with writeWorkspace(work, FILES) first');
  const { jevrisPaths } = await import('@jevris/platform');
  const { copyHostDocument } = await import('@jevris/contracts');
  const document = {
    schemaVersion: '1.0',
    mode,
    egress: EGRESS[egress],
    retention: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 },
    budget: { maxRequestBytes: 65536 },
    pin: { model: 'jev-1.13.0', respectHumanPins: true },
    packPrivileges: [],
    credentialRef: 'host-secret:typesafe-primary',
    installerEnvName: 'JEVRIS_INSTALLER_KEY',
    allowUncalibratedActuation: false,
  };
  if (copyHostDocument(document) === undefined) throw new Error('preparePart: the host policy is not valid');
  const config = jevrisPaths({ home }).config;
  mkdirSync(config, { recursive: true });
  const file = join(config, 'host.json');
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
  chmodSync(file, 0o600);
  return { hostPolicy: file, egress, mode };
}

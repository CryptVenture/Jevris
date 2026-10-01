/**
 * The model-facing Jevris tools (§6.4). Each maps to one surface operation that the CLI
 * answers through `jevris __surface <op>`, so a tool result is the CLI result.
 *
 * No tool is destructive and none takes a home, a root, an output path or a shell string: the
 * home comes from the host environment, the workspace from the host (CLAUDE_PROJECT_DIR, MCP
 * roots or the working directory). Settings changes, installs, data deletion, credentials,
 * kill switches and policy stay on the administrator CLI.
 */

export type EffectClass = 'read' | 'advise' | 'write-local' | 'submit';

export type JsonSchema = { readonly [key: string]: unknown };

export interface ToolSpec {
  readonly name: string;
  readonly op: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly effect: EffectClass;
  /**
   * Works only while owned mode is on for the workspace (`jevris configure owned-mode on`, a
   * CLI-only setting the sidecar checks per request); otherwise it answers OWNED_MODE_UNAVAILABLE.
   */
  readonly ownedOnly?: boolean;
}

const ID = '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$';
/** A model id as a harness reports it (G20; contracts HARNESS_MODEL_ID_PATTERN): provider/model and [1m] too. */
const HARNESS_MODEL = '^(?:[a-z0-9][a-z0-9._-]{0,63}/){0,2}[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?::[0-9]{1,8})?(?:\\[1m\\])?$';
/** An evidence handle: the only kind Jevris issues (contracts EVIDENCE_HANDLE_PATTERN). */
const HANDLE = '^ev:[0-9a-f]{64}$';

const id = (description: string): JsonSchema => ({ type: 'string', pattern: ID, maxLength: 128, description });
const harnessModel = (description: string): JsonSchema => ({ type: 'string', pattern: HARNESS_MODEL, maxLength: 271, description });
const text = (maxLength: number, description: string): JsonSchema => ({ type: 'string', minLength: 1, maxLength, description });
const tokens = (description: string): JsonSchema => ({ type: 'integer', minimum: 0, maximum: 100_000_000, description });

function input(properties: { readonly [key: string]: JsonSchema }, required: readonly string[] = []): JsonSchema {
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false };
}

export const TOOLS: readonly ToolSpec[] = [
  {
    name: 'jevris_status',
    op: 'status',
    title: 'Jevris status',
    description:
      'Current Jevris mode, sidecar state, decision health, model pin, active workers, budget and kill switch for this workspace. Read-only.',
    inputSchema: input({}),
    effect: 'read',
  },
  {
    name: 'jevris_explain_decision',
    op: 'explain',
    title: 'Explain a Jevris decision',
    description:
      'Explains one recorded decision: outcome, reason codes, resolved model, token usage, uncertainty and whether anything was applied. Read-only.',
    inputSchema: input(
      {
        decisionId: id('The decision id, as shown by jevris_status.'),
        sliceId: id("A task slice (such as bounded-edit): the trace then shows that slice's route learning (mode, policy version and why)."),
      },
      ['decisionId'],
    ),
    effect: 'read',
  },
  {
    name: 'jevris_plan_route',
    op: 'route',
    title: 'Model route advice',
    description:
      'Advice on the main-session model and on managed workers. It never switches a model and never overrides a pinned one; the user decides.',
    inputSchema: input({
      currentModel: harnessModel('The model the session uses now, if known, as the harness names it (provider/model and a [1m] suffix are accepted).'),
      modelPin: harnessModel('A model the user pinned, as the harness names it. It is always kept.'),
      effortPin: id('An effort level the user pinned.'),
      taskId: id('The task this advice is for, if any.'),
      sliceId: id('The task slice (such as bounded-edit), so a released calibration for it can apply to worker advice.'),
      task: input({
        title: text(2000, 'What the task is, in a sentence. Reduced to a verb class locally; sent only when source egress is approved.'),
        paths: { type: 'array', maxItems: 64, items: { type: 'string', minLength: 1, maxLength: 512 }, description: 'Files the task will touch. Only counts and categories are used; names are never sent to Jev.' },
        checkIds: { type: 'array', maxItems: 64, items: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$', maxLength: 128 }, description: 'Acceptance check ids.' },
      }),
      remaining: input(
        { inputTokens: tokens('Input tokens the rest of the task needs.'), outputTokens: tokens('Output tokens the rest of the task needs.') },
        ['inputTokens', 'outputTokens'],
      ),
      contextTokens: tokens('The context the task needs, in tokens.'),
      session: input(
        {
          warmPrefixTokens: tokens('Tokens of the cached prompt prefix a switch would move to the new model. Without it a switch cannot be priced and the model is kept.'),
          cacheWarm: { type: 'boolean', description: 'Whether that prefix is cached now (default true).' },
          atBoundary: { type: 'boolean', description: 'Whether the session is at a step boundary (default true). Mid-step, a switch is never advised.' },
          unitsSinceLastSwitch: { type: 'integer', minimum: 0, maximum: 1_000_000, description: 'Units of work since the last switch (default 2).' },
          switchesThisTask: { type: 'integer', minimum: 0, maximum: 1_000_000, description: 'Switches already made in this task (default 0).' },
          authMode: { type: 'string', enum: ['api-key', 'subscription', 'unknown'], description: "How the session's harness is billed (default unknown). It labels the transition cost: list price on an API key, an API-equivalent estimate of usage-limit use on a subscription." },
        },
        ['warmPrefixTokens'],
      ),
    }),
    effect: 'advise',
  },
  {
    name: 'jevris_select_evidence',
    op: 'evidence.select',
    title: 'Select evidence',
    description: 'Selects the most relevant evidence handles for an intent. Returns handles and short labels, not file contents. Read-only.',
    inputSchema: input(
      { intent: text(500, 'What the evidence is for.'), maxItems: { type: 'integer', minimum: 1, maximum: 64, description: 'At most this many items (default 16).' } },
      ['intent'],
    ),
    effect: 'read',
  },
  {
    name: 'jevris_evidence_get',
    op: 'evidence.get',
    title: 'Get evidence',
    description: 'Returns one evidence item by handle, bounded and possibly truncated, through the same egress checks as the CLI. Read-only.',
    inputSchema: input(
      {
        handle: { type: 'string', pattern: HANDLE, maxLength: 67, description: 'An evidence handle, ev: and 64 lower-case hex digits, as jevris verify names it. Other forms are refused.' },
        selectionId: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$', maxLength: 64, description: 'The selectionId of the evidence selection that listed this handle, if any.' },
      },
      ['handle'],
    ),
    effect: 'read',
  },
  {
    name: 'jevris_checkpoint',
    op: 'checkpoint',
    title: 'Checkpoint',
    description:
      'Saves a memory capsule of the objective, declared constraints and changed files under the Jevris data directory. It never triggers or replaces compaction.',
    inputSchema: input({
      objective: text(4000, 'The current objective in one or two sentences.'),
      constraints: { type: 'array', items: text(1000, 'One constraint to keep.'), maxItems: 64, description: 'Constraints that must survive compaction.' },
      taskId: id('The task this checkpoint belongs to, if any.'),
    }),
    effect: 'write-local',
  },
  {
    name: 'jevris_get_task',
    op: 'task.get',
    title: 'Get task',
    description: 'Returns a task with its state, acceptance checks and runner receipts from the Jevris store. Read-only.',
    inputSchema: input({ taskId: id('The task id.') }, ['taskId']),
    effect: 'read',
  },
  {
    name: 'jevris_record_verification',
    op: 'verification.record',
    title: 'Link a verification receipt',
    description:
      'Links an existing runner receipt to a check. It records only a pointer: it cannot create a receipt or mark a check passed.',
    inputSchema: input(
      { receiptId: id('An existing runner receipt id.'), checkId: id('The acceptance check it belongs to.'), taskId: id('The task, if any.') },
      ['receiptId', 'checkId'],
    ),
    effect: 'write-local',
  },
  {
    name: 'jevris_submit_task',
    op: 'task.submit',
    title: 'Submit owned work',
    description:
      'Submits a task node for Jevris-owned orchestration. Works only when the user turned on owned mode for this workspace with the jevris CLI; returns the lease ids actually granted, or the reason nothing was granted.',
    inputSchema: input({ task: { type: 'object', description: 'A TaskNode object (§6.2).' } }, ['task']),
    effect: 'submit',
    ownedOnly: true,
  },
  {
    name: 'jevris_handoff_export',
    op: 'handoff.export',
    title: 'Export a handoff capsule',
    description: 'Returns a portable memory capsule for another session or harness. Grants no authority. Read-only.',
    inputSchema: input({ capsuleId: id('A capsule id; the newest capsule when omitted.'), taskId: id('The task, if any.') }),
    effect: 'read',
  },
  {
    name: 'jevris_handoff_import',
    op: 'handoff.import',
    title: 'Import a handoff capsule',
    description:
      'Checks a capsule from another session (workspace match, expiry, contract) and pins its facts as context. It never grants authority or runs anything.',
    inputSchema: input({ capsule: { type: 'object', description: 'A capsule from jevris_handoff_export.' } }, ['capsule']),
    effect: 'write-local',
  },
  {
    name: 'jevris_plan',
    op: 'plan',
    title: 'Validate a plan',
    description:
      'Validates a task graph: cycles, unknown dependencies, missing acceptance checks and requirements, and parallel tasks that share a write scope. Returns waves, the critical path and ready tasks. Read-only.',
    inputSchema: input({ tasks: { type: 'array', items: { type: 'object' }, minItems: 1, maxItems: 1024, description: 'TaskNode objects (§6.2).' } }, ['tasks']),
    effect: 'read',
  },
  {
    name: 'jevris_recover',
    op: 'recover',
    title: 'Recovery advice',
    description:
      'Classifies repeated failures, oscillation and environment failures and names one next action. Advice only; nothing is run or restored.',
    inputSchema: input({
      fingerprints: { type: 'array', items: text(200, 'A short failure fingerprint.'), maxItems: 256, description: 'Failure fingerprints in the order they happened.' },
      environment: { type: 'array', items: { type: 'boolean' }, maxItems: 256, description: 'One entry per fingerprint: true when it was an environment failure.' },
      rejectedApproaches: { type: 'array', items: text(500, 'An approach not to repeat.'), maxItems: 32 },
      taskId: id('The task, if any.'),
    }),
    effect: 'advise',
  },
  {
    name: 'jevris_verify',
    op: 'verify',
    title: 'Verification status',
    description:
      'Reports whether each declared check has a current passing runner receipt. It never runs a check and never marks one passed; run checks with the jevris CLI.',
    inputSchema: input({
      checkIds: { type: 'array', items: id('A check id.'), maxItems: 512 },
      taskId: id('The task, if any.'),
    }),
    effect: 'read',
  },
  {
    name: 'jevris_configure',
    op: 'configure',
    title: 'Show settings',
    description: 'Shows the effective Jevris settings and where they come from. Read-only: settings change only from the jevris CLI.',
    inputSchema: input({}),
    effect: 'read',
  },
  {
    name: 'jevris_delivery_report',
    op: 'capability.advise',
    title: 'Delivery report',
    description:
      'A delivery report on the change in this workspace, from receipts, the task graph, git and workspace files: C57 pull-request readiness, C58 CI failure triage, C59 dependency-upgrade risk, C60 migration rehearsal, C61 documentation drift, C64 team configuration. Advice only: it never opens, merges or comments on a pull request, never changes CI, never installs a package and never runs a migration; the user does those.',
    inputSchema: input(
      {
        capabilityId: { type: 'string', enum: ['C57', 'C58', 'C59', 'C60', 'C61', 'C64'], description: 'Which report: C57 pr-readiness, C58 ci-triage, C59 upgrades, C60 migrations, C61 docs-drift, C64 team-policy.' },
        taskId: id('The task the report is for, if any.'),
        input: input({
          base: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._/@^~-]{0,199}$', description: 'C57, C59, C60, C61: the revision the change is measured from (default HEAD).' },
          unresolvedComments: { type: 'integer', minimum: 0, maximum: 100_000, description: 'C57: unresolved review comments the user reported.' },
          migrations: { type: 'array', items: text(512, 'A migration file relative to the workspace.'), minItems: 1, maxItems: 32, description: 'C60: the migration files to check (default: the changed ones).' },
          compatibility: text(2000, 'C60: the backward-compatibility contract the migration must keep.'),
        }),
      },
      ['capabilityId'],
    ),
    effect: 'advise',
  },
  {
    name: 'jevris_advise',
    op: 'capability.advise',
    title: 'Orchestration and verification advice',
    description:
      'Advice from the task graph, receipts, git and workspace files: C25 dependency suggestions, C26 worker-role allocation, C28 duplicate work, C30 handoff readiness, C41 test impact, C42 failure clusters, C43 patch ranking, C44 review areas, C45 requirements-to-evidence, C46 flaky tests, C47 security escalation. Advice only: nothing is started, run, cancelled, changed or approved.',
    inputSchema: input(
      {
        capabilityId: { type: 'string', enum: ['C25', 'C26', 'C28', 'C30', 'C41', 'C42', 'C43', 'C44', 'C45', 'C46', 'C47'], description: 'Which capability.' },
        taskId: id('The task the advice is for, if any.'),
        input: input({
          base: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._/@^~-]{0,199}$', description: 'C41, C42, C44, C47: the revision the change is measured from (default HEAD).' },
          planId: id('C25: the submitted plan to check (default: the planned tasks).'),
          phase: { type: 'string', enum: ['explorer', 'implementer', 'verifier', 'reviewer'], description: 'C26: the phase a worker is needed for.' },
          requiredTools: { type: 'array', items: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_.:-]{0,63}$' }, maxItems: 32, description: 'C26: tools the worker needs beyond the phase defaults.' },
          intent: text(1000, 'C26: what the worker is for.'),
          taskId: id('C30: the task to hand off (default: the taskId above).'),
          sourceRefs: { type: 'array', items: text(300, 'A source reference.'), maxItems: 64, description: 'C30: sources the next worker needs.' },
          diffHandle: { type: 'string', pattern: '^[a-z]+:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$', description: 'C30: evidence handle of the latest diff.' },
          patches: {
            type: 'array',
            minItems: 1,
            maxItems: 8,
            items: input({ id: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_.-]{0,63}$' }, diff: { type: 'string', minLength: 1, maxLength: 65_536 } }, ['id', 'diff']),
            description: 'C43: candidate patches to rank.',
          },
          taskIds: { type: 'array', items: id('A task id.'), maxItems: 8, description: 'C43: tasks whose worker patches to rank.' },
          requirement: text(1000, 'C43: the requirement the patches must meet.'),
          protectedPaths: { type: 'array', items: text(300, 'A path.'), maxItems: 64, description: 'C44: paths that always need review.' },
          requirementIds: { type: 'array', items: id('A requirement id.'), maxItems: 256, description: 'C45: requirements to audit (default: the task\'s).' },
          requirementTexts: { type: 'object', additionalProperties: text(1000, 'The requirement text.'), description: 'C45: requirement id to text.' },
          checkId: id('C46: the check to investigate.'),
        }),
      },
      ['capabilityId'],
    ),
    effect: 'advise',
  },
];

export function annotationsFor(tool: ToolSpec): { readonly [key: string]: boolean | string } {
  return {
    title: tool.title,
    readOnlyHint: tool.effect === 'read' || tool.effect === 'advise',
    destructiveHint: false,
    idempotentHint: tool.effect !== 'submit',
    openWorldHint: false,
  };
}

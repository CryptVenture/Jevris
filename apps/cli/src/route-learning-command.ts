/**
 * `jevris route learning` (C16, C52): C's baseline-first route learning (538cf77), from the CLI
 * only. The state is the workspace's `<data>/route-learning/<workspace id>.json`, read and written
 * with C's loadLearningState and saveLearningState; every policy change goes through C's pure
 * functions and makes a new policy version (settings do not). Learning is on and automatic by
 * default; off, automatic off (review) and pin are the opt-outs. An arm is a model at an effort
 * (C's 1fc41b9): a pin fixes both, and every model shown carries its effort when it is not the
 * model's default (C's armLabel). Thresholds come only from the
 * owner lock (C's automaticPromotionReady); nothing here holds one. No MCP tool reaches any of it.
 * The learning shared by the workspaces on this machine (C's 7bea448) is cleared for all of them
 * with `reset --machine` (C's resetMachineLearning); `reset --clear-evidence` also withdraws this
 * workspace's contribution (C's withdrawMachineContribution). `gone` lists and clears the models
 * found gone on this machine (C's model availability, f5b19ab): per machine, so no workspace.
 * `export-cases` writes this workspace's local calibration cases through the sidecar's
 * `calibration.export` (C's 01c1e29); `reset --clear-evidence` also removes that file.
 */
import {
  acceptProposal,
  activeVersion,
  clearModelAvailability,
  armLabel,
  automaticPromotionReady,
  emptyLearningState,
  EFFORT_LEVELS,
  explainSliceLearning,
  isEffortLevel,
  learningSettings,
  loadLearningState,
  loadModelRegistry,
  pinSlice,
  removeLocalCalibrationCases,
  rejectProposal,
  resetLearning,
  resetMachineLearning,
  rollbackLearning,
  rulesAttribution,
  saveLearningState,
  slicePolicy,
  unpinSlice,
  withdrawMachineContribution,
  type LearningState,
} from '@jevris/core';
import { COMMAND_EXIT_CODES, MODEL_ID_PATTERN, RouteLearningGoneContract, type RouteLearningGoneOutput } from '@jevris/contracts';
import { modelAvailabilityView } from './model-availability.js';
import { homeRefusal } from './public/home-guard.js';
import { defaultPorts } from './public/ports.js';
import { ROUTE_LEARNING_HELP } from './route-learning-help.js';
import { authorized, contextFor, parse, type VerifyAdminOptions } from './verify-admin.js';

type Write = (text: string) => void;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SUBCOMMANDS = new Set(['status', 'on', 'off', 'accept', 'reject', 'pin', 'unpin', 'reset', 'rollback', 'automatic', 'gone', 'export-cases']);
const MODEL_ID = new RegExp(MODEL_ID_PATTERN);
/** Shown for SlicePolicy.mode: `auto` routes the learned model, so users read it as active. */
const MODE_WORD = { advise: 'advice only', auto: 'active', pinned: 'pinned' } as const;

function pct(x: number | null): string {
  return x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`;
}

/**
 * The slices worth showing: every slice with outcomes (the aggregate, not the 30-day raw window),
 * a baseline, a policy in any version, or a proposal.
 */
function slicesOf(state: LearningState): string[] {
  const ids = new Set<string>(Object.keys(state.arms));
  for (const id of Object.keys(state.baseline)) ids.add(id);
  for (const v of state.versions) {
    for (const id of Object.keys(v.slices)) ids.add(id);
    if (v.sliceId !== null) ids.add(v.sliceId);
  }
  for (const p of state.proposals) ids.add(p.sliceId);
  return [...ids].sort();
}

/** Runs `jevris route learning ...` (argv after `learning`). */
export async function runRouteLearningCommand(argv: readonly string[], write: Write, options: VerifyAdminOptions = {}): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    write(`${ROUTE_LEARNING_HELP}\n`);
    return argv.length === 0 ? COMMAND_EXIT_CODES.usage : COMMAND_EXIT_CODES.ok;
  }
  const sub = argv[0] ?? '';
  const parsed = parse(argv.slice(1), ['--home', '--workspace', '--slice', '--effort'], ['--yes', '--json', '--advise', '--clear-evidence', '--machine', '--all']);
  const json = typeof parsed !== 'string' && parsed.flags.has('--json');
  const usage = (message: string): number => {
    write(json ? `${JSON.stringify({ error: { code: 'USAGE', message } })}\n` : `${message}\nRun jevris route learning --help for usage.\n`);
    return COMMAND_EXIT_CODES.usage;
  };
  if (!SUBCOMMANDS.has(sub)) return usage(`Unknown route learning subcommand ${sub.slice(0, 40)}. Use status, off, on, pin, unpin, reset, rollback, automatic, accept, reject, gone or export-cases.`);
  if (typeof parsed === 'string') return usage(parsed);
  const args = parsed.positionals;
  const flag = (name: string) => parsed.flags.has(name);
  if (parsed.values.has('--slice') && sub !== 'status') return usage('--slice applies only to status.');
  if (flag('--advise') && sub !== 'pin') return usage('--advise applies only to pin.');
  const effort = parsed.values.get('--effort') ?? null;
  if (effort !== null && (sub !== 'pin' || flag('--advise'))) return usage('--effort applies only to pin <slice> <model>.');
  if (effort !== null && !isEffortLevel(effort)) return usage(`--effort takes one of ${EFFORT_LEVELS.join(', ')}.`);
  if (flag('--clear-evidence') && sub !== 'reset') return usage('--clear-evidence applies only to reset.');
  if (flag('--machine') && sub !== 'reset') return usage('--machine applies only to reset.');
  if (flag('--all') && !(sub === 'gone' && args[0] === 'clear')) return usage('--all applies only to gone clear.');
  if (flag('--machine') && flag('--clear-evidence')) return usage('Use reset --machine or reset --clear-evidence, not both.');
  if (flag('--yes') && (sub === 'status' || (sub === 'gone' && args[0] !== 'clear'))) return usage(`${sub === 'gone' ? 'gone list' : 'status'} changes nothing; --yes does not apply.`);
  if (flag('--yes') && sub === 'export-cases') return usage('export-cases asks nothing; --yes does not apply.');
  const slice = parsed.values.get('--slice');
  if (slice !== undefined && !ID.test(slice)) return usage('--slice takes a slice id such as bounded-edit.');
  // Arguments per subcommand, all checked before anything is read.
  switch (sub) {
    case 'status':
    case 'export-cases':
    case 'reset':
    case 'on':
    case 'off':
      if (args.length !== 0) return usage(`route learning ${sub} takes no positional arguments.`);
      break;
    case 'accept':
    case 'reject':
      if (args.length !== 1 || !ID.test(args[0] ?? '')) return usage(`Name one proposal: jevris route learning ${sub} <proposal-id>.`);
      break;
    case 'pin':
      if (!ID.test(args[0] ?? '') || (flag('--advise') ? args.length !== 1 : args.length !== 2 || !ID.test(args[1] ?? ''))) return usage('Use jevris route learning pin <slice> <model> [--effort <level>], or pin <slice> --advise.');
      break;
    case 'unpin':
      if (args.length !== 1 || !ID.test(args[0] ?? '')) return usage('Name one slice: jevris route learning unpin <slice>.');
      break;
    case 'rollback':
      if (args.length !== 1 || !/^(0|[1-9][0-9]{0,8})$/.test(args[0] ?? '')) return usage('Name a version number: jevris route learning rollback <version>.');
      break;
    case 'automatic':
      if (args.length !== 1 || (args[0] !== 'on' && args[0] !== 'off')) return usage('Use jevris route learning automatic on, or automatic off.');
      break;
    case 'gone': {
      const clearing = args[0] === 'clear';
      const listing = args.length === 0 || (args.length === 1 && args[0] === 'list');
      const target = flag('--all') ? args.length === 1 : args.length === 2 && MODEL_ID.test(args[1] ?? '');
      if (!listing && !(clearing && target)) return usage('Use jevris route learning gone list, gone clear <model-id>, or gone clear --all.');
      break;
    }
  }

  const ctx = contextFor(parsed, options, options.ports ?? (await defaultPorts()));
  const refusedHome = homeRefusal(ctx);
  if (refusedHome !== null) return usage(refusedHome);
  const command = `route learning ${sub}`;
  const out = (result: object, lines: readonly string[], code: number): number => {
    write(json ? `${JSON.stringify({ schemaVersion: '1.0', command, ...result })}\n` : `${lines.join('\n')}\n`);
    return code;
  };

  // gone: the models found gone on this machine. The record is per machine, so no workspace.
  if (sub === 'gone') return goneCommand(ctx.home, args[0] === 'clear' ? (flag('--all') ? 'all' : String(args[1])) : null, json, write, () => authorized(parsed, options, goneQuestion(flag('--all') ? 'all' : String(args[1])), write, json, 'This changes which models Jevris recommends'));

  // reset --machine: the layer every workspace on this machine shares. It needs no workspace and
  // changes no workspace's own outcomes or policy; each contributes again from its next outcome.
  if (flag('--machine')) {
    const question = 'Clear the route learning shared by every workspace on this machine? Each workspace keeps its own outcomes and policy. [y/N] ';
    if (!(await authorized(parsed, options, question, write, json, 'This changes how workers are routed'))) return COMMAND_EXIT_CODES.usage;
    const cleared = await resetMachineLearning(ctx.home);
    const files = `${String(cleared.removed)} contribution${cleared.removed === 1 ? '' : 's'} removed`;
    if (!cleared.ok) return out({ changed: false, reasonCode: 'WRITE_FAILED', scope: 'machine', removed: cleared.removed }, [`The shared route learning could not be fully cleared (${files}); run the reset again.`], COMMAND_EXIT_CODES.negative);
    return out(
      { changed: true, reasonCode: 'CHANGED', scope: 'machine', removed: cleared.removed },
      [`The route learning shared by the workspaces on this machine is cleared (${files}). Each workspace keeps its own outcomes and policy and contributes again from its next outcome.`],
      COMMAND_EXIT_CODES.ok,
    );
  }
  if (ctx.workspaceRoot === null || !ID.test(ctx.workspaceId)) return usage('No workspace here. Run this inside a repository or pass --workspace <dir>.');
  if (sub === 'export-cases') return exportCases(ctx, json, write);
  const now = new Date(ctx.nowMs()).toISOString();
  const loaded = await loadLearningState({ home: ctx.home, workspaceId: ctx.workspaceId });
  // R4 (owner decision 9d6a66d): the loaded registry (an administrator's override included), so a
  // pin at a model's default effort is stored as the bare model and every label reads the same data.
  const registry = (await loadModelRegistry({ home: ctx.home }).catch(() => null)) ?? undefined;

  if (sub === 'status') {
    const readiness = automaticPromotionReady();
    const settings = loaded?.settings ?? learningSettings();
    // Models found gone on this machine are never routed, whatever a slice's evidence says.
    const gone = await modelAvailabilityView(ctx.home);
    const unavailable = { registrySnapshotId: gone.registrySnapshotId, entries: gone.entries };
    const automatic = { enabled: settings.promotionMode === 'automatic', ready: readiness.ready, reasonCode: readiness.ready ? null : readiness.reasonCode };
    const header = [
      settings.enabled
        ? `Route learning is on in this workspace; changes ${automatic.enabled ? 'apply automatically with the owner-locked thresholds' : 'wait as proposals for your review'}.`
        : 'Route learning is off in this workspace: managed workers keep their model and nothing is explored. Outcomes are still counted (jevris route learning on).',
    ];
    if (loaded === null) {
      const lines = [...header, 'No local outcomes yet: each slice follows the signed baseline release where one supports it, else the baseline model.', ...(gone.lines.length > 0 ? ['', ...gone.lines] : [])];
      return out({ learned: false, enabled: settings.enabled, version: 0, automatic, slices: [], attribution: [], pendingProposals: 0, unavailable }, lines, COMMAND_EXIT_CODES.ok);
    }
    const ids = slice !== undefined ? [slice] : slicesOf(loaded);
    const slices = ids.map((id) => explainSliceLearning(loaded, id, undefined, registry === undefined ? {} : { registry }));
    const attribution = rulesAttribution(loaded).filter((a) => slice === undefined || a.sliceId === slice);
    const pending = loaded.proposals.filter((p) => p.status === 'pending');
    const byMode = (mode: keyof typeof MODE_WORD) => slices.filter((s) => s.policy.mode === mode).map((s) => s.sliceId).join(', ') || 'none';
    const lines = [
      ...header,
      `Policy v${String(activeVersion(loaded).version)}. Slices ${MODE_WORD.auto}: ${byMode('auto')}; ${MODE_WORD.pinned}: ${byMode('pinned')}. ${String(pending.length)} pending proposal${pending.length === 1 ? '' : 's'}.`,
    ];
    if (slices.length === 0) lines.push('No slice has a baseline or local outcomes yet.');
    for (const s of slices) lines.push('', ...s.lines);
    if (gone.lines.length > 0) lines.push('', ...gone.lines);
    if (attribution.length > 0) lines.push('', 'Agreement with the rules-only choice (rates only; no saving is claimed):');
    for (const a of attribution) {
      lines.push(`- ${a.sliceId}: ${String(a.routes)} routes; agreed ${String(a.agreedWithRules)} (verified success ${pct(a.agreedSuccessRate)}), differed ${String(a.differedFromRules)} (verified success ${pct(a.differedSuccessRate)})`);
    }
    return out({ learned: true, enabled: settings.enabled, version: activeVersion(loaded).version, automatic, slices, attribution, pendingProposals: pending.length, unavailable }, lines, COMMAND_EXIT_CODES.ok);
  }

  // automatic on is refused before any question while the owner has not locked the thresholds.
  if (sub === 'automatic' && args[0] === 'on') {
    const readiness = automaticPromotionReady();
    if (!readiness.ready) {
      return out(
        { changed: false, reasonCode: readiness.reasonCode, promotionMode: (loaded?.settings ?? learningSettings()).promotionMode },
        ['Automatic changes are not yet calibrated: the owner has not locked their thresholds, so changes still wait as proposals (jevris route learning status).'],
        COMMAND_EXIT_CODES.negative,
      );
    }
  }

  const state = loaded ?? emptyLearningState({ workspaceId: ctx.workspaceId, now });
  const refuse = (reasonCode: string, text: string) => out({ changed: false, reasonCode, version: activeVersion(state).version }, [text], COMMAND_EXIT_CODES.negative);
  // What would change, checked before the question so a refusal never asks.
  if (sub === 'accept') {
    const proposal = state.proposals.find((p) => p.proposalId === args[0]);
    if (proposal === undefined) return refuse('PROPOSAL_UNKNOWN', `There is no proposal ${String(args[0])}; nothing changed.`);
    if (proposal.status !== 'pending') return refuse('PROPOSAL_NOT_PENDING', `Proposal ${String(args[0])} is ${proposal.status}; nothing changed.`);
  }
  if (sub === 'reject' && !state.proposals.some((p) => p.proposalId === args[0] && p.status === 'pending')) {
    return refuse(state.proposals.some((p) => p.proposalId === args[0]) ? 'PROPOSAL_NOT_PENDING' : 'PROPOSAL_UNKNOWN', `There is no pending proposal ${String(args[0])}; nothing changed.`);
  }
  if (sub === 'unpin' && slicePolicy(state, args[0] as string).mode !== 'pinned') return refuse('NOT_PINNED', `Slice ${String(args[0])} is not pinned; nothing changed.`);
  if (sub === 'rollback' && !state.versions.some((v) => v.version === Number(args[0]))) return refuse('VERSION_UNKNOWN', `There is no policy version ${String(args[0])}; nothing changed.`);

  // The pinned arm as people read it: the model, with its effort unless that is the default.
  const pinTarget = flag('--advise') ? 'advice only' : armLabel(String(args[1]), effort, registry);
  const questions: { readonly [key: string]: string } = {
    accept: `Accept proposal ${String(args[0])}? Its slice then routes the proposed model automatically. [y/N] `,
    reject: `Reject proposal ${String(args[0])}? [y/N] `,
    pin: `Pin slice ${String(args[0])} to ${pinTarget}? Learning will not change it. [y/N] `,
    unpin: `Unpin slice ${String(args[0])}? It returns to the baseline and local-evidence decision. [y/N] `,
    reset: `Reset every slice to the day-1 baseline${flag('--clear-evidence') ? ", delete the local outcomes and withdraw this workspace's share of the machine-wide learning" : ''}? [y/N] `,
    on: 'Turn route learning on in this workspace? Slices the evidence supports are then routed to the learned model. [y/N] ',
    rollback: `Restore the policy of version ${String(args[0])} as a new version? [y/N] `,
    automatic: 'Apply changes automatically? Slices that pass the owner-locked thresholds then switch without asking you; pin or reset undoes it. [y/N] ',
  };
  const lowersAutonomy = sub === 'off' || (sub === 'automatic' && args[0] === 'off');
  if (!lowersAutonomy && !(await authorized(parsed, options, questions[sub] ?? '', write, json, 'This changes how workers are routed'))) return COMMAND_EXIT_CODES.usage;

  let next: LearningState = state;
  let text: string;
  switch (sub) {
    case 'accept': {
      const accepted = acceptProposal(state, args[0] as string, now);
      if (!accepted.ok) return refuse(accepted.reasonCode, `Nothing changed (${accepted.reasonCode}).`);
      next = accepted.state;
      text = `Accepted proposal ${String(args[0])}; policy v${String(accepted.version.version)}.`;
      break;
    }
    case 'reject':
      next = rejectProposal(state, args[0] as string);
      text = `Rejected proposal ${String(args[0])}; the policy is unchanged.`;
      break;
    case 'pin':
      next = pinSlice(state, args[0] as string, flag('--advise') ? null : (args[1] as string), now, effort, registry);
      text = `Pinned slice ${String(args[0])} to ${pinTarget}; policy v${String(activeVersion(next).version)}.`;
      break;
    case 'unpin':
      next = unpinSlice(state, args[0] as string, now);
      text = `Slice ${String(args[0])} is no longer pinned: the baseline and local evidence decide it again; policy v${String(activeVersion(next).version)}.`;
      break;
    case 'reset':
      next = resetLearning(state, now, { clearEvidence: flag('--clear-evidence') });
      // Clearing the evidence also withdraws this workspace's contribution to the shared layer.
      if (flag('--clear-evidence')) next = await withdrawMachineContribution(ctx.home, next);
      text = `Every slice is back to the day-1 baseline${flag('--clear-evidence') ? ", the local outcomes were deleted and this workspace's share of the machine-wide learning was withdrawn" : '; local outcomes are kept'}; policy v${String(activeVersion(next).version)}.`;
      break;
    case 'rollback': {
      const rolled = rollbackLearning(state, Number(args[0]), now);
      if (!rolled.ok) return refuse(rolled.reasonCode, `Nothing changed (${rolled.reasonCode}).`);
      next = rolled.state;
      text = `Restored version ${String(args[0])} as policy v${String(activeVersion(next).version)}.`;
      break;
    }
    case 'on':
      next = { ...state, settings: learningSettings({ ...state.settings, enabled: true }) };
      text = 'Route learning is on in this workspace.';
      break;
    case 'off':
      next = { ...state, settings: learningSettings({ ...state.settings, enabled: false }) };
      text = 'Route learning is off in this workspace: managed workers keep their model and nothing is explored. Outcomes are still counted.';
      break;
    default: {
      // automatic on (ready, confirmed) or off (review).
      const readiness = automaticPromotionReady();
      if (args[0] === 'on' && readiness.ready) {
        const t = readiness.thresholds;
        next = {
          ...state,
          settings: learningSettings({
            ...state.settings,
            promotionMode: 'automatic',
            explorationRate: t.explorationRate,
            nonInferiorityMargin: t.nonInferiorityMargin,
            activateBelow: t.activateBelow,
            deactivateAbove: t.deactivateAbove,
            flapFloor: t.flapFloor,
            priorWeight: t.priorWeight,
            demotionWindow: t.demotionWindow,
          }),
        };
        text = `Changes apply automatically, with the thresholds locked on ${t.lockedOn}. Pin a slice or reset to undo a change.`;
      } else {
        next = { ...state, settings: learningSettings({ ...state.settings, promotionMode: 'review' }) };
        text = 'Changes now wait as proposals for your review (jevris route learning accept or reject).';
      }
    }
  }
  const saved = await saveLearningState(ctx.home, next);
  if (!saved.ok) return out({ changed: false, reasonCode: 'WRITE_FAILED' }, ['The learning state could not be written; nothing changed.'], COMMAND_EXIT_CODES.negative);
  const changed = { changed: true, reasonCode: 'CHANGED', version: activeVersion(next).version, enabled: next.settings.enabled, promotionMode: next.settings.promotionMode };
  if (sub === 'reset' && flag('--clear-evidence')) {
    // The store half of "clear the evidence" (owner decision 7922ee3; B a51d524): this workspace's
    // decision outcomes and advice-adherence records. Reported as a reason code only.
    const storePurge = await purgeWorkspaceLearning(ctx.home, ctx.workspaceId);
    const purged = storePurge === 'STORE_PURGED' || storePurge === 'NO_STORE';
    const retry = storePurge === 'KILL_SWITCH' ? 'clear the kill switch (jevris kill-switch clear), then run the reset again' : 'run jevris data delete --scope learning to retry';
    const line = purged ? `This workspace's learning records in the store were removed (${storePurge}).` : `This workspace's learning records in the store were not removed (${storePurge}); ${retry}.`;
    // The local calibration cases file (C's 01c1e29) is built from those records, so it goes too.
    // A stopped Jevris removes nothing (JEV-0021): the cases file stays with the store records.
    const calibrationCases = storePurge === 'KILL_SWITCH' ? 'KILL_SWITCH' : (await removeLocalCalibrationCases(ctx.home, ctx.workspaceId)).ok ? 'REMOVED' : 'REMOVE_FAILED';
    const casesLine = calibrationCases === 'KILL_SWITCH' ? "This workspace's local calibration cases file was not removed (KILL_SWITCH)." : calibrationCases === 'REMOVED' ? "This workspace's local calibration cases file was removed (REMOVED)." : "This workspace's local calibration cases file was not removed (REMOVE_FAILED); run the reset again.";
    return out({ ...changed, storePurge, calibrationCases }, [text, line, casesLine], purged && calibrationCases === 'REMOVED' ? COMMAND_EXIT_CODES.ok : COMMAND_EXIT_CODES.negative);
  }
  return out(changed, [text], COMMAND_EXIT_CODES.ok);
}

/** B's purgeStoreLearning for one workspace, as one reason code: STORE_PURGED, NO_STORE, or B's refusal code. */
async function purgeWorkspaceLearning(home: string, workspaceId: string): Promise<string> {
  try {
    const { purgeStoreLearning } = await import('./runtime-commands.js');
    const purged = await purgeStoreLearning(home, { workspaceId });
    if (!purged.ok) return purged.reasonCode;
    return purged.via === 'none' ? 'NO_STORE' : 'STORE_PURGED';
  } catch {
    return 'STORE_REFUSED';
  }
}

const COUNT = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const LINE = (x: unknown): x is string => typeof x === 'string' && x.length <= 2000 && !/[\u0000-\u001f\u007f]/.test(x);
const EXCLUDED = ['sessionWindowOnly', 'notVerified', 'noRecord', 'noProbabilities', 'overCap'] as const;

/** The sidecar's `calibration.export` reply, checked field by field; null when it does not match. */
function checkCalibrationExport(raw: unknown): object | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const totals = r['totals'] as Record<string, unknown> | null | undefined;
  const excluded = r['excluded'] as Record<string, unknown> | null | undefined;
  const lines = r['lines'];
  if (r['schemaVersion'] !== 'jevris-calibration-export-1' || !LINE(r['file']) || !COUNT(r['groups'])) return null;
  if (typeof totals !== 'object' || totals === null || !COUNT(totals['decisions']) || !COUNT(totals['cases'])) return null;
  if (typeof excluded !== 'object' || excluded === null || !EXCLUDED.every((k) => COUNT(excluded[k]))) return null;
  if (!Array.isArray(lines) || lines.length > 32 || !lines.every(LINE)) return null;
  return {
    schemaVersion: r['schemaVersion'],
    file: r['file'],
    totals: { decisions: totals['decisions'], cases: totals['cases'] },
    groups: r['groups'],
    excluded: Object.fromEntries(EXCLUDED.map((k) => [k, excluded[k]])),
    lines,
  };
}

/**
 * `route learning export-cases`: the sidecar's `calibration.export` (C's 01c1e29) writes this
 * workspace's local calibration cases for a person to review; nothing is applied or uploaded. It
 * asks nothing. A refusal is shown as its reason code.
 */
async function exportCases(ctx: ReturnType<typeof contextFor>, json: boolean, write: Write): Promise<number> {
  const command = 'route learning export-cases';
  const refused = (reasonCode: string): number => {
    write(json ? `${JSON.stringify({ schemaVersion: '1.0', command, exported: null, reasonCode })}\n` : `No calibration cases were exported (${reasonCode}).${reasonCode.startsWith('SIDECAR_') && reasonCode !== 'SIDECAR_INVALID_RESULT' ? ' The cases are read by the Jevris sidecar: start it with jevris sidecar start and retry.' : ''}\n`);
    return COMMAND_EXIT_CODES.negative;
  };
  if (ctx.autostart) {
    const ensured = await ctx.ports.sidecar.ensure({ home: ctx.home, waitMs: ctx.sidecarWaitMs });
    if (!ensured.ok) return refused(`SIDECAR_${ensured.reason.toUpperCase()}`);
  }
  const answer = await ctx.ports.sidecar.request({ home: ctx.home, op: 'calibration.export', workspace: ctx.workspaceRoot ?? ctx.workspaceId, body: {}, scope: 'cli', timeoutMs: ctx.requestTimeoutMs, budget: 'background' });
  if (!answer.ok) return refused(answer.reasonCode ?? `SIDECAR_${answer.reason.toUpperCase()}`);
  const exported = checkCalibrationExport(answer.result);
  if (exported === null) return refused('SIDECAR_INVALID_RESULT');
  write(json ? `${JSON.stringify({ schemaVersion: '1.0', command, exported, reasonCode: null })}\n` : `${(exported as { lines: string[] }).lines.join('\n')}\n`);
  return COMMAND_EXIT_CODES.ok;
}

function goneQuestion(target: string): string {
  return target === 'all'
    ? 'Clear every model found gone on this machine? Jevris may recommend them again until one is found gone again. [y/N] '
    : `Clear ${target} from the models found gone on this machine? Jevris may recommend it again until it is found gone again. [y/N] `;
}

/**
 * `route learning gone [list | clear <model-id> | clear --all]` over C's loadModelAvailability and
 * clearModelAvailability. A clear asks first (or takes --yes); one with nothing in force to clear
 * changes nothing, asks nothing and exits 0. The --json line is E's RouteLearningGoneOutput contract.
 */
async function goneCommand(home: string, target: string | null, json: boolean, write: Write, confirm: () => Promise<boolean>): Promise<number> {
  const emit = (result: RouteLearningGoneOutput, lines: readonly string[], code: number): number => {
    const checked = RouteLearningGoneContract.validate(result);
    if (!checked.ok) {
      write(json ? `${JSON.stringify({ error: { code: 'INVALID_RESULT', message: 'The found-gone record did not match its contract.' } })}\n` : 'The found-gone record did not match its contract; nothing changed.\n');
      return COMMAND_EXIT_CODES.negative;
    }
    write(json ? `${JSON.stringify(checked.value)}\n` : `${lines.join('\n')}\n`);
    return code;
  };
  const view = await modelAvailabilityView(home);
  if (target === null) {
    const lines = view.lines.length > 0 ? ['Models found gone on this machine (never recommended, routed or launched here):', ...view.lines] : [`No model is recorded as gone on this machine (registry ${view.registrySnapshotId}).`];
    return emit({ schemaVersion: '1.0', command: 'route learning gone list', registrySnapshotId: view.registrySnapshotId, entries: view.entries, lines: view.lines }, lines, COMMAND_EXIT_CODES.ok);
  }
  const clear = (changed: boolean, reasonCode: 'CHANGED' | 'NOTHING_TO_CLEAR' | 'WRITE_FAILED', removed: number): RouteLearningGoneOutput => ({ schemaVersion: '1.0', command: 'route learning gone clear', target, changed, reasonCode, removed });
  if (!view.entries.some((e) => target === 'all' || e.modelId === target)) {
    // Clearing what is not there is already done: exit 0, nothing asked and nothing written.
    return emit(clear(false, 'NOTHING_TO_CLEAR', 0), [target === 'all' ? 'No model is recorded as gone on this machine; nothing changed.' : `${target} is not recorded as gone on this machine; nothing changed.`], COMMAND_EXIT_CODES.ok);
  }
  if (!(await confirm())) return COMMAND_EXIT_CODES.usage;
  const cleared = await clearModelAvailability(home, target);
  if (!cleared.ok) return emit(clear(false, 'WRITE_FAILED', 0), ['The found-gone record could not be written; nothing changed. Retry in a moment.'], COMMAND_EXIT_CODES.negative);
  const what = target === 'all' ? 'Every model found gone on this machine was cleared' : `${target} was cleared from the models found gone on this machine`;
  return emit(clear(true, 'CHANGED', cleared.removed), [`${what} (${String(cleared.removed)} record${cleared.removed === 1 ? '' : 's'}). Jevris may recommend it again until it is found gone again.`], COMMAND_EXIT_CODES.ok);
}

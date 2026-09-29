/**
 * The Jevris product side of the trial driver: each call goes through a real product surface.
 * - `prepare`: for a product arm, `jevris certify` and `jevris install` into a seed profile
 *   (never the user's home). For Jev decisions it confirms with `jevris status` that decisions
 *   are healthy in that profile, and otherwise refuses the arm before any run.
 * - `route`: `jevris route --json`.
 * - `capsule`: `jevris checkpoint --json`.
 * - `shellTool`: the command's output through D's tool-output distillation (`distillOutput`,
 *   C22, MEM-08). The original output stays retrievable with `jevris evidence get <handle>`.
 * Rules-only decisions run with no sidecar (JEVRIS_SIDECAR_AUTOSTART=0), so no Jev key is used.
 */
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { certifiedHooks, certifyHarness, isolatedEnv } from './certification.js';
import { CLAUDE_MARKETPLACE_REL, defaultHarnessCli, installGlobal, type GlobalHarness, type HarnessCli } from './global-harness.js';
import { runCaptured } from './live-harness.js';
import { createTrialDriver, missingTaskSpecs, unsupportedArms, type ArmPlan, type JevrisPort, type RunNote, type ShellTool, type TrialConfig, type TrialHarness, type TrialHarnessDriver } from './trial-driver.js';
import { runnerFor } from './trial-runners.js';

const CLI_TIMEOUT_MS = 60_000;
const SHELL_TIMEOUT_MS = 600_000;

export interface ProductJevrisOptions {
  /** The Jevris package root (bin/jevris.mjs and dist/runtime). */
  readonly root: string;
  readonly harness: TrialHarness;
  readonly cli?: HarnessCli;
  /** Test seam for `jevris certify` into the seed profile. */
  readonly certify?: (home: string, harness: GlobalHarness) => Promise<{ readonly ok: boolean; readonly error: string | null }>;
  /** Test seam for the `jevris` command; production runs `node <root>/bin/jevris.mjs`. */
  readonly jevris?: (args: readonly string[], options: { readonly cwd: string; readonly env: { readonly [key: string]: string } }) => Promise<{ readonly code: number | null; readonly stdout: string }>;
  readonly tempRoot?: string;
  readonly platform?: string;
}

function installHarness(harness: TrialHarness): GlobalHarness {
  return harness === 'claude-sdk' ? 'claude' : harness;
}

function json(text: string): { readonly [key: string]: unknown } | null {
  try {
    const value = JSON.parse(text.trim()) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as { readonly [key: string]: unknown }) : null;
  } catch {
    return null;
  }
}

/** The environment of a run: the profile as HOME, hooks allowed to act, no sidecar unless Jev. */
export function trialEnv(home: string, decisions: ArmPlan['decisions'], base: { readonly [key: string]: string | undefined } = process.env): { [key: string]: string } {
  const env = isolatedEnv(home, base);
  delete env['JEVRIS_HOOK_OBSERVE_ONLY'];
  if (decisions !== 'jev') env['JEVRIS_SIDECAR_AUTOSTART'] = '0';
  return env;
}

export function productJevris(options: ProductJevrisOptions): JevrisPort {
  const target = installHarness(options.harness);
  const cli = options.cli ?? defaultHarnessCli;
  const platform = options.platform ?? process.platform;
  const runJevris =
    options.jevris ??
    (async (args: readonly string[], run: { readonly cwd: string; readonly env: { readonly [key: string]: string } }) => {
      const ran = await runCaptured(process.execPath, [join(options.root, 'bin', 'jevris.mjs'), ...args], { cwd: run.cwd, env: run.env, timeoutMs: CLI_TIMEOUT_MS });
      return { code: ran.code, stdout: ran.stdout };
    });
  const certify =
    options.certify ??
    (async (home: string, harness: GlobalHarness) => {
      const result = await certifyHarness({ home, harness, json: false, root: options.root, cli });
      const hooks = result.features.filter((item) => item.featureId.startsWith('hooks.'));
      const failed = hooks.filter((item) => !item.passed).map((item) => `${item.featureId} (${item.reasonCode ?? ''})`);
      if (result.error !== null && hooks.length === 0) return { ok: false, error: result.error };
      return failed.length === 0 ? { ok: true, error: null } : { ok: false, error: `hook features not certified: ${failed.join(', ')}` };
    });
  return {
    async prepare({ product, decisions }) {
      const seed = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'jevris-trial-seed-'));
      const env = trialEnv(seed, decisions);
      if (product) {
        const certified = await certify(seed, target);
        if (!certified.ok) return { ok: false, reason: `certify ${target} in the trial profile failed: ${certified.error ?? 'unknown'}` };
        const install = await installGlobal({ home: seed, root: options.root, harness: target, env, cli, platform }, certifiedHooks(seed, cli));
        if (!install.ok) return { ok: false, reason: `install ${target} in the trial profile failed: ${install.error ?? install.status}` };
      }
      if (decisions === 'jev') {
        const status = await runJevris(['status', '--json', '--home', seed], { cwd: seed, env });
        const health = json(status.stdout)?.['decisionHealth'];
        if (health !== 'healthy') return { ok: false, reason: `Jev decisions are not healthy in the trial profile (decisionHealth ${typeof health === 'string' ? health : 'unknown'}); run jevris credential status and jevris doctor` };
      }
      return { ok: true, prepared: { seed, pluginRel: product && target === 'claude' ? join(CLAUDE_MARKETPLACE_REL, 'plugins', 'jevris') : null } };
    },
    env: (home, decisions) => trialEnv(home, decisions),
    async route({ home, cwd, taskId, currentModel, decisions }) {
      const ran = await runJevris(['route', '--json', '--model', currentModel, '--task', taskId, '--home', home], { cwd, env: trialEnv(home, decisions) });
      const main = json(ran.stdout)?.['main'];
      const advice = main !== null && typeof main === 'object' ? (main as { readonly [key: string]: unknown }) : null;
      return advice?.['outcome'] === 'recommend' && typeof advice['recommendedModel'] === 'string' ? advice['recommendedModel'] : null;
    },
    async capsule({ home, cwd, taskId, objective, constraints, decisions }) {
      const args = ['checkpoint', '--json', '--objective', objective, ...constraints.flatMap((c) => ['--constraint', c]), '--task', taskId, '--home', home];
      const ran = await runJevris(args, { cwd, env: trialEnv(home, decisions) });
      const items = json(ran.stdout)?.['items'];
      if (!Array.isArray(items) || items.length === 0) return null;
      const lines = items
        .map((item) => (item !== null && typeof item === 'object' ? (item as { readonly kind?: unknown; readonly text?: unknown }) : null))
        .filter((item): item is { readonly kind: string; readonly text: string } => typeof item?.kind === 'string' && typeof item.text === 'string')
        .map((item) => `- ${item.kind}: ${item.text}`);
      return lines.length === 0 ? null : `Jevris memory capsule for this task:\n${lines.join('\n')}`;
    },
    shellTool({ home, cwd, env }): ShellTool {
      return {
        async run(command, signal) {
          const shell = platform === 'win32' ? [env['ComSpec'] ?? env['COMSPEC'] ?? 'C:\\Windows\\System32\\cmd.exe', '/d', '/s', '/c', command] : ['/bin/sh', '-c', command];
          const [file, ...args] = shell as [string, ...string[]];
          const ran = await runCaptured(file, args, { cwd, env, timeoutMs: SHELL_TIMEOUT_MS, signal });
          const raw = `${ran.stdout}${ran.stderr.length > 0 ? `\n${ran.stderr}` : ''}${ran.timedOut ? '\n[the command timed out]' : ''}`;
          try {
            const orchestrator = await import('@jevris/orchestrator');
            const ws = orchestrator.openWorkspace({ home, env, workspaceRoot: cwd });
            const view = await orchestrator.distillOutput(ws, { command, exitCode: ran.code, stdout: ran.stdout, stderr: ran.stderr });
            if (view.mode === 'distilled') return `${view.text}\n[full output: jevris evidence get ${view.handle}]`;
            return view.text.length > 0 ? view.text : raw;
          } catch {
            // Distillation failing never hides output: the model gets it unchanged.
            return raw;
          }
        },
      };
    },
  };
}

export interface ProductTrialDriverInput {
  /** The parsed, pre-registered trial config (parseTrialConfig). */
  readonly config: TrialConfig;
  /** The tasks runTrial will run (id, repository, slice, difficulty). */
  readonly tasks: readonly { readonly taskId: string }[];
  readonly arms: readonly string[];
  /** The Jevris package root. */
  readonly root: string;
  readonly env?: { readonly [key: string]: string | undefined };
  readonly onRun?: (note: RunNote) => void;
}

/**
 * The release command's entry (`release-evidence.mjs quality-trial`): the product driver for a
 * config, or every reason it cannot run. Nothing is started here; a refusal costs nothing.
 */
export function productTrialDriver(input: ProductTrialDriverInput): { readonly ok: true; readonly driver: TrialHarnessDriver } | { readonly ok: false; readonly problems: readonly string[] } {
  const env = input.env ?? process.env;
  const runner = runnerFor(input.config.harness, env);
  const problems = [
    ...unsupportedArms(input.arms, runner, env).map((item) => `arm ${item.arm}: ${item.reason}`),
    ...missingTaskSpecs(input.tasks, input.config).map((id) => `task ${id} has no entry in the trial config`),
  ];
  if (problems.length > 0) return { ok: false, problems };
  const jevris = productJevris({ root: input.root, harness: input.config.harness });
  return { ok: true, driver: createTrialDriver({ config: input.config, runner, jevris, ...(input.onRun === undefined ? {} : { onRun: input.onRun }) }) };
}

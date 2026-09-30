// The CLI loads @jevris/sidecar lazily (the sidecar package depends on this one, so there is
// no project reference). These are the parts of its API the CLI calls.
declare module '@jevris/sidecar' {
  import type { EnsureSidecarResult, SidecarEndpointFile, SidecarRequestInput, SidecarRequestResult } from '@jevris/contracts';

  export function ensureSidecar(input: { readonly home?: string; readonly waitMs?: number }): Promise<EnsureSidecarResult>;
  export function sidecarRequest(input: SidecarRequestInput): Promise<SidecarRequestResult>;
  /** The autostart wait: the requested one, or JEVRIS_SIDECAR_WAIT_MS (at most 60 s) under a test run. */
  export function sidecarWaitMs(requested: number, env?: { readonly [key: string]: string | undefined }): number;
  export function probeSidecar(home?: string, timeoutMs?: number): Promise<{ readonly running: boolean; readonly endpoint: SidecarEndpointFile | undefined; readonly reachable: boolean; readonly foreign?: true }>;
  export function stopSidecarProcess(
    home?: string,
    timeoutMs?: number,
  ): Promise<{ readonly stopped: boolean; readonly method: 'not-running' | 'shutdown-frame' | 'signal' | 'failed'; readonly pid?: number; readonly foreign?: true }>;
  export function sidecarMain(argv: readonly string[]): Promise<number>;
  export function hostScopeId(home: string): string;
  /** DATA-10: the scope to open a store with, and the earlier host-name scopes it may adopt. */
  export function hostScopeForStore(home: string, dbPath: string): { readonly hostScope: string; readonly adoptHostScopes: () => readonly string[] };
  export function hostScopeInfo(home: string): { readonly scope: string; readonly source: 'machine-id' | 'host-name'; readonly reason: string | null };
  export function legacyHostScopes(home: string): readonly string[];
  /** True when the file is a regular file owned by this user inside this home or its data directory. */
  export function storeBelongsHere(home: string, dbPath: string): boolean;
  /** Where this process runs (IPC-19): container, WSL, SSH or local, and a locality id. */
  export function detectLocality(input?: { readonly platform?: string; readonly env?: { readonly [key: string]: string | undefined } }): {
    readonly kind: 'local' | 'container' | 'wsl' | 'ssh' | 'remote';
    readonly container: boolean;
    readonly ssh: boolean;
    readonly signals: readonly string[];
    readonly id: string;
  };
  /** OBS-03: the status-line cache under the state directory; no sidecar round trip. */
  export function readStatusLine(stateDir: string): { readonly sidecar: 'running' | 'stopped'; readonly writtenAtMs: number; readonly pid: number } | undefined;
  export function statusLineText(body: ReturnType<typeof readStatusLine>, nowMs: number): string;
  /** The daemon command line (the bundled entry, or bin/jevris.mjs sidecar run). */
  export function sidecarCommand(): readonly string[] | undefined;
  /** GOV-11: a refusal code when an output path is not inside the home, is not absolute, or is reached through a symlink; undefined when acceptable. */
  export function outputPathRefusal(home: string, path: string | undefined): string | undefined;
  /** Creates a new private (0600) file, never over an existing file or through a symlink; false when it could not. */
  export function writeNewPrivate(path: string, text: string): boolean;
  /** A runtime build id: 16 hex characters (protocol runtimeBuild). */
  export const BUILD_ID: RegExp;
  /** The build under a package or runtime root: a short hash of its dist/bundle-manifest.json, and its source commit. */
  export function runtimeBuild(root?: string | null): { readonly id: string; readonly commit: string | null; readonly dirty: boolean } | null;
  /** The effective source-egress approval: the organization's policy, then the user's host.json. */
  export type EgressApproval = 'approved' | 'not-approved';
  export function resolveSourceEgress(input: { readonly home?: string }): EgressApproval;
  /** IPC-20: per-user service units (LaunchAgent, systemd user unit, Scheduled Task). */
  export interface ServiceInput {
    readonly platform: 'darwin' | 'linux' | 'win32';
    readonly osHome: string;
    readonly stateDir: string;
    readonly argv: readonly string[];
    readonly jevrisHome?: string;
    readonly uid?: number;
    readonly windowsUser?: string;
    readonly env?: { readonly [key: string]: string | undefined };
  }
  export type ServiceExec = (file: string, args: readonly string[]) => { readonly status: number | null; readonly stdout: string; readonly stderr: string };
  export interface ServiceResult {
    readonly ok: boolean;
    readonly state: 'installed' | 'not-installed' | 'running' | 'stopped' | 'unsupported' | 'failed' | 'other-home' | 'unknown';
    readonly unitPath: string;
    readonly manager: string;
    readonly pid: number | null;
    readonly steps: readonly { readonly step: string; readonly ok: boolean; readonly detail?: string }[];
    readonly message: string;
  }
  export function installService(input: ServiceInput, exec?: ServiceExec): ServiceResult;
  export function uninstallService(input: ServiceInput, exec?: ServiceExec): ServiceResult;
  export function serviceStatus(input: ServiceInput, exec?: ServiceExec): ServiceResult;
}

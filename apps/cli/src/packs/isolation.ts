/**
 * Third-party executable packs run isolated (PAK-06, §11.4, §16.1 "pack supply-chain attack").
 *
 * Declarative packs are the default and run no code. An executable component runs only when:
 * - its pack version is the active one (its delta, which listed the executable, was approved);
 * - the pack is signed by an allowlisted publisher (PAK-03) and its files still match their pins;
 * - the component's file hash matches the manifest; and
 * - this Node enforces the permission model including network denial (Node 25 or later).
 *
 * It then runs as a separate process, never in this one and never in a JavaScript VM (which does
 * not contain hostile code): `node --permission` with read access to its own version folder
 * only, write access only to the pack's data folder when it declares `writesPackData`, and no
 * child processes, workers, native addons, WASI or network (all denied by the permission model).
 * The environment is empty except what Windows needs to start Node. Input is one JSON document on
 * stdin; the answer is one JSON line on stdout, capped at 64 KiB, with a hard timeout. Its
 * proposals are advisory: only actions the manifest declares are kept, and they still go through
 * arbitration and the host's permissions.
 */
import { launchStreaming } from '../live-harness.js';
import { getPack, packDataDir, packVersionDir, type Refused } from './registry.js';
import { packPath, readPackDir } from './files.js';
import { manifestHash } from './manifest.js';
import { loadPublishers, signatureStatus } from './trust.js';
import { realpath } from 'node:fs/promises';
import { ensurePrivateDir } from '@jevris/platform';
import type { ActionKind } from '@jevris/contracts';

const OUTPUT_CAP = 64 * 1024;

function nodeVersion(): string {
  return (process as unknown as { readonly versions: { readonly node: string } }).versions.node;
}

/** True when `node --permission` also denies network access on this Node (added in Node 25). */
export function permissionModelDeniesNetwork(version: string = nodeVersion()): boolean {
  const major = Number.parseInt(version.split('.')[0] ?? '0', 10);
  return Number.isFinite(major) && major >= 25;
}

export interface ExecutableProposal {
  readonly action: ActionKind;
  readonly reason: string;
}

export type ExecutableRun =
  | { readonly ok: true; readonly proposals: readonly ExecutableProposal[]; readonly rejected: number }
  | Refused;

function refuse(reasonCode: string, detail = ''): Refused {
  return { ok: false, reasonCode, detail };
}

/** The permission-model arguments for one component: exported for review and tests. */
export function isolationArgs(versionDir: string, entry: string, dataDir: string | null): readonly string[] {
  return ['--permission', `--allow-fs-read=${versionDir}`, ...(dataDir === null ? [] : [`--allow-fs-write=${dataDir}`]), '--disable-warning=ExperimentalWarning', entry];
}

export async function runPackExecutable(
  home: string,
  packId: string,
  executableId: string,
  input: unknown,
  options: { readonly shippedPublishers?: string; readonly nodeVersion?: string } = {},
): Promise<ExecutableRun> {
  if (!permissionModelDeniesNetwork(options.nodeVersion)) return refuse('ISOLATION_UNAVAILABLE', `Node ${options.nodeVersion ?? nodeVersion()} cannot deny network access to a pack; executable packs need Node 25 or later`);
  const record = await getPack(home, packId);
  if (record === undefined || record.active === null) return refuse('NOTHING_ACTIVE', packId);
  const entry = record.versions[record.active];
  const versionDir = packVersionDir(home, packId, record.active);
  const dir = await readPackDir(versionDir);
  if (entry === undefined || !dir.ok || manifestHash(dir.manifest) !== entry.manifestHash) return refuse('PACK_TAMPERED', `${packId}@${record.active}`);
  const { manifest } = dir;
  const status = signatureStatus(manifest, await loadPublishers(home, ...(options.shippedPublishers === undefined ? [] : [options.shippedPublishers])));
  if (status !== 'verified') return refuse(status === 'unsigned' ? 'UNSIGNED_EXECUTABLE' : 'PUBLISHER_NOT_ALLOWED', `signature ${status}`);
  const exec = (manifest.executables ?? []).find((item) => item.id === executableId);
  if (exec === undefined) return refuse('EXECUTABLE_UNKNOWN', executableId);
  const file = dir.files.get(exec.path);
  if (file === undefined || file.sha256 !== exec.sha256) return refuse('PACK_TAMPERED', exec.path);
  let dataDir: string | null = null;
  if (exec.writesPackData) {
    const given = packDataDir(home, packId);
    if (!(await ensurePrivateDir(given)).ok) return refuse('DATA_DIR_REFUSED', given);
    dataDir = await realpath(given);
  }
  // The permission model compares real paths: grant the folders by their real location.
  const readRoot = await realpath(versionDir);
  let text: string;
  try {
    text = JSON.stringify({ schemaVersion: '1.0', packId, executableId, input });
  } catch {
    return refuse('INPUT_INVALID');
  }
  if (text.length > 1_048_576) return refuse('INPUT_TOO_LARGE');
  const env: Record<string, string> = {};
  if (process.platform === 'win32') {
    for (const name of ['SystemRoot', 'SYSTEMROOT', 'windir']) {
      const value = process.env[name];
      if (typeof value === 'string') env[name] = value;
    }
  }
  let size = 0;
  let last = '';
  let overflow = false;
  const launched = launchStreaming(process.execPath, isolationArgs(readRoot, packPath(readRoot, exec.path), dataDir), {
    cwd: dataDir ?? readRoot,
    env,
    input: `${text}\n`,
    onLine: (line) => {
      size += line.length + 1;
      if (size > OUTPUT_CAP) {
        overflow = true;
        launched.kill();
        return;
      }
      last = line;
    },
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    launched.kill();
  }, exec.timeoutMs);
  const exit = await launched.done;
  clearTimeout(timer);
  if (!exit.spawned) return refuse('EXECUTABLE_NOT_STARTED');
  if (timedOut) return refuse('EXECUTABLE_TIMEOUT', `${exec.timeoutMs} ms`);
  if (overflow) return refuse('EXECUTABLE_OUTPUT_TOO_LARGE');
  if (exit.code !== 0) return refuse('EXECUTABLE_FAILED', `exit ${String(exit.code)}: ${(await launched.stderr).split('\n')[0]?.slice(0, 200) ?? ''}`);
  let answer: unknown;
  try {
    answer = JSON.parse(last);
  } catch {
    return refuse('EXECUTABLE_ANSWER_INVALID');
  }
  const proposals = (answer as { readonly proposals?: unknown } | null)?.proposals;
  if (!Array.isArray(proposals)) return refuse('EXECUTABLE_ANSWER_INVALID');
  const declared = new Set<string>(manifest.actions);
  const kept: ExecutableProposal[] = [];
  let rejected = 0;
  for (const item of proposals.slice(0, 64)) {
    const proposal = item as { readonly action?: unknown; readonly reason?: unknown };
    if (typeof proposal.action === 'string' && declared.has(proposal.action)) {
      kept.push({ action: proposal.action as ActionKind, reason: typeof proposal.reason === 'string' ? proposal.reason.slice(0, 500) : '' });
    } else rejected += 1;
  }
  return { ok: true, proposals: kept, rejected };
}

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { machineIdentity, parseMachineIdFile } from '@jevris/platform';
// ------------------------------------------------------------------ execution locality (IPC-19)

/**
 * Where this process runs (US37). The sidecar, its socket and its store belong to the execution
 * environment of the coding process: a container, WSL or an SSH host, never the machine the IDE
 * or its localhost happens to be on. `id` is the same for every process that shares one kernel
 * boot and one pid namespace, and differs across a container boundary, between WSL and Windows,
 * and between hosts that share a home over the network, so a client never treats a sidecar from
 * another environment as its own. Environment variables only name the kind; they never change
 * the id, since two processes in one environment can see different variables.
 */
export interface ExecutionLocality {
  readonly kind: 'local' | 'container' | 'wsl' | 'ssh' | 'remote';
  readonly container: boolean;
  readonly ssh: boolean;
  readonly signals: readonly string[];
  readonly id: string;
}

export interface LocalityInput {
  readonly platform?: string;
  readonly env?: { readonly [key: string]: string | undefined };
  /** Filesystem root the Linux markers are read under (tests); default '/'. */
  readonly root?: string;
  readonly hostname?: string;
}

const CONTAINER_CGROUP = /(?:docker|kubepods|containerd|libpod|lxc|crio|garden)/;
const CONTAINER_ID = /(?:docker[-/]|containers\/|libpod-|crio-|cri-containerd-)([a-f0-9]{64})/;

function readSmall(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8').slice(0, 262_144);
  } catch {
    return undefined;
  }
}

function readNamespace(path: string): string | undefined {
  try {
    return readlinkSync(path);
  } catch {
    const text = readSmall(path)?.trim();
    return text !== undefined && /^[a-z]+:\[\d{1,20}\]$/.test(text) ? text : undefined;
  }
}

/**
 * The Linux machine id for the fallback id: under an injected root its `etc/machine-id` (or the
 * D-Bus copy), else the platform's cached machine identity. Hashed into the id, never kept.
 */
function machineIdAt(root: string | undefined): string | undefined {
  if (root === undefined) {
    const identity = machineIdentity();
    return identity.ok ? identity.machineId : undefined;
  }
  for (const path of [join(root, 'etc', 'machine-id'), join(root, 'var', 'lib', 'dbus', 'machine-id')]) {
    const id = parseMachineIdFile(readSmall(path) ?? '');
    if (id !== null) return id;
  }
  return undefined;
}

function present(env: LocalityInput['env'], name: string): boolean {
  const value = env?.[name];
  return typeof value === 'string' && value.length > 0;
}

export function detectLocality(input: LocalityInput = {}): ExecutionLocality {
  const env = input.env ?? process.env;
  const testRoot = env['JEVRIS_TEST'] === '1' ? env['JEVRIS_TEST_LOCALITY_ROOT'] : undefined;
  const root = input.root ?? (typeof testRoot === 'string' && isAbsolute(testRoot) ? testRoot : undefined);
  const platform = input.platform ?? process.platform;
  const linux = platform === 'linux' || root !== undefined;
  const at = (...parts: string[]): string => join(root ?? '/', ...parts);
  const signals: string[] = [];
  let containerId: string | undefined;
  let bootId: string | undefined;
  let pidNamespace: string | undefined;
  let wsl = present(env, 'WSL_DISTRO_NAME') || present(env, 'WSL_INTEROP');
  if (linux) {
    if (existsSync(at('.dockerenv'))) signals.push('dockerenv');
    if (existsSync(at('run', '.containerenv'))) signals.push('containerenv');
    const cgroup = readSmall(at('proc', '1', 'cgroup'));
    if (cgroup !== undefined && CONTAINER_CGROUP.test(cgroup)) signals.push('cgroup');
    const mountinfo = readSmall(at('proc', 'self', 'mountinfo'));
    if (mountinfo !== undefined && mountinfo.split('\n').some((line) => / \/ \/ [^-]*- overlay /.test(line))) signals.push('overlay-root');
    containerId = CONTAINER_ID.exec(mountinfo ?? '')?.[1] ?? CONTAINER_ID.exec(cgroup ?? '')?.[1];
    bootId = readSmall(at('proc', 'sys', 'kernel', 'random', 'boot_id'))?.trim();
    pidNamespace = readNamespace(at('proc', 'self', 'ns', 'pid'));
    if (/microsoft/i.test(readSmall(at('proc', 'sys', 'kernel', 'osrelease')) ?? '')) wsl = true;
  }
  const fileContainer = signals.length > 0;
  if (present(env, 'container')) signals.push('container-env');
  if (env['REMOTE_CONTAINERS'] === 'true' || env['DEVCONTAINER'] === 'true' || env['CODESPACES'] === 'true') signals.push('devcontainer');
  if (present(env, 'KUBERNETES_SERVICE_HOST')) signals.push('kubernetes');
  if (wsl) signals.push('wsl');
  const ssh = present(env, 'SSH_CONNECTION') || present(env, 'SSH_CLIENT') || present(env, 'SSH_TTY');
  if (ssh) signals.push('ssh');
  const remote = env['CLAUDE_CODE_REMOTE'] === 'true';
  if (remote) signals.push('remote');
  const container = fileContainer || signals.includes('container-env') || signals.includes('devcontainer') || signals.includes('kubernetes');
  const kind: ExecutionLocality['kind'] = container ? 'container' : wsl ? 'wsl' : ssh ? 'ssh' : remote ? 'remote' : 'local';
  // Linux: kernel boot and pid namespace (a container has its own pid namespace, and a pid in
  // an endpoint file only means something inside the namespace that wrote it). Without those,
  // the machine id (DATA-10: a DHCP host-name change must not make this environment's own
  // sidecar look foreign), and the host name only when no machine id can be read. Elsewhere
  // the platform alone: macOS and Windows homes are not shared with another kernel's sidecar.
  const fallback = (): string => {
    const machineId = machineIdAt(root);
    return machineId !== undefined ? `m:${machineId}` : input.hostname ?? hostname();
  };
  const basis = linux
    ? bootId !== undefined && pidNamespace !== undefined
      ? `linux|${bootId}|${pidNamespace}|${containerId ?? ''}`
      : `linux|${fallback()}|${containerId ?? ''}|${fileContainer ? 'c' : 'h'}`
    : platform;
  const id = createHash('sha256').update(basis).digest('hex').slice(0, 16);
  return { kind, container, ssh, signals, id };
}

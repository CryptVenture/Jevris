/**
 * Environment class for doctor and install reports.
 * Any platform and any Node on PATH can run. A remote, SSH, or container marker is reduced.
 * This module does not contact a worker and does not certify an actuator.
 */

export interface EnvironmentInput {
  readonly platform: string;
  readonly nodeVersion: string;
  readonly env: { readonly [key: string]: string | undefined };
  /**
   * Whether this process runs in a container. Production callers take it from
   * `detectInContainer()` (the sidecar's IPC-19 detector); tests inject it.
   */
  readonly inContainer?: boolean;
}

export type EnvironmentClass = 'local' | 'reduced' | 'unsupported';

function remoteMarker(input: EnvironmentInput): boolean {
  if (input.inContainer === true) return true;
  if (input.env.CLAUDE_CODE_REMOTE === 'true') return true;
  const sshConnection = input.env.SSH_CONNECTION;
  if (typeof sshConnection === 'string' && sshConnection.length > 0) return true;
  const sshClient = input.env.SSH_CLIENT;
  if (typeof sshClient === 'string' && sshClient.length > 0) return true;
  const kubeHost = input.env.KUBERNETES_SERVICE_HOST;
  if (typeof kubeHost === 'string' && kubeHost.length > 0) return true;
  return false;
}

export function classifyEnvironment(input: EnvironmentInput): EnvironmentClass {
  if (input.platform.length === 0) return 'unsupported';
  if (remoteMarker(input)) return 'reduced';
  return 'local';
}

/**
 * IPC-19: whether this process runs in a container, from the sidecar's execution-locality
 * detector (`/.dockerenv`, `/run/.containerenv`, container cgroups, an overlay root, and the
 * container and devcontainer variables). One detector serves the sidecar, doctor and hook
 * certification, so they never disagree. The sidecar package is loaded lazily, as elsewhere in
 * the CLI; if it cannot load, the answer is false and the environment variables above still apply.
 */
export async function detectInContainer(input: { readonly platform?: string; readonly env?: { readonly [key: string]: string | undefined } } = {}): Promise<boolean> {
  try {
    const { detectLocality } = await import('@jevris/sidecar');
    return detectLocality(input).container;
  } catch {
    return false;
  }
}

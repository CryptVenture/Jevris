/**
 * Managed (administrator) policy that stops harness hooks (HCF-02, ADM-05). Jevris reports it
 * and never works around it: when an administrator disables hooks, the Jevris hooks do not run,
 * doctor says so, and certify records the hook features as not certified.
 *
 * Claude Code reads a system-wide managed-settings.json that users cannot override. Two keys
 * stop the Jevris plugin hooks: `disableAllHooks: true`, and `allowManagedHooksOnly: true`
 * (only hooks from managed settings run). Read-only; a missing or unreadable file means no
 * managed policy was found.
 */
import { readFile } from 'node:fs/promises';

export interface ManagedHookPolicy {
  readonly harness: 'claude';
  readonly path: string;
  readonly key: 'disableAllHooks' | 'allowManagedHooksOnly';
}

export interface ManagedPolicyOptions {
  readonly platform?: string;
  readonly env?: { readonly [key: string]: string | undefined };
  readonly readText?: (path: string) => Promise<string | null>;
}

const MAX_BYTES = 262_144;

/** Where Claude Code looks for managed settings on each OS. */
export function claudeManagedSettingsPaths(platform: string, env: { readonly [key: string]: string | undefined } = {}): readonly string[] {
  if (platform === 'darwin') return ['/Library/Application Support/ClaudeCode/managed-settings.json'];
  if (platform === 'win32') {
    const programFiles = env['ProgramFiles'] ?? env['PROGRAMFILES'] ?? 'C:\\Program Files';
    const programData = env['ProgramData'] ?? env['PROGRAMDATA'] ?? 'C:\\ProgramData';
    return [`${programFiles}\\ClaudeCode\\managed-settings.json`, `${programData}\\ClaudeCode\\managed-settings.json`];
  }
  return ['/etc/claude-code/managed-settings.json'];
}

async function readBounded(path: string): Promise<string | null> {
  try {
    const bytes = await readFile(path);
    if (bytes.byteLength > MAX_BYTES) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Every managed setting found that stops the Jevris hooks. Empty when hooks may run. */
export async function managedHookPolicies(options: ManagedPolicyOptions = {}): Promise<readonly ManagedHookPolicy[]> {
  const platform = options.platform ?? process.platform;
  const read = options.readText ?? readBounded;
  const found: ManagedHookPolicy[] = [];
  for (const path of claudeManagedSettingsPaths(platform, options.env ?? process.env)) {
    const text = await read(path);
    if (text === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const settings = parsed as Record<string, unknown>;
    for (const key of ['disableAllHooks', 'allowManagedHooksOnly'] as const) {
      if (Object.hasOwn(settings, key) && settings[key] === true) found.push({ harness: 'claude', path, key });
    }
  }
  return found;
}

/** The doctor line for one managed policy. */
export function managedPolicyLine(policy: ManagedHookPolicy): string {
  const what = policy.key === 'disableAllHooks' ? 'disables all hooks' : 'allows only managed hooks';
  return `harness ${policy.harness} policy: ${policy.path} ${what} (${policy.key}); the Jevris hooks will not run, and Jevris does not work around managed policy`;
}

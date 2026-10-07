import { inspectOptInSource, optInRefusalClause, optInSourceOf, type OptInHost } from './credential.js';

/**
 * Doctor's line for the opt-in Jev key source (GOV-07), shown only where one is named in the
 * environment. Without it a refused file is visible only as a reason code in the sidecar log.
 *
 * - Doctor never reads the key and never opens the OS keystore: the file is checked against
 *   every rule that does not need its contents (type, owner, mode, folder, work tree, size).
 *   A file with a malformed body therefore passes here and is refused by `jevris credential
 *   status`, which reads it the way the sidecar does.
 * - Severity (doctor-severity.ts): ok when the file passes, action when it is refused.
 * - Fixed text only: the variable's name, a reason code and the rule it broke. Never the path
 *   or the contents.
 */
export async function credentialSourceDoctorLines(
  env: Readonly<Record<string, string | undefined>>,
  host?: OptInHost,
): Promise<string[]> {
  const source = optInSourceOf(env);
  if (source === undefined) return [];
  const refusal = (reason: Parameters<typeof optInRefusalClause>[0]): string =>
    `credentialSource: refused (${reason}): ${optInRefusalClause(reason)}; Jevris decides rules-only until it is fixed and the sidecar restarts (jevris sidecar restart)`;
  if ('refused' in source) return [refusal(source.refused)];
  const checked = await inspectOptInSource(source, host);
  if ('refused' in checked) return [refusal(checked.refused)];
  const name = source.kind === 'file' ? 'JEVRIS_CREDENTIAL_FILE' : 'JEVRIS_CREDENTIAL_SYSTEMD';
  return [`credentialSource: ${name} passes the owner-only checks; the sidecar uses it only when the OS keyring has no key`];
}

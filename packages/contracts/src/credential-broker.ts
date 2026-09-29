/**
 * Host secret identity and the fields a provider client may receive.
 * Harness views carry presence only. They do not carry the key.
 */

export const HOST_SECRET_SERVICE = 'jevris';
export const HOST_SECRET_ACCOUNT = 'typesafe-primary';
export const HOST_SECRET_REF = 'host-secret:typesafe-primary';
export const EXPLICIT_BASE_URL = 'https://api.typesafe.ai';
export const EXPLICIT_LOG_LEVEL = 'warn' as const;

export type CredentialPresence = 'present' | 'missing';

export interface CredentialStatus {
  readonly presence: CredentialPresence;
  readonly diagnostic: string | null;
}

export interface HarnessCredentialView {
  readonly presence: CredentialPresence;
  readonly diagnostic: string | null;
}

export interface ExplicitClientFields {
  readonly apiKey: string;
  readonly baseURL: typeof EXPLICIT_BASE_URL;
  readonly defaultModel: string;
  readonly logLevel: typeof EXPLICIT_LOG_LEVEL;
}

const FORBIDDEN_OWN_KEYS = new Set(['apiKey', 'token', 'secret', 'secretText', 'password']);

export interface HookCredentialCarry {
  readonly credentialRef: typeof HOST_SECRET_REF;
  readonly presence: CredentialPresence;
}

export interface McpCredentialArguments {
  readonly credentialRef: typeof HOST_SECRET_REF;
  readonly presence: CredentialPresence;
}

export function toHarnessView(status: CredentialStatus): HarnessCredentialView {
  return {
    presence: status.presence,
    diagnostic: status.diagnostic,
  };
}

export function hookCredentialCarry(presence: CredentialPresence): HookCredentialCarry {
  return {
    credentialRef: HOST_SECRET_REF,
    presence,
  };
}

export function mcpCredentialArguments(presence: CredentialPresence): McpCredentialArguments {
  return {
    credentialRef: HOST_SECRET_REF,
    presence,
  };
}

/**
 * False when a forbidden key is an own property. The property value is not read
 * and is not copied into an error.
 */
export function assertNoProviderKey(value: object): boolean {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string' && FORBIDDEN_OWN_KEYS.has(key)) return false;
  }
  return true;
}

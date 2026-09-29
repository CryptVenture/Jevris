/**
 * The test provider override (installed-product end-to-end runs against a mock Jev).
 *
 * - `JEVRIS_TEST_PROVIDER_URL` is honoured only for a loopback http URL: 127.0.0.1, ::1 or
 *   localhost, with a port and no path, query, fragment or user info.
 * - The key comes only from `JEVRIS_TEST_PROVIDER_KEY`. The stored (keychain) credential is
 *   never sent to an override URL.
 * - Anything else is refused with a reason code, and the engine is then rules-only: a refused
 *   override never falls through to production.
 * - While an override is set, status and doctor show one diagnostic line (`diagnostic`).
 */

export const TEST_PROVIDER_URL_ENV = 'JEVRIS_TEST_PROVIDER_URL';
export const TEST_PROVIDER_KEY_ENV = 'JEVRIS_TEST_PROVIDER_KEY';

export type ProviderOverrideRefusal = 'PROVIDER_OVERRIDE_INVALID_URL' | 'PROVIDER_OVERRIDE_NOT_LOOPBACK' | 'PROVIDER_OVERRIDE_NOT_HTTP' | 'PROVIDER_OVERRIDE_NO_KEY';

export type ProviderOverride =
  | { readonly active: false }
  | { readonly active: true; readonly ok: true; readonly baseURL: string; readonly apiKey: string; readonly diagnostic: string }
  | { readonly active: true; readonly ok: false; readonly reasonCode: ProviderOverrideRefusal; readonly diagnostic: string };

type EnvLike = { readonly [key: string]: string | undefined };

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function ambientEnv(): EnvLike {
  return (globalThis as { process?: { env?: EnvLike } }).process?.env ?? {};
}

/** Reads the override from the environment. Never returns or logs the key in `diagnostic`. */
export function readProviderOverride(env: EnvLike = ambientEnv()): ProviderOverride {
  const raw = env[TEST_PROVIDER_URL_ENV];
  if (raw === undefined || raw.trim().length === 0) return { active: false };
  const refuse = (reasonCode: ProviderOverrideRefusal): ProviderOverride => ({
    active: true,
    ok: false,
    reasonCode,
    diagnostic: `test provider override refused (${reasonCode}): Jev calls are rules-only until ${TEST_PROVIDER_URL_ENV} is unset or loopback`,
  });
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return refuse('PROVIDER_OVERRIDE_INVALID_URL');
  }
  if (url.protocol !== 'http:') return refuse(url.protocol === 'https:' && LOOPBACK.has(url.hostname) ? 'PROVIDER_OVERRIDE_NOT_HTTP' : 'PROVIDER_OVERRIDE_NOT_LOOPBACK');
  if (!LOOPBACK.has(url.hostname)) return refuse('PROVIDER_OVERRIDE_NOT_LOOPBACK');
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || (url.pathname !== '/' && url.pathname !== '') || url.port === '') {
    return refuse('PROVIDER_OVERRIDE_INVALID_URL');
  }
  const key = env[TEST_PROVIDER_KEY_ENV];
  if (key === undefined || key.trim().length === 0 || key.length > 512) return refuse('PROVIDER_OVERRIDE_NO_KEY');
  const baseURL = `http://${url.hostname}:${url.port}`;
  return {
    active: true,
    ok: true,
    baseURL,
    apiKey: key.trim(),
    diagnostic: `test provider override active: Jev calls go to ${baseURL}, not production; the stored key is not used`,
  };
}

/** The one status/doctor line while an override is set, else null. */
export function providerOverrideDiagnostic(env: EnvLike = ambientEnv()): string | null {
  const override = readProviderOverride(env);
  return override.active ? override.diagnostic : null;
}

import { HASH_PATTERN } from './hash.js';
import * as S from './schema.js';

/**
 * Unanchored credential shapes. Every identifier, reason code and free-text field in a contract
 * must not match any of them, so a key cannot travel inside a validated object.
 */
const B = '(?:^|[^A-Za-z0-9])';
export const SECRET_PATTERNS: readonly string[] = Object.freeze([
  `${B}sk-ant-`,
  `${B}sk-(?:proj-)?[A-Za-z0-9_-]{16,}`,
  `${B}gh[pousr]_[A-Za-z0-9]{20,}`,
  `${B}github_pat_`,
  `${B}(?:AKIA|ASIA)[0-9A-Z]{16}`,
  `${B}xox[abprs]-`,
  `${B}AIza[0-9A-Za-z_-]{30,}`,
  `${B}glpat-`,
  `${B}npm_[A-Za-z0-9]{30,}`,
  '-----BEGIN [A-Z ]*PRIVATE KEY',
  // A 32+ character run of mixed-case letters and digits: a high-entropy token.
  '(?:^|[^A-Za-z0-9_-])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{32,}',
]);

/** Unanchored URL shapes refused in free text: a scheme with an authority, and a www host. */
export const URL_PATTERNS: readonly string[] = Object.freeze(['[A-Za-z][A-Za-z0-9+.-]*://', '(?:^|[^A-Za-z0-9])www\\.']);

const secretRegexes = SECRET_PATTERNS.map((pattern) => new RegExp(pattern, 'u'));

/** True when the text contains a credential shape. */
export function containsSecret(text: string): boolean {
  return secretRegexes.some((regex) => regex.test(text));
}

/** An opaque identifier: no `/`, `:`, whitespace or shell metacharacter, so no URL, path or command. */
export const ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$';
/** A model identifier additionally allows one `:<digits>` revision suffix. */
export const MODEL_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?::[0-9]{1,8})?$';
/**
 * A model id as a harness reports it (harness parity audit G20): up to two lowercase `provider/`
 * segments (Kilo and OpenCode `providerID/modelID`, a gateway's `openrouter/anthropic/...`), a
 * MODEL_ID_PATTERN body, and an optional `[1m]` (Claude Code's 1M-context variant). An input only:
 * core `harnessModelRef` resolves it to a registry ModelId before anything is answered.
 */
export const HARNESS_MODEL_ID_PATTERN = '^(?:[a-z0-9][a-z0-9._-]{0,63}/){0,2}[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?::[0-9]{1,8})?(?:\\[1m\\])?$';
export const REASON_CODE_PATTERN = '^[A-Z][A-Z0-9_]{0,63}$';
export const SEMVER_PATTERN =
  '^(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$';
export const TIMESTAMP_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:\\d{2})$';
export const JEV_MODEL_PATTERN = '^jev-\\d+\\.\\d+\\.\\d+$';

export const MAX_SAFE_INTEGER = 9_007_199_254_740_991;

export const Id = S.string({ pattern: ID_PATTERN, notPatterns: SECRET_PATTERNS });
export const ModelId = S.string({ pattern: MODEL_ID_PATTERN, notPatterns: SECRET_PATTERNS });
export const Hash = S.string({ pattern: HASH_PATTERN });
export const Timestamp = S.string({ pattern: TIMESTAMP_PATTERN, format: 'date-time' });
export const ReasonCode = S.string({ pattern: REASON_CODE_PATTERN, notPatterns: SECRET_PATTERNS });
export const SemVer = S.string({ pattern: SEMVER_PATTERN });
export const NonNegativeInteger = S.integer({ minimum: 0, maximum: MAX_SAFE_INTEGER });
export const PositiveInteger = S.integer({ minimum: 1, maximum: MAX_SAFE_INTEGER });

/**
 * How the harness (or worker) pays for model use (owner decision, DOMAINS 8703ab6): an API key is
 * billed per token; a subscription has no per-token charge (dollars are an API-equivalent
 * estimate); unknown when nothing detected it. Cost wording follows this, never a guess. Defined
 * here, and re-exported by commands.ts, so access-limits.ts can use it without importing
 * commands.ts, which imports the access-limits status view.
 */
export const AUTH_MODES = ['api-key', 'subscription', 'unknown'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];
export const Probability = S.number({ minimum: 0, maximum: 1 });

/** Human-readable text: bounded, no credential and no URL. */
export function text(maxLength = 2000): S.TSchema<string> {
  return S.string({ minLength: 1, maxLength, notPatterns: [...SECRET_PATTERNS, ...URL_PATTERNS] });
}

export const IdList = (options: S.ArrayOptions = {}) => S.array(Id, { uniqueItems: true, maxItems: 256, ...options });

export const HARNESS_IDS = ['claude', 'kilocode', 'codex', 'opencode', 'antigravity'] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];
export const HarnessIdSchema = S.enumOf(HARNESS_IDS);

export const OPERATING_SYSTEMS = ['darwin', 'linux', 'win32'] as const;
export type OperatingSystem = (typeof OPERATING_SYSTEMS)[number];
export const OperatingSystemSchema = S.enumOf(OPERATING_SYSTEMS);

export const SignatureSchema = S.object({
  algorithm: S.literal('ed25519'),
  keyId: Id,
  value: S.string({ pattern: '^[A-Za-z0-9+/]{86}==$', description: 'Base64 Ed25519 signature (64 bytes).' }),
});
export type Signature = S.Static<typeof SignatureSchema>;

/**
 * CertificationRecord (§3.5, §15.4, CTR-05): certification records the actuator, a harness
 * version range, the tested operating systems, actual model and tool availability, known
 * limitations, the fixture suite hash and feature-level status, and it is signed and expires.
 * A version outside the range does not prohibit observation, but it disables unverified actuation.
 */
import { defineContract, timestampMs } from './contract.js';
import {
  Hash,
  HarnessIdSchema,
  Id,
  ModelId,
  OperatingSystemSchema,
  ReasonCode,
  SEMVER_PATTERN,
  SemVer,
  SignatureSchema,
  Timestamp,
  text,
} from './primitives.js';
import * as S from './schema.js';

export const FEATURE_STATUSES = ['certified', 'experimental', 'unsupported', 'disabled'] as const;

/**
 * The feature ids a certification record may certify (HCF-02). One list for the certify
 * runner (F) and every subscriber that gates on a record (C, D, E):
 * - plugin.install: the harness loads the installed Jevris plugin.
 * - mcp.tools: the harness registers the Jevris MCP server and lists its tools.
 * - skills.discovery: the harness discovers each Jevris skill exactly once.
 * - hooks.observe: native events reach the launcher and are answered in observe form.
 * - hooks.context: the harness shows the model context a hook adds.
 * - hooks.route: the harness applies a routed tool input: Claude Code on Agent or Task, and Codex
 *   on spawn_agent, certified only when the `codex.subagent-route` stub case (K2) passes on the
 *   installed binary (owner decision OD-6, F 0ea6199).
 * - worker.route: Jevris starts an owned worker on the harness (the `<harness>.worker`
 *   actuator; owner approval 2026-09-26, DOMAINS 72ff950). Certified pending first use: the
 *   no-cost probes (version, every flag the worker passes) and the nine §15.4 cases against the
 *   worker port pass; the first real run checks its init before any tool runs, and a mismatch
 *   demotes the feature.
 * - models.list: the harness's own model listing (Codex app-server model/list, `opencode models`,
 *   `kilo models`, `agy models`) answers, its output parses to model ids, and it has no session,
 *   history or config side effect in the throwaway profile (owner decision 2026-09-27, DOMAINS 3f090fa).
 * - worker.actual-model: an owned run's own hooks report the model it used (Codex, Kilo,
 *   OpenCode; routing design K8, A's R33 portability gate).
 * - session.route: the main session switches model per turn (Kilo, OpenCode; OD-8, route.turn).
 * - models.list-hosts: the harness's listing keeps each pinned serving host's own spellings
 *   (serving hosts R43 and R57, case K13; Kilo, OpenCode). Separate from models.list, so a
 *   listing side effect does not demote it and it does not demote the listing.
 * - route.host: a route that changes the session's serving host (the OQ-1 fallback), or any
 *   route through a gateway or third-party host, reaches that host, and a project config that
 *   redefines the host refuses it (serving hosts R57, cases K14 and K15, T-R6; Kilo, OpenCode).
 *   Certified only when session.route is certified in the same run. A same-maker route through
 *   the session's direct maker host stays under session.route and hooks.route.
 * - access.detect: an owned run's port reads an access limit from the harness's own error channel
 *   and core gives it the right class: a rate limit, a credit error and a sign-in error (access
 *   limits R69, cases K16-K18; Claude Code, Codex, Kilo, OpenCode). A certified harness version's
 *   signals are classified as proven (the `certified` flag of design 5.5).
 * - access.session: an interactive session's failed turn reaches the hooks with a structured error
 *   (Claude Code's StopFailure, K19; Kilo's and OpenCode's session.error or failed message, K20).
 *   Needs hooks.observe. A binary that does not send the event records it unsupported with
 *   ACCESS_SESSION_EVENT_ABSENT.
 * - access.usage-read: the harness's own read-only usage reading (OP-6: Codex's
 *   account/rateLimits/read) answers with the fields core keeps (band, window length, reset,
 *   ordinaryUsageAllowed), proven under OS network isolation so nothing leaves the machine (K21,
 *   owner decision DOMAINS 3298853d). macOS and Linux; where the isolation is not available (Windows)
 *   it is recorded unsupported with ACCESS_USAGE_ISOLATION_UNAVAILABLE. A certified reading may
 *   lift a usage window; an uncertified one only sets one.
 * A feature a harness cannot support is left out of its record (reduced mode).
 */
export const CERTIFICATION_FEATURES = ['plugin.install', 'mcp.tools', 'skills.discovery', 'hooks.observe', 'hooks.context', 'hooks.route', 'worker.route', 'models.list', 'worker.actual-model', 'session.route', 'models.list-hosts', 'route.host', 'access.detect', 'access.session', 'access.usage-read'] as const;
export type CertificationFeature = (typeof CERTIFICATION_FEATURES)[number];

/** access.usage-read's unsupported reason where OS network isolation is not available (Windows; K21). */
export const ACCESS_USAGE_ISOLATION_UNAVAILABLE = 'ACCESS_USAGE_ISOLATION_UNAVAILABLE' as const;

export const CertificationRecordSchema = S.object({
  id: Id,
  schemaVersion: S.literal('1.0'),
  harness: HarnessIdSchema,
  actuatorId: Id,
  harnessVersionRange: S.object({ minimum: SemVer, maximumExclusive: SemVer }),
  operatingSystems: S.array(OperatingSystemSchema, { minItems: 1, maxItems: 3, uniqueItems: true }),
  models: S.array(S.object({ modelId: ModelId, available: S.nullable(S.boolean()) }), { maxItems: 256 }),
  tools: S.array(S.object({ toolId: Id, available: S.nullable(S.boolean()) }), { maxItems: 256 }),
  limitations: S.array(text(500), { maxItems: 64 }),
  fixtureSuiteHash: Hash,
  features: S.array(
    S.object({ featureId: Id, status: S.enumOf(FEATURE_STATUSES), reasonCode: S.nullable(ReasonCode) }),
    { minItems: 1, maxItems: 256 },
  ),
  certifiedAt: Timestamp,
  expiresAt: Timestamp,
  signature: SignatureSchema,
});
export type CertificationRecord = S.Static<typeof CertificationRecordSchema>;

const SEMVER = new RegExp(SEMVER_PATTERN);

/** Semantic-version precedence (semver.org §11). Returns null when either side is not a version. */
export function compareSemver(a: string, b: string): number | null {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (pa === null || pb === null) return null;
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return Math.sign(diff);
  }
  const preA = a.includes('-') ? a.slice(a.indexOf('-') + 1).split('.') : [];
  const preB = b.includes('-') ? b.slice(b.indexOf('-') + 1).split('.') : [];
  if (preA.length === 0 || preB.length === 0) return preA.length === preB.length ? 0 : preA.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(preA.length, preB.length); i += 1) {
    const x = preA[i];
    const y = preB[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^[0-9]+$/.test(x);
    const ny = /^[0-9]+$/.test(y);
    if (nx && ny) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return Math.sign(diff);
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export const CertificationRecordContract = defineContract<CertificationRecord>({
  name: 'CertificationRecord',
  description: 'A signed, expiring adapter certification (§3.5, §15.4). Shared by doctor, the portability gate and the release pipeline.',
  schema: CertificationRecordSchema,
  refine: (value, issue) => {
    const order = compareSemver(value.harnessVersionRange.minimum, value.harnessVersionRange.maximumExclusive);
    if (order === null || order >= 0) issue('/harnessVersionRange', 'EMPTY_RANGE');
    if (timestampMs(value.expiresAt) <= timestampMs(value.certifiedAt)) issue('/expiresAt', 'EXPIRY_NOT_AFTER_ISSUE');
    const unique = (list: readonly string[], path: string) => {
      const seen = new Set<string>();
      list.forEach((id, index) => {
        if (seen.has(id)) issue(`${path}/${index}`, 'DUPLICATE');
        seen.add(id);
      });
    };
    unique(value.features.map((feature) => feature.featureId), '/features');
    unique(value.models.map((model) => model.modelId), '/models');
    unique(value.tools.map((tool) => tool.toolId), '/tools');
    value.features.forEach((feature, index) => {
      if (feature.status !== 'certified' && feature.reasonCode === null) issue(`/features/${index}/reasonCode`, 'REASON_REQUIRED');
    });
  },
});

export interface CertificationContext {
  readonly harness: string;
  readonly harnessVersion: string;
  readonly operatingSystem: string;
  readonly nowMs: number;
  readonly featureId: string;
}

export type CertificationCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reasonCode:
        | 'HARNESS_MISMATCH'
        | 'INVALID_VERSION'
        | 'VERSION_OUT_OF_RANGE'
        | 'OS_NOT_CERTIFIED'
        | 'NOT_YET_VALID'
        | 'EXPIRED'
        | 'FEATURE_NOT_CERTIFIED';
    };

/**
 * Whether a validated, signature-checked record certifies this feature for actuation here and
 * now. Anything else disables actuation of the feature; observation may continue (§15.4).
 */
export function certificationCovers(record: CertificationRecord, context: CertificationContext): CertificationCheck {
  const refuse = (reasonCode: Exclude<CertificationCheck, { ok: true }>['reasonCode']): CertificationCheck => ({ ok: false, reasonCode });
  if (record.harness !== context.harness) return refuse('HARNESS_MISMATCH');
  const lower = compareSemver(context.harnessVersion, record.harnessVersionRange.minimum);
  const upper = compareSemver(context.harnessVersion, record.harnessVersionRange.maximumExclusive);
  if (lower === null || upper === null) return refuse('INVALID_VERSION');
  if (lower < 0 || upper >= 0) return refuse('VERSION_OUT_OF_RANGE');
  if (!(record.operatingSystems as readonly string[]).includes(context.operatingSystem)) return refuse('OS_NOT_CERTIFIED');
  if (!Number.isFinite(context.nowMs) || context.nowMs < timestampMs(record.certifiedAt)) return refuse('NOT_YET_VALID');
  if (context.nowMs >= timestampMs(record.expiresAt)) return refuse('EXPIRED');
  const feature = record.features.find((candidate) => candidate.featureId === context.featureId);
  if (feature === undefined || feature.status !== 'certified') return refuse('FEATURE_NOT_CERTIFIED');
  return { ok: true };
}

import type {
  CredentialDiagnostic,
  EgressDecision,
  EgressLogLine,
  EgressReasonCode,
} from '@jevris/contracts';

/**
 * Synchronous in-process egress gate. It does not send, grant a tool
 * permission, or read source text into the result. Formatters read a code
 * or a known reason only. They have no body, secret, or claim parameter.
 */

const MISSING_CONSENT = 'Egress denied: missing consent.';
const UNTRUSTED_APPROVAL = 'Egress denied: untrusted text is not approval.';
const CREDENTIAL_MISSING = 'API credential is missing. Coding continues without a remote call.';
const PROVIDER_PREFIX = 'Provider error: ';
const CODE_PATTERN = /^[A-Z0-9_]{1,32}$/;
const dangerous = new Set(['__proto__', 'prototype', 'constructor']);

const LOG_LINES: Record<EgressReasonCode, string> = {
  EGRESS_NOT_APPROVED: MISSING_CONSENT,
  UNTRUSTED_APPROVAL: UNTRUSTED_APPROVAL,
  CREDENTIAL_MISSING: CREDENTIAL_MISSING,
};

export interface EgressRequest {
  readonly setting?: unknown;
  readonly untrustedClaims?: unknown;
  readonly sourceText?: string;
  readonly secretText?: string;
}

function denyNotApproved(): EgressDecision {
  return {
    decision: 'deny',
    reasonCode: 'EGRESS_NOT_APPROVED',
    explanation: MISSING_CONSENT,
    sent: false,
    toolPermission: false,
  };
}

function denyUntrusted(): EgressDecision {
  return {
    decision: 'deny',
    reasonCode: 'UNTRUSTED_APPROVAL',
    explanation: UNTRUSTED_APPROVAL,
    sent: false,
    toolPermission: false,
  };
}

function claimsBlock(claims: unknown): boolean {
  if (claims === undefined) return false;
  if (!Array.isArray(claims)) return true;
  return claims.length > 0;
}

function allowLocal(): EgressDecision {
  return {
    decision: 'allow',
    sent: false,
    toolPermission: false,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function hasDangerousKey(value: object): boolean {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || dangerous.has(key)) return true;
  }
  return false;
}

export function decideEgress(input: EgressRequest): EgressDecision {
  if (claimsBlock(input.untrustedClaims)) return denyUntrusted();
  const setting = input.setting;
  if (setting === undefined) return denyNotApproved();
  if (!isPlainObject(setting) || hasDangerousKey(setting)) return denyNotApproved();
  if (setting.provenance !== 'administrator') return denyNotApproved();
  if (setting.sourceEgress !== 'approved-scoped') return denyNotApproved();
  return allowLocal();
}

function acceptedCode(value: unknown): string {
  if (typeof value !== 'string') return 'PROVIDER_ERROR';
  if (!CODE_PATTERN.test(value)) return 'PROVIDER_ERROR';
  return value;
}

function acceptedStatus(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined;
  if (!Number.isInteger(value)) return undefined;
  if (value < 100 || value > 599) return undefined;
  return value;
}

function knownReason(value: unknown): EgressReasonCode {
  if (value === 'EGRESS_NOT_APPROVED' || value === 'UNTRUSTED_APPROVAL' || value === 'CREDENTIAL_MISSING') {
    return value;
  }
  return 'EGRESS_NOT_APPROVED';
}

export function formatProviderError(input: {
  readonly code: string;
  readonly status?: number;
}): string {
  if (!isPlainObject(input)) return `${PROVIDER_PREFIX}PROVIDER_ERROR`;
  const code = acceptedCode(input.code);
  const status = acceptedStatus(input.status);
  if (status === undefined) return `${PROVIDER_PREFIX}${code}`;
  return `${PROVIDER_PREFIX}${code} (${status})`;
}

export function formatEgressLog(input: { readonly reasonCode: EgressReasonCode }): EgressLogLine {
  const reasonCode = knownReason(isPlainObject(input) ? input.reasonCode : undefined);
  return { reasonCode, line: LOG_LINES[reasonCode] };
}

function missingCredential(): CredentialDiagnostic {
  return {
    reasonCode: 'CREDENTIAL_MISSING',
    explanation: CREDENTIAL_MISSING,
  };
}

/**
 * Presence is an injected argument. Only the string present returns null.
 * Every other presence returns one diagnostic. Ignored fields are not read.
 */
export function diagnoseCredential(input: {
  readonly presence: string;
}): CredentialDiagnostic | null {
  if (isPlainObject(input) && Object.hasOwn(input, 'presence') && input.presence === 'present') {
    return null;
  }
  return missingCredential();
}

// ------------------------------------------------------------------ transport boundary (GOV-01, US02)

/**
 * Free-text evidence in a Jev wire request: text that came from the workspace, a tool or the
 * user rather than from Jevris itself. While host egress is not approved, a request that
 * carries any of it is refused at the transport boundary (defence in depth: the packet
 * builder should already have left it out). Agreed fields, as JSON pointers:
 *
 * - `/state/untrustedEvidence/<i>/text` (the packet builder's evidence spans);
 * - `/state/evidence/<i>/text` (the older packet shape);
 * - `/state/task` (a task statement).
 *
 * Question instructions, criteria, the objective, facts, trusted policy, candidates and
 * missing-evidence labels are Jevris-authored and are not free text here.
 */
export function egressFreeText(body: unknown): readonly { readonly pointer: string; readonly text: string }[] {
  if (!isPlainObject(body)) return [];
  const state = body['state'];
  if (!isPlainObject(state)) return [];
  const out: { pointer: string; text: string }[] = [];
  for (const key of ['untrustedEvidence', 'evidence'] as const) {
    const list = state[key];
    if (!Array.isArray(list)) continue;
    list.forEach((item: unknown, index) => {
      if (isPlainObject(item) && typeof item['text'] === 'string' && item['text'].trim().length > 0) out.push({ pointer: ['', 'state', key, String(index), 'text'].join('/'), text: item['text'] });
    });
  }
  if (typeof state['task'] === 'string' && state['task'].trim().length > 0) out.push({ pointer: '/state/task', text: state['task'] });
  return out;
}

/** The JSON pointers of `egressFreeText`, for logs (never the text). */
export function egressFreeTextFields(body: unknown): readonly string[] {
  return egressFreeText(body).map((item) => item.pointer);
}

/** The status a refused request answers with locally (nothing was sent). */
export const EGRESS_REFUSED_STATUS = 451;

// ------------------------------------------------------------------ secret screening (GOV-08, US26)

/**
 * Deterministic secret screening for text that could leave the machine (SSOT §16.3, C50, E06).
 * Each rule has a stable id, so a data scope can allow one explicitly (for example a scope
 * that legitimately carries JWT-shaped test fixtures). No inference call is involved.
 *
 * Rules are shapes, never literal values: nothing here is a known key or a test canary.
 */
export interface SecretRule {
  readonly id: string;
  readonly pattern: RegExp;
}

const W = '(?:^|[^A-Za-z0-9_])';
const rule = (id: string, source: string, flags = ''): SecretRule => ({ id, pattern: new RegExp(source, `g${flags}`) });

export const SECRET_RULES: readonly SecretRule[] = Object.freeze([
  rule('aws-access-key-id', `${W}(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA|A3T[A-Z0-9])[A-Z0-9]{16}(?![A-Z0-9])`),
  rule('aws-secret-access-key', `aws.{0,20}(?:secret|private).{0,20}[=:"'\\s]{1,4}[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])`, 'i'),
  rule('aws-session-token', `aws.{0,20}session.{0,5}token.{0,5}[=:"'\\s]{1,4}[A-Za-z0-9/+=]{100,}`, 'i'),
  rule('github-token', `${W}gh[pousr]_[A-Za-z0-9]{36,}`),
  rule('github-fine-grained-pat', `${W}github_pat_[A-Za-z0-9_]{50,}`),
  rule('gitlab-token', `${W}gl(?:pat|dt|rt|ptt|ft|soat|agent)-[A-Za-z0-9_-]{20,}`),
  rule('slack-token', `${W}xox[abposr]-[A-Za-z0-9-]{10,}`),
  rule('slack-webhook', 'hooks\\.slack\\.com/(?:services|workflows)/[A-Za-z0-9/_-]{20,}'),
  rule('google-api-key', `${W}AIza[0-9A-Za-z_-]{35}`),
  rule('google-oauth-token', `${W}ya29\\.[0-9A-Za-z_-]{20,}`),
  rule('gcp-service-account', '"type"\\s*:\\s*"service_account"'),
  rule('stripe-key', `${W}(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}`),
  rule('stripe-webhook-secret', `${W}whsec_[0-9A-Za-z]{24,}`),
  rule('twilio-key', `${W}SK[0-9a-f]{32}(?![0-9a-f])`),
  rule('sendgrid-key', `${W}SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{30,}`),
  rule('mailgun-key', `${W}key-[0-9a-f]{32}(?![0-9a-f])`),
  rule('npm-token', `${W}npm_[A-Za-z0-9]{36}`),
  rule('pypi-token', `${W}pypi-AgE[A-Za-z0-9_-]{50,}`),
  rule('anthropic-key', `${W}sk-ant-[A-Za-z0-9_-]{20,}`),
  rule('openai-key', `${W}sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}`),
  rule('jwt', `${W}eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}`),
  rule('private-key-block', '-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----'),
  rule('azure-storage-key', 'AccountKey=[A-Za-z0-9/+]{80,}={0,2}'),
  rule('azure-sas-token', '[?&]sig=[A-Za-z0-9%/+]{30,}'),
  rule('digitalocean-token', `${W}do[por]_v1_[a-f0-9]{64}`),
  rule('shopify-token', `${W}shp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}`),
  rule('square-token', `${W}(?:sq0atp|sq0csp|EAAA)[A-Za-z0-9_-]{22,}`),
  rule('discord-bot-token', `${W}[MNO][A-Za-z0-9_-]{23,25}\\.[A-Za-z0-9_-]{6}\\.[A-Za-z0-9_-]{27,}`),
  rule('telegram-bot-token', `${W}[0-9]{8,10}:AA[A-Za-z0-9_-]{33}`),
  rule('huggingface-token', `${W}hf_[A-Za-z]{34}`),
  rule('databricks-token', `${W}dapi[a-f0-9]{32}`),
  rule('doppler-token', `${W}dp\\.(?:pt|st|sa|ct|scim|audit)\\.[A-Za-z0-9]{40,}`),
  rule('vault-token', `${W}hv[sbr]\\.[A-Za-z0-9_-]{24,}`),
  rule('atlassian-token', `${W}ATATT3[A-Za-z0-9_=-]{50,}`),
  rule('linear-key', `${W}lin_api_[A-Za-z0-9]{40}`),
  rule('notion-token', `${W}(?:secret|ntn)_[A-Za-z0-9]{43}`),
  rule('postman-key', `${W}PMAK-[a-f0-9]{24}-[a-f0-9]{34}`),
  rule('figma-token', `${W}figd_[A-Za-z0-9_-]{40,}`),
  rule('supabase-token', `${W}sbp_[a-f0-9]{40}`),
  rule('grafana-token', `${W}gl(?:c|sa)_[A-Za-z0-9_=+/-]{32,}`),
  rule('newrelic-key', `${W}NRAK-[A-Z0-9]{27}`),
  rule('age-secret-key', 'AGE-SECRET-KEY-1[0-9A-Z]{58}'),
  rule('terraform-token', `${W}[A-Za-z0-9]{14}\\.atlasv1\\.[A-Za-z0-9_=-]{60,}`),
  rule('sentry-dsn', 'https?://[0-9a-f]{32}@[A-Za-z0-9.-]+'),
  rule('url-credentials', '[A-Za-z][A-Za-z0-9+.-]*://[^/\\s:@]{1,64}:[^/\\s@]{3,}@'),
  rule('env-assignment', `(?:^|[\\s;'"{,])(?:export\\s+)?["']?(?:[A-Za-z_][A-Za-z0-9_]*)?(?:SECRET(?:_?KEY)?|TOKEN|PASSWORD|PASSWD|PWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CLIENT_?SECRET|AUTH_?TOKEN)["']?\\s*[=:]\\s*["']?(?!process\\.|os\\.environ|env\\.|import\\.meta|\\$|<|%|\\[REDACTED)[^\\s"'$]{8,}`, 'i'),
  rule('high-entropy-token', '(?:^|[^A-Za-z0-9_+/-])(?=[A-Za-z0-9_+/-]*[a-z])(?=[A-Za-z0-9_+/-]*[A-Z])(?=[A-Za-z0-9_+/-]*[0-9])[A-Za-z0-9_+/-]{40,}'),
]);

/**
 * Relative paths whose content is sensitive wherever they appear: env files, SSH and TLS keys,
 * cloud and package-manager credentials, and `secrets/` folders.
 */
export const SENSITIVE_PATH_RULES: readonly SecretRule[] = Object.freeze([
  rule('path-env-file', '(?:^|[\\s/\\\\"\'])\\.env(?:\\.[A-Za-z0-9_-]+)?(?=$|[\\s"\'/\\\\,;:)])'),
  rule('path-ssh-key', '(?:^|[\\s/\\\\"\'])id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?(?=$|[\\s"\',;:)])'),
  rule('path-key-file', '[A-Za-z0-9_-]+\\.(?:pem|p12|pfx|key|keystore|jks)(?=$|[\\s"\',;:)])'),
  rule('path-secrets-dir', '(?:^|[\\s/\\\\"\'])secrets?[/\\\\]'),
  rule('path-cloud-credentials', '\\.(?:aws[/\\\\]credentials|azure[/\\\\]|config[/\\\\]gcloud[/\\\\]|kube[/\\\\]config|docker[/\\\\]config\\.json)'),
  rule('path-package-credentials', '(?:^|[\\s/\\\\"\'])\\.(?:npmrc|pypirc|netrc|git-credentials|pgpass)(?=$|[\\s"\',;:)])'),
]);

export interface SecretFinding {
  readonly ruleId: string;
  /** UTF-16 offset and length of the match; the matched text itself is never returned. */
  readonly start: number;
  readonly length: number;
}

export interface ScreenOptions {
  /** Rule ids this data scope explicitly allows (a positive allowlist). */
  readonly allow?: readonly string[];
  /** Also screen for sensitive relative paths (default true). */
  readonly paths?: boolean;
}

/** Every secret and sensitive-path finding in `text`, without the matched values. */
export function screenText(text: string, options: ScreenOptions = {}): readonly SecretFinding[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const allow = new Set(options.allow ?? []);
  const rules = options.paths === false ? SECRET_RULES : [...SECRET_RULES, ...SENSITIVE_PATH_RULES];
  const findings: SecretFinding[] = [];
  for (const { id, pattern } of rules) {
    if (allow.has(id)) continue;
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      findings.push({ ruleId: id, start: match.index ?? 0, length: match[0].length });
      if (findings.length >= 256) return findings;
    }
  }
  return findings;
}

/**
 * Redact-and-continue: every finding is replaced by `[REDACTED:<rule id>]`. Overlapping
 * findings are merged, so no fragment of a secret survives between two replacements.
 */
export function redactText(text: string, options: ScreenOptions = {}): { readonly text: string; readonly findings: readonly SecretFinding[] } {
  const findings = screenText(text, options);
  if (findings.length === 0) return { text, findings };
  const ordered = [...findings].sort((a, b) => a.start - b.start || b.length - a.length);
  let out = '';
  let at = 0;
  for (const finding of ordered) {
    const end = finding.start + finding.length;
    if (end <= at) continue;
    const from = Math.max(at, finding.start);
    out += text.slice(at, from);
    out += at > finding.start ? '' : `[REDACTED:${finding.ruleId}]`;
    at = end;
  }
  out += text.slice(at);
  return { text: out, findings };
}

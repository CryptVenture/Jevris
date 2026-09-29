/**
 * `jevris consent provider` (owner decisions DOMAINS 7be3c43 and OD-4; routing design R30): the
 * one way to see, give and take back consent to send work to a model provider. B stores it
 * (`provider.consent.status | grant | revoke`, CLI key only); C's routing reads it.
 *
 * - The list shows every provider Jevris has consent text for, plus any stored row, with its
 *   state and why: granted, revoked, required, or allowed by the signed-in default (OD-4: a
 *   provider that passed the registry review is allowed while you are signed in to it on an
 *   installed harness; Moonshot and DeepSeek always need a grant).
 * - A grant widens what may leave the machine, so it needs a person: an interactive terminal
 *   (never MCP, a hook, a pipe or a test run), the provider's training term and storage location
 *   shown first (contracts `PROVIDER_CONSENT_TEXT`), and a typed phrase. The grant names the
 *   version of the text shown, so a text that changed since cannot be granted.
 * - A revoke only tightens: no terminal and no phrase.
 * - Serving hosts (R47; owner decisions 8c1f85d and c8e933d): a pinned gateway or inference host is
 *   a party too, listed under "Hosts". A route through a host needs the host's consent and the
 *   maker's; a grant for a host says so and shows who the host forwards to. A host with no text
 *   (NVIDIA) cannot be granted and is never routed to.
 * - Every sidecar answer is checked before it is shown. Grants and revokes are audited by the
 *   sidecar in the same transaction.
 */
import { lstat, readFile } from 'node:fs/promises';
import { COMMAND_EXIT_CODES, PROVIDER_CONSENT_TEXT, SERVING_HOST_IDS, consentText, providerConsentPhrase, servingHostOf, type ProviderConsentText, type ServingHostConsentText } from '@jevris/contracts';
import { BUNDLED_MODEL_REGISTRY, BUNDLED_REGISTRY_SOURCES, loadModelRegistry, modelRegistryFile, validateModelRegistry } from '@jevris/core';
import { homeRefusal } from './public/home-guard.js';
import { defaultPorts } from './public/ports.js';
import { dataTermsDoctorLines } from './data-terms.js';
import { hostTariffsDoctorLine } from './host-tariffs.js';
import { contextFor, parse, type VerifyAdminOptions } from './verify-admin.js';

type Write = (text: string) => void;

export const CONSENT_HELP = `Usage: jevris consent provider [<provider>] [--home <dir>] [--json]
       jevris consent provider <provider> --grant [--home <dir>]
       jevris consent provider <provider> --revoke [--home <dir>] [--json]
       jevris consent provider --all --revoke [--home <dir>] [--json]

Whether Jevris may route, suggest or launch models from a model provider. Some providers'
terms train on what they receive by default or store it outside your region, so routing to
them needs your consent. Moonshot (Kimi) and DeepSeek always need it. Any other provider that
passed Jevris's registry review is allowed while you are signed in to it on an installed
harness, and needs the same consent otherwise.

<provider> is a model's maker (such as moonshot) or a serving host that passes requests on
(openrouter, kilo). A route through a host needs consent for the host and for the model's
maker. OpenRouter and the Kilo Gateway are allowed while you are signed in to them; the
provider they pass your request to may train on it by default. NVIDIA cannot be granted.

With no provider, lists each maker's and host's state and why: granted, revoked, required, or
allowed by the signed-in default. With a provider, also shows its training term, storage
location, who it forwards to, and the dated terms they come from.

--grant   Shows the provider's training term and storage location, then asks you to type
          "consent to <provider>". Only from an interactive terminal: never from MCP, a hook,
          a script or a test run. The grant counts for the text you saw; when Jevris's text
          for that provider changes, you are asked again.
--revoke  Takes consent back, and Jevris then does not route to that provider even while
          you are signed in to it. Revoking always works: no terminal is needed, and a
          provider you never granted can be revoked too. --all revokes every provider Jevris
          knows, including ones you never granted.

Both changes are recorded in the audit log (jevris audit export). A repository file, a config
file or a model summary is never consent.

Options:
  --grant        Give consent to one provider
  --revoke       Take consent back from one provider, or from every provider with --all
  --all          With --revoke: every provider, including ones never granted
  --home <dir>   Jevris home (default: JEVRIS_HOME, else your home directory)
  --json         The list and --revoke: print one JSON result line

Exit codes: 0 shown or changed (or already so); 1 not changed (the sidecar is not running,
the store is not open, or the text changed since it was shown); 2 usage error, not an
interactive terminal, or the phrase did not match.

Examples:
  jevris consent provider
  jevris consent provider deepseek
  jevris consent provider deepseek --grant
  jevris consent provider deepseek --revoke
  jevris consent provider openrouter`;

const PROVIDER = /^[a-z][a-z0-9-]{0,31}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
/** B's store (ae73f00): a revoke of a provider never granted is stored with text version `none` and grant time 0. */
const NEVER_GRANTED_TEXT_VERSION = 'none';
const MAX_ROWS = 64;

export type ConsentState = 'granted' | 'revoked' | 'required' | 'signed-in-default' | 'blocked';

/** One stored row, as B's `provider.consent.status` returns it. */
export interface StoredConsent {
  readonly provider: string;
  readonly state: 'granted' | 'revoked';
  readonly textVersion: string;
  readonly grantedAtMs: number;
  readonly revokedAtMs: number | null;
  readonly current: boolean;
}

export interface ProviderConsentView {
  readonly provider: string;
  /** A model's maker, or a pinned serving host (R47). */
  readonly party: 'maker' | 'host';
  readonly name: string | null;
  readonly state: ConsentState;
  readonly why: string;
  readonly alwaysRequired: boolean;
  readonly textVersion: string | null;
  readonly grantedAtMs: number | null;
  readonly revokedAtMs: number | null;
}

const ms = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;

/** B's status answer, checked field by field; null when it does not match. */
export function checkConsentStatus(raw: unknown): readonly StoredConsent[] | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rows = (raw as { readonly providers?: unknown }).providers;
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) return null;
  const out: StoredConsent[] = [];
  for (const row of rows as unknown[]) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return null;
    const r = row as { readonly [key: string]: unknown };
    const provider = r['provider'];
    const state = r['state'];
    const textVersion = r['textVersion'];
    const revokedAtMs = r['revokedAtMs'];
    if (typeof provider !== 'string' || !PROVIDER.test(provider) || (state !== 'granted' && state !== 'revoked')) return null;
    if (typeof textVersion !== 'string' || !VERSION.test(textVersion) || !ms(r['grantedAtMs']) || typeof r['current'] !== 'boolean') return null;
    if (state === 'granted' ? revokedAtMs !== null : !ms(revokedAtMs)) return null;
    if (out.some((o) => o.provider === provider)) return null;
    out.push({ provider, state, textVersion, grantedAtMs: r['grantedAtMs'], revokedAtMs: state === 'granted' ? null : (revokedAtMs as number), current: r['current'] });
  }
  return out;
}

const day = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

function textFor(provider: string): ProviderConsentText | ServingHostConsentText | undefined {
  return consentText(provider);
}

const isHost = (id: string): boolean => (SERVING_HOST_IDS as readonly string[]).includes(id);

/** One line of the host's party: its kind, and that a route through it needs the maker too. */
function hostNote(id: string): string {
  const host = servingHostOf(id);
  if (host === undefined) return '';
  const forwards = host.forwardsTo.length === 0 ? '' : `; it passes requests to ${host.forwardsTo.join(', ')}, so revoking ${host.forwardsTo.join(' or ')} blocks it too`;
  return `; routes through it also need the maker's consent${forwards}`;
}

/** Each provider's state and why, from the consent text and the stored rows. */
export function consentViews(stored: readonly StoredConsent[]): readonly ProviderConsentView[] {
  const own = ownConsentViews(stored);
  // A host that passes requests to another host (kilo to openrouter) is blocked when that host is:
  // the list matches C's gate (B's note on R47).
  return own.map((v) => {
    if (v.party !== 'host' || v.state === 'revoked' || v.state === 'required') return v;
    const blockedBy = (servingHostOf(v.provider)?.forwardsTo ?? []).map((id) => own.find((o) => o.provider === id)).find((o) => o !== undefined && (o.state === 'revoked' || o.state === 'required'));
    if (blockedBy === undefined) return v;
    const why = blockedBy.state === 'revoked' ? 'is revoked' : 'needs your consent again';
    return { ...v, state: 'blocked' as const, why: `${blockedBy.provider} ${why}, and ${v.provider} passes requests there, so Jevris does not route through ${v.provider} (jevris consent provider ${blockedBy.provider} --grant)` };
  });
}

function ownConsentViews(stored: readonly StoredConsent[]): readonly ProviderConsentView[] {
  const ids = [...new Set([...Object.keys(PROVIDER_CONSENT_TEXT), ...SERVING_HOST_IDS, ...stored.map((row) => row.provider)])].sort();
  return ids.map((provider) => {
    const text = textFor(provider);
    const row = stored.find((r) => r.provider === provider);
    const party: 'maker' | 'host' = isHost(provider) ? 'host' : 'maker';
    const alwaysRequired = text?.alwaysRequired ?? true;
    const name = text?.name ?? null;
    const base = { provider, party, name, alwaysRequired, textVersion: row?.textVersion ?? null, grantedAtMs: row?.grantedAtMs ?? null, revokedAtMs: row?.revokedAtMs ?? null };
    const noText = party === 'host' ? 'Jevris has no consent text for this serving host, so it cannot be granted and is never routed to' : 'Jevris has no consent text for this provider, so it cannot be granted';
    const fallback: { state: ConsentState; why: string } = alwaysRequired
      ? { state: 'required', why: text === undefined ? noText : 'its terms train on what it receives by default, so it always needs your consent' }
      : { state: 'signed-in-default', why: `allowed while you are signed in to it on an installed harness; otherwise it needs your consent${party === 'host' ? hostNote(provider) : ''}` };
    if (row === undefined) return { ...base, ...fallback };
    // A revoke of a provider never granted: no text version was ever shown and no grant was ever given.
    if (row.state === 'revoked' && row.textVersion === NEVER_GRANTED_TEXT_VERSION && row.grantedAtMs === 0) {
      return { ...base, textVersion: null, grantedAtMs: null, state: 'revoked', why: `you revoked it on ${day(row.revokedAtMs ?? 0)} without ever granting it; Jevris does not route to it even while you are signed in to it (grant it with jevris consent provider ${provider} --grant)` };
    }
    // C's order: a revoke blocks even while signed in; a stale grant blocks until it is given again.
    if (row.state === 'revoked') return { ...base, state: 'revoked', why: `you revoked consent on ${day(row.revokedAtMs ?? row.grantedAtMs)}; Jevris does not route to it even while you are signed in to it (grant it again with jevris consent provider ${provider} --grant)` };
    if (row.current) return { ...base, state: 'granted', why: `you consented on ${day(row.grantedAtMs)}${party === 'host' ? hostNote(provider) : ''}` };
    return { ...base, state: 'required', why: `the consent text changed after you consented on ${day(row.grantedAtMs)}; Jevris does not route to it until you consent again (jevris consent provider ${provider} --grant)` };
  });
}

const STATE_TEXT: { readonly [K in ConsentState]: string } = {
  granted: 'granted',
  revoked: 'revoked',
  required: 'consent required',
  'signed-in-default': 'signed-in default',
  blocked: 'blocked',
};

/** The state as the list and doctor say it; a revoke with no grant behind it says so. */
function stateText(v: ProviderConsentView): string {
  return v.state === 'revoked' && v.grantedAtMs === null ? 'revoked (never granted)' : STATE_TEXT[v.state];
}

function viewLine(v: ProviderConsentView): string {
  // A host line names its kind (design 5.4: `openrouter (gateway): ...`).
  const label = v.party === 'host' ? (servingHostOf(v.provider)?.kind ?? null) : v.name;
  return `${v.provider}${label === null ? '' : ` (${label})`}: ${stateText(v)}: ${v.why}`;
}

function termLines(text: ProviderConsentText | ServingHostConsentText): string[] {
  const forwarding = 'forwarding' in text ? [`forwarding: ${text.forwarding}`] : [];
  return [`training: ${text.training}`, `storage: ${text.storage}`, ...forwarding, `source: ${text.source}`];
}

function disclosure(provider: string, text: ProviderConsentText | ServingHostConsentText): string {
  const host = isHost(provider);
  return [
    host
      ? `Consenting lets Jevris route, suggest or launch models through ${text.name} for your tasks, so your prompts, code and tool output go to ${text.name} and to the provider it passes them to, under their terms:`
      : `Consenting lets Jevris route, suggest or launch models from ${text.name} for your tasks, so your prompts, code and tool output go to ${text.name} under its terms:`,
    ...termLines(text).map((line) => `- ${line}`),
    ...(host ? [`A route through ${text.name} also needs consent for the model's maker, for example Moonshot for Kimi K3.`] : []),
    'Local deletion (jevris data delete) is not deletion at the provider.',
    `This is recorded in the Jevris store and the audit log. Undo it with jevris consent provider ${provider} --revoke.`,
    '',
  ].join('\n');
}

async function readLineFromStdin(prompt: string, write: Write): Promise<string | null> {
  write(prompt);
  return new Promise((resolve) => {
    const onData = (chunk: Uint8Array): void => {
      process.stdin.off('data', onData);
      process.stdin.pause();
      resolve(new TextDecoder().decode(chunk).replace(/\r?\n$/, ''));
    };
    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}

function actorName(env: { readonly [key: string]: string | undefined }): string {
  const cleaned = (env['USER'] ?? env['USERNAME'] ?? 'cli').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 63);
  return /^[A-Za-z]/.test(cleaned) ? cleaned : `u${cleaned}`.slice(0, 64);
}

export interface ConsentCommandOptions extends VerifyAdminOptions {
  /** Whether stdin and stdout are an interactive terminal (default: both are TTYs). */
  readonly interactive?: () => boolean;
  /** Reads one typed line after writing the prompt (default: stdin). */
  readonly readLine?: (prompt: string) => Promise<string | null>;
}

const REFUSAL_TEXT: { readonly [code: string]: string } = {
  STORE_UNAVAILABLE: 'the Jevris store is not open',
  STORE_REFUSED: 'the store refused it; retry in a moment',
  UNKNOWN_PROVIDER: 'Jevris has no consent text for this provider',
  CONSENT_TEXT_MISSING: 'Jevris has no consent text for this serving host, so it cannot be granted and is never routed to',
  PROVIDER_CONSENT_TEXT_MISMATCH: 'the consent text changed since it was shown; run the command again to see the current text',
  CHANNEL_REFUSED: 'consent is given only by a person at an interactive terminal',
  INVALID_REQUEST: 'the sidecar did not accept the request',
  SIDECAR_INVALID_RESULT: 'the sidecar answered with something Jevris does not recognise',
};

/** Runs `jevris consent ...` (argv after `consent`). */
export async function runConsentCommand(argv: readonly string[], write: Write, options: ConsentCommandOptions = {}): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    write(`${CONSENT_HELP}\n`);
    return argv.length === 0 ? COMMAND_EXIT_CODES.usage : COMMAND_EXIT_CODES.ok;
  }
  const parsed = parse(argv, ['--home'], ['--grant', '--revoke', '--all', '--json']);
  const json = typeof parsed !== 'string' && parsed.flags.has('--json');
  const usage = (message: string): number => {
    write(json ? `${JSON.stringify({ error: { code: 'USAGE', message } })}\n` : `${message}\nRun jevris help consent for usage.\n`);
    return COMMAND_EXIT_CODES.usage;
  };
  if (typeof parsed === 'string') return usage(parsed);
  if (parsed.positionals[0] !== 'provider') return usage('Name what the consent is for: jevris consent provider [<provider>].');
  if (parsed.positionals.length > 2) return usage('Name at most one provider.');
  const provider = parsed.positionals[1];
  const grant = parsed.flags.has('--grant');
  const revoke = parsed.flags.has('--revoke');
  const all = parsed.flags.has('--all');
  if (provider !== undefined && !PROVIDER.test(provider)) return usage('A provider id is lower case, such as deepseek or openai (jevris consent provider lists them).');
  if (grant && revoke) return usage('Use --grant or --revoke, not both.');
  if (all && (!revoke || provider !== undefined)) return usage('--all goes with --revoke and no provider: jevris consent provider --all --revoke.');
  if ((grant || revoke) && provider === undefined && !all) return usage(`Name the provider: jevris consent provider <provider> ${grant ? '--grant' : '--revoke'}.`);
  if (grant && json) return usage('--grant asks at the terminal, so it takes no --json.');

  const ctx = contextFor(parsed, options, options.ports ?? (await defaultPorts()));
  const refusedHome = homeRefusal(ctx);
  if (refusedHome !== null) return usage(refusedHome);
  const command = 'consent provider';
  const out = (result: object, lines: readonly string[], code: number): number => {
    write(json ? `${JSON.stringify({ schemaVersion: '1.0', command, ...result })}\n` : `${lines.join('\n')}\n`);
    return code;
  };
  const refused = (reasonCode: string): number => {
    const why = REFUSAL_TEXT[reasonCode] ?? (reasonCode.startsWith('SIDECAR_') ? 'the Jevris sidecar is not running; start it with jevris sidecar start and retry' : null);
    return out({ changed: false, reasonCode }, [`Nothing changed (${reasonCode})${why === null ? '' : `: ${why}`}.`], COMMAND_EXIT_CODES.negative);
  };

  // A grant is refused before the sidecar is asked anything when no person is there to see the text.
  const text = provider === undefined ? undefined : textFor(provider);
  if (grant) {
    // A pinned host with no text (NVIDIA, OQ-2) is refused as B's grant op refuses it.
    if (text === undefined) return refused(provider !== undefined && isHost(provider) ? 'CONSENT_TEXT_MISSING' : 'UNKNOWN_PROVIDER');
    const interactive = options.interactive ?? (() => process.stdin.isTTY === true && Reflect.get(process.stdout, 'isTTY') === true);
    if (ctx.env['JEVRIS_TEST'] === '1' || !interactive()) {
      write('Not granted: consent needs a person at an interactive terminal (never MCP, a hook, a script, a pipe or a test run). Nothing changed.\n');
      return COMMAND_EXIT_CODES.usage;
    }
  }

  if (ctx.autostart) {
    const ensured = await ctx.ports.sidecar.ensure({ home: ctx.home, waitMs: ctx.sidecarWaitMs });
    if (!ensured.ok) return refused(`SIDECAR_${ensured.reason.toUpperCase()}`);
  }
  const call = (op: string, body: object, budget: 'hot' | 'background') => ctx.ports.sidecar.request({ home: ctx.home, op, workspace: ctx.workspaceRoot ?? '', body, scope: 'cli', timeoutMs: ctx.requestTimeoutMs, budget });

  if (revoke) {
    const answer = await call('provider.consent.revoke', all ? { all: true, actor: actorName(ctx.env) } : { provider, actor: actorName(ctx.env) }, 'hot');
    if (!answer.ok) return refused(answer.reasonCode ?? `SIDECAR_${answer.reason.toUpperCase()}`);
    const r = answer.result as { readonly result?: unknown; readonly providers?: unknown } | null;
    const result = r?.result;
    const providers = r?.providers;
    if ((result !== 'revoked' && result !== 'not-granted') || !Array.isArray(providers) || providers.length > MAX_ROWS || !providers.every((p) => typeof p === 'string' && PROVIDER.test(p))) return refused('SIDECAR_INVALID_RESULT');
    // B's store (ae73f00) stores a revoke even where nothing was granted, so `not-granted` now means
    // everything asked for was already revoked.
    const lines =
      result !== 'revoked'
        ? [all ? 'Every provider is already revoked; nothing changed.' : `${String(provider)} is already revoked; nothing changed.`]
        : all
          ? [
              `Consent revoked for ${providers.length} provider${providers.length === 1 ? '' : 's'}: ${providers.join(', ')}.`,
              'Jevris will not route to them, even while you are signed in to them, including any you never granted.',
              'Grant one again with jevris consent provider <provider> --grant.',
            ]
          : [`Consent revoked for ${String(provider)}. Jevris will not route to it, even while you are signed in to it, until you grant it again (jevris consent provider ${String(provider)} --grant).`];
    return out({ changed: result === 'revoked', result, providers }, lines, COMMAND_EXIT_CODES.ok);
  }

  const status = await call('provider.consent.status', {}, 'background');
  if (!status.ok) return refused(status.reasonCode ?? `SIDECAR_${status.reason.toUpperCase()}`);
  const stored = checkConsentStatus(status.result);
  if (stored === null) return refused('SIDECAR_INVALID_RESULT');
  const views = consentViews(stored);

  if (!grant) {
    if (provider === undefined) {
      const makers = views.filter((v) => v.party === 'maker');
      const hosts = views.filter((v) => v.party === 'host');
      return out({ providers: views }, ['Consent per model provider.', 'Makers:', ...makers.map(viewLine), 'Hosts (a route through a host also needs the maker):', ...hosts.map(viewLine)], COMMAND_EXIT_CODES.ok);
    }
    const one = views.find((v) => v.provider === provider) ?? consentViews([]).find((v) => v.provider === provider);
    const view = one ?? { provider, party: 'maker' as const, name: null, state: 'required' as const, why: 'Jevris has no consent text for this provider, so it cannot be granted', alwaysRequired: true, textVersion: null, grantedAtMs: null, revokedAtMs: null };
    return out({ providers: [view], text: text ?? null }, [viewLine(view), ...(text === undefined ? [] : termLines(text))], COMMAND_EXIT_CODES.ok);
  }

  // grant (the terminal was checked above; text is defined)
  const shown = text as ProviderConsentText | ServingHostConsentText;
  const id = provider as string;
  const existing = views.find((v) => v.provider === id);
  if (existing?.state === 'granted' && existing.textVersion === shown.version) {
    write(`Consent to ${id} is already granted for the current text (${existing.why}); nothing changed.\n`);
    return COMMAND_EXIT_CODES.ok;
  }
  write(disclosure(id, shown));
  const phrase = providerConsentPhrase(id);
  const typed = await (options.readLine ?? ((prompt: string) => readLineFromStdin(prompt, write)))(`Type "${phrase}" to consent, anything else to cancel: `);
  if (typed === null || typed.trim() !== phrase) {
    write('\nNot granted: the phrase did not match. Nothing changed.\n');
    return COMMAND_EXIT_CODES.usage;
  }
  const answer = await call('provider.consent.grant', { provider: id, textVersion: shown.version, channel: 'terminal', actor: actorName(ctx.env) }, 'hot');
  if (!answer.ok) return refused(answer.reasonCode ?? `SIDECAR_${answer.reason.toUpperCase()}`);
  const r = answer.result as { readonly result?: unknown; readonly provider?: unknown; readonly textVersion?: unknown; readonly party?: unknown } | null;
  if ((r?.result !== 'granted' && r?.result !== 'already-granted') || r.provider !== id || r.textVersion !== shown.version) return refused('SIDECAR_INVALID_RESULT');
  // B's grant answers the party (3e74f561); one that disagrees with the pinned hosts is not trusted.
  if (r.party !== undefined && r.party !== (isHost(id) ? 'host' : 'maker')) return refused('SIDECAR_INVALID_RESULT');
  write(`Consent to ${shown.name} granted for text ${shown.version}. Undo it with jevris consent provider ${id} --revoke.\n`);
  return COMMAND_EXIT_CODES.ok;
}

/**
 * Doctor's lines (owner decision 7be3c43: consent and the data terms are shown in doctor; the
 * registry review's condition that the administrator override is visible): which model registry
 * routing reads, each provider's data terms per sign-in, and each provider's consent state. The
 * consent line asks a sidecar that is already running and never starts one; `ask` is injectable
 * for tests.
 */
export async function consentDoctorLines(home: string, ask?: () => Promise<unknown>): Promise<string[]> {
  const file = modelRegistryFile(home);
  let present = true;
  try {
    await lstat(file);
  } catch {
    present = false;
  }
  const registry = present ? await loadModelRegistry({ home }).catch(() => null) : null;
  const lines = [
    !present
      ? `modelRegistry: bundled snapshot ${BUNDLED_MODEL_REGISTRY.snapshotId}`
      : registry === null
        ? `modelRegistry: the administrator override ${file} was refused (${await overrideRefusal(file)}), so routing is unavailable; fix or remove it`
        : `modelRegistry: administrator override ${file} (snapshot ${registry.snapshotId}) in place of the bundled ${BUNDLED_MODEL_REGISTRY.snapshotId}`,
  ];
  // The data line per provider and sign-in (7be3c43), from the registry routing reads.
  const read = present ? registry : BUNDLED_MODEL_REGISTRY;
  if (read !== null) lines.push(...dataTermsDoctorLines(read.entries), hostTariffsDoctorLine(read.servings, BUNDLED_REGISTRY_SOURCES));
  let raw: unknown = null;
  try {
    raw = await (ask ?? (() => askRunningSidecar(home)))();
  } catch {
    raw = null;
  }
  const stored = raw === null ? null : checkConsentStatus(raw);
  if (stored === null) {
    lines.push(`providerConsent: not read (${raw === null ? 'the sidecar is not running' : 'the sidecar answer did not match'}); jevris consent provider shows it`);
    return lines;
  }
  const views = consentViews(stored);
  lines.push(`providerConsent: ${views.filter((v) => v.party === 'maker').map((v) => `${v.provider} ${stateText(v)}`).join(', ')} (jevris consent provider says why)`);
  // Serving hosts (design 8): each pinned host's kind and consent state; one with no text is never routed to.
  lines.push(`servingHosts: ${views.filter((v) => v.party === 'host').map((v) => `${v.provider} (${servingHostOf(v.provider)?.kind ?? 'host'}) ${consentText(v.provider) === undefined ? 'no consent text: never routed' : stateText(v)}`).join(', ')}`);
  return lines;
}

/**
 * Why an override was refused, with B's reason codes (model-registry-status, fail-closed): the
 * same 1 MiB cap and validation as core's loader.
 */
async function overrideRefusal(file: string): Promise<string> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(file);
  } catch {
    return 'MODEL_REGISTRY_UNREADABLE';
  }
  if (bytes.byteLength > 1024 * 1024) return 'MODEL_REGISTRY_TOO_LARGE';
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return 'MODEL_REGISTRY_NOT_JSON';
  }
  return validateModelRegistry(value).ok ? 'MODEL_REGISTRY_UNREADABLE' : 'MODEL_REGISTRY_INVALID';
}

/** provider.consent.status from a sidecar that is already running; null when none is. */
async function askRunningSidecar(home: string): Promise<unknown> {
  const sidecar = await import('@jevris/sidecar');
  const probe = await sidecar.probeSidecar(home, 500);
  if (!probe.running) return null;
  const res = await sidecar.sidecarRequest({ home, op: 'provider.consent.status', scope: 'cli', body: {}, timeoutMs: 5000 });
  return res.ok ? res.result : null;
}

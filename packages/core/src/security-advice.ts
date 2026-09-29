/**
 * Security advice: prompt-injection suspicion (C51, GOV-12) and permission-risk triage (C49,
 * GOV-13). SSOT §12.7, §16.1, ADR-06, US25, W06.
 *
 * Both are supplementary defence. Neither can grant, approve or relax anything:
 * - Every result carries `grants: []` and `restrictionsApply: true`. Native and host permissions
 *   stay authoritative, and capability restrictions apply whatever the flag says.
 * - Untrusted text is never sent to Jev. The detector runs locally on the text. A Jev question,
 *   when there is an engine, carries only content-free features (signal families, source kinds,
 *   effect classes and counts), so an injected sentence cannot reach the provider or steer it.
 * - Jev can only raise a result: a positive Noul adds a suspicion flag and a high Score raises
 *   the triage level. A negative or missing answer never lowers what the rules found.
 *
 * C51 normalises each untrusted span before matching: NFKC (full-width forms), a confusables
 * fold (Cyrillic and Greek look-alikes), removal of invisible and bidirectional controls
 * (their presence is itself a signal), and whitespace and case folding. It then looks for signal
 * families: instructions to override, text addressed to an AI agent, claims of authority or
 * consent, exfiltration of credentials, destructive commands, concealment, and hidden text. A
 * span is flagged on an override instruction (in any of nine languages), or on two other
 * families together. The adversarial corpus (fixtures/security/injection-corpus.json) covers
 * paraphrases, multilingual text, confusables, text in logs, dependency metadata, fetched docs
 * and skill descriptions, with benign look-alikes.
 *
 * C49 classifies a proposed tool effect (credential access, network egress, destructive or
 * privileged commands, package installation, writes outside the approved scope) and suggests
 * caution or extra review. Untrusted-content indicators (a C51 flag on the text that led to the
 * proposal) raise the level.
 */
import type { JevQuestions } from '@jevris/contracts';
import type { DecisionEngine } from './decision-engine.js';
import { askBoundedDecision, noulAnswer, scoreAnswer, withinWriteScopes, type IntentContext } from './intent-decisions.js';

export const UNTRUSTED_SOURCE_KINDS = ['file', 'log', 'dependency-metadata', 'fetched-doc', 'skill-description', 'tool-output', 'issue'] as const;
export type UntrustedSourceKind = (typeof UNTRUSTED_SOURCE_KINDS)[number];

export const INJECTION_SIGNALS = ['override-instructions', 'agent-addressed', 'authority-claim', 'exfiltration', 'destructive', 'concealment', 'hidden-text'] as const;
export type InjectionSignal = (typeof INJECTION_SIGNALS)[number];

export interface UntrustedSpan {
  readonly id: string;
  readonly sourceKind: UntrustedSourceKind;
  readonly text: string;
}

export interface SpanSuspicion {
  readonly id: string;
  readonly sourceKind: UntrustedSourceKind;
  readonly flagged: boolean;
  readonly signals: readonly InjectionSignal[];
}

export interface InjectionSuspicion {
  /** True when the rules or Jev flag any span. Supplementary: it never changes permissions. */
  readonly flagged: boolean;
  /** The rules' verdict alone (deterministic; what a hook may show). */
  readonly rulesFlagged: boolean;
  /** Jev's Noul on the content-free features; null when not asked or it abstained. */
  readonly jevFlagged: boolean | null;
  readonly spans: readonly SpanSuspicion[];
  readonly grants: readonly [];
  readonly restrictionsApply: true;
  readonly authority: 'none';
  readonly decisionId: string | null;
  readonly reasonCode: string;
}

const MAX_SPANS = 64;
const MAX_SPAN_CHARS = 20_000;

/** Look-alike letters folded to Latin (Cyrillic and Greek homoglyphs). */
const CONFUSABLES: Readonly<Record<string, string>> = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ɡ: 'g', ո: 'n', ս: 'u',
  α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ϲ: 'c',
};
const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠎​-‏‪-‮⁠-⁤⁦-⁯︀-️﻿]/gu;

/** The matching form of a span, and whether it hid characters. */
export function normalizeUntrusted(text: string): { readonly text: string; readonly hidden: boolean } {
  const bounded = text.length > MAX_SPAN_CHARS ? text.slice(0, MAX_SPAN_CHARS) : text;
  const hidden = INVISIBLE.test(bounded);
  INVISIBLE.lastIndex = 0;
  const visible = bounded.replace(INVISIBLE, '').normalize('NFKC').toLowerCase();
  // Fold look-alikes only inside a word that mixes them with Latin letters, so genuine Cyrillic
  // or Greek text keeps its script (and its own patterns).
  const folded = visible.replace(/[\p{L}\p{N}]+/gu, (word) => {
    if (!/[a-z]/.test(word) || ![...word].some((ch) => CONFUSABLES[ch] !== undefined)) return word;
    let out = '';
    for (const ch of word) out += CONFUSABLES[ch] ?? ch;
    return out;
  });
  // Leetspeak (1gn0re, pr3vious, t0ken) and separators inserted between letters.
  const LEET: Readonly<Record<string, string>> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't' };
  const deleet = folded.replace(/\b[a-z0-9]*[a-z][a-z0-9]*\b/g, (word) => (/[013457]/.test(word) && /[a-z]{2}/.test(word) ? word.replace(/[013457]/g, (d) => LEET[d] ?? d) : word));
  const joined = deleet.replace(/\b(?:[a-z][.\-_*]){3,}[a-z]\b/g, (m) => m.replace(/[.\-_*]/g, ''));
  return { text: joined.replace(/\s+/g, ' '), hidden };
}

const PRIOR = "(?:all |any |the |your |these |those |my )?(?:previous|prior|above|earlier|preceding|former|original|existing|system|developer|current|initial|old|user'?s?|human'?s?|developer'?s?|operator'?s?)";
const RULES = '(?:instructions?|directions?|rules|guidance|guidelines|directives|prompts?|orders|constraints|context|system prompt|policies)';

const SIGNAL_PATTERNS: Readonly<Record<InjectionSignal, readonly RegExp[]>> = {
  'override-instructions': [
    new RegExp(`\\b(?:ignor\\w*|disregard\\w*|forget\\w*|forgot|overrid\\w*|overrul\\w*|bypass\\w*|skip|drop|abandon|discard|set aside|pay no (?:attention|heed) to|do not follow|don't follow|stop following|no longer follow)\\b[^.\\n]{0,40}?\\b${PRIOR}\\b[^.\\n]{0,20}?\\b${RULES}\\b`),
    new RegExp(`\\b(?:ignore|disregard|forget|override)\\b (?:all|everything|anything) (?:you (?:were|have been) (?:told|given|instructed)|(?:said|written) (?:above|before))`),
    /\b(?:new|updated|real|actual|true|revised) (?:instructions?|task|objective|directive|orders)\b\s*(?:are|is|:|follow)/,
    /\bfrom now on,? (?:you|your|the assistant|the agent)\b/,
    /\byou are (?:now|no longer)\b[^.\n]{0,40}\b(?:assistant|agent|ai|model|bound|restricted|limited)\b/,
    /\b(?:instead|rather),? (?:of (?:the task|what you were asked)|your (?:real|actual|true) task is)\b/,
    /\b(?:the (?:user|human|developer)'?s? (?:request|task) (?:is|was) (?:fake|a test|irrelevant|cancelled))\b/,
    // Multilingual override phrasings.
    /\bignora(?:r)? (?:todas |las |tus )*(?:las )?instrucciones (?:anteriores|previas)\b/, // es
    /\b(?:ignorez|ignore|oubliez) (?:toutes )?(?:les |vos )?(?:instructions|consignes) (?:précédentes|precedentes|antérieures|anterieures)\b/, // fr
    /\b(?:ignoriere|ignorieren sie|vergiss|vergessen sie) (?:alle )?(?:vorherigen|bisherigen|vorigen|obigen) (?:anweisungen|instruktionen|befehle)\b/, // de
    /\bignor(?:e|a|ar) (?:todas )?as instruç(?:ões|oes) anteriores\b/, // pt
    /\bignora (?:tutte )?le istruzioni precedenti\b/, // it
    /(?:忽略|无视|忽视|不要理会)(?:之前|以上|先前|上面|前面)?(?:的)?(?:所有|全部)?(?:指令|指示|说明|规则)/, // zh
    /(?:以前|これまで|上記|前)の(?:指示|命令|ルール)を(?:すべて)?無視/, // ja
    /(?:игнорируй|игнорируйте|забудь|забудьте)(?: все)? (?:предыдущие|прежние|прошлые) (?:инструкции|указания|правила)/, // ru
    /이전(?:의)? (?:모든 )?(?:지시|지침|명령)(?:를|을|사항을)? (?:모두 )?무시/, // ko
  ],
  'agent-addressed': [
    /\b(?:ai|llm|language model|coding) (?:assistant|agent|model)s?\b\s*[:,]/,
    /\b(?:dear|attention|note (?:to|for)|message (?:to|for)|hey|hello) (?:the )?(?:ai|assistant|agent|claude|copilot|codex|llm|bot|model)\b/,
    /^\s*(?:system|assistant)\s*:/m,
    /<\/?(?:system|instructions?|im_start|admin)>|\[\/?inst\]|###\s*(?:instruction|system)|<\|(?:system|im_start)\|>/,
    /\bif you are an? (?:ai|llm|language model|assistant|agent|automated tool)\b/,
    /\b(?:ai|llm|agent|assistant|model)s?(?: (?:assistant|agent|model|crawler)s?)? (?:reading|processing|summari[sz]ing|viewing|crawling|indexing|installing) (?:this|these)\b/,
  ],
  'authority-claim': [
    /\b(?:the )?(?:admin|administrator|owner|maintainer|user|developer|security team|ciso|manager|operator|your (?:user|operator|developer))s? (?:has |have )?(?:already )?(?:approved|authori[sz]ed|allowed|permitted|consented|signed off|granted)\b/,
    /\byou (?:have|are given|now have|are granted) (?:full |explicit |my )?(?:permission|authori[sz]ation|consent|clearance)\b/,
    /\b(?:pre-?approved|already approved|approval (?:is|was) (?:granted|given)|no (?:need|approval) (?:to|required) (?:ask|confirm))\b/,
    /\b(?:this is|i am) (?:an? )?(?:authori[sz]ed|official|sanctioned) (?:request|instruction|admin)\b/,
  ],
  exfiltration: [
    /\b(?:upload|send|post|transmit|exfiltrate|leak|forward|email|paste|copy|share|curl|wget|scp|rsync|nc|netcat)\b[^\n]{0,80}?(?:credentials?|secrets?|tokens?|api[ _-]?keys?|passwords?|private keys?|\.ssh|\.aws|\.env\b|id_rsa|id_ed25519|keychain|\.npmrc|\.netrc|\.pypirc|kubeconfig|cookies?|session)/,
    /(?:~|\$home|%userprofile%)\/?\.(?:ssh|aws|gnupg|docker|kube|config\/gh)\b/,
    /\b(?:cat|type|read|print|dump|base64)\b[^\n]{0,40}(?:\.env\b|id_rsa|\.aws\/credentials|\.ssh\/|\.npmrc|\.netrc)/,
    /\b(?:env|printenv|set)\b[^\n]{0,20}\|\s*(?:curl|nc|wget)\b/,
  ],
  destructive: [
    /\brm\s+-(?:rf|fr|r\s+-f)\b\s*(?:\/|~|\$home|\*|\.\s*$)/,
    /\bgit push (?:-f|--force)\b|\bgit reset --hard\b[^\n]*\borigin\b/,
    /\b(?:drop (?:table|database)|truncate table|delete from \w+\s*;)/,
    /\b(?:disable|turn off|remove|bypass|skip)\b[^\n]{0,20}\b(?:tests?|security|hooks?|sandbox|firewall|antivirus|verification|checks|ci|safety|guardrails?)\b/,
    /\b(?:chmod\s+(?:-r\s+)?777|mkfs|dd if=|:\(\)\s*\{\s*:\|:&\s*\};:)/,
  ],
  concealment: [
    /\b(?:do not|don't|never) (?:tell|mention|inform|reveal|report|show|alert|notify|log)\b[^.\n]{0,30}\b(?:user|human|developer|anyone|owner|this)\b/,
    /\bwithout (?:telling|asking|informing|notifying|alerting) (?:the )?(?:user|human|developer|anyone|owner)\b/,
    /\b(?:silently|secretly|quietly|covertly|discreetly)\b[^.\n]{0,40}\b(?:run|execute|send|upload|delete|install|change|modify|add)\b/,
    /\b(?:hide|conceal) (?:this|these|the) (?:step|action|change|command)s?\b/,
  ],
  'hidden-text': [],
};

/** The signal families in one span (content-free). */
export function injectionSignals(text: string): InjectionSignal[] {
  const normalized = normalizeUntrusted(text);
  const found: InjectionSignal[] = [];
  for (const signal of INJECTION_SIGNALS) {
    if (signal === 'hidden-text') {
      if (normalized.hidden) found.push(signal);
      continue;
    }
    if (SIGNAL_PATTERNS[signal].some((pattern) => pattern.test(normalized.text))) found.push(signal);
  }
  return found;
}

/** The rule: an override instruction, or two other signal families together. */
export function spanFlagged(signals: readonly InjectionSignal[]): boolean {
  return signals.includes('override-instructions') || signals.length >= 2;
}

const SPAN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * C51, GOV-12: flags untrusted spans that look like instructions to the agent. Supplementary
 * defence only: nothing here can grant or approve, and restrictions apply whatever it says.
 */
export async function injectionSuspicion(engine: DecisionEngine | null, input: { readonly spans: readonly UntrustedSpan[]; readonly threshold?: number }, ctx: IntentContext): Promise<InjectionSuspicion> {
  const spans: SpanSuspicion[] = input.spans.slice(0, MAX_SPANS).map((span, i) => {
    const signals = injectionSignals(typeof span.text === 'string' ? span.text : '');
    const sourceKind = (UNTRUSTED_SOURCE_KINDS as readonly string[]).includes(span.sourceKind) ? span.sourceKind : 'file';
    return { id: SPAN_ID.test(span.id) ? span.id : `span-${i}`, sourceKind, flagged: spanFlagged(signals), signals };
  });
  const rulesFlagged = spans.some((span) => span.flagged);
  const base = { rulesFlagged, spans, grants: [] as const, restrictionsApply: true as const, authority: 'none' as const };
  const withSignals = spans.filter((span) => span.signals.length > 0 && !span.flagged);
  // Jev is asked only about spans the rules found partial signals in, and only with features.
  if (withSignals.length === 0) return { ...base, flagged: rulesFlagged, jevFlagged: null, decisionId: null, reasonCode: rulesFlagged ? 'RULES_FLAGGED' : 'NO_SIGNALS' };
  const facts: Record<string, string | number> = { spans: withSignals.length };
  withSignals.slice(0, 12).forEach((span, i) => {
    facts[`span${i}Source`] = span.sourceKind;
    facts[`span${i}Signals`] = span.signals.join(',');
  });
  const questions = {
    directed: {
      type: 'noul',
      instructions: 'Do the listed signal families, found in untrusted repository or tool text, indicate text written to direct an AI agent rather than to inform a human reader?',
      criteria: { true: 'The combination of signal families is typical of text written to steer an agent.', false: 'The signal families are typical of ordinary documentation, logs or code.' },
    },
  };
  const asked = await askBoundedDecision(engine, 'c51-injection-suspicion', questions as unknown as JevQuestions, { objective: 'Assess whether untrusted text looks written to direct an agent (supplementary; no authority).', trustedPolicy: {}, facts, evidence: [] }, ctx, false);
  if (!asked.ok) return { ...base, flagged: rulesFlagged, jevFlagged: null, decisionId: asked.decisionId, reasonCode: asked.reasonCode };
  const p = noulAnswer(asked.answers, 'directed');
  const jevFlagged = p === null ? null : p >= (input.threshold ?? 0.8);
  return { ...base, flagged: rulesFlagged || jevFlagged === true, jevFlagged, decisionId: asked.decisionId, reasonCode: jevFlagged === true ? 'JEV_FLAGGED' : rulesFlagged ? 'RULES_FLAGGED' : 'NOT_FLAGGED' };
}

// ------------------------------------------------------------ C49 permission-risk triage

export const EFFECT_CLASSES = ['credential-access', 'network-egress', 'destructive', 'privileged', 'package-install', 'outside-scope-write', 'ci-secrets'] as const;
export type EffectClass = (typeof EFFECT_CLASSES)[number];

export const TRIAGE_LEVELS = ['none', 'caution', 'review'] as const;
export type TriageLevel = (typeof TRIAGE_LEVELS)[number];

export interface ProposedEffect {
  /** The harness tool (Bash, Write, Edit, WebFetch...). */
  readonly tool: string;
  readonly command?: string;
  /** Paths the effect reads or writes, relative to the workspace root. */
  readonly paths?: readonly string[];
  readonly writes?: boolean;
  /** Hosts the effect contacts. */
  readonly hosts?: readonly string[];
}

export interface PolicyScope {
  /** The task's write scopes (INT-05 `withinWriteScopes`); empty means no write is approved. */
  readonly writeScopes: readonly string[];
  /** Hosts the workspace policy lets tools contact. */
  readonly allowedHosts: readonly string[];
}

export interface PermissionTriage {
  readonly level: TriageLevel;
  /** The rules' level alone. */
  readonly rulesLevel: TriageLevel;
  readonly classes: readonly EffectClass[];
  readonly reasons: readonly string[];
  readonly untrustedInfluence: boolean;
  /** Jev's Score (0-4, the rubric anchor) on the content-free facts; null when not asked or it abstained. */
  readonly jevScore: number | null;
  /** Never anything: Jevris does not grant access. Native and host permissions decide. */
  readonly grants: readonly [];
  readonly restrictionsApply: true;
  readonly nativePermissionsAuthoritative: true;
  readonly decisionId: string | null;
  readonly reasonCode: string;
}

const CREDENTIAL_PATH = /(?:^|[\\/])(?:\.ssh|\.aws|\.gnupg|\.kube|\.docker)(?:[\\/]|$)|(?:^|[\\/])(?:\.env(?:\.[\w-]+)?|id_rsa|id_ed25519|\.npmrc|\.netrc|\.pypirc|credentials(?:\.json)?|kubeconfig|[\w-]*\.pem|[\w-]*\.key)$|keychain/i;
const NETWORK = /\b(?:curl|wget|scp|rsync|ssh|sftp|ftp|nc|ncat|netcat|telnet|invoke-webrequest|iwr|http(?:ie)?)\b/i;
const DESTRUCTIVE = /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r|\bgit\s+push\s+(?:-f|--force)|\bgit\s+reset\s+--hard|\bgit\s+clean\s+-[a-z]*f|\b(?:drop|truncate)\s+(?:table|database)|\bmkfs\b|\bdd\s+if=|\bremove-item\b[^\n]*-recurse|\bdel\s+\/[sq]/i;
const PRIVILEGED = /\bsudo\b|\bdoas\b|\bsu\s+-|\bchmod\s+(?:-r\s+)?(?:777|[0-7]?[0-7]7[0-7])|\bchown\b|\bsetfacl\b|\bset-executionpolicy\b|\breg\s+add\b|\blaunchctl\b|\bsystemctl\b/i;
const INSTALL = /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add)\b|\bpip3?\s+install\b|\bgem\s+install\b|\bcargo\s+install\b|\bgo\s+install\b|\bbrew\s+install\b|\bapt(?:-get)?\s+install\b|\bcurl\b[^|\n]*\|\s*(?:ba|z)?sh\b|\biex\b|\binvoke-expression\b/i;
const CI_SECRETS = /\bsecrets\.[A-Za-z_]+|\bgh\s+secret\b|\bGITHUB_TOKEN\b|\bNPM_TOKEN\b|\bACTIONS_RUNTIME_TOKEN\b/;
const HOST_IN_COMMAND = /\bhttps?:\/\/([a-z0-9.-]+)/gi;

function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((a) => {
    const rule = a.toLowerCase();
    return rule.startsWith('*.') ? h.endsWith(rule.slice(1)) && h.length > rule.length - 1 : h === rule;
  });
}

/** The deterministic effect classes of one proposal. */
export function effectClasses(effect: ProposedEffect, scope: PolicyScope): { readonly classes: EffectClass[]; readonly reasons: string[] } {
  const classes = new Set<EffectClass>();
  const reasons: string[] = [];
  const command = typeof effect.command === 'string' ? effect.command.slice(0, 8000) : '';
  const paths = (effect.paths ?? []).filter((p) => typeof p === 'string').slice(0, 64);
  const mention = [command, ...paths].join('\n');
  if (paths.some((p) => CREDENTIAL_PATH.test(p)) || /(?:~|\$home|%userprofile%)[\\/]\.(?:ssh|aws|gnupg|kube|docker)\b|\bid_rsa\b|\.aws[\\/]credentials|\b(?:security|secret-tool)\s+find-generic-password\b/i.test(command)) {
    classes.add('credential-access');
    reasons.push('The proposal reads or writes a credential location.');
  }
  const hosts = new Set((effect.hosts ?? []).filter((h) => typeof h === 'string').map((h) => h.toLowerCase()));
  for (const match of command.matchAll(HOST_IN_COMMAND)) if (match[1] !== undefined) hosts.add(match[1].toLowerCase());
  const outside = [...hosts].filter((h) => !hostAllowed(h, scope.allowedHosts));
  if ((NETWORK.test(command) || effect.tool === 'WebFetch' || hosts.size > 0) && (outside.length > 0 || (hosts.size === 0 && NETWORK.test(command)))) {
    classes.add('network-egress');
    reasons.push(outside.length > 0 ? `The proposal contacts ${outside.length} host(s) outside the workspace policy.` : 'The proposal opens a network connection to an unnamed host.');
  }
  if (DESTRUCTIVE.test(command)) {
    classes.add('destructive');
    reasons.push('The command deletes or rewrites data that is hard to recover.');
  }
  if (PRIVILEGED.test(command)) {
    classes.add('privileged');
    reasons.push('The command changes privileges or system configuration.');
  }
  if (INSTALL.test(command)) {
    classes.add('package-install');
    reasons.push('The command installs or runs third-party code.');
  }
  if (CI_SECRETS.test(mention)) {
    classes.add('ci-secrets');
    reasons.push('The proposal touches CI secrets.');
  }
  if (effect.writes === true && paths.some((p) => !withinWriteScopes(p.replace(/\\/g, '/'), scope.writeScopes))) {
    classes.add('outside-scope-write');
    reasons.push('The proposal writes outside the task’s approved scope.');
  }
  return { classes: EFFECT_CLASSES.filter((c) => classes.has(c)), reasons };
}

const REVIEW_CLASSES: ReadonlySet<EffectClass> = new Set(['credential-access', 'destructive', 'privileged', 'ci-secrets']);

function rank(level: TriageLevel): number {
  return TRIAGE_LEVELS.indexOf(level);
}

function atLeast(a: TriageLevel, b: TriageLevel): TriageLevel {
  return rank(a) >= rank(b) ? a : b;
}

export const PERMISSION_RISK_RUBRIC = [
  'Routine: the listed effect classes carry no meaningful risk.',
  'Low: worth noting, no extra review.',
  'Moderate: the combination deserves caution before approving.',
  'High: a person should review the proposal before approving it.',
  'Severe: the combination matches a known attack pattern; review before any approval.',
] as const;

/**
 * C49, GOV-13: suggests caution or extra review for a proposed tool effect. It never grants: the
 * harness's native permission prompt and the host policy decide, and `grants` is always empty.
 */
export async function permissionRiskTriage(
  engine: DecisionEngine | null,
  input: { readonly effect: ProposedEffect; readonly scope: PolicyScope; readonly untrusted?: Pick<InjectionSuspicion, 'flagged' | 'spans'> | null },
  ctx: IntentContext,
): Promise<PermissionTriage> {
  const { classes, reasons } = effectClasses(input.effect, input.scope);
  const untrustedInfluence = input.untrusted?.flagged === true;
  let rulesLevel: TriageLevel = classes.length === 0 ? 'none' : classes.some((c) => REVIEW_CLASSES.has(c)) ? 'review' : 'caution';
  if (untrustedInfluence) {
    // Text that looked like an injection preceded the proposal: any sensitive effect gets review.
    rulesLevel = classes.length > 0 ? 'review' : atLeast(rulesLevel, 'caution');
    reasons.push('Untrusted text that looked like an instruction to the agent came before this proposal.');
  }
  const base = { rulesLevel, classes, reasons, untrustedInfluence, grants: [] as const, restrictionsApply: true as const, nativePermissionsAuthoritative: true as const };
  if (classes.length === 0 && !untrustedInfluence) return { ...base, level: rulesLevel, jevScore: null, decisionId: null, reasonCode: 'NO_RISK_SIGNALS' };
  const facts: Record<string, string | number | boolean> = { tool: /^[A-Za-z0-9_.-]{1,64}$/.test(input.effect.tool) ? input.effect.tool : 'other', classes: classes.join(',') || 'none', untrustedInfluence, paths: (input.effect.paths ?? []).length, hosts: (input.effect.hosts ?? []).length };
  const questions = { risk: { type: 'score', instructions: 'How risky is a tool proposal with the listed effect classes and untrusted-influence flag, before any person approves it?', criteria: [...PERMISSION_RISK_RUBRIC] } };
  const asked = await askBoundedDecision(engine, 'c49-permission-triage', questions as unknown as JevQuestions, { objective: 'Suggest caution or review for a proposed tool effect (advice only; grants nothing).', trustedPolicy: {}, facts, evidence: [] }, ctx, false);
  if (!asked.ok) return { ...base, level: rulesLevel, jevScore: null, decisionId: asked.decisionId, reasonCode: asked.reasonCode };
  const score = scoreAnswer(asked.answers, 'risk')?.score ?? null;
  // Jev can only raise the level: anchors 3-4 (high, severe) are review, 2 (moderate) is caution;
  // lower scores change nothing.
  const jevLevel: TriageLevel = score === null ? 'none' : score >= 3 ? 'review' : score >= 2 ? 'caution' : 'none';
  const level = atLeast(rulesLevel, jevLevel);
  return { ...base, level, jevScore: score, decisionId: asked.decisionId, reasonCode: level !== rulesLevel ? 'JEV_RAISED' : 'RULES_LEVEL' };
}

/**
 * The consent text for each model provider (owner decisions DOMAINS 7be3c43 and OD-4; routing
 * design R30). `jevris consent provider <id> --grant` shows a provider's training term and storage
 * location, then the sidecar stores a grant for this text's `version` only (B's
 * `provider.consent.grant`). When a text changes, its version changes, a stored grant reads as
 * stale and the person is asked again.
 *
 * - Every fact is dated and quoted from the provider's own public terms, as re-read for the SPEC
 *   8.1 registry review (`.planning/research/v1.2-spec-8.1-registry-review.md`, 2026-09-27).
 * - `alwaysRequired`: the provider's terms failed the review's egress bar (training on content by
 *   default), so a model from it is never routed, suggested or launched without a grant, even
 *   when the user is signed in to it (Moonshot and DeepSeek). Any other provider here passed the
 *   review and is allowed by default while the user is signed in to it on an installed harness;
 *   otherwise it needs the same grant.
 * - A provider with no entry cannot be granted, and reads as not consented.
 */

export interface ProviderConsentText {
  /** Changes whenever the text below changes; a grant counts only for the version it names. */
  readonly version: string;
  readonly name: string;
  /** Whether and how the provider may train on what it receives. */
  readonly training: string;
  /** Where the provider stores what it receives, and for how long when the terms say. */
  readonly storage: string;
  /** The dated public terms the text rests on. */
  readonly source: string;
  readonly alwaysRequired: boolean;
}

const READ = 're-read 2026-09-27';

/**
 * A party's consent state as the CLI and the route answer say it: granted; revoked; required (no
 * grant, and the signed-in default does not apply); allowed by the OD-4 signed-in default;
 * blocked (a host whose forwarding target is revoked or required, B's MEDIUM 19); no-text (a
 * pinned host with no consent text, never routed: CONSENT_TEXT_MISSING).
 */
export const PROVIDER_CONSENT_STATES = ['granted', 'revoked', 'required', 'signed-in-default', 'blocked', 'no-text'] as const;
export type ProviderConsentState = (typeof PROVIDER_CONSENT_STATES)[number];

export const PROVIDER_CONSENT_TEXT: { readonly [provider: string]: ProviderConsentText } = Object.freeze({
  // Owner decision c065d52: Anthropic can be granted explicitly; it is not in the always-required set.
  anthropic: Object.freeze({
    version: 'anthropic-2026-09-27',
    name: 'Anthropic (Claude)',
    training: 'On the Claude API, "Retained data is never used for model training without your express permission." With a Claude subscription sign-in, Anthropic\'s consumer terms apply instead.',
    storage: 'On the Claude API, "Conversation content (your prompts and Claude\'s outputs) is not retained by default", except for models that "require 30-day retention"; a session flagged by its trust and safety systems may be kept "for up to 2 years". The page names no storage region.',
    source: 'Claude API and data retention documentation (https://platform.claude.com/docs/en/manage-claude/api-and-data-retention), read 2026-09-27.',
    alwaysRequired: false,
  }),
  deepseek: Object.freeze({
    version: 'deepseek-2026-09-27',
    name: 'DeepSeek',
    training: 'Trains on what you send by default: DeepSeek uses inputs "to train and improve our technology, such as our machine learning models". You can opt out in your DeepSeek account.',
    storage: 'People\'s Republic of China: "we directly collect, process and store your Personal Data in People\'s Republic of China".',
    source: `DeepSeek privacy policy, last updated 2026-02-10 (https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html), ${READ}.`,
    alwaysRequired: true,
  }),
  moonshot: Object.freeze({
    // Serving hosts R40: the China endpoint (moonshotai-cn) has its own agreement and storage, so the text names both.
    version: 'moonshot-2026-09-28',
    name: 'Moonshot AI (Kimi)',
    training: 'May use what you send to improve its services. International platform: "We may use Content to provide, maintain, develop, support, and improve the Services"; only an enterprise agreement restricts that use. China endpoint (moonshotai-cn): by default you grant a free right to use your inputs, outputs and feedback for model-service optimisation ("您授予我们一项免费的使用权，以在法律允许的范围内将您输入输出之内容及反馈用于模型服务优化。").',
    storage: 'International platform: Singapore, "secure servers located in Singapore". China endpoint (moonshotai-cn): mainland China, "我们将您的个人信息存储于中华人民共和国境内。", under PRC law.',
    source: 'Kimi OpenPlatform privacy policy, last updated 2025-04-30 (https://platform.kimi.ai/docs/agreement/userprivacy), and terms, last updated 2026-07-30, re-read 2026-09-27; the China platform agreement, effective 2026-08-31, and privacy policy (platform.moonshot.cn, now platform.kimi.com), read 2026-09-28.',
    alwaysRequired: true,
  }),
  openai: Object.freeze({
    version: 'openai-2026-09-27',
    name: 'OpenAI',
    training: 'With an API key, "data sent to the OpenAI API is not used to train or improve OpenAI models (unless you explicitly opt in)". With a ChatGPT sign-in, your ChatGPT workspace settings apply instead.',
    storage: 'Abuse-monitoring logs are "retained for up to 30 days"; the Responses API keeps application state for 30 days by default. Regional processing exists in the US, the EEA plus Switzerland, and the UAE.',
    source: `OpenAI, your data (https://developers.openai.com/api/docs/guides/your-data) and Codex auth (https://learn.chatgpt.com/docs/auth), ${READ}.`,
    alwaysRequired: false,
  }),
  google: Object.freeze({
    // Serving hosts R40: Vertex AI (google-vertex) runs under Google Cloud's terms, not the Gemini API terms.
    version: 'google-2026-09-28',
    name: 'Google (Gemini)',
    training: 'On a paid Gemini API key, "Google doesn\'t use your prompts ... or responses to improve our products". On an unpaid key outside the EEA, Switzerland and the UK, Google uses what you send to improve its products and machine learning, and human reviewers may read it. Jevris cannot tell a paid key from an unpaid one. Under an Antigravity sign-in, data collection is on until you turn it off in Settings. On Vertex AI (google-vertex), "Google will not use Customer Data to train or fine-tune any AI/ML models without Customer\'s prior permission or instruction."',
    storage: 'Google logs prompts and responses "for a limited period of time, solely for detecting and preventing violations" on the paid Gemini API tier. On Vertex AI, Gemini models "cache Customer Data (inputs, outputs, and derived data) in-memory" with "a 24-hour TTL" by default, and Google may log prompts to detect abuse.',
    source: 'Gemini API additional terms, last updated 2026-04-28 (https://ai.google.dev/gemini-api/terms), and the Antigravity FAQ (https://antigravity.google/docs/faq/), re-read 2026-09-27; Google Cloud Service Specific Terms, last modified 2026-09-24, and the Vertex AI zero data retention page, last updated 2026-09-25, read 2026-09-28.',
    alwaysRequired: false,
  }),
  xai: Object.freeze({
    version: 'xai-2026-09-27',
    name: 'xAI (Grok)',
    training: 'With an API key, "xAI does not train on this data". With a SuperGrok sign-in, the consumer terms apply, and you "select whether or not" your content trains models.',
    storage: 'With an API key, "all API requests and responses are stored on our servers (encrypted at rest) for 30 days".',
    source: `xAI API documentation (https://docs.x.ai/developers/models) and consumer terms, ${READ}.`,
    alwaysRequired: false,
  }),
  zai: Object.freeze({
    version: 'zai-2026-09-27',
    name: 'Z.ai (GLM)',
    training: 'The policy says Z.ai keeps none of what you send: "The Company do not store any of the content the Customer or its End Users provide or generate while using our Services". It names no separate training term.',
    storage: 'Not stored; the service runs "generally" from Singapore.',
    source: `Z.ai privacy policy, last updated 2025-09-29 (https://docs.z.ai/legal-agreement/privacy-policy), ${READ}.`,
    alwaysRequired: false,
  }),
});

/**
 * A serving host's consent text (serving-hosts design 5.3, R40): the same terms as a maker's, plus
 * who else receives what you send. A route through a host needs the host's consent and the maker's.
 */
export interface ServingHostConsentText extends ProviderConsentText {
  /** Who the host passes what you send to, and whose terms then apply. */
  readonly forwarding: string;
}

const READ_HOSTS = 'read 2026-09-28';

/**
 * The pinned serving hosts' consent texts (R40; owner decision c8e933d, OQ-3). OpenRouter and the
 * Kilo Gateway get the OD-4 signed-in default (`alwaysRequired: false`, the owner's choice); their
 * texts say plainly that the downstream provider may train on what you send by default. The maker's
 * own consent is still needed, and Moonshot and DeepSeek stay always-required whichever host serves
 * them. NVIDIA has no text (OQ-2): its trial terms allow evaluation use only, forbid confidential
 * information and use content to improve its models, so it cannot be granted and is never routed to.
 * The keys are disjoint from `PROVIDER_CONSENT_TEXT` (a test pins it; B's store reads an id in
 * both maps as having no text).
 */
export const SERVING_HOST_CONSENT_TEXT: { readonly [host: string]: ServingHostConsentText } = Object.freeze({
  openrouter: Object.freeze({
    version: 'openrouter-2026-09-28',
    name: 'OpenRouter (gateway)',
    training: 'OpenRouter itself says "OpenRouter does not use your Inputs or Outputs for model training", but it passes each request to a downstream provider, and "Some Model Providers may use your Inputs and Outputs for model training or improvement". By default (data_collection "allow") OpenRouter may route to providers "which store user data non-transiently and may train on it"; you can turn that off in your OpenRouter privacy settings. Jevris cannot see that setting, so assume the downstream provider may train on what you send.',
    storage: '"OpenRouter does not store your prompts or responses, unless you opt in"; opt-in logs are "retained for a minimum of 3 months", and opting in grants OpenRouter a "worldwide, perpetual, irrevocable" licence. Your personal data "may be transferred to our servers in the US". Downstream providers "may, depending on their own terms and data practices, retain and use your Inputs and Outputs for their own purposes, such as model training and improvement."',
    forwarding: 'Each request goes to a provider OpenRouter selects for the model, under that provider\'s own terms; for Kimi K3 it listed 18 endpoints from 16 providers on 2026-09-28, including Moonshot AI, Together, Fireworks, DeepInfra, Chutes and Alibaba.',
    source: `OpenRouter privacy policy and terms, both last updated 2026-08-31 (https://openrouter.ai/privacy, https://openrouter.ai/terms), and its provider selection, data collection, input and output logging and endpoint docs, ${READ_HOSTS}.`,
    alwaysRequired: false,
  }),
  kilo: Object.freeze({
    version: 'kilo-2026-09-28',
    name: 'Kilo Gateway',
    training: 'Kilo says "Kilo does not use your code or prompts to train models or retain them for its own purposes", but its terms grant Kilo "a perpetual, irrevocable, fully-paid, royalty-free, worldwide, sublicensable, transferable right and license to use such Customer Data to provide and improve the Service and Kilo\'s other products and services", and Customer Data includes source code. The downstream provider that serves the model may train on what you send by default, under its own terms.',
    storage: 'Your personal information is "stored and processed on our servers in the United States". No retention period is stated for gateway traffic. An organisation can set a data collection policy (allow or deny) for its members\' requests.',
    forwarding: 'Kilo routes requests through OpenRouter ("Routing layer that forwards your request to the AI provider you select per request"), so OpenRouter\'s terms and the downstream provider\'s terms apply too. "Auto Free may route your requests to providers that log prompts and outputs and use them to improve their services"; Jevris never routes to Auto Free.',
    source: `Kilo privacy policy, last updated 2026-05-29 (https://kilo.ai/privacy), terms, last updated 2026-01-29 (https://kilo.ai/terms), https://kilo.ai/eu and the gateway and free-use docs, ${READ_HOSTS}.`,
    alwaysRequired: false,
  }),
});

/**
 * The consent text for a party, maker or serving host (R40); undefined when it has none, or when an
 * id has text in both maps (they are pinned disjoint, so that is a defect and reads as no text).
 */
export function consentText(party: string): ProviderConsentText | ServingHostConsentText | undefined {
  const maker = Object.hasOwn(PROVIDER_CONSENT_TEXT, party) ? PROVIDER_CONSENT_TEXT[party] : undefined;
  const host = Object.hasOwn(SERVING_HOST_CONSENT_TEXT, party) ? SERVING_HOST_CONSENT_TEXT[party] : undefined;
  if (maker !== undefined && host !== undefined) return undefined;
  return maker ?? host;
}

/** The phrase a person types to grant consent to one provider. */
export function providerConsentPhrase(provider: string): string {
  return `consent to ${provider}`;
}

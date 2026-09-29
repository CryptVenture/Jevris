/**
 * The `route.turn` answer (owner decisions OD-8 and f294e43; routing design, with C): whether a
 * Kilo or OpenCode main-session turn is switched to another model. The plugin asks the sidecar
 * before a turn's `chat.message`; C's engine answers from the route rules; the plugin rewrites
 * the turn's model only when `actuate` is true, and never changes the user's configuration.
 *
 * - `mainSession` is the effective main-session mode for that harness and whether this turn was
 *   switched. Status and explain show the same object per harness, so there is one shape.
 * - Only `plugin-bounded-auto` may actuate a turn: under `advice-only` (and `owned-sdk-approved`,
 *   which is the Claude Agent SDK path) the answer is advice and `actuate` is false.
 * - `switched` equals `actuate`, and an actuated turn names the model it switches to.
 */
import { defineContract, type Contract } from './contract.js';
import { REASON_CODE_PATTERN, SECRET_PATTERNS, text } from './primitives.js';
import * as S from './schema.js';

export const MAIN_SESSION_MODES = ['advice-only', 'plugin-bounded-auto', 'owned-sdk-approved'] as const;
export type MainSessionMode = (typeof MAIN_SESSION_MODES)[number];

/** The harnesses whose main session may be switched per turn (OD-8). */
export const TURN_HARNESSES = ['kilocode', 'opencode'] as const;

export const MainSessionViewSchema = S.object({
  mode: S.enumOf(MAIN_SESSION_MODES),
  switched: S.boolean(),
});
export type MainSessionView = S.Static<typeof MainSessionViewSchema>;

const ProviderIdSchema = S.string({ pattern: '^[a-z0-9][a-z0-9._-]{0,63}$' });
/** A Kilo or OpenCode modelID: one optional gateway segment (openrouter's `anthropic/...`), no `[1m]`. */
const TurnModelIdSchema = S.string({ pattern: '^(?:[a-z0-9][a-z0-9._-]{0,63}/)?[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?::[0-9]{1,8})?$' });

export const RouteTurnPayloadSchema = S.object(
  {
    harness: S.enumOf(TURN_HARNESSES),
    mainSession: MainSessionViewSchema,
    outcome: S.enumOf(['switch', 'abstain'] as const),
    actuate: S.boolean(),
    reasonCode: S.string({ pattern: REASON_CODE_PATTERN, notPatterns: SECRET_PATTERNS }),
    text: text(500),
  },
  {
    model: S.object({ providerID: ProviderIdSchema, modelID: TurnModelIdSchema }),
    variant: S.nullable(S.string({ pattern: '^[a-z][a-z0-9-]{0,31}$' })),
  },
);
export type RouteTurnPayload = S.Static<typeof RouteTurnPayloadSchema>;

export const RouteTurnPayloadContract: Contract<RouteTurnPayload> = defineContract<RouteTurnPayload>({
  name: 'RouteTurnPayload',
  description: 'The route.turn answer: whether one Kilo or OpenCode main-session turn is switched, under the effective main-session mode.',
  schema: RouteTurnPayloadSchema,
  refine: (value, issue) => {
    if (value.mainSession.switched !== value.actuate) issue('/mainSession/switched', 'SWITCHED_NOT_ACTUATE');
    if (value.actuate && value.mainSession.mode !== 'plugin-bounded-auto') issue('/actuate', 'MODE_DOES_NOT_ACTUATE');
    if (value.actuate && value.outcome !== 'switch') issue('/actuate', 'ACTUATE_WITHOUT_SWITCH');
    if (value.outcome === 'switch' && value.model === undefined) issue('/model', 'SWITCH_WITHOUT_MODEL');
    if (value.outcome === 'abstain' && (value.model !== undefined || (value.variant !== undefined && value.variant !== null))) issue('/model', 'ABSTAIN_WITH_MODEL');
  },
});

# Route outcomes

- `keep`: stay on the current model.
- `recommend`: another model fits better; `recommendedModel` names it. The user decides.
- `abstain`: Jevris has no basis for advice (for example no routing data).

Inputs that give a reason: `sliceId` (such as `bounded-edit`), or `task` with `paths` (files to touch), `checkIds` and `title`, so Jevris classifies the slice; and `session.warmPrefixTokens` (the cached prompt prefix, in tokens) to price a switch.

Reason codes you may see:

- `PIN_RESPECTED`: the user pinned a model; the pin always wins.
- `UNKNOWN_SLICE`: no `sliceId` and no `task` was given, so there is nothing to price. Add `sliceId`, or `task` with `paths`, `checkIds` and `title`.
- `TRANSITION_COST_UNKNOWN`: a switch cannot be priced without `session.warmPrefixTokens`.
- `ROUTER_UNAVAILABLE`: no routing data was available, so there is no recommendation.

`applied` is always false: Jevris never changes the model. A worker profile names a model for Jevris-owned workers only.

The `slice` part (present when Jevris classified the task): `sliceId` (null when none was used), `source` (`jev`, `rules` or `none`), `risk`, the reason code and a `decisionId` that `jevris_explain_decision` explains. It is advice only and never a learned prior.

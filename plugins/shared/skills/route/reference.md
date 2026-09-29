# Route outcomes

- `keep`: stay on the current model.
- `recommend`: another model fits better; `recommendedModel` names it. The user decides.
- `abstain`: Jevris has no basis for advice (for example no routing data).

Reason codes you may see:

- `PIN_RESPECTED`: the user pinned a model; the pin always wins.
- `ROUTER_UNAVAILABLE`: no routing data was available, so there is no recommendation.

`applied` is always false: Jevris never changes the model. A worker profile names a model for Jevris-owned workers only.

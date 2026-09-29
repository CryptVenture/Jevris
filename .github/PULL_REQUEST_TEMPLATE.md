## Summary

-

## Documented behaviour

- The behaviour this serves (`docs/` page):
- Deliberately not in this change:

## Test plan

- [ ] `npm run lint` and `npm test` on a supported Node (`^22.14.0 || >=23.6.0`)
- [ ] Docs updated if a command, path, or exit code changed; `npm run build && npm run docs` if a command's help text changed
- [ ] No secrets, source samples, or remote bodies in the diff
- [ ] `npm test` ran without the live opt-ins: `JEVRIS_LIVE_HARNESS` (real harness binaries) and `JEVRIS_LIVE_JEV` (the live Jev API) were not set
- [ ] Any live check that ran is named, with its command (`JEVRIS_LIVE_HARNESS=1 npm run smoke:harness`, `JEVRIS_LIVE_JEV=1 npm run smoke:jev`), or none ran

## Notes

Installed does not mean certified: say whether the change needs a `jevris certify` run on a real harness to be proven.

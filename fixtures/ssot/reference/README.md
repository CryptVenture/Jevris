# Jevris reference TypeScript

This directory is an offline-testable implementation of a **small integration boundary**, not the whole Jevris platform. There is no plugin installer, sidecar, production authorization service, scheduler, real calibration artifact, or live benchmark here.

## Files and use

`contracts.ts` contains proposed harness-neutral domain types. `jev-client.ts` implements a restricted native TypeSafe HTTP client with runtime validation, a fixed endpoint, pinned-model checks, byte limits, cancellation and a total deadline. `policy-guard.ts` is a pure planning check that executes nothing. `tests.mjs` has 57 offline tests with synthetic responses. `official-sdk.example.ts.txt` is a separately labelled, **uncompiled** official-SDK integration sketch. The skill templates show intended user-facing behaviour; they are not a registered plugin.

With Node 22 or later and TypeScript 5.8.3 installed:

```sh
npm test
```

When the compiler is not installed, run `npm install` first. This installs the development dependency; it does not contact Jev. The test run uses mocked HTTP transport and needs no API key. `dist/` contains compiled reference JavaScript and declarations, also included in this handoff. To rerun the already compiled tests without installing a compiler:

```sh
node --test tests.mjs
```

The dependency version is the compiler used for this handoff, not a claim about the latest TypeScript release. The official TypeSafe SDK is deliberately not a dependency of these offline tests. Choose one production transport and run common conformance tests against it; do not maintain two clients without a reason.

## Important limits

The HTTP client accepts fewer input shapes than the full provider API: string instructions/criteria, explicit versioned model IDs, at most 12 questions, at least two Choice options, and two to ten Score levels. These restrictions are proposed Jevris policy. Default request and response limits are 131,072 and 1,048,576 bytes. **Byte limits are not token limits.** Implement a tested token estimator and state-plus-question packing checks before live use.

The probability-sum/Score consistency tolerance is `1e-6`; confirm real serialization precision before enabling actuation. Unknown response metadata is ignored, but unknown answer IDs, question types, option keys and model revisions are rejected. Parsed output is normalized. Free output tokens may still have a nonzero usage count. No confidence field is interpreted as verified task success.

There are no automatic retries in this client. `retryable` classifies an error for a caller-owned policy; it does not authorize another billable call. Provider work may still be billed after cancellation or timeout. A production budget service must reconcile uncertain spend.

Credentials must come from a trusted host secret store. The injectable fetch implementation is for trusted tests/host composition, not an agent-controlled setting. No arbitrary URL is accepted. Error messages omit remote response bodies and transport error text. This is **not** a redaction or consent implementation: authorize and minimize the evidence before calling the client. Bound raw input bytes before parsing external hook/MCP input; a typed JavaScript object is not a security boundary.

`checkIntent` assumes an already schema-validated action and a trusted, current snapshot. Its positive result is **not authorization**. The actuator must independently authenticate the caller, verify capability-to-action binding, recheck resource scope, consume an atomic reservation, compare state revision, and enforce native permissions immediately before any effect. The reference does not perform those steps.

The test suite covers local contracts and failure handling, not current SDK compatibility, live Jev behaviour, gateway equivalence, real Claude hook semantics, security certification or coding quality. The document's P0–P4 release gates remain necessary.

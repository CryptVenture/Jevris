/**
 * The fixed vocabulary of evidence a failure can be missing (C05, evidence sufficiency, and the
 * repeated-failure advice that names the next kind). Each id has one plain phrase for an advice line,
 * written here, so a line never carries text from the failure, the workspace or the person. Jev is not
 * asked which kind comes next (see `failure-advice.ts` in provider-typesafe), so there is no option text.
 */
import type { FailureArtifactId } from '@jevris/contracts';

export const FAILURE_ARTIFACT_TEXT: Readonly<Record<FailureArtifactId, { readonly phrase: string }>> = {
  'failing-test-output': { phrase: 'the failing test output' },
  'stack-trace': { phrase: 'the full stack trace' },
  'config-file': { phrase: 'the configuration file that controls the failing step' },
  'environment-info': { phrase: 'the environment information (tool versions, running services, variables set)' },
  'repro-steps': { phrase: 'the exact steps that reproduce it' },
  'recent-diff': { phrase: 'the diff of the recent changes' },
  logs: { phrase: 'the logs from the failing run' },
};

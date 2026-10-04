/**
 * The fixed vocabulary of evidence a failure can be missing (C05, evidence sufficiency, and the
 * repeated-failure advice that asks it). Each id has one plain phrase for an advice line and one
 * option text for a question, both written here: a question about "which artifact to obtain next"
 * never carries text from the failure, the workspace or the person.
 */
import type { FailureArtifactId } from '@jevris/contracts';

export const FAILURE_ARTIFACT_TEXT: Readonly<Record<FailureArtifactId, { readonly phrase: string; readonly option: string }>> = {
  'failing-test-output': { phrase: 'the failing test output', option: 'The full output of the failing test run, with the assertion that failed.' },
  'stack-trace': { phrase: 'the full stack trace', option: 'The complete stack trace of the error, with every frame.' },
  'config-file': { phrase: 'the configuration file that controls the failing step', option: 'The configuration file that controls the failing step.' },
  'environment-info': { phrase: 'the environment information (tool versions, running services, variables set)', option: 'The environment information: tool versions, running services and which variables are set.' },
  'repro-steps': { phrase: 'the exact steps that reproduce it', option: 'The exact steps, in order, that reproduce the failure from a clean state.' },
  'recent-diff': { phrase: 'the diff of the recent changes', option: 'The diff of what changed since the last run that worked.' },
  logs: { phrase: 'the logs from the failing run', option: 'The logs written during the failing run.' },
};

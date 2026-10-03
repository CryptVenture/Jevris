// node:test reporter for a test run that scripts/test.mjs split into batches (its command line
// would have been too long). Each batch writes its own summary counts here, the ones node prints
// at the end of a run (tests, suites, pass, fail, cancelled, skipped, todo, duration_ms), as one
// JSON line; the runner adds the batches up and prints one summary for the run.
export default async function* testSummary(source) {
  const counts = {};
  for await (const event of source) {
    if (event.type !== 'test:diagnostic') continue;
    const data = event.data ?? {};
    if (data.nesting !== undefined && data.nesting !== 0) continue;
    const match = /^(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) (\d+(?:\.\d+)?)$/.exec(String(data.message));
    if (match !== null) counts[match[1]] = Number(match[2]);
  }
  yield `${JSON.stringify(counts)}\n`;
}

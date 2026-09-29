// node:test reporter for the release run's runtime-gate report (scripts/acceptance-report.mjs):
// one JSON line per finished test with its file, its name and whether it passed. A skipped or
// todo test is never a pass. scripts/test.mjs adds it when JEVRIS_TEST_EVENTS names a file.
export default async function* testEvents(source) {
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const data = event.data ?? {};
    if (data.details?.type === 'suite') continue;
    const skipped = (data.skip !== undefined && data.skip !== false) || (data.todo !== undefined && data.todo !== false);
    yield `${JSON.stringify({ file: typeof data.file === 'string' ? data.file : null, name: String(data.name), passed: event.type === 'test:pass' && !skipped, skipped })}\n`;
  }
}

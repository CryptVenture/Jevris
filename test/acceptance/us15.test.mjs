import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { story } from './lib.mjs';
import { verifySettled } from './verify-run.mjs';

// A long test run: 400 passing lines, one failing assertion in the middle, and an error on stderr.
const SCRIPT = [
  "const lines = ['TAP version 13'];",
  "for (let i = 1; i <= 2500; i += 1) lines.push(i === 1717 ? 'not ok 1717 - parser keeps the locale in the cache key' : `ok ${i} - case ${i}`);",
  "lines.push('  ---', '  expected: \"en-GB\"', '  actual: \"en-US\"', '  ...', '1..2500');",
  "process.stdout.write(lines.join('\\n') + '\\n');",
  "process.stderr.write('Error: 1 of 2500 tests failed\\n');",
  'process.exitCode = 1;',
].join('\n');

story('US15', async ({ then, sandbox, evidence }) => {
  const box = await sandbox();
  const up = box.startSidecar();
  assert.equal(up.code, 0, `sidecar start failed: ${up.stdout} ${up.stderr}`);
  box.write('work/jevris.checks.json', {
    schemaVersion: 'jevris-checks-1',
    checks: [{ id: 'unit', argv: [process.execPath, '-e', SCRIPT], mandatory: true, resultFormat: 'exit-code', description: 'unit tests' }],
  });
  const approve = await box.approveChecks();
  assert.equal(approve.code, 0, `verify approve failed: ${approve.reason}`);
  // The original bytes the runner stores: stdout, a separator, stderr.
  const child = spawnSync(process.execPath, ['-e', SCRIPT], { encoding: 'utf8' });
  const original = `${child.stdout}\n--- stderr ---\n${child.stderr}`;
  const originalHash = createHash('sha256').update(original).digest('hex');

  // Given: the check's long output is stored and shown to the model as an extractive view.
  const run = await verifySettled(box, ['--check', 'unit'], { checks: ['unit'] });
  evidence(run.json);
  assert.equal(run.code, 1, `verify did not report the failure: ${run.stdout} ${run.stderr}`);
  assert.equal(run.json.result.checks[0].outcome, 'failed');
  const client = await box.mcp();
  const selected = await client.callTool({ name: 'jevris_select_evidence', arguments: { intent: 'why did the unit tests fail' } });
  evidence(selected.structuredContent);
  const handle = /ev:[0-9a-f]{64}/.exec(JSON.stringify(selected.structuredContent.result.items))?.[0];
  assert.notEqual(handle, undefined, `the evidence selection names no output handle: ${JSON.stringify(selected.structuredContent.result)}`);

  // When: I request the full evidence handle (CLI and MCP).
  const got = box.jevris(['evidence', 'get', handle], { json: true });
  evidence(got.json);
  assert.equal(got.code, 0, `evidence get failed: ${got.stdout} ${got.stderr}`);
  const payload = got.json.result;
  const viaMcp = (await client.callTool({ name: 'jevris_evidence_get', arguments: { handle } })).structuredContent.result;
  const text = box.jevris(['evidence', 'get', handle]).stdout;

  await then('The original approved output is available, with hash, error state and offsets', () => {
    assert.equal(payload.found, true);
    assert.equal(payload.text, original, 'the stored output is not the original');
    assert.equal(payload.byteLength, Buffer.byteLength(original));
    assert.equal(handle, `ev:${originalHash}`, 'the handle is not the hash of the original');
    assert.match(text, new RegExp(`hash: sha256:${originalHash}`));
    const output = payload.output;
    assert.notEqual(output, null, 'no record of how the output was shown');
    assert.equal(output.exitCode, 1);
    assert.equal(output.errorState, 'failed');
    assert.equal(output.stderrOffset, Buffer.byteLength(`${child.stdout}\n--- stderr ---\n`), 'stderr offset is not in the original');
    assert.equal(output.mode, 'distilled');
    assert.equal(output.keptSpans.length > 0, true);
    // Every kept span points at real bytes and lines of the original, and one holds the failure.
    const bytes = Buffer.from(original);
    const lines = original.split('\n');
    for (const span of output.keptSpans) {
      assert.equal(span.startByte < span.endByte && span.endByte <= bytes.length, true, `span out of range: ${JSON.stringify(span)}`);
      assert.equal(bytes.subarray(span.startByte, span.endByte).toString().replace(/\n+$/, ''), lines.slice(span.startLine, span.endLine).join('\n').replace(/\n+$/, ''), `span bytes and lines disagree: ${JSON.stringify(span)}`);
    }
    assert.equal(output.keptSpans.some((span) => bytes.subarray(span.startByte, span.endByte).toString().includes('not ok 1717')), true, 'no kept span holds the failing assertion');
    assert.equal(output.omittedLines > 0, true);
    assert.match(text, /error state: failed/);
    assert.match(text, /exit code: 1/);
    assert.match(text, /kept bytes \d+-\d+ \(lines \d+-\d+\)/);
    assert.deepEqual(viaMcp.output, output, 'MCP and CLI disagree');
    assert.equal(viaMcp.text, original);
  });

  await then('it has not been replaced by a fabricated success summary', () => {
    const view = payload.output.view;
    assert.match(view, /exit code: 1/);
    assert.match(view, /not ok 1717 - parser keeps the locale in the cache key/);
    assert.match(view, /expected: "en-GB"/);
    assert.match(view, /Error: 1 of 2500 tests failed/);
    assert.match(view, new RegExp(`jevris evidence get ${handle}`), 'the view does not point at the full output');
    // Only lines of the original, plus Jevris's own markers, appear in the view.
    const known = new Set(original.split('\n'));
    const invented = view.split('\n').filter((line) => line.trim() !== '' && !known.has(line) && !/^(exit code: \d+|command: check unit|stderr \(\d+ bytes\):|\[\.\.\. \d+ lines omitted \.\.\.\]|\[output truncated: .*\])$/.test(line));
    assert.deepEqual(invented, [], 'the view holds text that is not in the original');
    assert.doesNotMatch(view, /\b(all tests passed|succeeded|success)\b/i);
  });
});

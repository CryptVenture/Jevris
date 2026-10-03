// Live repeated-failure advice (owner decision 2026-10-01, Jev as an active decision aid): the
// content-free features of a failed tool call, `intent.failure`, from the shared adapter core
// (src/common.ts, byte-identical in all five packages). Each package's own dist/common.js is
// exercised, so every copy is held to the same behaviour. A closed set of codes, two one-way
// digests and booleans: never text, a path, a command or output. No real harness runs here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const contracts = await import('@jevris/contracts');
const orchestrator = await import('@jevris/orchestrator');

const root = join(import.meta.dirname, '..', '..');
const PACKAGES = ['adapter-claude-code', 'adapter-codex', 'adapter-kilocode', 'adapter-opencode', 'adapter-antigravity'];
const cores = await Promise.all(PACKAGES.map(async (name) => ({ name, core: await import(pathToFileURL(join(root, name, 'dist', 'common.js')).href) })));

const ERR = 'Exit code 1\n  1) checkout totals\n     AssertionError: expected 41 to equal 42\n      at Context.<anonymous> (/Users/alice/work/shop/test/cart.test.js:10:5)\n      at process.processImmediate (node:internal/timers:483:21)';
const KEYS = ['commandDigest', 'elapsed', 'environmental', 'exitClass', 'family', 'present', 'signature', 'toolClass'];

function digest(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

for (const { name, core } of cores) {
  test(`${name}: a failed shell test run gives closed codes and digests, in a fixed shape`, () => {
    const f = core.failureFeatures({ toolName: 'Bash', toolInput: { command: 'npm test -- --grep checkout' }, error: ERR, durationMs: 4200 });
    assert.deepEqual(Object.keys(f).sort(), KEYS);
    assert.deepEqual(
      { ...f, signature: undefined, commandDigest: undefined },
      { toolClass: 'shell', exitClass: 'nonzero', family: 'shell:nonzero', signature: undefined, commandDigest: undefined, environmental: false, elapsed: 'lt10s', present: ['failing-test-output', 'stack-trace'] },
    );
    assert.match(f.signature, /^[0-9a-f]{16}$/);
    assert.match(f.commandDigest, /^[0-9a-f]{16}$/);
    // The features are the only thing that leaves the adapter: none of the failure's text is in them.
    const wire = JSON.stringify(f);
    for (const leak of ['alice', 'cart.test', 'AssertionError', 'checkout', 'npm', 'grep', 'Context', 'timers']) assert.equal(wire.includes(leak), false, `${leak} must not appear`);
  });

  test(`${name}: the signature is the one-way digest of the normalized text, so the same error compares equal across paths and numbers`, () => {
    // Independent of the adapter's code: lower case, numbers folded, then sha256 of the domain tag, tool class and text.
    const expected = digest('jevris-failure-v1\nmcp\nhttp <n> from server');
    assert.equal(core.failureFeatures({ toolName: 'mcp__github__create_issue', toolInput: { title: 'x' }, error: 'HTTP 500 from server' }).signature, expected);
    const a = core.failureFeatures({ toolName: 'Bash', error: 'Error: ENOENT /Users/alice/proj/a.js:12:3 at 2026-10-03T10:00:00Z' });
    const b = core.failureFeatures({ toolName: 'Bash', error: 'Error: ENOENT /home/bob/other/b.js:98:7 at 2027-01-01T00:00:01Z' });
    assert.equal(a.signature, b.signature, 'paths, line numbers and times do not make a different failure');
    const c = core.failureFeatures({ toolName: 'Bash', error: 'Error: EACCES something else entirely' });
    assert.notEqual(a.signature, c.signature, 'a different error is a different signature');
    assert.notEqual(core.failureFeatures({ toolName: 'Bash', error: 'boom' }).signature, core.failureFeatures({ toolName: 'WebFetch', error: 'boom' }).signature, 'the tool class is part of the signature');
  });

  test(`${name}: a failure with no text has no signature and a call with no input has no digest, so nothing is ever "the same" by default`, () => {
    const silent = core.failureFeatures({ toolName: 'Bash' });
    assert.deepEqual([silent.signature, silent.commandDigest, silent.exitClass, silent.present], [null, null, 'error', []]);
    assert.equal(core.failureFeatures({ toolName: 'Bash', toolInput: {}, error: 'x' }).commandDigest, null, 'an empty input is not "the same call"');
    assert.equal(core.failureFeatures({ toolName: 'Bash', toolInput: 'npm test', error: 'x' }).commandDigest, null, 'only a plain object input has a digest');
    const one = core.failureFeatures({ toolName: 'Bash', toolInput: { command: 'npm test' }, error: 'x' });
    const two = core.failureFeatures({ toolName: 'Bash', toolInput: { command: 'npm test' }, error: 'y' });
    const other = core.failureFeatures({ toolName: 'Bash', toolInput: { command: 'npm run lint' }, error: 'x' });
    assert.equal(one.commandDigest, two.commandDigest, 'the same call is the same digest whatever it printed');
    assert.notEqual(one.commandDigest, other.commandDigest);
  });

  test(`${name}: the tool class, exit class and elapsed bucket come from closed sets`, () => {
    const classOf = (toolName) => core.failureFeatures({ toolName, error: 'e' }).toolClass;
    assert.deepEqual(['Bash', 'bash', 'run_command', 'PowerShell'].map(classOf), ['shell', 'shell', 'shell', 'shell']);
    assert.deepEqual(['Edit', 'apply_patch', 'write_to_file'].map(classOf), ['edit', 'edit', 'edit']);
    assert.deepEqual(['Read', 'grep', 'view_file'].map(classOf), ['read', 'read', 'read']);
    assert.deepEqual(['WebFetch', 'read_url_content'].map(classOf), ['web', 'web']);
    assert.deepEqual(['Agent', 'Task'].map(classOf), ['agent', 'agent']);
    assert.deepEqual([classOf('mcp__github__create_issue'), classOf('Skill'), classOf('SomethingNew'), classOf(null)], ['mcp', 'skill', 'other', 'other']);
    const exitOf = (error, extra = {}) => core.failureFeatures({ toolName: 'Bash', error, ...extra }).exitClass;
    assert.deepEqual([exitOf('Exit code 2'), exitOf('exit status 137'), exitOf('boom'), exitOf('boom', { exit: 3 }), exitOf('boom', { exit: -1 })], ['nonzero', 'signal', 'error', 'nonzero', 'signal']);
    assert.deepEqual([exitOf('killed', { interrupted: true }), exitOf('Error: command timed out after 120s'), exitOf('ETIMEDOUT')], ['timeout', 'timeout', 'timeout']);
    const bucket = (durationMs) => core.failureFeatures({ toolName: 'Bash', error: 'e', durationMs }).elapsed;
    assert.deepEqual([bucket(0), bucket(999), bucket(1000), bucket(9999), bucket(10_000), bucket(59_999), bucket(60_000), bucket(null), bucket(undefined)], ['lt1s', 'lt1s', 'lt10s', 'lt10s', 'lt60s', 'lt60s', 'gte60s', 'unknown', 'unknown']);
  });

  test(`${name}: the artifacts a failure already shows are found by rule and listed in the fixed order`, () => {
    const present = (error) => core.failureFeatures({ toolName: 'Bash', error }).present;
    assert.deepEqual(present('not ok 3 - totals\n  expected 1 to equal 2'), ['failing-test-output']);
    assert.deepEqual(present('Traceback (most recent call last):\n  File "a.py", line 3, in <module>\nValueError'), ['stack-trace']);
    assert.deepEqual(present('could not parse tsconfig.json'), ['config-file']);
    assert.deepEqual(present('requires node 18.2.0 but found node 16.1.0'), ['environment-info']);
    assert.deepEqual(present(Array.from({ length: 20 }, (_, i) => `line ${String(i)}`).join('\n')), ['logs']);
    assert.deepEqual(present('plain failure'), []);
  });

  test(`${name}: the vocabularies are the contracts' lists, and every value produced is in them`, () => {
    assert.deepEqual([...core.FAILURE_ARTIFACT_IDS], [...contracts.FAILURE_ARTIFACT_IDS]);
    const samples = [
      { toolName: 'Bash', error: ERR, durationMs: 70_000 },
      { toolName: 'mcp__x__y', error: 'ECONNREFUSED', interrupted: true },
      { toolName: 'WebFetch', error: 'HTTP 404' },
      { toolName: null },
    ];
    for (const sample of samples) {
      const f = core.failureFeatures(sample);
      assert.ok(contracts.FAILURE_TOOL_CLASSES.includes(f.toolClass));
      assert.ok(contracts.FAILURE_EXIT_CLASSES.includes(f.exitClass));
      assert.ok(contracts.FAILURE_ELAPSED_BUCKETS.includes(f.elapsed));
      assert.ok(f.present.every((id) => contracts.FAILURE_ARTIFACT_IDS.includes(id)));
      assert.equal(f.family, `${f.toolClass}:${f.exitClass}`);
    }
  });

  test(`${name}: line-start rules read spaces, tabs and Windows line ends, and none can run long on a wall of blank lines`, () => {
    const present = (error) => core.failureFeatures({ toolName: 'Bash', error }).present;
    assert.deepEqual(present('Error: x\r\n\tat run (/w/a.js:3:9)\r\n\tat main (/w/b.js:1:1)\r\n'), ['stack-trace'], 'tab-indented frames with CRLF');
    assert.deepEqual(present('  File "a.py", line 3, in run\n    boom()'), ['stack-trace']);
    assert.deepEqual(present('\t  FAIL  src/cart.test.ts'), ['failing-test-output'], 'an indented FAIL line');
    assert.deepEqual(present('no frames here\n\n\n   \n'), []);
    // A blank-line wall at the text cap: the features still come back whole.
    const wall = ['\n'.repeat(20_000), ' \n'.repeat(10_000), ' \t'.repeat(10_000)];
    for (const text of wall) assert.deepEqual(present(text), [], 'blank text shows nothing');
    // `\s` spans newlines, so a `^`-anchored rule that starts with it is quadratic on such a wall: none may.
    const source = readFileSync(join(root, name, 'dist', 'common.js'), 'utf8');
    assert.equal(/\^\\s[*+]/.test(source), false, 'no line-start rule begins with \\s');
  });

  test(`${name}: "looks environmental" is the same rule the orchestrator's loop assessment uses`, () => {
    const corpus = [
      'getaddrinfo ENOTFOUND registry.npmjs.org',
      'connect ECONNREFUSED 127.0.0.1:5432',
      'bash: docker: command not found',
      "'tsc' is not recognized as an internal or external command",
      'EACCES: permission denied, open /var/log/x',
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock',
      'could not resolve host: example.test',
      'AssertionError: expected 1 to equal 2',
      'TypeError: x is not a function',
      'error TS2304: Cannot find name y',
      'exit status 1',
      '',
    ];
    for (const text of corpus) {
      assert.equal(core.failureFeatures({ toolName: 'Bash', error: text }).environmental, orchestrator.errorFamily(text).environment, JSON.stringify(text));
    }
  });
}

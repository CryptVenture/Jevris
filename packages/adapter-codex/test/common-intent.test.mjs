// HKR-02, INT-01..05, GOV-12, GOV-13, VER-05: the decision inputs, the Stop continuation and the
// plugin-family edges of the shared adapter core (src/common.ts, byte-identical in all five
// packages). Each package's own dist/common.js is exercised, so every copy is held to the same
// behaviour. No real harness runs here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(import.meta.dirname, '..', '..');
const PACKAGES = ['adapter-claude-code', 'adapter-codex', 'adapter-kilocode', 'adapter-opencode', 'adapter-antigravity'];
const cores = await Promise.all(PACKAGES.map(async (name) => ({ name, core: await import(pathToFileURL(join(root, name, 'dist', 'common.js')).href) })));

const SURROGATE = '\u{1F600}'; // two UTF-16 units

for (const { name, core } of cores) {
  test(`${name}: the user's request is kept verbatim, trimmed and clipped without splitting a surrogate pair`, () => {
    assert.equal(core.taskIntent(42), null);
    assert.equal(core.taskIntent('   '), null);
    assert.deepEqual(core.taskIntent('  fix the parser  '), { objective: 'fix the parser' });
    const long = core.taskIntent('a'.repeat(core.OBJECTIVE_CAP + 10));
    assert.equal(long.objective.length, core.OBJECTIVE_CAP);
    // The cap falls between the two halves of an emoji: the lone high half is dropped.
    const split = core.taskIntent(`${'a'.repeat(core.OBJECTIVE_CAP - 1)}${SURROGATE}tail`);
    assert.equal(split.objective, 'a'.repeat(core.OBJECTIVE_CAP - 1));
  });

  test(`${name}: a write's scope names its paths, relative to the session cwd when inside it`, () => {
    assert.equal(core.scopeIntent([null, '', 'x'.repeat(2000)], '/w'), null, 'nothing usable: no scope');
    assert.deepEqual(core.scopeIntent(['/w/src/a.ts', '/w/src/a.ts', '/elsewhere/b.ts', '/w/'], '/w/'), {
      diff: [{ path: 'src/a.ts' }, { path: '/elsewhere/b.ts' }, { path: '/w/' }],
      requestedEffects: [],
    });
    assert.deepEqual(core.scopeIntent(['C:\\repo\\src\\b.ts'], 'C:\\repo'), { diff: [{ path: 'src/b.ts' }], requestedEffects: [] }, 'Windows separators');
    assert.deepEqual(core.scopeIntent(['rel/c.ts'], null), { diff: [{ path: 'rel/c.ts' }], requestedEffects: [] });
    const many = core.scopeIntent(Array.from({ length: 300 }, (_, i) => `f${i}`), null);
    assert.equal(many.diff.length, 256, 'bounded');
    assert.deepEqual(core.patchPaths(7), []);
    assert.deepEqual(core.patchPaths('*** Begin Patch\n*** Add File: a.ts\n+body line\n*** Update File: b.ts\n*** Move to: c.ts\n*** Delete File: d.ts\n*** End Patch'), ['a.ts', 'b.ts', 'c.ts', 'd.ts']);
    assert.equal(core.patchPaths(Array.from({ length: 300 }, (_, i) => `*** Add File: p${i}`).join('\n')).length, 256);
  });

  test(`${name}: a failed call's evidence keeps only the first error line`, () => {
    assert.deepEqual(core.failureEvidence('Bash', '\n  \nexit 1: not found\nstack line'), {
      required: [{ id: 'failure-output', description: 'The error output of the failed Bash call', available: true, fresh: true }],
      diagnostics: [{ id: 'error', text: 'exit 1: not found' }],
    });
    assert.deepEqual(core.failureEvidence(null, undefined), {
      required: [{ id: 'failure-output', description: 'The error output of the failed tool call', available: false, fresh: null }],
    });
    assert.equal(core.failureEvidence('Bash', 'e'.repeat(400)).diagnostics[0].text.length, 300);
  });

  test(`${name}: returned text becomes untrusted spans with its source kind; names are not text`, () => {
    assert.equal(core.untrustedSourceKind(null), 'tool-output');
    assert.equal(core.untrustedSourceKind('Read'), 'file');
    assert.equal(core.untrustedSourceKind('view_file'), 'file');
    assert.equal(core.untrustedSourceKind('WebFetch'), 'fetched-doc');
    assert.equal(core.untrustedSourceKind('Skill'), 'skill-description');
    assert.equal(core.untrustedSourceKind('Bash'), 'tool-output');

    assert.equal(core.untrustedIntent('Read', 'tu1', { type: 'text', path: '/a', text: '   ' }), null, 'only names and blanks: nothing');
    const nested = core.untrustedIntent('WebFetch', 'tu_1', { type: 'text', url: 'https://x', content: [{ text: 'one' }, 'two', 3, null, { title: 'skip', body: 'three' }] });
    assert.deepEqual(nested, { spans: [{ id: 'tu_1', sourceKind: 'fetched-doc', text: 'one\ntwo\nthree' }] });
    const deep = { a: { b: { c: { d: { e: { f: { g: 'too deep' } } } } } }, top: 'kept' };
    assert.equal(core.untrustedIntent('Bash', null, deep).spans[0].text, 'kept', 'past the depth bound nothing is read');
    assert.equal(core.untrustedIntent('Bash', 'bad id with spaces', 'x').spans[0].id, 't1', 'an odd tool-use id is replaced');

    const big = core.untrustedIntent('Bash', 'call', 'x'.repeat(core.UNTRUSTED_TOTAL_CHARS + 500));
    assert.equal(big.spans.length, core.UNTRUSTED_SPANS);
    assert.deepEqual(big.spans.map((span) => span.id), ['call', 'call.2', 'call.3', 'call.4']);
    assert.ok(big.spans.every((span) => span.text.length <= core.UNTRUSTED_SPAN_CHARS));
    assert.ok(big.spans.at(-1).text.endsWith(core.TRUNCATION_MARKER));
    // A cut never leaves half a surrogate pair.
    const emoji = core.untrustedIntent('Bash', 'e', `${'a'.repeat(core.UNTRUSTED_SPAN_CHARS - 1)}${SURROGATE}b`);
    assert.equal(emoji.spans[0].text.length, core.UNTRUSTED_SPAN_CHARS - 1);
    assert.equal(emoji.spans[1].text, `${SURROGATE}b`);
    // Many small strings stop being collected once past the total.
    const lots = core.untrustedIntent('Bash', 'l', Array.from({ length: 200 }, () => 'z'.repeat(300)));
    assert.ok(lots.spans.map((span) => span.text).join('').length <= core.UNTRUSTED_TOTAL_CHARS);
  });

  test(`${name}: a proposed call's effect names its command, paths and hosts, bounded`, () => {
    assert.equal(core.effectIntent(null, {}), null);
    assert.equal(core.effectIntent('bad name!', {}), null);
    assert.deepEqual(core.effectIntent('Read', {}), { tool: 'Read' });
    assert.deepEqual(core.effectIntent('Bash', { command: 'curl -s https://User@Example.COM/a "http://api.test:8080/x" https://[::1]/v6' }), {
      tool: 'Bash',
      command: 'curl -s https://User@Example.COM/a "http://api.test:8080/x" https://[::1]/v6',
      hosts: ['example.com', 'api.test'],
    });
    assert.deepEqual(core.effectIntent('shell', { command: ['git', 'push', 'https://git.test/r'] }), { tool: 'shell', command: 'git push https://git.test/r', hosts: ['git.test'] }, 'Codex argv');
    assert.equal(core.effectIntent('shell', { command: ['git', 1] }).command, undefined, 'an argv with a non-string is not a command');
    assert.deepEqual(core.effectIntent('run_command', { CommandLine: '   ' }), { tool: 'run_command' }, 'a blank command is left out');
    assert.deepEqual(core.effectIntent('exec', { cmd: 'ls' }), { tool: 'exec', command: 'ls' });
    assert.deepEqual(core.effectIntent('write_to_file', { TargetFile: '/w/a', AbsolutePath: '/w/b', DirectoryPath: '/w', file_path: '', path: 'x'.repeat(5000) }), { tool: 'write_to_file', paths: ['/w/a', '/w/b', '/w'] });
    assert.deepEqual(core.effectIntent('apply_patch', { input: '*** Update File: src/a.ts' }).paths, ['src/a.ts']);
    assert.deepEqual(core.effectIntent('patch', { patchText: '*** Add File: n.ts' }).paths, ['n.ts']);
    assert.deepEqual(core.effectIntent('WebFetch', { url: 'https://docs.test/p', Url: 'ftp://no.test' }), { tool: 'WebFetch', hosts: ['docs.test'] });
    assert.deepEqual(core.effectIntent('WebFetch', { url: 42 }), { tool: 'WebFetch' });
    const hosts = Array.from({ length: 40 }, (_, i) => `https://h${i}.test/`).join(' ');
    assert.equal(core.effectIntent('Bash', { command: hosts }).hosts.length, 32);
    const patch = Array.from({ length: 40 }, (_, i) => `*** Add File: f${i}`).join('\n');
    assert.equal(core.effectIntent('apply_patch', { input: patch }).paths.length, 32);
    assert.equal(core.effectIntent('Bash', { command: 'y'.repeat(2000) }).command.length, 1024);
  });

  test(`${name}: an input cut to fit keeps its structure; one that cannot fit or serialize is null`, () => {
    const fitted = JSON.parse(core.fitWithin({ list: ['a'.repeat(40_000), 1, null], nested: { s: 'short' } }, 50_000));
    assert.equal(fitted.list[0], `${'a'.repeat(32_768)}${core.CUT_MARKER}`);
    assert.deepEqual(fitted.list.slice(1), [1, null]);
    assert.deepEqual(fitted.nested, { s: 'short' });
    assert.equal(core.fitWithin({ n: 1n }, 1000), null, 'cannot serialize');
    assert.equal(core.fitWithin(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, 'v'.repeat(300)])), 100), null, 'too wide at every limit');
    // `__proto__` stays an own key, so screening still refuses it after a cut.
    const proto = JSON.parse('{"__proto__":{"x":"' + 'p'.repeat(40_000) + '"}}');
    assert.equal(core.screen(JSON.parse(core.fitWithin(proto, 40_000))), 'UNSAFE_KEY');
  });

  test(`${name}: the Stop continuation blocks once, only for an explicit first stop, naming evidence ids only`, () => {
    const stop = (payload, extra = {}) => ({ kind: 'turn.stopped', nativeEventName: 'Stop', payload, ...extra });
    assert.equal(core.stopBlockResponse(null, ['tests']), '');
    assert.equal(core.stopBlockResponse(stop({ stopHookActive: false }, { kind: 'turn.started' }), ['tests']), '');
    assert.equal(core.stopBlockResponse(stop({ stopHookActive: false }, { nativeEventName: 'session.idle' }), ['tests']), '');
    assert.equal(core.stopBlockResponse(stop({ stopHookActive: true }), ['tests']), '', 'a continued turn never blocks again');
    assert.equal(core.stopBlockResponse(stop({}), ['tests']), '', 'a harness that did not say never blocks');
    assert.equal(core.stopBlockResponse(stop({ stopHookActive: false }), ['bad id!', 7, '']), '', 'no valid id: no block');
    const ids = ['tests', 'lint', 'tests', 'bad id!', ...Array.from({ length: 20 }, (_, i) => `e${i}`)];
    const block = JSON.parse(core.stopBlockResponse(stop({ stopHookActive: false }), ids));
    assert.equal(block.decision, 'block');
    assert.match(block.reason, /^Jevris: verification evidence is missing: tests, lint, e0, .*e13\. Run the declared checks \(jevris verify\) before finishing\.$/);
    assert.doesNotMatch(block.reason, /bad id|e14/);
  });

  test(`${name}: a Stop block names a still-running check with the launcher's words, and ignores unusable words or ids (pair)`, () => {
    const first = { kind: 'turn.stopped', nativeEventName: 'Stop', payload: { stopHookActive: false } };
    const reason = (running) => JSON.parse(core.stopBlockResponse(first, ['unit', 'lint'], running)).reason;
    const plain = 'Jevris: verification evidence is missing: unit, lint. Run the declared checks (jevris verify) before finishing.';
    const words = 'Still running in the background: unit (running); each receipt is recorded when its run ends.';
    assert.equal(reason(undefined), plain);
    for (const unusable of [{ checkIds: ['other'], text: words }, { checkIds: ['unit'], text: '' }, { checkIds: ['unit'], text: 'a\nb' }, { checkIds: ['unit'], text: 'x'.repeat(601) }, { checkIds: ['unit'], text: 7 }]) {
      assert.equal(reason(unusable), plain, JSON.stringify(unusable).slice(0, 80));
    }
    assert.equal(reason({ checkIds: ['unit'], text: words }), `Jevris: verification evidence is missing: unit, lint. ${words} Run the declared checks for lint (jevris verify) before finishing.`);
    assert.equal(reason({ checkIds: ['unit', 'lint'], text: words }), `Jevris: verification evidence is missing: unit, lint. ${words} Stopping again ends this turn labelled unverified.`);
    assert.equal(core.stopBlockResponse({ ...first, payload: { stopHookActive: true } }, ['unit'], { checkIds: ['unit'], text: words }), '', 'a continued turn never blocks, running or not');
  });

  test(`${name}: command hooks summarise effort and failures, and only a valid transcript position dedups`, () => {
    const spec = (kind) => ({ kind, blocking: false, responseRequired: false });
    const failed = core.commandHookParts('codex', 'PostToolUseFailure', spec('tool.failed'), { session_id: 's', tool_name: 'Bash', tool_use_id: 'u1', error: 'boom\nmore', effort: { level: 'high' } });
    assert.equal(failed.event.payload.effort, 'high');
    assert.deepEqual(failed.intent.evidence.diagnostics, [{ id: 'error', text: 'boom' }]);
    assert.deepEqual(failed.intent.untrusted.spans[0], { id: 'u1', sourceKind: 'tool-output', text: 'boom\nmore' });
    const wrote = core.commandHookParts('claude-code', 'PostToolUse', spec('tool.finished'), { session_id: 's', tool_name: 'apply_patch', cwd: '/w', tool_input: { command: '*** Update File: /w/a.ts', input: '*** Add File: b.ts' } });
    assert.deepEqual(wrote.intent.scope.diff, [{ path: 'a.ts' }, { path: 'b.ts' }]);
    const proposed = core.commandHookParts('claude-code', 'PreToolUse', spec('tool.proposed'), { session_id: 's', tool_name: 'Bash', tool_input: 'not an object' });
    assert.deepEqual(proposed.intent, { effect: { tool: 'Bash' } });
    assert.equal(core.deliveryPosition({ transcriptBytes: 12 }), 12);
    for (const bad of [-1, 1.5, '12', Number.MAX_SAFE_INTEGER + 2]) assert.equal(core.deliveryPosition({ transcriptBytes: bad }), null);
    const at = (bytes) => core.commandHookParts('codex', 'Stop', spec('turn.stopped'), { session_id: 's' }, { transcriptBytes: bytes }).event.dedupKey;
    assert.notEqual(at(10), at(20));
    assert.equal(at(-5), at(undefined), 'an invalid position is no position');
  });

  test(`${name}: plugin hook calls read args, metadata and prompt parts the way each shape sends them`, () => {
    const call = (hookKey, input, output) => core.pluginEvent('opencode', { hookKey, input, output });
    // Args may arrive on the input or only on the output.
    const fromOutput = call('tool.execute.before', { sessionID: 's', tool: 'bash' }, { args: { command: 'curl https://x.test' } });
    assert.deepEqual(fromOutput.intent.effect, { tool: 'bash', command: 'curl https://x.test', hosts: ['x.test'] });
    const fromInput = call('tool.execute.before', { sessionID: 's', tool: 'read', args: { filePath: '/a' } }, 'not an object');
    assert.deepEqual(fromInput.intent.effect, { tool: 'read', paths: ['/a'] });
    const noArgs = call('tool.execute.before', { sessionID: 's', tool: 'read' }, {});
    assert.deepEqual(noArgs.intent.effect, { tool: 'read' });
    // A finished write names the paths from its args, its metadata and its patch.
    const wrote = call('tool.execute.after', { sessionID: 's', tool: 'edit', callID: 'c1', args: { filePath: 'a.ts' } }, { metadata: { filepath: 'b.ts', filePath: 'c.ts' }, output: 'done' });
    assert.deepEqual(wrote.intent.scope.diff, [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'c.ts' }]);
    assert.deepEqual(wrote.intent.untrusted.spans[0], { id: 'c1', sourceKind: 'tool-output', text: 'done' });
    const patched = call('tool.execute.after', { sessionID: 's', tool: 'patch' }, { args: { patchText: '*** Update File: d.ts' }, metadata: 'odd' });
    assert.deepEqual(patched.intent.scope.diff, [{ path: 'd.ts' }]);
    const read = call('tool.execute.after', { sessionID: 's', tool: 'read' }, { output: '' });
    assert.equal(read.intent, undefined, 'a read is no write and returned nothing');
    // The prompt is the typed text parts, never synthetic, ignored or blank ones.
    const parts = [{ type: 'text', text: 'first' }, { type: 'text', text: 'hidden', synthetic: true }, { type: 'text', text: 'skip', ignored: true }, { type: 'file', text: 'no' }, 'odd', { type: 'text', text: '  ' }, { type: 'text', text: 7 }, { type: 'text', text: 'second' }];
    assert.deepEqual(call('chat.message', { sessionID: 's' }, { parts }).intent, { task: { objective: 'first\nsecond' } });
    assert.equal(call('chat.message', { sessionID: 's' }, { parts: [{ type: 'text', text: 'x', synthetic: true }] }).intent, undefined);
    assert.equal(call('chat.message', { sessionID: 's' }, { parts: 'odd' }).intent, undefined);
    // A bad delivery stamp still yields an event; only a well-formed stamp tells deliveries apart.
    const stamped = (delivery) => core.pluginEvent('kilocode', { event: { type: 'session.idle', properties: { sessionID: 's' } }, delivery }).event.dedupKey;
    assert.equal(stamped({ instance: 'i', seq: -1 }), stamped({ instance: 'i', seq: 'x' }));
    assert.notEqual(stamped({ instance: 'i', seq: 1 }), stamped({ instance: 'i', seq: 2 }));
    assert.equal(stamped('odd'), stamped(undefined));
    // Session ids come from the event itself or its info.
    assert.equal(core.pluginEvent('opencode', { event: { type: 'session.created', properties: { info: { id: 'ses_9' } } } }).event.sessionId, 'ses_9');
    assert.equal(core.pluginEvent('opencode', { event: { type: 'session.created', properties: 'odd' } }).event.sessionId, null);
  });

  test(`${name}: plugin hooks keep one stamp per delivered object and survive input that throws when read`, async () => {
    const sent = [];
    const hooks = core.createPluginHooks({ harness: 'opencode', responseTimeoutMs: 20, forward: async (text, wait) => (sent.push(JSON.parse(text)), wait ? '' : 'ignored') });
    const input = { sessionID: 's', tool: 'bash' };
    await hooks['tool.execute.before'](input, { args: { command: 'ls' } });
    await hooks['tool.execute.before'](input, { args: { command: 'ls' } });
    assert.equal(sent[0].delivery.seq, sent[1].delivery.seq, 'the same object redelivered keeps its stamp');
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 's' } } });
    assert.equal(sent[2].delivery.seq, sent[1].delivery.seq + 1);
    // A bus event that cannot be cut to fit is reduced to its input and stamp.
    const wide = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`k${i}`, 'y'.repeat(300)]));
    await hooks.event({ event: { type: 'file.edited', properties: { file: 'f', ...wide } } });
    assert.equal(sent[3].hookKey, 'event');
    const hostile = { sessionID: 's' };
    Object.defineProperty(hostile, 'boom', { enumerable: true, get: () => { throw new Error('getter'); } });
    await hooks['tool.execute.before'](hostile, {});
    const output = { context: [] };
    await hooks['experimental.session.compacting'](hostile, output);
    assert.deepEqual(output.context, [], 'a throwing input is a no-op, never an error in the harness');
    const before = sent.length;
    await hooks.event(hostile);
    assert.equal(sent.length, before, 'a bus event that throws when read is dropped');
    // An output whose context throws when read: compaction proceeds without Jevris context.
    const answering = core.createPluginHooks({ harness: 'kilocode', forward: async () => '{"context":["from jevris"]}' });
    const trap = {};
    Object.defineProperty(trap, 'context', { enumerable: true, get: () => { throw new Error('getter'); } });
    await answering['experimental.session.compacting']({ sessionID: 's' }, trap);
  });
}

// C20 (omission audit): the summary a finished compaction produced rides next to the envelope as `intent.compaction`,
// clipped, only on PostCompact, and never inside the envelope's payload. A harness that sends none leaves it out.
for (const { name, core } of cores) {
  test(`${name}: the compaction summary is kept clipped as a decision input, only on a finished compaction, and never in the envelope`, async () => {
    assert.equal(core.compactionIntent(7), null);
    assert.equal(core.compactionIntent('   '), null);
    assert.deepEqual(core.compactionIntent('  C7 holds.  '), { summary: 'C7 holds.' });
    assert.equal(core.compactionIntent('a'.repeat(core.COMPACTION_SUMMARY_CAP + 50)).summary.length, core.COMPACTION_SUMMARY_CAP);
    assert.equal(core.COMPACTION_SUMMARY_CAP, 16_384);
    const adapter = await import(pathToFileURL(join(root, name, 'dist', 'index.js')).href);
    const base = { session_id: 'ses_1', transcript_path: '/work/ses_1.jsonl', cwd: '/work', trigger: 'auto' };
    // Claude Code and Codex name their hook events; Kilo, OpenCode and Antigravity have no PostCompact hook, so this input is not theirs.
    const post = adapter.normalize({ ...base, hook_event_name: 'PostCompact', compact_summary: 'The summary SUMMARY-MARKER keeps C7.' });
    if (!post.ok) return;
    assert.deepEqual(post.intent?.compaction, { summary: 'The summary SUMMARY-MARKER keeps C7.' });
    assert.equal(JSON.stringify(post.event).includes('SUMMARY-MARKER'), false, 'not in the envelope: the payload is sizes and names');
    const none = adapter.normalize({ ...base, hook_event_name: 'PostCompact' });
    assert.equal(none.ok && none.intent?.compaction === undefined, true, 'no summary, no input');
    const pre = adapter.normalize({ ...base, hook_event_name: 'PreCompact', compact_summary: 'ignored' });
    assert.equal(pre.ok && pre.intent?.compaction === undefined, true, 'only a finished compaction carries one');
  });
}

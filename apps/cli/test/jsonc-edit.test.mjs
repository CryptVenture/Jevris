import test from 'node:test';
import assert from 'node:assert/strict';

const { appendItem, insertProperty, parseJsonc, removePath, undoSplices, indentUnit } = await import('../dist/jsonc-edit.js');

const SERVER = { type: 'local', command: ['node', '/home/u/.config/kilo/jevris/mcp.js'], enabled: true };

const SAMPLES = {
  pretty: `${JSON.stringify({ $schema: 'https://app.kilo.ai/config.json', mcp: { other: { type: 'remote', url: 'https://x.invalid' } } }, null, 2)}\n`,
  compact: '{"theme":"plain","mcp":{"other":{"enabled":true}}}',
  commented: [
    '// Kilo config, hand edited',
    '{',
    '  /* schema */ "$schema": "https://app.kilo.ai/config.json",',
    '  "mcp": {',
    '    // keep this server',
    '    "other": { "type": "remote", "url": "https://x.invalid" }, // trailing note',
    '  },',
    '  "compaction": { "threshold_percent": 50 }, // trailing comma allowed',
    '}',
    '',
  ].join('\n'),
  crlf: '{\r\n    "mcp": {\r\n        "other": {}\r\n    }\r\n}\r\n',
  tabs: '{\n\t"mcp": {\n\t\t"other": {}\n\t}\n}\n',
  emptyMcp: '{\n  "mcp": {}\n}\n',
  noMcp: '{\n  "model": "x"\n}\n',
  empty: '{}\n',
  bom: '﻿{\n  "a": 1\n}\n',
};

test('insert then undo is byte-exact on pretty, compact, commented, CRLF, tab, empty and BOM files', () => {
  for (const [name, text] of Object.entries(SAMPLES)) {
    const edited = insertProperty(text, ['mcp', 'jevris'], SERVER);
    assert.notEqual(edited, null, name);
    assert.deepEqual(parseJsonc(edited.text).mcp.jevris, SERVER, name);
    assert.equal(undoSplices(edited.text, [edited.splice]), text, name);
  }
});

test('insert keeps the file style: indent, line ending, compact layout and every comment', () => {
  const crlf = insertProperty(SAMPLES.crlf, ['mcp', 'jevris'], SERVER).text;
  assert.equal(crlf.replaceAll('\r\n', '').includes('\n'), false);
  assert.equal(crlf.includes('\r\n        "jevris": {\r\n            "type"'), true);
  const tabs = insertProperty(SAMPLES.tabs, ['mcp', 'jevris'], SERVER).text;
  assert.equal(tabs.includes('\n\t\t"jevris": {\n\t\t\t"type": "local"'), true);
  const compact = insertProperty(SAMPLES.compact, ['mcp', 'jevris'], SERVER).text;
  assert.equal(compact.includes('\n'), false);
  const commented = insertProperty(SAMPLES.commented, ['mcp', 'jevris'], SERVER).text;
  for (const comment of ['// Kilo config, hand edited', '/* schema */', '// keep this server', '// trailing note', '// trailing comma allowed']) {
    assert.equal(commented.includes(comment), true, comment);
  }
  assert.equal(indentUnit(SAMPLES.pretty), '  ');
  assert.equal(indentUnit(SAMPLES.tabs), '\t');
  assert.equal(indentUnit(SAMPLES.crlf), '    ');
});

test('insert refuses an existing key, a non-object ancestor and an unparsable file', () => {
  assert.equal(insertProperty('{"mcp":{"jevris":1}}', ['mcp', 'jevris'], SERVER), null);
  assert.equal(insertProperty('{"mcp":[]}', ['mcp', 'jevris'], SERVER), null);
  assert.equal(insertProperty('{"mcp": ', ['mcp', 'jevris'], SERVER), null);
  assert.equal(insertProperty('[1]', ['mcp', 'jevris'], SERVER), null);
  assert.equal(parseJsonc('{"__proto__": {}}'), undefined);
  assert.equal(parseJsonc('{"a": 1, "a": 2}'), undefined);
});

test('remove keeps comments and neighbours and leaves valid JSON', () => {
  const edited = insertProperty(SAMPLES.commented, ['mcp', 'jevris'], SERVER).text;
  const userEdited = edited.replace('"compaction"', '"added_by_user": true,\n  "compaction"');
  const removed = removePath(userEdited, ['mcp', 'jevris']);
  const value = parseJsonc(removed);
  assert.equal(Object.hasOwn(value.mcp, 'jevris'), false);
  assert.equal(value.mcp.other.type, 'remote');
  assert.equal(value.added_by_user, true);
  for (const comment of ['// Kilo config, hand edited', '/* schema */', '// keep this server', '// trailing note', '// trailing comma allowed']) {
    assert.equal(removed.includes(comment), true, comment);
  }
  const strict = '{\n  "a": 1, // note\n  "jevris": 2\n}\n';
  const stripped = removePath(strict, ['jevris']);
  assert.equal(stripped, '{\n  "a": 1 // note\n}\n');
  assert.deepEqual(JSON.parse(removePath('{"a":1,"b":2,"c":3}', ['b'])), { a: 1, c: 3 });
  assert.deepEqual(JSON.parse(removePath('{"a":1,"b":2}', ['a'])), { b: 2 });
  assert.deepEqual(JSON.parse(removePath('{\n  "only": 1\n}', ['only'])), {});
  assert.equal(removePath('{"a":1}', ['missing']), '{"a":1}');
});

test('array append and item removal round-trip exactly and keep other items', () => {
  const text = `${JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'gsd' }] }] } }, null, 2)}\n`;
  const group = { hooks: [{ type: 'command', command: "node '/h/.codex/jevris/hook.js'" }] };
  const edited = appendItem(text, ['hooks', 'SessionStart'], group);
  assert.equal(undoSplices(edited.text, [edited.splice]), text);
  const parsed = parseJsonc(edited.text);
  assert.equal(parsed.hooks.SessionStart.length, 2);
  assert.equal(parsed.hooks.SessionStart[0].hooks[0].command, 'gsd');
  const removed = removePath(edited.text, ['hooks', 'SessionStart', 1]);
  assert.equal(removed, text);
  const empty = appendItem('{\n  "plugins": []\n}\n', ['plugins'], { name: 'jevris' });
  assert.equal(undoSplices(empty.text, [empty.splice]), '{\n  "plugins": []\n}\n');
  assert.equal(appendItem('{"plugins": {}}', ['plugins'], 1), null);
});

test('undoSplices refuses when the spliced text is no longer there', () => {
  const edited = insertProperty(SAMPLES.pretty, ['mcp', 'jevris'], SERVER);
  const changed = edited.text.replace('"local"', '"remote"');
  assert.equal(undoSplices(changed, [edited.splice]), null);
});

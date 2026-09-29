import test from 'node:test';
import assert from 'node:assert/strict';

const { appendTomlBlock, hasTomlTable, removeTomlTables, scanToml, tomlString } = await import('../dist/toml-edit.js');

const JEVRIS = ['mcp_servers', 'jevris'];
const BLOCK = [
  '[mcp_servers.jevris]',
  'command = "node"',
  `args = [${tomlString('C:\\Users\\me\\.agents\\plugins\\jevris\\bin\\mcp.js')}]`,
  'enabled = true',
];

const USER_CONFIG = [
  '# Codex config',
  'model = "gpt-5.5"',
  'notes = """',
  '[mcp_servers.jevris]',
  'this line is inside a multi-line string',
  '"""',
  'paths = [',
  '  "a",',
  '  ["nested"],',
  ']',
  '',
  '[mcp_servers.docs]',
  'command = "docs-mcp"',
  '',
  '[mcp_servers.jevris2]',
  'command = "other"',
  '',
  '[mcp_servers."jevris.x"]',
  'command = "quoted"',
  '',
  '[projects."/Users/me/repo"]',
  "trust_level = 'trusted'",
  '',
].join('\n');

test('append then remove restores the file byte for byte', () => {
  for (const base of [USER_CONFIG, 'a = 1', 'a = 1\n', 'a = 1\n\n', '', 'a = 1\r\nb = 2\r\n']) {
    const appended = appendTomlBlock(base, BLOCK);
    assert.equal(appended.text.slice(0, base.length), base);
    assert.equal(appended.splice.at, base.length);
    assert.equal(`${base}${appended.splice.text}`, appended.text);
    assert.equal(hasTomlTable(appended.text, JEVRIS), true);
    const removed = removeTomlTables(appended.text, JEVRIS);
    assert.equal(hasTomlTable(removed, JEVRIS), false);
    assert.equal(removed.includes('[mcp_servers.docs]') || !base.includes('docs'), true);
  }
});

test('the scanner does not treat string or array content as a header', () => {
  const statements = scanToml(USER_CONFIG);
  assert.notEqual(statements, null);
  const headers = statements.filter((statement) => statement.kind === 'header').map((statement) => statement.path.join('.'));
  assert.deepEqual(headers, ['mcp_servers.docs', 'mcp_servers.jevris2', 'mcp_servers.jevris.x', 'projects./Users/me/repo']);
  assert.equal(hasTomlTable(USER_CONFIG, JEVRIS), false);
  assert.equal(removeTomlTables(USER_CONFIG, JEVRIS), USER_CONFIG);
});

test('remove takes the table, its sub-tables and dotted or inline keys, and nothing similar', () => {
  const text = [
    'model = "x"',
    'mcp_servers.jevris.command = "node"',
    '',
    '[mcp_servers]',
    'jevris = { command = "node" }',
    'docs = { command = "docs" }',
    '',
    '[mcp_servers.jevris]',
    'command = "node"',
    '',
    '[mcp_servers.jevris.env]',
    'X = "1"',
    '',
    '[[mcp_servers.jevris.tools]]',
    'name = "a"',
    '',
    '# describes jevris2',
    '[mcp_servers.jevris2]',
    'command = "keep"',
    '',
  ].join('\n');
  const removed = removeTomlTables(text, JEVRIS);
  assert.equal(removed, [
    'model = "x"',
    '',
    '[mcp_servers]',
    'docs = { command = "docs" }',
    '',
    '# describes jevris2',
    '[mcp_servers.jevris2]',
    'command = "keep"',
    '',
  ].join('\n'));
});

test('an unterminated string or bracket makes the scan fail instead of guessing', () => {
  assert.equal(scanToml('a = "open\n'), null);
  assert.equal(scanToml('a = [1, 2\n'), null);
  assert.equal(scanToml('a = """never closed\n'), null);
  assert.equal(removeTomlTables('a = [\n', JEVRIS), null);
});

test('tomlString escapes Windows paths and quotes as a TOML basic string', () => {
  assert.equal(tomlString('C:\\Users\\me\\a "b".js'), '"C:\\\\Users\\\\me\\\\a \\"b\\".js"');
});

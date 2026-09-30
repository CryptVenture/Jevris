import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { shellQuote } from '../dist/index.js';

test('POSIX: a value made only of safe characters prints exactly as it is', () => {
  for (const plain of ['abc', '/usr/local/lib/jevris', 'jevris.memory@1.0.0', 'a-b_c=d:e,f+g%h', './packs/memory', 'C:/x/y']) {
    assert.equal(shellQuote(plain, 'linux'), plain);
    assert.equal(shellQuote(plain, 'darwin'), plain);
  }
});

test('POSIX: a value with a space or a shell metacharacter is single-quoted', () => {
  assert.equal(shellQuote('/Volumes/WOB Ext Drive/Jevris/packs/memory', 'darwin'), "'/Volumes/WOB Ext Drive/Jevris/packs/memory'");
  assert.equal(shellQuote('a$b', 'linux'), "'a$b'");
  assert.equal(shellQuote('`x`', 'linux'), "'`x`'");
  assert.equal(shellQuote('~/x', 'linux'), "'~/x'");
  assert.equal(shellQuote('a;b', 'linux'), "'a;b'");
  assert.equal(shellQuote('a"b', 'linux'), `'a"b'`);
  assert.equal(shellQuote('', 'linux'), "''");
});

test('POSIX: an embedded single quote becomes the four characters quote, backslash, quote, quote', () => {
  assert.equal(shellQuote("it's here", 'linux'), `'it'\\''s here'`);
  assert.equal(shellQuote("'", 'linux'), `''\\'''`);
});

test('POSIX: the quoted form reads back as the same single argument through a real shell', { skip: process.platform === 'win32' }, () => {
  for (const value of ['plain', 'with space', "it's", 'a$HOME`id`;b', '~', '*', 'two  spaces', '-n', '']) {
    const ran = spawnSync('/bin/sh', ['-c', `printf %s ${shellQuote(value, 'linux')}`], { encoding: 'utf8' });
    assert.equal(ran.stdout, value, JSON.stringify(value));
  }
});

test('Windows: a value made only of safe characters prints exactly as it is, backslashes included', () => {
  for (const plain of ['abc', 'C:\\Users\\ada\\jevris', 'C:/x/y', 'jevris.memory@1.0.0']) {
    assert.equal(shellQuote(plain, 'win32'), plain);
  }
});

test('Windows: a value with a space or metacharacter is double-quoted', () => {
  assert.equal(shellQuote('C:\\Program Files\\Jevris\\packs\\memory', 'win32'), '"C:\\Program Files\\Jevris\\packs\\memory"');
  assert.equal(shellQuote('a&b', 'win32'), '"a&b"');
  assert.equal(shellQuote('a(b)', 'win32'), '"a(b)"');
  assert.equal(shellQuote('', 'win32'), '""');
});

test('Windows: an embedded double quote is backslash-escaped and a trailing backslash run is doubled', () => {
  assert.equal(shellQuote('say "hi"', 'win32'), '"say \\"hi\\""');
  assert.equal(shellQuote('C:\\My Dir\\', 'win32'), '"C:\\My Dir\\\\"');
  assert.equal(shellQuote('a\\"b c', 'win32'), '"a\\\\\\"b c"');
});

test('the default platform is the running one', () => {
  assert.equal(shellQuote('a b'), shellQuote('a b', process.platform));
});

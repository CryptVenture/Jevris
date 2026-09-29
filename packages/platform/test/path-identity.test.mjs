import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hasParentSegment,
  isAbsoluteFor,
  isAbsoluteOnAnyPlatform,
  isInsideOrSame,
  isStrictlyInside,
  pathKey,
  sameFile,
  samePath,
} from '../dist/index.js';

test('win32 absolute checks accept drive letters, UNC and verbatim paths (BLD-07)', () => {
  for (const path of ['C:\\Program Files (x86)\\x.exe', 'c:/tools/x.exe', '\\\\server\\share\\x', '\\\\?\\C:\\long\\path']) {
    assert.equal(isAbsoluteFor(path, 'win32'), true, path);
  }
  assert.equal(isAbsoluteFor('tools\\x.exe', 'win32'), false);
  assert.equal(isAbsoluteFor('C:\\x', 'linux'), false, 'a drive path is relative on POSIX');
  assert.equal(isAbsoluteFor('/usr/bin/git', 'linux'), true);
  assert.equal(isAbsoluteFor('', 'linux'), false);
  assert.equal(isAbsoluteFor('/a\0b', 'linux'), false);
});

test('refusing absolute ids refuses both families (BLD-07)', () => {
  assert.equal(isAbsoluteOnAnyPlatform('/etc/passwd'), true);
  assert.equal(isAbsoluteOnAnyPlatform('C:\\Windows'), true);
  assert.equal(isAbsoluteOnAnyPlatform('\\\\server\\share'), true);
  assert.equal(isAbsoluteOnAnyPlatform('fixtures/evidence/a.json'), false);
  assert.equal(hasParentSegment('a\\..\\b'), true);
  assert.equal(hasParentSegment('a/..b/c'), false);
});

test('identity case-folds on win32 and darwin but not linux (BLD-07)', () => {
  assert.equal(samePath('C:\\Users\\Ada\\', 'c:\\users\\ada', 'win32'), true);
  assert.equal(samePath('/Users/Ada', '/users/ada', 'darwin'), true);
  assert.equal(samePath('/home/Ada', '/home/ada', 'linux'), false);
  assert.equal(pathKey('/a/b/', 'linux'), '/a/b');
  assert.equal(pathKey('/', 'linux'), '/');
  assert.equal(pathKey('C:\\', 'win32'), 'c:\\');
});

test('containment compares keys and refuses other drives (BLD-07)', () => {
  assert.equal(isInsideOrSame('C:\\Users\\Ada', 'c:\\users\\ada\\.jevris', 'win32'), true);
  assert.equal(isInsideOrSame('C:\\Users\\Ada', 'D:\\Users\\Ada\\.jevris', 'win32'), false);
  assert.equal(isInsideOrSame('/home/ada', '/home/ada2', 'linux'), false);
  assert.equal(isStrictlyInside('/home/ada', '/home/ada', 'linux'), false);
  assert.equal(isStrictlyInside('/home/ada', '/home/ada/x', 'linux'), true);
  // A child whose name starts with two dots is inside; only a `..` segment leaves.
  assert.equal(isInsideOrSame('/home/ada', '/home/ada/..cache', 'linux'), true);
  assert.equal(isInsideOrSame('C:\\Users\\Ada', 'C:\\Users\\Ada\\..cache', 'win32'), true);
  assert.equal(isInsideOrSame('/home/ada', '/home/ada/../bob', 'linux'), false);
});

test('sameFile resolves through realpath.native (BLD-07)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jpi-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'x');
  assert.equal(sameFile(file, join(dir, '.', 'f.txt')), true);
  assert.equal(sameFile(file, join(dir, 'missing.txt')), false);
  const calls = [];
  const realpath = (path) => {
    calls.push(path);
    return path.toUpperCase();
  };
  assert.equal(sameFile('C:\\a', 'c:\\A', { platform: 'win32', realpath }), true);
  assert.deepEqual(calls, ['C:\\a', 'c:\\A']);
});

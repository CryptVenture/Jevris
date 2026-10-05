// JEV-0075: a script that writes an evidence record says why `durableWrite` refused it, with the platform's code and a fixed sentence that says what to do.
// `durableWriteRefusal` builds that text. It is platform-independent: the codes are the ones the helper returns, driven here through injected file-system
// calls, so every case runs on every host (a real symbolic link needs a privilege on Windows, so the script's own test covers that one end to end).
import test from 'node:test';
import assert from 'node:assert/strict';
import { durableWrite, durableWriteRefusal } from '../dist/index.js';

const fsThat = (over) => ({
  lstat: async () => {
    throw Object.assign(new Error('ENOENT: no such file /home/me/secret/path'), { code: 'ENOENT' });
  },
  readdir: async () => [],
  open: async () => ({ writeFile: async () => undefined, sync: async () => undefined, close: async () => undefined }),
  rename: async () => undefined,
  rm: async () => undefined,
  ...over,
});
const noSleep = async () => undefined;

test('every code durableWrite can return has a sentence of its own that says what to do, led by the code', async () => {
  const link = { isSymbolicLink: () => true, isFile: () => false, mtimeMs: 0 };
  const refused = {
    ESYMLINK: await durableWrite('/tmp/x.json', 'x', { platform: 'linux', fs: fsThat({ lstat: async () => link }) }),
    ELSTAT: await durableWrite('/data/x.json', 'x', { platform: 'linux', fs: fsThat({ lstat: async () => Promise.reject(Object.assign(new Error('boom /home/me'), { code: 'EIO' })) }) }),
    EINVAL: await durableWrite('', 'x', { platform: 'linux', fs: fsThat({}) }),
    EACL: await durableWrite('/data/x.json', 'x', { platform: 'linux', fs: fsThat({}), beforeRename: () => false }),
    EACCES: await durableWrite('/data/x.json', 'x', { platform: 'linux', fs: fsThat({ rename: async () => Promise.reject(Object.assign(new Error('denied /home/me'), { code: 'EACCES' })) }), retries: 0, sleep: noSleep }),
    ENOENT: await durableWrite('/data/x.json', 'x', { platform: 'linux', fs: fsThat({ open: async () => Promise.reject(Object.assign(new Error('missing /home/me'), { code: 'ENOENT' })) }) }),
    ENOSPC: await durableWrite('/data/x.json', 'x', { platform: 'linux', fs: fsThat({ open: async () => Promise.reject(Object.assign(new Error('full /home/me'), { code: 'ENOSPC' })) }) }),
  };
  const general = durableWriteRefusal({ ok: false, code: 'EUNKNOWN' });
  for (const [code, result] of Object.entries(refused)) {
    assert.deepEqual([result.ok, result.code], [false, code], `the helper returned ${JSON.stringify(result)} for ${code}`);
    const text = durableWriteRefusal(result);
    assert.ok(text.startsWith(`${code}: `), text);
    assert.notEqual(text.slice(code.length + 2), general.slice('EUNKNOWN: '.length), `${code} has no sentence of its own`);
    assert.equal(text.includes('/home/me'), false, `${code}: a path in the text`);
  }
  // The link case says what it is and what to do: name the real path.
  assert.match(durableWriteRefusal(refused.ESYMLINK), /^ESYMLINK: the file, or the folder it is in, is a symbolic link \(on macOS \/tmp is one\); name the real path, such as \/private\/tmp\/\.\.\., or a path with no link$/);
});

test('the text is the code and fixed words: a code that is not a code, a message or a path is never echoed, and a write that worked has no text', () => {
  assert.equal(durableWriteRefusal({ ok: true }), '');
  const general = 'EUNKNOWN: the platform refused the write; the code is the one it returned';
  for (const code of ['', 'eacces', 'EACCES: permission denied, open /home/me/x.json', '/home/me/x.json', 'E', `E${'A'.repeat(40)}`, 'EACCES\nEPERM', 'C:\\Users\\me\\x.json']) {
    const text = durableWriteRefusal({ ok: false, code });
    assert.equal(text, general, JSON.stringify(code));
    assert.equal(/[\\/]/.test(text), false, `${JSON.stringify(code)}: a path in the text`);
  }
  // A code the table does not know is shown as the platform gave it, with the general sentence.
  assert.equal(durableWriteRefusal({ ok: false, code: 'EMFILE' }), 'EMFILE: the platform refused the write; the code is the one it returned');
});

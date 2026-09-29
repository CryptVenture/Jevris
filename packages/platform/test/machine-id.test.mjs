import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hostnameCandidates,
  machineIdentity,
  parseIoregPlatformUuid,
  parseMachineIdFile,
  parseRegMachineGuid,
  readMachineIdentity,
} from '../dist/index.js';

// DATA-10: the stable machine id behind the store's host scope. Every system query is a
// fixture here; no test runs ioreg, reg.exe, whoami.exe or scutil.

const UUID = '4C4C4544-0042-3510-8052-B7C04F4E3732';
const IOREG = `+-o J316sAP  <class IOPlatformExpertDevice, id 0x100000223, registered, matched, active, busy 0 (1 ms), retain 42>
    {
      "IOPolledInterface" = "AppleARMWatchdogTimerHibernateHandler is not serializable"
      "IOPlatformSerialNumber" = "XXXXXXXXXX"
      "IOPlatformUUID" = "${UUID.toLowerCase()}"
      "model" = <"MacBookPro18,2">
    }
`;
const MACHINE_ID = 'b08dfa6083e7567a1921a715000001fb';
const GUID = '6f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8';
const REG = `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    ${GUID.toUpperCase()}\r\n\r\n`;
const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const WHOAMI = `"desktop-ada\\ada","${SID}"\r\n`;

/** An exec port answering from a table of `file args` keys, recording each call. */
function fakeExec(table) {
  const calls = [];
  const exec = (file, args) => {
    const key = [file, ...args].join(' ');
    calls.push(key);
    const answer = table[key];
    return answer === undefined ? { status: 1, stdout: '' } : typeof answer === 'string' ? { status: 0, stdout: answer } : answer;
  };
  return { exec, calls };
}

test('parsers accept the real output shapes and refuse placeholders (DATA-10)', () => {
  assert.equal(parseIoregPlatformUuid(IOREG), UUID);
  assert.equal(parseIoregPlatformUuid('"IOPlatformUUID" = "00000000-0000-0000-0000-000000000000"'), null);
  assert.equal(parseIoregPlatformUuid('"IOPlatformUUID" = "not-a-uuid"'), null);
  assert.equal(parseIoregPlatformUuid(''), null);

  assert.equal(parseMachineIdFile(`${MACHINE_ID}\n`), MACHINE_ID);
  assert.equal(parseMachineIdFile(MACHINE_ID.toUpperCase()), MACHINE_ID);
  assert.equal(parseMachineIdFile('uninitialized\n'), null);
  assert.equal(parseMachineIdFile(`${'0'.repeat(32)}\n`), null);
  assert.equal(parseMachineIdFile(''), null);

  assert.equal(parseRegMachineGuid(REG), GUID);
  assert.equal(parseRegMachineGuid('ERROR: The system was unable to find the specified registry key or value.\r\n'), null);
});

test('macOS reads IOPlatformUUID from ioreg by absolute path, with the uid (DATA-10)', () => {
  const { exec, calls } = fakeExec({ '/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice': IOREG });
  const identity = readMachineIdentity({ platform: 'darwin', exec, uid: 501 });
  assert.deepEqual(identity, { ok: true, machineId: UUID, source: 'ioplatformuuid', user: 'uid:501' });
  assert.deepEqual(calls, ['/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice']);
});

test('macOS retries ioreg once, then reports the id unreadable (DATA-10)', () => {
  let n = 0;
  const flaky = () => (++n === 1 ? { status: null, stdout: '' } : { status: 0, stdout: IOREG });
  assert.equal(readMachineIdentity({ platform: 'darwin', exec: flaky, uid: 501 }).ok, true);
  assert.equal(n, 2);
  const { exec, calls } = fakeExec({});
  assert.deepEqual(readMachineIdentity({ platform: 'darwin', exec, uid: 501 }), { ok: false, reason: 'machine-id-unreadable' });
  assert.equal(calls.length, 2);
});

test('Linux reads /etc/machine-id, else the D-Bus copy (DATA-10)', () => {
  const files = { '/etc/machine-id': `${MACHINE_ID}\n` };
  const readFile = (path) => {
    if (!(path in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return files[path];
  };
  assert.deepEqual(readMachineIdentity({ platform: 'linux', readFile, uid: 1000 }), { ok: true, machineId: MACHINE_ID, source: 'etc-machine-id', user: 'uid:1000' });

  delete files['/etc/machine-id'];
  files['/var/lib/dbus/machine-id'] = MACHINE_ID;
  assert.deepEqual(readMachineIdentity({ platform: 'linux', readFile, uid: 1000 }), { ok: true, machineId: MACHINE_ID, source: 'dbus-machine-id', user: 'uid:1000' });

  // An empty first-boot file is not an id; the D-Bus copy is used.
  files['/etc/machine-id'] = '\n';
  assert.equal(readMachineIdentity({ platform: 'linux', readFile, uid: 1000 }).source, 'dbus-machine-id');

  delete files['/var/lib/dbus/machine-id'];
  assert.deepEqual(readMachineIdentity({ platform: 'linux', readFile, uid: 1000 }), { ok: false, reason: 'machine-id-unreadable' });
  assert.deepEqual(readMachineIdentity({ platform: 'linux', readFile: () => MACHINE_ID, uid: null }), { ok: false, reason: 'user-unknown' });
});

test('Windows reads MachineGuid with reg.exe (64-bit view first) and the SID with whoami (DATA-10)', () => {
  const { exec, calls } = fakeExec({
    'reg.exe query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid /reg:64': REG,
    'whoami.exe /user /fo csv /nh': WHOAMI,
  });
  assert.deepEqual(readMachineIdentity({ platform: 'win32', exec }), { ok: true, machineId: GUID, source: 'machineguid', user: `sid:${SID}` });
  assert.deepEqual(calls, ['reg.exe query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid /reg:64', 'whoami.exe /user /fo csv /nh']);

  // A 32-bit Windows without the /reg:64 switch answers the plain query.
  const plain = fakeExec({ 'reg.exe query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid': REG, 'whoami.exe /user /fo csv /nh': WHOAMI });
  assert.equal(readMachineIdentity({ platform: 'win32', exec: plain.exec }).machineId, GUID);

  const noUser = fakeExec({ 'reg.exe query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid /reg:64': REG });
  assert.deepEqual(readMachineIdentity({ platform: 'win32', exec: noUser.exec }), { ok: false, reason: 'user-unknown' });
  const noGuid = fakeExec({ 'whoami.exe /user /fo csv /nh': WHOAMI });
  assert.deepEqual(readMachineIdentity({ platform: 'win32', exec: noGuid.exec }), { ok: false, reason: 'machine-id-unreadable' });
});

test('an unsupported platform has no machine id (DATA-10)', () => {
  assert.deepEqual(readMachineIdentity({ platform: 'aix', exec: () => ({ status: 0, stdout: IOREG }) }), { ok: false, reason: 'platform-unsupported' });
});

test('under JEVRIS_TEST the cached identity is the test machine and never queries the system (DATA-10)', () => {
  assert.equal(process.env.JEVRIS_TEST, '1');
  const first = machineIdentity();
  assert.equal(first.ok, true);
  assert.equal(first.source, 'test');
  assert.equal(machineIdentity(), first, 'read once per process');
});

test('host-name candidates: os.hostname, LocalHostName with and without .local, ComputerName (DATA-10)', () => {
  const { exec, calls } = fakeExec({
    '/usr/sbin/scutil --get LocalHostName': 'Devs-Macbook-Pro\n',
    '/usr/sbin/scutil --get ComputerName': "Dev's MacBook Pro\n",
  });
  const names = hostnameCandidates({ platform: 'darwin', exec, hostname: () => 'dhcp-10-0-0-7.example.net' });
  assert.deepEqual(names, ['dhcp-10-0-0-7.example.net', 'Devs-Macbook-Pro', 'Devs-Macbook-Pro.local', "Dev's MacBook Pro"]);
  assert.deepEqual(calls, ['/usr/sbin/scutil --get LocalHostName', '/usr/sbin/scutil --get ComputerName']);

  const local = hostnameCandidates({ platform: 'darwin', exec: fakeExec({}).exec, hostname: () => 'Devs-Macbook-Pro.local' });
  assert.deepEqual(local, ['Devs-Macbook-Pro.local', 'Devs-Macbook-Pro']);

  // Linux and Windows have one name; scutil is never run there, nor under JEVRIS_TEST.
  const none = fakeExec({});
  assert.deepEqual(hostnameCandidates({ platform: 'linux', exec: none.exec, hostname: () => 'box' }), ['box']);
  assert.deepEqual(none.calls, []);
  assert.deepEqual(hostnameCandidates({ platform: 'darwin', hostname: () => 'mac' }), ['mac']);
});

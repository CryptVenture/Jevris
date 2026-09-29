// K21 `codex.usage-read` (feature access.usage-read; coordinator decision DOMAINS 3298853d): the
// OS isolation, its checks from inside, the stub-only traffic and the fail-closed paths. A
// stand-in app-server (a node script) plays Codex; no test starts a real codex. Temp folders only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const k21 = await import('../dist/usage-read-case.js');
const { usageReadCheck } = await import('../dist/certification.js');

async function withBox(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'jevris-k21-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// The stand-in: an app-server that reads the case's config.toml and auth.json the way Codex does,
// asks the stub for the usage, and answers account/rateLimits/read in Codex's v2 shape.
// argv[2] picks a misbehaviour: ok, foreign (a request with another Host), wrong (other numbers).
const STAND_IN = `
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const mode = process.argv[2] || 'ok';
const home = process.env.CODEX_HOME;
const base = /chatgpt_base_url = "([^"]+)"/.exec(readFileSync(join(home, 'config.toml'), 'utf8'))[1];
const auth = JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8'));
const get = (url, headers) => new Promise((resolve, reject) => {
  http.get(url, { headers }, (res) => { let text = ''; res.on('data', (c) => (text += c)); res.on('end', () => resolve(JSON.parse(text))); }).on('error', reject);
});
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\\n')) !== -1) {
    const m = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    if (m.method === 'initialize') out({ id: m.id, result: { userAgent: 'stand-in' } });
    if (m.method !== 'account/rateLimits/read') continue;
    if (mode === 'foreign') await get(base + '/wham/other', { host: 'chatgpt.com' }).catch(() => null);
    const body = await get(base + '/wham/usage', { authorization: 'Bearer ' + auth.tokens.access_token, 'chatgpt-account-id': auth.tokens.account_id });
    const w = (x) => ({ usedPercent: mode === 'wrong' ? 99 : x.used_percent, windowDurationMins: Math.ceil(x.limit_window_seconds / 60), resetsAt: x.reset_at });
    out({ id: m.id, result: { ordinaryUsageAllowed: body.account_id === auth.tokens.account_id ? body.rate_limit.allowed : null, rateLimits: { primary: w(body.rate_limit.primary_window), secondary: w(body.rate_limit.secondary_window), planType: body.plan_type } } });
  }
});
`;

async function standIn(dir, mode = 'ok') {
  const script = join(dir, 'stand-in.mjs');
  await writeFile(script, STAND_IN);
  return { file: process.execPath, args: [script, mode] };
}

const run = (file, args) => new Promise((resolve) => execFile(file, args, { timeout: 15_000 }, (error, stdout) => resolve({ code: error ? (error.code ?? 1) : 0, stdout })));

/** Whether this machine can set up the isolation at all (a nested sandbox or disabled user namespaces cannot). */
async function isolationWorks() {
  if (process.platform === 'darwin') return (await run(k21.SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true'])).code === 0;
  if (process.platform === 'linux') {
    for (const path of k21.UNSHARE_PATHS) if ((await run(path, [...k21.LINUX_UNSHARE_ARGS, '/bin/true'])).code === 0) return true;
  }
  return false;
}

async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const leftovers = async (dir) => (await readdir(dir).catch(() => [])).filter((name) => name.startsWith('k21-'));

test('the macOS profile: every network operation denied but the stub\'s one loopback port; no unix-socket allow; the name-resolving mach services denied by name', async () => {
  const profile = k21.darwinUsageReadProfile(51234);
  assert.match(profile, /^\(version 1\)/);
  assert.match(profile, /\(deny network\*\)/);
  const allows = profile.split('\n').filter((line) => line.startsWith('(allow network'));
  assert.deepEqual(allows, ['(allow network-outbound (remote ip "localhost:51234"))', '(allow network-bind (local ip "localhost:51234"))', '(allow network-inbound (local ip "localhost:51234"))'], "B's MEDIUM 47: one port, never localhost:*");
  assert.doesNotMatch(profile, /unix-socket|:\*|"\*"/, 'no unix-socket allow and no wildcard host or port');
  for (const bad of [0, 80, 1023, 65536, 1.5, Number.NaN, '5000']) assert.throws(() => k21.darwinUsageReadProfile(bad), /invalid port/, String(bad));
  const port = await k21.freeLoopbackPort();
  assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
  for (const name of ['com.apple.dnssd.service', 'com.apple.mDNSResponder', 'com.apple.networkd', 'com.apple.nsurlsessiond', 'com.apple.trustd.agent', 'com.apple.SystemConfiguration.DNSConfiguration']) {
    assert.ok(profile.includes(`(global-name "${name}")`), `${name} is denied`);
  }
  assert.ok(profile.includes('(global-name-prefix "com.apple.dnssd.")'));
  assert.deepEqual(k21.LINUX_UNSHARE_ARGS, ['--user', '--map-root-user', '--net']);
});

test('the isolation per OS: sandbox-exec, unshare, or none; never a plain spawn', async () => {
  const has = (paths) => async (path) => paths.includes(path);
  assert.deepEqual(await k21.usageReadIsolation('darwin', '/p.sb', has([k21.SANDBOX_EXEC])), { ok: true, file: k21.SANDBOX_EXEC, args: ['-f', '/p.sb'] });
  assert.deepEqual(await k21.usageReadIsolation('darwin', '/p.sb', has([])), { ok: false, reason: 'NO_SANDBOX_EXEC' });
  assert.deepEqual(await k21.usageReadIsolation('linux', '/p.sb', has(['/bin/unshare'])), { ok: true, file: '/bin/unshare', args: k21.LINUX_UNSHARE_ARGS });
  assert.deepEqual(await k21.usageReadIsolation('linux', '/p.sb', has([])), { ok: false, reason: 'NO_UNSHARE' });
  assert.deepEqual(await k21.usageReadIsolation('win32', '/p.sb', has([k21.SANDBOX_EXEC])), { ok: false, reason: 'NO_OS_ISOLATION' });
});

// The Linux RC6 run in Docker Desktop (coordinator's decision): a new namespace also holds the
// kernel's fallback tunnel devices, down, with no address and no route. The shapes below are the
// `ip -j` output that run printed.
test("Linux interfaces: lo, plus only the kernel's fallback tunnel devices while down with no address and no route", () => {
  const verdict = k21.linuxInterfaceVerdict;
  const FALLBACK = ['tunl0', 'gre0', 'gretap0', 'erspan0', 'ip_vti0', 'ip6_vti0', 'sit0', 'ip6tnl0', 'ip6gre0'];
  assert.deepEqual(k21.LINUX_FALLBACK_INTERFACES, FALLBACK);
  const lo = { ifname: 'lo', flags: ['LOOPBACK', 'UP', 'LOWER_UP'], operstate: 'UNKNOWN' };
  const loAddr = { ...lo, addr_info: [{ family: 'inet', local: '127.0.0.1' }, { family: 'inet6', local: '::1' }] };
  const down = (ifname) => ({ ifname, flags: ['NOARP'], operstate: 'DOWN' });
  const links = [lo, ...FALLBACK.map(down)];
  const addrs = [loAddr, ...FALLBACK.map((ifname) => ({ ...down(ifname), addr_info: [] }))];
  const routes = [{ dst: '127.0.0.0/8', dev: 'lo', table: 'local', type: 'local' }, { dst: '::1', dev: 'lo', table: 'local', type: 'local' }];
  const names = ['lo', ...FALLBACK];
  assert.equal(verdict(['lo'], null, null, null), null, 'lo alone needs no ip state');
  assert.equal(verdict(names, links, addrs, routes), null, 'the Docker Desktop namespace');
  assert.deepEqual(verdict(['tunl0'], links, addrs, routes), { isolation: 'violated', reason: 'NO_LOOPBACK' });
  assert.deepEqual(verdict([], [], [], []), { isolation: 'violated', reason: 'NO_LOOPBACK' });
  for (const other of ['eth0', 'veth0', 'tun0', 'wg0', 'tunl1', 'gre1', 'TUNL0', 'sit0 ']) {
    assert.deepEqual(verdict([...names, other], [...links, down(other)], [...addrs, { ...down(other), addr_info: [] }], routes), { isolation: 'violated', reason: 'OTHER_INTERFACE' }, other);
  }
  const swap = (list, name, change) => list.map((item) => (item.ifname === name ? { ...item, ...change } : item));
  assert.deepEqual(verdict(names, swap(links, 'sit0', { flags: ['NOARP', 'UP'] }), addrs, routes), { isolation: 'violated', reason: 'FALLBACK_INTERFACE_UP' });
  assert.deepEqual(verdict(names, swap(links, 'gre0', { operstate: 'UNKNOWN' }), addrs, routes), { isolation: 'violated', reason: 'FALLBACK_INTERFACE_UP' });
  assert.deepEqual(verdict(names, swap(links, 'gre0', { flags: undefined }), addrs, routes), { isolation: 'violated', reason: 'FALLBACK_INTERFACE_UP' });
  assert.deepEqual(verdict(names, links, swap(addrs, 'ip6tnl0', { addr_info: [{ family: 'inet6', local: 'fe80::1' }] }), routes), { isolation: 'violated', reason: 'FALLBACK_INTERFACE_ADDRESS' });
  assert.deepEqual(verdict(names, links, swap(addrs, 'tunl0', { addr_info: [{ family: 'inet', local: '10.0.0.1' }] }), routes), { isolation: 'violated', reason: 'FALLBACK_INTERFACE_ADDRESS' });
  assert.deepEqual(verdict(names, links, [...routes, { dst: 'default', dev: 'gretap0' }]), { isolation: 'unavailable', reason: 'INTERFACE_STATE_UNREADABLE' }, 'a missing argument is unreadable');
  assert.deepEqual(verdict(names, links, addrs, [...routes, { dst: 'default', dev: 'gretap0' }]), { isolation: 'violated', reason: 'FALLBACK_INTERFACE_ROUTE' });
  assert.deepEqual(verdict(names, links, addrs, [...routes, null]), { isolation: 'violated', reason: 'FALLBACK_INTERFACE_ROUTE' }, 'an unreadable route entry is never waved through');
  for (const [label, l, a, r] of [['links', null, addrs, routes], ['addresses', links, null, routes], ['routes', links, addrs, null]]) {
    assert.deepEqual(verdict(names, l, a, r), { isolation: 'unavailable', reason: 'INTERFACE_STATE_UNREADABLE' }, `unreadable ${label}`);
  }
  assert.deepEqual(verdict(names, links.filter((item) => item.ifname !== 'erspan0'), addrs, routes), { isolation: 'unavailable', reason: 'INTERFACE_STATE_UNREADABLE' }, 'a device ip does not list');
  // The runner embeds the function's own source: it must work with nothing outside itself.
  const standalone = new Function(`return (${verdict.toString()});`)();
  assert.equal(standalone(names, links, addrs, routes), null);
  assert.deepEqual(standalone([...names, 'eth0'], links, addrs, routes), { isolation: 'violated', reason: 'OTHER_INTERFACE' });
  assert.ok(k21.USAGE_READ_RUNNER.includes(`const linuxInterfaceVerdict = ${verdict.toString()};`));
});

test('Windows and a refused isolation are ACCESS_USAGE_ISOLATION_UNAVAILABLE (unsupported), never a pass; the case folder is removed', async () => {
  await withBox(async (dir) => {
    const windows = await k21.codexUsageReadCase({ env: { PATH: process.env.PATH }, profile: dir, platform: 'win32', command: await standIn(dir) });
    assert.deepEqual([windows.id, windows.passed, windows.reasonCode], ['codex.usage-read', false, 'ACCESS_USAGE_ISOLATION_UNAVAILABLE']);
    // The isolation tool exists but refuses to start (a nested sandbox, user namespaces off): no runner line.
    const refused = await k21.codexUsageReadCase({ env: { PATH: process.env.PATH }, profile: dir, command: await standIn(dir), isolation: async () => ({ ok: true, file: process.execPath, args: ['-e', 'process.exit(71)'] }) });
    assert.deepEqual([refused.passed, refused.reasonCode], [false, 'ACCESS_USAGE_ISOLATION_UNAVAILABLE']);
    assert.deepEqual(await leftovers(dir), [], 'the dummy login and the case folder are gone');
    const feature = usageReadCheck(windows);
    assert.deepEqual([feature.featureId, feature.passed, feature.reasonCode], ['access.usage-read', false, 'ACCESS_USAGE_ISOLATION_UNAVAILABLE']);
  });
});

test('a violated isolation fails the case: an outbound connect that is not refused at once is ISOLATION_VIOLATED', { skip: process.platform === 'win32' }, async () => {
  await withBox(async (dir) => {
    // No isolation at all (the runner under /usr/bin/env): the check inside must catch it. The
    // probe is a closed loopback port, so nothing leaves the machine even here.
    const port = await closedPort();
    const violated = await k21.codexUsageReadCase({ env: { PATH: process.env.PATH }, profile: dir, command: await standIn(dir), isolation: async () => ({ ok: true, file: '/usr/bin/env', args: [] }), probes: [['127.0.0.1', port]] });
    const feature = usageReadCheck(violated);
    if (process.platform === 'linux' && violated.reasonCode === 'ACCESS_USAGE_ISOLATION_UNAVAILABLE') {
      // Outside a namespace, a user without CAP_NET_ADMIN cannot bring lo up (the Linux RC6 run):
      // the runner stops at LOOPBACK_DOWN before any probe. Unavailable, never a pass.
      assert.match(violated.detail, /LOOPBACK_DOWN/);
      assert.deepEqual([violated.passed, feature.passed, feature.reasonCode], [false, false, 'ACCESS_USAGE_ISOLATION_UNAVAILABLE']);
    } else {
      assert.deepEqual([violated.passed, violated.reasonCode], [false, 'ISOLATION_VIOLATED']);
      // On Linux as root, the host's own interfaces fail first; elsewhere the outbound probe does.
      assert.match(violated.detail, process.platform === 'linux' ? /OTHER_INTERFACE|OUTBOUND_ECONNREFUSED/ : /OUTBOUND_ECONNREFUSED/);
      assert.deepEqual([feature.passed, feature.reasonCode], [false, 'ACCESS_USAGE_CASE_FAILED']);
    }
    assert.deepEqual(await leftovers(dir), []);
  });
});

test('certify maps the case: a pass certifies; a missing case is not run; any failure is ACCESS_USAGE_CASE_FAILED', () => {
  assert.deepEqual(usageReadCheck(undefined).reasonCode, 'ACCESS_USAGE_CASE_NOT_RUN');
  assert.equal(usageReadCheck({ id: 'codex.usage-read', passed: true, reasonCode: null, detail: 'x' }).passed, true);
  for (const code of ['ISOLATION_VIOLATED', 'STUB_FOREIGN_REQUEST', 'USAGE_FIELDS_MISMATCH', 'CASE_INCOMPLETE']) {
    assert.deepEqual([usageReadCheck({ id: 'codex.usage-read', passed: false, reasonCode: code, detail: 'x' }).reasonCode], ['ACCESS_USAGE_CASE_FAILED'], code);
  }
});

test('under the real OS isolation (a stand-in, not codex): outbound refused, loopback works, names do not resolve; the read passes only through the stub', async (t) => {
  if (!(await isolationWorks())) {
    // This machine cannot isolate (Windows, a nested sandbox, user namespaces off): the case says so.
    await withBox(async (dir) => {
      const out = await k21.codexUsageReadCase({ env: { PATH: process.env.PATH }, profile: dir, command: await standIn(dir) });
      assert.deepEqual([out.passed, out.reasonCode], [false, 'ACCESS_USAGE_ISOLATION_UNAVAILABLE']);
    });
    t.diagnostic('OS network isolation is not available here; only the unavailable path was checked');
    return;
  }
  await withBox(async (dir) => {
    if (process.platform === 'darwin') {
      // The profile itself, with a stand-in process: a documentation address is refused at once.
      // A local listener on another loopback port stands for a proxy or agent on 127.0.0.1 (MEDIUM 47).
      const other = net.createServer((socket) => socket.destroy());
      await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
      const port = await k21.freeLoopbackPort();
      const profileFile = join(dir, 'p.sb');
      await writeFile(profileFile, k21.darwinUsageReadProfile(port));
      const probe = join(dir, 'probe.mjs');
      await writeFile(probe, `
import net from 'node:net'; import dns from 'node:dns'; import http from 'node:http';
const [port, other] = process.argv.slice(2).map(Number);
const conn = (host, p) => new Promise((res) => { const s = net.connect({ host, port: p }); s.once('connect', () => { s.destroy(); res('CONNECTED'); }); s.once('error', (e) => res(e.code)); setTimeout(() => res('TIMEOUT'), 2000); });
const srv = http.createServer((q, r) => r.end('ok')); await new Promise((r) => srv.listen(port, '127.0.0.1', r));
const out = { v4: await conn('192.0.2.1', 9), v6: await conn('2001:db8::1', 9), stub: await conn('127.0.0.1', port), otherLoopback: await conn('127.0.0.1', other), unix: await new Promise((res) => { const u = net.createConnection('/var/run/mDNSResponder'); u.on('connect', () => { u.destroy(); res('CONNECTED'); }); u.on('error', (e) => res(e.code)); }), dns: await dns.promises.lookup('example.com').then(() => 'RESOLVED', () => 'FAILED') };
srv.close(); console.log(JSON.stringify(out));
`);
      const ran = await run(k21.SANDBOX_EXEC, ['-f', profileFile, process.execPath, probe, String(port), String(other.address().port)]);
      await new Promise((resolve) => other.close(resolve));
      assert.deepEqual(JSON.parse(ran.stdout), { v4: 'EPERM', v6: 'EPERM', stub: 'CONNECTED', otherLoopback: 'EPERM', unix: 'EPERM', dns: 'FAILED' });
    }
    const passed = await k21.codexUsageReadCase({ env: { PATH: process.env.PATH }, profile: dir, command: await standIn(dir, 'ok') });
    assert.deepEqual([passed.passed, passed.reasonCode], [true, null], passed.detail);
    assert.equal(usageReadCheck(passed).passed, true);
    const foreign = await k21.codexUsageReadCase({ env: { PATH: process.env.PATH }, profile: dir, command: await standIn(dir, 'foreign') });
    assert.deepEqual([foreign.passed, foreign.reasonCode], [false, 'STUB_FOREIGN_REQUEST']);
    const wrong = await k21.codexUsageReadCase({ env: { PATH: process.env.PATH }, profile: dir, command: await standIn(dir, 'wrong') });
    assert.deepEqual([wrong.passed, wrong.reasonCode], [false, 'USAGE_FIELDS_MISMATCH']);
    assert.deepEqual(await leftovers(dir), []);
  });
});

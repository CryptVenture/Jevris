/**
 * K21 `codex.usage-read` (feature `access.usage-read`; OP-6, coordinator decision DOMAINS 3298853d
 * at the owner's request). It proves that Codex's `account/rateLimits/read` answers with the
 * fields core keeps, and that nothing leaves the machine while it does. The proof comes from the
 * OS, not from Codex's config.
 *
 * The OS isolation:
 * - macOS: `sandbox-exec -f <profile>` (darwinUsageReadProfile). Every network operation is
 *   denied except to and on the stub's one loopback port. The mach services that resolve names or make requests for a
 *   process (mDNSResponder, networkd, nsurlsessiond, trustd, configd's DNS) are denied by name.
 * - Linux: `unshare --user --map-root-user --net`. It is a network namespace with `lo`, which
 *   the runner brings up. The runner checks `/proc/net/dev` (per namespace) lists nothing else,
 *   except the kernel's fallback tunnel devices, and those only while down, with no address and no
 *   route (linuxInterfaceVerdict).
 * - Anywhere else (Windows), or when the isolation cannot start (no sandbox-exec, no unshare or
 *   `ip`, user namespaces disabled): the case is ACCESS_USAGE_ISOLATION_UNAVAILABLE, recorded
 *   unsupported. It is never a pass, and nothing ever runs unisolated.
 *
 * Inside the isolation, a small runner (USAGE_READ_RUNNER, node built-ins only):
 * 1. Checks the isolation from the inside. A connect to a documentation address (192.0.2.1,
 *    2001:db8::1) must be refused at once (EPERM, EACCES, ENETUNREACH, EAFNOSUPPORT or EADDRNOTAVAIL),
 *    and a name lookup must fail.
 *    Anything else is ISOLATION_VIOLATED.
 * 2. Starts the stub on 127.0.0.1 and writes the belt-and-braces config into the case's own
 *    CODEX_HOME:
 *    - `chatgpt_base_url` and `openai_base_url` on the stub, as IP literals, never a name;
 *    - the file credential store;
 *    - analytics and plugins off.
 * 3. Writes a dummy ChatGPT login. It has an unsigned id_token with no email claim, an opaque
 *    access token and a fresh `last_refresh`. It sits at 0600 in that CODEX_HOME only, and the whole
 *    case folder is removed afterwards. It is never the real login and never in argv or a log.
 * 4. Runs `codex app-server` with a minimal environment allow-list (HOME, CODEX_HOME and TMPDIR in
 *    the case folder, PATH, and the token-URL overrides and remote-control switch pointing at the
 *    stub). No proxy variable is passed. stdio is pipes only.
 * 5. Sends `initialize`, then `account/rateLimits/read` in the background-poll form.
 *
 * The case passes only when all of these hold:
 * - isolation is established and verified from inside;
 * - every request the stub saw was addressed to itself;
 * - the usage request came with the dummy bearer;
 * - the answer parses (parseCodexRateLimits) to exactly the stub's windows and allowed flag.
 *
 * No model runs and nothing is billed. Tests use a stand-in app-server, never the real codex.
 */
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { ACCESS_USAGE_ISOLATION_UNAVAILABLE } from '@jevris/contracts';
import { launchStreaming, spawnRefused } from './live-harness.js';
import { parseCodexRateLimits, type CodexUsageRead } from './model-offer.js';

declare function setTimeout(callback: () => void, ms: number): number;
declare function clearTimeout(handle: number): void;

type Env = { readonly [key: string]: string | undefined };

export const USAGE_READ_CASE_ID = 'codex.usage-read';
export const USAGE_READ_TIMEOUT_MS = 45_000;
const OUTPUT_CAP = 256 * 1024;

/** Where the isolation tools live; only these absolute paths are run. */
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
export const UNSHARE_PATHS: readonly string[] = ['/usr/bin/unshare', '/bin/unshare'];
export const IP_PATHS: readonly string[] = ['/usr/sbin/ip', '/sbin/ip', '/usr/bin/ip', '/bin/ip'];

/**
 * The macOS profile for a stub on `port` (B's review, MEDIUM 47). It denies every network
 * operation, then allows loopback on the stub's one port only: connects to it, and binding and
 * accepting on it. Any other loopback port is refused, so a local proxy or agent on 127.0.0.1
 * cannot relay a request off the machine. `localhost` here is matched by the kernel against
 * 127.0.0.1 and ::1, and no lookup is made. Unix-domain sockets stay denied, which covers the
 * mDNSResponder socket. The name-resolving and request-making mach services are denied by name,
 * so the intent is visible and a test pins it. The port is checked to be an integer from 1024 to
 * 65535 and inserted as a number.
 */
export function darwinUsageReadProfile(port: number): string {
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error('usage-read profile: invalid port');
  return `(version 1)
(allow default)
(deny network*)
(allow network-outbound (remote ip "localhost:${port}"))
(allow network-bind (local ip "localhost:${port}"))
(allow network-inbound (local ip "localhost:${port}"))
(deny mach-lookup
  (global-name "com.apple.dnssd.service")
  (global-name "com.apple.mDNSResponder")
  (global-name-prefix "com.apple.dnssd.")
  (global-name "com.apple.mDNSResponderHelper")
  (global-name "com.apple.networkd")
  (global-name "com.apple.nsurlsessiond")
  (global-name "com.apple.trustd.agent")
  (global-name "com.apple.SystemConfiguration.DNSConfiguration"))
`;
}

/** A free loopback port from 1024 to 65535 for the stub: bound on 127.0.0.1:0, read, closed. Null after five tries. */
export async function freeLoopbackPort(): Promise<number | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const server = createServer(() => undefined);
    const port = await new Promise<number>((resolve) => {
      server.on('error', () => resolve(0));
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (Number.isInteger(port) && port >= 1024 && port <= 65_535) return port;
  }
  return null;
}

/** The Linux isolation's argv before the runner: a new user and network namespace, mapped to root so `lo` can be brought up. */
export const LINUX_UNSHARE_ARGS: readonly string[] = ['--user', '--map-root-user', '--net'];

/** The stub's canned usage (Codex's backend `wham/usage` shape) and what the app-server must answer with. */
export const USAGE_READ_ACCOUNT = { accountId: 'acct-jevris-k21', userId: 'user-jevris-k21', accessToken: 'jevris-k21-dummy-access' } as const;

function stubBody(nowS: number): unknown {
  return {
    plan_type: 'plus',
    account_id: USAGE_READ_ACCOUNT.accountId,
    user_id: USAGE_READ_ACCOUNT.userId,
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 42, limit_window_seconds: 18_000, reset_after_seconds: 600, reset_at: nowS + 600 },
      secondary_window: { used_percent: 5, limit_window_seconds: 604_800, reset_after_seconds: 86_400, reset_at: nowS + 86_400 },
    },
  };
}

/** What parseCodexRateLimits must give for the stub's body. */
export function expectedUsageRead(nowS: number): CodexUsageRead {
  return {
    windows: [
      { usedPercent: 42, windowMinutes: 300, resetsAtMs: (nowS + 600) * 1000 },
      { usedPercent: 5, windowMinutes: 10_080, resetsAtMs: (nowS + 86_400) * 1000 },
    ],
    ordinaryUsageAllowed: true,
  };
}

/**
 * The fallback devices the kernel creates in every new network namespace when a tunnel module
 * (ipip, gre, vti, sit, ip6_tunnel, ip6_gre) is loaded and `net.core.fb_tunnels_only_for_init_net`
 * is 0, its default. Docker Desktop's kernel builds them in, and an ordinary host has them once
 * such a module is loaded (the Linux RC6 run, coordinator's decision).
 */
export const LINUX_FALLBACK_INTERFACES: readonly string[] = ['tunl0', 'gre0', 'gretap0', 'erspan0', 'ip_vti0', 'ip6_vti0', 'sit0', 'ip6tnl0', 'ip6gre0'];

/** Why the Linux namespace's interfaces do not show an isolation, or null when they do. */
export interface LinuxInterfaceVerdict {
  readonly isolation: 'violated' | 'unavailable';
  readonly reason: string;
}

/**
 * K21's interface check inside the Linux namespace. `names` are /proc/net/dev's; `links`, `addrs`
 * and `routes` are `ip -j link show`, `ip -j addr show` and the v4 and v6 `ip -j route show table
 * all` (null when unreadable). `lo` must be there. Any other interface fails, except a kernel
 * fallback tunnel device that is down (no UP flag, operstate DOWN), has no v4 or v6 address and
 * no route. The runner embeds this function's source, so it uses nothing outside itself; the
 * outbound and name checks still run after it.
 */
export function linuxInterfaceVerdict(names: readonly string[], links: unknown, addrs: unknown, routes: unknown): LinuxInterfaceVerdict | null {
  const fallback = new Set(['tunl0', 'gre0', 'gretap0', 'erspan0', 'ip_vti0', 'ip6_vti0', 'sit0', 'ip6tnl0', 'ip6gre0']);
  if (!names.includes('lo')) return { isolation: 'violated', reason: 'NO_LOOPBACK' };
  const extra = names.filter((name) => name !== 'lo');
  if (extra.length === 0) return null;
  if (extra.some((name) => !fallback.has(name))) return { isolation: 'violated', reason: 'OTHER_INTERFACE' };
  if (!Array.isArray(links) || !Array.isArray(addrs) || !Array.isArray(routes)) return { isolation: 'unavailable', reason: 'INTERFACE_STATE_UNREADABLE' };
  const entry = (list: readonly unknown[], name: string): { readonly [key: string]: unknown } | undefined =>
    list.find((item): item is { readonly [key: string]: unknown } => typeof item === 'object' && item !== null && (item as { readonly [key: string]: unknown })['ifname'] === name);
  for (const name of extra) {
    const link = entry(links, name);
    const address = entry(addrs, name);
    if (link === undefined || address === undefined) return { isolation: 'unavailable', reason: 'INTERFACE_STATE_UNREADABLE' };
    const flags = link['flags'];
    if (!Array.isArray(flags) || flags.includes('UP') || link['operstate'] !== 'DOWN') return { isolation: 'violated', reason: 'FALLBACK_INTERFACE_UP' };
    const info = address['addr_info'];
    if (!Array.isArray(info) || info.length > 0) return { isolation: 'violated', reason: 'FALLBACK_INTERFACE_ADDRESS' };
    if (routes.some((route) => typeof route !== 'object' || route === null || (route as { readonly [key: string]: unknown })['dev'] === name)) return { isolation: 'violated', reason: 'FALLBACK_INTERFACE_ROUTE' };
  }
  return null;
}

/**
 * The runner, run inside the isolation with the node that runs Jevris. It reads its input file
 * and prints one `started` line, then one `result` line, as JSON. It keeps request paths and
 * flags, never header values or bodies.
 */
export const USAGE_READ_RUNNER = `
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
say({ k21: 'started' });
const done = (o) => { say({ k21: 'result', ...o }); process.exit(0); };
const within = (p, ms, late) => Promise.race([p, new Promise((r) => setTimeout(() => r(late), ms))]);
const connect = (host, port) => new Promise((res) => {
  const s = net.connect({ host, port });
  s.once('connect', () => { s.destroy(); res('CONNECTED'); });
  s.once('error', (e) => res(String(e.code || 'ERROR')));
});
// Refused before anything is sent: denied by the sandbox, no route, or no address family or source address.
const DENIED = new Set(['EPERM', 'EACCES', 'ENETUNREACH', 'EAFNOSUPPORT', 'EADDRNOTAVAIL']);
const linuxInterfaceVerdict = ${linuxInterfaceVerdict.toString()};

if (input.platform === 'linux') {
  const ip = input.ipPaths.find((p) => existsSync(p));
  if (!ip) done({ isolation: 'unavailable', reason: 'NO_IP_TOOL' });
  try { execFileSync(ip, ['link', 'set', 'lo', 'up'], { stdio: 'ignore', env: {} }); } catch { done({ isolation: 'unavailable', reason: 'LOOPBACK_DOWN' }); }
  let names = [];
  try { names = readFileSync('/proc/net/dev', 'utf8').split('\\n').slice(2).map((l) => l.split(':')[0].trim()).filter(Boolean); } catch { done({ isolation: 'unavailable', reason: 'NO_PROC_NET' }); }
  const ipJson = (args) => { try { return JSON.parse(execFileSync(ip, ['-j', ...args], { encoding: 'utf8', env: {}, stdio: ['ignore', 'pipe', 'ignore'] }) || '[]'); } catch { return null; } };
  const extra = names.some((n) => n !== 'lo');
  const v4 = extra ? ipJson(['-4', 'route', 'show', 'table', 'all']) : [];
  const v6 = extra ? ipJson(['-6', 'route', 'show', 'table', 'all']) : [];
  const verdict = linuxInterfaceVerdict(names, extra ? ipJson(['link', 'show']) : [], extra ? ipJson(['addr', 'show']) : [], Array.isArray(v4) && Array.isArray(v6) ? [...v4, ...v6] : null);
  if (verdict !== null) done(verdict);
}
for (const [host, port] of input.probes) {
  const code = await within(connect(host, port), 2000, 'TIMEOUT');
  if (!DENIED.has(code)) done({ isolation: 'violated', reason: 'OUTBOUND_' + code });
}
const looked = await within(dns.promises.lookup(input.probeName).then(() => 'RESOLVED', () => 'FAILED'), 3000, 'TIMEOUT');
if (looked !== 'FAILED') done({ isolation: 'violated', reason: 'NAME_' + looked });

const requests = [];
const port = input.port;
const server = http.createServer((req, res) => {
  const path = String(req.url || '').split('?')[0].slice(0, 200);
  const usage = req.method === 'GET' && path === '/backend-api/wham/usage';
  requests.push({ method: String(req.method).slice(0, 10), path, self: req.headers.host === '127.0.0.1:' + port, bearer: usage && req.headers.authorization === 'Bearer ' + input.accessToken });
  req.resume();
  if (usage) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(input.body)); return; }
  res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}');
});
// Exactly the port the profile allows; a lost race is a failed case, never a pass.
const bound = await new Promise((r) => { server.once('error', () => r(false)); server.listen(port, '127.0.0.1', () => r(true)); });
if (!bound) done({ isolation: 'verified', reason: 'STUB_BIND_FAILED', requests, answered: false });
if ((await within(connect('127.0.0.1', port), 2000, 'TIMEOUT')) !== 'CONNECTED') done({ isolation: 'verified', reason: 'LOOPBACK_UNREACHABLE', requests, answered: false });
requests.length = 0;
const base = 'http://127.0.0.1:' + port;
writeFileSync(join(input.codexHome, 'config.toml'), [
  'check_for_update_on_startup = false',
  'chatgpt_base_url = "' + base + '/backend-api"',
  'openai_base_url = "' + base + '/v1"',
  'cli_auth_credentials_store = "file"',
  '[analytics]',
  'enabled = false',
  '[features]',
  'plugins = false',
  '',
].join('\\n'), { mode: 0o600 });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const idToken = b64({ alg: 'none', typ: 'JWT' }) + '.' + b64({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_user_id: input.userId, chatgpt_account_id: input.accountId } }) + '.sig';
writeFileSync(join(input.codexHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: idToken, access_token: input.accessToken, refresh_token: 'jevris-k21-dummy-refresh', account_id: input.accountId }, last_refresh: new Date().toISOString() }), { mode: 0o600 });
const env = {
  HOME: input.home,
  CODEX_HOME: input.codexHome,
  TMPDIR: input.tmp,
  PATH: input.path,
  LANG: 'C',
  CODEX_REFRESH_TOKEN_URL_OVERRIDE: base + '/oauth/token',
  CODEX_REVOKE_TOKEN_URL_OVERRIDE: base + '/oauth/revoke',
  CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1',
};
const child = spawn(input.command.file, [...input.command.args, '-c', 'check_for_update_on_startup=false', 'app-server'], { cwd: input.work, env, stdio: ['pipe', 'pipe', 'pipe'] });
let spawned = true;
child.on('error', () => { spawned = false; });
child.stderr.resume();
let buffer = '';
let bytes = 0;
let answer = null;
const finished = new Promise((resolve) => {
  const timer = setTimeout(() => resolve('timeout'), input.timeoutMs);
  child.on('exit', () => { clearTimeout(timer); resolve('exited'); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > 262144) { clearTimeout(timer); resolve('too-large'); return; }
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\\n')) !== -1) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message === null || typeof message !== 'object') continue;
      if (message.id === 1) {
        child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\\n');
        child.stdin.write(JSON.stringify({ id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } }) + '\\n');
      } else if (message.id === 2) {
        answer = message.error !== undefined ? { error: true } : { result: message.result ?? null };
        clearTimeout(timer);
        resolve('answered');
      }
    }
  });
});
child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'jevris', title: 'Jevris', version: '1' } } }) + '\\n');
const how = await finished;
child.kill('SIGKILL');
server.close();
done({ isolation: 'verified', spawned, how, requests, answered: answer !== null && answer.error !== true, result: answer === null || answer.error === true ? null : answer.result });
`;

export interface UsageReadRunnerInput {
  readonly platform: string;
  /** The stub's port, the only loopback port the macOS profile allows. */
  readonly port: number;
  readonly ipPaths: readonly string[];
  readonly probes: readonly (readonly [string, number])[];
  readonly probeName: string;
  readonly command: { readonly file: string; readonly args: readonly string[] };
  readonly home: string;
  readonly codexHome: string;
  readonly tmp: string;
  readonly work: string;
  readonly path: string;
  readonly timeoutMs: number;
  readonly accessToken: string;
  readonly accountId: string;
  readonly userId: string;
  readonly body: unknown;
}

/** How the runner is wrapped: the isolation's argv (before `node runner input`), or why there is none. */
export type UsageReadIsolation = { readonly ok: true; readonly file: string; readonly args: readonly string[] } | { readonly ok: false; readonly reason: string };

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    (info) => info.isFile() || info.isSymbolicLink(),
    () => false,
  );
}

/** The isolation for this OS, or why it is not available. Never a plain spawn. */
export async function usageReadIsolation(platform: string, profileFile: string, has: (path: string) => Promise<boolean> = exists): Promise<UsageReadIsolation> {
  if (platform === 'darwin') return (await has(SANDBOX_EXEC)) ? { ok: true, file: SANDBOX_EXEC, args: ['-f', profileFile] } : { ok: false, reason: 'NO_SANDBOX_EXEC' };
  if (platform === 'linux') {
    for (const path of UNSHARE_PATHS) if (await has(path)) return { ok: true, file: path, args: LINUX_UNSHARE_ARGS };
    return { ok: false, reason: 'NO_UNSHARE' };
  }
  return { ok: false, reason: 'NO_OS_ISOLATION' };
}

export interface UsageReadCaseOptions {
  /** certifyEnv's environment; only its PATH reaches the case. */
  readonly env: Env;
  /** The certify profile; the case works in its own folder inside it and removes it. */
  readonly profile: string;
  readonly timeoutMs?: number;
  readonly platform?: string;
  /** Tests: a stand-in app-server instead of `codex` on PATH. */
  readonly command?: { readonly file: string; readonly args?: readonly string[] };
  /** Tests: another isolation (a forced unavailable, or none to prove a violation fails). */
  readonly isolation?: (platform: string, profileFile: string) => Promise<UsageReadIsolation>;
  /** Tests: the outbound probes (default the documentation addresses) and the name looked up. */
  readonly probes?: readonly (readonly [string, number])[];
  readonly probeName?: string;
  readonly nowMs?: number;
}

export interface UsageReadCaseResult {
  readonly id: string;
  readonly passed: boolean;
  readonly reasonCode: string | null;
  readonly detail: string;
}

const verdict = (passed: boolean, reasonCode: string | null, detail: string): UsageReadCaseResult => ({ id: USAGE_READ_CASE_ID, passed, reasonCode, detail });

interface RunnerLines {
  readonly started: boolean;
  readonly result: { readonly [key: string]: unknown } | null;
}

/** Runs the isolated runner (pipes only, its own process group) and reads its two JSON lines. */
async function runIsolated(file: string, args: readonly string[], env: { [key: string]: string }, cwd: string, timeoutMs: number): Promise<RunnerLines> {
  let started = false;
  let result: { readonly [key: string]: unknown } | null = null;
  let bytes = 0;
  let over = false;
  const launched = launchStreaming(file, args, {
    cwd,
    env,
    input: '',
    onLine: (line) => {
      bytes += line.length + 1;
      if (bytes > OUTPUT_CAP) over = true;
      if (over) return;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message === null || typeof message !== 'object' || Array.isArray(message)) return;
      const record = message as { readonly [key: string]: unknown };
      if (record['k21'] === 'started') started = true;
      if (record['k21'] === 'result' && started) result = record;
    },
  });
  const timer = setTimeout(() => launched.kill(), timeoutMs);
  await launched.done;
  clearTimeout(timer);
  return { started, result: over ? null : result };
}

function sameRead(a: CodexUsageRead | null, b: CodexUsageRead): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * K21. Never throws. The case folder (the dummy login included) is removed in `finally`.
 * - unavailable: ACCESS_USAGE_ISOLATION_UNAVAILABLE;
 * - violated or failed: its own reason code;
 * - pass: only with every condition in the module comment.
 */
export async function codexUsageReadCase(options: UsageReadCaseOptions): Promise<UsageReadCaseResult> {
  const platform = options.platform ?? process.platform;
  let dir: string | null = null;
  try {
    await mkdir(options.profile, { recursive: true });
    dir = await mkdtemp(join(options.profile, 'k21-'));
    await chmod(dir, 0o700);
    const port = await freeLoopbackPort();
    if (port === null) return verdict(false, 'STUB_BIND_FAILED', 'no loopback port for the stub');
    const profileFile = join(dir, 'isolation.sb');
    await writeFile(profileFile, darwinUsageReadProfile(port), { mode: 0o600 });
    const command = { file: options.command?.file ?? 'codex', args: [...(options.command?.args ?? [])] };
    const isolation = await (options.isolation ?? ((p: string, f: string) => usageReadIsolation(p, f)))(platform, profileFile);
    if (!isolation.ok) return verdict(false, ACCESS_USAGE_ISOLATION_UNAVAILABLE, `no OS network isolation here (${isolation.reason}); the read is not certified`);
    // A test run never starts the real codex, whatever the isolation (the harness tripwire).
    if (spawnRefused(command.file) || spawnRefused(command.file, options.env)) return verdict(false, 'HARNESS_NOT_STARTED', 'codex is not started in a test run');
    const home = join(dir, 'home');
    const codexHome = join(home, '.codex');
    const tmp = join(dir, 'tmp');
    const work = join(dir, 'work');
    for (const folder of [home, codexHome, tmp, work]) await mkdir(folder, { recursive: true, mode: 0o700 });
    const nowS = Math.floor((options.nowMs ?? Date.now()) / 1000);
    const timeoutMs = Math.min(Math.max(1_000, options.timeoutMs ?? USAGE_READ_TIMEOUT_MS), USAGE_READ_TIMEOUT_MS);
    const input: UsageReadRunnerInput = {
      platform,
      port,
      ipPaths: IP_PATHS,
      probes: options.probes ?? [
        ['192.0.2.1', 9],
        ['2001:db8::1', 9],
      ],
      probeName: options.probeName ?? 'example.com',
      command,
      home,
      codexHome,
      tmp,
      work,
      path: options.env['PATH'] ?? '/usr/bin:/bin',
      timeoutMs: Math.max(500, timeoutMs - 8_000),
      accessToken: USAGE_READ_ACCOUNT.accessToken,
      accountId: USAGE_READ_ACCOUNT.accountId,
      userId: USAGE_READ_ACCOUNT.userId,
      body: stubBody(nowS),
    };
    const runner = join(dir, 'runner.mjs');
    const inputFile = join(dir, 'input.json');
    await writeFile(runner, USAGE_READ_RUNNER, { mode: 0o600 });
    await writeFile(inputFile, JSON.stringify(input), { mode: 0o600 });
    const env: { [key: string]: string } = { PATH: input.path, HOME: home, TMPDIR: tmp };
    const ran = await runIsolated(isolation.file, [...isolation.args, process.execPath, runner, inputFile], env, work, timeoutMs);
    if (!ran.started) return verdict(false, ACCESS_USAGE_ISOLATION_UNAVAILABLE, 'the isolation did not start the case (sandbox or namespace refused); the read is not certified');
    const out = ran.result;
    if (out === null) return verdict(false, 'CASE_INCOMPLETE', 'the isolated case stopped before its result');
    if (out['isolation'] === 'unavailable') return verdict(false, ACCESS_USAGE_ISOLATION_UNAVAILABLE, `the isolation could not be completed inside (${String(out['reason']).slice(0, 40)})`);
    if (out['isolation'] !== 'verified') return verdict(false, 'ISOLATION_VIOLATED', `the check inside the isolation failed (${String(out['reason']).slice(0, 40)})`);
    if (out['reason'] === 'LOOPBACK_UNREACHABLE') return verdict(false, 'LOOPBACK_UNREACHABLE', 'the stub on loopback was not reachable inside the isolation');
    if (out['reason'] === 'STUB_BIND_FAILED') return verdict(false, 'STUB_BIND_FAILED', 'the stub could not bind the port the isolation allows');
    const requests = Array.isArray(out['requests']) ? (out['requests'] as { readonly [key: string]: unknown }[]) : [];
    if (requests.some((item) => item['self'] !== true)) return verdict(false, 'STUB_FOREIGN_REQUEST', 'the stub saw a request addressed to another host');
    if (out['spawned'] === false) return verdict(false, 'HARNESS_NOT_STARTED', 'codex app-server did not start');
    if (!requests.some((item) => item['path'] === '/backend-api/wham/usage' && item['bearer'] === true)) return verdict(false, 'USAGE_NOT_REQUESTED', `codex did not read the usage from the stub (${String(out['how']).slice(0, 20)})`);
    if (out['answered'] !== true) return verdict(false, 'USAGE_NOT_ANSWERED', 'account/rateLimits/read gave no result');
    if (!sameRead(parseCodexRateLimits(out['result']), expectedUsageRead(nowS))) return verdict(false, 'USAGE_FIELDS_MISMATCH', 'the answer did not carry the stub\'s windows and allowed flag');
    return verdict(true, null, `isolated (${platform === 'darwin' ? 'sandbox-exec' : 'network namespace'}); only loopback reached; the read answered with both windows and ordinaryUsageAllowed`);
  } catch {
    return verdict(false, 'STUB_CASE_ERROR', 'the case stopped with an error');
  } finally {
    if (dir !== null) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

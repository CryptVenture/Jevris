import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync, constants as fsConstants } from 'node:fs';
import type { Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAbsoluteFor, jevrisPaths, pathApiFor, type EnvLike } from '@jevris/platform';
import type {
  SidecarBudgetClass,
  SidecarClientKind,
  SidecarEndpointFile,
} from '@jevris/contracts';

/**
 * Sidecar protocol v1: key files, frame MACs, the endpoint file and a bounded line reader
 * (IPC-01..IPC-05, IPC-08). Imported by the light client and by the daemon. This module has
 * no store, provider or keyring import, so the hook can vendor it.
 */

export const PROTOCOL = 1;
export const DOMAIN = 'jevris-sidecar-v1';
export const KEY_BYTES = 32;
export const NONCE_BYTES = 16;
/** Base64url of NONCE_BYTES bytes. */
export const NONCE_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export const OP_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
/** A frame timestamp outside this window is refused (IPC-01). */
export const SKEW_MS = 30_000;
/** One NDJSON line: the body text is capped at MAX_REQUEST_BYTES inside it. */
export const MAX_BODY_BYTES = 131_072;
export const MAX_LINE_BYTES = MAX_BODY_BYTES * 2 + 4096;
/** A Unix socket path above this many bytes is refused by the kernel (sun_path). */
export const SUN_PATH_LIMIT = 103;
export const ENDPOINT_SCHEMA = 'jevris-sidecar-endpoint-1';

export const CLIENT_KINDS: readonly SidecarClientKind[] = ['cli', 'hook', 'mcp'];
export const BUDGET_CLASSES: readonly SidecarBudgetClass[] = ['hot', 'background'];

export function isClientKind(value: unknown): value is SidecarClientKind {
  return value === 'cli' || value === 'hook' || value === 'mcp';
}

export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function newNonce(): string {
  return b64url(randomBytes(NONCE_BYTES));
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function hmac(key: Uint8Array, text: string): string {
  return createHmac('sha256', key).update(text, 'utf8').digest('base64url');
}

export function macEquals(expected: string, presented: unknown): boolean {
  if (typeof presented !== 'string' || presented.length !== expected.length) return false;
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(presented, 'utf8');
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

/** The per-kind client key, derived from the per-boot key. Never the boot key itself. */
export function clientKey(bootKey: Uint8Array, kind: SidecarClientKind): Uint8Array {
  return new Uint8Array(createHmac('sha256', bootKey).update(`${DOMAIN}\nclient-key\n${kind}`, 'utf8').digest());
}

export function serverProof(key: Uint8Array, cnonce: string, snonce: string, bootId: string): string {
  return hmac(key, `${DOMAIN}\nserver\n${cnonce}\n${snonce}\n${bootId}`);
}

export interface RequestMacFields {
  readonly snonce: string;
  readonly id: string;
  readonly ws: string;
  readonly op: string;
  readonly ts: number;
  readonly eventAtMs: number | null;
  readonly budget: SidecarBudgetClass;
  readonly body: string;
  /** The client's own deadline (wall ms). MAC'd when present, appended last. */
  readonly deadlineAtMs?: number | null;
  /** The answer lane (ANSWER_PRIORITY): MAC'd when present, after the deadline. */
  readonly priority?: RequestPriority | null;
}

/**
 * The answer lane (owner decision ededdba; D's K3 load test). A hook event whose answer must not be
 * lost to load (a SessionStart restore, a Stop reminder, a PreCompact capsule) is admitted from
 * hot slots kept for it, so a full hot pool never answers it BUSY. The flag is part of the
 * request MAC, only a hook client's `event` may carry it, and the sidecar checks the event kind in
 * the body before it runs anything: no other request can claim the lane.
 */
export type RequestPriority = 'answer';
export const ANSWER_PRIORITY: RequestPriority = 'answer';
/** The normalized event kinds that ride the answer lane. */
export const ANSWER_EVENT_KINDS: readonly string[] = ['session.started', 'turn.stopped', 'context.compacting'];

/** The lane a request asks for: `answer` only for a hook `event` whose envelope kind is an answer kind. */
export function requestPriority(scope: string, op: string, body: unknown): RequestPriority | null {
  if (scope !== 'hook' || op !== 'event' || body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const envelope: unknown = Reflect.get(body, 'envelope');
  const kind: unknown = envelope !== null && typeof envelope === 'object' && !Array.isArray(envelope) ? Reflect.get(envelope, 'kind') : undefined;
  return typeof kind === 'string' && ANSWER_EVENT_KINDS.includes(kind) ? ANSWER_PRIORITY : null;
}

export function requestMac(key: Uint8Array, f: RequestMacFields): string {
  const event = f.eventAtMs === null ? '' : String(f.eventAtMs);
  const fields = [DOMAIN, 'request', f.snonce, f.id, f.ws, f.op, String(f.ts), event, f.budget, sha256Hex(f.body)];
  if (typeof f.deadlineAtMs === 'number') fields.push(String(f.deadlineAtMs));
  // Never a number, so it cannot be read as a deadline: with and without a deadline the fields differ.
  if (f.priority === ANSWER_PRIORITY) fields.push(`priority=${ANSWER_PRIORITY}`);
  return hmac(key, fields.join('\n'));
}

export function responseMac(key: Uint8Array, snonce: string, id: string, payload: string): string {
  return hmac(key, [DOMAIN, 'response', snonce, id, sha256Hex(payload)].join('\n'));
}

// ------------------------------------------------------------------ runtime files

export interface RuntimeFiles {
  readonly dir: string;
  readonly endpoint: string;
  readonly pid: string;
  readonly lock: string;
  readonly spawnLock: string;
  readonly preferredSocket: string;
  /** Which execution environment the running sidecar belongs to (IPC-19). */
  readonly locality: string;
  key(kind: SidecarClientKind): string;
}

export interface RuntimeInput {
  readonly home?: string;
  readonly platform?: string;
  readonly env?: EnvLike;
}

export function runtimeFiles(input: RuntimeInput = {}): RuntimeFiles {
  const platform = input.platform ?? process.platform;
  const paths = jevrisPaths({
    ...(input.home !== undefined ? { home: input.home } : {}),
    platform,
    ...(input.env !== undefined ? { env: input.env } : {}),
  });
  const api = pathApiFor(platform);
  const dir = paths.runtime;
  return {
    dir,
    endpoint: api.join(dir, 'endpoint.json'),
    pid: api.join(dir, 'sidecar.pid'),
    lock: api.join(dir, 'sidecar.lock'),
    spawnLock: api.join(dir, 'spawn.lock'),
    preferredSocket: api.join(dir, 's'),
    locality: api.join(dir, 'locality.json'),
    key: (kind) => api.join(dir, `key-${kind}`),
  };
}

// ------------------------------------------------------------------ socket selection (IPC-05, IPC-08)

export function isNamedPipe(path: string): boolean {
  return path.startsWith('\\\\.\\pipe\\') || path.startsWith('\\\\?\\pipe\\');
}

/** `\\.\pipe\jevris-<principal hash>-<128-bit random>`: unpredictable, per user (IPC-05). */
export function randomPipeName(principal: string): string {
  const who = sha256Hex(principal).slice(0, 12);
  return `\\\\.\\pipe\\jevris-${who}-${randomBytes(16).toString('hex')}`;
}

export interface SocketCandidate {
  readonly path: string;
  /** The private directory the socket lives in, which must be owned and 0700. */
  readonly dir: string;
  readonly fallback: boolean;
}

/**
 * The Unix socket path for a runtime directory. The preferred `<runtime>/s` is used unless it
 * exceeds the sun_path limit; then `$XDG_RUNTIME_DIR/jevris`, `$TMPDIR/jevris-<uid>` or
 * `/tmp/jevris-<uid>` with a name derived from the runtime directory, so two homes never share
 * a socket (IPC-08).
 */
export function socketCandidates(runtimeDir: string, env: EnvLike = process.env, uid?: number): readonly SocketCandidate[] {
  const preferred = join(runtimeDir, 's');
  const out: SocketCandidate[] = [];
  if (Buffer.byteLength(preferred, 'utf8') <= SUN_PATH_LIMIT) out.push({ path: preferred, dir: runtimeDir, fallback: false });
  const id = uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0);
  const name = `${sha256Hex(runtimeDir).slice(0, 16)}.s`;
  const roots: string[] = [];
  const xdg = env['XDG_RUNTIME_DIR'];
  if (typeof xdg === 'string' && isAbsoluteFor(xdg, 'linux')) roots.push(join(xdg, 'jevris'));
  const tmp = env['TMPDIR'];
  if (typeof tmp === 'string' && isAbsoluteFor(tmp, 'linux')) roots.push(join(tmp, `jevris-${id}`));
  roots.push(join('/tmp', `jevris-${id}`));
  for (const dir of roots) {
    const path = join(dir, name);
    if (Buffer.byteLength(path, 'utf8') <= SUN_PATH_LIMIT) out.push({ path, dir, fallback: true });
  }
  return out;
}

/**
 * Ownership and mode check for a fallback socket directory: a real directory owned by this
 * user with no group or other bits. A symlink or foreign owner is refused (IPC-08).
 */
export function fallbackDirSafe(dir: string, uid?: number): boolean {
  const st = lstatSync(dir, { throwIfNoEntry: false });
  if (st === undefined) return false;
  if (st.isSymbolicLink() || !st.isDirectory()) return false;
  const me = uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
  if (me !== undefined && st.uid !== me) return false;
  return (st.mode & 0o077) === 0;
}

// ------------------------------------------------------------------ endpoint and key files

const MAX_SMALL_FILE = 8192;

/**
 * Reads a small private file without following a symlink. On POSIX the file must be owned by
 * this user with no group or other bits; on Windows the private runtime directory's ACL,
 * applied by the daemon, protects it.
 */
export function readPrivateSmall(path: string, platform: string = process.platform): Buffer | undefined {
  let fd: number | undefined;
  try {
    const flags = fsConstants.O_RDONLY | (platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0));
    const before = lstatSync(path, { throwIfNoEntry: false });
    if (before === undefined || before.isSymbolicLink() || !before.isFile()) return undefined;
    fd = openSync(path, flags);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_SMALL_FILE) return undefined;
    if (platform !== 'win32') {
      const me = typeof process.getuid === 'function' ? process.getuid() : undefined;
      if (me !== undefined && st.uid !== me) return undefined;
      if ((st.mode & 0o077) !== 0) return undefined;
    }
    const buffer = Buffer.alloc(Number(st.size));
    let read = 0;
    while (read < buffer.byteLength) {
      const n = readSync(fd, buffer, read, buffer.byteLength - read, read);
      if (n <= 0) break;
      read += n;
    }
    return buffer.subarray(0, read);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // nothing to report
      }
    }
  }
}

// ------------------------------------------------------------------ locality record (IPC-19)

export const LOCALITY_SCHEMA = 'jevris-sidecar-locality-1';
/** The daemon rewrites its locality record this often while it runs. */
export const LOCALITY_REFRESH_MS = 30_000;
/** A record not refreshed for this long belongs to a sidecar that is gone. */
export const LOCALITY_STALE_MS = 120_000;

export interface LocalityRecord {
  readonly schemaVersion: typeof LOCALITY_SCHEMA;
  readonly bootId: string;
  readonly id: string;
  readonly kind: string;
  readonly refreshedAtMs: number;
}

export function localityRecordText(bootId: string, locality: { readonly id: string; readonly kind: string }, nowMs: number): string {
  const record: LocalityRecord = { schemaVersion: LOCALITY_SCHEMA, bootId, id: locality.id, kind: locality.kind, refreshedAtMs: nowMs };
  return `${JSON.stringify(record)}\n`;
}

export function readLocalityRecord(files: RuntimeFiles, platform?: string): LocalityRecord | undefined {
  const raw = readPrivateSmall(files.locality, platform);
  if (raw === undefined) return undefined;
  try {
    const v = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    if (v === null || typeof v !== 'object' || v['schemaVersion'] !== LOCALITY_SCHEMA) return undefined;
    const { bootId, id, kind, refreshedAtMs } = v;
    if (typeof bootId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(bootId)) return undefined;
    if (typeof id !== 'string' || !/^[a-f0-9]{16}$/.test(id)) return undefined;
    if (typeof kind !== 'string' || !/^[a-z]{1,16}$/.test(kind)) return undefined;
    if (typeof refreshedAtMs !== 'number' || !Number.isSafeInteger(refreshedAtMs)) return undefined;
    return { schemaVersion: LOCALITY_SCHEMA, bootId, id, kind, refreshedAtMs };
  } catch {
    return undefined;
  }
}

export const FOREIGN_LOCALITY_MESSAGE =
  'The Jevris sidecar for this home runs in another execution environment (a container, WSL or another host). Jevris runs next to the coding process: set JEVRIS_HOME to a directory inside this environment, or stop the other sidecar there.';

/**
 * The running sidecar's locality record when it belongs to another execution environment:
 * the record names the endpoint's boot id, was refreshed recently, and its id is not ours. A
 * sidecar from an older build writes no record and is treated as local.
 */
export function foreignSidecar(files: RuntimeFiles, endpoint: SidecarEndpointFile | undefined, ownId: string, nowMs: number, platform?: string): LocalityRecord | undefined {
  if (endpoint === undefined) return undefined;
  const record = readLocalityRecord(files, platform);
  if (record === undefined || record.bootId !== endpoint.bootId || record.id === ownId) return undefined;
  return nowMs - record.refreshedAtMs < LOCALITY_STALE_MS ? record : undefined;
}

export function readClientKey(files: RuntimeFiles, kind: SidecarClientKind, platform?: string): Uint8Array | undefined {
  const raw = readPrivateSmall(files.key(kind), platform);
  if (raw === undefined) return undefined;
  const decoded = Buffer.from(raw.toString('utf8').trim(), 'base64url');
  return decoded.byteLength === KEY_BYTES ? new Uint8Array(decoded) : undefined;
}

export function parseEndpoint(text: string): SidecarEndpointFile | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (v['schemaVersion'] !== ENDPOINT_SCHEMA) return undefined;
  const protocol = v['protocol'];
  const version = v['version'];
  const pid = v['pid'];
  const bootId = v['bootId'];
  const endpoint = v['endpoint'];
  const startedAtMs = v['startedAtMs'];
  const supervised = v['supervised'];
  if (typeof protocol !== 'number' || !Number.isSafeInteger(protocol)) return undefined;
  if (typeof version !== 'string' || version.length === 0 || version.length > 64) return undefined;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (typeof bootId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(bootId)) return undefined;
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > 1024) return undefined;
  if (typeof startedAtMs !== 'number' || !Number.isFinite(startedAtMs)) return undefined;
  const build = v['build'];
  return {
    schemaVersion: ENDPOINT_SCHEMA,
    protocol,
    version,
    pid,
    bootId,
    endpoint,
    startedAtMs,
    supervised: supervised === true,
    ...(typeof build === 'string' && BUILD_ID.test(build) ? { build } : {}),
  };
}

export function readEndpoint(files: RuntimeFiles, platform?: string): SidecarEndpointFile | undefined {
  const raw = readPrivateSmall(files.endpoint, platform);
  if (raw === undefined) return undefined;
  return parseEndpoint(raw.toString('utf8'));
}

/** True when a process with this pid exists (signal 0 works on every OS). */
export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'EPERM';
  }
}

// ------------------------------------------------------------------ bounded line reader (IPC-04)

export type LineResult =
  | { readonly kind: 'line'; readonly text: string }
  | { readonly kind: 'oversize' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'closed' };

export interface LineReaderOptions {
  readonly maxLineBytes?: number;
  /** Waiting for the first byte of the next frame. */
  readonly idleMs: number;
  /** From the first byte of a frame to its newline (slow-read defence). */
  readonly frameMs?: number;
}

/**
 * Reads newline-terminated frames with a byte cap, an idle timeout and a per-frame timeout.
 * The socket is paused between frames, so a slow handler applies back-pressure to the peer.
 */
export class LineReader {
  private readonly socket: Socket;
  private readonly maxLineBytes: number;
  private readonly frameMs: number;
  private idleMs: number;
  private chunks: Buffer[] = [];
  private size = 0;
  private lines: string[] = [];
  private ended = false;
  private failed: 'oversize' | undefined;
  private waiter: ((result: LineResult) => void) | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(socket: Socket, options: LineReaderOptions) {
    this.socket = socket;
    this.maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
    this.idleMs = options.idleMs;
    this.frameMs = options.frameMs ?? 2000;
    socket.on('data', (chunk: Buffer) => {
      this.onData(chunk);
    });
    socket.on('end', () => {
      this.ended = true;
      this.flush();
    });
    socket.on('close', () => {
      this.ended = true;
      this.flush();
    });
    socket.on('error', () => {
      this.ended = true;
      this.flush();
    });
    socket.pause();
  }

  setIdle(ms: number): void {
    this.idleMs = ms;
  }

  next(): Promise<LineResult> {
    const ready = this.take();
    if (ready !== undefined) return Promise.resolve(ready);
    return new Promise((resolve) => {
      this.waiter = resolve;
      this.arm(this.size > 0 ? this.frameMs : this.idleMs);
      this.socket.resume();
    });
  }

  private arm(ms: number): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.settle({ kind: 'timeout' });
    }, ms);
    this.timer.unref();
  }

  private take(): LineResult | undefined {
    if (this.lines.length > 0) return { kind: 'line', text: this.lines.shift() ?? '' };
    if (this.failed !== undefined) return { kind: this.failed };
    if (this.ended) return { kind: 'closed' };
    return undefined;
  }

  private settle(result: LineResult): void {
    const waiter = this.waiter;
    if (waiter === undefined) return;
    this.waiter = undefined;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.socket.pause();
    waiter(result);
  }

  private flush(): void {
    const ready = this.take();
    if (ready !== undefined) this.settle(ready);
  }

  private onData(chunk: Buffer): void {
    if (this.failed !== undefined) return;
    const hadPartial = this.size > 0;
    let start = 0;
    for (let i = 0; i < chunk.byteLength; i += 1) {
      if (chunk[i] !== 0x0a) continue;
      const piece = chunk.subarray(start, i);
      if (this.size + piece.byteLength > this.maxLineBytes) {
        this.failed = 'oversize';
        this.flush();
        return;
      }
      this.chunks.push(piece);
      const line = Buffer.concat(this.chunks).toString('utf8');
      this.chunks = [];
      this.size = 0;
      this.lines.push(line.endsWith('\r') ? line.slice(0, -1) : line);
      start = i + 1;
    }
    const rest = chunk.subarray(start);
    if (rest.byteLength > 0) {
      if (this.size + rest.byteLength > this.maxLineBytes) {
        this.failed = 'oversize';
        this.flush();
        return;
      }
      this.chunks.push(Buffer.from(rest));
      this.size += rest.byteLength;
    }
    if (this.lines.length > 0) {
      this.flush();
      return;
    }
    // A frame has started: from now on the per-frame (slow-read) timeout applies.
    if (!hadPartial && this.size > 0 && this.waiter !== undefined) this.arm(this.frameMs);
  }
}

export function writeLine(socket: Socket, value: unknown): void {
  if (socket.destroyed || !socket.writable) return;
  socket.write(`${JSON.stringify(value)}\n`);
}

export function parseLine(text: string): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['__proto__', 'prototype', 'constructor']) {
    if (Object.hasOwn(record, key)) return undefined;
  }
  return record;
}

// ------------------------------------------------------------------ nonce cache (IPC-02, IPC-04)

/**
 * TTL-bounded anti-replay cache. A nonce is remembered until its frame could no longer pass
 * the skew check, so memory stays bounded by rate x window, and a hard cap refuses (BUSY)
 * rather than growing.
 */
export class NonceCache {
  private readonly entries = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly max: number;

  constructor(ttlMs = SKEW_MS * 2, max = 100_000) {
    this.ttlMs = ttlMs;
    this.max = max;
  }

  get size(): number {
    return this.entries.size;
  }

  /** 'fresh' consumes the nonce; 'replayed' and 'full' do not. */
  consume(key: string, nowMs: number): 'fresh' | 'replayed' | 'full' {
    const seen = this.entries.get(key);
    if (seen !== undefined && seen > nowMs) return 'replayed';
    if (this.entries.size >= this.max) this.sweep(nowMs);
    if (this.entries.size >= this.max) return 'full';
    this.entries.set(key, nowMs + this.ttlMs);
    return 'fresh';
  }

  sweep(nowMs: number): void {
    for (const [key, expires] of this.entries) {
      if (expires <= nowMs) this.entries.delete(key);
    }
  }
}

// ------------------------------------------------------------------ runtime version

let cachedPackage: { readonly root: string | null; readonly version: string } | undefined;

/** The installed Jevris package root and version, from the nearest package.json named jevris. */
export function jevrisPackage(from: string = import.meta.url): { readonly root: string | null; readonly version: string } {
  if (from === import.meta.url && cachedPackage !== undefined) return cachedPackage;
  let dir = dirname(from.startsWith('file:') ? fileURLToPath(from) : from);
  let found: { readonly root: string | null; readonly version: string } = { root: null, version: '0.0.0' };
  for (let depth = 0; depth < 12; depth += 1) {
    const raw = readPlain(join(dir, 'package.json'));
    if (raw !== undefined) {
      try {
        const parsed = JSON.parse(raw) as { readonly name?: unknown; readonly version?: unknown };
        if ((parsed.name === 'jevris' || parsed.name === '@webventures/jevris') && typeof parsed.version === 'string') {
          found = { root: dir, version: parsed.version };
          break;
        }
      } catch {
        // keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (from === import.meta.url) cachedPackage = found;
  return found;
}

export function runtimeVersion(): string {
  return jevrisPackage().version;
}

// ------------------------------------------------------------------ runtime build

/** A runtime build id: 16 hex characters. */
export const BUILD_ID = /^[0-9a-f]{16}$/;

/**
 * The build a runtime holds. `id` is a short SHA-256 of its dist/bundle-manifest.json, which
 * lists every bundled output with its own SHA-256, so two builds of one version (a reinstall
 * from a newer commit, or a dirty tree) differ. `commit` and `dirty` come from the runtime
 * manifest's `source`; a dirty build names no commit.
 */
export interface RuntimeBuild {
  readonly id: string;
  readonly commit: string | null;
  readonly dirty: boolean;
}

/** The build under a Jevris package or runtime root, or null where there is no bundle (a source tree before `npm run build`). */
export function runtimeBuild(root: string | null = jevrisPackage().root): RuntimeBuild | null {
  if (root === null) return null;
  const bundle = readPlain(join(root, 'dist', 'bundle-manifest.json'));
  if (bundle === undefined) return null;
  let commit: string | null = null;
  let dirty = false;
  const manifest = readPlain(join(root, 'dist', 'runtime', 'manifest.json'));
  if (manifest !== undefined) {
    try {
      const source = (JSON.parse(manifest) as { readonly source?: { readonly commit?: unknown; readonly dirty?: unknown } }).source;
      dirty = source?.dirty === true;
      commit = !dirty && typeof source?.commit === 'string' && /^[0-9a-f]{40}$/.test(source.commit) ? source.commit : null;
    } catch {
      commit = null;
    }
  }
  return { id: createHash('sha256').update(bundle, 'utf8').digest('hex').slice(0, 16), commit, dirty };
}

let loadedBuild: RuntimeBuild | null | undefined;

/**
 * The build this process loaded: read once, on the first call. The daemon calls it as it
 * starts, so a reinstall afterwards shows up as a different runtimeBuild() on disk.
 */
export function loadedRuntimeBuild(): RuntimeBuild | null {
  if (loadedBuild === undefined) loadedBuild = runtimeBuild();
  return loadedBuild;
}

function readPlain(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > 1_000_000) return undefined;
    const buffer = Buffer.alloc(Number(st.size));
    readSync(fd, buffer, 0, buffer.byteLength, 0);
    return buffer.toString('utf8');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Semver-ish comparison of dotted numeric versions; prerelease tags compare as text. */
export function compareVersions(left: string, right: string): number {
  const a = left.split(/[.+-]/);
  const b = right.split(/[.+-]/);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? '0';
    const y = b[i] ?? '0';
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Environment names that could carry a Jev key or a legacy hook token. The sidecar reads the
 * key only from the OS keystore, so it drops these at boot and no process it starts inherits
 * them; the detached sidecar is spawned without them too (GOV-06).
 */
export const CREDENTIAL_ENV_NAME = /^(JEVRIS_HOOK_|TYPESAFE_API_KEY|JEV_API_KEY|JEVRIS_API_KEY|JEVRIS_INSTALLER_KEY)/i;

/** Removes every CREDENTIAL_ENV_NAME variable from `env` in place and returns the names removed. */
export function scrubCredentialEnv(env: NodeJS.ProcessEnv): readonly string[] {
  const removed: string[] = [];
  for (const name of Object.keys(env)) {
    if (!CREDENTIAL_ENV_NAME.test(name)) continue;
    delete env[name];
    removed.push(name);
  }
  return removed;
}

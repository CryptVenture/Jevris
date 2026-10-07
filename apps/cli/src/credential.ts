import { constants as fsConstants, openSync, writeSync } from 'node:fs';
import { lstat, open as openFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { ReadStream } from 'node:tty';
import { diagnoseCredential } from '@jevris/core';
import {
  EXPLICIT_BASE_URL,
  EXPLICIT_LOG_LEVEL,
  HOST_SECRET_ACCOUNT,
  HOST_SECRET_SERVICE,
  PINNED_MODEL,
  assertNoProviderKey,
  toHarnessView,
  type ExplicitClientFields,
  type HarnessCredentialView,
} from '@jevris/contracts';

export { assertNoProviderKey, toHarnessView };

const STDIN_CAP = 4096;

export interface HostSecretPort {
  get(): string | undefined | Promise<string | undefined>;
  set(value: string): void | Promise<void>;
  delete(): void | Promise<void>;
}

export type OpenHostSecret = (
  service: string,
  account: string,
) => HostSecretPort | Promise<HostSecretPort>;

export interface RulesOnlyCredential {
  readonly mode: 'rules-only';
  readonly diagnostic: string;
  /** Why an opted-in credential source was refused (GOV-07). A reason code only, never content. */
  readonly refused?: OptInRefusal;
  /** Why the OS keystore could not be used, when it threw. A closed code only, never the binding's message. */
  readonly keystoreFailure?: KeystoreFailureCode;
}

export type ResolvedProviderCredential = ExplicitClientFields | RulesOnlyCredential;

export interface ResolveCredentialOptions {
  readonly fetch?: () => unknown;
  readonly installerEnvName?: string;
  readonly readEnv?: (name: string) => string | undefined;
  /**
   * The environment to read the GOV-07 opt-in from. Only JEVRIS_CREDENTIAL_FILE,
   * JEVRIS_CREDENTIAL_SYSTEMD and CREDENTIALS_DIRECTORY are read from it. Leave it out and
   * no opt-in source is ever consulted.
   */
  readonly optInEnv?: Readonly<Record<string, string | undefined>>;
  /** Test seam for the platform and the owner check. */
  readonly optInHost?: OptInHost;
  /** Told which source supplied the key. Never told the key. */
  readonly onSource?: (source: CredentialSource) => void;
}

export type CredentialSource = 'keychain' | 'file' | 'systemd-creds' | 'installer';

const DENIED_INSTALLER_NAMES = new Set<string>(['TYPESAFE_API_KEY']);

function decodeUtf8(bytes: Uint8Array): string | undefined {
  const Ctor = (globalThis as unknown as {
    TextDecoder?: new (label: string, options: { fatal: boolean }) => { decode(input?: Uint8Array): string };
  }).TextDecoder;
  if (Ctor === undefined) return undefined;
  try {
    return new Ctor('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function encodeUtf8(text: string): Uint8Array | undefined {
  const Ctor = (globalThis as unknown as {
    TextEncoder?: new () => { encode(input?: string): Uint8Array };
  }).TextEncoder;
  if (Ctor === undefined) return undefined;
  return new Ctor().encode(text);
}

function missingDiagnostic(): string {
  const diagnostic = diagnoseCredential({ presence: 'missing' });
  if (diagnostic === null) return '';
  return diagnostic.explanation;
}

function rulesOnly(keystoreFailure?: KeystoreFailureCode): RulesOnlyCredential {
  return {
    mode: 'rules-only',
    diagnostic: missingDiagnostic(),
    ...(keystoreFailure !== undefined ? { keystoreFailure } : {}),
  };
}

function clientFields(apiKey: string): ExplicitClientFields {
  return {
    apiKey,
    baseURL: EXPLICIT_BASE_URL,
    defaultModel: PINNED_MODEL,
    logLevel: EXPLICIT_LOG_LEVEL,
  };
}

function installerAllowed(name: string | undefined): name is string {
  return name !== undefined && name.length > 0 && !DENIED_INSTALLER_NAMES.has(name);
}

function viewFor(presence: 'present' | 'missing'): HarnessCredentialView {
  const diagnostic = diagnoseCredential({ presence });
  return toHarnessView({
    presence,
    diagnostic: diagnostic === null ? null : diagnostic.explanation,
  });
}

function acceptedSecret(value: string): boolean {
  return value.length > 0 && !value.includes('\n') && !value.includes('\r') && !value.includes('\0');
}

function decodeSecret(bytes: Uint8Array): string | undefined {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > STDIN_CAP) return undefined;
  let end = bytes.byteLength;
  const last = bytes[end - 1];
  if (last === 0x0a) end -= 1;
  if (end > 0 && bytes[end - 1] === 0x0d) end -= 1;
  if (end === 0) return undefined;
  for (let index = 0; index < end; index += 1) {
    const byte = bytes[index];
    if (byte === undefined || byte === 0x00 || byte === 0x0a || byte === 0x0d) return undefined;
  }
  const decoded = decodeUtf8(bytes.subarray(0, end));
  if (decoded === undefined || !acceptedSecret(decoded)) return undefined;
  return decoded;
}

export interface HiddenInput {
  setRawMode(mode: boolean): void;
  resume(): void;
  pause(): void;
  on(event: 'data', listener: (chunk: Uint8Array) => void): void;
  off(event: 'data', listener: (chunk: Uint8Array) => void): void;
}

export async function readHiddenLine(
  input: HiddenInput,
  prompt: (text: string) => void,
): Promise<Uint8Array | { readonly over: true }> {
  prompt('API key: ');
  const collected: number[] = [];
  let settled = false;
  const result = await new Promise<Uint8Array | { readonly over: true }>((resolve) => {
    const finish = (value: Uint8Array | { readonly over: true }): void => {
      if (settled) return;
      settled = true;
      input.off('data', onData);
      try {
        input.setRawMode(false);
      } catch {
        resolve(value);
        return;
      }
      input.pause();
      resolve(value);
    };
    const onData = (chunk: Uint8Array): void => {
      for (let index = 0; index < chunk.byteLength; index += 1) {
        const byte = chunk[index];
        if (byte === undefined) continue;
        if (byte === 0x03 || (byte === 0x04 && collected.length === 0)) {
          finish(new Uint8Array());
          return;
        }
        if (byte === 0x0d || byte === 0x0a) {
          finish(Uint8Array.from(collected));
          return;
        }
        if (byte === 0x7f || byte === 0x08) {
          collected.pop();
          continue;
        }
        if (byte < 0x20) continue;
        if (collected.length >= STDIN_CAP) {
          finish({ over: true });
          return;
        }
        collected.push(byte);
      }
    };
    input.on('data', onData);
    try {
      input.setRawMode(true);
      input.resume();
    } catch {
      finish({ over: true });
    }
  });
  prompt('\n');
  return result;
}

function wrapRaw(input: {
  setRawMode(mode: boolean): unknown;
  resume(): void;
  pause(): void;
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  off(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
}): HiddenInput {
  return {
    setRawMode(mode: boolean) {
      input.setRawMode(mode);
    },
    resume() {
      input.resume();
    },
    pause() {
      input.pause();
    },
    on(event, listener) {
      input.on(event, listener);
    },
    off(event, listener) {
      input.off(event, listener);
    },
  };
}

export async function readConsoleSecret(): Promise<Uint8Array | { readonly over: true }> {
  if (process.stdin.isTTY === true && typeof process.stdin.setRawMode === 'function') {
    return readHiddenLine(wrapRaw(process.stdin), (text) => {
      process.stderr.write(text);
    });
  }
  const path = process.platform === 'win32' ? 'CONIN$' : '/dev/tty';
  let fd: number;
  try {
    fd = openSync(path, process.platform === 'win32' ? 'r' : 'r+');
  } catch {
    return readCappedStdin(process.stdin);
  }
  const stream = new ReadStream(fd);
  try {
    return await readHiddenLine(wrapRaw(stream), (text) => {
      if (process.platform === 'win32') {
        process.stderr.write(text);
        return;
      }
      try {
        writeSync(fd, text);
      } catch {
        process.stderr.write(text);
      }
    });
  } finally {
    stream.destroy();
  }
}

export async function readCappedStdin(
  source: AsyncIterable<Uint8Array | string>,
): Promise<Uint8Array | { readonly over: true }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of source) {
    const bytes = chunk instanceof Uint8Array ? chunk : encodeUtf8(chunk);
    if (bytes === undefined || total > STDIN_CAP - bytes.byteLength) {
      return { over: true };
    }
    chunks.push(bytes);
    total += bytes.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function setHostSecret(bytes: Uint8Array, open: OpenHostSecret): Promise<'present' | 'refused'> {
  const secret = decodeSecret(bytes);
  if (secret === undefined) return 'refused';
  const port = await open(HOST_SECRET_SERVICE, HOST_SECRET_ACCOUNT);
  await port.set(secret);
  return 'present';
}

export async function clearHostSecret(open: OpenHostSecret): Promise<void> {
  const port = await open(HOST_SECRET_SERVICE, HOST_SECRET_ACCOUNT);
  await port.delete();
}

export async function credentialStatus(open: OpenHostSecret): Promise<HarnessCredentialView> {
  try {
    const port = await open(HOST_SECRET_SERVICE, HOST_SECRET_ACCOUNT);
    const value = await port.get();
    const presence = typeof value === 'string' && acceptedSecret(value) ? 'present' : 'missing';
    return viewFor(presence);
  } catch {
    return viewFor('missing');
  }
}

/**
 * GOV-07 (owner and security decision, 2026-09-26): an explicit opt-in credential source
 * for headless Linux, CI and WSL, where no OS keystore exists. Two sources, each named
 * exactly; nothing is ever searched for:
 *   JEVRIS_CREDENTIAL_FILE=/absolute/path   an owner-only file outside any git work tree
 *   JEVRIS_CREDENTIAL_SYSTEMD=<name>        $CREDENTIALS_DIRECTORY/<name> (systemd LoadCredential=)
 * The keychain stays the default: the opt-in is read only when the keychain has no key or
 * cannot be opened. The file is refused unless it is a regular file (not a symlink) owned
 * by this user with no group or other permission bits, in a directory nobody else can
 * write, with no .git in any ancestor. Its contents are never logged or echoed; refusals
 * carry a reason code only.
 */
export const CREDENTIAL_FILE_ENV = 'JEVRIS_CREDENTIAL_FILE';
export const CREDENTIAL_SYSTEMD_ENV = 'JEVRIS_CREDENTIAL_SYSTEMD';

export type OptInRefusal =
  | 'both-set'
  | 'not-absolute'
  | 'bad-name'
  | 'no-credentials-directory'
  | 'unsupported-platform'
  | 'unreadable'
  | 'symlink'
  | 'not-a-file'
  | 'not-owner'
  | 'group-or-world-access'
  | 'unsafe-directory'
  | 'inside-git-work-tree'
  | 'too-large'
  | 'malformed';

export interface OptInSource {
  readonly kind: 'file' | 'systemd-creds';
  readonly path: string;
}

export interface OptInHost {
  readonly platform?: string;
  readonly uid?: number;
}

const SYSTEMD_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

const REFUSAL_TEXT: Readonly<Record<OptInRefusal, string>> = {
  'both-set': 'set only one of JEVRIS_CREDENTIAL_FILE and JEVRIS_CREDENTIAL_SYSTEMD',
  'not-absolute': 'the path must be absolute and normalized',
  'bad-name': 'the systemd credential name is not valid',
  'no-credentials-directory': 'CREDENTIALS_DIRECTORY is not set to an absolute path',
  'unsupported-platform': 'the opt-in source is for Linux, CI and WSL; use the OS keystore on Windows',
  unreadable: 'the file could not be read',
  symlink: 'the file is a symbolic link',
  'not-a-file': 'the path is not a regular file',
  'not-owner': 'the file is not owned by the current user',
  'group-or-world-access': 'the file is readable or writable by group or others (chmod 600)',
  'unsafe-directory': 'the directory is writable by other users',
  'inside-git-work-tree': 'the file is inside a git work tree',
  'too-large': 'the file is larger than 4096 bytes',
  malformed: 'the file must hold one key on one line',
};

/** The rule an opt-in refusal broke, as a clause. Fixed text, never the contents. */
export function optInRefusalClause(reason: OptInRefusal): string {
  return REFUSAL_TEXT[reason];
}

/** One plain line for the sidecar log and `credential status`. It names the rule, never the contents. */
export function optInRefusalText(reason: OptInRefusal): string {
  return `jevris: the opt-in credential source was refused: ${REFUSAL_TEXT[reason]}. Jevris continues rules-only.`;
}

/** Reads the opt-in from exactly two named variables. Returns undefined when not opted in. */
export function optInSourceOf(
  env: Readonly<Record<string, string | undefined>>,
): OptInSource | { readonly refused: OptInRefusal } | undefined {
  const file = env[CREDENTIAL_FILE_ENV];
  const name = env[CREDENTIAL_SYSTEMD_ENV];
  const hasFile = typeof file === 'string' && file.length > 0;
  const hasName = typeof name === 'string' && name.length > 0;
  if (!hasFile && !hasName) return undefined;
  if (hasFile && hasName) return { refused: 'both-set' };
  if (hasFile) {
    if (!isAbsolute(file) || resolvePath(file) !== file) return { refused: 'not-absolute' };
    return { kind: 'file', path: file };
  }
  if (!SYSTEMD_NAME.test(name as string)) return { refused: 'bad-name' };
  const directory = env.CREDENTIALS_DIRECTORY;
  if (typeof directory !== 'string' || directory.length === 0 || !isAbsolute(directory)) {
    return { refused: 'no-credentials-directory' };
  }
  return { kind: 'systemd-creds', path: join(resolvePath(directory), name as string) };
}

function currentUid(host: OptInHost | undefined): number | undefined {
  if (host?.uid !== undefined) return host.uid;
  const getuid = Reflect.get(process, 'getuid');
  if (typeof getuid !== 'function') return undefined;
  const uid: unknown = Reflect.apply(getuid, process, []);
  return typeof uid === 'number' ? uid : undefined;
}

async function insideGitWorkTree(realFile: string): Promise<boolean> {
  let directory = dirname(realFile);
  for (let depth = 0; depth < 256; depth += 1) {
    try {
      await lstat(join(directory, '.git'));
      return true;
    } catch {
      // not here; keep walking up to the filesystem root
    }
    const parent = dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
  return true;
}

/**
 * Applies the GOV-07 rules to an opted-in source, and reads it when `readContents` is set.
 * The only place that opens the file. The value is returned to the caller and never written
 * anywhere. With `readContents` off no key byte is read: the file is checked and left alone.
 */
async function openOptIn(
  source: OptInSource,
  host: OptInHost | undefined,
  readContents: boolean,
): Promise<{ readonly secret: string | undefined } | { readonly refused: OptInRefusal }> {
  const platform = host?.platform ?? process.platform;
  if (platform === 'win32') return { refused: 'unsupported-platform' };
  const uid = currentUid(host);
  if (uid === undefined) return { refused: 'unsupported-platform' };
  let link;
  try {
    link = await lstat(source.path);
  } catch {
    return { refused: 'unreadable' };
  }
  if (link.isSymbolicLink()) return { refused: 'symlink' };
  if (!link.isFile()) return { refused: 'not-a-file' };
  if (link.uid !== uid) return { refused: 'not-owner' };
  if ((link.mode & 0o077) !== 0) return { refused: 'group-or-world-access' };
  if (link.size > STDIN_CAP) return { refused: 'too-large' };
  let real: string;
  try {
    real = await realpath(source.path);
  } catch {
    return { refused: 'unreadable' };
  }
  try {
    const parent = await lstat(dirname(real));
    const othersWrite = (parent.mode & 0o022) !== 0;
    if ((parent.uid !== uid && parent.uid !== 0) || othersWrite) return { refused: 'unsafe-directory' };
  } catch {
    return { refused: 'unreadable' };
  }
  if (await insideGitWorkTree(real)) return { refused: 'inside-git-work-tree' };
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const nonBlock = fsConstants.O_NONBLOCK ?? 0;
  let handle;
  try {
    handle = await openFile(source.path, fsConstants.O_RDONLY | noFollow | nonBlock);
  } catch {
    return { refused: 'unreadable' };
  }
  try {
    // Checked again on the open descriptor, so a swap after lstat is refused.
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== link.dev || opened.ino !== link.ino) return { refused: 'unreadable' };
    if (opened.uid !== uid) return { refused: 'not-owner' };
    if ((opened.mode & 0o077) !== 0) return { refused: 'group-or-world-access' };
    if (opened.size > STDIN_CAP) return { refused: 'too-large' };
    if (!readContents) return { secret: undefined };
    const buffer = new Uint8Array(STDIN_CAP + 1);
    let total = 0;
    while (total < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, total, buffer.byteLength - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > STDIN_CAP) return { refused: 'too-large' };
    const secret = decodeSecret(buffer.subarray(0, total));
    buffer.fill(0);
    if (secret === undefined) return { refused: 'malformed' };
    return { secret };
  } catch {
    return { refused: 'unreadable' };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Reads an opted-in source under the GOV-07 rules. The value is returned and never written anywhere. */
export async function readOptInCredential(
  source: OptInSource,
  host?: OptInHost,
): Promise<{ readonly secret: string } | { readonly refused: OptInRefusal }> {
  const result = await openOptIn(source, host, true);
  if ('refused' in result) return result;
  return result.secret === undefined ? { refused: 'malformed' } : { secret: result.secret };
}

/**
 * Whether an opted-in source passes every GOV-07 rule that does not need its contents
 * (type, owner, mode, folder, work tree, size). No key byte is read, so doctor can use it.
 */
export async function inspectOptInSource(
  source: OptInSource,
  host?: OptInHost,
): Promise<{ readonly ok: true } | { readonly refused: OptInRefusal }> {
  const result = await openOptIn(source, host, false);
  return 'refused' in result ? result : { ok: true };
}

async function fromOptIn(
  options: ResolveCredentialOptions | undefined,
  keystoreFailure: KeystoreFailureCode | undefined,
): Promise<ResolvedProviderCredential | undefined> {
  const env = options?.optInEnv;
  if (env === undefined) return undefined;
  const source = optInSourceOf(env);
  if (source === undefined) return undefined;
  if ('refused' in source) return { ...rulesOnly(keystoreFailure), refused: source.refused };
  const read = await readOptInCredential(source, options?.optInHost);
  if ('refused' in read) return { ...rulesOnly(keystoreFailure), refused: read.refused };
  options?.onSource?.(source.kind);
  return clientFields(read.secret);
}

export async function resolveProviderCredential(
  open: OpenHostSecret,
  options?: ResolveCredentialOptions,
): Promise<ResolvedProviderCredential> {
  let keystoreFailed = false;
  let keystoreFailure: KeystoreFailureCode | undefined;
  try {
    const port = await open(HOST_SECRET_SERVICE, HOST_SECRET_ACCOUNT);
    const value = await port.get();
    if (typeof value === 'string' && acceptedSecret(value)) {
      options?.onSource?.('keychain');
      return clientFields(value);
    }
  } catch (error) {
    keystoreFailed = true;
    keystoreFailure = keystoreFailureOf(error, options?.optInHost?.platform) ?? undefined;
  }
  // GOV-07: the keychain is the default; an explicit opt-in is read only when it has no key.
  const optedIn = await fromOptIn(options, keystoreFailure);
  if (optedIn !== undefined) return optedIn;
  if (keystoreFailed) return rulesOnly(keystoreFailure);
  const name = options?.installerEnvName;
  if (!installerAllowed(name)) return rulesOnly();
  const readEnv = options?.readEnv;
  if (readEnv === undefined) return rulesOnly();
  try {
    const fromEnv = readEnv(name);
    if (typeof fromEnv !== 'string' || !acceptedSecret(fromEnv)) return rulesOnly();
    options?.onSource?.('installer');
    return clientFields(fromEnv);
  } catch {
    return rulesOnly();
  }
}

export function emitCredentialStatus(view: object, write: (text: string) => void): number {
  if (!assertNoProviderKey(view)) {
    write('refused\n');
    return 2;
  }
  const presence = Reflect.get(view, 'presence');
  const diagnostic = Reflect.get(view, 'diagnostic');
  if (presence === 'present' && diagnostic === null) {
    write('present\n');
    return 0;
  }
  if (presence === 'missing' && (diagnostic === null || typeof diagnostic === 'string')) {
    write('missing\n');
    const line = missingDiagnostic();
    if (line.length > 0) write(`${line}\n`);
    return 0;
  }
  write('refused\n');
  return 2;
}

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

interface KeyringModule {
  Entry: new (
    service: string,
    account: string,
    options?: { readonly linux: { readonly store: 'secret-service' } },
  ) => KeyringEntry;
}

/**
 * Test runs must never reach the OS keychain (macOS Keychain, Windows Credential Manager,
 * Linux Secret Service). Under a test runner, with a temporary HOME, macOS shows a
 * "keychain not found" dialog. scripts/test.mjs sets JEVRIS_TEST=1 and node --test sets
 * NODE_TEST_CONTEXT in every test process, and children inherit both. A test that needs
 * a keyring injects a memory port through the openKeyring seam instead.
 */
export class KeyringBlockedError extends Error {
  readonly code = 'ERR_JEVRIS_KEYRING_BLOCKED';
  constructor() {
    super('keyring-blocked-in-tests');
  }
}

export function keyringBlockedInTests(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.JEVRIS_TEST === '1' || (typeof env.NODE_TEST_CONTEXT === 'string' && env.NODE_TEST_CONTEXT.length > 0);
}

/** One plain line when the keyring binding does not load (BLD-13). No stack, no path. */
export const KEYRING_UNAVAILABLE =
  'jevris: the OS keyring binding could not be loaded. Jevris continues rules-only: no provider key is stored or read. Run "jevris doctor" for details; reinstalling on a supported Node (^22.14.0 || >=23.6.0) usually fixes it.';

export class KeyringUnavailableError extends Error {
  readonly code = 'ERR_JEVRIS_KEYRING_UNAVAILABLE';
  constructor() {
    super('keyring-binding-unavailable');
  }
}

/**
 * Why the OS keystore could not be used, from what the binding threw. Only a closed code is
 * kept: the binding's own message can carry bus names and paths, so it is never printed,
 * logged or stored. The classification reads the message to pick a code and then forgets it.
 */
export type KeystoreFailureCode = 'KEYSTORE_BINDING' | 'KEYSTORE_NO_SERVICE' | 'KEYSTORE_LOCKED' | 'KEYSTORE_FAILED';

const LOCKED_MESSAGE = /locked|dismissed|denied|not allowed|cancel|user interaction|authori[sz]ation|permission/;
const NO_SERVICE_MESSAGE = /dbus|d-bus|session bus|org\.freedesktop\.secrets|secret service/;

export function keystoreFailureOf(error: unknown, platform: string = process.platform): KeystoreFailureCode | null {
  // A test run blocks the keystore on purpose; that is not a failure of the machine.
  if (error instanceof KeyringBlockedError) return null;
  if (error instanceof KeyringUnavailableError) return 'KEYSTORE_BINDING';
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (LOCKED_MESSAGE.test(message)) return 'KEYSTORE_LOCKED';
  if (platform === 'linux' && NO_SERVICE_MESSAGE.test(message)) return 'KEYSTORE_NO_SERVICE';
  return 'KEYSTORE_FAILED';
}

/** What went wrong, as a clause that fits after "jevris: ". Fixed text per code and OS. */
export function keystoreFailureClause(code: KeystoreFailureCode, platform: string = process.platform): string {
  switch (code) {
    case 'KEYSTORE_BINDING':
      return 'the OS keyring binding could not be loaded';
    case 'KEYSTORE_NO_SERVICE':
      return 'no Secret Service (GNOME Keyring or KWallet) is running for this session, so there is no OS keyring to hold a key';
    case 'KEYSTORE_LOCKED':
      return platform === 'darwin'
        ? 'the login keychain is locked or access was denied'
        : platform === 'win32'
          ? 'Windows Credential Manager refused access'
          : 'the Secret Service is locked or refused access';
    case 'KEYSTORE_FAILED':
      return platform === 'linux'
        ? 'the Secret Service did not accept the request'
        : platform === 'darwin'
          ? 'the macOS Keychain did not accept the request'
          : platform === 'win32'
            ? 'Windows Credential Manager did not accept the request'
            : 'the OS keystore did not accept the request';
  }
}

/** The way out, in plain steps. On Linux it is the owner-only key file; elsewhere the keystore itself. */
export function keystoreFailureRemedy(code: KeystoreFailureCode, platform: string = process.platform): readonly string[] {
  if (platform === 'linux') {
    return [
      ...(code === 'KEYSTORE_LOCKED' ? ['Unlock the keyring in your login session and run the command again, or use a key file:'] : ['On a headless server, CI or WSL, use an owner-only key file instead:']),
      '  1. save the key on one line in a file only you can read (mode 600, in a folder only you can write, outside any git work tree);',
      '  2. name it where the sidecar starts: export JEVRIS_CREDENTIAL_FILE=/absolute/path/to/the/file (or JEVRIS_CREDENTIAL_SYSTEMD=<name> under systemd);',
      '  3. run "jevris sidecar restart", then "jevris credential status". Jevris never searches for a key file, so the variable must name it.',
    ];
  }
  if (platform === 'darwin') return ['Unlock the login keychain, run "jevris credential set" again and choose Allow.'];
  if (platform === 'win32') return ['Credential Manager is per user: run Jevris as the user that runs your harness.'];
  return ['Run "jevris doctor" for details.'];
}

/**
 * Printed after "refused" when `credential set` could not store the key. When a key source is
 * already named in this environment it points at `credential status` instead of the setup steps.
 */
export function credentialSetRefusalLines(
  code: KeystoreFailureCode,
  platform: string = process.platform,
  optInConfigured = false,
): readonly string[] {
  const first = `jevris: the key was not stored: ${keystoreFailureClause(code, platform)} (${code}).`;
  if (optInConfigured) {
    return [first, 'A key source is already named by JEVRIS_CREDENTIAL_FILE or JEVRIS_CREDENTIAL_SYSTEMD in this environment: run "jevris credential status" to see whether it is used.'];
  }
  return [first, ...keystoreFailureRemedy(code, platform)];
}

/** Printed after "refused" when the input itself was not a storable key. */
export const CREDENTIAL_INPUT_REFUSED =
  'jevris: no key was stored: the key is read from standard input or a hidden prompt and must be one line of 1 to 4096 bytes with no NUL byte.';

/** The harness view of a report: presence and the plain diagnostic, never the key. */
export function credentialViewFor(report: CredentialReport): HarnessCredentialView {
  return viewFor(report.presence);
}

/**
 * The opt-in variables of an environment, for `credential status`. Under a test run none is
 * read (the same rule as the sidecar), so a developer's shell variable never reaches a test.
 */
export function optInEnvOf(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<string, string | undefined>> {
  if (keyringBlockedInTests(env)) return {};
  return {
    [CREDENTIAL_FILE_ENV]: env[CREDENTIAL_FILE_ENV],
    [CREDENTIAL_SYSTEMD_ENV]: env[CREDENTIAL_SYSTEMD_ENV],
    CREDENTIALS_DIRECTORY: env.CREDENTIALS_DIRECTORY,
  };
}

export interface CredentialReport {
  readonly presence: 'present' | 'missing';
  /** Which source supplies the key; null when none does. */
  readonly source: CredentialSource | null;
  readonly keystoreFailure: KeystoreFailureCode | null;
  /** True when JEVRIS_CREDENTIAL_FILE or JEVRIS_CREDENTIAL_SYSTEMD names a source. */
  readonly optInConfigured: boolean;
  readonly optInRefused: OptInRefusal | null;
}

/**
 * What the sidecar would find if it started in this environment: the same resolver, with the
 * key dropped. `credential status` prints this so it never disagrees with the sidecar.
 */
export async function credentialReport(
  open: OpenHostSecret,
  options?: Pick<ResolveCredentialOptions, 'optInEnv' | 'optInHost'>,
): Promise<CredentialReport> {
  let source: CredentialSource | null = null;
  const resolved = await resolveProviderCredential(open, {
    ...(options?.optInEnv !== undefined ? { optInEnv: options.optInEnv } : {}),
    ...(options?.optInHost !== undefined ? { optInHost: options.optInHost } : {}),
    onSource: (found) => {
      source = found;
    },
  });
  const optInConfigured = options?.optInEnv !== undefined && optInSourceOf(options.optInEnv) !== undefined;
  if ('apiKey' in resolved) {
    return { presence: 'present', source, keystoreFailure: null, optInConfigured, optInRefused: null };
  }
  return {
    presence: 'missing',
    source: null,
    keystoreFailure: resolved.keystoreFailure ?? null,
    optInConfigured,
    optInRefused: resolved.refused ?? null,
  };
}

const SOURCE_VARIABLE: Readonly<Record<'file' | 'systemd-creds', string>> = {
  file: CREDENTIAL_FILE_ENV,
  'systemd-creds': CREDENTIAL_SYSTEMD_ENV,
};

/**
 * The lines `credential status` prints after present or missing, beyond the key's presence:
 * which opt-in source supplies it, or why the keystore or the opt-in source did not. Empty on
 * a host where the keystore works, so the plain keychain output is unchanged.
 */
export function credentialStatusLines(report: CredentialReport, platform: string = process.platform): readonly string[] {
  if (report.presence === 'present') {
    if (report.source === 'file' || report.source === 'systemd-creds') {
      return [`source: ${SOURCE_VARIABLE[report.source]} (the OS keyring has no key for it to override)`];
    }
    return [];
  }
  const lines: string[] = [];
  if (report.keystoreFailure !== null) {
    lines.push(`jevris: ${keystoreFailureClause(report.keystoreFailure, platform)} (${report.keystoreFailure}).`);
  }
  if (report.optInRefused !== null) lines.push(optInRefusalText(report.optInRefused));
  else if (report.keystoreFailure !== null && !report.optInConfigured) lines.push(...keystoreFailureRemedy(report.keystoreFailure, platform));
  return lines;
}

/**
 * The sidecar's status advice while it has no Jev key. The default is the plain "run
 * credential set"; where that cannot work (the keystore failed, or an opt-in source was
 * refused) it says what to do instead, because pointing at the failing command is a dead end.
 */
export function noCredentialAdvice(input: {
  readonly keystoreFailure?: KeystoreFailureCode | undefined;
  readonly optInRefused?: OptInRefusal | undefined;
  readonly platform?: string | undefined;
}): string {
  const platform = input.platform ?? process.platform;
  if (input.optInRefused !== undefined) {
    return `The opt-in Jev key source was refused (${input.optInRefused}): ${REFUSAL_TEXT[input.optInRefused]}; decisions run rules-only. Fix it, then run \`jevris sidecar restart\`.`;
  }
  const failure = input.keystoreFailure;
  if (failure === undefined) return 'No Jev credential is configured; decisions run rules-only. Run `jevris credential set`.';
  const clause = keystoreFailureClause(failure, platform);
  return platform === 'linux'
    ? `No Jev key is available: ${clause} (${failure}); decisions run rules-only. Name an owner-only key file with JEVRIS_CREDENTIAL_FILE in the sidecar's environment (docs/security.md), then run \`jevris sidecar restart\`.`
    : `No Jev key is available: ${clause} (${failure}); decisions run rules-only. Fix the keystore and run \`jevris credential set\`.`;
}

export type KeyringBindingStatus = 'loaded' | 'unavailable' | 'not-probed';

/**
 * Whether the keyring binding loads, for doctor. It never opens an entry, so it never
 * reaches the OS keychain; under a test run it is not probed at all.
 */
export async function probeKeyringBinding(): Promise<KeyringBindingStatus> {
  if (keyringBlockedInTests()) return 'not-probed';
  try {
    await loadKeyring();
    return 'loaded';
  } catch {
    return 'unavailable';
  }
}

export async function openHostEntry(service: string, account: string): Promise<HostSecretPort> {
  if (keyringBlockedInTests()) throw new KeyringBlockedError();
  const loaded = await loadKeyring();
  const Entry = loaded.Entry;
  const entry =
    process.platform === 'linux'
      ? new Entry(service, account, { linux: { store: 'secret-service' } })
      : new Entry(service, account);
  return {
    get() {
      const value = entry.getPassword();
      if (value === null || value.length === 0) return undefined;
      return value;
    },
    set(value: string) {
      entry.setPassword(value);
    },
    delete() {
      entry.deletePassword();
    },
  };
}

/** The only import of the keyring binding. Callers check keyringBlockedInTests first. */
async function loadKeyring(): Promise<KeyringModule> {
  let loaded: KeyringModule;
  try {
    loaded = (await import('@napi-rs/keyring')) as KeyringModule;
  } catch {
    throw new KeyringUnavailableError();
  }
  if (typeof loaded.Entry !== 'function') throw new KeyringUnavailableError();
  return loaded;
}

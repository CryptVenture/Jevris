/**
 * A Jevris-home file that grants authority (SR-4): today the egress approval in `host.json`
 * and `organization.json`. Such a file counts only when all of these hold:
 *
 * - the resolved Jevris home is not inside a git work tree (a workspace is one);
 * - the file is not inside a git work tree;
 * - the file is a regular file, not a symbolic link;
 * - on macOS and Linux, it is owned by the current user and no group or other user may write it.
 *
 * On Windows the owner and the ACL are not checked here: that needs `icacls`, which is too slow
 * for a check made on every request. The symlink, regular-file and work-tree rules still apply.
 *
 * Otherwise the file is refused with a reason code and grants nothing. The read itself opens the
 * file without following a link and checks that the descriptor is the file that was checked, so a
 * swap in between is refused too. Synchronous: the egress guard asks on every request.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats, type Stats } from 'node:fs';
import { pathApiFor } from './paths.js';

export type AuthorityFileRefusal =
  | 'AUTHORITY_FILE_SYMLINK'
  | 'AUTHORITY_FILE_NOT_REGULAR'
  | 'AUTHORITY_FILE_NOT_OWNER'
  | 'AUTHORITY_FILE_SHARED_WRITE'
  | 'AUTHORITY_FILE_IN_WORK_TREE'
  | 'JEVRIS_HOME_IN_WORK_TREE';

export const AUTHORITY_FILE_REFUSALS: readonly AuthorityFileRefusal[] = [
  'AUTHORITY_FILE_SYMLINK',
  'AUTHORITY_FILE_NOT_REGULAR',
  'AUTHORITY_FILE_NOT_OWNER',
  'AUTHORITY_FILE_SHARED_WRITE',
  'AUTHORITY_FILE_IN_WORK_TREE',
  'JEVRIS_HOME_IN_WORK_TREE',
];

export interface AuthorityFileInput {
  /** The resolved Jevris home. */
  readonly home: string;
  readonly platform?: string;
  /** The current user (tests); default process.getuid(). */
  readonly uid?: number;
}

export type AuthorityFileRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'refused'; readonly reasonCode: AuthorityFileRefusal }
  | { readonly kind: 'ok'; readonly bytes: Uint8Array };

function currentUid(input: AuthorityFileInput): number | undefined {
  if (input.uid !== undefined) return input.uid;
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function hasGitAbove(start: string, platform: string): boolean {
  const api = pathApiFor(platform);
  let current = api.resolve(start);
  for (let depth = 0; depth < 256; depth += 1) {
    try {
      lstatSync(api.join(current, '.git'));
      return true;
    } catch {
      // Not here: keep walking up to the filesystem root.
    }
    const parent = api.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return true;
}

/**
 * True when `path` or a folder above it holds `.git` (a repository, or a linked worktree's
 * `.git` file). Both the path as given and its real path are walked, so a link into a
 * repository counts as inside it.
 */
export function insideGitWorkTree(path: string, platform: string = process.platform): boolean {
  if (hasGitAbove(path, platform)) return true;
  try {
    const real = realpathSync(path);
    return real !== path && hasGitAbove(real, platform);
  } catch {
    return false;
  }
}

function fileRefusal(stats: Stats, input: AuthorityFileInput, platform: string): AuthorityFileRefusal | null {
  if (stats.isSymbolicLink()) return 'AUTHORITY_FILE_SYMLINK';
  if (!stats.isFile()) return 'AUTHORITY_FILE_NOT_REGULAR';
  if (platform === 'win32') return null;
  const uid = currentUid(input);
  if (uid === undefined || stats.uid !== uid) return 'AUTHORITY_FILE_NOT_OWNER';
  if ((stats.mode & 0o022) !== 0) return 'AUTHORITY_FILE_SHARED_WRITE';
  return null;
}

/**
 * Why a present authority file does not count, or null when it counts (or is missing, which
 * grants nothing by itself). Doctor and `jevris egress status` name the reason code.
 */
export function authorityFileRefusal(path: string, input: AuthorityFileInput): AuthorityFileRefusal | null {
  const read = readAuthorityFile(path, input, 0);
  return read.kind === 'refused' ? read.reasonCode : null;
}

/**
 * Reads an authority file under the rules above, at most `maxBytes` (0: check only, read
 * nothing). A missing file is `missing`; one that cannot be read or is larger than the cap is
 * `invalid`; one that breaks a rule is `refused` with its reason code.
 */
export function readAuthorityFile(path: string, input: AuthorityFileInput, maxBytes: number): AuthorityFileRead {
  const platform = input.platform ?? process.platform;
  const api = pathApiFor(platform);
  let link: Stats;
  try {
    link = lstatSync(path);
  } catch (error) {
    const code = error !== null && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'missing' } : { kind: 'invalid' };
  }
  if (insideGitWorkTree(input.home, platform)) return { kind: 'refused', reasonCode: 'JEVRIS_HOME_IN_WORK_TREE' };
  const refusal = fileRefusal(link, input, platform);
  if (refusal !== null) return { kind: 'refused', reasonCode: refusal };
  if (insideGitWorkTree(api.dirname(path), platform)) return { kind: 'refused', reasonCode: 'AUTHORITY_FILE_IN_WORK_TREE' };
  if (maxBytes === 0) return { kind: 'ok', bytes: new Uint8Array(0) };
  // The open descriptor is checked under the same rules, so a swap after lstat is refused too.
  const opened: { refusal: AuthorityFileRefusal | null } = { refusal: null };
  const read = readFileNoFollow(path, maxBytes, (stats) => (opened.refusal = fileRefusal(stats, input, platform)) === null);
  if (opened.refusal !== null) return { kind: 'refused', reasonCode: opened.refusal };
  if (read.kind === 'ok') return read;
  if (read.kind === 'missing') return read;
  return read.kind === 'link' ? { kind: 'refused', reasonCode: 'AUTHORITY_FILE_SYMLINK' } : read.kind === 'not-regular' ? { kind: 'refused', reasonCode: 'AUTHORITY_FILE_NOT_REGULAR' } : { kind: 'invalid' };
}

export type NoFollowRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'link' }
  | { readonly kind: 'not-regular' }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'ok'; readonly bytes: Uint8Array };

/**
 * Whether the open descriptor is the file `lstat` saw: the same device and inode, compared as
 * bigints (a 64-bit file id loses bits as a number). On Windows a path's stat can give the volume
 * serial number in 64 bits (the GetFileInformationByName path, as on windows-latest) where the
 * descriptor's gives its low 32, so there the device is compared on those 32 bits.
 */
export function sameOpenedFile(byPath: BigIntStats, byFd: BigIntStats, platform: string = process.platform): boolean {
  if (byPath.ino !== byFd.ino) return false;
  return platform === 'win32' ? (byPath.dev & 0xffffffffn) === (byFd.dev & 0xffffffffn) : byPath.dev === byFd.dev;
}

/**
 * Reads a regular file without following a symbolic link, at most `maxBytes`, and never more
 * than that from the disk: the size is checked on the link itself and on the open descriptor,
 * and the descriptor must be the file that was checked (the same device and inode), so a swap in
 * between reads nothing. `accept` sees the open descriptor's stats; false makes it `unreadable`.
 */
export function readFileNoFollow(path: string, maxBytes: number, accept: (opened: Stats) => boolean = () => true): NoFollowRead {
  let link: BigIntStats;
  try {
    link = lstatSync(path, { bigint: true });
  } catch (error) {
    const code = error !== null && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'missing' } : { kind: 'unreadable' };
  }
  if (link.isSymbolicLink()) return { kind: 'link' };
  if (!link.isFile()) return { kind: 'not-regular' };
  if (link.size > BigInt(maxBytes)) return { kind: 'too-large' };
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    const code = error !== null && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
    // O_NOFOLLOW on a link that replaced the file after lstat: ELOOP (Linux, macOS) or EMLINK (FreeBSD).
    if (code === 'ELOOP' || code === 'EMLINK') return { kind: 'link' };
    return code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable' };
  }
  try {
    if (!sameOpenedFile(link, fstatSync(fd, { bigint: true }))) return { kind: 'unreadable' };
    const opened = fstatSync(fd);
    if (!opened.isFile()) return { kind: 'unreadable' };
    if (!accept(opened)) return { kind: 'unreadable' };
    if (opened.size > maxBytes) return { kind: 'too-large' };
    const buffer = new Uint8Array(maxBytes + 1);
    let total = 0;
    while (total < buffer.byteLength) {
      const got = readSync(fd, buffer, total, buffer.byteLength - total, null);
      if (got === 0) break;
      total += got;
    }
    if (total > maxBytes) return { kind: 'too-large' };
    return { kind: 'ok', bytes: buffer.subarray(0, total) };
  } catch {
    return { kind: 'unreadable' };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Already closed.
    }
  }
}

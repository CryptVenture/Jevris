/**
 * Network filesystem detection (DATA-10, SSOT §17.1, E31). SQLite's locking is unreliable
 * over NFS, SMB and similar, and the store must never be shared across machines, so the
 * store refuses a database directory on one.
 *
 * - Linux: `statfs` magic numbers of network filesystems.
 * - macOS: the filesystem type of the longest mount point containing the directory, from
 *   `/sbin/mount`.
 * - Windows: a UNC path, or a drive whose `DriveInfo.DriveType` is `Network`.
 *
 * Detection that cannot run reports `unknown`; the store opens and shows `unknown` in
 * health rather than refuse a local disk it failed to classify.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync, statfsSync } from 'node:fs';

export type FsKind = 'local' | 'network' | 'unknown';

export interface FsKindResult {
  readonly kind: FsKind;
  /** A short filesystem label (for example `nfs`, `smbfs`, `ext4-or-other`), never a path. */
  readonly label: string;
}

/** statfs f_type values of network filesystems (linux/magic.h and filesystem sources). */
export const LINUX_NETWORK_MAGIC: ReadonlyMap<number, string> = new Map([
  [0x6969, 'nfs'],
  [0x517b, 'smb'],
  [0xff534d42, 'cifs'],
  [0xfe534d42, 'smb2'],
  [0x73757245, 'coda'],
  [0x5346414f, 'afs'],
  [0x6b414653, 'kafs'],
  [0x01021997, 'v9fs'],
  [0x00c36400, 'ceph'],
  [0x47504653, 'gpfs'],
  [0x0bd00bd0, 'lustre'],
  [0x564c, 'ncp'],
]);

/** macOS mount types that are network filesystems. */
export const DARWIN_NETWORK_TYPES: ReadonlySet<string> = new Set(['nfs', 'smbfs', 'afpfs', 'webdav', 'cifs', 'ftp', 'osxfuse-sshfs', 'macfuse-sshfs']);

export interface FsKindDeps {
  readonly platform?: string;
  readonly statfsType?: (dir: string) => number;
  readonly mountTable?: () => string | undefined;
  readonly windowsDriveType?: (driveLetter: string) => string | undefined;
  readonly realpath?: (dir: string) => string;
}

function linuxKind(dir: string, deps: FsKindDeps): FsKindResult {
  const read = deps.statfsType ?? ((d: string) => Number(statfsSync(d).type));
  let type: number;
  try {
    type = read(dir) >>> 0;
  } catch {
    return { kind: 'unknown', label: 'statfs-failed' };
  }
  const name = LINUX_NETWORK_MAGIC.get(type);
  return name !== undefined ? { kind: 'network', label: name } : { kind: 'local', label: `0x${type.toString(16)}` };
}

function defaultMountTable(): string | undefined {
  const result = spawnSync('/sbin/mount', [], { shell: false, timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return result.status === 0 ? result.stdout : undefined;
}

/** Parses `mount` lines: `<device> on <mount point> (<type>, <options>)`. */
export function parseDarwinMounts(text: string): readonly { readonly point: string; readonly type: string }[] {
  const out: { point: string; type: string }[] = [];
  for (const line of text.split('\n')) {
    const match = /^.+? on (.+) \(([^,)]+)/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) out.push({ point: match[1], type: match[2].trim() });
  }
  return out;
}

function within(dir: string, point: string): boolean {
  if (point === '/') return true;
  return dir === point || dir.startsWith(`${point}/`);
}

function darwinKind(dir: string, deps: FsKindDeps): FsKindResult {
  const table = (deps.mountTable ?? defaultMountTable)();
  if (table === undefined) return { kind: 'unknown', label: 'mount-failed' };
  let best: { point: string; type: string } | undefined;
  for (const entry of parseDarwinMounts(table)) {
    if (within(dir, entry.point) && (best === undefined || entry.point.length > best.point.length)) best = entry;
  }
  if (best === undefined) return { kind: 'unknown', label: 'no-mount' };
  return { kind: DARWIN_NETWORK_TYPES.has(best.type) ? 'network' : 'local', label: best.type };
}

function defaultDriveType(letter: string): string | undefined {
  const root = process.env['SystemRoot'] ?? 'C:\\Windows';
  const ps = `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const result = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', `[System.IO.DriveInfo]::new('${letter}').DriveType`], {
    shell: false,
    timeout: 8000,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function windowsKind(dir: string, deps: FsKindDeps): FsKindResult {
  const normal = dir.replace(/\//g, '\\');
  if (/^\\\\\?\\UNC\\/i.test(normal)) return { kind: 'network', label: 'unc' };
  if (/^\\\\[?.]\\/.test(normal)) {
    // \\?\C:\ and \\.\C:\ are local device paths; classify the drive.
    const letter = /^\\\\[?.]\\([A-Za-z]):/.exec(normal)?.[1];
    if (letter === undefined) return { kind: 'unknown', label: 'device-path' };
    return driveKind(letter, deps);
  }
  if (normal.startsWith('\\\\')) return { kind: 'network', label: 'unc' };
  const letter = /^([A-Za-z]):/.exec(normal)?.[1];
  if (letter === undefined) return { kind: 'unknown', label: 'no-drive' };
  return driveKind(letter, deps);
}

function driveKind(letter: string, deps: FsKindDeps): FsKindResult {
  let type: string | undefined;
  try {
    type = (deps.windowsDriveType ?? defaultDriveType)(letter.toUpperCase());
  } catch {
    type = undefined;
  }
  if (type === undefined || type.length === 0) return { kind: 'unknown', label: 'drivetype-failed' };
  return { kind: type === 'Network' ? 'network' : 'local', label: type.toLowerCase() };
}

/** Classifies the filesystem holding `dir` (which must exist). */
export function filesystemKind(dir: string, deps: FsKindDeps = {}): FsKindResult {
  const platform = deps.platform ?? process.platform;
  let real = dir;
  try {
    real = (deps.realpath ?? realpathSync)(dir);
  } catch {
    // classify the given path
  }
  if (platform === 'win32') return windowsKind(real, deps);
  if (platform === 'darwin') return darwinKind(real, deps);
  if (platform === 'linux' || platform === 'android') return linuxKind(real, deps);
  // FreeBSD and others: statfs types differ; report unknown rather than guess.
  return { kind: 'unknown', label: platform };
}

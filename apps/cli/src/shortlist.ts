import { lstat, open, readdir, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { formatShortlist, shortlistEvidence, shortlistInstalledSkills } from '@jevris/core';

/**
 * Bounded local reader for the shortlist command.
 * Roots outside home are refused before any read. Omitted roots are not a home scan.
 */

const SKILL_CAP = 8192;
const EVIDENCE_CAP = 4096;
const LIST_CAP = 65;
const ID_BYTE_LIMIT = 256;
const DIRECTORY_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ShortlistCommand {
  readonly home: string;
  readonly skillsRoot?: string;
  readonly evidenceRoot?: string;
  readonly intent: string;
  readonly skillId?: string;
  readonly evidenceIds: readonly string[];
}

function staysInside(rootReal: string, candidateReal: string, expectedRel: string): boolean {
  const rel = relative(rootReal, candidateReal);
  if (rel.startsWith('..') || isAbsolute(rel)) return false;
  return rel === expectedRel;
}

function slashRel(value: string): string {
  if (sep === '/') return value;
  return value.split(sep).join('/');
}

async function rootInsideHome(home: string, root: string): Promise<boolean> {
  if (home.length === 0 || root.length === 0) return false;
  const resolvedHome = resolve(home);
  const resolvedRoot = resolve(root);
  const expectedRel = relative(resolvedHome, resolvedRoot);
  if (expectedRel.startsWith('..') || isAbsolute(expectedRel)) return false;
  let homeReal: string;
  let rootReal: string;
  try {
    homeReal = await realpath(resolvedHome);
    rootReal = await realpath(resolvedRoot);
  } catch {
    return false;
  }
  return staysInside(homeReal, rootReal, expectedRel);
}

function boundedPath(root: string, relativeId: string): string | null {
  if (relativeId.length === 0 || relativeId.includes('\0') || isAbsolute(relativeId)) return null;
  const resolvedRoot = resolve(root);
  const expected = resolve(resolvedRoot, relativeId);
  const rel = slashRel(relative(resolvedRoot, expected));
  if (rel.startsWith('..') || isAbsolute(rel) || rel !== relativeId) return null;
  return expected;
}

function utf8ByteLength(value: string): number {
  const Ctor = (
    globalThis as unknown as {
      TextEncoder?: new () => { encode(input?: string): Uint8Array };
    }
  ).TextEncoder;
  if (Ctor === undefined) return value.length * 4;
  return new Ctor().encode(value).byteLength;
}

function compareNames(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

async function listEvidenceFiles(root: string): Promise<readonly string[]> {
  const resolvedRoot = resolve(root);
  let rootReal: string;
  try {
    rootReal = await realpath(resolvedRoot);
  } catch {
    return [];
  }
  const found: string[] = [];
  const pending: string[] = [''];
  let examined = 0;
  let stoppedEarly = false;
  while (pending.length > 0 && found.length < LIST_CAP && examined < LIST_CAP) {
    const prefix = pending.shift();
    if (prefix === undefined) break;
    const dir = prefix.length === 0 ? resolvedRoot : resolve(resolvedRoot, prefix);
    let names: readonly string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    const sorted = [...names].sort(compareNames);
    for (const name of sorted) {
      if (found.length >= LIST_CAP || examined >= LIST_CAP) {
        stoppedEarly = true;
        break;
      }
      examined += 1;
      if (name.length === 0 || name === '.' || name === '..') continue;
      const rel = prefix.length === 0 ? name : `${prefix}/${name}`; // path-hygiene: allow portable slash skill id
      if (utf8ByteLength(rel) > ID_BYTE_LIMIT) continue;
      const full = resolve(dir, name);
      const lexical = relative(resolvedRoot, full);
      if (lexical.startsWith('..') || isAbsolute(lexical)) continue;
      let st;
      try {
        st = await lstat(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        let real: string;
        try {
          real = await realpath(full);
        } catch {
          continue;
        }
        const fromRoot = relative(rootReal, real);
        if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) continue;
        found.push(rel);
        continue;
      }
      if (st.isDirectory()) {
        pending.push(rel);
        continue;
      }
      if (!st.isFile()) continue;
      found.push(rel);
    }
    if (found.length >= LIST_CAP || examined >= LIST_CAP) stoppedEarly = true;
  }
  if (stoppedEarly) {
    while (found.length < LIST_CAP) found.push('../cap');
  }
  return found;
}

async function confinedFile(root: string, relativeId: string): Promise<string | null> {
  const path = boundedPath(root, relativeId);
  if (path === null) return null;
  let rootReal: string;
  let candidateReal: string;
  try {
    rootReal = await realpath(resolve(root));
    candidateReal = await realpath(path);
  } catch {
    return null;
  }
  const rel = relative(rootReal, candidateReal);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return path;
}

async function readAtMost(
  path: string,
  cap: number,
): Promise<{ readonly bytes: Uint8Array; readonly truncated: boolean } | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, 'r');
    const buffer = new Uint8Array(cap + 1);
    const result = await handle.read(buffer, 0, cap + 1, 0);
    if (result.bytesRead > cap) return { bytes: buffer.subarray(0, cap), truncated: true };
    return { bytes: buffer.subarray(0, result.bytesRead), truncated: false };
  } catch {
    return null;
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // A close failure does not become a span or an error string.
      }
    }
  }
}

const skillReader = {
  async listDirectories(root: string): Promise<readonly string[]> {
    let names: readonly string[];
    try {
      names = await readdir(root);
    } catch {
      return [];
    }
    const dirs: string[] = [];
    for (const name of names) {
      if (!DIRECTORY_NAME.test(name)) continue;
      let st;
      try {
        st = await lstat(resolve(root, name));
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      dirs.push(name);
    }
    return dirs;
  },
  async readSkillMarkdown(root: string, directoryName: string): Promise<Uint8Array | null> {
    if (!DIRECTORY_NAME.test(directoryName)) return null;
    const path = boundedPath(root, `${directoryName}/SKILL.md`); // path-hygiene: allow portable slash id, checked by boundedPath
    if (path === null) return null;
    const capped = await readAtMost(path, SKILL_CAP);
    if (capped === null) return null;
    return capped.bytes;
  },
};

const evidenceReader = {
  async listFiles(root: string): Promise<readonly string[]> {
    return listEvidenceFiles(root);
  },
  async readPrefix(root: string, relativeId: string) {
    const path = await confinedFile(root, relativeId);
    if (path === null) return null;
    return readAtMost(path, EVIDENCE_CAP);
  },
};

export async function runShortlist(command: ShortlistCommand): Promise<string | null> {
  if (command.skillsRoot !== undefined) {
    const accepted = await rootInsideHome(command.home, command.skillsRoot);
    if (!accepted) return null;
  }
  if (command.evidenceRoot !== undefined) {
    const accepted = await rootInsideHome(command.home, command.evidenceRoot);
    if (!accepted) return null;
  }
  const skills = await shortlistInstalledSkills({
    roots: command.skillsRoot === undefined ? [] : [command.skillsRoot],
    intent: command.intent,
    requestedIds: command.skillId === undefined ? [] : [command.skillId],
    reader: skillReader,
  });
  const evidence = await shortlistEvidence({
    roots: command.evidenceRoot === undefined ? [] : [command.evidenceRoot],
    ids: command.evidenceIds,
    intent: command.intent,
    reader: evidenceReader,
  });
  return formatShortlist(skills, evidence);
}

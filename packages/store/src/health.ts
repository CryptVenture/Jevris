/**
 * Store faults and content-free diagnostics (DATA-08, SSOT §17.3). The store runs
 * `quick_check` on open. SQLITE_FULL and SQLITE_CORRUPT (and NOTADB, IOERR) stop owned
 * automation for that store and write a diagnostic next to the db that doctor and
 * `jevris sidecar status` show: a code, the phase and a time, never a path, a row or SQL.
 */
import { chmodSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export type StoreFaultCode = 'store-full' | 'store-corrupt' | 'store-io' | 'store-readonly';

export interface StoreDiagnostic {
  readonly schema: 'jevris-store-diagnostic-1';
  readonly code: StoreFaultCode;
  /** Where it happened: open, quick-check, migrate, write. */
  readonly phase: 'open' | 'quick-check' | 'migrate' | 'write';
  /** The SQLite result code name, e.g. SQLITE_FULL. */
  readonly sqliteCode: string;
  readonly atMs: number;
  readonly action: string;
}

const ACTIONS: { readonly [K in StoreFaultCode]: string } = {
  'store-full': 'The disk holding the Jevris store is full. Free space, then run `jevris sidecar restart`.',
  'store-corrupt': 'The Jevris store failed its integrity check. Run `jevris store restore <backup>` or move the store aside and restart; owned automation is stopped until then.',
  'store-io': 'The Jevris store could not be read or written. Check the disk and permissions, then run `jevris sidecar restart`.',
  'store-readonly': 'The Jevris store is read-only. Make the data directory writable by your user, then run `jevris sidecar restart`.',
};

export function faultAction(code: StoreFaultCode): string {
  return ACTIONS[code];
}

/** Maps a better-sqlite3 error to a fault, or undefined for an ordinary error. */
export function classifySqliteError(error: unknown): { readonly code: StoreFaultCode; readonly sqliteCode: string } | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const raw = Reflect.get(error, 'code');
  if (typeof raw !== 'string') return undefined;
  if (raw.startsWith('SQLITE_FULL')) return { code: 'store-full', sqliteCode: raw };
  if (raw.startsWith('SQLITE_CORRUPT') || raw.startsWith('SQLITE_NOTADB')) return { code: 'store-corrupt', sqliteCode: raw };
  if (raw.startsWith('SQLITE_IOERR') || raw.startsWith('SQLITE_CANTOPEN')) return { code: 'store-io', sqliteCode: raw };
  if (raw.startsWith('SQLITE_READONLY')) return { code: 'store-readonly', sqliteCode: raw };
  return undefined;
}

export function diagnosticPath(dbPath: string): string {
  return `${dbPath}.diagnostic.json`;
}

/**
 * Writes the diagnostic (owner-only, atomic rename). On a full disk the write itself may
 * fail; the in-memory fault still stops automation and health still reports it.
 */
export function writeDiagnostic(dbPath: string, fault: { readonly code: StoreFaultCode; readonly sqliteCode: string }, phase: StoreDiagnostic['phase'], atMs: number): StoreDiagnostic {
  const diagnostic: StoreDiagnostic = {
    schema: 'jevris-store-diagnostic-1',
    code: fault.code,
    phase,
    sqliteCode: /^SQLITE_[A-Z_]{1,40}$/.test(fault.sqliteCode) ? fault.sqliteCode : 'SQLITE_ERROR',
    atMs,
    action: ACTIONS[fault.code],
  };
  const target = diagnosticPath(dbPath);
  const temp = `${target}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(diagnostic)}\n`, { mode: 0o600 });
    if (process.platform !== 'win32') chmodSync(temp, 0o600);
    renameSync(temp, target);
  } catch {
    // best effort (a full disk)
  }
  return diagnostic;
}

export function readDiagnostic(dbPath: string): StoreDiagnostic | undefined {
  const target = diagnosticPath(dbPath);
  try {
    const st = lstatSync(target, { throwIfNoEntry: false });
    if (st === undefined || !st.isFile()) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(target, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Reflect.get(parsed, 'schema') !== 'jevris-store-diagnostic-1') return undefined;
    const code = Reflect.get(parsed, 'code');
    if (typeof code !== 'string' || !(code in ACTIONS)) return undefined;
    return parsed as StoreDiagnostic;
  } catch {
    return undefined;
  }
}

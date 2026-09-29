// Test runner only (scripts/test-keyring-hooks.mjs): an ES module import of better-sqlite3 is
// sent here, and this loads the real driver through require, where the preload records a
// database opened for writing under the real home (scripts/test-preload.mjs).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const target = new URL(import.meta.url).searchParams.get('target') ?? '';
const Database = createRequire(target)(fileURLToPath(target));
export default Database;
export const SqliteError = Database.SqliteError;

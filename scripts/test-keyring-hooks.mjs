// Module resolve hook used only by the test runner. See scripts/test-preload.mjs.
export function keyringBlocked(specifier) {
  return specifier === '@napi-rs/keyring' || specifier.startsWith('@napi-rs/keyring/') || specifier.startsWith('@napi-rs/keyring-');
}

function blockedError() {
  const error = new Error('test run: @napi-rs/keyring is blocked');
  error.code = 'ERR_JEVRIS_KEYRING_BLOCKED';
  return error;
}

const SQLITE_SHIM = new URL('./test-sqlite-shim.mjs', import.meta.url).href;

/**
 * An ES module import of better-sqlite3, while the home-write ledger is on, goes through a shim
 * that loads the driver with require, where the preload wraps it (a require is wrapped there
 * directly). Any other resolution is unchanged.
 */
function sqliteShim(specifier, context, resolved) {
  const ledger = process.env.JEVRIS_HOME_WRITE_LEDGER;
  if (specifier !== 'better-sqlite3' || typeof ledger !== 'string' || ledger.length === 0) return resolved;
  if (!Array.isArray(context?.conditions) || !context.conditions.includes('import')) return resolved;
  return { ...resolved, format: 'module', url: `${SQLITE_SHIM}?target=${encodeURIComponent(resolved.url)}`, shortCircuit: true };
}

/** Synchronous hook for module.registerHooks (Node >= 22.15, 23.5). Covers import and require. */
export function resolveSync(specifier, context, nextResolve) {
  if (keyringBlocked(specifier)) throw blockedError();
  return sqliteShim(specifier, context, nextResolve(specifier, context));
}

/** Asynchronous hook for module.register (older Node 22). */
export async function resolve(specifier, context, nextResolve) {
  if (keyringBlocked(specifier)) throw blockedError();
  return sqliteShim(specifier, context, await nextResolve(specifier, context));
}

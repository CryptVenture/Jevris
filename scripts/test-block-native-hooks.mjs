// Module resolve hook used only by scripts/test-block-native.mjs.
export function nativeBlocked(specifier) {
  return specifier === 'better-sqlite3' || specifier.startsWith('better-sqlite3/');
}

function blockedError() {
  const error = new Error("Cannot find module 'better-sqlite3' (blocked by the test preload)");
  error.code = 'MODULE_NOT_FOUND';
  return error;
}

/** Synchronous hook for module.registerHooks (Node >= 22.15, 23.5). Covers import and require. */
export function resolveSync(specifier, context, nextResolve) {
  if (nativeBlocked(specifier)) throw blockedError();
  return nextResolve(specifier, context);
}

/** Asynchronous hook for module.register (older Node 22). */
export async function resolve(specifier, context, nextResolve) {
  if (nativeBlocked(specifier)) throw blockedError();
  return nextResolve(specifier, context);
}

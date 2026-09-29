// Test-only preload: `node --import scripts/test-block-native.mjs ...` makes better-sqlite3
// fail to resolve, as it does on a machine whose native binding is missing or blocked.
// Tests use it to prove a module does not need the binding (BLD-13, BLD-14).
import * as nodeModule from 'node:module';
import { nativeBlocked, resolveSync } from './test-block-native-hooks.mjs';

if (typeof nodeModule.registerHooks === 'function') {
  nodeModule.registerHooks({ resolve: resolveSync });
} else {
  // Older Node 22: async hooks cover import; the CJS resolver covers createRequire.
  nodeModule.register(new URL('./test-block-native-hooks.mjs', import.meta.url));
  const Module = nodeModule.default;
  const original = Module._resolveFilename;
  Module._resolveFilename = function resolveFilename(request, ...rest) {
    if (nativeBlocked(request)) {
      const error = new Error("Cannot find module 'better-sqlite3' (blocked by the test preload)");
      error.code = 'MODULE_NOT_FOUND';
      throw error;
    }
    return original.call(this, request, ...rest);
  };
}

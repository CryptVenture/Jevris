/**
 * Entry of the bundled `plugins/shared/mcp.js`. The emit step defines the version and the
 * output schemas; this file only starts the stdio loop when it is the script node runs.
 */
import { runStdio, serverEnv } from './server.js';
import type { JsonSchema } from './tools.js';

export { MCP_HARNESS_IDS, REPORTS, SUPPORTED_PROTOCOLS, TOOLS, cliRunner, createServer, resolveBin, rootPath, serverEnv } from './server.js';

declare const __JEVRIS_VERSION__: string | undefined;
declare const __JEVRIS_OUTPUT_SCHEMAS__: { readonly [op: string]: JsonSchema } | undefined;

export const VERSION: string = typeof __JEVRIS_VERSION__ === 'string' ? __JEVRIS_VERSION__ : '0.0.0-dev';
export const OUTPUT_SCHEMAS: { readonly [op: string]: JsonSchema } =
  typeof __JEVRIS_OUTPUT_SCHEMAS__ === 'object' && __JEVRIS_OUTPUT_SCHEMAS__ !== null ? __JEVRIS_OUTPUT_SCHEMAS__ : {};

function isEntry(): boolean {
  const entry = process.argv[1];
  return typeof entry === 'string' && /(?:^|[\\/])mcp\.(?:js|mjs)$/.test(entry);
}

if (isEntry()) {
  runStdio({ env: serverEnv(process.argv.slice(2), process.env), cwd: () => process.cwd(), version: VERSION, outputSchemas: OUTPUT_SCHEMAS, scriptPath: process.argv[1] ?? null });
}

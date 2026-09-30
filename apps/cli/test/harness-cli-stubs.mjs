// Certifiable harness stand-ins: one node-backed executable per harness (a .cmd beside it on
// Windows) that answers everything `jevris install` and `jevris certify` ask of that harness,
// so pack smoke and tests can run the real certify path with no real harness binary. They
// write nothing outside the profile they are run in, never read a login, and make no network
// call except the loopback `serve` that Kilo and OpenCode certify drives.
//
// Put the folder first on PATH, inside the temp folder the test tripwire allows, and set
// JEVRIS_LIVE_HARNESS=1 so certify runs the binaries PATH names in a test run.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const STUB_VERSIONS = { claude: '2.1.283', kilo: '7.7.9', codex: '0.157.1', opencode: '1.18.32', agy: '1.2.11' };

/** Help text that lists every flag each owned-worker port passes (worker.route's flag probe). */
const HELP_FLAGS = {
  claude: ['-p, --print', '--output-format <format>', '--verbose', '--model <model>', '--max-budget-usd <amount>', '--allowedTools, --allowed-tools <tools...>', '--disallowedTools, --disallowed-tools <tools...>', '--strict-mcp-config', '--effort <level>'],
  codex: ['--json', '-m, --model <MODEL>', '-s, --sandbox <SANDBOX_MODE>', '--skip-git-repo-check', '-c, --config <key=value>'],
  opencode: ['--format', '-m, --model', '--agent', '--dir', '--variant'],
  kilo: ['--format', '-m, --model', '--agent', '--dir', '--variant'],
  agy: ['--input-format', '--output-format', '--model', '--sandbox', '--print-timeout', '--effort'],
};
export const WORKER_HELP = Object.fromEntries(Object.entries(HELP_FLAGS).map(([bin, flags]) => [bin, `Usage: ${bin}\n\nOptions:\n${flags.map((flag) => `  ${flag}    stand-in`).join('\n')}\n`]));

async function publicCommandNames() {
  const { SKILL_NAMES } = await import(new URL('../../../packages/contracts/dist/index.js', import.meta.url).href);
  return [...SKILL_NAMES];
}

/** The stub program for one harness binary (bin: claude, kilo, codex, opencode or agy). */
function program(bin, version, skills) {
  return `
'use strict';
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const BIN = ${JSON.stringify(bin)};
const VERSION = ${JSON.stringify(version)};
const SKILLS = ${JSON.stringify(skills)};
const args = process.argv.slice(2);
const line = args.join(' ');
const home = process.env.HOME || process.env.USERPROFILE || '';
const config = process.env.XDG_CONFIG_HOME || join(home, '.config');
const out = (text) => process.stdout.write(text);
function shimPath() {
  return BIN === 'kilo' ? join(config, 'kilo', 'plugin', 'jevris.js') : join(config, 'opencode', 'plugins', 'jevris.js');
}
async function serve(port) {
  const http = require('node:http');
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/session')) {
      try {
        const mod = await import(pathToFileURL(shimPath()).href);
        // Kilo loads a default export { id, server } and calls server; OpenCode calls every
        // exported function.
        const entries = Object.values(mod).flatMap((value) => (typeof value === 'function' ? [value] : value !== null && typeof value === 'object' && typeof value.server === 'function' ? [value.server] : []));
        for (const fn of entries) {
          try {
            await fn({ directory: process.cwd(), worktree: process.cwd(), project: {}, client: {}, $: () => undefined });
          } catch {
            // A plugin that needs more of the host still counts as called.
          }
        }
      } catch {
        // No shim: the marker stays empty and certify says so.
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  server.listen(port, '127.0.0.1');
}
// The Codex app-server's model listing: answers initialize and model/list, one JSON per line.
function appServer() {
  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\\n')) !== -1) {
      const text = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        continue;
      }
      if (message.method === 'initialize') out(JSON.stringify({ id: message.id, result: { userAgent: 'codex-stub' } }) + '\\n');
      else if (message.method === 'model/list') out(JSON.stringify({ id: message.id, result: { data: [{ id: 'gpt-5.5', model: 'gpt-5.5', hidden: false }, { id: 'hidden-one', model: 'hidden-one', hidden: true }], nextCursor: null } }) + '\\n');
      // A stand-in starts no thread or turn. It refuses such a request at once, as the app-server
      // answers any request it does not serve, so the stub-turn case fails now instead of at its timeout.
      else if (message.id !== undefined && typeof message.method === 'string') out(JSON.stringify({ id: message.id, error: { code: -32601, message: 'the stand-in starts no thread' } }) + '\\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
// Claude Code's initialize answer on an idle stream-json print session: the models, no turn.
function claudeInitialize() {
  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\\n')) !== -1) {
      const text = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        continue;
      }
      if (message.type === 'control_request' && message.request && message.request.subtype === 'initialize') {
        out(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { models: [{ value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'stand-in' }] } } }) + '\\n');
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
const HELP = ${JSON.stringify(WORKER_HELP)};
(async () => {
  if (args[args.length - 1] === '--help') return out(HELP[BIN] ?? '');
  if (line === '--version' || line === 'version') return out(BIN === 'claude' ? VERSION + ' (Claude Code)\\n' : VERSION + '\\n');
  if (BIN === 'claude') {
    if (line.startsWith('plugin validate')) return out('✔ Validation passed\\n');
    if (line === 'plugin list --json') return out('[{"id":"jevris@jevris-local","enabled":true}]');
    if (line.startsWith('plugin details')) return out('Skills: ' + SKILLS.join(', ') + '\\n');
    // models.list (G13): the idle print session answers only the initialize control request.
    if (args.includes('--input-format')) return claudeInitialize();
    return;
  }
  // models.list: the listing each harness answers, writing nothing (DOMAINS 3f090fa).
  if (BIN === 'codex' && args.includes('app-server')) return appServer();
  if (BIN === 'agy' && line === 'models') return out('gemini-3-pro\\ngemini-3-flash\\n');
  if ((BIN === 'kilo' || BIN === 'opencode') && line === 'models') return out('anthropic/claude-sonnet-4-5\\nopenai/gpt-5.5\\nopenrouter/openai/gpt-5.5\\n');
  if (BIN === 'codex' || BIN === 'agy') {
    if (line.startsWith('plugin list')) return out('jevris (installed)\\n');
    if (line.startsWith('mcp list')) return out('jevris  node  enabled\\n');
    return;
  }
  // kilo and opencode
  if (line === 'mcp list') return out('●  ✓ jevris connected\\n');
  if (line === 'debug info') return out('plugins:\\n- ' + pathToFileURL(shimPath()).href + '\\n');
  if (line === 'debug skill') return out(JSON.stringify(SKILLS.map((name) => ({ name: 'jevris-' + name, location: join(home, 'jevris-' + name, 'SKILL.md') }))));
  if (args[0] === 'serve') {
    const at = args.indexOf('--port');
    return serve(Number(args[at + 1]));
  }
})();
`;
}

/**
 * Writes the five stand-ins into `dir` and returns the folder. `versions` overrides the version
 * each one prints (keys: claude, kilo, codex, opencode, agy); `only` limits which are written.
 */
export async function writeCertifiableHarnessStubs(dir, options = {}) {
  mkdirSync(dir, { recursive: true });
  const versions = { ...STUB_VERSIONS, ...(options.versions ?? {}) };
  const skills = options.skills ?? (await publicCommandNames());
  for (const bin of options.only ?? Object.keys(STUB_VERSIONS)) {
    const script = join(dir, `${bin}-stub.cjs`);
    writeFileSync(script, program(bin, versions[bin], skills));
    if (process.platform === 'win32') {
      writeFileSync(join(dir, `${bin}.cmd`), `@"${process.execPath}" "%~dp0${bin}-stub.cjs" %*\r\n`);
    } else {
      writeFileSync(join(dir, bin), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
      chmodSync(join(dir, bin), 0o755);
    }
  }
  return dir;
}
